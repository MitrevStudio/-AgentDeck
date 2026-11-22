// The TCP ports this computer listens on, for forwarding one of them to a paired computer (docs/PORT-FORWARDING.md,
// `ports.list`). Asked for when a menu opens, never polled: a call starts at most two child processes (machines with
// EDR make each one slow), and calls made while one is under way share its scan.
//
// listListening({ rootPid }) -> [{ port, address, pid, process, own }], one entry per port, `own` ones first, then by
// port. Nothing is left out by port number (the caller leaves out its own mesh port).
//   address  how the port is reached on loopback, the only place a forward connects to: "127.0.0.1" or "0.0.0.0" -
//            connect to 127.0.0.1; "::1" or "::" - IPv6 only, connect to ::1. A port on several addresses is reported
//            once, with the first of 127.0.0.1, 0.0.0.0, ::1, :: it has. A socket bound only to another address (a
//            LAN address, 127.0.0.53, a link-local one) cannot be reached through loopback and is not listed.
//   pid      the listening process, 0 when it is not known (another user's process on Linux without root, no `ss`).
//   process  its short name ("node", "com.docker.backend", "nginx"), "" when not known.
//   own      pid is rootPid or one of its descendants (a terminal's tree). Several processes on one port (nginx
//            workers, SO_REUSEPORT): an own one is the one reported.
// Never throws: [] when the sockets could not be listed, and that [] alone has `failed === true` (a property of the
// array, lost over JSON) for a caller that wants to tell "none" from "could not look".
//
// Windows: one `netstat -ano` (a listening row is the TCP row whose remote port is 0 - the state word is translated
//   on a non-English Windows). Names and parents from the Toolhelp process list in this process, through koffi, as
//   ../proc-stats.js does; where koffi is not installed (the headless host: host/package.json) one PowerShell
//   Win32_Process query instead.
// Linux: `ss -ltnpH`, which says whose each socket is; without `ss` (a slim container, the host's Alpine image)
//   /proc/net/tcp and tcp6, and the owner looked up by the socket's inode among the processes that may be looked
//   into. Names from /proc/<pid>/exe, parents from /proc/<pid>/stat, no child process.
// macOS: `lsof -nP -iTCP -sTCP:LISTEN -F pctn`, and one `ps` for parents and full names (lsof cuts a name short).
//
// The process tree is read here and not taken from ../proc-stats.js: the headless host ships only host/, src/host,
// src/mesh and src/shared, proc-stats.js needs koffi on Windows and reads no names, and here a pid -> parent map of
// one moment is all that is needed.
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TIMEOUT = 5000;
const RANK = ["127.0.0.1", "0.0.0.0", "::1", "::"];

// -> { err, stdout }; never rejects.
function run(file, args) {
  return new Promise(resolve => {
    const env = process.platform === "win32" ? process.env : { ...process.env, LC_ALL: "C" };
    try {
      execFile(file, args, { windowsHide: true, timeout: TIMEOUT, maxBuffer: 16 * 1048576, env }, (err, stdout) => resolve({ err, stdout: String(stdout || "") }));
    } catch (err) { resolve({ err, stdout: "" }); }
  });
}

// ---------- addresses ----------
// A local address as the tools print it -> one of RANK, or null when loopback does not reach it. `wildcard`: what a
// bare "*" stands for.
function loopback(text, wildcard = "0.0.0.0") {
  let a = String(text || "").trim();
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  if (a === "*") return wildcard;
  if (a.includes("%")) return null; // bound to an interface: 127.0.0.53%lo, fe80::1%lo0
  a = a.toLowerCase();
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice(7);
  return RANK.includes(a) ? a : null;
}
// "address:port" -> [address, port]; the port is after the last colon ("[::1]:80", ":::22", "*:80").
function splitPort(text) {
  const at = String(text).lastIndexOf(":");
  const port = at < 0 ? NaN : Number(text.slice(at + 1));
  return Number.isInteger(port) && port > 0 && port < 65536 ? [text.slice(0, at), port] : null;
}
// "C:\x\Node.exe", "/usr/sbin/nginx" -> "Node", "nginx".
function shortName(name) {
  return String(name || "").trim().split(/[\\/]/).pop().replace(/\.exe$/i, "");
}

