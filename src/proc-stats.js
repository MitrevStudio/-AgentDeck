// CPU and memory of the Claude sessions running on this computer: what the manager's Agents list shows at the end of
// a row. A figure covers the session's own process and every process it started (its MCP servers, the shells and
// builds of its tools) - the agent's own process alone says little while a build or a test run is what loads the
// computer.
//
// Local and on demand: main.js asks only for a manager window that is in view ("proc:get"), nothing is measured
// otherwise, and nothing of this is part of what the host publishes to peers and phones (host/index.js).
//
// read([{ key, pids }]) -> { [key]: { cpu, mem, memShare, procs } }: cpu - the share of the whole computer (all its
// cores, as Task Manager counts it) the processes took since the measurement before, null on the first; mem - their
// working sets added up, in bytes (memory they share is counted for each); memShare - that as a share of the
// computer's memory; procs - how many processes. Measured at most every `interval`; in between, the last figures.
// A process that started and ended between two measurements is not seen.
//
// Windows: the process list (Toolhelp) and each process's times and working set, in this process, through koffi -
// no helper process. Linux: /proc. macOS: one `ps`. A measurement that fails is tried again later and later
// (`interval` doubled each time, up to `maxBackoff`), never every few seconds.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

// ---------- Windows ----------
const TH32CS_SNAPPROCESS = 2, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
// PROCESSENTRY32W (x64): 568 bytes, th32ProcessID at 8, th32ParentProcessID at 32. PROCESS_MEMORY_COUNTERS: 72 bytes,
// WorkingSetSize at 16.
const ENTRY = 568, ENTRY_PID = 8, ENTRY_PARENT = 32, COUNTERS = 72, COUNTERS_WS = 16;

let api; // undefined: not loaded yet; null: not available
function native() {
  if (api !== undefined) return api;
  try {
    const kernel32 = require("koffi").load("kernel32.dll");
    api = {
      snapshot: kernel32.func("intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)"),
      first: kernel32.func("bool __stdcall Process32FirstW(intptr_t snapshot, void *entry)"),
      next: kernel32.func("bool __stdcall Process32NextW(intptr_t snapshot, void *entry)"),
      open: kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      times: kernel32.func("bool __stdcall GetProcessTimes(intptr_t process, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)"),
      memory: kernel32.func("bool __stdcall K32GetProcessMemoryInfo(intptr_t process, void *counters, uint32_t size)"),
      close: kernel32.func("bool __stdcall CloseHandle(intptr_t handle)")
    };
  } catch (e) {
    console.error("Process figures are not available:", e.message);
    api = null;
  }
  return api;
}

// pid -> [child pids], of every process running now.
function windowsChildren(f) {
  const snapshot = f.snapshot(TH32CS_SNAPPROCESS, 0);
  if (Number(snapshot) === -1) throw new Error("No process list");
  const children = new Map(), entry = Buffer.alloc(ENTRY);
  try {
    entry.writeUInt32LE(ENTRY, 0);
    for (let ok = f.first(snapshot, entry); ok; ok = f.next(snapshot, entry)) {
      const pid = entry.readUInt32LE(ENTRY_PID), parent = entry.readUInt32LE(ENTRY_PARENT);
      if (!pid) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pid);
    }
  } finally { f.close(snapshot); }
  return children;
}
// One process: { pid, start (FILETIME ticks, as text), cpuMs, mem }, or null when it is gone or may not be asked.
function windowsProcess(f, pid, counters) {
  const handle = f.open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!Number(handle)) return null;
  try {
    const creation = [0], exit = [0], kernel = [0], user = [0];
    if (!f.times(handle, creation, exit, kernel, user)) return null;
    counters.fill(0);
    counters.writeUInt32LE(COUNTERS, 0);
    const mem = f.memory(handle, counters, COUNTERS) ? Number(counters.readBigUInt64LE(COUNTERS_WS)) : 0;
    // Kernel and user time in 100 ns units.
    return { pid, start: String(creation[0]), cpuMs: Number((BigInt(kernel[0]) + BigInt(user[0])) / 10000n), mem };
  } finally { f.close(handle); }
}
function windowsQuery(roots) {
  const f = native();
  if (!f) return null;
  const children = windowsChildren(f), counters = Buffer.alloc(COUNTERS), trees = new Map();
  for (const root of roots) {
    const first = windowsProcess(f, root, counters);
    if (!first) continue;
    const tree = [first], seen = new Set([root]);
    for (let i = 0; i < tree.length; i++) {
      for (const pid of children.get(tree[i].pid) || []) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const p = windowsProcess(f, pid, counters);
        // Windows keeps a parent's PID in its children after the parent is gone, and gives the PID out again: a
        // process older than its "parent" is some other process's child.
        if (p && BigInt(p.start) >= BigInt(tree[i].start)) tree.push(p);
      }
    }
    trees.set(root, tree);
  }
  return trees;
}

