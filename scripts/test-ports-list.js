// The listening ports of this computer (src/host/ports.js): servers of this process on 127.0.0.1 and ::1 are listed
// with its pid and name and are `own` under it; a child's server is own under this process and not under another
// one; the parsers of netstat, ss, lsof and /proc/net/tcp against fixed outputs; what merges into one entry.
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { listListening, _test } = require("../src/host/ports");

const listen = host => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, host, () => resolve(server));
});
// A Node child that listens on 127.0.0.1 and says its port; `idle`: one that only waits.
const child = idle => new Promise((resolve, reject) => {
  const code = idle ? "console.log(0); setInterval(() => {}, 1000)"
    : "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => console.log(s.address().port)); setInterval(() => {}, 1000)";
  const proc = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  proc.once("error", reject);
  proc.stdout.once("data", data => resolve({ proc, port: Number(String(data).trim()) }));
});

function parsers() {
  const { parseNetstat, parseSs, parseLsof, parseProcNet, parseProcessRows, loopback, shortName, treeOf, merge } = _test;

  assert.equal(loopback("[::1]"), "::1");
  assert.equal(loopback("127.0.0.53%lo"), null);
  assert.equal(loopback("192.168.1.5"), null);
  assert.equal(loopback("::ffff:127.0.0.1"), "127.0.0.1");
  assert.equal(shortName("C:\\Program Files\\nodejs\\Node.EXE"), "Node");
  assert.equal(shortName("/Applications/Docker.app/Contents/MacOS/com.docker.backend"), "com.docker.backend");

  // Windows; the last listening row is of a German one. Connections and UDP are not listening sockets.
  assert.deepEqual(parseNetstat([
    "", "Active Connections", "", "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1284",
    "  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       5100",
    "  TCP    192.0.2.20:139         0.0.0.0:0              LISTENING       4",
    "  TCP    127.0.0.1:5432         127.0.0.1:61000        ESTABLISHED     5100",
    "  TCP    [::]:135               [::]:0                 LISTENING       1284",
    "  TCP    [::1]:3000             [::]:0                 LISTENING       7777",
    "  TCP    [fe80::1c2b%12]:3001   [::]:0                 LISTENING       7777",
    "  TCP    0.0.0.0:8080           0.0.0.0:0              ABH\u00d6REN         9000",
    "  UDP    0.0.0.0:5353           *:*                                    2200", ""
  ].join("\r\n")), [
    { port: 135, address: "0.0.0.0", pid: 1284, name: "" },
    { port: 5432, address: "127.0.0.1", pid: 5100, name: "" },
    { port: 135, address: "::", pid: 1284, name: "" },
    { port: 3000, address: "::1", pid: 7777, name: "" },
    { port: 8080, address: "0.0.0.0", pid: 9000, name: "" }
  ]);

  // Linux: ss.
  assert.deepEqual(parseSs([
    'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*    users:(("systemd-resolve",pid=701,fd=14))',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=900,fd=3))',
    'LISTEN 0      511                *:3000             *:*    users:(("node",pid=1234,fd=21))',
    'LISTEN 0      511          0.0.0.0:80         0.0.0.0:*    users:(("nginx",pid=1501,fd=6),("nginx",pid=1500,fd=6))',
    'LISTEN 0      128             [::]:22            [::]:*    users:(("sshd",pid=900,fd=4))',
    'LISTEN 0      4096           [::1]:631           [::]:*',
    'LISTEN 0      4096   192.0.2.60:9100       0.0.0.0:*    users:(("node_exporter",pid=77,fd=3))',
    'LISTEN 0      128               :::8443            :::*    users:(("java",pid=42,fd=9))', ""
  ].join("\n")), [
    { port: 22, address: "0.0.0.0", pid: 900, name: "sshd" },
    { port: 3000, address: "0.0.0.0", pid: 1234, name: "node" },
    { port: 80, address: "0.0.0.0", pid: 1501, name: "nginx" },
    { port: 80, address: "0.0.0.0", pid: 1500, name: "nginx" },
    { port: 22, address: "::", pid: 900, name: "sshd" },
    { port: 631, address: "::1", pid: 0, name: "" },
    { port: 8443, address: "::", pid: 42, name: "java" }
  ]);

  // macOS: lsof -F pctn.
  assert.deepEqual(parseLsof([
    "p412", "ccom.docke", "f21", "tIPv6", "n*:3000", "f22", "tIPv4", "n127.0.0.1:5432",
    "p900", "cpostgres", "f7", "tIPv6", "n[::1]:5432", "f8", "tIPv4", "n*:7000", "f9", "tIPv4", "n192.168.1.5:7001", ""
  ].join("\n")), [
    { port: 3000, address: "::", pid: 412, name: "com.docke" },
    { port: 5432, address: "127.0.0.1", pid: 412, name: "com.docke" },
    { port: 5432, address: "::1", pid: 900, name: "postgres" },
    { port: 7000, address: "0.0.0.0", pid: 900, name: "postgres" }
  ]);

  // Linux without ss: /proc/net/tcp and tcp6 (0A: listening; 01: a connection).
  assert.deepEqual(parseProcNet([
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0",
    "   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2345 1 0000000000000000 100 0 0 10 0",
    "   2: 3C0200C0:2394 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2346 1 0000000000000000 100 0 0 10 0",
    "   3: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 20 4 30 10 -1",
    "   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3345 1 0000000000000000 100 0 0 10 0",
    "   1: 00000000000000000000000001000000:0277 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3346 1 0000000000000000 100 0 0 10 0",
    "   2: 000080FE00000000FF2B2C1CFE1C2B1C:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3347 1 0000000000000000 100 0 0 10 0", ""
  ].join("\n")), [
    { port: 8080, address: "127.0.0.1", pid: 0, name: "", inode: "12345" },
    { port: 22, address: "0.0.0.0", pid: 0, name: "", inode: "2345" },
    { port: 3000, address: "::", pid: 0, name: "", inode: "3345" },
    { port: 631, address: "::1", pid: 0, name: "", inode: "3346" }
  ]);

  // Process rows: ps (the name is the rest of the line, a path with spaces) and the PowerShell query (with a start).
  const ps = parseProcessRows("    1     0 /sbin/launchd\n  412     1 /Applications/Docker.app/Contents/MacOS/com.docker.backend\n  900   412 /Applications/My App.app/Contents/MacOS/My App\n");
  assert.deepEqual([...ps], [
    [1, { parent: 0, name: "launchd", start: "" }],
    [412, { parent: 1, name: "com.docker.backend", start: "" }],
    [900, { parent: 412, name: "My App", start: "" }]
  ]);
  const win = parseProcessRows("0 0 0 System Idle Process\r\n4 0 134000000000000000 System\r\n5100 4 134000000000000500 postgres.exe\r\n", true);
  assert.deepEqual(win.get(0), { parent: 0, name: "System Idle Process", start: "" });
  assert.deepEqual(win.get(5100), { parent: 4, name: "postgres", start: "134000000000000500" });

  // A tree: the root and all below it; a process older than its "parent" (a pid given out again) is not its child.
  const procs = new Map([
    [10, { parent: 1, name: "shell", start: "100" }], [11, { parent: 10, name: "node", start: "200" }],
    [12, { parent: 11, name: "esbuild", start: "300" }], [13, { parent: 10, name: "old", start: "50" }],
    [14, { parent: 13, name: "under-old", start: "60" }], [20, { parent: 1, name: "other", start: "100" }]
  ]);
  assert.deepEqual([...treeOf(10, procs)].sort(), [10, 11, 12]);
  assert.deepEqual([...treeOf(99, procs)], [99], "a root that is not listed is still itself");
  assert.deepEqual([...treeOf(0, procs)], []);
  // Starts asked for only when a process has none of its own.
  const lazy = new Map([...procs].map(([pid, p]) => [pid, { ...p, start: undefined }]));
  assert.deepEqual([...treeOf(10, lazy, pid => procs.get(pid).start)].sort(), [10, 11, 12]);

  // One entry per port: the address by rank, an own process before another, own ports first, then by port.
  const merged = merge([
    { port: 9000, address: "::", pid: 20, name: "" },
    { port: 9000, address: "0.0.0.0", pid: 20, name: "" },
    { port: 5173, address: "::1", pid: 12, name: "" },
    { port: 80, address: "0.0.0.0", pid: 20, name: "nginx" },
    { port: 80, address: "0.0.0.0", pid: 11, name: "nginx" },
    { port: 631, address: "::1", pid: 0, name: "" },
    { port: 3000, address: "::", pid: 11, name: "" },
    { port: 3000, address: "127.0.0.1", pid: 11, name: "" }
  ], procs, 10);
  assert.deepEqual(merged, [
    { port: 80, address: "0.0.0.0", pid: 11, process: "nginx", own: true },
    { port: 3000, address: "127.0.0.1", pid: 11, process: "node", own: true },
    { port: 5173, address: "::1", pid: 12, process: "esbuild", own: true },
    { port: 631, address: "::1", pid: 0, process: "", own: false },
    { port: 9000, address: "0.0.0.0", pid: 20, process: "other", own: false }
  ]);
  assert.equal(merge([{ port: 1, address: "::1", pid: 5, name: "" }], null, 5)[0].own, true, "the root itself without a process list");
  console.log("  parsers, tree and merge: ok");
}

