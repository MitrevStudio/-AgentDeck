// When git-status.js starts git: a real repository, the real watcher, and every start of git counted. Changes in
// what git ignores start none; a real change, a change of the rules and staging from outside start one; while nobody
// is at the window the watchers' checks are far apart, and getting the focus brings a waiting change at once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Counted where git-status.js starts git, before it is loaded: { at, args } of every call.
const started = [];
const realExecFile = childProcess.execFile;
childProcess.execFile = (file, args, ...rest) => {
  started.push({ at: Date.now(), file, args });
  return realExecFile(file, args, ...rest);
};
const statusRuns = () => started.filter(s => s.args.includes('status'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-watch-'));
// The user's git config of this test, for the git that git-status.js starts as well: nothing of the machine's.
process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'user-config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
fs.writeFileSync(path.join(tmp, 'user-ignore'), '*.userignored\n');
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, `[core]\n\texcludesfile = ${path.join(tmp, 'user-ignore').replace(/\\/g, '/')}\n`);
const git = require('../src/host/git-status');

const root = path.join(tmp, 'solution');
const run = (...args) => childProcess.execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true, stdio: 'pipe' });
const write = (rel, text = String(Math.random())) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Waits for a state, looking again at every report of git-status.js and a few times a second.
let onChange = () => {};
const until = (isDone, what, ms = 60000) => new Promise((resolve, reject) => {
  const done = () => {
    if (!isDone()) return;
    clearTimeout(timer); clearInterval(poll);
    onChange = () => {};
    resolve();
  };
  const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`Timed out waiting for: ${what}`)); }, ms);
  const poll = setInterval(done, 100);
  onChange = done;
  done();
});
const repo = () => git.get().repos[git.norm(root)];
const has = (file, status) => repo().files.some(f => f.path === file && (!status || f.status === status));
// Writes for `ms`, several times a second.
async function keepWriting(ms, writeAll) {
  for (const end = Date.now() + ms; Date.now() < end;) { writeAll(); await sleep(150); }
}
// A watcher's events come in order: once the status shows this new file, every change before it has been dealt with.
let marks = 0;
async function settle() {
  const mark = `mark-${++marks}.txt`;
  write(mark);
  await until(() => has(mark, '??'), `${mark} in the status`);
}

// ---------- the executable on Windows ----------
async function testExecutable() {
  const layout = files => ({ isFile: async file => files.includes(file) });
  const gfw = 'C:\\Program Files\\Git';
  const table = [
    ['Git for Windows', 'win32', `${gfw}\\cmd\\git.exe`, [`${gfw}\\mingw64\\bin\\git.exe`], `${gfw}\\mingw64\\bin\\git.exe`],
    ['its folder in another case', 'win32', 'D:\\Tools\\Git\\CMD\\GIT.EXE', ['D:\\Tools\\Git\\mingw64\\bin\\git.exe'], 'D:\\Tools\\Git\\mingw64\\bin\\git.exe'],
    ['on ARM', 'win32', `${gfw}\\cmd\\git.exe`, [`${gfw}\\clangarm64\\bin\\git.exe`], `${gfw}\\clangarm64\\bin\\git.exe`],
    ['32-bit', 'win32', `${gfw}\\cmd\\git.exe`, [`${gfw}\\mingw32\\bin\\git.exe`], `${gfw}\\mingw32\\bin\\git.exe`],
    ['64-bit before 32-bit', 'win32', `${gfw}\\cmd\\git.exe`, [`${gfw}\\mingw32\\bin\\git.exe`, `${gfw}\\mingw64\\bin\\git.exe`], `${gfw}\\mingw64\\bin\\git.exe`],
    ['a cmd folder without the real one', 'win32', 'C:\\Tools\\cmd\\git.exe', [], 'git'],
    ['the real one already on the PATH', 'win32', `${gfw}\\mingw64\\bin\\git.exe`, [`${gfw}\\mingw64\\bin\\git.exe`], 'git'],
    ['a shim', 'win32', 'C:\\Users\\someone\\scoop\\shims\\git.exe', ['C:\\Users\\someone\\scoop\\mingw64\\bin\\git.exe'], 'git'],
    ['a script', 'win32', `${gfw}\\cmd\\git.cmd`, [`${gfw}\\mingw64\\bin\\git.exe`], 'git'],
    ['not installed', 'win32', '', [], 'git'],
    ['Linux', 'linux', '/usr/bin/git', ['/usr/mingw64/bin/git.exe'], 'git'],
    ['macOS', 'darwin', '/opt/homebrew/cmd/git.exe', ['/opt/homebrew/mingw64/bin/git.exe'], 'git']
  ];
  for (const [what, platform, found, files, expected] of table) {
    assert.equal(await git.resolveGitExe({ platform, find: async () => found, ...layout(files) }), expected, what);
  }
  assert.equal(await git.resolveGitExe({ platform: 'win32', find: async () => `${gfw}\\cmd\\git.exe`, isFile: async () => { throw new Error('no access'); } }), 'git', 'a folder that cannot be looked into');
  // This machine's git: the one chosen answers as the one on the PATH does.
  const exe = await git.resolveGitExe();
  if (exe === 'git') return process.platform === 'win32' ? 'no Git for Windows layout here, smoke check skipped' : 'plain git';
  const version = file => childProcess.execFileSync(file, ['--version'], { windowsHide: true }).toString();
  assert.equal(version(exe), version('git'));
  return `runs ${exe}`;
}

