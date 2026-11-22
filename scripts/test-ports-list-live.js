// The listening ports of this computer (src/host/ports.js) against real sockets, on whatever system this runs on:
// Windows asks netstat, Linux `ss` (and /proc/net/tcp* without it), macOS lsof. test-ports-list.js checks the parsers
// against fixed text; here the text is the system's own.
//
// Listeners are opened on every kind of address - 127.0.0.1, ::1, 0.0.0.0, :: for IPv6 only, :: for both families,
// 127.0.0.2 only, a network address only, one number on ::1 and on the network address - in this process, in a child,
// in a child of that child, and (Linux, as root) in a child that runs as another user. What listListening says of each
// is compared with what is true: the port is listed or not (a connection to 127.0.0.1 and to ::1 says which loopback
// reaches it), the address it reports is one a connection to gets through, the pid is the listener's, the name is the
// program's, `own` follows the root asked for (this process, the child, the child's child, an idle process, none).
//
// Linux, in processes of their own (src/host/ports.js decides once how it looks):
//   without `ss` (PATH emptied): /proc/net/tcp* and the owners by the sockets' inodes - the same answer as with it;
//   as another user (when this runs as root): the ports of root's processes - what a host that is not root sees of
//   the services of other users. Both are what ports.js documents ("pid 0 when it is not known").
//
// Every check runs; the ones that failed are listed at the end and the exit code is 1.
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile, execFileSync } = require("node:child_process");
const PORTS = path.join(__dirname, "..", "src", "host", "ports.js");
const { listListening, _test } = require(PORTS);

const LINUX = process.platform === "linux";
// What the system calls this program: "node" (ports.js shortName drops the folder and ".exe").
const NAME = _test.shortName(process.execPath);
const NOBODY = 65534;
const failures = [];
function check(fn, what) {
  try { fn(); } catch (e) {
    failures.push(what);
    const said = e.generatedMessage && "actual" in e ? `got ${JSON.stringify(e.actual)}, expected ${JSON.stringify(e.expected)}` : String(e.message).split("\n")[0];
    console.log(`  FAILED: ${what}: ${said}`);
  }
}

// ---------- sockets ----------
const listen = (host, port = 0, options = {}) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen({ port, host, ...options }, () => resolve(server));
});
// Does a connection to host:port get through from here?
const reaches = (host, port) => new Promise(resolve => {
  const socket = net.connect({ host, port });
  const say = yes => { socket.destroy(); resolve(yes); };
  socket.setTimeout(2000, () => say(false));
  socket.once("connect", () => say(true));
  socket.once("error", () => say(false));
});
// A network address of this computer (not loopback), "" when it has none.
function networkAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) return a.address;
  }
  return "";
}

// ---------- processes ----------
// A Node child that listens on `host` ("-": on nothing) and, with `grandHost`, starts a child of its own that listens
// there; it says { pid, port, grand: { pid, port } } and ends when its stdin does (so does its child: nothing is left
// behind when this test is killed).
const CHILD = `
const net = require("net"), { spawn } = require("child_process");
const [host, grandHost] = process.argv.slice(1);
const out = { pid: process.pid, port: 0, grand: null };
const say = () => console.log(JSON.stringify(out));
const grand = () => {
  if (!grandHost) return say();
  const g = spawn(process.execPath, ["-e", process.env.LIVE_CHILD, grandHost], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  g.stdout.once("data", d => { out.grand = JSON.parse(d); say(); });
};
if (host === "-") grand();
else { const s = net.createServer(); s.listen(0, host, () => { out.port = s.address().port; grand(); }); }
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
`;
const children = [];
const child = (host, grandHost = "", options = {}) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, ["-e", CHILD, host, ...(grandHost ? [grandHost] : [])],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, LIVE_CHILD: CHILD }, ...options });
  children.push(proc);
  proc.once("error", reject);
  proc.once("exit", code => reject(new Error(`the child ended (${code}) before it listened`)));
  proc.stdout.once("data", data => resolve(JSON.parse(data)));
});
// listListening in a process of its own: ports.js looks for `ss` through that process's PATH and reads /proc as its
// user. -> the list (with `failed` as a field, since JSON drops the array's property).
const listIn = (rootPid, options) => new Promise((resolve, reject) => {
  const code = `require(${JSON.stringify(PORTS)}).listListening({ rootPid: ${Number(rootPid) || 0} }).then(l => console.log(JSON.stringify({ list: l, failed: l.failed === true })))`;
  execFile(process.execPath, ["-e", code], { timeout: 30000, ...options }, (err, stdout, stderr) => {
    if (err) return reject(new Error(`${err.message}\n${stderr}`));
    try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error(`not a list: ${stdout}${stderr}`)); }
  });
});

