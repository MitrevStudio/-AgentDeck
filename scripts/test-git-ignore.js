// What git ignores, as git-ignore.js tells it without starting git - checked against `git check-ignore` itself in a
// real repository wherever git has an answer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createGitIgnores, getDefaultExcludesFile } = require('../src/host/git-ignore');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ignore-'));
const root = path.join(tmp, 'repo'), userRules = path.join(tmp, 'user-ignore'), userConfig = path.join(tmp, 'user-config');
// Git with this test's own user config: its excludes file, and nothing of the machine's.
const env = { ...process.env, GIT_CONFIG_GLOBAL: userConfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true, env, stdio: 'pipe' });
const write = (rel, text = 'x\n', base = root) => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const gitIgnores = (rel, base = root) => spawnSync('git', ['-C', base, 'check-ignore', '-q', '--', rel], { windowsHide: true, env }).status === 0;
const isCaseBlind = process.platform === 'win32' || process.platform === 'darwin';

async function main() {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(userRules, '*.swp\n.DS_Store\n');
  fs.writeFileSync(userConfig, `[core]\n\texcludesfile = ${userRules.replace(/\\/g, '/')}\n`);
  git(root, 'init', '--quiet');
  write('.gitignore', [
    '# build output of a .NET solution', '.vs/', '[Bb]in/', '[Oo]bj/', '*.log', '!keep.log', '/rooted.txt', 'docs/*.tmp',
    'logs/', '!logs/keep.txt', 'gen/', 'Tmp/', 'with space.txt', '\\#hash.txt', ''
  ].join('\n'));
  write('src/.gitignore', '*.gen.js\n!important.gen.js\n/local.txt\nout/\n!gen/\n');
  write('src/deep/.gitignore', '!special.log\n');
  write('bin/.gitignore', '!keep.txt\n'); // a folder that is ignored: its own rules are never read
  write('.git/info/exclude', '*.excluded\n!not.excluded\n');
  // path -> what is expected; each is created as a file, so git answers for the same thing.
  const cases = {
    'bin/Debug/app.dll': true, 'Bin/Release/app.dll': true, 'App/obj/project.assets.json': true, 'App/Obj/x/y/z.cs': true,
    '.vs/Solution/v17/.suo': true, 'App/.vs/state.json': true,
    'bin/keep.txt': true,                      // not included again: its folder is ignored
    'logs/keep.txt': true, 'logs/a.txt': true, // the same within one file
    'src/Program.cs': false, 'README.md': false, 'binary/file.txt': false, 'App/objects.txt': false,
    'debug.log': true, 'src/debug.log': true, 'keep.log': false, 'src/keep.log': false,
    'rooted.txt': true, 'src/rooted.txt': false,
    'docs/a.tmp': true, 'docs/sub/a.tmp': false, 'other/docs/a.tmp': false,
    'src/a.gen.js': true, 'src/deep/b.gen.js': true, 'src/important.gen.js': false, 'a.gen.js': false,
    'src/local.txt': true, 'src/deep/local.txt': false, 'local.txt': false,
    'src/out/x.txt': true, 'out/x.txt': false,
    'src/deep/special.log': false, 'src/deep/other.log': true, 'src/special.log': true,
    'gen/a.js': true, 'src/gen/a.js': false,   // src/.gitignore includes src/gen again
    'a.excluded': true, 'src/b.excluded': true, 'not.excluded': false,
    'notes.swp': true, 'src/deep/.DS_Store': true,
    'tmp/a.txt': isCaseBlind, 'DEBUG.LOG': isCaseBlind,
    'with space.txt': true, '#hash.txt': true, 'src/файл.log': true, 'src/файл.txt': false
  };
  for (const rel of Object.keys(cases)) write(rel);
  write('plain/obj'); // a file named like a build folder

  const ignores = createGitIgnores({ excludesFile: () => userRules });
  // The first question about a folder may have to load its rules: the answer is a promise then, never a guess.
  const first = ignores.isIgnored(root, 'bin/Debug/app.dll');
  assert.ok(first instanceof Promise, 'rules are loaded on demand, without blocking');
  assert.equal(await first, true);
  for (const [rel, expected] of Object.entries(cases)) {
    assert.equal(await ignores.isIgnored(root, rel), expected, rel);
    assert.equal(gitIgnores(rel), expected, `git itself: ${rel}`);
    // Once loaded, the answer comes at once - nothing is read per change.
    assert.equal(ignores.isIgnored(root, rel), expected, `${rel}, asked again`);
    // As a watcher on Windows names it.
    assert.equal(ignores.isIgnored(root, rel.replaceAll('/', '\\')), expected, `${rel} with backslashes`);
  }
  // A folder pattern and the folder itself, which a watcher reports when something is added to it: it takes a look at
  // what the path is, once.
  assert.equal(await ignores.isIgnored(root, 'bin'), true, 'the ignored folder itself');
  assert.equal(ignores.isIgnored(root, 'bin'), true, 'remembered');
  assert.equal(await ignores.isIgnored(root, 'App\\obj'), true);
  assert.equal(await ignores.isIgnored(root, 'plain/obj'), false, 'a file with a folder pattern\'s name');
  assert.equal(gitIgnores('plain/obj'), false);
  assert.equal(await ignores.isIgnored(root, 'gone/obj'), false, 'deleted, or not there yet: not known to be a folder');
  fs.rmSync(path.join(root, 'plain', 'obj'));
  fs.mkdirSync(path.join(root, 'plain', 'obj'));
  assert.equal(await ignores.isIgnored(root, 'plain/obj'), false, 'what a path was is remembered...');
  assert.equal(await ignores.isIgnored(root, 'plain/obj', { renamed: true }), true, '...until it is created anew');
  // A folder that is not ignored, for a caller that takes a folder's own change for no change (git-status.js on
  // Windows): only folders, and only when asked.
  assert.equal(await ignores.isIgnored(root, 'src/deep'), false);
  assert.equal(await ignores.isIgnored(root, 'src/deep', { skipFolders: true }), true, 'a folder itself');
  assert.equal(await ignores.isIgnored(root, 'src\Program.cs', { skipFolders: true }), false, 'a file still counts');
  assert.equal(await ignores.isIgnored(root, 'src/gone.cs', { skipFolders: true }), false, 'and so does what is no longer there');
  // Paths that make no sense are not ignored.
  for (const odd of ['', '/', '../outside.log', 'src/../debug.log', null]) assert.equal(await ignores.isIgnored(root, odd), false, String(odd));

  // Rules are read again when told that they changed.
  write('.gitignore', '*.log\n');
  assert.equal(await ignores.isIgnored(root, 'bin/Debug/app.dll'), true, 'the old rules until then');
  ignores.reload(root);
  assert.equal(await ignores.isIgnored(root, 'bin/Debug/app.dll'), false, 'no longer ignored');
  assert.equal(await ignores.isIgnored(root, 'debug.log'), true);
  assert.equal(gitIgnores('bin/Debug/app.dll'), false);
  write('src/.gitignore', '*.cs\n');
  ignores.reload(root);
  assert.equal(await ignores.isIgnored(root, 'src/Program.cs'), true, 'a nested file\'s new rules');
  assert.equal(await ignores.isIgnored(root, 'src/a.gen.js'), false);

  // core.ignorecase is the repository's own setting.
  write('.gitignore', 'Tmp/\n*.log\n');
  for (const blind of [false, true]) {
    git(root, 'config', 'core.ignorecase', String(blind));
    ignores.reload(root);
    assert.equal(await ignores.isIgnored(root, 'tmp/a.txt'), blind, `core.ignorecase=${blind}`);
    assert.equal(await ignores.isIgnored(root, 'Tmp/a.txt'), true);
  }

  // A rules file that cannot be read (here: a folder in its place) means nothing is known, so nothing under it is
  // ignored - not even what the rules further up ignore.
  fs.mkdirSync(path.join(root, 'broken', '.gitignore'), { recursive: true });
  write('broken/debug.log');
  ignores.reload(root);
  assert.equal(await ignores.isIgnored(root, 'broken/debug.log'), false, 'an unreadable nested .gitignore');
  assert.equal(await ignores.isIgnored(root, 'debug.log'), true, 'the rest of the repository is not affected');
  fs.rmSync(path.join(root, '.gitignore'));
  fs.mkdirSync(path.join(root, '.gitignore'));
  ignores.reload(root);
  assert.equal(await ignores.isIgnored(root, 'debug.log'), false, 'an unreadable root .gitignore');
  assert.equal(await ignores.isIgnored(root, 'notes.swp'), false, 'and then not the user\'s rules either');
  fs.rmSync(path.join(root, '.gitignore'), { recursive: true });
  fs.rmSync(path.join(root, 'broken'), { recursive: true });

  // No rules at all, and a user's file that is not there.
  const none = createGitIgnores({ excludesFile: () => path.join(tmp, 'no-such-file') });
  assert.equal(await none.isIgnored(root, 'notes.swp'), false);
  assert.equal(await none.isIgnored(root, 'a.excluded'), true, 'info/exclude still applies');
  const failing = createGitIgnores({ excludesFile: () => { throw new Error('no git'); } });
  assert.equal(await failing.isIgnored(root, 'a.excluded'), true, 'not knowing the user\'s file leaves the other rules');

  // A linked worktree: its own .gitignore, the main checkout's info/exclude.
  write('.gitignore', 'bin/\n');
  git(root, 'add', '.gitignore');
  git(root, '-c', 'core.hooksPath=' + path.join(tmp, 'no-hooks'), 'commit', '--quiet', '-m', 'fixture');
  const linked = path.join(tmp, 'linked');
  git(root, 'worktree', 'add', '--quiet', '-b', 'linked', linked);
  write('.gitignore', 'bin/\n*.linked\n', linked);
  for (const [rel, expected] of Object.entries({ 'bin/a.dll': true, 'a.linked': true, 'a.excluded': true, 'not.excluded': false, 'src/a.txt': false, 'notes.swp': true })) {
    write(rel, 'x\n', linked);
    assert.equal(await ignores.isIgnored(linked, rel), expected, `linked worktree: ${rel}`);
    assert.equal(gitIgnores(rel, linked), expected, `git itself, linked worktree: ${rel}`);
  }
  assert.equal(await ignores.isIgnored(root, 'a.linked'), false, 'each checkout has its own rules');

  // Where git looks for the user's file when its config names none.
  assert.equal(getDefaultExcludesFile({ XDG_CONFIG_HOME: path.join(tmp, 'xdg') }, tmp), path.join(tmp, 'xdg', 'git', 'ignore'));
  assert.equal(getDefaultExcludesFile({}, tmp), path.join(tmp, '.config', 'git', 'ignore'));
  console.log(`Git ignore rules: ${Object.keys(cases).length} paths agree with git check-ignore; nested files, negation, folder patterns, info/exclude, the user's file, case, reloading, unreadable files and linked worktrees passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
