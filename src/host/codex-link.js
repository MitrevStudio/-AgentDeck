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

// ---------- pruning ----------
// Codex writes its log and a log database into the folder for as long as it runs (megabytes a day), and a folder
// would otherwise stay forever once its terminal is gone. prune() removes whole folders, never one a terminal still
// points to: a running Codex has its files open, and a terminal a restart took is resumed by its log (readIdentity).
const FOLDER = new RegExp(`^${UUID}$`, "i");
const GRACE_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;
// The folder a codexLog lies in, by its name ("" when it is not a launch's folder).
function folderOf(codexLog) {
  const name = path.basename(path.dirname(String(codexLog || ""))).toLowerCase();
  return FOLDER.test(name) ? name : "";
}
// The logs of the terminals the host saved to find again after a restart (terminals.js, terminals-pty.js:
// <dataDir>/terminals/<id>.json). They count before the host has restored its terminals, and for those it could not
// attach or has yet to open anew. Throws when the entries cannot be read: nothing is pruned then.
async function savedLogs(dataDir) {
  const dir = path.join(dataDir, "terminals"), logs = [];
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === "ENOENT") return logs; throw e; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let text;
    try { text = await fs.promises.readFile(path.join(dir, name), "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    try { logs.push(JSON.parse(text).meta?.codexLog); } catch { /* not an entry: the restore drops it */ }
  }
  return logs;
}
// A folder's size and when anything in it was last written; null for what is not a folder (a link is not followed).
async function measure(dir) {
  const stat = await fs.promises.lstat(dir);
  if (!stat.isDirectory()) return null;
  let bytes = 0, mtimeMs = stat.mtimeMs;
  for (const name of await fs.promises.readdir(dir)) {
    const file = path.join(dir, name), s = await fs.promises.lstat(file);
    const inner = s.isDirectory() ? await measure(file) : { bytes: s.size, mtimeMs: s.mtimeMs };
    bytes += inner.bytes;
    mtimeMs = Math.max(mtimeMs, inner.mtimeMs);
  }
  return { bytes, mtimeMs };
}
// Removes the folders under <dataDir>/codex-links that no terminal needs any more. inUse: the codexLog of every
// terminal the host has now; those of its saved terminals are added here. Kept as well: a folder written to within
// graceMs (a launch whose terminal is not listed yet). Of the rest, those idle for maxAgeMs go, then the oldest until
// what is left takes no more than maxBytes. Only folders named as launchIdentity names them are looked at. A folder
// that cannot be removed (Windows: a file in it is still open) stays for the next time. -> the names removed.
async function prune(dataDir, { inUse = [], graceMs = GRACE_MS, maxAgeMs = MAX_AGE_MS, maxBytes = MAX_BYTES, now = Date.now() } = {}) {
  const root = path.join(dataDir, "codex-links"), removed = [], idle = [];
  let keep, names;
  try {
    keep = new Set([...inUse, ...await savedLogs(dataDir)].map(folderOf));
    names = await fs.promises.readdir(root);
  } catch { return removed; }
  for (const name of names) {
    if (!FOLDER.test(name) || keep.has(name.toLowerCase())) continue;
    try {
      const size = await measure(path.join(root, name));
      if (size && now - size.mtimeMs > graceMs) idle.push({ name, ...size });
    } catch { /* gone or changing meanwhile */ }
  }
  // Newest first: once the folders so far are over the limit, that one and every older one go.
  idle.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let bytes = 0;
  for (const folder of idle) {
    bytes += folder.bytes;
    if (now - folder.mtimeMs <= maxAgeMs && bytes <= maxBytes) continue;
    try {
      await fs.promises.rm(path.join(root, folder.name), { recursive: true });
      removed.push(folder.name);
    } catch { /* still open somewhere: the next time */ }
  }
  return removed;
}
module.exports = { launchIdentity, readIdentity, prune };
