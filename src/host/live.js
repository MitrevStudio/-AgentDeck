// Live status of running agent sessions.
//
// Claude Code registers every running session in ~/.claude/sessions/<pid>.json with its sessionId, cwd and
// status ("busy" while it works, "waiting" while it is blocked on the user, with `waitingFor` saying on what, "idle"
// while it waits for input, "shell" while it waits for input with a background shell still running - see getStatus).
// A file can outlive its process (crash, kill) and Windows reuses PIDs, so an entry only counts when the PID is alive *and* was started at `procStart`.
// "busy" alone does not tell whether anything is still happening, so the newest write to the transcript or to
// one of its subagent transcripts is reported as `activityAt`.
// Its subagents (<transcript>/subagents/agent-*.jsonl, described by the .meta.json beside each) come along as
// `subagents`, newest first; one counts as working until it ended - by the mark Claude Code leaves in its .meta.json
// or by how its transcript ends - and by its last write only where neither can be read (isSubagentWorking).
//
// A turn sent to the background (ctrl+b, Claude Code 2.1.3xx) runs in a "bg" process of its own: a fork of the session
// (--fork-session --resume <parent>: a transcript and sessionId of its own, `jobId`) that the interactive parent names in
// `parkedJobId`; a spare bg process (`spare`, no transcript) is kept ready beside it. The parent is the session the
// user sees, so a job's state and activity count for its parent and spares are left out (foldJobs).
//
// A job whose parent is gone is listed on its own (`kind: "bg"`, its `jobId`).
//
// Codex's rollout lifecycle is read separately by codex-live.js, OpenCode's turn times by opencode-live.js; both are
// merged in host/index.js.
//
// The status is asked for every few seconds by many (the windows, the notifier, the tab links, the peers), in the
// process that also carries the terminals. So liveSessions() is one read they all share (shared-read.js: askers that
// come together get one read, { fresh: true } a new one), and that read waits for the disk nowhere: every file
// operation is asynchronous, a few at a time (FS_AT_ONCE). It also opens as little as it can: a registry file is read
// again only when its time or size changed (Claude Code writes it when the status changes, not in between), a
// subagent's description once, and a transcript that is not where its folder says is searched for only now and then.
// What is left for every read: the registry's listing, a stat per registry file, per transcript and per subagent, and
// the listing of each session's subagents.
// findTranscript() is the synchronous lookup for those who act once (a launch, a preview, the command centre);
// locateTranscript() is the same without waiting for the disk, for what runs on a timer.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createSharedRead } = require("./shared-read");

const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const REGISTRY_DIR = path.join(CLAUDE_HOME, "sessions");
const PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

// A subagent's state (isSubagentWorking): how long after its last write it counts as working when its transcript's end
// cannot be read; how long at most when the end says it has not finished (a tool call may run that long - past it, it
// crashed or was never marked as ended); how much of the transcript's end is read; and how much earlier than the
// transcript's last line the .meta.json that marks the end may have been written (seen: up to 0.1 s before, 3.4 s after).
const SUBAGENT_ACTIVE_MS = 30000;
const SUBAGENT_STALL_MS = 30 * 60 * 1000;
const SUBAGENT_TAIL_BYTES = 256 * 1024;
const META_SLACK_MS = 3000;
const FS_AT_ONCE = 8;
// A registry file written this shortly before it was read may be written again within the same tick of the file
// system's clock (FAT counts in 2 s), at the same size ("idle" -> "busy"): it is read again the next time.
const SETTLED_MS = 3000;
// A session's transcript that is not in the folder its cwd names is looked for in all of them this often.
const SEEK_MS = 5000;

const startVerified = new Map(); // `${pid}:${procStart}` -> boolean
const transcripts = new Map();   // sessionId -> transcript path
const subagentMeta = new Map();  // .meta.json path -> {type, description, ended, at}
const subagentEnds = new Map();  // subagent transcript path -> { at, size, end }: how it ended when it was last read
const registry = new Map();      // registry file name -> { mtimeMs, size, settled, x }: the entry as last parsed
const sought = new Map();        // sessionId -> when its transcript was last looked for in every project folder

