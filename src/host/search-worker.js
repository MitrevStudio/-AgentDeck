// The full-text index of the sessions' conversations (search.js), in a worker so indexing never stalls the app.
// SQLite FTS5 with the trigram tokenizer: any substring of three or more characters matches, Cyrillic and case
// included. What is indexed is what was said - the user's prompts, the agent's answers, the files and commands its
// tools were pointed at - not the tools' output, which would be most of the bytes and little of the meaning.
//
// Messages in: {type: "index", items: [{key, file, agent}]}, {type: "query", id, q, limit}.
// Messages out: {type: "indexed", changed, total}, {type: "result", id, hits: [{key, snippet}]}, {type: "error", message}.
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = 1;
const MAX_BODY = 1_500_000; // characters per session
const MARK_OPEN = "\u0002", MARK_CLOSE = "\u0003";

const db = new DatabaseSync(workerData.dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
if (db.prepare("PRAGMA user_version").get().user_version !== SCHEMA) {
  db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS docs;");
  db.exec(`PRAGMA user_version = ${SCHEMA}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS files (key TEXT PRIMARY KEY, file TEXT, mtime REAL, size INTEGER);
  CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(key UNINDEXED, body, tokenize = 'trigram');`);
const q = {
  file: db.prepare("SELECT mtime, size FROM files WHERE key = ?"),
  allFiles: db.prepare("SELECT key, file FROM files"),
  putFile: db.prepare("INSERT OR REPLACE INTO files (key, file, mtime, size) VALUES (?, ?, ?, ?)"),
  dropFile: db.prepare("DELETE FROM files WHERE key = ?"),
  dropDoc: db.prepare("DELETE FROM docs WHERE key = ?"),
  putDoc: db.prepare("INSERT INTO docs (key, body) VALUES (?, ?)"),
  // A trigram index counts tokens of three characters: 40 of them is about a line of text.
  search: db.prepare(`SELECT key, snippet(docs, 1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 40) AS snippet
    FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?`)
};

const textOf = content => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(c => (c?.type === "text" || c?.type === "input_text" || c?.type === "output_text") ? c.text || "" : "").join("\n") : "";
const toolLine = c => {
  const i = c?.input || {};
  const what = i.file_path || i.notebook_path || i.command || i.pattern || i.url || i.description || i.query || i.path || "";
  return `${c.name || ""} ${String(what).slice(0, 300)}`;
};

// One conversation as plain text.
function bodyOf(file, agent) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const parts = [];
  let len = 0;
  const add = s => { s = String(s || "").trim(); if (!s || len > MAX_BODY) return; parts.push(s); len += s.length + 1; };
  for (const line of raw.split(/\r?\n/)) {
    if (len > MAX_BODY) break;
    if (!line) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (agent === "Codex") {
      const p = x.payload;
      if (x.type === "response_item" && p?.type === "message" && (p.role === "user" || p.role === "assistant")) add(textOf(p.content));
      else if (x.type === "event_msg" && p?.type === "user_message") add(p.message);
      continue;
    }
    if (x.type === "custom-title") add(x.customTitle);
    else if (x.type === "ai-title") add(x.aiTitle);
    else if (x.type === "user" && !x.isMeta) add(textOf(x.message?.content));
    else if (x.type === "assistant") {
      for (const c of Array.isArray(x.message?.content) ? x.message.content : []) {
        if (c?.type === "text") add(c.text);
        else if (c?.type === "tool_use") add(toolLine(c));
      }
    }
  }
  return parts.join("\n");
}

function index(items) {
  let changed = 0;
  const wanted = new Set();
  const batch = [];
  for (const it of items) {
    wanted.add(it.key);
    let st; try { st = fs.statSync(it.file); } catch { continue; }
    const known = q.file.get(it.key);
    if (known && known.mtime === st.mtimeMs && known.size === st.size) continue;
    batch.push({ ...it, mtime: st.mtimeMs, size: st.size });
  }
  // Newest first, so a fresh install can search today's sessions soonest.
  batch.sort((a, b) => b.mtime - a.mtime);
  for (let i = 0; i < batch.length; i += 10) {
    const chunk = batch.slice(i, i + 10).map(it => ({ ...it, body: bodyOf(it.file, it.agent) }));
    db.exec("BEGIN");
    try {
      for (const it of chunk) {
        if (it.body === null) continue;
        q.dropDoc.run(it.key);
        q.putDoc.run(it.key, it.body);
        q.putFile.run(it.key, it.file, it.mtime, it.size);
        changed++;
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  // Sessions whose transcript is gone (deleted, or cleaned up by the agent) leave the index.
  for (const row of q.allFiles.all()) {
    if (!wanted.has(row.key) && !fs.existsSync(row.file)) { q.dropDoc.run(row.key); q.dropFile.run(row.key); }
  }
  return changed;
}

// Each word of three characters or more must occur (as a phrase, so FTS syntax in it means nothing).
function search(text, limit) {
  const words = String(text || "").trim().split(/\s+/).filter(w => [...w].length >= 3);
  if (!words.length) return [];
  const expr = words.map(w => `"${w.replace(/"/g, '""')}"`).join(" AND ");
  return q.search.all(expr, limit);
}

parentPort.on("message", m => {
  try {
    if (m.type === "index") parentPort.postMessage({ type: "indexed", changed: index(m.items), total: m.items.length });
    else if (m.type === "query") parentPort.postMessage({ type: "result", id: m.id, hits: search(m.q, m.limit || 200) });
  } catch (e) {
    parentPort.postMessage({ type: m.type === "query" ? "result" : "error", id: m.id, hits: [], message: e.message });
  }
});
