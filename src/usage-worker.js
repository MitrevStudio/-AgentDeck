// Usage scan on a thread of its own (started by usage.js): the first scan reads every transcript, later ones only
// the bytes appended since. What each file yielded is kept in a cache in userData, so a restart starts from there.
// Every source is opened read-only.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const scan = require("./usage-scan");
const atomic = require("./voice/atomic-file");
const { readAt, lineChunks } = require("./file-chunks");

const VERSION = 1;          // of the cache layout and of what the parsers extract
const MARK = 64;            // bytes compared to tell a rewritten file from one that only grew
const PARALLEL = 4;         // files read at once
const SAVE_AFTER_MS = 90 * 1000;
const { cacheFile, claudeDir, codexDir, openCodeDb } = workerData;

let cache = null, dirty = false, saveTimer = null;

// ---------- cache ----------
const recMap = list => new Map((list || []).map(r => [r[0], r]));
function emptyCache() { return { files: new Map(), openCode: { stamp: "", since: 0, sessions: [], msgs: new Map() } }; }
function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (raw.v !== VERSION) return emptyCache();
    const oc = raw.openCode || {};
    return {
      files: new Map(Object.entries(raw.files || {}).map(([f, e]) => [f, { ...e, msgs: recMap(e.msgs) }])),
      openCode: { stamp: oc.stamp || "", since: oc.since || 0, sessions: oc.sessions || [], msgs: recMap(oc.msgs) }
    };
  } catch { return emptyCache(); }
}
async function save() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dirty || !cache) return;
  dirty = false;
  const files = Object.fromEntries([...cache.files].map(([f, e]) => [f, { ...e, msgs: [...e.msgs.values()] }]));
  const oc = cache.openCode;
  try { await atomic.write(cacheFile, JSON.stringify({ v: VERSION, files, openCode: { ...oc, msgs: [...oc.msgs.values()] } })); }
  catch (e) { dirty = true; console.error("Could not save the usage cache:", e.message); }
}

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

async function updateFile(file, makeEntry, read, stats) {
  let st;
  try { st = await fs.promises.stat(file); } catch { return; }
  let e = cache.files.get(file);
  if (e && e.size === st.size && e.mtime === st.mtimeMs) return;
  const fh = await fs.promises.open(file, "r");
  // The bytes just before where the last pass stopped: if they changed, the file was replaced, not appended to.
  const markAt = async offset => (await readAt(fh, offset - Math.min(MARK, offset), Math.min(MARK, offset))).toString("base64");
  try {
    if (e && (st.size < e.offset || (await markAt(e.offset)) !== e.mark)) e = null;
    e ??= { ...makeEntry(file), offset: 0, mark: "" };
    const from = e.offset;
    // A piece at a time: a first pass over a large transcript must not hold all of it.
    for await (const lines of lineChunks(fh, e.offset, st.size)) {
      const used = read(lines, e);
      e.offset += used;
      stats.bytes += used;
    }
    if (e.offset > from) e.mark = await markAt(e.offset);
    e.size = st.size; e.mtime = st.mtimeMs;
    cache.files.set(file, e);
    dirty = true;
  } finally { await fh.close(); }
}

async function updateTranscripts(stats) {
  const jobs = [
    ...(await listFiles(claudeDir)).map(f => [f, claudeEntry, scan.readClaude]),
    ...(await listFiles(codexDir)).map(f => [f, codexEntry, scan.readCodex])
  ];
  stats.files = jobs.length;
  const present = new Set(jobs.map(j => j[0]));
  for (const f of cache.files.keys()) if (!present.has(f)) { cache.files.delete(f); dirty = true; }
  let next = 0;
  const run = async () => {
    while (next < jobs.length) {
      const [f, make, read] = jobs[next++];
      try { await updateFile(f, make, read, stats); } catch (e) { console.error(`Usage: could not read ${f}:`, e.message); }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, run));
}