// ---------- Linux ----------
// /proc/<pid>/stat after the command name (which is in parentheses and may hold spaces): ppid is field 4 of the
// line, utime and stime 14 and 15 (clock ticks - 100 a second on every kernel Node runs on), starttime 22. The
// memory is VmRSS of /proc/<pid>/status, read only for the processes that count.
function linuxQuery(roots, dir = "/proc") {
  const all = new Map(), children = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`${dir}/${name}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const pid = Number(name), parent = Number(f[1]);
      all.set(pid, { pid, start: f[19] || "", cpuMs: (Number(f[11]) + Number(f[12])) * 10, mem: 0 });
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pid);
    } catch {} // gone meanwhile
  }
  const rss = pid => {
    try { return Number(/VmRSS:\s*(\d+)\s*kB/.exec(fs.readFileSync(`${dir}/${pid}/status`, "utf8"))?.[1] || 0) * 1024; } catch { return 0; }
  };
  return walk(roots, all, children, p => ({ ...p, mem: rss(p.pid) }));
}

// ---------- macOS ----------
// ps's cumulative time ([[dd-]hh:]mm:ss.cc) and resident size in KiB, of every process.
function parsePs(text) {
  const all = new Map(), children = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const [days, rest] = m[3].includes("-") ? m[3].split("-") : ["0", m[3]];
    const seconds = rest.split(":").reduce((a, x) => a * 60 + Number(x), 0) + Number(days) * 86400;
    const pid = Number(m[1]), parent = Number(m[2]);
    all.set(pid, { pid, start: "", cpuMs: Number.isFinite(seconds) ? seconds * 1000 : 0, mem: Number(m[4]) * 1024 });
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  return { all, children };
}
function psQuery(roots) {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-axo", "pid=,ppid=,time=,rss="], { env: { ...process.env, LC_ALL: "C" }, timeout: 8000, maxBuffer: 8 * 1048576 }, (err, stdout) => {
      const { all, children } = parsePs(stdout);
      if (!all.size) return reject(err || new Error("ps listed nothing"));
      resolve(walk(roots, all, children));
    });
  });
}

// root -> its process and every descendant, out of all (pid -> process) and children (pid -> [pids]).
function walk(roots, all, children, each = p => p) {
  const trees = new Map();
  for (const root of roots) {
    if (!all.has(root)) continue;
    const pids = [root], seen = new Set(pids);
    for (let i = 0; i < pids.length; i++) {
      for (const pid of children.get(pids[i]) || []) if (!seen.has(pid) && all.has(pid)) { seen.add(pid); pids.push(pid); }
    }
    trees.set(root, pids.map(pid => each(all.get(pid))));
  }
  return trees;
}

// query(rootPids) -> Map(root -> [{ pid, start, cpuMs, mem }]: the root's process first, then its descendants), a
// root that is not running left out; null or a throw: could not measure. null here: nothing to measure with.
function defaultQuery() {
  if (process.platform === "win32") return windowsQuery;
  if (process.platform === "linux") return roots => linuxQuery(roots);
  return process.platform === "darwin" ? psQuery : null;
}

function createProcStats({ query = defaultQuery(), cores = () => os.cpus().length || 1, totalmem = os.totalmem, now = Date.now,
  interval = 2000, maxBackoff = 5 * 60 * 1000 } = {}) {
  let before = new Map();  // key -> { at, cpu: Map(pid -> { start, cpuMs }) }
  let figures = {}, flight = null, nextAt = -Infinity, failures = 0;
  const pick = sessions => Object.fromEntries(sessions.filter(s => figures[s.key]).map(s => [s.key, figures[s.key]]));

  async function measure(sessions) {
    const pidsOf = s => [...new Set((s.pids || []).map(Number).filter(pid => Number.isInteger(pid) && pid > 0))];
    let trees = null;
    try { trees = await query([...new Set(sessions.flatMap(pidsOf))]); } catch {}
    const at = now();
    if (!trees) {
      // Not again at once: a `ps` that is missing or blocked would otherwise be started every few seconds for good.
      failures++;
      nextAt = at + Math.min(maxBackoff, interval * 2 ** failures);
      before = new Map();
      figures = {};
      return;
    }
    failures = 0;
    nextAt = at + interval;
    const next = new Map(), out = {}, n = Math.max(1, cores()), total = totalmem() || 0;
    for (const s of sessions) {
      const procs = pidsOf(s).flatMap(pid => trees.get(pid) || []);
      if (!procs.length) continue;
      // Since the measurement before: what each process used more; all of it for a process started meanwhile. A
      // measurement long ago (the list was out of view) is no measure of now.
      const last = before.get(s.key), wall = last ? at - last.at : 0, fresh = last && wall > 0 && wall <= Math.max(30000, interval * 4);
      let used = 0, mem = 0;
      const cpu = new Map();
      for (const p of procs) {
        const was = fresh ? last.cpu.get(p.pid) : null;
        used += was && was.start === p.start ? Math.max(0, p.cpuMs - was.cpuMs) : fresh ? Math.min(p.cpuMs, wall * n) : 0;
        mem += p.mem;
        cpu.set(p.pid, { start: p.start, cpuMs: p.cpuMs });
      }
      next.set(s.key, { at, cpu });
      out[s.key] = { cpu: fresh ? Math.min(100, 100 * used / (wall * n)) : null, mem, memShare: total > 0 ? Math.min(100, 100 * mem / total) : null, procs: procs.length };
    }
    before = next;
    figures = out;
  }
  // The figures of these sessions: measured now unless they were a moment ago, a measurement is under way (its
  // figures then) or the last one failed and its wait is not over.
  async function read(sessions) {
    const list = Array.isArray(sessions) ? sessions : [];
    if (!query || !list.length) return {};
    if (!flight && now() >= nextAt) flight = measure(list).finally(() => { flight = null; });
    if (flight) await flight;
    return pick(list);
  }
  return { read, available: Boolean(query) };
}

// What the manager window is answered when it asks for its Agents rows' figures (main.js "proc:get"). wanted(): the
// setting is on and the window is in view - otherwise nothing is read and nothing measured, and the answer is null.
// sessions(): the Claude sessions running here (host/live.js): only theirs is the agent's own process - a Codex or
// OpenCode session's PID, and a stand-in's, is its terminal's. A turn sent to the background runs in a process of
// its own (`jobs`), which counts for its session. -> { "Claude:<id>": figures }.
function createSessionLoad({ sessions, wanted, stats = createProcStats() }) {
  return async function get() {
    if (!stats.available || !wanted()) return null;
    const live = (await sessions()).filter(l => l.agent === "Claude" && l.pid > 0);
    return stats.read(live.map(l => ({ key: `Claude:${l.id}`, pids: [l.pid, ...(l.jobs || []).map(j => j.pid)] })));
  };
}

module.exports = { createProcStats, createSessionLoad, windowsQuery, linuxQuery, psQuery, parsePs };
