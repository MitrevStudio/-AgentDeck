// Usage scan on a thread of its own (started by usage.js). The first pass walks the transcripts' folders and reads
// what the cache does not have; after it the folders are watched, and a pass looks only at the files the watchers
// named since the last one - a pass with nothing new touches no transcript and answers with the figures it had. The
// folders are walked again only when a watcher cannot say what changed (it failed, lost events, is not available),
// when a refresh asks for it, and as a safety net every WALK_EVERY_MS. A writer that keeps its file open may not
// cause an event for every append (Windows tells of it only when the file is flushed or closed), so the transcripts
// that changed within the last RECENT_MS are looked at on every pass, event or not: a stat each of the few files in
// use, for a few minutes after their last change. What each file yielded is kept in a cache in
// userData (usage-cache.js: a base and a journal of the entries that changed), so a restart starts from there.
// Every source is opened read-only.
//
// Messages in: { type: "scan", full?, snapshots?, resend? } - full: walk the folders; snapshots: the names of the
// context snapshots that changed, or true for all of them; resend: answer with the whole summary. { type: "flush" }
// writes what is not saved yet. Out: { type: "result", summary } when the figures changed, { type: "result", same:
// { version, at, stats } } when they did not, { type: "error", message }, { type: "flushed" }.
// stats of a pass: files - transcripts looked at (the changed ones and the ones in use); read - of them, opened; bytes - read from them; walked - the
// folders were listed; full - nothing was cached; ms; saved - "base" or "journal" when the pass wrote the cache.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const scan = require("./usage-scan");
const context = require("./session-context");
const openCodeModels = require("./opencode-models");
const claudeContext = require("./claude-context");
const { createStore, emptyOpenCode } = require("./usage-cache");
const { readAt, lineChunks } = require("./file-chunks");

const VERSION = 5;          // Separate context snapshots; OpenCode 2 storage only.
const MARK = 64;            // bytes compared to tell a rewritten file from one that only grew
const PARALLEL = 4;         // files read at once
const MAX_PENDING = 5000;   // more changed paths than this between two passes: a walk is cheaper
const MAX_FOLDERS = 64;     // the same for folders (and files that are not transcripts) that came or went
const { cacheFile, claudeDir, codexDir, openCodeDb, tuning = {} } = workerData; // tuning: shorter times and sizes, for the tests
const SAVE_AFTER_MS = tuning.saveAfterMs ?? 90 * 1000;
const WALK_EVERY_MS = tuning.walkEveryMs ?? 15 * 60 * 1000;
const RECENT_MS = tuning.recentMs ?? 10 * 60 * 1000; // how long after its last change a transcript counts as in use

const modelLimits = openCodeModels.createModelLimits();
const store = createStore(cacheFile, VERSION, tuning);
const dataDir = path.dirname(cacheFile);

let cache = null, saveTimer = null, saving = Promise.resolve(), openCodeWarning = "";
// Not saved yet: the paths whose entry was replaced or removed, and whether the OpenCode part changed.
const unsaved = new Set();
let unsavedOpenCode = false;
// The last figures: kept for the passes that find nothing new. limitsDue: when OpenCode's model limits are asked
// for again (they are not part of the cache); sent: the version the main process has.
// stale: the cache changed and the figures were not worked out again yet (also after a pass that failed half way).
let summary = null, version = "", limitsDue = Infinity, sent = "", stale = true;
let snapshots = null;
const snapshotRetry = new Set();

// ---------- cache ----------
// One at a time; what changes while a save is being written goes with the next one.
function save(opts) {
  clearTimeout(saveTimer); saveTimer = null;
  const run = saving.then(async () => {
    if (!cache) return "";
    const files = new Set(unsaved), openCode = unsavedOpenCode;
    unsaved.clear(); unsavedOpenCode = false;
    try { return await store.save(cache, files, openCode, opts); }
    catch (e) {
      for (const f of files) unsaved.add(f);
      unsavedOpenCode ||= openCode;
      console.error("Could not save the usage cache:", e.message);
      return "";
    }
  });
  saving = run;
  return run;
}
const hasUnsaved = () => unsaved.size > 0 || unsavedOpenCode;

