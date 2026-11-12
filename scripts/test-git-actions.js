const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGitActions } = require('../src/host/git-actions');
const { parseStatus, norm } = require('../src/host/git-status');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-actions-'));
process.env.GIT_CONFIG_GLOBAL = path.join(temp, 'empty-config');
process.env.GIT_CONFIG_NOSYSTEM = '1';
const root = path.join(temp, 'repo'), remote = path.join(temp, 'remote.git'), tree = path.join(temp, 'task');
const command = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
let registered = '', active = [], refreshed = 0;
const service = createGitActions({ status: () => ({ repos: { [norm(root)]: { root } } }), parseStatus,
  refresh: async () => { refreshed++; }, context: () => ({ terminals: active, register: p => { registered = p; }, unregister: () => { registered = ''; } }) });
const execute = args => service.execute({ root, ...args });
const query = args => service.query({ root, ...args });
async function regressions() {
  function fixture(name) {
    const dir = path.join(temp, name); fs.mkdirSync(dir);
    const git = (...args) => command(dir, ...args);
    git('init', '-b', 'main');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', path.join(temp, 'no-hooks')]]) git('config', key, value);
    const api = createGitActions({ status: () => ({ repos: { [norm(dir)]: { root: dir } } }), parseStatus, refresh: async () => {} });
    return { dir, git, write: (file, content) => fs.writeFileSync(path.join(dir, file), content),
      act: args => api.execute({ root: dir, ...args }), query: kind => api.query({ root: dir, kind }) };
  }
  const unborn = fixture('unborn');
  unborn.write('partial.txt', 'staged\n');
  await unborn.act({ action: 'stage', files: ['partial.txt'] });
  unborn.write('partial.txt', 'new working content\n');
  await unborn.act({ action: 'unstage', files: ['partial.txt'] });
  assert.equal(unborn.git('ls-files'), '');
  assert.equal(fs.readFileSync(path.join(unborn.dir, 'partial.txt'), 'utf8'), 'new working content\n');

  const rename = fixture('rename');
  rename.write('old.txt', 'one\ntwo\nthree\n'); rename.git('add', '.'); rename.git('commit', '-m', 'initial');
  rename.git('mv', 'old.txt', 'new.txt'); rename.write('new.txt', 'one\ntwo\nthree\nfour\n');
  await rename.act({ action: 'stage', files: ['new.txt'] });
  assert.equal(rename.git('show', ':new.txt'), 'one\ntwo\nthree\nfour');
  // Reusing the original name must not silently stage an unrelated new file.
  rename.write('old.txt', 'unrelated\n'); rename.write('new.txt', 'one\ntwo\nthree\nfive\n');
  await rename.act({ action: 'stage', files: ['new.txt'] });
  assert.equal(rename.git('ls-files', 'old.txt'), '');
  await rename.act({ action: 'unstage', files: ['new.txt'] });
  assert.equal(rename.git('diff', '--cached'), '');
  assert.equal(fs.readFileSync(path.join(rename.dir, 'old.txt'), 'utf8'), 'unrelated\n');

  for (const operation of ['cherry-pick', 'revert']) for (const finish of ['continue', 'abort']) {
    const f = fixture(`${operation}-${finish}`);
    f.write('a.txt', 'base\n'); f.git('add', '.'); f.git('commit', '-m', 'base');
    if (operation === 'cherry-pick') f.git('switch', '-c', 'feature');
    f.write('a.txt', 'feature\n'); f.git('commit', '-am', 'first'); const first = f.git('rev-parse', 'HEAD');
    f.write('b.txt', 'second\n'); f.git('add', '.'); f.git('commit', '-m', 'second'); const second = f.git('rev-parse', 'HEAD');
    if (operation === 'cherry-pick') f.git('switch', 'main');
    f.write('a.txt', 'main\n'); f.git('commit', '-am', 'main');
    assert.throws(() => f.git(operation, first, second));
    assert.equal((await f.query('details')).operation, operation);
    f.write('a.txt', 'resolved\n'); await f.act({ action: 'stage', files: ['a.txt'] });
    const review = await f.query('preview'); await f.act({ action: 'commit', message: 'resolved', token: review.token });
    assert.equal(fs.existsSync(path.join(f.dir, '.git', operation === 'revert' ? 'REVERT_HEAD' : 'CHERRY_PICK_HEAD')), false);
    assert.equal((await f.query('details')).operation, operation, 'sequencer survives a manual conflict-resolution commit');
    await assert.rejects(f.act({ action: 'branch', branch: 'blocked' }), /finish the current Git operation/);
    await f.act({ action: finish });
    assert.equal((await f.query('details')).operation, '');
    // Git may keep the manual commit on abort because HEAD moved. Do not
    // override that native safeguard with a reset; only the sequence must end.
    if (finish === 'abort') assert.equal(fs.existsSync(path.join(f.dir, '.git', 'sequencer')), false);
    else assert.equal(fs.existsSync(path.join(f.dir, 'b.txt')), operation === 'cherry-pick', 'continue processes the remaining commit');
  }
}
async function main() {
  try {
    await regressions();
    fs.mkdirSync(root);
    command(root, 'init', '-b', 'main');
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', path.join(temp, 'no-hooks')]]) command(root, 'config', key, value);
    const write = (name, text) => fs.writeFileSync(path.join(root, name), text);
    write('a.txt', 'one\n'); write('[literal].txt', 'safe\n');
    await execute({ action: 'stage', files: ['a.txt', '[literal].txt'] });
    await execute({ action: 'unstage', files: ['[literal].txt'] });
    let review = await query({ kind: 'preview' });
    assert.match(review.patch, /one/); assert.doesNotMatch(review.patch, /safe/);
    await execute({ action: 'commit', message: 'initial', token: review.token });
    assert.equal(command(root, 'log', '-1', '--format=%s'), 'initial');
    await execute({ action: 'stage', files: ['[literal].txt'] });
    review = await query({ kind: 'preview' });
    write('a.txt', 'two\n'); await execute({ action: 'stage', files: ['a.txt'] });
    await assert.rejects(execute({ action: 'commit', message: 'stale', token: review.token }), /changed/);
    review = await query({ kind: 'preview' }); await execute({ action: 'commit', message: 'second', token: review.token });
    await assert.rejects(execute({ action: 'stage', files: ['../escape'] }));
    await assert.rejects(execute({ action: 'branch', branch: '--bad' }));
    await assert.rejects(service.query({ root: temp, kind: 'details' }), /Unknown repository/);
    await execute({ action: 'branch', branch: 'feature' });
    write('a.txt', 'feature\n');
    await assert.rejects(execute({ action: 'switch', branch: 'main' }), /Commit or stash/);
    await execute({ action: 'stage', files: ['a.txt'] });
    review = await query({ kind: 'preview' }); await execute({ action: 'commit', message: 'feature change', token: review.token });
    const comparison = await query({ kind: 'compare', base: 'main' });
    assert.match(comparison.patch, /\+feature/); assert.deepEqual(comparison.files, ['a.txt']);
    const history = await query({ kind: 'history' }); assert.equal(history.commits.length, 3);
    const graph = await query({ kind: 'graph', limit: 10 });
    assert.equal(graph.commits.length, 3);
    assert.ok(graph.commits.every(c => typeof c.subject === 'string' && Array.isArray(c.parents)));
    assert.ok(graph.commits.some(c => c.parents.length), 'merge base keeps its parent');
    assert.match(graph.commits.map(c => c.refs).join(' '), /feature/);
    assert.match((await query({ kind: 'commit', oid: history.commits[0].oid })).patch, /feature change/);
    await execute({ action: 'switch', branch: 'main' });
    await execute({ action: 'worktree-add', branch: 'task', path: tree, base: 'main' });
    assert.equal(registered, tree);
    assert.equal((await query({ kind: 'details' })).worktrees.length, 2);
    active = [{ cwd: tree, id: 'active', exited: false }];
    await assert.rejects(execute({ action: 'worktree-remove', path: tree }), /active/);
    active = []; fs.writeFileSync(path.join(tree, 'untracked'), 'keep');
    await assert.rejects(execute({ action: 'worktree-remove', path: tree }), /uncommitted/);
    fs.unlinkSync(path.join(tree, 'untracked'));
    await execute({ action: 'worktree-remove', path: tree });
    assert.equal(fs.existsSync(tree), false); assert.equal(registered, '');
    command(temp, 'init', '--bare', remote); command(root, 'remote', 'add', 'origin', remote);
    await execute({ action: 'push', remote: 'origin' }); await execute({ action: 'fetch' }); await execute({ action: 'pull' });
    assert.equal((await query({ kind: 'details' })).status.upstream, 'origin/main');
    // Real divergent merge: report operation and conflicts; do not allow a commit.
    write('a.txt', 'main change\n'); await execute({ action: 'stage', files: ['a.txt'] });
    review = await query({ kind: 'preview' }); await execute({ action: 'commit', message: 'main change', token: review.token });
    assert.throws(() => command(root, 'merge', 'feature'));
    const conflict = await query({ kind: 'details' }); assert.equal(conflict.operation, 'merge'); assert.equal(conflict.status.conflicts, 1);
    await assert.rejects(execute({ action: 'continue' }), /conflicts/);
    await execute({ action: 'abort' }); assert.equal((await query({ kind: 'details' })).operation, '');
    // Hooks must run and their rejection must reach the caller without creating a commit.
    const hooks = path.join(temp, 'hooks'); fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "hook rejected fixture" >&2\nexit 1\n', { mode: 0o755 });
    command(root, 'config', 'core.hooksPath', hooks);
    write('a.txt', 'hook test\n'); await execute({ action: 'stage', files: ['a.txt'] });
    review = await query({ kind: 'preview' });
    await assert.rejects(execute({ action: 'commit', message: 'blocked', token: review.token }), /hook rejected fixture/);
    assert.notEqual(command(root, 'log', '-1', '--format=%s'), 'blocked');
    const { createServed } = require('../src/mesh/serve');
    const served = createServed({ host: { git: service } });
    assert.equal((await served.api('git.query', { root, kind: 'details' }, { id: 'peer' })).status.branch, 'main');
    await served.api('git.execute', { root, action: 'unstage', files: ['a.txt'] }, { id: 'peer' });
    assert.equal((await query({ kind: 'preview' })).patch, '');
    await assert.rejects(served.api('git.execute', { root: temp, action: 'fetch' }, { id: 'peer' }), /Unknown repository/);
    // Staging and unstaging refresh that repository alone; anything else still refreshes everything.
    const calls = [];
    const indexOnly = createGitActions({ status: () => ({ repos: { [norm(root)]: { root } } }), parseStatus,
      refresh: async o => { calls.push(['all', o.force]); }, refreshRepo: async r => { calls.push(['repo', norm(r)]); } });
    await indexOnly.execute({ root, action: 'stage', files: ['a.txt'] });
    await indexOnly.execute({ root, action: 'unstage', files: ['a.txt'] });
    await indexOnly.execute({ root, action: 'fetch' }).catch(() => {});
    assert.equal(JSON.stringify(calls), JSON.stringify([['repo', norm(root)], ['repo', norm(root)], ['all', true]]));
    assert.ok(refreshed > 15);
    console.log('Git actions: staging, initial commit, stale review, branches, history, comparison, worktrees, active/dirty guards, remotes and conflicts passed');
  } finally {
    const resolved = path.resolve(temp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('agentdeck-actions-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
