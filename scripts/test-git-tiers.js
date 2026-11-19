// Which repositories git-status.js starts git for, and when: only those in use (a live session, an open terminal) are
// looked after in the background; any other listed one is asked about when a page shows it, after an action on it, or
// on the user's Refresh; and nothing is asked while nobody is at the window. Real repositories and the real watcher
// where a status is needed, folders that only look like repositories (a .git folder) where one must never be asked
// for; every start of git is counted where it happens, and compared with the module's own count and log.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Every process git-status.js starts, before it is loaded: what, how, and how many at a time.
const spawned = [];
let runningNow = 0, runningMax = 0;
const realSpawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  const child = realSpawn.call(this, file, args, options);
  spawned.push({ file, args, options });
  runningMax = Math.max(runningMax, ++runningNow);
  let over = false;
  const end = () => { if (!over) runningNow--; over = true; }; // a program that is not there reports both
  child.once('close', end);
  child.once('error', end);
  return child;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-tiers-'));
// Nothing of the machine's git config: no filters, no excludes file of the user's.
process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'user-config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const git = require('../src/host/git-status');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (isDone, what, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (isDone()) return;
  throw new Error(`Timed out waiting for: ${what}`);
};
const init = dir => {
  fs.mkdirSync(dir, { recursive: true });
  childProcess.execFileSync('git', ['init', '--quiet', dir], { windowsHide: true, stdio: 'pipe' });
  return dir;
};
const write = (dir, name, text = String(Math.random())) => fs.writeFileSync(path.join(dir, name), text);

// A folder of customers' repositories that nobody works in, and four real ones.
const clinic = path.join(tmp, 'ClinicDesk');
const idle = Array.from({ length: 40 }, (_, i) => path.join(clinic, `customer-${String(i).padStart(2, '0')}`));
for (const dir of idle) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
const work = path.join(tmp, 'StudioPc');
const parent = init(path.join(work, 'parent-repo')), child = init(path.join(work, 'child-app'));
const shelf = init(path.join(work, 'shelf-tools')), archive = init(path.join(work, 'archive-site'));
fs.mkdirSync(path.join(child, 'src'));

const key = git.norm;
const log = [], seenLog = []; // the starts of git, and what the watchers reported that led to one
let focused = true, active = [], projects = [clinic];
const options = {
  dirs: () => [...projects, ...active], projects: () => projects, activeDirs: async () => active, focused: () => focused,
  log: line => (line.split(' ')[1] === 'seen' ? seenLog : log).push(line), watchDelayMs: 300, watchSettleMs: 100, fallbackMs: 60 * 60 * 1000
};
// The starts since the last call: [reason, repository], sorted. Without the one question that is about no repository:
// where the user's excludes file is, asked once when the first watcher needs it.
let seen = 0;
const starts = () => {
  const lines = log.slice(seen).map(line => { const [, reason, ...root] = line.split(' '); return [reason, key(root.join(' '))]; }).filter(([reason]) => reason !== 'config');
  seen = log.length;
  return lines.sort((a, b) => (a.join() < b.join() ? -1 : 1));
};
const statusOf = dir => git.get().repos[key(dir)];
const has = (dir, file) => Boolean(statusOf(dir)?.files.some(f => f.path === file));