// ---------- transcripts ----------
async function listFiles(dir, out = []) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}
// projects/<folder>/<id>.jsonl is a session; anything under projects/<folder>/<id>/ (subagents, workflows) is part of it.
function claudeEntry(file) {
  const parts = path.relative(claudeDir, file).split(path.sep);
  const sub = parts.length > 2;
  return { agent: "Claude", sid: sub ? parts[1] : path.basename(file, ".jsonl"), sub, cwd: "", msgs: new Map() };
}
const codexEntry = file => ({ agent: "Codex", sid: path.basename(file, ".jsonl"), sub: false, cwd: "", msgs: new Map() });

// The two folders of transcripts. watcher: tells which files changed; walk: it cannot be trusted for what happened
// so far, the folder is listed on the next pass; files, folders: the paths it named since the last pass; walkedAt:
// the last listing; recent: the transcripts in use - path -> when it last changed.
const roots = [
  { dir: claudeDir, agent: "Claude", makeEntry: claudeEntry, read: scan.readClaude },
  { dir: codexDir, agent: "Codex", makeEntry: codexEntry, read: scan.readCodex }
].map(r => ({ ...r, watcher: null, walk: true, files: new Set(), folders: new Set(), walkedAt: 0, recent: new Map() }));
// A restart: what the cache says changed lately may still be written to.
function load() {
  const loaded = store.load(), now = Date.now();
  for (const [f, e] of loaded.files) if (now - e.mtime < RECENT_MS) roots.find(r => r.agent === e.agent)?.recent.set(f, e.mtime);
  return loaded;
}

// A recursive watch: Windows and macOS have one, Linux gets one from Node (a watch per folder). Returns false when
// the folder does not exist (yet) - asked again on every pass, which costs no more than the failed call.
function watch(root) {
  if (root.watcher) return true;
  try {
    const watcher = fs.watch(root.dir, { recursive: true }, (event, name) => {
      if (tuning.dropEvents) return; // the tests: a watcher that says nothing
      // No name: events were lost (Windows, when more came than its buffer holds) or the platform does not tell.
      if (!name) { root.walk = true; return; }
      const full = path.join(root.dir, String(name));
      if (full.endsWith(".jsonl")) root.files.add(full);
      // A folder that appeared, went or was renamed may bring or take transcripts no event names: it is listed.
      // (A change of a folder's own times says nothing its files' events do not, and other files are not ours.)
      else if (event === "rename") root.folders.add(full);
      if (root.files.size + root.folders.size > MAX_PENDING) { root.walk = true; root.files.clear(); root.folders.clear(); }
    });
    watcher.on("error", err => {
      console.error(`Usage: watching ${root.dir} failed:`, err.message);
      watcher.close();
      if (root.watcher === watcher) root.watcher = null;
      root.walk = true;
    });
    root.watcher = watcher;
    root.walk = true; // what happened before it was there is unknown
    return true;
  } catch (err) {
    root.walk = true;
    if (err.code === "ENOENT") return false;
    if (root.warning !== err.message) console.error(`Usage: could not watch ${root.dir}:`, root.warning = err.message);
    return true; // without a watcher every pass lists the folder, as before there were any
  }
}

function forget(file) {
  for (const root of roots) root.recent.delete(file);
  if (cache.files.delete(file)) { unsaved.add(file); return true; }
  return false;
}

