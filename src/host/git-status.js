// Git state of the projects' folders and the sessions' working folders: branch (or the commit of a detached HEAD),
// ahead/behind its upstream, staged/unstaged/untracked counts and conflicts. Read-only: `git status` runs without
// optional locks (so it never rewrites the index), without fsmonitor and without looking into submodules' work trees,
// and nothing is fetched - ahead and behind are as of the last fetch the user made. What remains is what any
// `git status` does: for a file whose timestamps changed it runs the clean filter that the user's or the repository's
// own git config sets for it (Git LFS, say), as git does in every terminal that shows the branch; a repository owned
// by another user is refused by git itself (safe.directory). A folder inside a repository shares the repository's
// status; one outside any is ruled out with a few stat calls, without starting git.
//
// When it runs. Every start of git is a process (on Windows with a console host of its own) that security software
// inspects, so a status is asked for only when it can have changed: after a full scan of the
// sessions, when a page asks (the manager window gets the focus, the edge menu opens), every BACKGROUND_MS while a
// window shows it, and when a watcher on the repository's folder reports a change - unless git ignores the changed
// path (git-ignore.js): an IDE and a build write into ignored folders all the time. The watchers' passes are at least
// WATCH_DELAY_MS apart, WATCH_UNFOCUSED_MS while the status is in view but nobody is at the window (opts.focused).
// Known limit: a change of a file that is tracked although an ignore pattern matches it is not seen by the watchers;
// the next of the other refreshes shows it.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createGitIgnores, getDefaultExcludesFile } = require("./git-ignore");

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
// Outside a repository the walk is bounded per project: maxDepth levels below the project's folder and maxDirs
// folders, so a big folder of loose files cannot leave the other projects unscanned. A repository's own tree is walked
// in full, whatever its depth and size, and spends none of that budget: a nested repository or a worktree can be
// anywhere in it, and a source tree is deeper than any depth limit. All of it stays within one ceiling (maxTotal
// folders read in a pass). A folder inside several projects counts for the one that reached it first; the walk is
// level by level over all projects, so the ceiling cuts the deepest folders first. The folders are read a few at a
// time (about three times faster than one by one); what is admitted and in which order stays that of a queue.
// truncatedIn: the projects not scanned in full, where a repository may have been missed - a budget spent, folders
// below the depth limit outside any repository, or folders left when the ceiling was reached.
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "vendor", "dist", "build", ".next", "coverage", "target", "__pycache__"]);
const MAX_DIRS = 3000, MAX_TOTAL = 15000;
async function discoverRepositories(dirs, { maxDepth = 5, maxDirs = MAX_DIRS, maxTotal = MAX_TOTAL } = {}) {
  const queue = dirs.filter(d => typeof d === "string" && path.isAbsolute(d)).map(dir => ({ dir, depth: 0, project: dir, inRepo: false }));
  const seen = new Set(), found = new Set(), counts = new Map(), spent = new Set(), truncatedIn = new Set();
  let total = 0;
  for (let i = 0; i < queue.length;) {
    const batch = [];
    for (; i < queue.length && batch.length < PARALLEL; i++) {
      const { dir, project } = queue[i], key = norm(dir);
      if (seen.has(key) || spent.has(project)) continue;
      seen.add(key);
      const count = (counts.get(project) || 0) + (queue[i].inRepo ? 0 : 1);
      counts.set(project, count);
      if (count > maxDirs || ++total > maxTotal) {
        spent.add(project);
        truncatedIn.add(project);
        continue;
      }
      batch.push(queue[i]);
    }
    const read = await Promise.all(batch.map(x => fs.promises.readdir(x.dir, { withFileTypes: true }).catch(() => null)));
    batch.forEach(({ dir, depth, project, inRepo: inside }, n) => {
      const entries = read[n];
      if (!entries) return;
      const isRepo = entries.some(e => e.name === ".git"), inRepo = inside || isRepo;
      if (isRepo) found.add(dir);
      const children = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name.toLowerCase()));
      if (depth >= maxDepth && !inRepo) {
        if (children.length) truncatedIn.add(project);
        return;
      }
      for (const e of children) queue.push({ dir: path.join(dir, e.name), depth: depth + 1, project, inRepo });
    });
  }
  return { repos: [...found], truncated: truncatedIn.size > 0, truncatedIn: [...truncatedIn] };
}

