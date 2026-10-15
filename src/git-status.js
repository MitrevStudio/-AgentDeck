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
const ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-z", "--ignore-submodules=dirty"];

// As the pages' normPath(): the keys they look folders up by.
const { normPath: norm } = require("./voice/util");

// ---------- parsing ----------
// `git status --porcelain=v2 --branch -z`: "# " headers, then one entry per changed path. A rename/copy entry ("2")
// is followed by its original path as a field of its own, which must not be taken for an entry.
function parseStatus(out) {
  const st = { branch: "", oid: "", detached: false, initial: false, upstream: "", ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
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
      if (f[0] === "2") i++;
    } else if (f[0] === "u") st.conflicts++;
    else if (f[0] === "?") st.untracked++;
  }
  return st;
}

// ---------- state ----------
let opts = null, timer = null, running = null, again = false;
let missingAt = 0;                 // when git was last found missing
const roots = new Map();           // norm(dir) -> { root: absolute path | null, at }
const repos = new Map();           // norm(root) -> status (with root, at, error?)
let snapshot = { at: 0, missing: false, dirs: {}, repos: {} };

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
function refresh({ force = false } = {}) {
  if (!opts) return Promise.resolve(snapshot);
  if (running) { again = true; return running; }
  running = pass(force).finally(() => {
    running = null;
    if (again) { again = false; refresh(); }
  });
  return running;
}
async function pass(force) {
  const t0 = Date.now();
  if (missingAt && t0 - missingAt < MISSING_RETRY_MS) return snapshot;
  const dirs = [...new Set((opts.dirs() || []).filter(Boolean))];
  const dirRoot = {};
  for (const d of dirs) { const r = await rootOf(d, t0); if (r) dirRoot[norm(d)] = r; }
  const todo = [...new Set(Object.values(dirRoot))].filter(r => force || !(t0 - (repos.get(norm(r))?.at || 0) < TTL_MS));
  let missing = false, next = 0;
  const work = async () => {
    while (next < todo.length && !missing) {
      const root = todo[next++];
      const r = await runGit(root);
      if (r.missing) { missing = true; break; }
      repos.set(norm(root), { root, at: Date.now(), ...(r.status || { error: r.error }) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, work));
  missingAt = missing ? Date.now() : 0;
  const used = new Set(Object.values(dirRoot).map(norm));
  for (const k of repos.keys()) if (!used.has(k)) repos.delete(k);
  const prev = snapshot;
  snapshot = {
    at: Date.now(), missing, ms: Date.now() - t0, checked: todo.length,
    dirs: Object.fromEntries(Object.entries(dirRoot).map(([d, r]) => [d, norm(r)])),
    repos: Object.fromEntries(repos)
  };
  if (signature(snapshot) !== signature(prev)) opts.onChange?.(snapshot);
  return snapshot;
}
// What the pages show: an unchanged status is not sent again just because it was checked again, or because the
// folders came in another order (the sessions are sorted by their last activity).
const sorted = o => Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const signature = s => JSON.stringify([s.missing, sorted(s.dirs), sorted(s.repos).map(([k, v]) => [k, { ...v, at: 0 }])]);

// dirs(): the folders to report on; onChange(snapshot); active(): whether a window that shows the state is open
// (the background refresh runs only then).
function start(o) {
  opts = o;
  clearInterval(timer);
  timer = setInterval(() => { if (opts.active?.()) refresh(); }, BACKGROUND_MS);
  timer.unref?.();
}

module.exports = { start, refresh, get: () => snapshot, parseStatus, norm };