// Returns whether the file's entry changed (or went).
async function updateFile(file, root, stats) {
  let st;
  try { st = await fs.promises.stat(file); } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return forget(file);
    throw e;
  }
  if (!st.isFile()) return forget(file);
  stats.files++;
  let e = cache.files.get(file);
  if (e && e.size === st.size && e.mtime === st.mtimeMs) return false;
  const fh = await fs.promises.open(file, "r");
  stats.read++;
  // The bytes just before where the last pass stopped: if they changed, the file was replaced, not appended to.
  const markAt = async offset => (await readAt(fh, offset - Math.min(MARK, offset), Math.min(MARK, offset))).toString("base64");
  try {
    if (e && (st.size < e.offset || (await markAt(e.offset)) !== e.mark)) e = null;
    const known = Boolean(e);
    e ??= { ...root.makeEntry(file), offset: 0, mark: "" };
    const from = e.offset;
    // A piece at a time: a first pass over a large transcript must not hold all of it.
    for await (const lines of lineChunks(fh, e.offset, st.size)) {
      const used = root.read(lines, e);
      e.offset += used;
      stats.bytes += used;
    }
    if (e.offset > from) e.mark = await markAt(e.offset);
    // In use: one that grew while it was known changed just now; for any other its own time says when.
    const now = Date.now(), at = known && e.offset > from ? now : Math.min(st.mtimeMs, now);
    if (now - at < RECENT_MS) root.recent.set(file, at); else root.recent.delete(file);
    e.size = st.size; e.mtime = st.mtimeMs;
    cache.files.set(file, e);
    unsaved.add(file);
    return true;
  } finally { await fh.close(); }
}

// The files of one folder to look at in this pass. Whatever the watcher names from here on is for the next pass.
async function changedFiles(root, force, stats) {
  const watched = watch(root);
  const files = root.files, folders = root.folders;
  root.files = new Set(); root.folders = new Set();
  let changed = false;
  if (force || root.walk || !root.watcher || folders.size > MAX_FOLDERS || Date.now() - root.walkedAt >= WALK_EVERY_MS) {
    root.walk = false;
    root.walkedAt = Date.now();
    const present = new Set(watched ? await listFiles(root.dir) : []);
    if (watched) stats.walked = true;
    for (const [f, e] of cache.files) if (e.agent === root.agent && !present.has(f)) changed = forget(f) || changed;
    return { files: present, changed };
  }
  const now = Date.now();
  for (const [f, at] of root.recent) if (now - at < RECENT_MS) files.add(f); else root.recent.delete(f);
  for (const folder of folders) {
    const present = new Set(await listFiles(folder));
    for (const f of present) files.add(f);
    const inside = folder + path.sep;
    for (const f of cache.files.keys()) if (f.startsWith(inside) && !present.has(f)) changed = forget(f) || changed;
  }
  return { files, changed };
}

