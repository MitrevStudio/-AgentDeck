// Git state of the projects' folders and the sessions' working folders: branch (or the commit of a detached HEAD),
// ahead/behind its upstream, staged/unstaged/untracked counts and conflicts. Read-only: `git status` runs without
// optional locks (so it never rewrites the index), without fsmonitor and without looking into submodules' work trees,
// and nothing is fetched - ahead and behind are as of the last fetch the user made. What remains is what any
// `git status` does: for a file whose timestamps changed it runs the clean filter that the user's or the repository's
// own git config sets for it (Git LFS, say), as git does in every terminal that shows the branch; a repository owned
// by another user is refused by git itself (safe.directory). A folder inside a repository shares the repository's
// status; one outside any is ruled out with a few stat calls, without starting git.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TTL_MS = 20 * 1000;             // a status younger than this is not asked for again
const BACKGROUND_MS = 2 * 60 * 1000;  // while a window that shows it is open
const ROOT_TTL_MS = 5 * 60 * 1000;    // where a folder's repository is, or that it has none
const TIMEOUT_MS = 10 * 1000;
const PARALLEL = 4;
const MISSING_RETRY_MS = 5 * 60 * 1000;
const ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=dirty"];

// As the pages' normPath(): the keys they look folders up by.
const { normPath: norm } = require("../shared/util");

// ---------- parsing ----------
// `git status --porcelain=v2 --branch -z`: "# " headers, then one entry per changed path. A rename/copy entry ("2")
// is followed by its original path as a field of its own, which must not be taken for an entry.
function parseStatus(out) {
  const st = { branch: "", oid: "", detached: false, initial: false, upstream: "", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  st.files = [];
  let fileCount = 0;
  const fields = String(out).split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.startsWith("# ")) {
      const sp = f.indexOf(" ", 2), k = f.slice(2, sp < 0 ? undefined : sp), v = sp < 0 ? "" : f.slice(sp + 1);
      if (k === "branch.oid") { st.initial = v === "(initial)"; st.oid = st.initial ? "" : v; }
      else if (k === "branch.head") { if (v === "(detached)") st.detached = true; else st.branch = v; }
      else if (k === "branch.upstream") st.upstream = v;
      else if (k === "branch.ab") { const m = /^\+(\d+) -(\d+)$/.exec(v); if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]); } }
    } else if (f[0] === "1" || f[0] === "2") {
      if (f[2] !== ".") st.staged++;
      if (f[3] !== ".") st.unstaged++;
      fileCount++;
      const entry = { status: f.slice(2, 4), path: f.split(" ").slice(f[0] === "2" ? 9 : 8).join(" ") };
      if (f[0] === "2") entry.original = fields[++i];
      if (st.files.length < 2000) st.files.push(entry);
    } else if (f[0] === "u") {
      st.conflicts++; fileCount++;
      if (st.files.length < 2000) st.files.push({ status: f.slice(2, 4), path: f.split(" ").slice(10).join(" ") });
    } else if (f[0] === "?") {
      st.untracked++; fileCount++;
      if (st.files.length < 2000) st.files.push({ status: "??", path: f.slice(2) });
    }
  }
  st.filesTruncated = fileCount > st.files.length;
  st.fileCount = fileCount;
  return st;
}

// Walk project folders, including nested independent repositories and worktrees.
// Never follow junctions/symlinks or descend into dependency/build caches.
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".next", "coverage", "target", "__pycache__"]);
async function discoverRepositories(dirs, { maxDepth = 5, maxDirs = 3000 } = {}) {
  const queue = dirs.filter(d => typeof d === "string" && path.isAbsolute(d)).map(dir => ({ dir, depth: 0 }));
  const seen = new Set(), found = new Set();
  let count = 0, truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const { dir, depth } = queue[i], key = norm(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (++count > maxDirs) { truncated = true; break; }
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some(e => e.name === ".git")) found.add(dir);
    const children = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name.toLowerCase()));
    if (depth >= maxDepth) { if (children.length) truncated = true; continue; }
    for (const e of children) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
  }
  return { repos: [...found], truncated };
}

