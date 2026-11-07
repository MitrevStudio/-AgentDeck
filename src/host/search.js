// Full-text search over the sessions' conversations: main's side of search-worker.js, which owns the index
// (userData/search.db). index() is called after every scan and only re-reads transcripts that changed; query()
// answers the edge menu's search box.
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const QUERY_TIMEOUT_MS = 4000;

function createSearch({ dbFile }) {
  let worker = null, dead = false, seq = 0;
  const pending = new Map(); // id -> resolve

  function start() {
    if (worker || dead) return worker;
    worker = new Worker(path.join(__dirname, "search-worker.js"), { workerData: { dbFile } });
    worker.on("message", m => {
      if (m.type === "result") { pending.get(m.id)?.(m.hits || []); pending.delete(m.id); }
      else if (m.type === "error") console.error("Search index:", m.message);
    });
    worker.on("error", e => { console.error("Search worker failed:", e); dead = true; });
    worker.on("exit", () => { worker = null; for (const r of pending.values()) r([]); pending.clear(); });
    return worker;
  }

  return {
    // sessions: the scan's list; only those with a transcript file (Claude, Codex) can be indexed.
    index(sessions) {
      const items = (sessions || []).filter(s => s.file && (s.agent === "Claude" || s.agent === "Codex"))
        .map(s => ({ key: `${s.agent}:${s.id}`, file: s.file, agent: s.agent }));
      start()?.postMessage({ type: "index", items });
    },
    // -> [{key, snippet}]; the snippet marks the match with \u0002 ... \u0003.
    query(q) {
      const w = start();
      if (!w) return Promise.resolve([]);
      const id = ++seq;
      return new Promise(resolve => {
        pending.set(id, resolve);
        setTimeout(() => { if (pending.delete(id)) resolve([]); }, QUERY_TIMEOUT_MS);
        w.postMessage({ type: "query", id, q });
      });
    },
    stop() { worker?.terminate(); }
  };
}

module.exports = { createSearch };