async function main() {
  // 1. Forty repositories listed, nobody working in any, the window focused, nothing shown: listing them starts no
  // git, however many scans, timer rounds and watchers' passes go by.
  git.start({ ...options, fallbackMs: 150 });
  await git.refresh();
  assert.equal(Object.keys(git.get().unchecked).length, 40, 'all forty are listed');
  assert.deepEqual(git.get().repos, {}, 'none has a status, made up or real');
  await sleep(700); // several rounds of the fallback timer
  for (const reason of ['scan', 'watcher', 'timer', 'scan']) await git.refresh({ reason });
  assert.equal(git.stats().total, 0, 'listed repositories alone start no git');
  assert.equal(spawned.length, 0, 'and no other process');

  // 2. Two of the real ones are in use - one through a folder inside it. Git is started for those two and for no
  // other: once to begin with, then only after a change.
  git.start(options);
  projects = [clinic, work];
  active = [parent, path.join(child, 'src')];
  await git.refresh();
  assert.deepEqual(starts(), [['initial', key(child)], ['initial', key(parent)]], 'the first status of the two in use');
  assert.deepEqual(Object.keys(git.get().repos).sort(), [key(child), key(parent)].sort());
  assert.equal(Object.keys(git.get().unchecked).length, 42, 'the other real ones are listed, not asked about');
  for (const reason of ['scan', 'timer', 'watcher', 'scan']) await git.refresh({ reason });
  assert.deepEqual(starts(), [], 'nothing changed: nothing asked');
  write(parent, 'notes.txt');
  await until(() => has(parent, 'notes.txt'), 'the change in a repository in use');
  assert.deepEqual(starts(), [['watcher', key(parent)]], 'one start, for the one that changed');
  // A repository nobody works in has no watcher, and is not asked about because another one changed.
  write(shelf, 'notes.txt');
  write(child, 'notes.txt');
  await until(() => has(child, 'notes.txt'), 'the next change');
  await sleep(600);
  assert.deepEqual(starts(), [['watcher', key(child)]], 'the change next door starts nothing for the idle one');
  assert.ok(git.get().unchecked[key(shelf)], 'which still has no status');
  // The fallback asks about the ones in use only.
  for (const dir of [parent, child]) statusOf(dir).at = 0; // older than a status is kept for
  await git.refresh({ reason: 'timer' });
  assert.deepEqual(starts(), [['timer', key(child)], ['timer', key(parent)]], 'the fallback round: the two in use');

  // 3. Nobody at the window: changes start nothing, whatever else comes by; with the focus back, one pass takes them.
  focused = false;
  write(parent, 'away.txt');
  write(child, 'away.txt');
  await sleep(1200); // several times the watchers' delay
  for (const reason of ['scan', 'timer', 'watcher']) await git.refresh({ reason });
  assert.deepEqual(starts(), [], 'nothing is asked while nobody is there');
  assert.ok(!has(parent, 'away.txt'));
  focused = true;
  const back = await git.refresh({ reason: 'focus' });
  assert.equal(back.checked, 2, 'one pass for both');
  assert.deepEqual(starts(), [['watcher', key(child)], ['watcher', key(parent)]], 'the two that changed meanwhile, once each');
  assert.ok(has(parent, 'away.txt') && has(child, 'away.txt'));
  await sleep(800);
  await git.refresh({ reason: 'focus' });
  assert.deepEqual(starts(), [], 'and nothing after it');

  // 4. A page shows two of the idle ones: exactly those are asked about, once; again only when their status is old.
  write(archive, 'index.html');
  const shown = [shelf, archive, path.join(tmp, 'not-listed')];
  await git.refresh({ reason: 'page', shown });
  assert.deepEqual(starts(), [['page', key(archive)], ['page', key(shelf)]], 'the shown ones');
  assert.ok(has(archive, 'index.html') && has(shelf, 'notes.txt'));
  await git.refresh({ reason: 'page', shown });
  await git.refresh({ reason: 'focus', shown });
  assert.deepEqual(starts(), [], 'shown again while the status is fresh: nothing');
  statusOf(shelf).at = 0;
  await git.refresh({ reason: 'focus', shown });
  assert.deepEqual(starts(), [['focus', key(shelf)]], 'only the one whose status is old');
  // Asked for while a pass runs, the same repository is not started twice.
  statusOf(shelf).at = 0;
  await Promise.all([git.refresh({ reason: 'page', shown }), git.refresh({ reason: 'page', shown }), git.refresh({ reason: 'page', shown })]);
  await until(() => statusOf(shelf).at > 0, 'the folded request');
  await git.refresh();
  assert.deepEqual(starts(), [['page', key(shelf)]], 'three requests at once: one start');

  // 5. After an action on a repository: that repository, and no other. The user's Refresh: every listed one.
  await git.refreshRepo(archive);
  assert.deepEqual(starts(), [['action', key(archive)]], 'an action refreshes its own repository');
  runningMax = 0;
  const all = await git.refresh({ force: true });
  const forced = starts();
  assert.equal(forced.length, 44, 'the forced refresh asks about every listed repository');
  assert.ok(forced.every(([reason]) => reason === 'forced'));
  assert.equal(new Set(forced.map(([, root]) => root)).size, 44, 'each once');
  assert.equal(Object.keys(all.unchecked).length, 0);
  assert.ok(runningMax <= 2, `at most two gits at a time (${runningMax})`);
  // A file's changes are opened twice at once: the status they both need is asked for once. (The file is untracked,
  // so it is read, not diffed.)
  const [one, two] = await Promise.all([git.diff({ root: archive, file: 'index.html' }), git.diff({ root: archive, file: 'index.html' })]);
  assert.deepEqual(one, two);
  assert.deepEqual(starts(), [['diff', key(archive)]], 'the same question asked twice at once is one start');

  // 6. A repository nobody works in any more keeps its watcher for a short while - a terminal closed and opened again
  // changes nothing - and loses it after: its changes start nothing then.
  git.start({ ...options, activeGraceMs: 1500 });
  await git.refresh(); // both in use, as of now
  active = [parent];
  await git.refresh();
  active = [parent, path.join(child, 'src')];
  await git.refresh();
  assert.deepEqual(starts(), [], 'back within the grace: still looked after, nothing to ask');
  active = [parent];
  await git.refresh();
  await sleep(2200); // the grace ends; the pass that follows lets the watcher go
  write(child, 'later.txt');
  write(parent, 'later.txt');
  await until(() => has(parent, 'later.txt'), 'the change in the one still in use');
  await sleep(600);
  assert.deepEqual(starts(), [['watcher', key(parent)]], 'the one no longer in use is not asked about');
  assert.ok(!has(child, 'later.txt'), 'its status stays as it was');
  // In use again: nobody watched it meanwhile, so it is asked about once as its watcher goes up.
  active = [parent, child];
  await git.refresh();
  assert.deepEqual(starts(), [['active', key(child)]], 'in use again: one start');
  assert.ok(has(child, 'later.txt'), 'which brings what it missed');

  // 7. A linked worktree in use whose main checkout is not: staging in the worktree changes files only in the main
  // checkout's .git, so that is watched too - for the worktree's sake alone, its own changes start nothing.
  const run = (dir, ...args) => childProcess.execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true, stdio: 'pipe' });
  const linked = path.join(work, 'parent-fix');
  run(parent, 'add', '--', 'notes.txt');
  run(parent, '-c', 'core.hooksPath=' + path.join(tmp, 'no-hooks'), 'commit', '--quiet', '-m', 'fixture');
  run(parent, 'worktree', 'add', '--quiet', '-b', 'fix', linked);
  git.start({ ...options, activeGraceMs: 0 });
  active = [linked];
  await git.refresh();
  await git.refresh(); // the main checkout and the other one are out of use by now
  starts();
  write(linked, 'fix.txt');
  await until(() => has(linked, 'fix.txt'), 'a change in the worktree');
  run(linked, 'add', '--', 'fix.txt');
  await until(() => statusOf(linked).staged === 1, 'staging in the worktree');
  write(parent, 'main-only.txt');
  await sleep(1000);
  const afterLinked = starts();
  assert.ok(afterLinked.length >= 2 && afterLinked.every(([reason, root]) => reason === 'watcher' && root === key(linked)), `only the worktree is asked about (${JSON.stringify(afterLinked)})`);

  // The count and the log say the same as the processes started.
  const stats = git.stats();
  assert.equal(stats.total, log.length);
  assert.equal(stats.total, spawned.length, 'every start is counted');
  assert.equal(stats.reasons.config, 1, 'the excludes file is asked for once');
  assert.equal(Object.values(stats.reasons).reduce((a, b) => a + b, 0), stats.total);
  for (const line of log) assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z (initial|active|watcher|timer|focus|page|action|forced|diff|config) \S/, line);
  assert.equal(git.get().starts.total > 0, true, 'and the snapshot carries the count');
  // What a watcher saw that led to a start is in the log too: the repository and the file.
  assert.ok(seenLog.some(line => line.includes(` seen ${key(parent)} `) && line.endsWith(' notes.txt')), 'the file whose change was seen');
  assert.ok(seenLog.length <= stats.reasons.watcher, 'one line for a repository that changed, not one for every report');
  // No console host on Windows: git is started detached there, and as a plain child elsewhere.
  assert.ok(spawned.every(s => s.options.detached === (process.platform === 'win32') && s.options.windowsHide === true));
  // A git that does not answer is killed when its time is up, and one that prints without end when it printed too
  // much - each answered at once, with what happened as the error's code. (A stand-in program here.)
  const { runGit } = require('../src/host/git-run');
  const t0 = Date.now();
  const slow = await runGit(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 500 });
  assert.equal(slow.err?.code, 'ETIMEDOUT');
  assert.ok(Date.now() - t0 < 5000, `answered when the time was up (${Date.now() - t0} ms)`);
  const loud = await runGit(process.execPath, ['-e', 'setInterval(() => process.stdout.write("x".repeat(65536)), 1)'], { timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(loud.err?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  assert.equal((await runGit(path.join(tmp, 'no-such-program'), [])).err?.code, 'ENOENT');
  const fine = await runGit(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("note")']);
  assert.deepEqual([fine.err, fine.stdout, fine.stderr], [null, 'ok', 'note']);
  assert.equal((await runGit(process.execPath, ['-e', 'process.exit(3)'])).err?.code, 3);
  await until(() => runningNow === 0, 'the killed ones to be gone', 10000);
  console.log(`Git tiers passed: ${stats.total} starts in all (${Object.entries(stats.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}), none for the 40 idle repositories outside the forced refresh`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  git.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