(async () => {
  parsers();

  const v4 = await listen("127.0.0.1");
  let v6 = null;
  try { v6 = await listen("::1"); } catch (e) { console.log(`  no IPv6 loopback here (${e.code || e.message}): that part is skipped`); }
  const listening = await child(false), idle = await child(true);
  try {
    const at = process.hrtime.bigint();
    const list = await listListening({ rootPid: process.pid });
    const ms = Number(process.hrtime.bigint() - at) / 1e6;
    console.log(`  listListening: ${list.length} ports in ${ms.toFixed(0)} ms (the first call, on ${process.platform})`);
    assert.ok(!list.failed, "the sockets were listed");

    const byPort = l => new Map(l.map(p => [p.port, p]));
    const mine = byPort(list);
    const a = mine.get(v4.address().port);
    assert.ok(a, "the IPv4 server is listed");
    assert.deepEqual({ address: a.address, pid: a.pid, own: a.own }, { address: "127.0.0.1", pid: process.pid, own: true });
    assert.ok(a.process, "its process has a name");
    console.log(`  127.0.0.1:${a.port} -> ${JSON.stringify(a)}`);
    if (v6) {
      const b = mine.get(v6.address().port);
      assert.ok(b, "the IPv6 server is listed");
      assert.deepEqual({ address: b.address, pid: b.pid, own: b.own, process: b.process }, { address: "::1", pid: process.pid, own: true, process: a.process });
      console.log(`  [::1]:${b.port} -> ${JSON.stringify(b)}`);
    }
    // The child's server: own under this process, not under a process beside it; this process's then are not either.
    const c = mine.get(listening.port);
    assert.ok(c, "the child's server is listed");
    assert.deepEqual({ pid: c.pid, own: c.own }, { pid: listening.proc.pid, own: true });
    assert.ok(c.process, "the child has a name");
    console.log(`  child 127.0.0.1:${c.port} -> ${JSON.stringify(c)}`);

    // Own first, then by port.
    const order = list.map(p => `${p.own ? 0 : 1}:${String(p.port).padStart(5, "0")}`);
    assert.deepEqual(order, [...order].sort(), "own first, then by port");
    assert.equal(new Set(list.map(p => p.port)).size, list.length, "one entry per port");
    for (const p of list) assert.ok(["127.0.0.1", "0.0.0.0", "::1", "::"].includes(p.address) && Number.isInteger(p.pid) && typeof p.process === "string");

    // Calls at the same moment share one scan and each has its own root.
    const t = process.hrtime.bigint();
    const [other, child2, none] = await Promise.all([
      listListening({ rootPid: idle.proc.pid }), listListening({ rootPid: listening.proc.pid }), listListening()
    ]);
    console.log(`  three calls at once: ${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms`);
    assert.equal(byPort(other).get(listening.port).own, false, "not own under an unrelated process");
    assert.equal(byPort(other).get(v4.address().port).own, false);
    assert.equal(other.some(p => p.own), false, "an idle process owns no port");
    assert.equal(byPort(child2).get(listening.port).own, true, "own under the child itself");
    assert.equal(byPort(child2).get(v4.address().port).own, false, "the parent's is not under the child");
    assert.equal(none.some(p => p.own), false, "no root: nothing is own");

    const names = list.filter(p => p.process).length;
    console.log(`  ${names} of ${list.length} ports with a process name; e.g. ${list.filter(p => !p.own).slice(0, 6).map(p => `${p.port}/${p.process || "?"}`).join(", ")}`);

    // Windows without koffi (the headless host): the PowerShell process list gives the same parents and names.
    if (process.platform === "win32") {
      const t2 = process.hrtime.bigint();
      const procs = await _test.windowsPowerShell();
      console.log(`  PowerShell process list (the fallback without koffi): ${procs ? procs.size : 0} processes in ${(Number(process.hrtime.bigint() - t2) / 1e6).toFixed(0)} ms`);
      assert.ok(procs, "the PowerShell query answered");
      assert.equal(procs.get(process.pid).parent, process.ppid);
      assert.equal(procs.get(process.pid).name, a.process);
      assert.ok(procs.get(process.pid).start, "with a start");
      assert.ok(_test.treeOf(process.pid, procs).has(listening.proc.pid), "the child is in the tree by that list too");
    }
    if (process.platform === "linux") assert.equal(_test.linuxProcs().get(process.pid).parent, process.ppid);
  } finally {
    listening.proc.kill();
    idle.proc.kill();
    v4.close();
    v6?.close();
  }
  console.log("ports list: all checks passed");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
