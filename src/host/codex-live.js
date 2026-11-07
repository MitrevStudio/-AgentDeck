// Codex records turn lifecycle events in its rollout, rather than Claude's PID registry.
// Read appended complete lines only. Never infer completion from a quiet reasoning period.
const fs = require('node:fs');
const { lineChunks } = require('./file-chunks');
const RECENT_MS = 10 * 60 * 1000;

function applyEvent(state, entry) {
  if (entry.type !== 'event_msg') return;
  const type = entry.payload?.type;
  if (type === 'task_started') state.status = 'busy';
  else if (['task_complete', 'task_completed', 'turn_aborted', 'shutdown'].includes(type)) state.status = 'idle';
  else return;
  state.statusAt = Date.parse(entry.timestamp) || 0;
}

function createCodexLive({ sessions, tabs = () => [], now = Date.now }) {
  const cache = new Map();
  let flight = null;
  async function poll() {
    const activeTabs = tabs().filter(t => t.agent === 'Codex' && t.sessionId && !t.exited);
    const byId = new Map(activeTabs.map(t => [t.sessionId, t]));
    const result = [], retained = new Set();
    for (const s of sessions().filter(s => s.agent === 'Codex' && s.file)) {
      let stat;
      try { stat = await fs.promises.stat(s.file); } catch { continue; }
      const tab = byId.get(s.id);
      // Without an owned terminal there is no reliable process lifetime. Ignore old orphaned rollouts.
      if (!tab && now() - stat.mtimeMs > RECENT_MS) continue;
      retained.add(s.file);
      let state = cache.get(s.file);
      if (!state || stat.size < state.offset || stat.ino !== state.ino || (stat.size === state.size && stat.mtimeMs !== state.mtime)) {
        state = { offset: 0, status: '', statusAt: 0, ino: stat.ino };
      }
      let handle;
      try {
        handle = await fs.promises.open(s.file, 'r');
        for await (const lines of lineChunks(handle, state.offset, stat.size)) {
          for (const line of lines.toString('utf8').split('\n')) {
            if (!line.includes('"event_msg"')) continue;
            try { applyEvent(state, JSON.parse(line)); } catch {}
          }
          state.offset += lines.length;
        }
      } catch { continue; }
      finally { await handle?.close(); }
      state.size = stat.size; state.mtime = stat.mtimeMs;
      cache.set(s.file, state);
      // An idle historical transcript is not evidence that its terminal is still open.
      if (!state.status || (!tab && state.status !== 'busy')) continue;
      result.push({ agent: 'Codex', id: s.id, cwd: s.cwd || '', pid: tab?.pid || 0,
        status: state.status, statusAt: state.statusAt, activityAt: stat.mtimeMs,
        startedAt: tab?.startedAt || state.statusAt, subagents: [] });
    }
    for (const file of cache.keys()) if (!retained.has(file)) cache.delete(file);
    return result;
  }
  return () => {
    if (!flight) flight = poll().finally(() => { flight = null; });
    return flight;
  };
}
module.exports = { createCodexLive, applyEvent };