// ---------- state ----------
let opts = null, timer = null, running = null, again = null; // the options of one more pass after the running one
let missingAt = 0;                 // when git was last found missing
const roots = new Map();           // norm(dir) -> { root: absolute path | null, at }
const repos = new Map();           // norm(root) -> status (with root, at, error?)
let discovery = { key: "", at: 0, repos: [], truncated: false };
let snapshot = { at: 0, missing: false, dirs: {}, repos: {} };
const watchers = new Map();
let watchTimer = null;
const changedRoots = new Set();    // norm(root) of the repositories a watcher saw change since the last pass
const WATCH_DELAY_MS = 2000;
// Build output, IDE state and the agents' worktrees (repositories of their own, with watchers of their own) change all
// the time without changing what `git status` reports here.
const WATCH_NOISE = new RegExp(`(^|/)(${[...SKIP].filter(d => d !== ".git").map(d => d.replace(".", "\\.")).join("|")}|\\.idea|\\.gradle|\\.claude/worktrees)(/|$)`, "i");
function syncWatchers() {
  const wanted = new Set(Object.values(snapshot.repos).map(r => r.root));
  for (const [root, watcher] of watchers) if (!wanted.has(root)) { watcher.close(); watchers.delete(root); }
  for (const root of wanted) {
    if (watchers.has(root) || watchers.size >= 32) continue;
    try {
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        const name = String(filename || '').replaceAll('\\', '/');
        if (WATCH_NOISE.test(name) || /\.git\/(objects|logs)\//.test(name) || name.endsWith('.lock')) return;
        if (!opts?.active?.()) return;
        changedRoots.add(norm(root));
        // At most one pass per WATCH_DELAY_MS, and only for the repositories that changed.
        watchTimer ??= setTimeout(() => {
          watchTimer = null;
          refresh({ changedOnly: true }).catch(() => {});
        }, WATCH_DELAY_MS);
        watchTimer.unref?.();
      });
      watcher.on('error', () => { watcher.close(); watchers.delete(root); });
      watchers.set(root, watcher);
    } catch { /* Periodic refresh covers platforms without recursive watching. */ }
  }
}