// ---------- the comparison ----------
// listeners: [{ what, port, address: [what may be reported], pid, tree: the pids above it up to this process,
// hidden: its process cannot be looked into from here }].
// known: the pids and names can be read (false: /proc/net only, or another user's processes) - then pid 0, "" and
// nothing own. root: the rootPid asked for. full: false - only what the root changes (`own`) is compared.
function compare(label, list, listeners, absent, { known: all, root, full = true }) {
  const byPort = new Map(list.map(p => [p.port, p]));
  check(() => assert.equal(byPort.size, list.length), `${label}: one entry per port`);
  check(() => {
    const order = list.map(p => `${p.own ? 0 : 1}:${String(p.port).padStart(5, "0")}`);
    assert.deepEqual(order, [...order].sort());
  }, `${label}: own first, then by port`);
  check(() => {
    for (const p of list) {
      assert.deepEqual(Object.keys(p).sort(), ["address", "own", "pid", "port", "process"], JSON.stringify(p));
      assert.ok(["127.0.0.1", "0.0.0.0", "::1", "::"].includes(p.address) && Number.isInteger(p.pid) && p.pid >= 0 && typeof p.process === "string" && typeof p.own === "boolean", JSON.stringify(p));
    }
  }, `${label}: the shape of every entry`);
  for (const l of listeners) {
    const p = byPort.get(l.port), known = all && !l.hidden;
    check(() => assert.ok(p, `port ${l.port} is not in the list`), `${label}: ${l.what} is listed`);
    if (!p) continue;
    const own = known && l.tree.includes(root);
    check(() => assert.equal(p.own, own), `${label}: ${l.what}: own is ${own} under root ${root || "none"}`);
    if (!full) continue;
    check(() => assert.ok(l.address.includes(p.address), `reported ${p.address}, expected ${l.address.join(" or ")}`), `${label}: ${l.what}: the address`);
    check(() => assert.equal(p.pid, known ? l.pid : 0), `${label}: ${l.what}: the pid${known ? "" : " (not known: 0)"}`);
    check(() => assert.equal(p.process, known ? NAME : ""), `${label}: ${l.what}: the process name${known ? "" : " (not known: \"\")"}`);
  }
  if (full) for (const a of absent) check(() => assert.equal(byPort.has(a.port), false, JSON.stringify(byPort.get(a.port))), `${label}: ${a.what} is not listed`);
  return byPort;
}

