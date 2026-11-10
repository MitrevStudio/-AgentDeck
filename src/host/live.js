// Live status of running agent sessions.
//
// Claude Code registers every running session in ~/.claude/sessions/<pid>.json with its sessionId, cwd and
// status ("busy" while it works, "shell" while it runs a shell command - reported here as "busy" -, "waiting" while
// it is blocked on the user, with `waitingFor` saying on what, "idle" while it waits for input). A file can outlive
// its process (crash, kill) and Windows reuses PIDs, so an entry only counts when the PID is alive *and* was started at `procStart`.
// "busy" alone does not tell whether anything is still happening, so the newest write to the transcript or to
// one of its subagent transcripts is reported as `activityAt`.
// Its subagents (<transcript>/subagents/agent-*.jsonl, described by the .meta.json beside each) come along as
// `subagents`, newest first; one written to within SUBAGENT_ACTIVE_MS counts as working.
//
// A turn sent to the background (ctrl+b, Claude Code 2.1.3xx) runs in a "bg" process of its own: a fork of the session
// (--fork-session --resume <parent>: a transcript and sessionId of its own, `jobId`) that the interactive parent names in
// `parkedJobId`; a spare bg process (`spare`, no transcript) is kept ready beside it. The parent is the session the
// user sees, so a job's state and activity count for its parent and spares are left out (foldJobs).
//
// Codex's rollout lifecycle is read separately by codex-live.js and merged in host/index.js.
// OpenCode has no live status source here.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const REGISTRY_DIR = path.join(CLAUDE_HOME, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

const SUBAGENT_ACTIVE_MS = 30000;

const startVerified = new Map(); // `${pid}:${procStart}` -> boolean
const transcripts = new Map();   // sessionId -> transcript path
const subagentMeta = new Map();  // .meta.json path -> {type, description}

const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Process creation times in the formats Claude Code writes to `procStart`, pid -> [accepted values]: Windows FILETIME
// ticks; on Linux the start time from /proc/<pid>/stat (clock ticks since boot, what current versions write) and,
// on Linux and macOS, the text of `ps -o lstart=` (LC_ALL=C, TZ=UTC), as older versions wrote it.
function procStatStart(pid) {
  try {
    // Fields after the command name, which is in parentheses and may hold spaces: starttime is field 22 of the line.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
  } catch { return null; }
}
function processStartTimes(pids) {
  if (!pids.length) return Promise.resolve(null);
  if (process.platform !== "win32") {
    return new Promise(resolve => {
      execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 8000 }, (err, stdout) => {
        const map = new Map();
        for (const line of String(stdout || "").split(/\r?\n/)) {
          const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (m) map.set(m[1], [m[2]]);
        }
        if (process.platform === "linux") {
          for (const pid of pids) {
            const ticks = procStatStart(pid);
            if (ticks) map.set(String(pid), [...(map.get(String(pid)) || []), ticks]);
          }
        }
        resolve(err && !map.size ? null : map);
      });
    });
  }
  const script = `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`;
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      resolve(new Map(String(stdout).trim().split(/\r?\n/).filter(Boolean).map(l => { const [pid, start] = l.trim().split(/\s+/); return [pid, [start]]; })));
    });
  });
}

async function verifyStarts(entries) {
  const todo = entries.filter(e => e.procStart && !startVerified.has(`${e.pid}:${e.procStart}`));
  if (!todo.length) return;
  const starts = await processStartTimes([...new Set(todo.map(e => e.pid))]);
  if (!starts) return; // cannot verify; fall back to the PID check alone
  for (const e of todo) startVerified.set(`${e.pid}:${e.procStart}`, (starts.get(String(e.pid)) || []).includes(String(e.procStart)));
}

// A Claude Code session's transcript, found by its id (remembered once found).
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