// ---------- OpenCode ----------
// Its database is opened read-only, and only when it (or its write-ahead log) changed since the last look.
function updateOpenCode(stats) {
  const oc = cache.openCode;
  const stamp = ["", "-wal"].map(s => { try { const st = fs.statSync(openCodeDb + s); return `${st.size}:${st.mtimeMs}`; } catch { return "-"; } }).join("|");
  if (stamp === oc.stamp) return;
  if (!fs.existsSync(openCodeDb)) {
    cache.openCode = { ...emptyCache().openCode, stamp };
    dirty = true;
    return;
  }
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return; }
  const db = new DatabaseSync(openCodeDb, { readOnly: true });
  try {
    oc.sessions = db.prepare("SELECT id, parent_id AS parent, directory AS dir, title FROM session").all().map(s => ({ ...s }));
    const rows = db.prepare("SELECT id, session_id, time_created, time_updated, data FROM message WHERE time_updated >= ? AND json_extract(data, '$.role') = 'assistant'").all(oc.since);
    for (const row of rows) {
      oc.since = Math.max(oc.since, Number(row.time_updated) || 0);
      const rec = scan.openCodeRecord(row);
      if (rec) oc.msgs.set(rec[0], [...rec, row.session_id]);
    }
    stats.openCodeRows = rows.length;
    const live = new Set(oc.sessions.map(s => s.id));
    for (const [id, rec] of oc.msgs) if (!live.has(rec[10])) oc.msgs.delete(id); // deleted sessions
    oc.stamp = stamp;
    dirty = true;
  } finally { db.close(); }
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
    s.list.push({ key, cwd: e.cwd, msgs: e.msgs.values(), sub: e.sub, file });
  }
  const ordered = [...bySession.values()].sort((a, b) => a.first - b.first)
    .flatMap(s => s.list.sort((a, b) => a.sub - b.sub || (a.file < b.file ? -1 : 1)));
  // OpenCode: a subagent runs in a child session; it counts for the session at the top.
  const oc = cache.openCode, byId = new Map(oc.sessions.map(s => [s.id, s]));
  const top = id => { let s = byId.get(id); for (let i = 0; s?.parent && byId.has(s.parent) && i < 50; i++) s = byId.get(s.parent); return s; };
  const groups = new Map();
  for (const rec of oc.msgs.values()) {
    const root = top(rec[10]), id = root?.id || rec[10];
    if (!groups.has(id)) groups.set(id, { key: `OpenCode:${id}`, cwd: root?.dir || "", title: root?.title || "", msgs: [] });
    groups.get(id).msgs.push(rec);
  }
  return [...ordered, ...groups.values()];
}

async function run() {
  const t0 = performance.now();
  cache ??= load();
  const full = cache.files.size === 0;
  const stats = { files: 0, bytes: 0, openCodeRows: 0 };
  await updateTranscripts(stats);
  try { updateOpenCode(stats); } catch (e) { console.error("Usage: could not read the OpenCode database:", e.message); }
  const summary = scan.aggregate(sources());
  stats.ms = Math.round(performance.now() - t0);
  stats.full = full;
  // A big pass is worth keeping at once; small ones (a running session's last replies) are batched.
  if (dirty && (full || stats.bytes > 8 * 1024 * 1024)) await save();
  else if (dirty) saveTimer ??= setTimeout(save, SAVE_AFTER_MS);
  // Most passes find nothing new: the same figures keep their version, so the windows are not redrawn for them.
  const version = crypto.createHash("sha1").update(JSON.stringify([summary.models, summary.sessions, summary.rows])).digest("base64");
  return { ...summary, version, at: Date.now(), stats };
}

parentPort.on("message", async msg => {
  if (msg?.type === "flush") { await save(); parentPort.postMessage({ type: "flushed" }); return; }
  if (msg?.type !== "scan") return;
  try { parentPort.postMessage({ type: "result", summary: await run() }); }
  catch (e) { parentPort.postMessage({ type: "error", message: e.stack || e.message }); }
});
