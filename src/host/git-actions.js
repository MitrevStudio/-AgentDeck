// Shared local/mesh Git service. Commands use argv, known repositories and explicit operations.
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { normPath } = require('../shared/util');

function run(root, args, { limit = 4 * 1024 * 1024, timeout = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-C', root,
    '-c', 'core.fsmonitor=false', ...args], { windowsHide: true, timeout, maxBuffer: limit,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' } }, (error, stdout, stderr) => {
    if (error) return reject(new Error(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'Git output exceeds the 4 MB preview limit. Narrow the selection or use a terminal.' : (stderr || error.message).trim().slice(0, 12000)));
    resolve({ output: stdout, messages: stderr.trim() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const value = (s, max = 4096) => {
  if (typeof s !== 'string' || !s || s.length > max || s.includes('\0')) throw new Error('Invalid Git argument');
  return s;
};
const ref = s => { value(s, 512); if (s.startsWith('-') || /[\s\x00-\x1f]/.test(s)) throw new Error('Invalid reference'); return s; };
function createGitActions({ status, refresh, parseStatus, context = () => ({}) }) {
  const queues = new Map();
  const rootOf = root => {
    const repo = status().repos[normPath(value(root))];
    if (!repo) throw new Error('Unknown repository. Refresh Git first.');
    return repo.root;
  };
  const text = async (root, args) => (await run(root, args)).output.trim();
  const current = async root => parseStatus((await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'])).output);
  async function operations(root) {
    const gitDir = await text(root, ['rev-parse', '--absolute-git-dir']);
    const exists = async name => fs.stat(path.join(gitDir, name)).then(() => true, () => false);
    if (await exists('rebase-merge') || await exists('rebase-apply')) return 'rebase';
    if (await exists('MERGE_HEAD')) return 'merge';
    if (await exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (await exists('REVERT_HEAD')) return 'revert';
    // A manual commit of a resolved conflict clears *_HEAD, but a multi-commit
    // sequence still needs --continue (or --abort). This lives per worktree.
    const todo = await fs.readFile(path.join(gitDir, 'sequencer', 'todo'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const step = /^(pick|revert)\s/m.exec(todo)?.[1];
    if (step) return step === 'pick' ? 'cherry-pick' : 'revert';
    return '';
  }
  async function preview(root) {
    const patch = (await run(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-color'])).output;
    const head = await text(root, ['rev-parse', '--verify', 'HEAD']).catch(() => 'unborn');
    const branch = await text(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => 'detached');
    const operation = await operations(root);
    const token = crypto.createHash('sha256').update([head, branch, operation, patch].join('\0')).digest('hex');
    return { patch, token };
  }
  async function worktrees(root) {
    const raw = (await run(root, ['worktree', 'list', '--porcelain', '-z'])).output;
    const list = []; let item;
    for (const field of raw.split('\0')) {
      if (field.startsWith('worktree ')) { item = { path: field.slice(9) }; list.push(item); }
      else if (item && field.startsWith('branch ')) item.branch = field.slice(7).replace(/^refs\/heads\//, '');
      else if (item && field.startsWith('HEAD ')) item.oid = field.slice(5);
      else if (item && /^(locked|prunable|bare|detached)( |$)/.test(field)) item[field.split(' ')[0]] = true;
    }
    const ctx = await context();
    for (const w of list) {
      const within = cwd => { const a = normPath(cwd), b = normPath(w.path); return a === b || a.startsWith(b + '/'); };
      w.sessions = (ctx.sessions || []).filter(s => within(s.workDir || s.cwd)).map(s => ({ id: s.id, agent: s.agent, title: s.title || s.id }));
      w.active = (ctx.terminals || []).filter(t => !t.exited && within(t.cwd)).map(t => ({ id: t.id, agent: t.agent, title: t.title }));
      w.active.push(...(ctx.live || []).filter(s => within(s.workDir || s.cwd)).map(s => ({ id: s.id, agent: s.agent })));
    }
    return list;
  }
  async function query(p = {}) {
    const root = rootOf(p.root);
    switch (p.kind) {
      case 'details': {
        const [branches, remotes, operation, trees, st] = await Promise.all([
          text(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
          text(root, ['remote']), operations(root), worktrees(root), current(root)
        ]);
        return { branches: branches.split('\n').filter(Boolean), remotes: remotes.split('\n').filter(Boolean), operation, worktrees: trees, status: st };
      }
      case 'preview': return preview(root);
      case 'history': {
        const skip = Number.isSafeInteger(p.skip) && p.skip >= 0 ? p.skip : 0;
        const st = await current(root); if (st.initial) return { commits: [] };
        const out = (await run(root, ['log', '-50', `--skip=${skip}`, '--format=%H%x00%an%x00%aI%x00%s%x00', 'HEAD', '--'])).output;
        const fields = out.split('\0'), commits = [];
        for (let i = 0; i + 3 < fields.length; i += 4) commits.push({ oid: fields[i].trim(), author: fields[i + 1], date: fields[i + 2], subject: fields[i + 3] });
        return { commits };
      }
      // Every branch, newest first, with parents and decorations: the renderer draws the graph from this.
      case 'graph': {
        const limit = Number.isSafeInteger(p.limit) ? Math.min(400, Math.max(1, p.limit)) : 150;
        const skip = Number.isSafeInteger(p.skip) && p.skip >= 0 ? p.skip : 0;
        const st = await current(root); if (st.initial) return { commits: [] };
        const out = (await run(root, ['log', '--all', '--date-order', `-${limit}`, `--skip=${skip}`, '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00'])).output;
        const fields = out.split('\0'), commits = [];
        for (let i = 0; i + 5 < fields.length; i += 6) {
          const oid = fields[i].trim(); if (!oid) continue;
          commits.push({ oid, parents: fields[i + 1].trim().split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4], refs: fields[i + 5].trim() });
        }
        return { commits };
      }
      case 'commit': {
        if (!/^[a-f0-9]{40,64}$/.test(p.oid || '')) throw new Error('Invalid commit');
        return { patch: (await run(root, ['show', '--format=fuller', '--no-ext-diff', '--no-textconv', '--no-color', p.oid, '--'])).output };
      }
      case 'compare': {
        const base = await text(root, ['rev-parse', '--verify', ref(p.base) + '^{commit}']);
        const mergeBase = await text(root, ['merge-base', base, 'HEAD']);
        const files = (await run(root, ['diff', '--name-only', '-z', '--no-renames', mergeBase, 'HEAD', '--'])).output.split('\0').filter(Boolean);
        if (p.file && !files.includes(value(p.file))) throw new Error('File is not part of this branch comparison');
        return { mergeBase, files, patch: (await run(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', mergeBase, 'HEAD', '--', ...(p.file ? [p.file] : [])])).output };
      }
      default: throw new Error('Unknown Git query');
    }
  }
  async function execute(p = {}) {
    const root = rootOf(p.root);
    // Linked worktrees share refs; serialize them too.
    const common = await text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const key = normPath(common), previous = queues.get(key) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      try { return await mutate(root, p); }
      finally { await refresh({ force: true }).catch(() => {}); }
    });
    queues.set(key, pending);
    try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
  }
  async function mutate(root, p) {
    const st = await current(root), operation = await operations(root);
    const clean = () => { if (st.files.length || operation) throw new Error('Commit or stash your changes and finish the current Git operation first.'); };
    if (p.action === 'stage' || p.action === 'unstage') {
      if (!Array.isArray(p.files) || !p.files.length || p.files.length > 2000) throw new Error('Select changed files');
      const files = new Set();
      for (const file of p.files) {
        value(file);
        const entry = st.files.find(f => f.path === file);
        const rel = path.relative(root, path.resolve(root, file));
        if (!entry || path.isAbsolute(file) || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('File changed since selection. Refresh Git.');
        files.add(file);
        // The old name of an indexed rename no longer exists in the index.
        // Reset needs both paths; add must only stage the selected new path.
        if (p.action === 'unstage' && entry.original) files.add(entry.original);
      }
      // --cached --force removes only index entries, preserving working files
      // even when they have changed again since staging in an unborn branch.
      const args = p.action === 'stage' ? ['add'] : st.initial ? ['rm', '--cached', '--force'] : ['reset', 'HEAD'];
      return run(root, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: [...files].join('\0') + '\0' });
    }
    if (p.action === 'commit') {
      if (st.conflicts) throw new Error('Resolve conflicts before committing');
      const review = await preview(root);
      if (!p.token || p.token !== review.token) throw new Error('Staged changes changed. Review the commit again.');
      if (!review.patch) throw new Error('No staged changes');
      return run(root, ['commit', '-m', value(p.message, 20000)]);
    }
    if (p.action === 'fetch') return run(root, ['fetch', '--all']);
    if (p.action === 'pull') { clean(); return run(root, ['pull', '--ff-only']); }
    if (p.action === 'push') {
      if (st.detached || st.initial) throw new Error('Select a branch with commits before pushing');
      if (st.upstream) return run(root, ['push']);
      const remotes = (await text(root, ['remote'])).split('\n');
      if (!remotes.includes(p.remote)) throw new Error('Select a remote');
      return run(root, ['push', '--set-upstream', p.remote, `refs/heads/${st.branch}`]);
    }
    if (p.action === 'switch' || p.action === 'branch') {
      clean(); const branch = ref(p.branch);
      if (p.action === 'branch') { await run(root, ['check-ref-format', '--branch', branch]); return run(root, ['switch', '-c', branch]); }
      const local = await text(root, ['show-ref', '--verify', `refs/heads/${branch}`]).then(() => true, () => false);
      if (local) return run(root, ['switch', '--', branch]);
      await text(root, ['show-ref', '--verify', `refs/remotes/${branch}`]);
      return run(root, ['switch', '--track', '--', branch]);
    }
    if (p.action === 'continue' || p.action === 'abort') {
      if (!operation) throw new Error('No Git operation in progress');
      if (p.action === 'continue' && st.conflicts) throw new Error('Resolve and stage conflicts first');
      return run(root, [operation, '--' + p.action]);
    }
    if (p.action === 'worktree-add') {
      const branch = ref(p.branch); await run(root, ['check-ref-format', '--branch', branch]);
      const destination = value(p.path);
      if (!path.isAbsolute(destination)) throw new Error('Use an absolute worktree path');
      const result = await run(root, ['worktree', 'add', '-b', branch, '--', destination, ref(p.base || 'HEAD')]);
      try { await (await context()).register?.(destination); }
      catch (error) { throw new Error(`Worktree created at ${destination}, but project registration failed: ${error.message}`); }
      return { ...result, path: destination };
    }
    if (p.action === 'worktree-remove') {
      const trees = await worktrees(root), item = trees.find(w => normPath(w.path) === normPath(value(p.path)));
      if (!item || item === trees[0] || item.locked || item.bare || item.active.length) throw new Error('Worktree is primary, locked or used by an active session/terminal');
      const state = await current(item.path);
      if (state.files.length || await operations(item.path)) throw new Error('Worktree has uncommitted changes or an unfinished operation');
      const result = await run(root, ['worktree', 'remove', '--', item.path]);
      await (await context()).unregister?.(item.path);
      return result;
    }
    throw new Error('Unknown Git action');
  }
  return { query, execute };
}
module.exports = { createGitActions, run };