// What Claude Code wrote about a subagent when it started it (agentType, description); remembered once read, it does
// not change. A file not there yet, or still being written, is read again on the next poll.
const NO_META = Object.freeze({ type: "", description: "" });
function readSubagentMeta(file) {
  let meta = subagentMeta.get(file);
  if (!meta) {
    let m;
    try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return NO_META; }
    meta = { type: String(m?.agentType || ""), description: String(m?.description || "") };
    subagentMeta.set(file, meta);
  }
  return meta;
}
function listSubagents(dir, now) {
  let names;
  try { names = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  // The subagents gone from this folder are forgotten.
  const ids = new Set(names.map(f => f.slice(0, -".jsonl".length)));
  for (const file of subagentMeta.keys()) {
    if (path.dirname(file) === dir && !ids.has(path.basename(file, ".meta.json"))) subagentMeta.delete(file);
  }
  return names.map(f => {
    const id = f.slice(0, -".jsonl".length);
    const at = mtime(path.join(dir, f));
    return { id, at, working: now - at < SUBAGENT_ACTIVE_MS, ...readSubagentMeta(path.join(dir, `${id}.meta.json`)) };
  }).sort((a, b) => b.at - a.at);
}
// The newest write to the transcript or to a subagent's, and the subagents.
function getActivity(id) {
  const file = findTranscript(id);
  if (!file) return { at: 0, subagents: [] };
  const subagents = listSubagents(path.join(file.slice(0, -".jsonl".length), "subagents"), Date.now());
  return { at: Math.max(mtime(file), ...subagents.map(a => a.at)), subagents };
}

// Registry entries as the user sees them: spares gone, each background job folded into its parent (`jobs` on the
// parent); a job whose parent is gone stays on its own.
function foldJobs(entries) {
  const byJob = new Map(entries.filter(x => x.kind !== "bg" && x.parkedJobId).map(x => [x.parkedJobId, x]));
  const kept = [], jobs = new Map();
  for (const x of entries) {
    if (x.spare) continue;
    const parent = x.kind === "bg" && x.jobId ? byJob.get(x.jobId) : null;
    if (parent && parent !== x) {
      if (!jobs.has(parent.sessionId)) jobs.set(parent.sessionId, []);
      jobs.get(parent.sessionId).push(x);
    } else kept.push(x);
  }
  return kept.map(x => ({ ...x, jobs: jobs.get(x.sessionId) || [] }));
}
// The state shown for a session with background jobs: whatever needs the user first, else whatever works.
const STATUS_RANK = { waiting: 0, busy: 1, shell: 1 };
function leadingEntry(x) {
  return [x, ...(x.jobs || [])].reduce((best, e) => (STATUS_RANK[e.status] ?? 2) < (STATUS_RANK[best.status] ?? 2) ? e : best);
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
  return foldJobs(entries.filter(x => !x.procStart || startVerified.get(`${x.pid}:${x.procStart}`) !== false))
    .map(x => ({ x, lead: leadingEntry(x), activities: [x, ...x.jobs].map(e => getActivity(e.sessionId)) }))
    .map(({ x, lead, activities }) => ({
      agent: "Claude", id: x.sessionId, pid: x.pid, procStart: String(x.procStart || ""), cwd: x.cwd || "", name: x.name || "",
      status: lead.status === "shell" ? "busy" : lead.status || "running",
      waitingFor: lead.waitingFor || "",
      statusAt: lead.statusUpdatedAt || lead.updatedAt || lead.startedAt || 0,
      startedAt: x.startedAt || 0,
      activityAt: Math.max(...activities.map(a => a.at)),
      subagents: activities.flatMap(a => a.subagents).sort((a, b) => b.at - a.at),
      jobs: x.jobs.map(j => ({ id: j.sessionId, pid: j.pid, status: j.status === "shell" ? "busy" : j.status || "running" }))
    }));
}

async function liveSessions() {
  return claudeLive();
}

module.exports = { liveSessions, findTranscript, foldJobs, leadingEntry };
