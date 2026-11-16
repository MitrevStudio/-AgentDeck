// Claude Code's scratchpad folders on this computer: how much room they take, and clearing those of finished sessions.
//
// Claude Code keeps a folder per session in the temp folder and never removes it:
//   <root>/<project key>/<session id>/scratchpad (and tasks, images beside it)
// where <root> is <temp>\claude on Windows and <temp>/claude-<uid> on Linux and macOS; <temp> is CLAUDE_CODE_TMPDIR
// when set, else the system's temp folder (always /tmp on macOS). Read from Claude Code's own bundles (2.1.226 and
// 2.1.282). Other things live in <root> too (bundled skills, caches): they are counted in the total and never touched.
//
// Nothing is removed unless asked (clear), and then only the folder of a session that has surely finished:
//   - its name is a session id, and no running Claude Code process holds that id (live.js liveIds, read again right
//     before each folder goes: a finished session can be resumed under its old id at any moment);
//   - nothing in it was written in the last hour, and neither was the session's transcript - a session can be starting,
//     or be one the registry does not list (an SDK run, another Claude home);
//   - all of it could be read.
// Links and junctions in a folder (a scratchpad can hold a junction into a project's node_modules) are never
// followed: they are counted as nothing and removed as links, their targets stay.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fsp = fs.promises;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECENT_MS = 60 * 60 * 1000;
const CONCURRENCY = 8; // file system calls in flight while a folder is measured

// Where this platform's Claude Code keeps them; "" where that is not known.
function defaultRoot() {
  const temp = process.env.CLAUDE_CODE_TMPDIR || (process.platform === "darwin" ? "/tmp" : os.tmpdir());
  if (process.platform === "win32") return path.join(temp, "claude");
  return typeof process.getuid === "function" ? path.join(temp, `claude-${process.getuid()}`) : "";
}

const mtimeOf = async file => { try { return (await fsp.lstat(file)).mtimeMs; } catch { return 0; } };

// A folder's size (the files' own sizes; a link counts as nothing) and its newest write, links not followed.
// unread: something in it could not be read. What vanishes meanwhile is simply not there.
async function measure(top) {
  const out = { bytes: 0, newest: 0, unread: false };
  const queue = [top];
  let active = 0;
  const failed = e => { if (e.code !== "ENOENT") out.unread = true; };
  async function visit(dir) {
    let entries;
    try {
      out.newest = Math.max(out.newest, (await fsp.lstat(dir)).mtimeMs);
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) { return failed(e); }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { queue.push(file); continue; } // a link to a folder is not one
      try {
        const st = await fsp.lstat(file);
        if (st.isFile()) out.bytes += st.size;
        out.newest = Math.max(out.newest, st.mtimeMs);
      } catch (e) { failed(e); }
    }
  }
  await new Promise(resolve => {
    const next = () => {
      while (active < CONCURRENCY && queue.length) { active++; visit(queue.pop()).then(() => { active--; next(); }); }
      if (!active) resolve();
    };
    next();
  });
  return out;
}

