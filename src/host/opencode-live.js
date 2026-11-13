// OpenCode 2 keeps each session's turn times in its database (session_v2): time_busy is set when a turn starts,
// time_idle when it ends (idle_outcome: succeeded, failed, interrupted), so a session works while its last start is
// newer than its last end. Read only, as opencode-sessions.js reads the list. Taken from OpenCode 2.2.7: how its own
// code writes the two times, and the rows of finished sessions (a turn under way was not watched). Nothing
// there tells a session blocked on the user from a working one, so "waiting" is never reported. A session no turn was
// timed in (time_busy empty: made by an older release, or nothing sent yet) has no state to report, and neither has a
// database without these columns: the host lists the terminal as a stand-in then (host/index.js liveAgents).
//
// OpenCode's terminal is a client of its background service, so no process names its session. A session counts as
// running in the terminal AgentDeck started it in - the id is given at the launch (opencode-link.js, launch.js) - for
// as long as that terminal runs; any other session only while it works and was written to lately. A session the user
// switches to inside OpenCode's own interface is not followed.
// Its child sessions (parent_id) are its subagents, working by the same times.
const fs = require("node:fs");

const RECENT_MS = 10 * 60 * 1000;
// The windows, the tray and the peers each ask every few seconds: one read answers those that come together.
const KEEP_MS = 1000;
const MAX_SUBAGENTS = 50;

const isBusy = row => row.time_busy != null && (row.time_idle == null || row.time_idle < row.time_busy);

// -> { own, children, working }: the sessions of `ids`, their child sessions (newest first), and the top-level
// sessions that work and were written to since `since`. null when there is nothing to tell: no database, or one
// without the turn times. Never creates or migrates the agent's database.
function readLive(file, ids, since) {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    const cols = new Set(db.prepare("PRAGMA table_info(session_v2)").all().map(c => c.name));
    if (!cols.has("time_busy") || !cols.has("time_idle")) return null;
    const fields = `id, parent_id, directory, title, ${cols.has("agent") ? "agent" : "'' AS agent"}, time_created, time_updated, time_busy, time_idle`;
    const marks = ids.map(() => "?").join(",");
    return {
      own: ids.length ? db.prepare(`SELECT ${fields} FROM session_v2 WHERE id IN (${marks})`).all(...ids) : [],
      children: ids.length ? db.prepare(`SELECT ${fields} FROM session_v2 WHERE parent_id IN (${marks}) ORDER BY time_updated DESC LIMIT ${MAX_SUBAGENTS}`).all(...ids) : [],
      working: db.prepare(`SELECT ${fields} FROM session_v2 WHERE parent_id IS NULL AND time_busy IS NOT NULL
        AND (time_idle IS NULL OR time_idle < time_busy) AND max(time_updated, time_busy) >= ?`).all(since)
    };
  } finally {
    db.close();
  }
}

// dbFile: OpenCode's database (opencode-sessions.js databasePath); tabs(): the host's terminals.
function createOpenCodeLive({ dbFile, tabs = () => [], now = Date.now, read = readLive }) {
  let warned = "", last = null, lastAt = 0, lastFor = "";
  function poll() {
    const mine = tabs().filter(t => t.agent === "OpenCode" && t.sessionId && !t.exited);
    const byId = new Map(mine.map(t => [t.sessionId, t]));
    let found = null;
    try { found = read(dbFile, [...byId.keys()], now() - RECENT_MS); }
    catch (e) { if (e.message !== warned) console.warn("OpenCode live status failed:", warned = e.message); }
    if (!found) return [];
    const result = [];
    for (const row of found.own) {
      // No turn timed yet: nothing to report (the terminal's stand-in shows it).
      if (row.time_busy == null) continue;
      const tab = byId.get(row.id), busy = isBusy(row);
      result.push({
        agent: "OpenCode", id: row.id, cwd: row.directory || tab.cwd || "", pid: tab.pid || 0,
        status: busy ? "busy" : "idle", statusAt: busy ? row.time_busy : row.time_idle,
        activityAt: Math.max(row.time_updated || 0, row.time_busy), startedAt: tab.createdAt || row.time_created || 0,
        subagents: found.children.filter(c => c.parent_id === row.id)
          .map(c => ({ id: c.id, at: c.time_updated || 0, working: isBusy(c), type: c.agent || "", description: c.title || "" }))
      });
    }
    for (const row of found.working) {
      if (byId.has(row.id)) continue;
      result.push({
        agent: "OpenCode", id: row.id, cwd: row.directory || "", pid: 0, status: "busy", statusAt: row.time_busy,
        activityAt: Math.max(row.time_updated || 0, row.time_busy), startedAt: row.time_created || 0, subagents: []
      });
    }
    return result;
  }
  return async () => {
    const sig = tabs().filter(t => t.agent === "OpenCode" && t.sessionId && !t.exited).map(t => t.id + t.sessionId).join(",");
    if (!last || sig !== lastFor || now() - lastAt >= KEEP_MS) {
      last = poll(); lastAt = now(); lastFor = sig;
    }
    return last.map(l => ({ ...l, subagents: [...l.subagents] }));
  };
}

module.exports = { createOpenCodeLive, readLive, isBusy };
