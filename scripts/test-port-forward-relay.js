// Forwarded ports through a relay, as in production (docs/PORT-FORWARDING.md): the viewer V and the computer H are not
// on one network, each has only a link to R - a relay-only node (createLinks relayOnly: true, kind "host") - and V's
// link to H is a tunnel through it (mesh/relay.js: pieces of at most 32 KB as "relay.data" calls, each awaited - end
// to end for what the tunnel's opener sends, leg by leg for what comes back to it, so the two directions differ in
// speed and the table says who opened the tunnel). D is a second viewer paired straight with H, for comparison. All
// in one process, on loopback.
//
// Latency: every mesh connection that is dialled goes through a small TCP proxy of this test (delayProxy), which holds
// the bytes of each direction for N ms and keeps their order: PH on H -> R, PV on V -> R, PD on D -> H. A node is paired
// with the proxy's port, so the link it then opens goes through it; the side that answered is made to forget where the
// caller is (hide), as behind a NAT, so it never dials back around the proxy. Each leg of the relay path gets half of
// the one-way delay and the direct link the whole of it: both paths then have the same round trip V <-> H, and the
// difference left is what the tunnel costs. Every measured transfer is also checked against the proxies' byte
// counters: the bytes really went that way.
//
// The traffic is a browser's, with Node's http client against 127.0.0.1:<the forward's port> and real servers on H's
// loopback: keep-alive (many requests on one connection), ten connections at once with bodies of mixed sizes, a large
// download and a large upload (each body checked by its SHA-256), a WebSocket (the handshake and the framing done by
// hand here: masked frames echoed, the server pushing on its own - a dev server's hot reload), Server-Sent Events that
// trickle (each event's delay measured; the client aborting closes the service's socket on H), requests while a large
// download runs (head of line: measured and printed), and the ways a connection ends: the service first, the client
// first, a half close, a client that just goes, a service that resets. Then the link to the relay drops in the middle
// of a download: the browser's connection is closed (not left hanging), the forward goes, the link comes back through
// the proxy by itself and a new forward works.
//
// Throughput (KB/s, download and upload, relay and direct) is measured at each latency and printed as a table at the
// end. Nothing tight is asserted of it - machines differ - only a floor far below anything that is not a stall.
// PF_RELAY_MB=<n>: megabytes of each measured transfer at every latency (default: 8 without latency, less with it,
// since the tunnel moves one piece per round trip). No mDNS, no Electron, no dependencies.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createPortForwards } = require("../src/port-forwards");

const MB = 1024 * 1024, KB = 1024;
const FORCED_MB = Number(process.env.PF_RELAY_MB) || 0;
// oneWay: ms from V to H as asked of the proxies (the round trip is twice that; what it comes to is measured and
// printed - timers are coarse, on Windows about 16 ms); bytes: the size of each measured transfer.
const CONFIGS = [
  { oneWay: 0, bytes: 8 * MB },
  { oneWay: 25, bytes: 2 * MB },
  { oneWay: 50, bytes: 1 * MB }
].map(c => (FORCED_MB ? { ...c, bytes: FORCED_MB * MB } : c));
const FLOOR_KBS = 20; // below this a transfer counts as stalled
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-port-forward-relay-"));
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (test, what, ms = 15000) => {
  for (const from = now(); now() - from < ms;) { if (test()) return; await sleep(10); }
  throw new Error(`timed out: ${what}`);
};
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const uuid = () => crypto.randomUUID();
const fails = code => e => e.code === code;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const ms = x => `${Math.round(x)} ms`;
const kbs = (bytes, took) => Math.round(bytes / KB / (took / 1000));
const passed = [];
const pass = line => { passed.push(line); console.log(`  ok  ${line}`); };

// ---------- the delay proxy ----------
// A TCP proxy to 127.0.0.1:target that holds what it reads for `delay` ms (changed while it runs) before it writes it
// on, each direction apart and in order: a piece never leaves before the one read before it. A FIN is passed on the
// same way; an error or a close of either side closes both. bytes[0]: from the dialler to the target, bytes[1]: back.
// drop(): every connection through it is cut (the listener stays).
function delayProxy(target) {
  const p = { delay: 0, bytes: [0, 0], accepted: 0, live: new Set(), port: 0, server: null };
  const lane = (from, to, dir, conn) => {
    const queue = []; // { due, chunk | null: the end }
    let timer = null, lastDue = 0;
    const put = item => (item ? to.write(item) : to.end());
    const drain = () => {
      timer = null;
      while (queue.length && queue[0].due <= now() + 0.5) put(queue.shift().chunk);
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].due - now()));
    };
    const take = chunk => {
      if (chunk) p.bytes[dir] += chunk.length;
      if (!p.delay && !queue.length) return void put(chunk);
      lastDue = Math.max(now() + p.delay, lastDue);
      queue.push({ due: lastDue, chunk });
      timer ||= setTimeout(drain, Math.max(0, queue[0].due - now()));
    };
    from.on("data", take);
    from.on("end", () => take(null));
    conn.stops.push(() => clearTimeout(timer));
  };
  p.server = net.createServer({ allowHalfOpen: true }, a => {
    p.accepted++;
    const b = net.connect({ host: "127.0.0.1", port: target, allowHalfOpen: true });
    const conn = { a, b, stops: [] };
    p.live.add(conn);
    const end = () => {
      if (!p.live.delete(conn)) return;
      for (const stop of conn.stops) stop();
      a.destroy(); b.destroy();
    };
    conn.end = end;
    for (const s of [a, b]) { s.setNoDelay(true); s.on("error", end); s.on("close", end); }
    lane(a, b, 0, conn);
    lane(b, a, 1, conn);
  });
  p.drop = () => { for (const conn of [...p.live]) conn.end(); };
  p.stop = () => { p.drop(); p.server.close(); };
  return new Promise((resolve, reject) => {
    p.server.once("error", reject);
    p.server.listen(0, "127.0.0.1", () => { p.port = p.server.address().port; resolve(p); });
  });
}

