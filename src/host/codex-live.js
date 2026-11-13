// Codex records turn lifecycle events in its rollout, rather than Claude's PID registry.
// Read appended complete lines only. Never infer completion from a quiet reasoning period.
//
// A session in a terminal of the host's own is live for as long as that terminal runs. Codex writes the rollout when
// the first turn starts (0.167), so until then - and while a rollout holds no turn - there is no state to report: the
// host lists the terminal as a stand-in (host/index.js liveAgents).
// A session in no such terminal shows only while it works and its rollout was written to lately. The file's time
// does not tell that everywhere (Codex on Windows leaves it at the first write), so growth seen here counts as well,
// and the newest line's timestamp is the activity reported.
const fs = require('node:fs');
const { lineChunks } = require('./file-chunks');
const { readIdentity } = require('./codex-link');
const RECENT_MS = 10 * 60 * 1000;

function applyEvent(state, entry) {
  if (entry.type !== 'event_msg') return;
  const type = entry.payload?.type;
  if (type === 'task_started') state.status = 'busy';
  else if (['task_complete', 'task_completed', 'turn_aborted', 'shutdown'].includes(type)) state.status = 'idle';
  else return;
  state.statusAt = Date.parse(entry.timestamp) || 0;
}
// When the last complete line of a piece of the rollout was written, by its own timestamp (0 when it has none).
function lastLineAt(text) {
  const line = text.slice(text.lastIndexOf('\n', text.length - 2) + 1);
  return Date.parse(/"timestamp":"([^"]+)"/.exec(line.slice(0, 400))?.[1]) || 0;
}

function createCodexLive({ sessions, tabs = () => [], now = Date.now, link = () => {}, identify = readIdentity }) {
  const cache = new Map();
  const grown = new Map(); // rollout -> { size, at }: when it was last seen to grow (0: not since it is watched)
  let flight = null;
  async function poll() {
    const activeTabs = tabs().filter(t => t.agent === 'Codex' && !t.exited);
    for (const tab of activeTabs) {
      if (tab.sessionId || !tab.codexLog) continue;
      const id = await identify(tab.codexLog);
      if (id) { tab.sessionId = id; link(tab.id, 'Codex', id); }
    }
    const byId = new Map(activeTabs.map(t => [t.sessionId, t]));
    const result = [], retained = new Set(), files = new Set();
    for (const s of sessions().filter(s => s.agent === 'Codex' && s.file)) {
      files.add(s.file);
      let stat;
      try { stat = await fs.promises.stat(s.file); } catch { continue; }
      const tab = byId.get(s.id);
      const was = grown.get(s.file);
      const grownAt = was && was.size !== stat.size ? now() : was?.at || 0;
      grown.set(s.file, { size: stat.size, at: grownAt });
      const writtenAt = Math.max(stat.mtimeMs, grownAt);
      // Without an owned terminal there is no reliable process lifetime. Ignore old orphaned rollouts.
      if (!tab && now() - writtenAt > RECENT_MS) continue;
      retained.add(s.file);
      let state = cache.get(s.file);
      if (!state || stat.size < state.offset || stat.ino !== state.ino || (stat.size === state.size && stat.mtimeMs !== state.mtime)) {
        state = { offset: 0, status: '', statusAt: 0, lastAt: 0, ino: stat.ino };
      }
      let handle;
      try {
        handle = await fs.promises.open(s.file, 'r');
        for await (const lines of lineChunks(handle, state.offset, stat.size)) {
          const text = lines.toString('utf8');
          for (const line of text.split('\n')) {
            if (!line.includes('"event_msg"')) continue;
            try { applyEvent(state, JSON.parse(line)); } catch {}
          }
          state.lastAt = lastLineAt(text) || state.lastAt;
          state.offset += lines.length;
        }
      } catch { continue; }
      finally { await handle?.close(); }
      state.size = stat.size; state.mtime = stat.mtimeMs;
      cache.set(s.file, state);
      // An idle historical transcript is not evidence that its terminal is still open.
      if (!state.status || (!tab && state.status !== 'busy')) continue;
      result.push({ agent: 'Codex', id: s.id, cwd: s.cwd || '', pid: tab?.pid || 0,
        status: state.status, statusAt: state.statusAt, activityAt: Math.max(writtenAt, state.lastAt),
        startedAt: tab?.createdAt || state.statusAt, subagents: [] });
    }
    for (const file of cache.keys()) if (!retained.has(file)) cache.delete(file);
    for (const file of grown.keys()) if (!files.has(file)) grown.delete(file);
    return result;
  }
  return () => {
    if (!flight) flight = poll().finally(() => { flight = null; });
    return flight;
  };
}
module.exports = { createCodexLive, applyEvent };
