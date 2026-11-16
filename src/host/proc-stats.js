// CPU and memory of the agents' own processes - each session's main process, not its children: what the Agents lists
// show beside a row.
//
// attach(list, own) gives each entry whose `pid` is the agent's own process (own(entry)) the last figures measured for
// it (`proc: { cpu, mem, memShare }`) and asks for a new measurement once the last one is older than `interval`: a
// list is never held up by it, the figures come with the next one. cpu: the share of the whole computer (all its
// cores, as Task Manager counts it) since the measurement before, null on the first; mem: the working set in bytes;
// memShare: that as a share of the computer's memory.
//
// Windows: one PowerShell kept running while measurements are asked for (starting one each time would cost more than
// what it measures), reading a line of PIDs and writing a line per process, then "."; it ends after `idleMs` without a
// question. Linux: /proc. macOS: ps.
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");

// One line (the statements apart by ";"), so it goes as it is in -Command.
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "$ids = @($line -split ',' | Where-Object { $_ -match '^[0-9]+$' } | ForEach-Object { [int]$_ })",
  "if ($ids.Count) { foreach ($p in (Get-Process -Id $ids)) { $t = $p.TotalProcessorTime",
  "[Console]::Out.WriteLine(\"$($p.Id) $(if ($t) { [long]$t.TotalMilliseconds } else { -1 }) $($p.WorkingSet64)\") } }",
  "[Console]::Out.WriteLine('.')",
  "[Console]::Out.Flush() }"
].join("; ").replace(/\{; /g, "{ ");

// pid -> { cpuMs (processor time used so far, -1 when it cannot be read), mem (bytes) }
function createWindowsQuery({ idleMs = 60000, timeout = 15000 } = {}) {
  let child = null, buffer = "", pending = null, idleTimer = null;
  function finish(result) {
    const p = pending;
    pending = null;
    if (p) { clearTimeout(p.timer); p.resolve(result); }
  }
  function kill() {
    clearTimeout(idleTimer);
    if (child) { try { child.kill(); } catch {} }
    child = null;
    buffer = "";
    finish(null);
  }
  function ensure() {
    if (child) return child;
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const me = child;
    me.on("error", () => { if (child === me) kill(); });
    me.on("exit", () => { if (child === me) { child = null; buffer = ""; finish(null); } });
    me.stdout.setEncoding("utf8");
    me.stdout.on("data", chunk => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!pending) continue;
        if (line === ".") { finish(pending.map); continue; }
        const [pid, cpuMs, mem] = line.split(/\s+/).map(Number);
        if (pid > 0 && Number.isFinite(mem)) pending.map.set(pid, { cpuMs: Number.isFinite(cpuMs) ? cpuMs : -1, mem });
      }
    });
    me.stdin.on("error", () => {});
    return me;
  }
  function query(pids) {
    if (pending) return Promise.resolve(null);
    clearTimeout(idleTimer);
    return new Promise(resolve => {
      pending = { map: new Map(), resolve, timer: setTimeout(kill, timeout) };
      pending.timer.unref?.();
      try { ensure().stdin.write(pids.join(",") + "\n"); } catch { kill(); }
    }).then(result => {
      if (child) { idleTimer = setTimeout(kill, idleMs); idleTimer.unref?.(); }
      return result;
    });
  }
  return Object.assign(query, { stop: kill });
}

// Linux: utime + stime (fields 14 and 15, in clock ticks - 100 a second on every kernel Node runs on) and VmRSS.
function linuxQuery(pids) {
  const map = new Map();
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = /VmRSS:\s*(\d+)\s*kB/.exec(status);
      map.set(pid, { cpuMs: (Number(f[11]) + Number(f[12])) * 10, mem: rss ? Number(rss[1]) * 1024 : 0 });
    } catch {}
  }
  return Promise.resolve(map);
}

// macOS: ps's cumulative time ([[dd-]hh:]mm:ss.cc) and resident size in KiB.
function psQuery(pids) {
  return new Promise(resolve => {
    execFile("ps", ["-o", "pid=,time=,rss=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" }, timeout: 8000 }, (err, stdout) => {
      const map = new Map();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\S+)\s+(\d+)/.exec(line);
        if (!m) continue;
        const [days, rest] = m[2].includes("-") ? m[2].split("-") : ["0", m[2]];
        const seconds = rest.split(":").reduce((a, x) => a * 60 + Number(x), 0) + Number(days) * 86400;
        map.set(Number(m[1]), { cpuMs: Number.isFinite(seconds) ? seconds * 1000 : -1, mem: Number(m[3]) * 1024 });
      }
      resolve(err && !map.size ? null : map);
    });
  });
}

function defaultQuery() {
  if (process.platform === "win32") return createWindowsQuery();
  return process.platform === "linux" ? linuxQuery : psQuery;
}

function createProcStats({ query = defaultQuery(), cores = () => os.cpus().length || 1, totalmem = os.totalmem, now = Date.now, interval = 5000 } = {}) {
  let last = new Map();   // pid -> { at, cpuMs, cpu, mem }
  let flight = null, lastAt = -Infinity;

  async function measure(pids) {
    lastAt = now();
    let result = null;
    try { result = await query(pids); } catch {}
    // Stamped once the figures are in: the first question also waits for PowerShell to start.
    const at = now();
    if (!result) return;
    const next = new Map(), n = Math.max(1, cores());
    for (const [pid, { cpuMs, mem }] of result) {
      const before = last.get(pid), wall = before ? at - before.at : 0;
      const ok = before && wall > 0 && cpuMs >= 0 && before.cpuMs >= 0 && cpuMs >= before.cpuMs;
      next.set(pid, { at, cpuMs, mem, cpu: ok ? Math.min(100, 100 * (cpuMs - before.cpuMs) / (wall * n)) : null });
    }
    last = next;
  }
  // Starts a measurement of these PIDs unless one is under way or the last is recent; resolves when it is done.
  function refresh(pids) {
    if (!flight && pids.length && now() - lastAt >= interval) flight = measure(pids).finally(() => { flight = null; });
    return flight || Promise.resolve();
  }
  function attach(list, own = () => true) {
    const mine = x => Number.isInteger(Number(x.pid)) && Number(x.pid) > 0 && own(x);
    refresh([...new Set(list.filter(mine).map(x => Number(x.pid)))]);
    const total = totalmem() || 0;
    return list.map(x => {
      const s = mine(x) && last.get(Number(x.pid));
      return s ? { ...x, proc: { cpu: s.cpu, mem: s.mem, memShare: total > 0 ? Math.min(100, 100 * s.mem / total) : null } } : x;
    });
  }
  return { attach, refresh, get: pid => last.get(pid) || null, stop: () => query.stop?.() };
}

module.exports = { createProcStats, createWindowsQuery, linuxQuery, psQuery };
