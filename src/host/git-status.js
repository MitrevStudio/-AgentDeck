// Git state of the projects' folders and the sessions' working folders: branch (or the commit of a detached HEAD),
// ahead/behind its upstream, staged/unstaged/untracked counts and conflicts. Read-only: `git status` runs without
// optional locks (so it never rewrites the index), without fsmonitor and without looking into submodules' work trees,
// and nothing is fetched - ahead and behind are as of the last fetch the user made. What remains is what any
// `git status` does: for a file whose timestamps changed it runs the clean filter that the user's or the repository's
// own git config sets for it (Git LFS, say), as git does in every terminal that shows the branch; a repository owned
// by another user is refused by git itself (safe.directory). A folder inside a repository shares the repository's
// status; one outside any is ruled out with a few stat calls, without starting git.
//
// Which repositories are listed. Those of the projects' and the sessions' folders and of the open terminals', and -
// with "All in the projects" in Settings > Git (opts.scope) - every repository found inside a project, however deep.
// Listing one costs a few stat calls and no process; until its status is asked for the first time it is reported
// under `unchecked`, with no status at all rather than a made-up clean one.
//
// When it runs. Every start of git is a process that security software inspects, and a folder can hold hundreds of
// repositories, so being listed is no reason to ask. There are two kinds:
// - Active: the repository of a folder a session is live in, or a terminal is open in (opts.activeDirs). These, and
//   only these, are looked after in the background: each gets a watcher (at most MAX_WATCHERS of them), and its status
//   is asked for the first time, when it becomes active, and when its watcher reports a change - unless git ignores
//   the changed path (git-ignore.js): an IDE and a build write into ignored folders all the time. The watchers' passes
//   are at least WATCH_DELAY_MS apart; a change that comes after a quiet while is looked at WATCH_SETTLE_MS later.
//   Every ACTIVE_FALLBACK_MS they are asked once more: where folders cannot be watched in depth, and for the known
//   limits - the watchers do not see a change of a file that is tracked although an ignore pattern matches it, nor,
//   on Windows, a write that leaves the file's modification time as it was (a file only read is reported there like
//   one written, and that time tells them apart).
//   A repository stays active for ACTIVE_GRACE_MS after its last session or terminal went, so closing a terminal and
//   opening it again does not take the watcher down and put it up.
// - Every other listed repository is asked about only when somebody wants to see it: a page names the folders it
//   shows now (refresh({ shown })) and those of them whose status is older than TTL_MS are asked; after a git action
//   on it (refreshRepo); and on the user's own Refresh, which asks about every listed one (refresh({ force })).
//   Nothing sweeps them: no timer, no scan of the sessions, and no change in some other repository.
// Nothing at all is asked in the background while nobody is at a window that shows the status (opts.focused): what
// the watchers see meanwhile is remembered, and the first pass after the focus is back takes it - one pass, however
// much changed.
// At most PARALLEL gits run at a time, and a question already waiting or running is not asked twice.
// stats() counts every start by its reason; with opts.log each is also a line of a log (AGENTDECK_GIT_LOG=1).
const fs = require("node:fs");
const path = require("node:path");
const { createGitIgnores, getDefaultExcludesFile } = require("./git-ignore");
const { runGit: startProcess } = require("./git-run");

const TTL_MS = 20 * 1000;             // a status younger than this is not asked for again
const ACTIVE_FALLBACK_MS = 5 * 60 * 1000; // the active repositories are asked once more this often, while somebody is there
const ACTIVE_GRACE_MS = 60 * 1000;    // a repository stays active this long after its last session or terminal went
const ROOT_TTL_MS = 5 * 60 * 1000;    // where a folder's repository is, or that it has none
const TIMEOUT_MS = 10 * 1000;
const PARALLEL = 2;                   // gits at a time
const READ_PARALLEL = 4;              // folders read at a time while looking for repositories
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
// shallow: only what the panel lists with the scope "open" - a folder that is a repository, or the repositories right
// in a folder that is none. Nothing inside a repository is looked at, and nothing is reported as cut short.
async function discoverRepositories(dirs, { shallow = false, maxDepth = shallow ? 1 : 5, maxDirs = MAX_DIRS, maxTotal = MAX_TOTAL } = {}) {
  const queue = dirs.filter(d => typeof d === "string" && path.isAbsolute(d)).map(dir => ({ dir, depth: 0, project: dir, inRepo: false }));
  const seen = new Set(), found = new Set(), counts = new Map(), spent = new Set(), truncatedIn = new Set();
  let total = 0;
  for (let i = 0; i < queue.length;) {
    const batch = [];
    for (; i < queue.length && batch.length < READ_PARALLEL; i++) {
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
      if (isRepo && shallow) return;
      const children = entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !SKIP.has(e.name.toLowerCase()));
      if (depth >= maxDepth && !inRepo) {
        if (children.length && !shallow) truncatedIn.add(project);
        return;
      }
      for (const e of children) queue.push({ dir: path.join(dir, e.name), depth: depth + 1, project, inRepo });
    });
  }
  return { repos: [...found], truncated: truncatedIn.size > 0, truncatedIn: [...truncatedIn] };
}