// root: the folder (defaultRoot()); liveIds(): the ids of the running sessions, as a Set (may be async);
// projectsDir: Claude Code's transcripts (<project>/<session id>.jsonl); recentMs, now and remove: for tests.
function createScratchpads({ root = defaultRoot(), liveIds = () => require("./live").liveIds(),
  projectsDir = path.join(os.homedir(), ".claude", "projects"), recentMs = RECENT_MS, now = Date.now,
  remove = dir => fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }) } = {}) {
  let scanning = null, clearing = null;

  const info = () => ({ supported: Boolean(root) && fs.existsSync(root), dir: root });
  const running = async () => new Set([...(await liveIds())].map(id => String(id).toLowerCase()));

  // session id -> the project folders with a transcript of it.
  async function transcriptDirs() {
    const byId = new Map();
    let dirs = [];
    try { dirs = await fsp.readdir(projectsDir); } catch {}
    for (const dir of dirs) {
      let names = [];
      try { names = await fsp.readdir(path.join(projectsDir, dir)); } catch {}
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length).toLowerCase();
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(path.join(projectsDir, dir, name));
      }
    }
    return byId;
  }
  // The newest write to a session's transcript or to one of its subagents'.
  async function transcriptAt(files) {
    let at = 0;
    for (const file of files || []) {
      at = Math.max(at, await mtimeOf(file));
      const subagents = path.join(file.slice(0, -".jsonl".length), "subagents");
      let names = [];
      try { names = await fsp.readdir(subagents); } catch {}
      for (const name of names) at = Math.max(at, await mtimeOf(path.join(subagents, name)));
    }
    return at;
  }

  // Everything in the root: the session folders, each measured and marked finished or not, and the size of the rest.
  // null when the root is not there.
  async function survey() {
    let top;
    try { top = await fsp.readdir(root, { withFileTypes: true }); } catch { return null; }
    const sessions = [];
    let other = 0;
    const count = async (entry, file) => {
      if (entry.isDirectory()) other += (await measure(file)).bytes;
      else { try { const st = await fsp.lstat(file); if (st.isFile()) other += st.size; } catch {} }
    };
    for (const project of top) {
      const dir = path.join(root, project.name);
      let entries = null;
      if (project.isDirectory()) { try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch {} }
      if (!entries) { await count(project, dir); continue; }
      for (const entry of entries) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory() && SESSION_ID.test(entry.name)) sessions.push({ id: entry.name.toLowerCase(), path: file, project: dir, ...(await measure(file)) });
        else await count(entry, file);
      }
    }
    const live = await running();
    const transcripts = await transcriptDirs();
    const at = now();
    for (const s of sessions) {
      const quiet = !live.has(s.id) && !s.unread && at - s.newest >= recentMs;
      s.finished = quiet && at - (await transcriptAt(transcripts.get(s.id))) >= recentMs;
    }
    return { sessions, other };
  }

  const sum = list => ({ bytes: list.reduce((n, s) => n + s.bytes, 0), folders: list.length });

  // -> { supported, dir, total, finished, running }, each { bytes, folders }: `folders` counts session folders, and
  // `total.bytes` is the whole root, with what is not a session's. One measurement at a time: who asks meanwhile
  // gets the same answer.
  function scan() {
    scanning ??= (async () => {
      const found = root ? await survey() : null;
      if (!found) return { supported: false, dir: root };
      const finished = found.sessions.filter(s => s.finished), kept = found.sessions.filter(s => !s.finished);
      const total = sum(found.sessions);
      return { supported: true, dir: root, total: { bytes: total.bytes + found.other, folders: total.folders }, finished: sum(finished), running: sum(kept) };
    })().finally(() => { scanning = null; });
    return scanning;
  }

  // Written to since it was measured: the folder itself or what lies directly in it.
  async function changedSince(s) {
    let names = [];
    try { names = await fsp.readdir(s.path); } catch {}
    for (const file of [s.path, ...names.map(n => path.join(s.path, n))]) if (await mtimeOf(file) > s.newest) return true;
    return false;
  }

  // Removes the finished sessions' folders, measured anew; a project folder left empty by that goes too.
  // -> { removed, bytes, failed }: folders gone, the bytes they held, folders that could not be removed (whole or
  // in part). A session that started meanwhile is kept and is not a failure.
  function clear() {
    clearing ??= (async () => {
      const out = { removed: 0, bytes: 0, failed: 0 };
      const found = root ? await survey() : null;
      const emptied = new Set();
      for (const s of found?.sessions.filter(x => x.finished) || []) {
        // Inside the root by construction; checked all the same before anything is removed.
        if (path.resolve(s.path, "..", "..") !== path.resolve(root)) continue;
        if ((await running()).has(s.id) || await changedSince(s)) continue;
        try {
          await remove(s.path);
          out.removed++;
          out.bytes += s.bytes;
          emptied.add(s.project);
        } catch { out.failed++; }
      }
      for (const dir of emptied) { try { await fsp.rmdir(dir); } catch {} } // only if nothing is left in it
      return out;
    })().finally(() => { clearing = null; });
    return clearing;
  }

  return { info, scan, clear };
}

module.exports = { createScratchpads, defaultRoot, measure, SESSION_ID };
