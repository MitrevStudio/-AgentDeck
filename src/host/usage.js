// Tokens and API-equivalent cost of the agents' sessions (Claude Code and Codex transcripts, OpenCode's database).
// The parsing runs on a worker thread (usage-worker.js) that keeps a per-file cache in userData, so the main
// process only passes messages: a refresh asked for while one runs is folded into one more pass afterwards.
// Each summary carries a version that changes only with its figures; onChange hears of new figures only.
const path = require("node:path");
const fs = require("node:fs");
const { Worker } = require("node:worker_threads");

let config = null, worker = null, current = null, running = null, again = false, settle = null, flushed = null;
let contextWatcher = null, contextTimer = null;

// claudeDir/codexDir: where main looks for sessions; openCodeDb: OpenCode's database; userData: for the cache;
// onChange(summary) after a pass that changed the figures.
function start(opts) {
  config = opts;
  contextWatcher?.close();
  const dir = path.join(config.userData, 'claude-context', 'sessions');
  try {
    fs.mkdirSync(dir, { recursive: true });
    require('./claude-context').prune(config.userData);
    contextWatcher = fs.watch(dir, (_event, name) => {
      if (name && !String(name).endsWith('.json')) return;
      clearTimeout(contextTimer);
      contextTimer = setTimeout(() => refresh().catch(err => console.error('Context refresh failed:', err.message)), 300);
    });
    contextWatcher.on('error', err => { console.warn('Context watcher failed:', err.message); contextWatcher?.close(); contextWatcher = null; });
  } catch (err) { console.warn('Context watcher unavailable:', err.message); }
  return refresh();
}

function spawn() {
  worker = new Worker(path.join(__dirname, "usage-worker.js"), {
    workerData: {
      cacheFile: path.join(config.userData, "usage-cache.json"),
      claudeDir: config.claudeDir, codexDir: config.codexDir, openCodeDb: config.openCodeDb
    }
  });
  worker.on("message", msg => {
    if (msg.type === "error") console.error("Usage scan failed:", msg.message);
    if (msg.type === "result" || msg.type === "error") settle?.(msg.summary || null);
    if (msg.type === "flushed") flushed?.();
  });
  // A crashed worker is started again by the next refresh; the cache on disk makes that cheap.
  worker.on("error", e => console.error("Usage worker failed:", e));
  worker.on("exit", () => { worker = null; settle?.(null); flushed?.(); });
}

function refresh() {
  if (!config) return Promise.resolve(current);
  if (running) { again = true; return running; }
  running = new Promise(resolve => {
    settle = resolve;
    if (!worker) spawn();
    worker.postMessage({ type: "scan" });
  }).then(summary => {
    settle = null;
    if (summary) {
      const changed = summary.version !== current?.version;
      current = summary;
      if (changed) config.onChange?.(summary);
    }
    return current;
  }).finally(() => {
    running = null;
    if (again) { again = false; refresh().catch(() => {}); }
  });
  return running;
}

// Quitting: what the worker has not written yet (it batches small passes) goes to disk first.
function flush() {
  clearTimeout(contextTimer);
  contextWatcher?.close(); contextWatcher = null;
  if (!worker) return Promise.resolve();
  return new Promise(resolve => {
    flushed = () => { flushed = null; resolve(); };
    worker.postMessage({ type: "flush" });
  });
}

module.exports = { start, refresh, flush, get: () => current };
