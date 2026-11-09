const fs = require("node:fs");
const path = require("node:path");

function databasePath(home, env = process.env) {
  const data = path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode");
  if (env.OPENCODE_DB === ":memory:") return ":memory:";
  return env.OPENCODE_DB ? path.resolve(data, env.OPENCODE_DB) : path.join(data, "opencode.db");
}

// null means the store is unavailable; [] is a successful, empty store.
// Never create or migrate the agent's database, and include committed WAL changes.
function readSessions(file) {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 1000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get()) {
      throw new Error('OpenCode 2 is required. Update OpenCode and let it migrate its database.');
    }
    return db.prepare(`SELECT id, directory, title, time_updated AS updated
      FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1000`).all();
  } finally {
    db.close();
  }
}

module.exports = { databasePath, readSessions };