// ---------- parsers: text -> [{ port, address, pid, name }] ----------
// netstat -ano:  "  TCP    0.0.0.0:135    0.0.0.0:0    LISTENING    1234", "  TCP    [::1]:5432    [::]:0    LISTENING    5".
function parseNetstat(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[0].toUpperCase() !== "TCP" || !/:0$/.test(f[2])) continue;
    const local = splitPort(f[1]), pid = Number(f[f.length - 1]);
    const address = local && loopback(local[0]);
    if (address) out.push({ port: local[1], address, pid: Number.isInteger(pid) ? pid : 0, name: "" });
  }
  return out;
}
// ss -ltnpH:  "LISTEN 0 511 *:3000 *:* users:(("node",pid=1234,fd=21))". "*" is a socket for both families (or, in
// an old ss, the IPv4 wildcard): 127.0.0.1 reaches it either way. A socket shared by several processes gives a row
// each; one without `users:` is another user's.
function parseSs(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "tcp") f.shift();
    if (f[0] !== "LISTEN" || f.length < 5) continue;
    const local = splitPort(f[3]);
    const address = local && loopback(local[0]);
    if (!address) continue;
    const users = [...line.matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)];
    if (!users.length) out.push({ port: local[1], address, pid: 0, name: "" });
    for (const u of users) out.push({ port: local[1], address, pid: Number(u[2]), name: shortName(u[1]) });
  }
  return out;
}
// lsof -F pctn: "p<pid>", "c<command>", then per socket "f<fd>", "t<IPv4|IPv6>", "n<address>:<port>".
function parseLsof(text) {
  const out = [];
  let pid = 0, name = "", type = "";
  for (const line of String(text || "").split(/\r?\n/)) {
    const value = line.slice(1);
    if (line[0] === "p") { pid = Number(value) || 0; name = ""; type = ""; }
    else if (line[0] === "c") name = shortName(value);
    else if (line[0] === "f") type = "";
    else if (line[0] === "t") type = value;
    else if (line[0] === "n") {
      const local = splitPort(value.split("->")[0]);
      const address = local && loopback(local[0], type === "IPv6" ? "::" : "0.0.0.0");
      if (address) out.push({ port: local[1], address, pid, name });
    }
  }
  return out;
}
// /proc/net/tcp and tcp6: "   0: 0100007F:1F90 00000000:0000 0A ..." - state 0A is LISTEN, the address is the
// bytes of the network order read as 32-bit words of this machine (little-endian taken for granted). The tenth
// field is the socket's inode, by which linuxOwners finds its process.
function parseProcNet(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3].toUpperCase() !== "0A") continue;
    const [hex, portHex] = f[1].split(":");
    const port = parseInt(portHex, 16);
    if (!(port > 0)) continue;
    let address = null;
    if (hex.length === 8) {
      address = loopback(hex.match(/../g).reverse().map(b => parseInt(b, 16)).join("."));
    } else if (hex.length === 32) {
      address = /^0+$/.test(hex) ? "::" : /^0{24}01000000$/.test(hex) ? "::1"
        : /^0{16}FFFF0000(0100007F|00000000)$/i.test(hex) ? (/7F$/i.test(hex) ? "127.0.0.1" : "0.0.0.0") : null;
    }
    if (address) out.push({ port, address, pid: 0, name: "", ...(/^[1-9]\d*$/.test(f[9] || "") ? { inode: f[9] } : {}) });
  }
  return out;
}
// "pid ppid name" rows (ps -axo pid=,ppid=,comm=) or "pid ppid start name" (the PowerShell query, `start` true) ->
// Map(pid -> { parent, name, start }). start: when the process began, in units that only compare; "" unknown.
function parseProcessRows(text, start = false) {
  const procs = new Map();
  const row = start ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/ : /^\s*(\d+)\s+(\d+)()\s*(.*)$/;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = row.exec(line);
    if (m) procs.set(Number(m[1]), { parent: Number(m[2]), name: shortName(m[4]), start: m[3] && m[3] !== "0" ? m[3] : "" });
  }
  return procs;
}