// ---------- state ----------
let opts = null, timer = null, running = null, again = null; // the request of one more pass after the running one
let missingAt = 0;                 // when git was last found missing
const roots = new Map();           // norm(dir) -> { root: absolute path | null, at }
const repos = new Map();           // norm(root) -> status (with root, at, error?)
let discovery = { key: "", at: 0, repos: [], truncated: false, truncatedIn: [] };
let snapshot = { at: 0, missing: false, dirs: {}, repos: {}, unchecked: {} };
const watchers = new Map();
let watchTimer = null;
const changedRoots = new Set();    // norm(root) of the active repositories a watcher saw change since a pass took them
const actedRoots = new Set();      // norm(root) of the repositories a git action was run on since the last pass
const activeAt = new Map();        // norm(root) -> { root, at }: when a session or a terminal was last seen in it
let activeKeys = new Set();        // norm(root) of the active repositories, as of the last pass
// The watched repositories whose status was asked for since their watcher is up: only from then on does "no change
// reported" mean "no change".
const covered = new Set();
const MAX_WATCHERS = 32;
// Even with the window focused, agents at work change tracked files all the time, and every `git status` stats each
// tracked file - each of those opens inspected in the kernel by an EDR (CrowdStrike: about 3 of 14 cores with five
// agents and a pass every 2 s). So the passes are at least 10 s apart, and 10x what the last one took.
const WATCH_DELAY_MS = 10 * 1000;
const WATCH_DELAY_MAX_MS = 60 * 1000;
const WATCH_COST_FACTOR = 10;      // a watchers' pass that took 3 s is followed by the next one 30 s later at the earliest
const WATCH_SETTLE_MS = 2000;      // a change is looked at this long after it at the earliest: a burst of writes is one pass
const WATCH_SINCE_SLACK_MS = 2000; // a file written this shortly before its watcher went up counts as written since (isWritten)
const WATCH_TIMES_MAX = 20000;     // files a watcher remembers the modification time of (isWritten)
let watchCostMs = 0;               // how long the last watchers' pass took
let watchDue = 0;                  // when the pass that watchTimer waits for runs
let watchedAt = 0;                 // when the last pass that asked git ended: the watchers' next one keeps its distance from it
// Whether somebody is at a window that shows the status. A host that is not told (a test's) takes it that somebody is.
const isFocused = () => (opts?.focused ? Boolean(opts.focused()) : true);