async function main() {
  const servers = [], listeners = [], absent = [];
  const mine = [process.pid];
  // In this process. address: what ports.js may say; reach: the loopbacks a connection must get through on.
  const add = async (what, host, address, reach, options) => {
    let server;
    try { server = await listen(host, 0, options); } catch (e) { console.log(`  ${what}: cannot listen here (${e.code || e.message}), skipped`); return null; }
    servers.push(server);
    const l = { what, port: server.address().port, address, pid: process.pid, tree: mine, reach };
    listeners.push(l);
    return l;
  };
  await add("127.0.0.1 in this process", "127.0.0.1", ["127.0.0.1"], ["127.0.0.1"]);
  const six = await add("::1 in this process", "::1", ["::1"], ["::1"]);
  await add("0.0.0.0 in this process", "0.0.0.0", ["0.0.0.0"], ["127.0.0.1"]);
  if (six) {
    await add(":: for IPv6 only in this process", "::", ["::"], ["::1"], { ipv6Only: true });
    // Both families on one socket: 127.0.0.1 reaches it and ::1 does. ss prints "*" (-> 0.0.0.0), /proc/net/tcp6 the
    // zero address (-> ::), netstat a row for each family (-> 0.0.0.0).
    await add(":: for both families in this process", "::", ["0.0.0.0", "::"], ["127.0.0.1", "::1"]);
  } else console.log("  no IPv6 loopback here: the IPv6 listeners are skipped");

  // What loopback does not reach: not listed.
  const lan = networkAddress();
  const notListed = async (what, host) => {
    let server;
    try { server = await listen(host); } catch (e) { console.log(`  ${what}: cannot listen here (${e.code || e.message}), skipped`); return; }
    servers.push(server);
    absent.push({ what, port: server.address().port, host });
  };
  if (lan) await notListed(`the network address ${lan} only`, lan);
  else console.log("  no network address here: a listener on one only is skipped");
  await notListed("127.0.0.2 only", "127.0.0.2");
  // One number on ::1 and on the network address: listed, as ::1.
  if (six && lan) {
    const both = await add("::1 and the network address on one number", "::1", ["::1"], ["::1"]);
    try { servers.push(await listen(lan, both.port)); } catch (e) { console.log(`  ${lan}:${both.port} beside [::1]:${both.port}: ${e.code || e.message}, the pair is ::1 alone`); }
  }

  // In a child, and in a child of the child; a child that listens on nothing.
  const kid = await child("127.0.0.1", six ? "::" : "0.0.0.0"), idle = await child("-");
  listeners.push({ what: "127.0.0.1 in a child", port: kid.port, address: ["127.0.0.1"], pid: kid.pid, tree: [kid.pid, ...mine], reach: ["127.0.0.1"] });
  listeners.push({ what: `${six ? "::" : "0.0.0.0"} in a child's child`, port: kid.grand.port, address: six ? ["0.0.0.0", "::"] : ["0.0.0.0"], pid: kid.grand.pid, tree: [kid.grand.pid, kid.pid, ...mine], reach: six ? ["127.0.0.1", "::1"] : ["127.0.0.1"] });
  // Linux as root: a child that runs as another user. Root reads its pid and name all the same - where it may look
  // into other users' processes (CAP_SYS_PTRACE; root in a Docker container has it not, and gets pid 0 as anyone).
  const root = LINUX && process.getuid() === 0;
  if (root) {
    try {
      const other = await child("127.0.0.1", "", { uid: NOBODY, gid: NOBODY });
      let hidden = false;
      try { require("node:fs").readlinkSync(`/proc/${other.pid}/fd/0`); } catch { hidden = true; } // what ss does for each socket
      console.log(`  a child as uid ${NOBODY}: its sockets ${hidden ? "cannot be looked into from here (no CAP_SYS_PTRACE): pid 0 is what to expect" : "can be looked into from here"}`);
      listeners.push({ what: `127.0.0.1 in a child running as uid ${NOBODY}`, port: other.port, address: ["127.0.0.1"], pid: other.pid, tree: [other.pid, ...mine], reach: ["127.0.0.1"], hidden });
    } catch (e) { console.log(`  a child as uid ${NOBODY}: ${e.message.split("\n")[0]}, skipped`); }
  }

  // ---------- what is true, by connecting ----------
  for (const l of listeners) {
    for (const host of ["127.0.0.1", "::1"]) {
      if (host === "::1" && !six) continue;
      const got = await reaches(host, l.port), want = l.reach.includes(host);
      check(() => assert.equal(got, want), `the truth: ${l.what} (port ${l.port}) ${want ? "answers" : "does not answer"} on ${host}`);
    }
  }
  for (const a of absent) {
    const v4 = await reaches("127.0.0.1", a.port), v6 = six ? await reaches("::1", a.port) : false;
    check(() => assert.deepEqual([v4, v6], [false, false]), `the truth: ${a.what} (port ${a.port}) answers on no loopback`);
    const there = await reaches(a.host, a.port);
    check(() => assert.equal(there, true), `the truth: ${a.what} answers on ${a.host}`);
  }

  // ---------- as this process sees them ----------
  let ss = null;
  if (LINUX) try { ss = execFileSync("ss", ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() || "ss"; } catch (e) { ss = e.status ? `ss (exit ${e.status}: ${String(e.stderr || "").trim().split("\n")[0]})` : null; }
  const how = process.platform === "win32" ? "netstat -ano" : process.platform === "darwin" ? "lsof" : ss ? `ss -ltnpH (${ss})` : "/proc/net/tcp* (no ss)";
  // Whether `ss -ltnpH` itself works here (BusyBox has no ss; an ss that does not know an option ends with an error).
  let ssWorks = false;
  if (LINUX && ss) try { execFileSync("ss", ["-ltnpH"], { stdio: ["ignore", "pipe", "pipe"] }); ssWorks = true; } catch {}
  // Without ss too: the owners are found by the sockets' inodes among this user's processes (ports.js).
  const known = true;
  console.log(`  ${process.platform}, ${how}${LINUX ? `, uid ${process.getuid()}` : ""}; the program is "${NAME}"${LINUX ? `, its comm "${require("node:fs").readFileSync("/proc/self/comm", "utf8").trim()}"` : ""}`);

  const at = process.hrtime.bigint();
  const list = await listListening({ rootPid: process.pid });
  console.log(`  listListening: ${list.length} ports in ${(Number(process.hrtime.bigint() - at) / 1e6).toFixed(0)} ms`);
  check(() => assert.ok(!list.failed), "the sockets were listed (not failed)");
  const seen = compare("under this process", list, listeners, absent, { known, root: process.pid });
  for (const l of listeners) console.log(`    ${l.what}: ${JSON.stringify(seen.get(l.port) || null)}`);
  // The address reported is one a forward gets through on (it connects to 127.0.0.1 for the first two, ::1 for the rest).
  for (const l of listeners) {
    const p = seen.get(l.port);
    if (!p) continue;
    const target = p.address === "127.0.0.1" || p.address === "0.0.0.0" ? "127.0.0.1" : "::1";
    check(() => assert.ok(l.reach.includes(target)), `${l.what}: reported as ${p.address}, and ${target} reaches it`);
  }

  // Other roots, at once (one scan between them).
  const [underKid, underGrand, underIdle, none] = await Promise.all([
    listListening({ rootPid: kid.pid }), listListening({ rootPid: kid.grand.pid }), listListening({ rootPid: idle.pid }), listListening()
  ]);
  compare("under the child", underKid, listeners, absent, { known, root: kid.pid, full: false });
  compare("under the child's child", underGrand, listeners, absent, { known, root: kid.grand.pid, full: false });
  compare("under an idle process", underIdle, listeners, absent, { known, root: idle.pid, full: false });
  compare("with no root", none, listeners, absent, { known, root: 0, full: false });
  check(() => assert.equal(underIdle.some(p => p.own), false), "an idle process owns no port");
  check(() => assert.equal(none.some(p => p.own), false), "no root: nothing is own");

  // ---------- Linux: the other ways of looking ----------
  if (LINUX) {
    // Without ss: /proc/net/tcp*. A PATH with nothing in it, so `ss` is not found.
    try {
      const { list: bare, failed } = await listIn(process.pid, { env: { ...process.env, PATH: "/nonexistent" } });
      check(() => assert.equal(failed, false), "without ss: the sockets were listed (not failed)");
      const got = compare("without ss", bare, listeners, absent, { known: true, root: process.pid });
      console.log(`  without ss: ${bare.length} ports; e.g. ${JSON.stringify(got.get(listeners[0].port) || null)}`);
    } catch (e) { check(() => { throw e; }, "without ss: the list in a process of its own"); }
    // As another user: root's processes cannot be looked into.
    if (root) {
      const theirs = listeners.filter(l => !l.what.includes("running as uid"));
      for (const [label, env] of [["as another user", process.env], ["as another user, without ss", { ...process.env, PATH: "/nonexistent" }]]) {
        try {
          const { list: other, failed } = await listIn(process.pid, { uid: NOBODY, gid: NOBODY, env });
          check(() => assert.equal(failed, false), `${label}: the sockets were listed (not failed)`);
          const got = compare(label, other, theirs, absent, { known: false, root: process.pid });
          console.log(`  ${label}: ${other.length} ports; e.g. ${JSON.stringify(got.get(theirs[0].port) || null)}`);
        } catch (e) { check(() => { throw e; }, `${label}: the list in a process of its own`); }
      }
    } else console.log("  not root: the ports of another user's processes are not looked at (run this as root for that)");
    check(() => assert.equal(_test.linuxProcs().get(process.pid).parent, process.ppid), "/proc gives this process's parent");
  }

  for (const s of servers) s.close();
}

const watchdog = setTimeout(() => { console.error("the test did not finish in time"); for (const c of children) c.kill(); process.exit(1); }, 120000);
main().then(() => 0, e => { console.error(e); return 2; }).then(code => {
  clearTimeout(watchdog);
  for (const c of children) c.kill();
  const real = failures.filter(Boolean);
  if (real.length) console.log(`ports list, live: ${real.length} check(s) FAILED:\n${real.map(f => `  - ${f}`).join("\n")}`);
  else if (!code) console.log("ports list, live: all checks passed");
  process.exit(code || (real.length ? 1 : 0));
});