// ---------- processes: -> Map(pid -> { parent, name, start }) or null ----------
// Windows, in this process. PROCESSENTRY32W (64-bit): 568 bytes, th32ProcessID at 8, th32ParentProcessID at 32,
// szExeFile (260 UTF-16 units) at 44.
const TH32CS_SNAPPROCESS = 2, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ENTRY = 568, ENTRY_PID = 8, ENTRY_PARENT = 32, ENTRY_NAME = 44, ENTRY_NAME_BYTES = 520;
let api; // undefined: not tried yet; null: not available
function native() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) return api;
  try {
    const kernel32 = require("koffi").load("kernel32.dll");
    api = {
      snapshot: kernel32.func("intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)"),
      first: kernel32.func("bool __stdcall Process32FirstW(intptr_t snapshot, void *entry)"),
      next: kernel32.func("bool __stdcall Process32NextW(intptr_t snapshot, void *entry)"),
      open: kernel32.func("intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
      times: kernel32.func("bool __stdcall GetProcessTimes(intptr_t process, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)"),
      close: kernel32.func("bool __stdcall CloseHandle(intptr_t handle)")
    };
  } catch {} // not installed: the headless host
  return api;
}
function windowsNative(f) {
  const snapshot = f.snapshot(TH32CS_SNAPPROCESS, 0);
  if (Number(snapshot) === -1) return null;
  const procs = new Map(), entry = Buffer.alloc(ENTRY);
  try {
    entry.writeUInt32LE(ENTRY, 0);
    for (let ok = f.first(snapshot, entry); ok; ok = f.next(snapshot, entry)) {
      const pid = entry.readUInt32LE(ENTRY_PID);
      if (!pid) continue;
      const name = entry.toString("utf16le", ENTRY_NAME, ENTRY_NAME + ENTRY_NAME_BYTES);
      const end = name.indexOf("\0");
      procs.set(pid, { parent: entry.readUInt32LE(ENTRY_PARENT), name: shortName(end < 0 ? name : name.slice(0, end)), start: undefined });
    }
  } finally { f.close(snapshot); }
  return procs;
}
// When a process began (FILETIME, as text), "" when it may not be asked. Only the few processes of a tree are asked.
function windowsStart(f, pid) {
  const handle = f.open(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!Number(handle)) return "";
  try {
    const creation = [0], exit = [0], kernel = [0], user = [0];
    return f.times(handle, creation, exit, kernel, user) ? String(creation[0]) : "";
  } catch { return ""; } finally { f.close(handle); }
}
const POWERSHELL_QUERY = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { "
  + "\"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) $($_.Name)\" }";
async function windowsPowerShell() {
  const { err, stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY]);
  const procs = parseProcessRows(stdout, true);
  return !err && procs.size ? procs : null;
}
// /proc/<pid>/stat: "pid (name) state ppid ..."; the name may hold spaces and parentheses. A process whose parent
// ended is handed to another one at once, so a parent's pid is never a stale one and no start is needed.
function linuxProcs(dir = "/proc") {
  const procs = new Map();
  for (const entry of fs.readdirSync(dir)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`${dir}/${entry}/stat`, "utf8");
      const open = stat.indexOf("("), close = stat.lastIndexOf(")");
      procs.set(Number(entry), { parent: Number(stat.slice(close + 2).split(" ")[1]) || 0, name: shortName(stat.slice(open + 1, close)), start: "" });
    } catch {} // gone meanwhile
  }
  return procs.size ? procs : null;
}
// Whose sockets these are, without `ss`: a process holds a socket as /proc/<pid>/fd/<n> -> "socket:[inode]". Only
// the processes this one may look into (its user's; all of them as root with CAP_SYS_PTRACE) - the rest stay pid 0.
function linuxOwners(socks, dir = "/proc") {
  const wanted = new Map();
  for (const s of socks) if (s.inode && !s.pid) wanted.set(`socket:[${s.inode}]`, s);
  for (const entry of wanted.size ? fs.readdirSync(dir) : []) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try { fds = fs.readdirSync(`${dir}/${entry}/fd`); } catch { continue; } // another user's, or gone meanwhile
    for (const fd of fds) {
      let s;
      try { s = wanted.get(fs.readlinkSync(`${dir}/${entry}/fd/${fd}`)); } catch { continue; }
      if (!s) continue;
      s.pid = Number(entry);
      wanted.delete(`socket:[${s.inode}]`);
    }
    if (!wanted.size) break;
  }
}
// The program a process runs: /proc/<pid>/exe, not its `comm` - a thread may rename that (Node 24 calls its main
// thread "MainThread", which is what `ss` and /proc/<pid>/stat then say). "" for a process that may not be asked.
function linuxExe(pid, dir = "/proc") {
  try { return shortName(fs.readlinkSync(`${dir}/${pid}/exe`).replace(/ \(deleted\)$/, "")); } catch { return ""; }
}