async function isDir(p) { try { return (await fs.promises.stat(p)).isDirectory(); } catch { return false; } }
async function findRoot(dir) {
  if (!path.isAbsolute(dir) || !(await isDir(dir))) return null;
  for (let d = path.resolve(dir); ;) {
    try { await fs.promises.stat(path.join(d, ".git")); return d; } catch { /* not here */ }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}
// A linked worktree's main checkout: its .git is a file naming <main>/.git/worktrees/<name>. Else the root itself.
// Read once per root: a checkout does not become a worktree of another one.
const mainRoots = new Map();
async function getMainRoot(root) {
  if (!mainRoots.has(root)) mainRoots.set(root, await readMainRoot(root));
  return mainRoots.get(root);
}
async function readMainRoot(root) {
  let text = "";
  try {
    text = await fs.promises.readFile(path.join(root, ".git"), "utf8");
  } catch {
    return root;
  }
  const gitdir = (/^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1] || "").replace(/\\/g, "/");
  const at = gitdir.search(/\/\.git\/worktrees\//);
  return at > 0 ? path.resolve(root, gitdir.slice(0, at)) : root;
}
async function rootOf(dir, now) {
  const k = norm(dir), known = roots.get(k);
  if (known && now - known.at < ROOT_TTL_MS) return known.root;
  const root = await findRoot(dir);
  roots.set(k, { root, at: now });
  return root;
}

function runGit(root) {
  return new Promise(resolve => {
    execFile("git", ["-C", root, ...ARGS], {
      windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    }, (err, stdout, stderr) => {
      if (err?.code === "ENOENT") return resolve({ missing: true });
      if (err) return resolve({ error: (String(stderr).trim().split(/\r?\n/)[0] || err.message).slice(0, 300) });
      resolve({ status: parseStatus(stdout) });
    });
  });
}

// ---------- refreshing ----------
// Brings every folder that opts.dirs() lists up to date (repositories checked within TTL_MS are kept, unless forced),
// then reports the result through opts.onChange. A refresh asked for while one runs is folded into one more after it.
// changedOnly: only the repositories a watcher saw change, not every one past TTL_MS.
function refresh({ force = false, changedOnly = false } = {}) {
  if (!opts) return Promise.resolve(snapshot);
  if (running) {
    if (force) return running.then(() => refresh({ force: true }));
    again = !again || again.changedOnly ? { changedOnly } : again;
    return running;
  }
  running = pass(force, changedOnly).finally(() => {
    running = null;
    if (again) {
      const next = again;
      again = null;
      refresh(next);
    }
  });
  return running;
}
// After an action that changed one repository's index only (stage, unstage): just its status, once any pass running now
// is over - no rescan of the projects, no other repository.
async function refreshRepo(root) {
  changedRoots.add(norm(root));
  if (running) await running.catch(() => {});
  return refresh({ changedOnly: true });
}
async function pass(force, changedOnly = false) {
  const t0 = Date.now();
  if (!force && missingAt && t0 - missingAt < MISSING_RETRY_MS) return snapshot;
  const dirs = [...new Set((opts.dirs() || []).filter(Boolean))];
  const projects = opts.projects?.() || dirs;
  const discoveryKey = JSON.stringify([...projects].sort());
  if (force || discovery.key !== discoveryKey || t0 - discovery.at > ROOT_TTL_MS) discovery = { ...await discoverRepositories(projects), key: discoveryKey, at: t0 };
  const dirRoot = {};
  for (const d of [...dirs, ...discovery.repos]) { if (force) roots.delete(norm(d)); const r = await rootOf(d, t0); if (r) dirRoot[norm(d)] = r; }
  const changed = new Set(changedRoots);
  changedRoots.clear();
  const isStale = r => !(t0 - (repos.get(norm(r))?.at || 0) < TTL_MS);
  const todo = [...new Set(Object.values(dirRoot))].filter(r => force || changed.has(norm(r)) || (!changedOnly && isStale(r)));
  let missing = false, next = 0;
  const work = async () => {
    while (next < todo.length && !missing) {
      const root = todo[next++];
      const r = await runGit(root);
      if (r.missing) { missing = true; break; }
      repos.set(norm(root), { root, mainRoot: await getMainRoot(root), at: Date.now(), ...(r.status || { error: r.error }) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, work));
  missingAt = missing ? Date.now() : 0;
  const used = new Set(Object.values(dirRoot).map(norm));
  for (const k of repos.keys()) if (!used.has(k)) repos.delete(k);
  const prev = snapshot;
  snapshot = {
    at: Date.now(), missing, discoveryTruncated: discovery.truncated, ms: Date.now() - t0, checked: todo.length,
    dirs: Object.fromEntries(Object.entries(dirRoot).map(([d, r]) => [d, norm(r)])),
    repos: Object.fromEntries(repos)
  };
  syncWatchers();
  if (signature(snapshot) !== signature(prev) || todo.length) opts.onChange?.(snapshot);
  return snapshot;
}
// What the pages show: an unchanged status is not sent again just because it was checked again, or because the
// folders came in another order (the sessions are sorted by their last activity).
const sorted = o => Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const signature = s => JSON.stringify([s.missing, s.discoveryTruncated, sorted(s.dirs), sorted(s.repos).map(([k, v]) => [k, { ...v, at: 0 }])]);

// dirs(): the folders to report on; onChange(snapshot); active(): whether a window that shows the state is open
// (the background refresh runs only then).
function start(o) {
  opts = o;
  clearInterval(timer);
  timer = setInterval(() => { if (opts.active?.()) refresh(); }, BACKGROUND_MS);
  timer.unref?.();
}

async function diff({ root, file } = {}) {
  const invalid = () => { throw new Error("Invalid repository or changed file"); };
  if (typeof root !== "string" || typeof file !== "string" || !file || file.length > 4096 || file.includes("\0") || !snapshot.repos[norm(root)] || path.isAbsolute(file)) return invalid();
  root = snapshot.repos[norm(root)].root;
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return invalid();
  const current = await runGit(root);
  if (current.error || current.missing) throw new Error(current.error || "Git is unavailable");
  const entry = current.status.files.find(f => f.path === file);
  if (!entry) return { staged: "", unstaged: "", untracked: "" };
  const limit = 512 * 1024;
  if (entry.status === "??") {
    const target = path.join(root, file), stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink()) return { untracked: "+" + await fs.promises.readlink(target), staged: "", unstaged: "" };
    const realRoot = await fs.promises.realpath(root), realFile = await fs.promises.realpath(target);
    const rel = path.relative(realRoot, realFile);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel) || !stat.isFile()) return invalid();
    const handle = await fs.promises.open(realFile, "r");
    let bytes;
    try {
      const buffer = Buffer.alloc(limit + 1);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead > limit) return { tooLarge: true };
      bytes = buffer.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { binary: true }; }
    if (bytes.includes(0)) return { binary: true };
    return { staged: "", unstaged: "", untracked: text ? text.replace(/\n$/, "").split("\n").map(line => "+" + line).join("\n") : "", emptyFile: !bytes.length };
  }
  const readDiff = cached => new Promise((resolve, reject) => {
    execFile("git", ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-C", root, "-c", "core.fsmonitor=false", "diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", file, ...(entry.original ? [entry.original] : [])], {
      windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: limit,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }
    }, (err, stdout, stderr) => {
      if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve(null);
      if (err) return reject(new Error(String(stderr).trim().slice(0, 300) || err.message));
      resolve(stdout);
    });
  });
  const [staged, unstaged] = await Promise.all([readDiff(true), readDiff(false)]);
  return { staged: staged || "", unstaged: unstaged || "", binary: /(?:^|\n)Binary files .* differ/.test((staged || "") + (unstaged || "")), tooLarge: staged === null || unstaged === null };
}

let actionContext = () => ({});
const actions = require('./git-actions').createGitActions({ status: () => snapshot, refresh, refreshRepo, parseStatus, context: () => actionContext() });
function stop() { clearInterval(timer); clearTimeout(watchTimer); watchTimer = null; changedRoots.clear(); for (const w of watchers.values()) w.close(); watchers.clear(); }
module.exports = { start, stop, refresh, get: () => snapshot, parseStatus, norm, discoverRepositories, diff, WATCH_NOISE,
  query: actions.query, execute: actions.execute, configure: context => { actionContext = context; } };