async function main() {
  const executable = await testExecutable();

  // A .NET solution as Visual Studio leaves it, with the usual rules.
  fs.mkdirSync(root, { recursive: true });
  run('init', '--quiet');
  write('.gitignore', '.vs/\n[Bb]in/\n[Oo]bj/\n*.user\n');
  write('App/Program.cs', 'class Program {}\n');
  write('App/App.csproj', '<Project />\n');
  run('add', '.');
  run('-c', 'core.hooksPath=' + path.join(tmp, 'no-hooks'), 'commit', '--quiet', '-m', 'fixture');
  const ignoredWrites = n => {
    write('.vs/Solution/v17/.suo');
    write('.vs/Solution/FileContentIndex/' + n + '.vsidx');
    write('App/bin/Debug/net8.0/App.dll');
    write('App/obj/project.assets.json');
    write('App/obj/Debug/net8.0/App.AssemblyInfo.cs');
    write('App/obj/Debug/net8.0/tmp' + n + '.cache');
    write('App/App.csproj.user');
    write('scratch.userignored');
    write('bin/tool.exe');
    write('App/Notes' + n + '.user'); // new in a folder that is not ignored: Windows reports that folder as changed too
    for (const old of n > 2 ? ['App/obj/Debug/net8.0/tmp' + (n - 2) + '.cache', 'App/Notes' + (n - 2) + '.user'] : []) fs.rmSync(path.join(root, old), { force: true });
  };
  ignoredWrites(0);

  // The focused minimum is shortened as the unfocused gap is below: the steps here wait for one watched pass each.
  const options = { dirs: () => [root], projects: () => [root], active: () => true, focused: () => true, watchDelayMs: 2000, onChange: () => onChange() };
  git.start(options);
  await git.refresh({ force: true });
  assert.deepEqual(repo().files, [], 'nothing but ignored files');
  await settle(); // the watcher is up and has the rules
  const count = () => statusRuns().length;

  // 1. An IDE and a build writing into ignored folders, for longer than two watchers' passes are apart.
  let before = count(), n = 0;
  await keepWriting(5000, () => ignoredWrites(++n));
  assert.equal(count() - before, 0, 'changes in ignored paths start no git status');
  await settle();
  assert.equal(count() - before, 1, 'only the mark that followed them did');
  assert.ok(!started.some(s => s.args.includes('check-ignore')), 'and git is not asked what is ignored');
  assert.ok(started.filter(s => s.args.includes('config')).length <= 1, 'where the user\'s excludes file is, is asked once');

  // 2. A tracked file and a new file that is not ignored.
  before = count();
  write('App/Program.cs', 'class Program { }\n');
  await until(() => has('App/Program.cs', '.M'), 'a tracked file\'s change');
  assert.equal(count() - before, 1, 'one status for a tracked file\'s change');
  before = count();
  write('App/New.cs');
  await until(() => has('App/New.cs', '??'), 'a new file');
  assert.equal(count() - before, 1, 'one status for a new file');

  // 3. The rules change: one status, and what is ignored follows - both ways.
  write('notes.draft');
  await until(() => has('notes.draft', '??'), 'a file not ignored yet');
  before = count();
  write('.gitignore', '.vs/\n[Oo]bj/\n*.user\n*.draft\n');
  await until(() => has('.gitignore', '.M') && !has('notes.draft'), 'the changed rules');
  await settle();
  assert.ok(has('App/bin/Debug/net8.0/App.dll', '??'), 'bin/ is no longer ignored');
  before = count();
  await keepWriting(3000, () => { write('notes.draft'); write('App/obj/project.assets.json'); });
  assert.equal(count() - before, 0, 'the newly ignored file starts no status');
  write('App/bin/Debug/net8.0/App.pdb');
  await until(() => has('App/bin/Debug/net8.0/App.pdb', '??'), 'a change in what is no longer ignored');

  // 4. Staging from outside changes only .git.
  run('add', '--', 'App/Program.cs');
  await until(() => has('App/Program.cs', 'M.'), 'staging from outside');

  // 4b. The passes keep their distance from the last pass, not from the change: after a quiet while a change shows
  // at once, and the one right behind it waits out the distance.
  const DISTANCE = 6000;
  options.watchDelayMs = DISTANCE;
  options.watchSettleMs = 300;
  await sleep(DISTANCE + 300); // nothing was asked of git for as long as the passes are apart
  let t = Date.now();
  write('App/Quiet.cs');
  await until(() => has('App/Quiet.cs', '??'), 'a change after a quiet while');
  assert.ok(Date.now() - t < DISTANCE / 2, `seen ${Date.now() - t} ms after it, not a whole distance later`);
  t = Date.now();
  before = count();
  write('App/Close.cs');
  await until(() => has('App/Close.cs', '??'), 'a change right behind a pass');
  assert.ok(Date.now() - t >= DISTANCE - 1500, `the next pass kept its distance (${Date.now() - t} ms)`);
  assert.equal(count() - before, 1, 'and was one pass');
  options.watchDelayMs = 2000;
  delete options.watchSettleMs;

  // 5. Nobody at the window: the watchers' passes are a long gap apart, however much changes. (The gap is shortened
  // here; the first pass after the switch may still be one that was waiting from before.)
  const GAP = 5000;
  options.watchUnfocusedMs = GAP;
  options.focused = () => false;
  assert.equal(git.getWatchDelay(), GAP);
  before = count();
  await keepWriting(GAP * 2 + 3500, () => write('App/Busy.cs'));
  const runs = statusRuns().slice(before).map(s => s.at);
  assert.ok(runs.length >= 2, `changes are still seen while unfocused (${runs.length} passes)`);
  assert.ok(runs.length <= 4, `at most one pass per gap (${runs.length} passes in ${GAP * 2 + 3500} ms)`);
  for (let i = 2; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= GAP - 100, `passes ${runs[i] - runs[i - 1]} ms apart`);
  assert.ok(runs.at(-1) - runs.at(-2) >= GAP - 100, `the last two passes ${runs.at(-1) - runs.at(-2)} ms apart`);
  options.focused = () => true;
  assert.ok(git.getWatchDelay() < GAP, 'the short delay again with the focus');

  // 6. The window gets the focus: the page asks for a refresh, which takes a waiting change at once although the
  // status was checked a moment ago - and without it nothing would be asked.
  options.focused = () => false;
  options.watchUnfocusedMs = 10 * 60 * 1000;
  await git.refresh();
  await sleep(500);
  await git.refresh(); // whatever was still on its way
  before = count();
  await git.refresh();
  assert.equal(count() - before, 0, 'a status checked moments ago is not asked for again');
  const t0 = Date.now();
  write('App/Waiting.cs');
  options.focused = () => true;
  await until(() => { git.refresh().catch(() => {}); return has('App/Waiting.cs', '??'); }, 'the waiting change after the focus', 15000);
  assert.ok(Date.now() - t0 < 15000, 'well within the time a status is kept for');
  assert.equal(count() - before, 1, 'one status for it');
  // The same without anybody asking: the next change after the focus brings the waiting pass forward.
  options.focused = () => false;
  write('App/Waiting2.cs');
  await sleep(500);
  assert.ok(!has('App/Waiting2.cs'), 'waits while unfocused');
  options.focused = () => true;
  write('App/Waiting3.cs');
  await until(() => has('App/Waiting2.cs', '??') && has('App/Waiting3.cs', '??'), 'a waiting pass brought forward', 20000);

  console.log(`Git watching passed: ignored changes start no status, real ones, rule changes and outside staging do, unfocused gap, focus flush; executable: ${executable}`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  git.stop();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