// ---------- what the services send ----------
// `size` bytes that depend on `seed`: both ends of a transfer make them here and compare hashes, so nothing has to
// be carried beside the body.
const BLOCK = crypto.randomBytes(MB);
function payload(seed, size) {
  const out = Buffer.allocUnsafe(size);
  for (let i = 0, off = (seed * 7919) % BLOCK.length; i < size; off = 0) i += BLOCK.copy(out, i, off, Math.min(BLOCK.length, off + size - i));
  if (size >= 4) out.writeUInt32BE(seed >>> 0, 0);
  return out;
}

// ---------- a WebSocket by hand (RFC 6455), as much of it as an echo and a push need ----------
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsAccept = key => crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
const WS = { TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };
// One unfragmented frame; masked: as a client must send it.
function wsFrame(op, data, masked) {
  const n = data.length, flag = masked ? 0x80 : 0;
  let head;
  if (n < 126) head = Buffer.from([0x80 | op, flag | n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = flag | 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = flag | 127; head.writeBigUInt64BE(BigInt(n), 2); }
  if (!masked) return Buffer.concat([head, data]);
  const key = crypto.randomBytes(4), body = Buffer.from(data);
  for (let i = 0; i < n; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}
// -> feed(chunk): calls onFrame(op, data: unmasked, masked) for every whole frame in what was fed so far.
function wsReader(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15, masked = Boolean(buf[1] & 0x80);
      let n = buf[1] & 127, at = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); at = 10; }
      const from = at + (masked ? 4 : 0);
      if (buf.length < from + n) return;
      const data = Buffer.from(buf.subarray(from, from + n));
      if (masked) for (let i = 0; i < n; i++) data[i] ^= buf[at + (i & 3)];
      buf = buf.subarray(from + n);
      onFrame(op, data, masked);
    }
  };
}

// ---------- TCP by hand, for the ways a connection ends ----------
const listen = onConnection => new Promise((resolve, reject) => {
  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server));
});
const dial = port => new Promise((resolve, reject) => {
  const s = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  s.once("error", reject);
  s.once("connect", () => { s.off("error", reject); s.on("error", () => {}); resolve(s); });
});
const closed = (s, what, within = 10000) => new Promise((resolve, reject) => {
  if (s.destroyed) return void resolve();
  const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), within);
  s.once("close", () => { clearTimeout(timer); resolve(); });
});
// Everything a socket gets until the other side ends.
const readAll = s => new Promise((resolve, reject) => {
  const parts = [];
  s.on("data", d => parts.push(d));
  s.once("end", () => resolve(Buffer.concat(parts)));
  s.once("close", () => reject(new Error("closed before its end")));
});

// ---------- the browser: one HTTP request ----------
// -> { status, headers, size, sha (of the body), text (a small body), ms (until the body's end), first (until its
// first byte) }. agent: false - a connection of its own, "Connection: close" (the service closes first). onFirst():
// the first byte of the body is here. onRequest(req): the request, for one that is aborted. Rejects when nothing ended within `timeout`: a stall is a failure, not a hang.
function ask(port, { method = "GET", path: url, body, agent = false, timeout = 60000, onFirst, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const from = now();
    let size = 0, first = 0;
    const small = [];
    const timer = setTimeout(() => req.destroy(new Error(`${method} ${url} did not end within ${timeout} ms (${size} bytes of the body came)`)), timeout);
    const fail = e => { clearTimeout(timer); reject(e); };
    const req = http.request({ host: "127.0.0.1", port, method, path: url, agent, headers: body ? { "content-length": body.length, "content-type": "application/octet-stream" } : {} }, res => {
      const hash = crypto.createHash("sha256");
      res.on("data", d => {
        if (!size) { first = now() - from; onFirst?.(); }
        size += d.length;
        hash.update(d);
        if (size <= 64 * KB) small.push(d);
      });
      res.on("error", fail);
      res.on("close", () => { if (!res.complete) fail(Object.assign(new Error(`${method} ${url}: closed after ${size} bytes, before the body's end`), { code: "cutShort" })); });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, size, sha: hash.digest("hex"), text: Buffer.concat(small).toString(), ms: now() - from, first });
      });
    });
    req.on("error", fail);
    onRequest?.(req);
    req.end(body);
  });
}

// What createServed needs of a host that has no terminals.
function makeHost() {
  return Object.assign(new EventEmitter(), {
    terminals: { getTabs: () => [] }, viewers: { leave() {}, state: () => null }, launch: {}, sendText: {}, git: {}, setup: {},
    sessions: { get: () => null, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } },
    home: os.homedir(), tabs: () => [], liveSessions: async () => []
  });
}