async function updateTranscripts(stats, force) {
  let changed = false;
  const jobs = [];
  for (const root of roots) {
    const found = await changedFiles(root, force, stats);
    changed ||= found.changed;
    for (const f of found.files) jobs.push([f, root]);
  }
  let next = 0;
  const run = async () => {
    while (next < jobs.length) {
      const [f, root] = jobs[next++];
      try { changed = (await updateFile(f, root, stats)) || changed; }
      catch (e) {
        console.error(`Usage: could not read ${f}:`, e.message);
        root.files.add(f); // looked at again on the next pass
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, run));
  return changed;
}

// ---------- OpenCode ----------
// Its database is opened read-only, and only when it (or its write-ahead log) changed since the last look. Returns
// whether it was read.
function updateOpenCode(stats) {
  const oc = cache.openCode;
  const stamp = ["", "-wal"].map(s => { try { const st = fs.statSync(openCodeDb + s); return `${st.size}:${st.mtimeMs}`; } catch { return "-"; } }).join("|");
  if (stamp === oc.stamp) return false;
  if (!fs.existsSync(openCodeDb)) {
    cache.openCode = { ...emptyOpenCode(), stamp };
    unsavedOpenCode = true;
    return true;
  }
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return false; }
  const db = new DatabaseSync(openCodeDb, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 1000');
    oc.sessions = db.prepare("SELECT id, parent_id AS parent, directory AS dir, title FROM session_v2").all().map(s => ({ ...s }));
    const rows = db.prepare("SELECT id, session_id, type, time_created, time_updated, data FROM session_message WHERE time_updated >= ? AND type = 'assistant'").all(oc.since);
    for (const row of rows) {
      oc.since = Math.max(oc.since, Number(row.time_updated) || 0);
      const rec = scan.openCodeRecord(row);
      if (rec) oc.msgs.set(rec[0], [...rec, row.session_id]);
    }
    // Re-read each root's latest usable observation, so removals/reverts cannot leave
    // a newer, deleted message in the context cache. Child usage remains in the ledger.
    oc.contexts = {};
    const latest = db.prepare(`SELECT type, time_created, time_updated, data FROM session_message
      WHERE session_id = ? AND type IN ('assistant', 'compaction', 'model-switched')
      AND json_extract(data, '$.error') IS NULL
      AND (type != 'compaction' OR json_extract(data, '$.status') = 'completed')
      AND (json_extract(data, '$.tokens.total') > 0 OR json_extract(data, '$.tokens.input') > 0
        OR json_extract(data, '$.tokens.cache.read') > 0 OR json_extract(data, '$.tokens.cache.write') > 0
        OR json_extract(data, '$.tokens.output') > 0 OR json_extract(data, '$.tokens.reasoning') > 0
        OR type IN ('compaction', 'model-switched'))
      ORDER BY seq DESC LIMIT 1`);
    for (const s of oc.sessions.filter(s => !s.parent)) {
      const row = latest.get(s.id);
      if (row) oc.contexts[s.id] = context.openCode(row);
    }
    stats.openCodeRows = rows.length;
    const live = new Set(oc.sessions.map(s => s.id));
    const messages = new Set(db.prepare("SELECT id FROM session_message WHERE type = 'assistant'").all().map(r => r.id));
    for (const [id, rec] of oc.msgs) if (!live.has(rec[10]) || !messages.has(id)) oc.msgs.delete(id);
    oc.stamp = stamp;
    unsavedOpenCode = true;
    return true;
  } finally { db.close(); }
}

// ---------- context snapshots ----------
// What Claude Code's status line reported per session (claude-context.js), kept here between passes: all of them are
// read once, then only the ones the main process saw change (names: their file names, or true for all). Returns
// whether any is different.
function updateSnapshots(names) {
  if (!snapshots || names === true) {
    const next = claudeContext.readSnapshots(dataDir);
    const changed = !snapshots || JSON.stringify([...next]) !== JSON.stringify([...snapshots]);
    snapshots = next;
    snapshotRetry.clear();
    return changed;
  }
  let changed = false;
  const dir = claudeContext.snapshotsDir(dataDir);
  const todo = new Set([...(Array.isArray(names) ? names : []), ...snapshotRetry]);
  snapshotRetry.clear();
  for (const name of todo) {
    let found;
    // Being replaced right now: what was known stays until it can be read.
    try { found = claudeContext.readSnapshot(dir, String(name)); } catch { snapshotRetry.add(name); continue; }
    const key = `Claude:${String(name).replace(/\.json$/, "")}`;
    if (JSON.stringify(found?.[1]) === JSON.stringify(snapshots.get(key))) continue;
    if (found) snapshots.set(key, found[1]); else snapshots.delete(key);
    changed = true;
  }
  return changed;
}