// ---------- state ----------
let opts = null, timer = null, running = null, again = null; // the options of one more pass after the running one
let missingAt = 0;                 // when git was last found missing
const roots = new Map();           // norm(dir) -> { root: absolute path | null, at }
const repos = new Map();           // norm(root) -> status (with root, at, error?)
let discovery = { key: "", at: 0, repos: [], truncated: false, truncatedIn: [] };
let snapshot = { at: 0, missing: false, dirs: {}, repos: {} };
const watchers = new Map();
let watchTimer = null;
const changedRoots = new Set();    // norm(root) of the repositories a watcher saw change since the last pass
const MAX_WATCHERS = 32;
const WATCH_DELAY_MS = 2000;
const WATCH_DELAY_MAX_MS = 30 * 1000;
const WATCH_COST_FACTOR = 4;       // a watchers' pass that took 3 s is followed by the next one 12 s later at the earliest
const WATCH_UNFOCUSED_MS = 30 * 1000; // between two watchers' passes while nobody is at the window that shows the status
let watchCostMs = 0;               // how long the last watchers' pass took
let watchDue = 0;                  // when the pass that watchTimer waits for runs
// A linked worktree by where the main checkout keeps its index and HEAD: the main root -> <name> of
// <main>/.git/worktrees/<name> -> norm(the worktree's root). The main root is keyed by its real path: git names it
// that way, while a watcher goes by the folder as the project gives it - through a junction or a symlink, or with a
// Windows short name ("RUNNER~1"), another spelling of the same folder. realRoots: a watched root -> that key.
const worktreeRoots = new Map(), realRoots = new Map();
async function getRealKey(dir) {
  try { return norm(await fs.promises.realpath(dir)); } catch { return norm(dir); }
}
// While files keep changing (an agent at work, a build), a repository whose `git status` is slow is not asked again
// right away: git runs for at most 1/(WATCH_COST_FACTOR + 1) of the time.
// While the status is only in view (opts.focused() is false: the window is open, the user is in another program), a
// change waits longer still; a page that gets the focus asks for a refresh, which takes the waiting changes with it.
function getWatchDelay() {
  const delay = Math.min(WATCH_DELAY_MAX_MS, Math.max(WATCH_DELAY_MS, watchCostMs * WATCH_COST_FACTOR));
  return opts?.focused && !opts.focused() ? Math.max(delay, opts.watchUnfocusedMs ?? WATCH_UNFOCUSED_MS) : delay;
}
// At most one pass per getWatchDelay(), and only for the repositories that changed. A pass already waiting is brought
// forward when the delay has become shorter since (the window got the focus), never put off.
function scheduleWatchPass() {
  const due = Date.now() + getWatchDelay();
  if (watchTimer && due >= watchDue) return;
  clearTimeout(watchTimer);
  watchDue = due;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    refresh({ changedOnly: true }).catch(() => {});
  }, due - Date.now());
  watchTimer.unref?.();
}
// The repositories a change seen under `root` belongs to: a linked worktree's when it is in the main checkout's
// .git/worktrees/<name> (staging or committing there changes no file in the worktree's own folder), else root's.
// Without a name the watcher lost track of what changed (too many changes at once): root's and its worktrees'.
function getChangedRoots(root, name) {
  const linked = worktreeRoots.get(realRoots.get(root));
  if (!name) return [norm(root), ...(linked?.values() || [])];
  const worktree = /^\.git\/worktrees\/([^/]+)\//.exec(name)?.[1];
  return [(worktree && linked?.get(worktree)) || norm(root)];
}
// Build output, IDE state and the agents' worktrees (repositories of their own, with watchers of their own) change all
// the time without changing what `git status` reports here. Only names that mean the same in every repository: a
// "bin" or an "obj" is build output in one and tracked source in another, which the repository's ignore rules tell.
const WATCH_NOISE = new RegExp(`(^|/)(${[...SKIP].filter(d => d !== ".git").map(d => d.replace(".", "\\.")).join("|")}|\\.idea|\\.vs|\\.gradle|\\.claude/worktrees)(/|$)`, "i");
// What git ignores in each watched repository (git-ignore.js). Where the user's excludes file is, is asked of git
// once, as its config can include other files: one process, not one per change.
let excludesFile = null;
const ignores = createGitIgnores({
  excludesFile: () => excludesFile ||= getGitExe().then(exe => new Promise(resolve => {
    execFile(exe, ["config", "--global", "--type=path", "--get", "core.excludesfile"], { windowsHide: true, timeout: TIMEOUT_MS }, (err, stdout) => {
      const file = String(stdout || "").trim();
      resolve(!err && path.isAbsolute(file) ? file : getDefaultExcludesFile());
    });
  }))
});
const IGNORE_RULES = /(^|\/)\.gitignore$/i;
// A change a watcher reports under `root`: whether it can change the status, and then the pass that will ask.
function onWatched(root, watcher, event, filename) {
  const name = String(filename || '').replaceAll('\\', '/');
  if (WATCH_NOISE.test(name) || /\.git\/(objects|logs)\//.test(name) || name.endsWith('.lock')) return;
  // The rules themselves changed, or (no name: too many changes at once) may have. info/exclude is a main checkout's
  // and its worktrees' alike.
  if (!name || IGNORE_RULES.test(name)) ignores.reload(root);
  else if (name === '.git/info/exclude') ignores.clear();
  if (!opts?.active?.()) return;
  const changed = () => {
    for (const r of getChangedRoots(root, name)) changedRoots.add(r);
    scheduleWatchPass();
  };
  // Git's own folder (the index, HEAD, refs: staging and committing from outside) and the rules always count.
  if (!name || name === '.git' || name.startsWith('.git/') || IGNORE_RULES.test(name)) return changed();
  // Rules not loaded yet: the answer comes later and the change with it, unless the watcher is gone by then.
  // Windows also reports the folder a file was added to as changed (its times did); that file has a report of its own,
  // and an ignored one would start a status through its folder otherwise.
  const ignored = ignores.isIgnored(root, name, { renamed: event === 'rename', skipFolders: process.platform === 'win32' && event === 'change' });
  if (ignored === false) changed();
  else if (ignored !== true) ignored.then(yes => { if (!yes && watchers.get(root) === watcher) changed(); }, () => {});
}
async function syncWatchers() {
  const wanted = new Set(Object.values(snapshot.repos).map(r => r.root));
  for (const [root, watcher] of watchers) if (!wanted.has(root)) { watcher.close(); watchers.delete(root); realRoots.delete(root); ignores.reload(root); }
  for (const root of wanted) {
    if (watchers.has(root) || watchers.size >= MAX_WATCHERS) continue;
    if (!realRoots.has(root)) realRoots.set(root, await getRealKey(root));
    try {
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (event, filename) => onWatched(root, watcher, event, filename));
      watcher.on('error', () => { watcher.close(); watchers.delete(root); ignores.reload(root); });
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
  if (at <= 0) return root;
  const main = path.resolve(root, gitdir.slice(0, at));
  const name = gitdir.slice(at).split("/")[3];
  if (name) {
    const key = await getRealKey(main);
    if (!worktreeRoots.has(key)) worktreeRoots.set(key, new Map());
    worktreeRoots.get(key).set(name, norm(root));
  }
  return main;
}
async function rootOf(dir, now) {
  const k = norm(dir), known = roots.get(k);
  if (known && now - known.at < ROOT_TTL_MS) return known.root;
  const root = await findRoot(dir);
  roots.set(k, { root, at: now });
  return root;
}

// ---------- the executable ----------
// Git for Windows puts a launcher on the PATH (<Git>\cmd\git.exe) that only starts the real program
// (<Git>\mingw64\bin\git.exe): one more process per status, and the real one sets up the same environment for its
// filters by itself (its sh, its PATH). So the status and the diff here run the real one when the layout is exactly
// that; any other git (a shim, a portable or unknown install, another system) runs as "git" from the PATH as before.
// git-actions.js and setup.js keep the launcher: hooks, credential helpers and ssh are the user's own programs.
// find(name): the file on the PATH; isFile(file).
async function resolveGitExe({ platform = process.platform, find = name => require("./sessions").findOnPath(name), isFile = async file => (await fs.promises.stat(file)).isFile() } = {}) {
  if (platform !== "win32") return "git";
  const win = path.win32, found = String(await find("git") || "");
  if (win.basename(found).toLowerCase() !== "git.exe" || win.basename(win.dirname(found)).toLowerCase() !== "cmd") return "git";
  for (const arch of ["mingw64", "clangarm64", "mingw32"]) {
    const exe = win.join(win.dirname(win.dirname(found)), arch, "bin", "git.exe");
    if (await Promise.resolve(exe).then(isFile).catch(() => false)) return exe;
  }
  return "git";
}
// Looked for once, and again after git was found missing (installed or updated since).
let gitExe = null;
const getGitExe = () => gitExe ||= resolveGitExe().catch(() => "git");

async function runGit(root) {
  const exe = await getGitExe();
  return new Promise(resolve => {
    execFile(exe, ["-C", root, ...ARGS], {
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
// changedOnly: only the repositories a watcher saw change, not every one past TTL_MS - except those no watcher looks
// after (there are more repositories than watchers, or watching failed), which are checked past TTL_MS as before.
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
  // Not in a watchers' pass (changedOnly): the walk would delay the status the user waits for after staging, and
  // count as the cost that spaces the watchers' passes out. The background refresh does it.
  if (force || discovery.key !== discoveryKey || (!changedOnly && t0 - discovery.at > ROOT_TTL_MS)) discovery = { ...await discoverRepositories(projects), key: discoveryKey, at: t0 };
  const dirRoot = {};
  for (const d of [...dirs, ...discovery.repos]) { if (force) roots.delete(norm(d)); const r = await rootOf(d, t0); if (r) dirRoot[norm(d)] = r; }
  const changed = new Set(changedRoots);
  changedRoots.clear();
  clearTimeout(watchTimer); // this pass takes the changes the watchers' one was waiting with
  watchTimer = null;
  const isStale = r => !(t0 - (repos.get(norm(r))?.at || 0) < TTL_MS);
  const watched = new Set([...watchers.keys()].map(norm));
  const todo = [...new Set(Object.values(dirRoot))].filter(r => force || changed.has(norm(r)) || (isStale(r) && (!changedOnly || !watched.has(norm(r)))));
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
  if (missing) gitExe = excludesFile = null;
  if (changedOnly && todo.length) watchCostMs = Date.now() - t0;
  const used = new Set(Object.values(dirRoot).map(norm));
  for (const k of repos.keys()) if (!used.has(k)) repos.delete(k);
  const prev = snapshot;
  snapshot = {
    at: Date.now(), missing, discoveryTruncated: discovery.truncated, discoveryTruncatedIn: discovery.truncatedIn, ms: Date.now() - t0, checked: todo.length,
    dirs: Object.fromEntries(Object.entries(dirRoot).map(([d, r]) => [d, norm(r)])),
    repos: Object.fromEntries(repos)
  };
  await syncWatchers();
  if (signature(snapshot) !== signature(prev) || todo.length) opts.onChange?.(snapshot);
  return snapshot;
}
// What the pages show: an unchanged status is not sent again just because it was checked again, or because the
// folders came in another order (the sessions are sorted by their last activity).
const sorted = o => Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const signature = s => JSON.stringify([s.missing, s.discoveryTruncatedIn, sorted(s.dirs), sorted(s.repos).map(([k, v]) => [k, { ...v, at: 0 }])]);

// dirs(): the folders to report on; onChange(snapshot); active(): whether a window that shows the state is open
// (the background refresh and the watchers' passes run only then); focused(): whether the user is at such a window
// (without it: always) - else the watchers' passes are WATCH_UNFOCUSED_MS apart (watchUnfocusedMs: another gap, for
// the tests).
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
  const exe = await getGitExe();
  const readDiff = cached => new Promise((resolve, reject) => {
    execFile(exe, ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-C", root, "-c", "core.fsmonitor=false", "diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", file, ...(entry.original ? [entry.original] : [])], {
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
function stop() { clearInterval(timer); clearTimeout(watchTimer); watchTimer = null; changedRoots.clear(); watchCostMs = 0; for (const w of watchers.values()) w.close(); watchers.clear(); realRoots.clear(); ignores.clear(); }
module.exports = { start, stop, refresh, get: () => snapshot, parseStatus, norm, discoverRepositories, diff, WATCH_NOISE, getWatchDelay, resolveGitExe,
  query: actions.query, execute: actions.execute, configure: context => { actionContext = context; } };