const stops = [];
async function main() {
  // ---------- the services on H's loopback ----------
  // One HTTP server, as a dev server is one:
  //   GET /bytes?seed&size[&chunked=1][&group&of]: payload(seed, size), with a Content-Length or chunked; with
  //     group/of the answer waits until `of` requests of that group are here - they are all open at the same time.
  //   POST /upload: { size, sha } of what came.   GET /sse?id&n&every: n events, one every `every` ms, each with the
  //   time it was written.   Upgrade /ws: a WebSocket that echoes binary frames and pushes a text frame every 200 ms.
  // "x-conn" on every answer: the number of the connection it came on.
  let conns = 0;
  const groups = new Map(); // group -> the answers that wait
  const sse = new Map();    // id -> { sent, closedAt }
  const wsServer = { masked: 0, unmasked: 0, open: 0 };
  const web = http.createServer((req, res) => {
    const url = new URL(req.url, "http://h"), q = url.searchParams;
    res.setHeader("x-conn", String(req.socket.conn));
    if (url.pathname === "/bytes") {
      const body = payload(Number(q.get("seed")), Number(q.get("size")));
      const send = () => {
        if (!q.get("chunked")) return void res.writeHead(200, { "content-length": body.length, "content-type": "application/octet-stream" }).end(body);
        res.writeHead(200, { "content-type": "application/octet-stream" });
        for (let i = 0; i < body.length; i += 48 * KB) res.write(body.subarray(i, i + 48 * KB));
        res.end();
      };
      const group = q.get("group");
      if (!group) return void send();
      if (!groups.has(group)) groups.set(group, []);
      const waiting = groups.get(group);
      waiting.push(send);
      if (waiting.length === Number(q.get("of"))) { groups.delete(group); for (const go of waiting) go(); }
    } else if (url.pathname === "/upload" && req.method === "POST") {
      const hash = crypto.createHash("sha256");
      let size = 0;
      req.on("data", d => { size += d.length; hash.update(d); });
      req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ size, sha: hash.digest("hex") })));
    } else if (url.pathname === "/sse") {
      const n = Number(q.get("n")), rec = { sent: 0, closedAt: 0 };
      sse.set(q.get("id"), rec);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.flushHeaders();
      const timer = setInterval(() => {
        res.write(`data: ${JSON.stringify({ i: rec.sent, t: now() })}\n\n`);
        if (++rec.sent >= n) { clearInterval(timer); res.end(); }
      }, Number(q.get("every")));
      res.on("close", () => { clearInterval(timer); rec.closedAt = now(); });
    } else res.writeHead(404).end();
  });
  web.on("connection", s => { s.conn = ++conns; s.setNoDelay(true); });
  web.on("upgrade", (req, socket) => {
    if (req.url !== "/ws" || !/websocket/i.test(req.headers.upgrade || "")) return void socket.destroy();
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${wsAccept(req.headers["sec-websocket-key"])}\r\n\r\n`);
    wsServer.open++;
    let n = 0;
    const push = setInterval(() => socket.write(wsFrame(WS.TEXT, Buffer.from(JSON.stringify({ type: "reload", n: n++, t: now() })), false)), 200);
    socket.on("error", () => {});
    socket.on("close", () => { clearInterval(push); wsServer.open--; });
    socket.on("data", wsReader((op, data, masked) => {
      wsServer[masked ? "masked" : "unmasked"]++;
      if (op === WS.BINARY) socket.write(wsFrame(WS.BINARY, data, false));
      else if (op === WS.PING) socket.write(wsFrame(WS.PONG, data, false));
      else if (op === WS.CLOSE) { clearInterval(push); socket.end(wsFrame(WS.CLOSE, data, false)); }
    }));
  });
  await new Promise((resolve, reject) => { web.once("error", reject); web.listen(0, "127.0.0.1", resolve); });
  // Plain TCP ones. A forward first looks whether its port answers on this machine (port-forwards.js) - and here it
  // does, the service being on the same one - so each service counts only the connections that sent it something.
  const banner = payload(99, 4 * KB);
  const bye = await listen(s => { s.on("error", () => {}); s.resume(); s.on("end", () => s.end()); s.end(banner); }); // says its piece and ends first
  const sum = await listen(s => { s.on("error", () => {}); readAll(s).then(all => s.end(sha(all)), () => {}); });    // answers once the client ended
  const held = [];
  const hold = await listen(s => {                                                                                    // waits for the client
    s.on("error", () => {});
    const rec = { socket: s, data: "", ended: false, closed: false };
    s.on("data", d => { if (!rec.data) held.push(rec); rec.data += d; });
    s.on("end", () => { rec.ended = true; s.end(); });
    s.on("close", () => { rec.closed = true; });
  });
  const reset = await listen(s => { s.on("error", () => {}); s.once("data", () => s.resetAndDestroy()); });
  stops.push(() => { web.closeAllConnections(); for (const s of [web, bye, sum, hold, reset]) s.close(); });
  const portOf = s => s.address().port;

  // ---------- the nodes, as in production ----------
  const node = (name, opts = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
    return createLinks({ dir, defaultName: name, kind: "desktop", version: "test", api: async () => null, discover: false, log: () => {}, ...opts });
  };
  const served = createServed({ host: makeHost() });
  const h = node("H", { api: (m, p, peer) => served.api(m, p, peer) });
  const r = node("R", { kind: "host", relayOnly: true }); // the VPS: installed relay-only
  const v = node("V"), d = node("D");
  stops.push(() => [h, r, v, d].forEach(l => l.stop()));
  const H = (await h.start()).id;
  served.attach(h);
  const R = (await r.start()).id, V = (await v.start()).id, D = (await d.start()).id;
  const PH = await delayProxy(r.self().port), PV = await delayProxy(r.self().port), PD = await delayProxy(h.self().port);
  stops.push(() => [PH, PV, PD].forEach(p => p.stop()));
  // The node that answered a pairing keeps where the caller came from and may dial it later (links.js connectAll) -
  // here that would be a connection around the proxy, which behind a NAT cannot be made. So it forgets the address.
  const hide = (answerer, caller) => answerer.peers().update(caller, { address: "", port: 0 });
  const linked = (a, b, idA, idB, what) => waitFor(() => a.online(idB) && b.online(idA), what);

  // H and V each dial the relay (through their proxy); one pairing a second from one address (pair-guard.js).
  await h.pair("127.0.0.1", PH.port, r.self().code);
  hide(r, H);
  await linked(h, r, H, R, "H linked to the relay");
  await sleep(1100);
  await v.pair("127.0.0.1", PV.port, r.self().code);
  hide(r, V);
  await linked(v, r, V, R, "V linked to the relay");
  // V knows H only as a route through R, and pairs with it end to end through the tunnel.
  await waitFor(() => v.discovered().some(n => n.id === H), "V sees H through the relay");
  await v.pair(H, 0, h.self().code);
  await linked(v, h, V, H, "V linked to H through the relay");
  // D: the same computer H on the same network, a link of its own (through its proxy), for the comparison.
  await d.pair("127.0.0.1", PD.port, h.self().code);
  hide(h, D);
  await linked(d, h, D, H, "D linked to H");
  await sleep(300); // the pairing connections are gone from the proxies

  const viaRelay = () => {
    const n = v.nodes().find(x => x.id === H);
    assert.deepEqual(n.via, [R], "V's link to H goes through R and nothing else");
    assert.deepEqual(h.nodes().find(x => x.id === V).via, [R], "H's link to V goes through R too");
    // (The side that answered shows 127.0.0.1 for the link: the tunnel's last hop into its own listener, relay.js.)
    assert.deepEqual([v.peers().get(H).address, v.peers().get(H).port], ["", 0], "V keeps no address of H: there is no other way to it");
    assert.deepEqual([h.peers().get(V).address, h.peers().get(V).port], ["", 0], "nor H of V");
    assert.equal(PV.live.size, 1, "V's one connection is the one to the relay, through its proxy");
    assert.equal(PH.live.size, 1, "H's one connection is the one to the relay, through its proxy");
  };
  // Which of the two opened the tunnel that their link is: the one that answered sees the tunnel's last hop, 127.0.0.1.
  // It matters for the speed: relay.js passes the opener's bytes on one piece per round trip end to end, the other
  // side's one piece per round trip of each leg.
  const opener = () => (v.nodes().find(x => x.id === H).address ? "H" : "V");
  viaRelay();
  assert.equal(opener(), "V", "V paired with H through the relay, and opened the tunnel");
  assert.equal(PD.live.size, 1, "D's link to H goes through its proxy");
  assert.equal(v.nodes().find(x => x.id === R).relayOnly, true, "R says it is a relay only");
  assert.equal(h.peers().get(R).control, false, "the relay may not control H");
  assert.equal(h.peers().get(V).control, true, "V may");
  await assert.rejects(v.call(R, "host.info"), fails("relayOnly"), "the relay serves no api");
  assert.equal((await v.call(H, "host.info")).ports, 1, "H says it forwards ports, through the relay");
  pass("topology: V and H each hold one connection, to the relay-only R; V's link to H is a tunnel through R; D is linked to H directly");

  const events = [];
  v.on("event", e => e.node === H && events.push(e));
  let lastChange = 0;
  for (const l of [v, h]) l.on("nodes", () => { lastChange = now(); });
  const fv = createPortForwards({ links: v }), fd = createPortForwards({ links: d });
  stops.push(() => { fv.dispose(); fd.dispose(); });
  await assert.rejects(fv.open(R, portOf(web)), fails("relayOnly"), "no forward to the relay itself");
  assert.deepEqual(fv.list(), []);
  // The forwards of V, made again after its link dropped (they go with the link).
  const ports = {};
  const openAll = async () => {
    for (const [name, server] of Object.entries({ web, bye, sum, hold, reset })) ports[name] = (await fv.open(H, portOf(server))).localPort;
  };
  await openAll();
  const direct = (await fd.open(H, portOf(web))).localPort;
  assert.notEqual(ports.web, portOf(web), "the service's number is taken on this machine: the forward has another");
  const quiet = () => waitFor(() => fv.list().every(f => !f.streams) && fd.list().every(f => !f.streams) && !served.ports.count(V) && !served.ports.count(D), "every stream went with its connection");
  const setLatency = oneWay => { PH.delay = PV.delay = oneWay / 2; PD.delay = oneWay; };
  // The round trip of one small request on the link, as it is now.
  const roundTrip = async (links, n = 5) => {
    const took = [];
    for (let i = 0; i < n; i++) { const from = now(); await links.call(H, "ports.close", { stream: uuid() }); took.push(now() - from); }
    return median(took);
  };
  // One measured transfer through a forward; the proxies named must have carried at least the body, in its direction.
  let seed = 1000;
  async function download(port, bytes, proxies, extra = {}) {
    const s = seed++, before = proxies.map(([p, dir]) => p.bytes[dir]);
    const got = await ask(port, { path: `/bytes?seed=${s}&size=${bytes}`, timeout: 120000, ...extra });
    assert.deepEqual([got.status, got.size], [200, bytes], "the whole body");
    assert.equal(got.sha, sha(payload(s, bytes)), "the same bytes, in order");
    proxies.forEach(([p, dir], i) => assert.ok(p.bytes[dir] - before[i] >= bytes, "the body went through the proxy"));
    return got;
  }
  async function upload(port, bytes, proxies) {
    const body = payload(seed++, bytes), before = proxies.map(([p, dir]) => p.bytes[dir]);
    const got = await ask(port, { method: "POST", path: "/upload", body, timeout: 120000 });
    assert.deepEqual(JSON.parse(got.text), { size: bytes, sha: sha(body) }, "the service got the same bytes, in order");
    proxies.forEach(([p, dir], i) => assert.ok(p.bytes[dir] - before[i] >= bytes, "the body went through the proxy"));
    return got;
  }
  // Towards V: H -> R is PH's direction 0 (H dialled), R -> V is PV's direction 1. Towards H: the other two.
  const DOWN_RELAY = [[PH, 0], [PV, 1]], UP_RELAY = [[PV, 0], [PH, 1]], DOWN_DIRECT = [[PD, 1]], UP_DIRECT = [[PD, 0]];
  // Server-Sent Events read as a browser's EventSource does: onEvent(data, req) for each, -> true when the service
  // ended the stream, false when it was cut (aborted here, or the connection closed).
  const events$ = (id, n, every, onEvent) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: ports.web, path: `/sse?id=${id}&n=${n}&every=${every}`, agent: false }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", part => {
        text += part;
        for (let at; (at = text.indexOf("\n\n")) >= 0; text = text.slice(at + 2)) onEvent(JSON.parse(text.slice(6, at)), req);
      });
      res.on("end", () => resolve(true));
      res.on("close", () => resolve(false));
    });
    req.on("error", e => (req.destroyed ? resolve(false) : reject(e)));
  });
  const small = (port, i, extra) => ask(port, { path: `/bytes?seed=${i}&size=${300 + i}`, ...extra });

  // Nothing forwarded: the service asked on its own port, for the scale of the table.
  setLatency(0);
  const table = [];
  {
    const down = await download(portOf(web), 8 * MB, []), up = await upload(portOf(web), 8 * MB, []);
    table.push({ latency: "-", path: "no forward", rtt: 0, bytes: 8 * MB, down: kbs(8 * MB, down.ms), up: kbs(8 * MB, up.ms) });
  }

  for (const { oneWay, bytes } of CONFIGS) {
    console.log(`\n--- ${oneWay} ms one way (${2 * oneWay} ms round trip) ---`);
    setLatency(oneWay);
    const rtt = { relay: await roundTrip(v), direct: await roundTrip(d) };
    console.log(`  round trip of one request: through the relay ${ms(rtt.relay)}, direct ${ms(rtt.direct)}`);
    assert.ok(rtt.relay >= 2 * oneWay * 0.9 && rtt.direct >= 2 * oneWay * 0.9, "the proxies hold the bytes at least that long");

    // ---------- throughput ----------
    for (const [name, port, links, downVia, upVia] of [["relay", ports.web, rtt.relay, DOWN_RELAY, UP_RELAY], ["direct", direct, rtt.direct, DOWN_DIRECT, UP_DIRECT]]) {
      const down = await download(port, bytes, downVia), up = await upload(port, bytes, upVia);
      const row = { latency: `${oneWay} ms`, path: name === "relay" ? `relay (${opener()} opened)` : name, rtt: links, bytes, down: kbs(bytes, down.ms), up: kbs(bytes, up.ms) };
      table.push(row);
      assert.ok(row.down > FLOOR_KBS && row.up > FLOOR_KBS, `${name} at ${oneWay} ms: not a stall (${row.down} / ${row.up} KB/s)`);
      pass(`${bytes / MB} MB down and ${bytes / MB} MB up, ${name}: hashes equal, ${row.down} KB/s down, ${row.up} KB/s up`);
    }
    viaRelay();

    // ---------- keep-alive: many requests, one connection (both paths, for the comparison) ----------
    const rows = { relay: table.at(-2), direct: table.at(-1) };
    for (const [name, port] of [["relay", ports.web], ["direct", direct]]) {
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }), n = oneWay >= 50 ? 10 : oneWay ? 20 : 30, seen = new Set(), took = [];
      for (let i = 0; i < n; i++) {
        const got = await small(port, i, { agent });
        assert.equal(got.sha, sha(payload(i, 300 + i)), `keep-alive #${i}`);
        seen.add(got.headers["x-conn"]);
        took.push(got.ms);
      }
      agent.destroy();
      assert.equal(seen.size, 1, "all on one connection to the service");
      rows[name].kept = median(took);
      pass(`keep-alive, ${name}: ${n} requests one after another on one connection, median ${ms(median(took))}, slowest ${ms(Math.max(...took))}`);
    }

    // ---------- a request while a large download runs (head of line) ----------
    // Each small request is a connection of its own: the forward asks H to open the stream (a request on the link),
    // then the bytes go as frames - all behind what the download has put on the same link. The download is larger
    // than what can pass meanwhile, and is aborted after the last of them (its stream on H then goes: the service's
    // own socket says nothing here - Windows takes the whole body from it long before the forward has read it).
    for (const [name, port] of [["relay", ports.web], ["direct", direct]]) {
      const idle = [];
      for (let i = 0; i < 5; i++) idle.push((await small(port, 50 + i)).ms);
      const s = seed++, hog = { req: null, ended: false, got: 0 };
      const big = new Promise(first => {
        ask(port, { path: `/bytes?seed=${s}&size=${64 * MB}`, timeout: 120000, onFirst: first, onRequest: req => { hog.req = req; } })
          .then(() => { hog.ended = true; }, () => { hog.ended = true; });
      });
      await big;
      const busy = [];
      for (let i = 0; i < 5; i++) {
        const got = await small(port, 60 + i, { timeout: 30000 });
        assert.equal(got.sha, sha(payload(60 + i, 360 + i)));
        busy.push(got.ms);
      }
      assert.equal(hog.ended, false, "the download was still running after the last of them");
      hog.req.destroy();
      await waitFor(() => hog.ended, "the aborted download ended");
      await quiet();
      Object.assign(rows[name], { idle: median(idle), busy: median(busy), busyMax: Math.max(...busy) });
      pass(`head of line, ${name}: a small request on a new connection takes ${ms(median(idle))} idle, ${ms(median(busy))} while a download runs (slowest ${ms(Math.max(...busy))}); the download aborted, no stream left`);
    }

    {
      // ---------- ten connections at once, bodies of mixed sizes ----------
      {
        const sizes = [200, 3 * KB, 40 * KB, 300 * KB, 1, 700, 90 * KB, 512 * KB, 17 * KB, 150 * KB], group = `g${oneWay}`, from = now();
        const got = await Promise.all(sizes.map((size, i) => ask(ports.web, { path: `/bytes?seed=${200 + i}&size=${size}&group=${group}&of=${sizes.length}${i % 2 ? "&chunked=1" : ""}` })));
        got.forEach((g, i) => {
          assert.equal(g.size, sizes[i], `at once #${i}: the whole body`);
          assert.equal(g.sha, sha(payload(200 + i, sizes[i])), `at once #${i}: the same bytes`);
        });
        // The service answered none before all ten were there: ten connections were open at the same time.
        assert.equal(new Set(got.map(g => g.headers["x-conn"])).size, sizes.length, "each on a connection of its own");
        pass(`${sizes.length} connections at once (${Math.round(sizes.reduce((a, b) => a + b) / KB)} KB in all, Content-Length and chunked): every hash equal, ${ms(now() - from)}`);
      }

      // ---------- a WebSocket: the upgrade, frames both ways for a while ----------
      {
        const key = crypto.randomBytes(16).toString("base64"), before = { ...wsServer };
        const { res, socket, head } = await new Promise((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: ports.web, path: "/ws", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
          req.on("upgrade", (res, socket, head) => resolve({ res, socket, head }));
          req.on("response", res => reject(new Error(`no upgrade: HTTP ${res.statusCode}`)));
          req.on("error", reject);
          setTimeout(() => reject(new Error("no answer to the upgrade")), 15000).unref();
          req.end();
        });
        assert.equal(res.statusCode, 101);
        assert.equal(res.headers["sec-websocket-accept"], wsAccept(key), "the service's own answer to this handshake");
        const sent = [], echo = [], pushes = [];
        let pongs = 0, closeGot = false, wrong = null, lastPush = -1;
        const feed = wsReader((op, data, masked) => {
          try {
            assert.equal(masked, false, "a server's frames are not masked");
            if (op === WS.BINARY) {
              const mine = sent.shift();
              assert.ok(mine, "an echo of something sent");
              assert.equal(sha(data), mine.sha, "the echo is the frame sent, in order");
              echo.push(now() - mine.at);
            } else if (op === WS.TEXT) {
              const m = JSON.parse(data.toString());
              assert.equal(m.n, lastPush + 1, "the pushes in order, none missing");
              lastPush = m.n;
              pushes.push(now() - m.t);
            } else if (op === WS.PONG) pongs++;
            else if (op === WS.CLOSE) closeGot = true;
          } catch (e) { wrong ||= e; }
        });
        if (head.length) feed(head);
        socket.on("data", feed);
        socket.on("error", () => {});
        // 7-bit, 16-bit and 64-bit lengths; the largest is more than one piece of a stream (32 KB).
        const sizes = [16, 300, 70000, 5, 2000];
        let frames = 0;
        for (const until = now() + 2000; now() < until; frames++) {
          const data = crypto.randomBytes(sizes[frames % sizes.length]);
          sent.push({ sha: sha(data), at: now() });
          socket.write(wsFrame(WS.BINARY, data, true));
          await sleep(100);
        }
        socket.write(wsFrame(WS.PING, Buffer.from("still there?"), true));
        await waitFor(() => wrong || (!sent.length && pongs === 1), "every frame echoed, the ping answered");
        socket.write(wsFrame(WS.CLOSE, Buffer.from([3, 232]), true)); // 1000
        await closed(socket, "the WebSocket's connection closes after the close frames");
        if (wrong) throw wrong;
        assert.equal(closeGot, true, "the service's close frame came before the end");
        assert.equal(echo.length, frames);
        assert.equal(wsServer.unmasked, before.unmasked, "the client's frames reached the service masked, as sent");
        assert.equal(wsServer.masked - before.masked, frames + 2, "every frame, the ping and the close reached the service");
        assert.ok(pushes.length >= 6, `the service's own pushes came all along: ${pushes.length}`);
        assert.ok(Math.max(...pushes) < 2 * oneWay + 1500, `no push was held back: ${ms(Math.max(...pushes))}`);
        await waitFor(() => wsServer.open === 0, "the service's end of the WebSocket closed");
        pass(`WebSocket: handshake, ${frames} masked frames (5 B - 70 KB) echoed in order over 2 s (echo median ${ms(median(echo))}, slowest ${ms(Math.max(...echo))}), ${pushes.length} pushes (delay median ${ms(median(pushes))}, slowest ${ms(Math.max(...pushes))}), ping/pong, close`);
      }

      // ---------- Server-Sent Events: they trickle, and arrive as they are written ----------
            {
        const id = `whole${oneWay}`, delays = [], gaps = [];
        let last = 0;
        const whole = await events$(id, 10, 200, e => {
          assert.equal(e.i, delays.length, "the events in order");
          delays.push(now() - e.t);
          if (last) gaps.push(now() - last);
          last = now();
        });
        assert.equal(whole, true, "the stream ended as the service ended it");
        assert.equal(delays.length, 10, "every event");
        // Each came while the stream still ran - not all at its end - and not long after it was written.
        assert.ok(Math.max(...delays) < 2 * oneWay + 1000, `an event was held back: ${ms(Math.max(...delays))}`);
        assert.ok(median(gaps) > 100, `the events came one by one, not in a lump: median gap ${ms(median(gaps))}`);
        pass(`SSE: 10 events over 2 s, each ${ms(median(delays))} after it was written (slowest ${ms(Math.max(...delays))}; one way is ${oneWay} ms)`);
      }
      // The client aborts in the middle: the service's connection on H closes, soon.
      {
        const id = `cut${oneWay}`;
        let abortedAt = 0;
        const whole = await events$(id, 1000, 100, (e, req) => { if (e.i === 3) { abortedAt = now(); req.destroy(); } });
        assert.equal(whole, false);
        await waitFor(() => sse.get(id).closedAt, "the service's socket closes after the client aborted", 10000);
        const rec = sse.get(id);
        assert.ok(rec.sent < 1000, "the service was still sending");
        pass(`SSE aborted by the client: the service's socket on H closed ${ms(rec.closedAt - abortedAt)} later (after ${rec.sent} events written)`);
      }

      // ---------- the ways a connection ends ----------
      await quiet();
      const closedBefore = events.filter(e => e.name === "port.closed").length;
      {
        // The service says its piece and ends first; the client ends after it.
        const s = await dial(ports.bye), got = readAll(s);
        s.write("hello");
        assert.equal(sha(await got), sha(banner), "what the service sent before its end");
        s.end();
        await closed(s, "closed after both ended");
      }
      {
        // The client ends first (a FIN, nothing lost); the service ends when it sees it.
        held.length = 0;
        const s = await dial(ports.hold), got = readAll(s);
        s.write("first");
        await waitFor(() => held.length === 1 && held[0].data === "first", "the service has the client's bytes");
        assert.equal(held[0].ended, false);
        s.end(" and last");
        assert.equal((await got).length, 0, "the service's end reached the client");
        await closed(s, "closed after both ended");
        assert.deepEqual([held[0].data, held[0].ended], ["first and last", true], "the service saw the bytes, then the end");
      }
      {
        // A half close: the client sends, ends, and still gets the answer the service makes only then.
        const data = payload(7, 300 * KB), s = await dial(ports.sum), got = readAll(s);
        s.end(data);
        assert.equal((await got).toString(), sha(data), "the answer came after the client's end");
        await closed(s, "closed after both ended");
      }
      await quiet();
      assert.equal(events.filter(e => e.name === "port.closed").length, closedBefore, "three clean ends: none reported as broken");
      {
        // The client just goes (a tab closed): the service's socket closes.
        held.length = 0;
        const s = await dial(ports.hold);
        s.write("gone soon");
        await waitFor(() => held.length === 1, "the service has the connection");
        const from = now();
        s.destroy();
        await waitFor(() => held[0].closed, "the service's socket closes after the client went", 10000);
        console.log(`  a client that just goes: the service's socket closed ${ms(now() - from)} later`);
      }
      {
        // The service resets: the client's connection goes too, and V hears "port.closed".
        const s = await dial(ports.reset);
        s.resume();
        s.on("end", () => s.end()); // this socket stays half open: the forward's end is answered with its own
        s.write("hello");
        await closed(s, "the client's connection closes after the service reset its own");
        await waitFor(() => events.filter(e => e.name === "port.closed").length === closedBefore + 1, "port.closed");
      }
      await quiet();
      pass("endings: the service first, the client first, a half close, a client that just goes, a service that resets - no stream left on either side");
    }
  }

  // ---------- the link to the relay drops in the middle of a download, and comes back ----------
  {
    console.log("\n--- the link to the relay drops (25 ms one way) ---");
    setLatency(25);
    // V dials the relay where it last reached it; a link says its own port when it comes up (links.js adopt), which
    // here is R's real one - around the proxy. So V is told the proxy's again, as if that were where R is.
    v.peers().update(R, { address: "127.0.0.1", port: PV.port });
    hide(r, V);
    const accepted = PV.accepted;
    let started, flowing;
    const running = new Promise(done => { started = done; }), trickling = new Promise(done => { flowing = done; });
    const big = ask(ports.web, { path: `/bytes?seed=${seed++}&size=${16 * MB}`, onFirst: started, timeout: 30000 }).then(() => null, e => e);
    // And an event stream, whose service is still writing when the link goes: its socket on H closing is seen there.
    const stream = events$("drop", 1000, 100, e => { if (e.i === 2) flowing(); });
    await Promise.all([running, trickling]);
    const from = now();
    PV.drop();
    const e = await big;
    assert.ok(e, "the download did not pass for whole");
    assert.notEqual(e.message.includes("did not end within"), true, `the browser's connection was closed, not left hanging: ${e.message}`);
    const cutAfter = now() - from;
    assert.equal(await stream, false, "the event stream was cut too");
    await waitFor(() => sse.get("drop").closedAt, "the service's connection on H closed too", 20000);
    const serviceCut = sse.get("drop").closedAt - from;
    assert.ok(sse.get("drop").sent < 1000, "the service was still writing");
    await waitFor(() => !fv.list().length && !served.ports.count(V), "V's forwards and H's streams went with the link");
    await assert.rejects(dial(ports.web), "nothing listens on the forward's port any more");
    pass(`link drop during a download: the browser's connection closed ${ms(cutAfter)} later (${e.code || e.message}), the service's on H ${ms(serviceCut)} later, the forwards gone`);
    // Back by itself: V dials the relay again (through the proxy), then H through it.
    await waitFor(() => v.online(R) && v.online(H) && h.online(V), "V linked to the relay and to H again", 30000);
    const back = now() - from;
    assert.ok(PV.accepted > accepted, "the new link to the relay went through the proxy");
    // V and H both dial each other through the relay once they see the route again; of two links the one from the
    // smaller id stays (links.js adopt), and the other is closed with what was asked on it. So a forward asked for
    // the moment V sees H again is refused with "closed" when H's id is the smaller one (H's link replaces V's just
    // then). Known, and said here every time it happens; PF_RELAY_STRICT=1 makes it a failure. Any other refusal is one.
    const early = await fv.open(H, portOf(web)).then(() => "", e => e.code || e.message);
    if (early) {
      assert.equal(early, "closed", `a forward asked for as soon as the link was back: ${early}`);
      console.log(`  NOTE  forwards.open ${ms(now() - from - back)} after V saw H again was refused with "closed": H's own link through the relay replaced V's just then (H's id is the ${H < V ? "smaller" : "larger"} one). Asked again below, it works.`);
      assert.ok(!process.env.PF_RELAY_STRICT, "PF_RELAY_STRICT: a forward asked for right after the link came back was refused");
    }
    // Nothing more is forwarded until the links are settled: no change of the nodes for a second.
    await waitFor(() => now() - lastChange > 1000, "the links settled");
    viaRelay();
    await openAll();
    const down = await download(ports.web, MB, DOWN_RELAY), up = await upload(ports.web, MB, UP_RELAY);
    await quiet();
    table.push({ latency: "25 ms", path: `relay again (${opener()} opened)`, rtt: await roundTrip(v), bytes: MB, down: kbs(MB, down.ms), up: kbs(MB, up.ms) });
    pass(`reconnect: V linked to R and H again ${ms(back)} after the drop, through the proxy; the tunnel now opened by ${opener()}; a new forward carried 1 MB each way (${kbs(MB, down.ms)} KB/s down, ${kbs(MB, up.ms)} KB/s up)`);
  }

  // ---------- the table ----------
  console.log("\nThroughput through a forward (KB/s); one small request (median): on a kept connection, on a new one, on a new one while a download runs");
  const cols = [["one way", r => r.latency], ["path", r => r.path], ["round trip", r => (r.rtt ? ms(r.rtt) : "-")], ["size", r => `${r.bytes / MB} MB`],
    ["down KB/s", r => String(r.down)], ["up KB/s", r => String(r.up)], ["kept conn", r => (r.kept ? ms(r.kept) : "-")], ["new conn", r => (r.idle ? ms(r.idle) : "-")], ["new, busy", r => (r.busy ? `${ms(r.busy)} (max ${ms(r.busyMax)})` : "-")]];
  const width = cols.map(([title, cell]) => Math.max(title.length, ...table.map(r => cell(r).length)));
  const line = cells => `  ${cells.map((c, i) => c.padEnd(width[i])).join("  ")}`;
  console.log(line(cols.map(c => c[0])));
  for (const row of table) console.log(line(cols.map(c => c[1](row))));
  console.log(`\nport forwarding through a relay: all ${passed.length} checks passed`);
}

const started = Date.now();
const watchdog = setTimeout(() => { console.error("the test did not finish in time"); process.exit(1); }, 300000);
main().then(() => 0, e => { console.error(e); return 1; }).then(async code => {
  clearTimeout(watchdog);
  for (const stop of stops.reverse()) try { stop(); } catch {}
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
  process.exit(code);
});