// ---------- every start of git ----------
// Counted by why it was started, since the host started: "initial" (an active repository's first status), "active"
// (it became active, or its watcher is new), "watcher" (a watcher saw a change), "timer" (the active ones' fallback),
// "focus" and "page" (a page asked about what it shows - as its window got the focus, or later), "action" (after a git
// action on the repository), "forced" (the user's Refresh), "diff" (a file's changes were opened) and "config" (where
// the user's excludes file is). opts.log(line), when the host was started with a log: one line a start - the time,
// the reason, the repository - and one, "seen", for the watcher's report that made a repository one to ask about
// (the repository, the kind of report, the file).
const starts = { total: 0, reasons: {} };
function countStart(reason, root) {
  starts.total++;
  starts.reasons[reason] = (starts.reasons[reason] || 0) + 1;
  opts?.log?.(`${new Date().toISOString()} ${reason} ${root || "-"}`);
}
const stats = () => ({ total: starts.total, reasons: { ...starts.reasons } });
// At most PARALLEL gits at a time, each question once: asked again while it waits or runs, it gets the answer of the
// one already there. key: what is asked (a repository's status, one file's diff); run(): starts git, never rejects;
// isDropped(): the answer is not needed any more by the time its turn comes (git turned out to be missing).
const waiting = [], asked = new Map();
let busy = 0;
function ask(key, reason, root, run, isDropped = () => false) {
  if (asked.has(key)) return asked.get(key);
  const answer = new Promise(resolve => { waiting.push({ reason, root, run, isDropped, resolve }); });
  asked.set(key, answer);
  answer.then(() => asked.delete(key));
  startWaiting();
  return answer;
}
function startWaiting() {
  while (busy < PARALLEL && waiting.length) {
    const job = waiting.shift();
    if (job.isDropped()) { job.resolve({ missing: true }); continue; }
    busy++;
    countStart(job.reason, job.root);
    job.run().then(job.resolve, err => job.resolve({ error: err.message })).finally(() => { busy--; startWaiting(); });
  }
}

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
function getWatchDelay() {
  return Math.min(WATCH_DELAY_MAX_MS, Math.max(opts?.watchDelayMs ?? WATCH_DELAY_MS, watchCostMs * WATCH_COST_FACTOR));
}
// At most one pass per getWatchDelay(), and only for the repositories that changed. The distance is kept from the last
// pass, not from the change: a change after a quiet while shows WATCH_SETTLE_MS later, and only where files keep
// changing do the passes come getWatchDelay() apart. A pass already waiting is brought forward when the delay has
// become shorter since, never put off. With nobody at the window no pass is set up, and one that was waiting does
// nothing when its time comes: the changes stay remembered for the pass that follows the focus.
function scheduleWatchPass() {
  if (!isFocused()) return;
  const now = Date.now(), gap = getWatchDelay();
  const due = Math.max(now + Math.min(opts?.watchSettleMs ?? WATCH_SETTLE_MS, gap), watchedAt + gap);
  if (watchTimer && due >= watchDue) return;
  clearTimeout(watchTimer);
  watchDue = due;
  watchTimer = setTimeout(() => {
    watchTimer = null;
    if (!isFocused()) return;
    // A pass asked for otherwise (a page, the fallback) is running or has just ended: the changes since wait their
    // distance from that one.
    if (running) return void running.catch(() => {}).then(() => { if (changedRoots.size) scheduleWatchPass(); });
    if (Date.now() < watchedAt + getWatchDelay()) return scheduleWatchPass();
    refresh({ reason: "watcher" }).catch(() => {});
  }, Math.max(0, due - now));
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
  excludesFile: () => excludesFile ||= ask("config", "config", "", async () => startProcess(await getGitExe(), ["config", "--global", "--type=path", "--get", "core.excludesfile"], { timeout: TIMEOUT_MS }))
    .then(({ err, stdout }) => {
      const file = String(stdout || "").trim();
      return !err && path.isAbsolute(file) ? file : getDefaultExcludesFile();
    })
});
const IGNORE_RULES = /(^|\/)\.gitignore$/i;
// A change a watcher reports under `root`: whether it can change the status, and then the pass that will ask.
function onWatched(root, watcher, event, filename) {
  const name = String(filename || '').replaceAll('\\', '/');
  if (WATCH_NOISE.test(name) || /\.git\/(objects|logs)\//.test(name) || name.endsWith('.lock')) return;
  const isRules = IGNORE_RULES.test(name), inGit = name === '.git' || name.startsWith('.git/');
  // Windows reports a file or a folder as changed when no more than its times did - also the time it was last read.
  // Git's own files and the rules are read here and by every `git status`, so each status and each loading of the
  // rules would be followed by another status. Such a report counts only when the file was written since.
  if ((isRules || inGit) && process.platform === 'win32' && event === 'change') {
    return void isWritten(root, name).then(yes => { if (yes && watchers.get(root) === watcher) onChanged(root, watcher, event, name, isRules, inGit); });
  }
  onChanged(root, watcher, event, name, isRules, inGit);
}
// Whether the file a "change" was reported for was written, not merely read: its modification time moved since the
// last report for it or, at the first one, is not older than the watcher - what it held before that, the first status
// and the loading of the rules have seen. A folder is never "written": what changes in it has a report of its own. A
// file that is gone by now counts.
const watchTimes = new Map(); // watched root -> { since, files: Map(name -> mtimeMs) }
async function isWritten(root, name) {
  const times = watchTimes.get(root);
  let st;
  try { st = await fs.promises.stat(path.join(root, name)); } catch { return true; }
  if (st.isDirectory()) return false;
  if (!times) return true;
  const known = times.files.get(name) ?? times.since;
  if (times.files.size >= WATCH_TIMES_MAX) times.files.clear(); // forgotten, a file counts as written once more at most
  times.files.set(name, st.mtimeMs);
  return st.mtimeMs > known;
}
function onChanged(root, watcher, event, name, isRules, inGit) {
  // The rules themselves changed, or (no name: too many changes at once) may have. info/exclude is a main checkout's
  // and its worktrees' alike.
  if (!name || isRules) ignores.reload(root);
  else if (name === '.git/info/exclude') ignores.clear();
  // Only an active repository's change is one to ask about: a main checkout watched for its worktrees' sake alone
  // (their index is in its .git) is not asked about because a file of its own changed. Remembered whoever is at the
  // window; scheduleWatchPass() sets a pass up only when somebody is.
  const changed = () => {
    let any = false;
    for (const r of getChangedRoots(root, name)) {
      if (!activeKeys.has(r)) continue;
      // In the log: the first report that makes a repository one to ask about, so a start can be traced to its file.
      if (!changedRoots.has(r)) opts?.log?.(`${new Date().toISOString()} seen ${r} ${event} ${name || "(many changes)"}`);
      changedRoots.add(r);
      any = true;
    }
    if (any) scheduleWatchPass();
  };
  // Git's own folder (the index, HEAD, refs: staging and committing from outside) and the rules always count.
  if (!name || isRules || inGit) return changed();
  // Rules not loaded yet: the answer comes later and the change with it, unless the watcher is gone by then.
  // Windows also reports the folder a file was added to as changed (its times did); that file has a report of its own,
  // and an ignored one would start a status through its folder otherwise.
  const ignored = ignores.isIgnored(root, name, { renamed: event === 'rename', skipFolders: process.platform === 'win32' && event === 'change' });
  // On Windows a file that was only read is reported as changed too, when the time of its last reading moves: an
  // editor's indexer, a search or an agent reading the sources would start a status each. Asked only of a file that
  // is not ignored, so a build's output costs no stat.
  const ifWritten = () => {
    if (process.platform !== 'win32' || event !== 'change') return changed();
    isWritten(root, name).then(yes => { if (yes && watchers.get(root) === watcher) changed(); });
  };
  if (ignored === false) ifWritten();
  else if (ignored !== true) ignored.then(yes => { if (!yes && watchers.get(root) === watcher) ifWritten(); }, () => {});
}
function unwatch(root) {
  watchers.get(root)?.close();
  watchers.delete(root);
  watchTimes.delete(root);
  covered.delete(norm(root));
  ignores.reload(root);
}
// A watcher for each active repository, and for the main checkout of an active linked worktree (staging in the
// worktree changes files only there) - the active ones first when there are more than MAX_WATCHERS. One whose
// repository is active no more is closed. active: [root].
async function syncWatchers(active) {
  const mains = (await Promise.all(active.map(getMainRoot))).filter(Boolean);
  const wanted = new Set([...active, ...mains]);
  for (const root of [...watchers.keys()]) if (!wanted.has(root)) { unwatch(root); realRoots.delete(root); }
  for (const root of wanted) {
    if (watchers.has(root) || watchers.size >= MAX_WATCHERS) continue;
    if (!realRoots.has(root)) realRoots.set(root, await getRealKey(root));
    try {
      const watcher = fs.watch(root, { recursive: true, persistent: false }, (event, filename) => onWatched(root, watcher, event, filename));
      watcher.on('error', () => { if (watchers.get(root) === watcher) unwatch(root); else watcher.close(); });
      watchers.set(root, watcher);
      watchTimes.set(root, { since: Date.now() - WATCH_SINCE_SLACK_MS, files: new Map() });
    } catch { /* The fallback pass covers platforms without recursive watching. */ }
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

// One repository's status: { status } | { error } | { missing: true } (no git on this computer).
function askStatus(root, reason, isDropped) {
  return ask(`status ${norm(root)}`, reason, root, async () => {
    const { err, stdout, stderr } = await startProcess(await getGitExe(), ["-C", root, ...ARGS], {
      timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    if (err?.code === "ENOENT") return { missing: true };
    if (err) return { error: (String(stderr).trim().split(/\r?\n/)[0] || err.message).slice(0, 300) };
    return { status: parseStatus(stdout) };
  }, isDropped);
}

// ---------- refreshing ----------
// Lists the repositories of the folders opts.dirs() names, asks about those there is a reason to ask about (the header
// comment says which), and reports the result through opts.onChange. What a request may say:
// - reason: who asks. "focus" and "page" - a page, of what it shows, as its window got the focus or later; they are
//   answered whoever is at the window, as somebody is looking. "scan" (the default: the folders may have changed),
//   "timer", "watcher" and "action" are the host's own.
// - shown: the folders the page shows now (a repository's root, or a folder inside one). Those of them that are
//   listed and whose status is older than TTL_MS are asked about.
// - force: the user's Refresh - the folders are looked through anew and every listed repository is asked about.
// - relist: the folders are looked through anew (an action added or removed a worktree, say); nobody is asked for it.
// A refresh asked for while one runs is folded into one more after it.
const REASONS = ["watcher", "action", "scan", "timer", "page", "focus", "forced"]; // of two folded requests, the later one names the pass
function toRequest(r = {}) {
  const force = r.force === true, shown = new Set((Array.isArray(r.shown) ? r.shown : []).filter(d => typeof d === "string" && d).map(norm));
  const reason = force ? "forced" : REASONS.includes(r.reason) && r.reason !== "forced" ? r.reason : shown.size ? "page" : "scan";
  return { force, reason, relist: force || r.relist === true, shown };
}
function refresh(request) {
  if (!opts) return Promise.resolve(snapshot);
  const req = request?.shown instanceof Set ? request : toRequest(request);
  if (running) {
    if (req.force) return running.then(() => refresh(req), () => refresh(req));
    again = !again ? req : {
      force: false, relist: again.relist || req.relist, shown: new Set([...again.shown, ...req.shown]),
      reason: REASONS.indexOf(req.reason) > REASONS.indexOf(again.reason) ? req.reason : again.reason
    };
    return running;
  }
  running = pass(req).finally(() => {
    running = null;
    if (again) {
      const next = again;
      again = null;
      refresh(next).catch(() => {});
    }
  });
  return running;
}
// After a git action on one repository: its status, once any pass running now is over - no other repository is asked
// about. relist: the action may have changed more than the index - the folders are looked through anew (a worktree
// added or removed), and the checkouts that share its refs (its linked worktrees, or the main one) are asked about as
// well, as a fetch or a commit moves what they are ahead of and behind.
async function refreshRepo(root, { relist = false } = {}) {
  const key = norm(root), main = norm(repos.get(key)?.mainRoot || root);
  actedRoots.add(key);
  if (relist) for (const [k, r] of repos) if (norm(r.mainRoot || r.root) === main) actedRoots.add(k);
  while (running) await running.catch(() => {});
  return refresh({ reason: "action", relist });
}
// The active repositories as of now: those of opts.activeDirs(), and those that were among them less than
// ACTIVE_GRACE_MS ago. One that is listed for no other reason stays listed through its grace. -> [root]
let graceTimer = null;
async function getActive(dirRoot, listed, t0) {
  const grace = opts.activeGraceMs ?? ACTIVE_GRACE_MS;
  const inUse = new Set();
  for (const dir of new Set((await opts.activeDirs?.() || []).filter(Boolean))) {
    const root = dirRoot[norm(dir)] ?? await rootOf(dir, t0);
    if (!root) continue;
    inUse.add(norm(root));
    activeAt.set(norm(root), { root: listed.get(norm(root)) || root, at: t0 });
  }
  let left = Infinity;
  for (const [key, a] of activeAt) {
    if (inUse.has(key)) continue;
    if (t0 - a.at >= grace) { activeAt.delete(key); continue; }
    left = Math.min(left, grace - (t0 - a.at));
    if (!listed.has(key)) { listed.set(key, a.root); dirRoot[key] = a.root; }
  }
  // Nothing else may come by when a grace ends: a pass of its own lets the watcher go then.
  clearTimeout(graceTimer);
  graceTimer = null;
  if (left < Infinity) {
    graceTimer = setTimeout(() => refresh({ reason: "scan" }).catch(() => {}), left + 50);
    graceTimer.unref?.();
  }
  activeKeys = new Set(activeAt.keys());
  return [...activeAt.values()].map(a => a.root);
}
async function pass(req) {
  const t0 = Date.now(), { force, reason } = req;
  if (!force && missingAt && t0 - missingAt < MISSING_RETRY_MS) return snapshot;
  // A page that asks is somebody looking; everything else waits for somebody to be at the window.
  const allowed = force || reason === "focus" || reason === "page" || reason === "action" || isFocused();
  const light = reason === "watcher" || reason === "action";
  const dirs = [...new Set((opts.dirs() || []).filter(Boolean))];
  // With the scope "open" the projects are not searched for the repositories nested in them: a project that holds a
  // hundred reference clones would have each of them listed for a panel that shows none of them.
  const shallow = opts.scope?.() === "open";
  const projects = [...new Set([...(opts.projects?.() || dirs), ...(shallow ? (opts.open?.() || []).filter(Boolean) : [])])];
  const discoveryKey = JSON.stringify([shallow, [...projects].sort()]);
  // Not in a watchers' pass or after an action: the walk would delay the status the user waits for after staging, and
  // count as the cost that spaces the watchers' passes out. Nor while nobody is there to see what it finds.
  if (req.relist || discovery.key !== discoveryKey || (!light && allowed && t0 - discovery.at > ROOT_TTL_MS)) discovery = { ...await discoverRepositories(projects, { shallow }), key: discoveryKey, at: t0 };
  const dirRoot = {};
  for (const d of [...dirs, ...discovery.repos]) { if (req.relist) roots.delete(norm(d)); const r = await rootOf(d, t0); if (r) dirRoot[norm(d)] = r; }
  const listed = new Map(Object.values(dirRoot).map(r => [norm(r), r])); // norm(root) -> root
  // The watchers first, the questions after: what changes while git runs is then reported, not missed.
  await syncWatchers(await getActive(dirRoot, listed, t0));
  const watched = new Set([...watchers.keys()].map(norm));
  // What the watchers saw is taken by this pass - or, with nobody at the window, left for the one after the focus.
  const changed = new Set(allowed ? changedRoots : []);
  if (allowed) {
    changedRoots.clear();
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  const acted = new Set(actedRoots);
  actedRoots.clear();
  const shown = new Set([...req.shown].map(k => (dirRoot[k] ? norm(dirRoot[k]) : k)));
  const looking = reason === "focus" || reason === "page" || reason === "timer";
  // Why this pass asks about a repository; "": it does not.
  const getReason = key => {
    if (force) return "forced";
    if (acted.has(key)) return "action";
    if (changed.has(key)) return "watcher";
    if (!allowed) return "";
    const isStale = !(t0 - (repos.get(key)?.at || 0) < TTL_MS);
    if (activeKeys.has(key)) {
      if (!repos.has(key)) return "initial";
      // Watched from now on: what changed before the watcher was up, nobody reported.
      if (watched.has(key) && !covered.has(key)) return "active";
      // No watcher looks after it (there are more active repositories than watchers, or watching failed): as often
      // as somebody looks.
      if (!watched.has(key) && isStale && looking) return reason;
      if (reason === "timer" && isStale) return "timer";
    }
    return shown.has(key) && isStale ? (reason === "focus" ? "focus" : "page") : "";
  };
  const todo = [...listed].map(([key, root]) => ({ key, root, reason: getReason(key) })).filter(x => x.reason)
    .sort((a, b) => Number(activeKeys.has(b.key)) - Number(activeKeys.has(a.key)));
  let missing = false;
  await Promise.all(todo.map(async ({ key, root, reason: why }) => {
    const r = await askStatus(root, why, () => missing);
    if (r.missing) { missing = true; return; }
    repos.set(key, { root, mainRoot: await getMainRoot(root), at: Date.now(), ...(r.status || { error: r.error }) });
    if (watchers.has(root)) covered.add(key);
  }));
  missingAt = missing ? Date.now() : 0;
  if (missing) gitExe = excludesFile = null;
  if (light && todo.length) watchCostMs = Date.now() - t0;
  if (todo.length) watchedAt = Date.now();
  for (const k of repos.keys()) if (!listed.has(k)) repos.delete(k);
  // Listed and never asked about: no status, and nothing that could pass for one.
  const unchecked = {};
  for (const [key, root] of listed) if (!repos.has(key)) unchecked[key] = { root, mainRoot: await getMainRoot(root) };
  const prev = snapshot;
  snapshot = {
    at: Date.now(), missing, discoveryTruncated: discovery.truncated, discoveryTruncatedIn: discovery.truncatedIn, ms: Date.now() - t0, checked: todo.length, starts: stats(),
    dirs: Object.fromEntries(Object.entries(dirRoot).map(([d, r]) => [d, norm(r)])),
    repos: Object.fromEntries(repos), unchecked
  };
  if (signature(snapshot) !== signature(prev) || todo.length) opts.onChange?.(snapshot);
  return snapshot;
}
// What the pages show: an unchanged status is not sent again just because it was checked again, or because the
// folders came in another order (the sessions are sorted by their last activity).
const sorted = o => Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const signature = s => JSON.stringify([s.missing, s.discoveryTruncatedIn, sorted(s.dirs), sorted(s.repos).map(([k, v]) => [k, { ...v, at: 0 }]), Object.keys(s.unchecked || {}).sort()]);

// dirs(): the folders to report on; projects(): those searched for the repositories in them (without it: dirs());
// scope(): "open" - none of the repositories nested in a repository, only a folder's own and those right in a folder
// that is in none, for projects() and open() (the folders of the open terminals) - else every one in projects();
// activeDirs(): the folders a session is live in or a terminal is open in, now (may be a promise; without it no
// repository is active); focused(): whether somebody is at a window that shows the state (without it: always);
// onChange(snapshot); log(line): every start of git, a line each. For the tests, other times than the constants':
// watchDelayMs (WATCH_DELAY_MS), watchSettleMs (WATCH_SETTLE_MS), fallbackMs (ACTIVE_FALLBACK_MS) and activeGraceMs
// (ACTIVE_GRACE_MS).
function start(o) {
  opts = o;
  clearInterval(timer);
  timer = setInterval(() => { if (isFocused()) refresh({ reason: "timer" }).catch(() => {}); }, o.fallbackMs ?? ACTIVE_FALLBACK_MS);
  timer.unref?.();
}

async function diff({ root, file } = {}) {
  const invalid = () => { throw new Error("Invalid repository or changed file"); };
  if (typeof root !== "string" || typeof file !== "string" || !file || file.length > 4096 || file.includes("\0") || !snapshot.repos[norm(root)] || path.isAbsolute(file)) return invalid();
  root = snapshot.repos[norm(root)].root;
  const relative = path.relative(root, path.resolve(root, file));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return invalid();
  const current = await askStatus(root, "diff");
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
  // -> the diff, or null when it is longer than is shown.
  const readDiff = async cached => {
    const { err, stdout, stderr } = await ask(`diff ${cached ? "staged" : "unstaged"} ${norm(root)} ${file}`, "diff", root, async () => startProcess(await getGitExe(),
      ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-C", root, "-c", "core.fsmonitor=false", "diff", ...(cached ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--", file, ...(entry.original ? [entry.original] : [])],
      { timeout: TIMEOUT_MS, maxBuffer: limit, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" } }));
    if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return null;
    if (err) throw new Error(String(stderr).trim().slice(0, 300) || err.message);
    return stdout;
  };
  const [staged, unstaged] = await Promise.all([readDiff(true), readDiff(false)]);
  return { staged: staged || "", unstaged: unstaged || "", binary: /(?:^|\n)Binary files .* differ/.test((staged || "") + (unstaged || "")), tooLarge: staged === null || unstaged === null };
}

let actionContext = () => ({});
const actions = require('./git-actions').createGitActions({ status: () => snapshot, refresh, refreshRepo, parseStatus, context: () => actionContext() });
function stop() {
  clearInterval(timer);
  clearTimeout(watchTimer);
  clearTimeout(graceTimer);
  watchTimer = graceTimer = null;
  changedRoots.clear(); actedRoots.clear(); activeAt.clear(); covered.clear();
  activeKeys = new Set();
  watchCostMs = 0; watchedAt = 0;
  for (const w of watchers.values()) w.close();
  watchers.clear(); watchTimes.clear(); realRoots.clear(); ignores.clear();
}
module.exports = { start, stop, refresh, refreshRepo, get: () => snapshot, stats, parseStatus, norm, discoverRepositories, diff, WATCH_NOISE, getWatchDelay, resolveGitExe, TTL_MS,
  query: actions.query, execute: actions.execute, configure: context => { actionContext = context; } };