// At most `max` of the operations given to it run at a time; the rest wait their turn.
function limiter(max) {
  let running = 0;
  const waiting = [];
  return async fn => {
    if (running < max) running++; else await new Promise(resolve => waiting.push(resolve));
    try { return await fn(); } finally {
      const next = waiting.shift();
      if (next) next(); else running--; // the next one takes this one's place
    }
  };
}
const io = limiter(FS_AT_ONCE);
// When a file was last written; -1 when it is not there.
const mtime = f => io(() => fs.promises.stat(f)).then(s => s.mtimeMs, () => -1);
// The same with its size: { at, size }, null when it is not there.
const stat = f => io(() => fs.promises.stat(f)).then(s => ({ at: s.mtimeMs, size: s.size }), () => null);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Process creation times in the formats Claude Code writes to `procStart`, pid -> [accepted values]: Windows FILETIME
// ticks; on Linux the start time from /proc/<pid>/stat (clock ticks since boot, what current versions write) and,
// on Linux and macOS, the text of `ps -o lstart=` (LC_ALL=C, TZ=UTC), as older versions wrote it.
async function procStatStart(pid) {
  try {
    // Fields after the command name, which is in parentheses and may hold spaces: starttime is field 22 of the line.
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
  } catch { return null; }
}
function processStartTimes(pids) {
  if (!pids.length) return Promise.resolve(null);
  if (process.platform !== "win32") {
    return new Promise(resolve => {
      execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 8000 }, async (err, stdout) => {
        const map = new Map();
        for (const line of String(stdout || "").split(/\r?\n/)) {
          const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (m) map.set(m[1], [m[2]]);
        }
        if (process.platform === "linux") {
          for (const pid of pids) {
            const ticks = await procStatStart(pid);
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

// A Claude Code session's transcript, found by its id (remembered once found). Synchronous: for those who ask once,
// on the user's action - nothing that runs on a timer (those: locateTranscript).
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
// The same without waiting for the disk, and with the time of the transcript's last write: { file, at } ("" and 0
// when there is none - a session nothing was sent to yet has no transcript, for as long as it stays so). Claude Code
// keeps a transcript in the folder named after the session's cwd (every other character than a letter or digit as
// "-"), so with the cwd that is one stat; all the folders are gone through only when it is not there (a session
// resumed from another folder), and at most every SEEK_MS a session.
async function transcriptOf(id, cwd = "") {
  const file = `${id}.jsonl`;
  const known = transcripts.get(id);
  const guess = cwd ? path.join(PROJECTS_DIR, String(cwd).replace(/[^a-z0-9]/gi, "-"), file) : "";
  for (const f of new Set([known, guess])) {
    const at = f ? await mtime(f) : -1;
    if (at >= 0) { transcripts.set(id, f); sought.delete(id); return { file: f, at }; }
  }
  if (Date.now() - (sought.get(id) || 0) < SEEK_MS) return { file: "", at: 0 };
  sought.set(id, Date.now());
  let dirs;
  try { dirs = await io(() => fs.promises.readdir(PROJECTS_DIR)); } catch { return { file: "", at: 0 }; }
  const ats = await Promise.all(dirs.map(d => mtime(path.join(PROJECTS_DIR, d, file))));
  const i = ats.findIndex(at => at >= 0);
  if (i < 0) return { file: "", at: 0 };
  const found = path.join(PROJECTS_DIR, dirs[i], file);
  transcripts.set(id, found);
  sought.delete(id);
  return { file: found, at: ats[i] };
}
const locateTranscript = async (id, cwd = "") => (await transcriptOf(id, cwd)).file;

// What Claude Code wrote about a subagent: when it started it (agentType, description) and, from 2.1.302 on, when it
// ended (`finished: true`, written within a few seconds of the transcript's last line; `stoppedByUser: true` in some
// versions when the user interrupted it). Remembered once read; read again only for a subagent that may still work,
// when the file's time changed (`at`: that time, 0 when it was not asked). A file not there yet, or still being
// written, is read again on the next poll.
const NO_META = Object.freeze({ type: "", description: "", ended: false, at: 0 });
async function readSubagentMeta(file, at = 0) {
  const had = subagentMeta.get(file);
  if (had && (!at || had.at === at)) return had;
  let m;
  try { m = JSON.parse(await io(() => fs.promises.readFile(file, "utf8"))); } catch { return had || NO_META; }
  const meta = { type: String(m?.agentType || ""), description: String(m?.description || ""), ended: m?.finished === true || m?.stoppedByUser === true, at };
  subagentMeta.set(file, meta);
  return meta;
}

// How a subagent's transcript ends, by its last line: "ended" - its turn is over (a last answer with nothing asked
// of a tool, the result of a tool that ends the turn, or the mark of the user's interruption); "open" - anything
// else: a tool was asked for and its result is awaited, a result came and the model's answer is awaited, a line of
// the request log; "unknown" - the last line could not be read (it is being written, it is longer than the piece
// read, it is not JSON). Only the file's end is read, SUBAGENT_TAIL_BYTES at most.
const INTERRUPTED = "[Request interrupted";
function subagentEndOf(entry) {
  const message = entry?.message, content = message?.content;
  const blocks = Array.isArray(content) ? content : [];
  if (entry?.type === "assistant") {
    const over = message?.stop_reason === "end_turn" || message?.stop_reason === "stop_sequence";
    return over && !blocks.some(b => b?.type === "tool_use") ? "ended" : "open";
  }
  if (entry?.type === "user") {
    const text = typeof content === "string" ? content : String(blocks.find(b => b?.type === "text")?.text || "");
    return entry.toolEndsTurn === true || text.startsWith(INTERRUPTED) ? "ended" : "open";
  }
  return entry && typeof entry === "object" ? "open" : "unknown";
}
async function readSubagentEnd(file, size) {
  const length = Math.min(size, SUBAGENT_TAIL_BYTES);
  if (!length) return "unknown";
  let text;
  try {
    text = await io(async () => {
      const handle = await fs.promises.open(file, "r");
      try { return (await handle.read(Buffer.alloc(length), 0, length, size - length)).buffer.toString("utf8"); } finally { await handle.close(); }
    });
  } catch { return "unknown"; }
  if (!text.endsWith("\n")) return "unknown"; // the last line is still being written
  const lines = text.trimEnd().split("\n");
  if (lines.length === 1 && length < size) return "unknown"; // it began before the piece that was read
  try { return subagentEndOf(JSON.parse(lines.at(-1))); } catch { return "unknown"; }
}
// Whether a subagent still works. Its last write alone does not tell: one that waits for a long tool call writes
// nothing for minutes, one that just gave its answer wrote a moment ago. So, in this order:
// - written to before its session's process started (`since`), or not for SUBAGENT_STALL_MS: not working - the first
//   is a subagent of a process that is gone, the second the limit that ends one that crashed or was never marked;
// - its .meta.json says it ended, and was written after the transcript's last line (a subagent continued later is
//   written to again, and its old mark does not count): not working;
// - else by its transcript's end: ended - not working; open - working; unknown - working if written to within
//   SUBAGENT_ACTIVE_MS, as before any of this was read.
// What was found is kept by the transcript's time and size, so the end is read again only when the file changed, the
// .meta.json is looked at only while the subagent may still work, and one past the limit costs nothing more.
async function isSubagentWorking(file, metaFile, s, now, since) {
  if (s.at < since || now - s.at >= SUBAGENT_STALL_MS) { subagentEnds.delete(file); return false; }
  let known = subagentEnds.get(file);
  if (known?.at !== s.at || known.size !== s.size) known = null;
  if (known?.end === "ended") return false;
  const metaAt = await mtime(metaFile);
  if (metaAt >= s.at - META_SLACK_MS && (await readSubagentMeta(metaFile, metaAt)).ended) {
    subagentEnds.set(file, { at: s.at, size: s.size, end: "ended" });
    return false;
  }
  if (!known) {
    known = { at: s.at, size: s.size, end: await readSubagentEnd(file, s.size) };
    subagentEnds.set(file, known);
  }
  if (known.end === "ended") return false;
  return known.end === "open" || now - s.at < SUBAGENT_ACTIVE_MS;
}
// since: when the session's process started.
async function listSubagents(dir, now, since = 0) {
  let names;
  try { names = (await io(() => fs.promises.readdir(dir))).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  // The subagents gone from this folder are forgotten.
  const ids = new Set(names.map(f => f.slice(0, -".jsonl".length)));
  for (const file of subagentMeta.keys()) {
    if (path.dirname(file) === dir && !ids.has(path.basename(file, ".meta.json"))) subagentMeta.delete(file);
  }
  for (const file of subagentEnds.keys()) {
    if (path.dirname(file) === dir && !ids.has(path.basename(file, ".jsonl"))) subagentEnds.delete(file);
  }
  const list = await Promise.all(names.map(async f => {
    const id = f.slice(0, -".jsonl".length), file = path.join(dir, f), metaFile = path.join(dir, `${id}.meta.json`);
    const [s, meta] = await Promise.all([stat(file), readSubagentMeta(metaFile)]);
    if (!s) return { id, at: 0, working: false, type: meta.type, description: meta.description }; // it went meanwhile
    const working = await isSubagentWorking(file, metaFile, s, now, since);
    // The description as it is now: the end's reading may have read the .meta.json anew.
    const { type, description } = subagentMeta.get(metaFile) || meta;
    return { id, at: s.at, working, type, description };
  }));
  return list.sort((a, b) => b.at - a.at);
}
// The newest write to the transcript or to a subagent's, and the subagents. since: when the session's process started.
async function getActivity(id, cwd, since = 0) {
  const { file, at } = await transcriptOf(id, cwd);
  if (!file) return { at: 0, subagents: [] };
  const subagents = await listSubagents(path.join(file.slice(0, -".jsonl".length), "subagents"), Date.now(), since);
  return { at: Math.max(at, ...subagents.map(a => a.at)), subagents };
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
const STATUS_RANK = { waiting: 0, busy: 1 };
function leadingEntry(x) {
  return [x, ...(x.jobs || [])].reduce((best, e) => (STATUS_RANK[getStatus(e)] ?? 2) < (STATUS_RANK[getStatus(best)] ?? 2) ? e : best);
}
// "shell": the session waits for the user, a run_in_background shell still running - idle. A ctrl+b job's "shell" is
// the parked work itself still running - busy.
function getStatus(e) {
  if (e.status !== "shell") return e.status || "running";
  return e.kind === "bg" ? "busy" : "idle";
}

// A registry file's entry (null when it cannot be read), parsed again only when the file changed. The parsed entry is
// kept as it is: nothing writes into it (foldJobs copies).
async function readEntry(name) {
  const file = path.join(REGISTRY_DIR, name);
  let stat;
  try { stat = await io(() => fs.promises.stat(file)); } catch { registry.delete(name); return null; }
  const seenAt = Date.now();
  const had = registry.get(name);
  if (had?.settled && had.mtimeMs === stat.mtimeMs && had.size === stat.size) return had.x;
  let x;
  try { x = JSON.parse(await io(() => fs.promises.readFile(file, "utf8"))); } catch { registry.delete(name); return null; }
  registry.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, settled: seenAt - stat.mtimeMs > SETTLED_MS, x });
  return x;
}

async function claudeLive() {
  let files;
  try { files = (await fs.promises.readdir(REGISTRY_DIR)).filter(f => /^\d+\.json$/.test(f)); } catch { return []; }
  const names = new Set(files);
  for (const name of registry.keys()) if (!names.has(name)) registry.delete(name);
  const entries = (await Promise.all(files.map(readEntry))).filter(x => x?.sessionId && Number.isInteger(x.pid) && pidAlive(x.pid));
  await verifyStarts(entries);
  const sessions = foldJobs(entries.filter(x => !x.procStart || startVerified.get(`${x.pid}:${x.procStart}`) !== false));
  const ids = new Set(sessions.flatMap(x => [x, ...x.jobs]).map(e => e.sessionId));
  for (const id of sought.keys()) if (!ids.has(id)) sought.delete(id);
  const read = await Promise.all(sessions.map(async x =>
    ({ x, lead: leadingEntry(x), activities: await Promise.all([x, ...x.jobs].map(e => getActivity(e.sessionId, e.cwd, Number(e.startedAt) || 0))) })));
  return read.map(({ x, lead, activities }) => ({
      agent: "Claude", id: x.sessionId, pid: x.pid, procStart: String(x.procStart || ""), cwd: x.cwd || "", name: x.name || "",
      // A background job left on its own (its parent gone): Claude Code's daemon restarts its process when it dies,
      // so it is stopped by `claude stop <jobId>` (launch.stopSession).
      kind: x.kind === "bg" ? "bg" : "", jobId: x.kind === "bg" ? String(x.jobId || "") : "",
      status: getStatus(lead),
      hasBackgroundShell: x.status === "shell",
      waitingFor: lead.waitingFor || "",
      statusAt: lead.statusUpdatedAt || lead.updatedAt || lead.startedAt || 0,
      startedAt: x.startedAt || 0,
      activityAt: Math.max(...activities.map(a => a.at)),
      subagents: activities.flatMap(a => a.subagents).sort((a, b) => b.at - a.at),
      jobs: x.jobs.map(j => ({ id: j.sessionId, pid: j.pid, status: getStatus(j) }))
    }));
}

// The Claude sessions running here: one read for all who ask (shared-read.js), each with a list of its own.
// liveSessions({ fresh: true }) for a caller that acts on the answer at once.
const liveSessions = createSharedRead(claudeLive);

// The id of every session a running Claude Code process holds: the sessions, their background jobs and the spare bg
// processes alike, and by the PID alone - for a caller that must never take a running session for a finished one
// (scratchpads.js), where a reused PID only makes a finished session count as running for a while. -> a Set.
async function liveIds() {
  let files;
  try { files = (await fs.promises.readdir(REGISTRY_DIR)).filter(f => /^\d+\.json$/.test(f)); } catch { return new Set(); }
  const ids = new Set();
  for (const f of files) {
    let x;
    try { x = JSON.parse(await fs.promises.readFile(path.join(REGISTRY_DIR, f), "utf8")); } catch { continue; }
    if (!Number.isInteger(x.pid) || !pidAlive(x.pid)) continue;
    for (const id of [x.sessionId, x.jobId, x.parkedJobId]) if (id) ids.add(String(id));
  }
  return ids;
}

module.exports = { liveSessions, liveIds, findTranscript, locateTranscript, foldJobs, leadingEntry, getStatus, subagentEndOf, SUBAGENT_ACTIVE_MS, SUBAGENT_STALL_MS, SUBAGENT_TAIL_BYTES };