// ---------- totals ----------
// Earliest session first, so a reply copied into a later (resumed or forked) session counts for the original.
function sources() {
  const bySession = new Map();
  for (const [file, e] of cache.files) {
    const key = `${e.agent}:${e.agent === "Codex" ? e.id || e.sid : e.sid}`;
    let first = Infinity;
    for (const r of e.msgs.values()) if (r[1] && r[1] < first) first = r[1];
    if (!bySession.has(key)) bySession.set(key, { first, list: [] });
    const s = bySession.get(key);
    s.first = Math.min(s.first, first);
    s.list.push({ key, cwd: e.cwd, msgs: e.msgs.values(), sub: e.sub, file,
      context: e.sub ? null : context.latest(e.context, snapshots.get(key)) });
  }
  const ordered = [...bySession.values()].sort((a, b) => a.first - b.first)
    .flatMap(s => s.list.sort((a, b) => a.sub - b.sub || (a.file < b.file ? -1 : 1)));
  // OpenCode: a subagent runs in a child session; it counts for the session at the top.
  const oc = cache.openCode, byId = new Map(oc.sessions.map(s => [s.id, s]));
  const top = id => { let s = byId.get(id); for (let i = 0; s?.parent && byId.has(s.parent) && i < 50; i++) s = byId.get(s.parent); return s; };
  const groups = new Map();
  for (const s of oc.sessions.filter(s => !s.parent)) groups.set(s.id,
    { key: `OpenCode:${s.id}`, cwd: s.dir, title: s.title, msgs: [], context: oc.contexts[s.id] });
  for (const rec of oc.msgs.values()) {
    const root = top(rec[10]), id = root?.id || rec[10];
    if (!groups.has(id)) groups.set(id, { key: `OpenCode:${id}`, cwd: root?.dir || "", title: root?.title || "", msgs: [] });
    groups.get(id).msgs.push(rec);
  }
  return [...ordered, ...groups.values()];
}

async function run(msg) {
  const t0 = performance.now();
  cache ??= load();
  const full = cache.files.size === 0;
  const stats = { files: 0, read: 0, bytes: 0, openCodeRows: 0, walked: false };
  stale = (await updateTranscripts(stats, Boolean(msg.full))) || stale;
  try { stale = updateOpenCode(stats) || stale; }
  catch (e) {
    stale = true; // it may have been read in part
    if (e.message !== openCodeWarning) console.error("Usage: could not read the OpenCode database:", openCodeWarning = e.message);
  }
  stale = updateSnapshots(msg.full ? true : msg.snapshots) || stale;
  // Most passes find nothing new and keep the figures they had - and their version, so the windows are not redrawn.
  if (stale || Date.now() >= limitsDue) {
    const from = sources();
    // The limits of OpenCode's models are asked from its CLI and kept for a while: due again when that has passed.
    limitsDue = from.some(s => s.key.startsWith("OpenCode:") && s.context?.model && s.cwd) ? Date.now() + openCodeModels.TTL : Infinity;
    summary = scan.aggregate(await modelLimits.enrich(from));
    version = crypto.createHash("sha1").update(JSON.stringify([summary.models, summary.sessions, summary.rows])).digest("base64");
    stale = false;
  }
  stats.ms = Math.round(performance.now() - t0);
  stats.full = full;
  // A big pass is worth keeping at once; small ones (a running session's last replies) are batched.
  if (hasUnsaved() && (full || stats.bytes > 8 * 1024 * 1024)) stats.saved = await save({ whole: full });
  else if (hasUnsaved()) saveTimer ??= setTimeout(save, SAVE_AFTER_MS);
  const at = Date.now();
  if (version === sent && !msg.resend) return { same: { version, at, stats } };
  sent = version;
  return { summary: { ...summary, version, at, stats } };
}

parentPort.on("message", async msg => {
  if (msg?.type === "flush") {
    await save();
    if (cache) await store.tidy(cache).catch(e => console.error("Could not save the usage cache:", e.message));
    parentPort.postMessage({ type: "flushed" });
    return;
  }
  if (msg?.type !== "scan") return;
  try { parentPort.postMessage({ type: "result", ...(await run(msg)) }); }
  catch (e) { parentPort.postMessage({ type: "error", message: e.stack || e.message }); }
});
