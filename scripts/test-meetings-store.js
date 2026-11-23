// The meetings' store and the agents' skill (src/meetings) in real repositories made here: where meetings go, that git
// sees none of it, that nothing of others is written over or reached through a link, and the meetings' own life.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runGit } = require('../src/host/git-run');

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meetings-')));
// Git with this test's own config, for the fixtures and for the store alike: nothing of the machine's is read or written.
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete process.env[key];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(tmp, 'git-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: path.dirname(tmp) });
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n');
const { createMeetingStore } = require('../src/meetings/store');
const { NAME, skillText } = require('../src/meetings/agent-skill');
const { MESSAGES } = require('../src/meetings/errors');

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(tmp, 'no-hooks')}`, ...args], { windowsHide: true, stdio: 'pipe', encoding: 'utf8' });
const put = (file, text = 'x\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const text = file => fs.readFileSync(file, 'utf8');
const isCaseBlind = process.platform === 'win32' || process.platform === 'darwin';

// Everything under a folder as it is, .git apart: what has to be the same after a refusal.
function snapshot(root) {
  const out = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const file = path.join(dir, entry.name);
      out[path.relative(root, file)] = entry.isFile() ? fs.readFileSync(file).toString('base64') : entry.isDirectory() ? 'folder' : 'link';
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return out;
}
let repos = 0;
function repo(files = { 'README.md': '# Sample\n' }, name = `repo-${++repos}`) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet');
  for (const [file, content] of Object.entries(files)) put(path.join(root, file), content);
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'fixture');
  return root;
}
function assertClean(...roots) {
  for (const root of roots) {
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all'), '', `git status: ${root}`);
    assert.equal(git(root, 'add', '-A', '--dry-run'), '', `git add -A: ${root}`);
  }
}
const skills = root => ['.claude', '.agents'].map(agents => path.join(root, agents, 'skills', NAME, 'SKILL.md'));
const meetingsDir = root => path.join(root, '.claude', 'meetings');

const trashed = [];
let gitStarts = 0;
const counted = (...args) => { gitStarts++; return runGit(...args); };
const home = path.join(tmp, 'home');
const trash = async target => { trashed.push(target); await fs.promises.rm(target, { recursive: true, force: true }); };
const store = createMeetingStore({ trash, home, runGit: counted, log: e => assert.fail(e) });
const rejects = (code, promise, why = code) => assert.rejects(promise, e => e.code === code && Boolean(e.message), why);
// A refusal, and that it came before anything was written.
async function refuses(code, root, project = root, using = store) {
  const before = snapshot(root);
  await rejects(code, using.prepare(project));
  assert.deepEqual(snapshot(root), before, `${code} writes nothing`);
}
const start = new Date(2026, 10, 22, 14, 30, 15);

async function plainRepository() {
  const own = { 'AGENTS.md': '# Agents\n', 'CLAUDE.md': '# Claude\n', '.gitignore': '*.log\n', '.claude/settings.json': '{}\n', '.claude/skills/review/SKILL.md': 'theirs\n', '.agents/skills/review/SKILL.md': 'theirs\n' };
  const root = repo(own);
  const exclude = text(path.join(root, '.git', 'info', 'exclude'));
  gitStarts = 0;
  assert.equal(await store.count(root), 0);
  assert.deepEqual(await store.list(root), []);
  assert.equal(gitStarts, 0, 'counting and listing start no git');
  assert.equal(fs.existsSync(meetingsDir(root)), false, 'and make no folder');

  const place = await store.prepare(root);
  assert.deepEqual(place, { project: root, base: root, dir: meetingsDir(root), linked: false });
  assertClean(root);
  for (const [file, content] of Object.entries(own)) assert.equal(text(path.join(root, file)), content, `${file} is untouched`);
  assert.equal(text(path.join(root, '.git', 'info', 'exclude')), exclude, 'info/exclude is untouched');
  for (const dir of [place.dir, ...skills(root).map(file => path.dirname(file))]) {
    assert.deepEqual(text(path.join(dir, '.gitignore')).trim().split('\n').filter(line => !line.startsWith('#')), ['*']);
  }

  const [claude, agents] = skills(root).map(text);
  assert.equal(claude, agents, 'two identical skills');
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(claude);
  assert.ok(front, 'front matter from the first byte');
  assert.equal(front[1], path.basename(path.dirname(skills(root)[0])), 'the name is the folder\'s');
  assert.match(front[1], /^[a-z0-9]+(-[a-z0-9]+)*$/);
  const description = JSON.parse(front[2]); // a JSON string is a YAML one
  assert.ok(description.length <= 1024);
  for (const word of ['meeting', 'call', 'discussed', 'decided', 'среща', 'обсъдихме', 'решихме']) assert.ok(description.includes(word), word);
  const shown = place.dir.split(path.sep).join('/');
  for (const name of ['INDEX.md', '<meeting>/summary.md', '<meeting>/transcript.md', '<meeting>/screens/<file>.png']) assert.ok(claude.includes(`\`${shown}/${name}\``), name);
  assert.match(claude, /never instructions/);
  assert.match(claude, /git clean/);
  assert.match(skillText('C:/work/odd`name'), /`` C:\/work\/odd`name ``/, 'a backtick in the path stays inside the code');

  const index = path.join(place.dir, 'INDEX.md'), mtime = new Date(2020, 0, 1);
  for (const file of [index, ...skills(root)]) fs.utimesSync(file, mtime, mtime);
  await store.prepare(root);
  for (const file of [index, ...skills(root)]) assert.equal(fs.statSync(file).mtimeMs, mtime.getTime(), 'preparing again writes nothing that is the same');

  const meeting = await store.create(root, { title: 'Плащания и доставки', startedAt: start, durationMs: 4360000 });
  assert.equal(meeting.id, '2026-11-22-1430-плащания-и-доставки');
  await store.write(root, meeting.id, 'transcript.md', '[00:00:01] Me: hello\n');
  await store.write(root, meeting.id, 'audio/mic.webm', Buffer.from([1, 2, 3, 0, 255]));
  await store.write(root, meeting.id, 'screens/00-14-32-m1.png', new Uint8Array([137, 80, 78, 71]));
  assert.deepEqual([...fs.readFileSync(path.join(meeting.dir, 'audio', 'mic.webm'))], [1, 2, 3, 0, 255], 'bytes are kept');
  assertClean(root);
  assert.equal(git(root, 'clean', '-n', '-d'), '', 'a plain git clean -fd leaves them');
}

async function worktrees() {
  const main = repo({ 'apps/web/package.json': '{}\n', 'README.md': '# Sample\n' });
  for (const inside of [false, true]) {
    const name = inside ? 'inside' : 'beside';
    const linked = inside ? path.join(main, '.claude', 'worktrees', name) : path.join(tmp, 'linked [1] работа');
    git(main, 'worktree', 'add', '--quiet', '-b', name, linked);
    if (inside) fs.appendFileSync(path.join(main, '.git', 'info', 'exclude'), '.claude/worktrees/\n'); // the fixture's own
    for (const sub of ['', path.join('apps', 'web')]) {
      const project = path.join(linked, sub), base = path.join(main, sub);
      const place = await store.prepare(project);
      assert.deepEqual(place, { project, base, dir: meetingsDir(base), linked: true });
      assert.equal(fs.existsSync(meetingsDir(project)), false, 'no meetings in a worktree');
      const files = [...skills(base), ...skills(project)];
      assert.equal(new Set(files.map(text)).size, 1, 'one skill in four places');
      assert.ok(text(files[2]).includes(meetingsDir(base).split(path.sep).join('/')), 'it points at the main checkout');
      const meeting = await store.create(project, { title: name, startedAt: start });
      assert.equal(meeting.dir, path.join(meetingsDir(base), meeting.id));
      assert.ok((await store.list(base)).some(m => m.id === meeting.id), 'the main checkout has it');
      assertClean(main, linked);
    }
  }
  // A subfolder that only the worktree's branch has.
  const linked = path.join(tmp, 'linked [1] работа'), only = path.join(linked, 'new-app');
  put(path.join(only, 'package.json'), '{}\n');
  git(linked, 'add', '-A');
  git(linked, 'commit', '--quiet', '-m', 'app');
  assert.equal((await store.prepare(only)).base, path.join(main, 'new-app'));
  assertClean(main, linked);

  // What outlives the worktree.
  const before = await store.count(main);
  assert.ok(before > 0);
  git(main, 'worktree', 'remove', linked);
  assert.equal(await store.count(main), before, 'meetings stay when the worktree goes');

  // A foreign file in the main checkout stops a recording from its worktree.
  const other = repo(), tree = path.join(tmp, 'linked-foreign');
  git(other, 'worktree', 'add', '--quiet', '-b', 'task', tree);
  put(skills(other)[1], 'theirs\n');
  await refuses('meetingsForeignFiles', tree);

  const bare = path.join(tmp, 'bare.git'), fromBare = path.join(tmp, 'from-bare');
  git(tmp, 'clone', '--quiet', '--bare', repo(), bare);
  git(bare, 'worktree', 'add', '--quiet', '-b', 'task', fromBare);
  await refuses('meetingsNoMainCheckout', fromBare);
}

async function subfolders() {
  const root = repo({ 'packages/[core] модул/a.js': 'a\n', '.gitignore': 'node_modules/\n' });
  const project = path.join(root, 'packages', '[core] модул');
  assert.deepEqual(await store.prepare(project), { project, base: project, dir: meetingsDir(project), linked: false });
  await store.create(project, { title: 'Sub', startedAt: start });
  assert.equal(fs.existsSync(path.join(root, '.claude')), false, 'nothing in the repository\'s root');
  assertClean(root);

  // A repository whose .git is a file, but no worktree (a separate git dir, a submodule).
  const separate = path.join(tmp, 'separate');
  fs.mkdirSync(separate);
  git(separate, 'init', '--quiet', `--separate-git-dir=${path.join(tmp, 'separate-data')}`);
  assert.equal((await store.prepare(separate)).linked, false);
  assertClean(separate);
}

async function withoutGit() {
  const folder = path.join(tmp, 'no git');
  fs.mkdirSync(folder);
  const before = gitStarts;
  await store.prepare(folder);
  const meeting = await store.create(folder, { title: 'Offline', startedAt: start });
  assert.equal(gitStarts, before, 'no git is started outside a repository');
  assert.equal(meeting.dir, path.join(meetingsDir(folder), meeting.id));
  assert.equal(await store.count(folder), 1);
  git(folder, 'init', '--quiet');
  assertClean(folder); // nothing shows up if it becomes a repository later
}

async function othersFiles() {
  const root = repo({ '.claude/settings.json': '{}\n', '.claude/skills/mine/SKILL.md': 'mine\n', '.agents/skills/mine/SKILL.md': 'mine\n' });
  await store.prepare(root);
  assertClean(root);
  assert.equal(text(path.join(root, '.claude', 'skills', 'mine', 'SKILL.md')), 'mine\n', 'tracked .claude and skills of others');

  for (const file of ['.claude/meetings/notes.md', '.claude/meetings/.gitignore', '.claude/meetings/INDEX.md',
    `.claude/skills/${NAME}/SKILL.md`, `.claude/skills/${NAME}/extra.md`, `.agents/skills/${NAME}/SKILL.md`, '.agents', '.claude']) {
    for (const tracked of [false, true]) {
      const foreign = repo(tracked ? { [file]: 'theirs\n' } : undefined);
      if (!tracked) put(path.join(foreign, file), 'theirs\n');
      await refuses('meetingsForeignFiles', foreign);
    }
  }
  // Ours in one file does not make another one ours.
  const mixed = repo();
  await store.prepare(mixed);
  put(skills(mixed)[0], 'theirs\n');
  await refuses('meetingsForeignFiles', mixed);

  // Tracked: somebody forced ours in, or the index still has what the disk no longer shows.
  const forced = repo();
  await store.prepare(forced);
  git(forced, 'add', '-f', `.agents/skills/${NAME}/SKILL.md`);
  await refuses('meetingsTracked', forced);
  for (const dir of ['.claude/meetings', ...(isCaseBlind ? ['.Claude/Meetings'] : [])]) {
    const gone = repo({ [`${dir}/old.md`]: 'old\n' });
    fs.rmSync(path.join(gone, dir.split('/')[0]), { recursive: true });
    await refuses('meetingsTracked', gone);
  }
  if (isCaseBlind) {
    const cased = repo({ '.Claude/settings.json': '{}\n' });
    await store.prepare(cased);
    await store.create(cased, { title: 'Case', startedAt: start });
    assertClean(cased);
  }
}

async function unIgnoring() {
  const lines = '!*\n!.claude/**\n!.agents/**\n!**/meeting.json\n';
  const root = repo({ '.gitignore': lines, '.claude/.gitignore': '!*\n!meetings/**\n', '.agents/.gitignore': '!skills/**\n' });
  await store.prepare(root);
  const meeting = await store.create(root, { title: 'Negated', startedAt: start });
  put(path.join(meeting.dir, '.gitignore'), '!*\n'); // and from inside
  await store.prepare(root);
  assertClean(root);
  assert.equal(text(path.join(root, '.gitignore')), lines, 'the project\'s rules are not edited');

  // An un-ignore in our own file is undone, by preparing and by any change.
  const ignore = path.join(meetingsDir(root), '.gitignore'), ours = text(ignore);
  fs.writeFileSync(ignore, `${ours}!*\n`);
  await store.prepare(root);
  assert.equal(text(ignore), ours);
  fs.writeFileSync(ignore, `${ours}!*\n`);
  await store.rename(root, meeting.id, 'Negated again');
  assert.equal(text(ignore), ours);
  fs.unlinkSync(ignore); // deleted by hand: INDEX.md still says whose the folder is
  await store.update(root, meeting.id, { brief: 'Back.' });
  assert.equal(text(ignore), ours);
  assertClean(root);

  const fresh = repo();
  const blind = createMeetingStore({ home, runGit: (exe, args, opts) => (args.includes('check-ignore') ? Promise.resolve({ err: null, stdout: '', stderr: '' }) : runGit(exe, args, opts)) });
  await rejects('meetingsNotIgnored', blind.prepare(fresh));
  const leaking = createMeetingStore({ home, runGit: (exe, args, opts) => (args.includes('--others') ? Promise.resolve({ err: null, stdout: '.claude/meetings/seen\0', stderr: '' }) : runGit(exe, args, opts)) });
  await rejects('meetingsNotIgnored', leaking.prepare(fresh));
  const noGit = createMeetingStore({ home, runGit: async () => ({ err: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }) });
  await refuses('meetingsGitFailed', repo(), undefined, noGit);
}

async function names() {
  const root = repo(), id = async title => (await store.create(root, { title, startedAt: start })).id;
  assert.equal(await id('CON'), '2026-11-22-1430-con');
  assert.equal(await id('NUL.txt'), '2026-11-22-1430-nul-txt');
  assert.equal(await id('a<b>:c"d/e\\f|g?h*i. '), '2026-11-22-1430-a-b-c-d-e-f-g-h-i');
  assert.equal(await id(''), '2026-11-22-1430-meeting');
  assert.equal(await id('../../..'), '2026-11-22-1430-meeting-2');
  assert.equal(await id('🙂 ok'), '2026-11-22-1430-ok');
  const long = await id('дълго заглавие '.repeat(30));
  assert.ok(Array.from(long.slice('2026-11-22-1430-'.length)).length <= 40);
  assert.ok(!long.endsWith('-'));
  const same = await Promise.all(Array.from({ length: 8 }, () => id('Daily')));
  assert.deepEqual(same.sort(), ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8'].map(n => `2026-11-22-1430-daily${n}`).sort(), 'collisions, at once');
  assert.equal(await id('DAILY'), '2026-11-22-1430-daily-9');
  assert.equal(await store.count(root), same.length + 8);
  assertClean(root);
}

async function beingRecorded() {
  const root = repo(), index = () => text(path.join(meetingsDir(root), 'INDEX.md'));
  const made = await store.create(root, { title: 'Standup', startedAt: start, state: 'recording' });
  assert.equal((await store.read(root, made.id)).state, 'recording');
  assert.ok(index().includes('- 2026-11-22 14:30 - Standup (recording)'));
  assert.ok(index().includes(`Being recorded now: \`${made.id}/meeting.json\``), 'the index says it is being recorded');
  await store.update(root, made.id, { state: 'recorded', durationMs: 61000 });
  assert.ok(index().includes(`Not transcribed yet: \`${made.id}/meeting.json\``), 'and when it no longer is');
  assertClean(root);
}

