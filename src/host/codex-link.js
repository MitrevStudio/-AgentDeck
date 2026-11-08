// A private log directory per launch ties a Codex thread to its terminal without guessing by cwd or time.
// log_dir is a Codex CLI config override; unknown log formats deliberately remain unlinked.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
function launchIdentity(dataDir) {
  const dir = path.join(dataDir, "codex-links", crypto.randomUUID());
  return { args: ["-c", `log_dir=${dir}`], codexLog: path.join(dir, "codex-tui.log") };
}
async function readIdentity(file) {
  if (!file) return "";
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytesRead).replace(/\x1b\[[0-9;]*m/g, "");
    // Only session lifecycle spans, never UUIDs in prompts, tool output or child-thread messages.
    const match = new RegExp(`(?:session_init|session_loop)\\{[^}\\r\\n]*?thread_id[=:]\\s*"?(${UUID})`, "i").exec(text);
    return match?.[1] || "";
  } catch { return ""; }
  finally { await handle?.close(); }
}
module.exports = { launchIdentity, readIdentity };