// ---------- one scan: -> { socks: [{ port, address, pid, name }] or null, procs: Map or null, startOf } ----------
const noStart = () => "";
async function scanWindows() {
  const netstat = run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "netstat.exe"), ["-ano"]);
  const f = native();
  let procs = null, startOf = noStart;
  if (f) {
    try { procs = windowsNative(f); } catch {}
    startOf = pid => windowsStart(f, pid);
  }
  if (!procs) procs = await windowsPowerShell();
  const { err, stdout } = await netstat;
  const socks = parseNetstat(stdout);
  return { socks: err && !socks.length ? null : socks, procs, startOf };
}
async function scanLinux() {
  let socks = null;
  const { err, stdout } = await run("ss", ["-ltnpH"]);
  if (!err) socks = parseSs(stdout);
  if (!socks) {
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try { socks = (socks || []).concat(parseProcNet(fs.readFileSync(file, "utf8"))); } catch {} // no IPv6: no tcp6
    }
    try { if (socks) linuxOwners(socks); } catch {}
  }
  let procs = null;
  try { procs = linuxProcs(); } catch {}
  for (const s of socks || []) if (s.pid) s.name = linuxExe(s.pid) || s.name;
  return { socks, procs, startOf: noStart };
}
async function scanMac() {
  const [lsof, ps] = await Promise.all([
    run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pctn"]),
    run("ps", ["-axo", "pid=,ppid=,comm="])
  ]);
  // lsof ends with 1 when nothing listens, and when it could not look into some process: what it printed counts.
  const socks = parseLsof(lsof.stdout);
  const procs = parseProcessRows(ps.stdout);
  return { socks: lsof.err && !socks.length && lsof.err.code !== 1 ? null : socks, procs: procs.size ? procs : null, startOf: noStart };
}
let flight = null;
function scan() {
  if (flight) return flight;
  const start = process.platform === "win32" ? scanWindows : process.platform === "linux" ? scanLinux : process.platform === "darwin" ? scanMac : null;
  flight = (start ? start() : Promise.resolve({ socks: null, procs: null, startOf: noStart }))
    .catch(() => ({ socks: null, procs: null, startOf: noStart }))
    .finally(() => { flight = null; });
  return flight;
}

// ---------- the answer ----------
// root and every process below it. Windows keeps a parent's pid in its children after the parent is gone and gives
// the pid out again: a process older than its "parent" is some other process's child (as in ../proc-stats.js).
function treeOf(root, procs, startOf = noStart) {
  const tree = new Set();
  if (!(root > 0)) return tree;
  tree.add(root);
  if (!procs || !procs.has(root)) return tree;
  const children = new Map();
  for (const [pid, p] of procs) {
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(pid);
  }
  const starts = new Map();
  const began = pid => {
    if (!starts.has(pid)) {
      let text = procs.get(pid).start;
      if (text === undefined) text = startOf(pid);
      let value = null;
      try { if (text) value = BigInt(text); } catch {}
      starts.set(pid, value);
    }
    return starts.get(pid);
  };
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const parentStart = began(queue[i]);
    for (const pid of children.get(queue[i]) || []) {
      if (tree.has(pid)) continue;
      const start = began(pid);
      if (parentStart !== null && start !== null && start < parentStart) continue;
      tree.add(pid);
      queue.push(pid);
    }
  }
  return tree;
}
// One entry per port out of the sockets: the address by RANK; the process an own one, else that of the best address.
function merge(socks, procs, rootPid, startOf) {
  const tree = treeOf(Number(rootPid) || 0, procs, startOf), ports = new Map();
  const better = (a, b) => (tree.has(a.pid) !== tree.has(b.pid) ? tree.has(a.pid) : !b.pid && a.pid ? true : !a.pid && b.pid ? false
    : RANK.indexOf(a.address) < RANK.indexOf(b.address));
  for (const s of socks) {
    const p = ports.get(s.port);
    if (!p) { ports.set(s.port, { address: s.address, by: s }); continue; }
    if (RANK.indexOf(s.address) < RANK.indexOf(p.address)) p.address = s.address;
    if (better(s, p.by)) p.by = s;
  }
  return [...ports].map(([port, { address, by }]) => ({
    port, address, pid: by.pid || 0, process: by.name || (by.pid && procs && procs.get(by.pid)?.name) || "", own: Boolean(by.pid) && tree.has(by.pid)
  })).sort((a, b) => (a.own === b.own ? a.port - b.port : a.own ? -1 : 1));
}

async function listListening({ rootPid } = {}) {
  try {
    const { socks, procs, startOf } = await scan();
    if (socks) return merge(socks, procs, rootPid, startOf);
  } catch {}
  return Object.defineProperty([], "failed", { value: true });
}

module.exports = {
  listListening,
  _test: { parseNetstat, parseSs, parseLsof, parseProcNet, parseProcessRows, loopback, shortName, treeOf, merge, windowsPowerShell, linuxProcs, linuxOwners, linuxExe }
};