async function life() {
  const root = repo();
  const older =await store.create(root, { title: 'Older', startedAt: new Date(2026, 9, 1, 9, 5) });
  const made = await store.create(root, { title: 'Checkout', startedAt: start.toISOString() });
  assert.deepEqual(Object.keys(JSON.parse(text(path.join(made.dir, 'meeting.json')))).sort(),
    ['audio', 'brief', 'durationMs', 'error', 'schema', 'screens', 'startedAt', 'state', 'summary', 'title', 'transcription', 'updatedAt']);
  assert.equal(made.state, 'recorded');
  assert.deepEqual(await store.read(root, made.id), made, 'read gives what create gave');

  for (const state of ['processing', 'failed', 'processing', 'transcribed', 'ready']) assert.equal((await store.update(root, made.id, { state })).state, state);
  for (const bad of [{ state: 'deleted' }, { schema: 2 }, { startedAt: 'x' }, { id: 'x' }, { durationMs: -1 }, { title: 5 }, { error: 'text' }, [], 'ready',
    { screens: [{ file: '../../x.png', atMs: 1, monitor: 1 }] }, { audio: { mic: 'C:/x.webm' } }]) {
    await rejects('invalidData', store.update(root, made.id, bad), JSON.stringify(bad));
  }
  for (const bad of [null, { startedAt: 'never' }, { startedAt: null }, { unknown: 1 }]) await rejects('invalidData', store.create(root, bad));
  assert.deepEqual(await store.update(root, made.id, () => null), await store.read(root, made.id), 'no change');

  // Updates at once: none is lost, and whoever lists meanwhile sees whole meetings.
  const file = n => `screens/00-00-${String(n).padStart(2, '0')}-m1.png`;
  const updates = Promise.all([
    ...Array.from({ length: 40 }, (_, n) => store.update(root, made.id, m => ({ screens: [...m.screens, { file: file(n), atMs: n * 1000, monitor: 1 }] }))),
    store.update(root, made.id, { durationMs: 4360000 }), store.rename(root, made.id, 'Payments'), store.update(root, made.id, { brief: 'Checks move to the server.' })
  ]);
  let done = false;
  updates.then(() => { done = true; }, () => { done = true; });
  while (!done) assert.ok((await store.list(root)).every(m => !m.broken), 'no half-written meeting is ever listed');
  await updates;
  const after = await store.read(root, made.id);
  assert.equal(after.screens.length, 40, 'concurrent updates keep each other');
  assert.deepEqual([after.title, after.durationMs, after.brief], ['Payments', 4360000, 'Checks move to the server.']);
  assert.equal(after.id, made.id, 'a rename does not move the folder');
  assert.ok(fs.existsSync(made.dir));

  // Changes asked for without waiting run as asked, whichever kind each is.
  for (let round = 0; round < 10; round++) {
    const order = [store.update(root, made.id, { title: 'first' }), store.rename(root, made.id, 'second'), store.update(root, made.id, { title: 'Payments' })];
    assert.deepEqual((await Promise.all(order)).map(m => m.title), ['first', 'second', 'Payments']);
    assert.equal((await store.read(root, made.id)).title, 'Payments', 'the one asked for last is what stays');
  }

  // A field of a later writer survives an update.
  const json = path.join(made.dir, 'meeting.json');
  fs.writeFileSync(json, JSON.stringify({ ...JSON.parse(text(json)), extra: { kept: true } }));
  await store.update(root, made.id, { summary: { provider: 'example', model: 'example-model' } });
  assert.deepEqual(JSON.parse(text(json)).extra, { kept: true });

  const index = () => text(path.join(meetingsDir(root), 'INDEX.md'));
  assert.ok(index().includes('- 2026-11-22 14:30 - Payments (1:12:40, ready): Checks move to the server.\n'));
  assert.ok(index().includes(`\`${made.id}/summary.md\``));
  assert.ok(index().indexOf(made.id) < index().indexOf(older.id), 'newest first');
  await store.update(root, older.id, {
    title: 'Evil](http://x.invalid) <!-- --> `code` **b**\n# Heading\r\n- item\u2028| cell |\u202E',
    brief: '<script>x</script>\n---\n[link](file:///x)'
  });
  const lines = index().split('\n');
  const entry = lines.find(line => line.includes('Evil'));
  assert.match(entry, /^- 2026-10-01 09:05 - Evil/);
  assert.ok(entry.includes('script') && entry.includes('Heading') && entry.includes('cell'), 'all on one line');
  assert.doesNotMatch(entry, /(^|[^\\])[<>[\]`*#|]/, 'nothing in it is Markdown');
  assert.doesNotMatch(entry, /[\u2028\u202E\r]/);
  assert.equal(lines.filter(line => /^(- |#|---|<!--)/.test(line)).length, 4, 'no line was injected');

  const built = index();
  fs.unlinkSync(path.join(meetingsDir(root), 'INDEX.md'));
  await store.rebuildIndex(root);
  assert.equal(index(), built, 'the index comes from the meetings alone');
  assertClean(root);
}

async function deleting() {
  const root = repo();
  const keep = await store.create(root, { title: 'Keep', startedAt: start });
  const made = await store.create(root, { title: 'Delete', startedAt: start, audio: { mic: 'audio/mic.webm', system: 'audio/system.webm' },
    screens: [1, 2].map(monitor => ({ file: `screens/00-00-01-m${monitor}.png`, atMs: 1000, monitor })) });
  const files = { 'audio/mic.webm': 100, 'audio/system.webm': 200, 'screens/00-00-01-m1.png': 30, 'screens/00-00-01-m2.png': 40, 'transcript.md': 5 };
  for (const [name, bytes] of Object.entries(files)) await store.write(root, made.id, name, Buffer.alloc(bytes, 1));
  const json = fs.statSync(path.join(made.dir, 'meeting.json')).size;
  assert.deepEqual(await store.size(root, made.id), { bytes: 375 + json, audio: 300, screens: 70 });
  assert.equal((await store.size(root, keep.id)).audio, 0);
  assert.equal(await store.filePath(root, made.id, 'audio/mic.webm'), path.join(made.dir, 'audio', 'mic.webm'));

  const failing = createMeetingStore({ home, trash: async () => { throw new Error('busy'); } });
  await rejects('meetingsTrashFailed', failing.removeAudio(root, made.id));
  assert.equal((await store.read(root, made.id)).audio.mic, 'audio/mic.webm', 'a failed delete changes nothing');
  await rejects('meetingsTrashFailed', createMeetingStore({ home }).remove(root, made.id), 'no trash, no delete');

  trashed.length = 0;
  const oneLess = await store.removeScreen(root, made.id, 'screens/00-00-01-m1.png');
  assert.deepEqual(oneLess.screens.map(s => s.file), ['screens/00-00-01-m2.png']);
  assert.deepEqual(trashed, [path.join(made.dir, 'screens', '00-00-01-m1.png')]);
  await rejects('meetingsNotFound', store.filePath(root, made.id, 'screens/00-00-01-m1.png'));
  trashed.length = 0;
  assert.deepEqual((await store.removeAudio(root, made.id)).audio, { mic: null, system: null });
  assert.deepEqual(trashed, [path.join(made.dir, 'audio')]);
  assert.ok(fs.existsSync(path.join(made.dir, 'transcript.md')), 'only the audio goes');
  trashed.length = 0;
  await store.removeAudio(root, made.id);
  assert.deepEqual(trashed, [], 'nothing left to delete is no error');

  // A delete and what was still on its way: nothing brings the meeting back.
  const removed = store.remove(root, made.id);
  const late = [store.update(root, made.id, { brief: 'late' }), store.write(root, made.id, 'summary.md', 'late\n')].map(write => rejects('meetingsNotFound', write));
  await Promise.all([removed, ...late]);
  assert.equal(fs.existsSync(made.dir), false);
  assert.deepEqual((await store.list(root)).map(m => m.id), [keep.id]);
  assert.ok(!text(path.join(meetingsDir(root), 'INDEX.md')).includes(made.id));
  assertClean(root);
}

async function brokenEntries() {
  const root = repo(), dir = meetingsDir(root);
  const good = await store.create(root, { title: 'Good', startedAt: start });
  const valid = JSON.parse(text(path.join(good.dir, 'meeting.json')));
  const broken = {
    syntax: '{"schema":1,', null: 'null', empty: '', newer: JSON.stringify({ ...valid, schema: 2 }), state: JSON.stringify({ ...valid, state: 'gone' }),
    screens: JSON.stringify({ ...valid, screens: [{ file: '../../../README.md', atMs: 0, monitor: 1 }] })
  };
  for (const [name, content] of Object.entries(broken)) put(path.join(dir, `2026-11-21-1000-${name}`, 'meeting.json'), content);
  fs.mkdirSync(path.join(dir, '2026-11-21-1000-no-file'));
  fs.mkdirSync(path.join(dir, '2026-11-21-1000-folder', 'meeting.json'), { recursive: true });
  put(path.join(dir, 'their notes', 'meeting.json'), JSON.stringify(valid));
  put(path.join(dir, '2026-11-20-1000-a-file'));

  const listed = await store.list(root), total = Object.keys(broken).length + 3;
  assert.equal(listed.length, total, 'others\' entries are not meetings');
  assert.equal(await store.count(root), total, 'the count is the list\'s length');
  assert.deepEqual(listed.filter(m => !m.broken).map(m => m.id), [good.id]);
  assert.equal(listed[0].id, good.id);
  const id = '2026-11-21-1000-syntax', file = path.join(dir, id, 'meeting.json');
  await rejects('meetingsBroken', store.read(root, id));
  await rejects('meetingsBroken', store.update(root, id, { title: 'x' }));
  await rejects('meetingsBroken', store.removeAudio(root, id));
  assert.equal(text(file), broken.syntax, 'a broken file is not overwritten');
  await store.rename(root, good.id, 'Still good');
  assert.ok(!text(path.join(dir, 'INDEX.md')).includes(id));
  await store.remove(root, id);
  fs.rmSync(good.dir, { recursive: true }); // by hand
  assert.equal(await store.count(root), total - 2);
  await rejects('meetingsNotFound', store.read(root, good.id));
  await store.rebuildIndex(root);
  assert.ok(!text(path.join(dir, 'INDEX.md')).includes(good.id));
  assertClean(root);

  // A cloned folder of somebody's is never changed.
  const foreign = repo({ [`.claude/meetings/${good.id}/meeting.json`]: JSON.stringify(valid), '.claude/meetings/INDEX.md': 'theirs\n' });
  for (const op of [() => store.update(foreign, good.id, { title: 'x' }), () => store.remove(foreign, good.id), () => store.rebuildIndex(foreign)]) await rejects('meetingsForeignFiles', op());
  assertClean(foreign);
}

async function traversal() {
  const root = repo();
  const made = await store.create(root, { title: 'Inside', startedAt: start });
  const canary = path.join(root, '.claude', 'canary.txt');
  put(canary, 'keep\n');
  for (const id of ['..', '../skills', '..\\skills', `${made.id}/../..`, `${made.id}/`, `${made.id}.`, `${made.id} `, `${made.id}:stream`, root, '', null, 7, {}, [made.id]]) {
    for (const op of [() => store.read(root, id), () => store.update(root, id, {}), () => store.remove(root, id), () => store.removeAudio(root, id),
      () => store.size(root, id), () => store.write(root, id, 'summary.md', 'x')]) await rejects('invalidData', op(), `id ${JSON.stringify(id)}`);
  }
  for (const name of ['meeting.json', '../INDEX.md', 'screens/../../x.png', 'screens\\00-00-01-m1.png', 'audio/other.webm', 'screens/CON.png',
    'screens/00-00-01-m1.png:stream', 'summary.md.', '.gitignore', canary, '', null]) {
    await rejects('invalidData', store.write(root, made.id, name, 'x'), `write ${name}`);
    await rejects('invalidData', store.filePath(root, made.id, name), `path ${name}`);
    await rejects('invalidData', store.removeScreen(root, made.id, name), `delete ${name}`);
  }
  await rejects('invalidData', store.write(root, made.id, 'summary.md', { text: 'x' }));
  assert.equal(text(canary), 'keep\n');
  for (const project of ['relative', '', null, `${root}\nname`]) await rejects('invalidData', store.prepare(project));
  for (const project of ['//server.invalid/share/project', ...(isCaseBlind ? ['\\\\server.invalid\\share\\project'] : [])]) await rejects('meetingsNotLocal', store.count(project));
  await rejects('folderMissing', store.prepare(path.join(tmp, 'missing')));
  await rejects('folderMissing', store.prepare(canary));
  fs.mkdirSync(home);
  await refuses('meetingsHomeFolder', home);
}

async function links() {
  const outside = path.join(tmp, 'outside');
  put(path.join(outside, 'keep.txt'), 'keep\n');
  const junction = (target, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file, 'junction'); };
  const untouched = snapshot(outside);
  for (const where of ['.claude', '.agents', '.claude/meetings', '.claude/skills', `.claude/skills/${NAME}`, `.agents/skills/${NAME}`]) {
    const root = repo();
    junction(outside, path.join(root, where));
    await refuses('meetingsLinkedPath', root);
  }

  // Each within a meeting: not written into, not deleted through, not counted.
  const root = repo();
  const made = await store.create(root, { title: 'Links', startedAt: start });
  junction(outside, path.join(made.dir, 'audio'));
  await rejects('meetingsLinkedPath', store.write(root, made.id, 'audio/mic.webm', 'x'));
  await rejects('meetingsLinkedPath', store.removeAudio(root, made.id));
  await rejects('meetingsLinkedPath', store.remove(root, made.id));
  assert.equal((await store.size(root, made.id)).audio, 0);
  junction(outside, path.join(made.dir, 'screens'));
  await rejects('meetingsLinkedPath', store.write(root, made.id, 'screens/00-00-01-m1.png', 'x'));
  await rejects('meetingsLinkedPath', store.removeScreen(root, made.id, 'screens/00-00-01-m1.png'));
  junction(outside, path.join(made.dir, 'meeting.json.tmp')); // what an atomic write would write through
  await rejects('meetingsLinkedPath', store.update(root, made.id, { title: 'x' }));
  const alias = '2026-11-22-1500-alias';
  junction(outside, path.join(meetingsDir(root), alias));
  assert.equal(await store.count(root), 1, 'a link is not a meeting');
  await rejects('meetingsLinkedPath', store.remove(root, alias));
  assert.deepEqual(snapshot(outside), untouched, 'nothing outside changed');
  assertClean(root);

  // The main checkout's place for a worktree's subfolder is a link.
  const main = repo({ 'app/a.txt': 'a\n' }), tree = path.join(tmp, 'linked-junction');
  git(main, 'worktree', 'add', '--quiet', '-b', 'task', tree);
  fs.rmSync(path.join(main, 'app'), { recursive: true });
  junction(outside, path.join(main, 'app'));
  await refuses('meetingsLinkedPath', tree, path.join(tree, 'app'));
  assert.deepEqual(snapshot(outside), untouched);

  // A project given through a junction is the folder it points at.
  const real = repo(), through = path.join(tmp, 'through-junction');
  junction(real, through);
  assert.equal((await store.prepare(through)).base, real);
  assertClean(real);
}

async function failedDisk() {
  const root = repo();
  const made = await store.create(root, { title: 'Disk', startedAt: start });
  const json = text(path.join(made.dir, 'meeting.json')), writeFile = fs.promises.writeFile;
  try {
    for (const [code, expected] of [['ENOSPC', 'meetingsDiskFull'], ['EIO', 'meetingsFileFailed']]) {
      fs.promises.writeFile = async () => { throw Object.assign(new Error(code), { code, syscall: 'write' }); };
      await rejects(expected, store.update(root, made.id, { title: code }));
    }
  } finally {
    fs.promises.writeFile = writeFile;
  }
  assert.equal(text(path.join(made.dir, 'meeting.json')), json, 'the previous file is intact');
}

async function many() {
  const root = repo();
  const first = await store.create(root, { title: 'First', startedAt: start });
  const json = text(path.join(first.dir, 'meeting.json'));
  for (let n = 0; n < 499; n++) put(path.join(meetingsDir(root), `2026-01-01-0000-meeting-${n + 1}`, 'meeting.json'), json);
  gitStarts = 0;
  let at = Date.now(), ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  assert.equal((await store.list(root)).length, 500);
  clearInterval(timer);
  const listMs = Date.now() - at;
  assert.ok(ticks > 0, 'the event loop runs while it lists');
  at = Date.now();
  assert.equal(await store.count(root), 500);
  const countMs = Date.now() - at;
  assert.equal(gitStarts, 0, 'no process for either');
  assertClean(root);
  return `500 meetings: list ${listMs} ms, count ${countMs} ms`;
}

async function main() {
  for (const test of [plainRepository, worktrees, subfolders, withoutGit, othersFiles, unIgnoring, names, beingRecorded, life, deleting, brokenEntries, traversal, links, failedDisk]) {
    await test();
    console.log(`passed: ${test.name}`);
  }
  console.log(`passed: many (${await many()})`);
  for (const code of Object.keys(MESSAGES)) assert.match(code, /^meetings[A-Z][A-Za-z]+$/);
  console.log('Meetings store: all passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
