// Live status of running agent sessions.
//
// Claude Code registers every running session in ~/.claude/sessions/<pid>.json with its sessionId, cwd and
// status ("busy" while it works, "idle" while it waits for input). A file can outlive its process (crash, kill)
// and Windows reuses PIDs, so an entry only counts when the PID is alive *and* was started at `procStart`.
// "busy" alone does not tell whether anything is still happening, so the newest write to the transcript or to
// one of its subagent transcripts is reported as `activityAt`.
//
// OpenCode and Codex keep no such registry, so they have no live status.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const REGISTRY_DIR = path.join(CLAUDE_HOME, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

const startVerified = new Map(); // `${pid}:${procStart}` -> boolean
const transcripts = new Map();   // sessionId -> transcript path

const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Process creation times as Windows FILETIME ticks, the format Claude Code writes to `procStart`.
function processStartTimes(pids) {
  if (process.platform !== "win32" || !pids.length) return Promise.resolve(null);
  const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`;
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      resolve(new Map(String(stdout).trim().split(/\r?\n/).filter(Boolean).map(l => l.trim().split(/\s+/))));
    });
  });
}

async function verifyStarts(entries) {
  const todo = entries.filter(e => e.procStart && !startVerified.has(`${e.pid}:${e.procStart}`));
  if (!todo.length) return;
  const starts = await processStartTimes([...new Set(todo.map(e => e.pid))]);
  if (!starts) return; // cannot verify; fall back to the PID check alone
  for (const e of todo) startVerified.set(`${e.pid}:${e.procStart}`, starts.get(String(e.pid)) === String(e.procStart));
}

function findTranscript(id) {
  const known = transcripts.get(id);
  if (known && fs.existsSync(known)) return known;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return ""; }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, `${id}.jsonl`);
    if (fs.existsSync(f)) { transcripts.set(id, f); return f; }
  }
  return "";
}

function lastActivity(id) {
  const file = findTranscript(id);
  if (!file) return 0;
  let t = mtime(file);
  const subagents = path.join(file.slice(0, -".jsonl".length), "subagents");
  try { for (const f of fs.readdirSync(subagents)) t = Math.max(t, mtime(path.join(subagents, f))); } catch {}
  return t;
}

async function claudeLive() {
  let files;
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const entries = [];
  for (const f of files) {
    let x;
    try { x = JSON.parse(fs.readFileSync(path.join(REGISTRY_DIR, f), "utf8")); } catch { continue; }
    if (x.sessionId && Number.isInteger(x.pid) && pidAlive(x.pid)) entries.push(x);
  }
  await verifyStarts(entries);
  return entries
    .filter(x => !x.procStart || startVerified.get(`${x.pid}:${x.procStart}`) !== false)
    .map(x => ({
      agent: "Claude", id: x.sessionId, pid: x.pid, cwd: x.cwd || "", name: x.name || "",
      status: x.status || "running",
      statusAt: x.statusUpdatedAt || x.updatedAt || x.startedAt || 0,
      startedAt: x.startedAt || 0,
      activityAt: lastActivity(x.sessionId)
    }));
}

async function liveSessions() {
  return claudeLive();
}

module.exports = { liveSessions };
