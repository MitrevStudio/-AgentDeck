const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/host/git-status');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-git-'));
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
    git.start({ dirs: () => [root], projects: () => [root], active: () => true });
    await git.refresh({ force: true });
    git.get().repos[git.norm(frontend)].at = 0; // past TTL_MS: a full pass would check it again
    fs.mkdirSync(path.join(backend, 'target'), { recursive: true });
    fs.writeFileSync(path.join(backend, 'target', 'ignored.txt'), 'build output');
    fs.writeFileSync(path.join(backend, 'watched.txt'), 'new');
    const seen = () => git.get().repos[git.norm(backend)].files.some(f => f.path === 'watched.txt');
    for (const deadline = Date.now() + 10000; !seen() && Date.now() < deadline;) await new Promise(r => setTimeout(r, 200));
    assert.ok(seen(), 'a watched change refreshes its repository');
    assert.equal(git.get().repos[git.norm(frontend)].at, 0, 'a watched change does not check the other repositories');
    await git.refresh();
    assert.ok(git.get().repos[git.norm(frontend)].at > 0, 'a plain refresh still checks a stale repository');
    console.log('Nested repository discovery, real Git status, spaced names, renames, conflicts, limits and watched refreshes passed');
  } finally { git.stop(); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
