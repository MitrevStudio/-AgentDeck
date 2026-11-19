const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/host/git-status');
// The fixture is reached through a link (a junction on Windows), as a project's folder can be: git names a checkout
// by its real path, the watchers go by the path they were given. The Windows CI runner's temp folder is such a path
// by itself (a short name, "RUNNER~1").
const real = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-')), root = real + '-link';
fs.symlinkSync(real, root, 'junction');
// A watchers' pass comes when their delay lets it - two seconds, longer after a slow pass on a busy machine - so the
// test waits for the state it reports (onChange, as the pages do), not for a time.
let onChange = () => {};
const until = (isDone, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out waiting for: ${what}`)), 120000);
  onChange = () => {
    if (!isDone()) return;
    clearTimeout(timer);
    onChange = () => {};
    resolve();
  };
  onChange();
});
async function main() {
  try {
    const backend = path.join(root, 'apps', 'backend'), frontend = path.join(root, 'apps', 'frontend');
    for (const dir of [backend, frontend, path.join(root, 'node_modules', 'ignored')]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '--quiet', dir], { windowsHide: true });
      fs.writeFileSync(path.join(dir, 'a file.txt'), 'example');
    }
    const result = await git.discoverRepositories([root, backend]);
    assert.deepEqual(result.repos.sort(), [backend, frontend].sort());
    assert.equal(result.truncated, false);
    assert.equal((await git.discoverRepositories([root], { maxDirs: 1 })).truncated, true);
    // Each project has its own budget: a big one that spends it does not leave another one unscanned, and is named.
    const scan = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-scan-'));
    const big = path.join(scan, 'big'), small = path.join(scan, 'small', 'repo');
    for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(big, `d${i}`), { recursive: true });
    fs.mkdirSync(small, { recursive: true });
    execFileSync('git', ['init', '--quiet', small], { windowsHide: true });
    const budget = await git.discoverRepositories([big, path.join(scan, 'small')], { maxDirs: 4 });
    assert.deepEqual(budget.repos, [small]);
    assert.equal(budget.truncated, true);
    assert.deepEqual(budget.truncatedIn, [big]);
    // Below the depth limit: inside a repository it is that repository's source tree, so not reported; outside one, a
    // repository could be missed there, so the project is named - and the rest of it is still scanned.
    const source = path.join(scan, 'deep', 'app');
    fs.mkdirSync(path.join(source, 'src', 'main', 'java'), { recursive: true });
    execFileSync('git', ['init', '--quiet', source], { windowsHide: true });
    const sourceTree = await git.discoverRepositories([path.join(scan, 'deep')], { maxDepth: 2 });
    assert.deepEqual(sourceTree.repos, [source]);
    assert.equal(sourceTree.truncated, false);
    const loose = path.join(scan, 'deep', 'loose');
    fs.mkdirSync(path.join(loose, 'a', 'b'), { recursive: true });
    const deep = await git.discoverRepositories([path.join(scan, 'deep')], { maxDepth: 2 });
    assert.deepEqual(deep.truncatedIn, [path.join(scan, 'deep')]);
    assert.deepEqual(deep.repos, [source], 'the depth note does not stop the scan');
    // The overall ceiling: projects past it are named too.
    const capped = await git.discoverRepositories([big, path.join(scan, 'small')], { maxDirs: 10, maxTotal: 7 });
    assert.deepEqual(capped.truncatedIn.sort(), [big, path.join(scan, 'small')].sort());
    // A repository's own tree is walked in full and spends no budget: a nested repository and an agent's worktree are
    // found however deep they are, and one big repository is not reported as cut short.
    const work = path.join(scan, 'work'), parent = path.join(work, 'parent-repo');
    const child = path.join(parent, 'src', 'main', 'java', 'modules', 'child-app'), worktree = path.join(parent, '.claude', 'worktrees', 'fix-login');
    for (let i = 0; i < 30; i++) fs.mkdirSync(path.join(parent, 'src', `package${i}`), { recursive: true });
    for (const dir of [parent, child, worktree]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '--quiet', dir], { windowsHide: true });
    }
    const nested = await git.discoverRepositories([work], { maxDepth: 2, maxDirs: 10 });
    assert.deepEqual(nested.repos.sort(), [parent, child, worktree].sort(), 'nested repositories below the depth limit');
    assert.equal(nested.truncated, false, 'a source tree is no reason for the note');
    // The ceiling counts every folder. Where it stops the walk inside a repository, a nested one may be missed: the
    // project is named.
    const cut = await git.discoverRepositories([work], { maxTotal: 20 });
    assert.deepEqual(cut.repos, [parent]);
    assert.deepEqual(cut.truncatedIn, [work]);
    fs.rmSync(scan, { recursive: true, force: true });
    // The scope of Settings > Git. "open": a folder's own repository and those right in a folder that is in none -
    // what the panel lists then; the repositories nested in a repository (reference clones, say) are neither looked
    // for nor asked about. "all": every one in a project. A change of the scope is taken by the next refresh.
    const scoped = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-scope-'));
    const project = path.join(scoped, 'project'), reference = path.join(project, 'refs', 'a', 'b', 'reference');
    const plain = path.join(scoped, 'plain'), direct = path.join(plain, 'direct'), inner = path.join(direct, 'inner'), far = path.join(plain, 'x', 'far');
    for (const dir of [project, reference, direct, inner, far]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '--quiet', dir], { windowsHide: true });
    }
    const shallow = await git.discoverRepositories([project, plain], { shallow: true });
    assert.deepEqual(shallow.repos.sort(), [project, direct].sort(), 'a shallow walk stops at a repository and one level down');
    assert.equal(shallow.truncated, false, 'a shallow walk is not a scan cut short');
    let scope = 'open', open = [];
    const keys = dirs => dirs.map(git.norm).sort();
    git.start({ dirs: () => [project, plain, ...open], projects: () => [project, plain], open: () => open, scope: () => scope });
    assert.deepEqual(Object.keys((await git.refresh({ force: true })).repos).sort(), keys([project, direct]), 'the open scope leaves nested repositories alone');
    assert.equal(git.get().discoveryTruncated, false);
    open = [path.join(plain, 'x')];
    assert.deepEqual(Object.keys((await git.refresh()).repos).sort(), keys([project, direct, far]), 'a repository right in a folder with an open terminal');
    scope = 'all';
    assert.deepEqual(Object.keys((await git.refresh()).repos).sort(), keys([project, reference, direct, inner, far]), 'the scope "all" lists every repository in the projects');
    scope = 'open';
    open = [];
    assert.deepEqual(Object.keys((await git.refresh()).repos).sort(), keys([project, direct]), 'back to the open scope');
    git.stop();
    fs.rmSync(scoped, { recursive: true, force: true });
    git.start({ dirs: () => [root], projects: () => [root] });
    const snapshot = await git.refresh({ force: true });
    assert.equal(Object.keys(snapshot.repos).length, 2);
    for (const repo of Object.values(snapshot.repos)) {
      assert.equal(repo.untracked, 1);
      assert.deepEqual(repo.files, [{ status: '??', path: 'a file.txt' }]);
    }
    assert.equal((await git.diff({ root: backend, file: 'a file.txt' })).untracked, '+example');
    const run = (...args) => execFileSync('git', ['-C', backend, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true });
    run('add', '--', 'a file.txt');
    run('-c', 'core.hooksPath=' + path.join(root, 'no-hooks'), 'commit', '--quiet', '-m', 'fixture');
    fs.writeFileSync(path.join(backend, 'a file.txt'), 'staged\n');
    run('add', '--', 'a file.txt');
    fs.writeFileSync(path.join(backend, 'a file.txt'), 'working\n');
    const changes = await git.diff({ root: backend, file: 'a file.txt' });
    assert.match(changes.staged, /\+staged/);
    assert.match(changes.unstaged, /\+working/);
    assert.doesNotMatch(changes.staged, /\+working/);
    fs.writeFileSync(path.join(backend, 'binary.bin'), Buffer.from([0, 1, 2]));
    assert.equal((await git.diff({ root: backend, file: 'binary.bin' })).binary, true);
    fs.writeFileSync(path.join(backend, 'large.txt'), Buffer.alloc(512 * 1024 + 1, 65));
    assert.equal((await git.diff({ root: backend, file: 'large.txt' })).tooLarge, true);
    await assert.rejects(git.diff({ root: backend, file: '../../outside.txt' }));
    await assert.rejects(git.diff({ root, file: 'apps/backend/a file.txt' }));
    fs.writeFileSync(path.join(backend, '[literal].txt'), 'literal');
    assert.equal((await git.diff({ root: backend, file: '[literal].txt' })).untracked, '+literal');
    run('add', '--', '[literal].txt');
    assert.match((await git.diff({ root: backend, file: '[literal].txt' })).staged, /\+literal/);
    const status = git.parseStatus('1 MM N... 100644 100644 100644 abc def folder/with spaces.txt\0' +
      '2 R. N... 100644 100644 100644 abc def R100 new name.txt\0old name.txt\0' +
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\0');
    assert.equal(status.files[0].path, 'folder/with spaces.txt');
    assert.equal(status.files[1].original, 'old name.txt');
    assert.equal(status.files[1].path, 'new name.txt');
    assert.equal(status.files[2].path, 'conflict.txt');
    assert.equal(status.conflicts, 1);
    assert.equal(status.filesTruncated, false);
    const large = git.parseStatus(Array.from({ length: 2001 }, (_, i) => `? file${i}\0`).join(''));
    assert.equal(large.files.length, 2000);
    assert.equal(large.filesTruncated, true);
    for (const noise of ['target/classes/A.class', 'node_modules/x/index.js', '.idea/workspace.xml', '.claude/worktrees/fix/src/a.js', 'sub/Build/out.txt']) assert.ok(git.WATCH_NOISE.test(noise), noise);
    for (const real of ['src/main/App.java', '.claude/settings.json', 'targets.txt', '.gitignore']) assert.equal(git.WATCH_NOISE.test(real), false, real);
    git.start({ dirs: () => [root], projects: () => [root], active: () => true, onChange: () => onChange() });
    await git.refresh({ force: true });
    git.get().repos[git.norm(frontend)].at = 0; // past TTL_MS: a full pass would check it again
    fs.mkdirSync(path.join(backend, 'target'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'target', 'ignored.txt'), 'build output');
    fs.writeFileSync(path.join(backend, 'watched.txt'), 'new');
    const seen = () => git.get().repos[git.norm(backend)].files.some(f => f.path === 'watched.txt');
    await until(seen, 'a watched change refreshes its repository');
    assert.equal(git.get().repos[git.norm(frontend)].at, 0, 'a watched change does not check the other repositories');
    git.refresh(); // asked for while the watchers' pass is still reporting: it runs right after that one
    await until(() => git.get().repos[git.norm(frontend)].at > 0, 'a plain refresh still checks a stale repository');
    // A linked worktree keeps its index in the main checkout's .git/worktrees/<name>: staging there changes no file in
    // the worktree's own folder, yet its status must follow.
    const linked = path.join(root, 'apps', 'backend-linked');
    run('worktree', 'add', '--quiet', '-b', 'linked', linked);
    fs.writeFileSync(path.join(linked, 'linked.txt'), 'new');
    await git.refresh({ force: true });
    assert.equal(git.get().repos[git.norm(linked)].untracked, 1);
    execFileSync('git', ['-C', linked, 'add', '--', 'linked.txt'], { windowsHide: true });
    await until(() => git.get().repos[git.norm(linked)].staged === 1, "staging in a linked worktree refreshes the worktree's status");
    const delay = git.getWatchDelay();
    assert.ok(delay >= 10000 && delay <= 60000, 'the next watched pass waits at least ten seconds, longer after a slow one');
    console.log('Nested repository discovery, real Git status, spaced names, renames, conflicts, limits, watched refreshes and linked worktrees passed');
  } finally {
    git.stop();
    fs.rmSync(root, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
