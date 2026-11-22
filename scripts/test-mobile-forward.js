// Forwarded ports on the phone (docs/PORT-FORWARDING.md 4; mobile/src/forward.js, ports.js, provider-relay.js,
// src/mesh/web-client.js), without a phone: the app's provider and store run in Node with `ws` as the WebSocket, as in
// scripts/test-mobile-provider.js, and reach a real computer H (createServed: ports.*, as scripts/test-port-forward.js
// builds it) the way a phone does - a web link to the relay R (relay only), and inside a tunnel through it a second
// Noise link to H. O is an AgentDeck from before forwarded ports. The phone dials R through a small TCP proxy of this
// test that can hold the bytes (latency) and cut the connection (a lost link).
//
// The native side is a FAKE `Forward` plugin made here over Node's sockets, behind exactly the contract of
// PORT-FORWARDING.md 4.1: listen on 127.0.0.1 (the wished port when free, else any), "connection" / "data" (base64,
// at most 32 KB) / "end" / "closed" events delivered later and in order as a bridge does, the socket read only while
// less than 256 KB is delivered and not credited, write (one at a time for a connection, at most 64 KB) / end / close
// / credit, show / hide / "hidden". It notes every breach of the contract by the page (two writes at once, a piece
// too big, more credit than was delivered, a call for a connection that never was): none may be left at the end.
//
// Checked: a phone may ask for ports.* (it is a peer with control) and its link to H is a tunnel; megabytes both ways
// by hash; a forward is made once and has the port's own number when the phone has it free; several connections at
// once; a half close; a client that resets and one that just closes; a service that resets ("port.closed"); a client
// that does not read and a service that does not read - the sender stops a window later, the plugin stops reading at
// 256 KB, the phone's backlog towards the relay stays far below what closes its link, and every byte arrives once
// they read; a dead port, an older computer, the relay, a computer that is not there - each with its code and its
// words, and nothing left listening; the view (show, https, "hidden", hide on stop); the 65th stream; the Ports
// sheet's list and rows (ports.js), the ports typed by hand; the base64 of the bridge; a lost link closes the
// listeners, the connections on both sides and the view, says "lost", and after the phone is back a new forward works.
// Throughput through the phone's path is measured without latency and at about 50 ms round trip, and printed; only a
// floor far below anything that is not a stall is asserted. PF_PHONE_MB=<n>: megabytes of each measured transfer.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");
const { WebSocket } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { MAX_STREAMS } = require("../src/host/port-streams");
const { HostError } = require("../src/host/errors");
const pairCode = require("../src/mesh/pair-code");
const noise = require("../src/mesh/noise");
const frames = require("../src/mesh/frames");
const { STREAM_WINDOW, STREAM_PIECE } = frames;

const MB = 1024 * 1024, KB = 1024;
const FORCED_MB = Number(process.env.PF_PHONE_MB) || 0;
const PLUGIN_WINDOW = 256 * KB, PLUGIN_PIECE = 32 * KB, PLUGIN_WRITE_MAX = 64 * KB; // PORT-FORWARDING.md 4.1
const CLIENT_BACKLOG_LIMIT = 32 * MB; // web-client.js MAX_BACKLOG: more than this waiting closes the phone's link
const FLOOR_KBS = 20;                 // below this a transfer counts as stalled
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mobile-forward-"));
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (test, what, ms = 20000) => {
  for (const from = now(); now() - from < ms;) { if (test()) return; await sleep(10); }
  throw new Error(`timed out: ${what}`);
};
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const uuid = () => crypto.randomUUID();
const fails = code => e => e.code === code;
const kbs = (bytes, took) => Math.round(bytes / KB / (took / 1000));
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const passed = [];
const pass = line => { passed.push(line); console.log(`  ok  ${line}`); };
const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });

// ---------- TCP on this machine ----------
const listen = (onConnection, host = "127.0.0.1") => new Promise((resolve, reject) => {
  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.once("error", reject);
  server.listen(0, host, () => resolve(server));
});
const dial = port => new Promise((resolve, reject) => {
  const s = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  s.once("error", reject);
  s.once("connect", () => { s.off("error", reject); s.on("error", () => {}); s.setNoDelay(true); resolve(s); });
});
// The socket closed. These sockets stay half open, so the other side's end is answered with this side's.
const closed = (s, what = "the socket closes", within = 15000) => new Promise((resolve, reject) => {
  if (s.destroyed) return void resolve();
  const timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), within);
  s.once("end", () => s.end());
  s.once("close", () => { clearTimeout(timer); resolve(); });
});
// Everything a socket gets until the other side ends.
const readAll = s => new Promise((resolve, reject) => {
  const parts = [];
  s.on("data", d => parts.push(d));
  s.once("end", () => resolve(Buffer.concat(parts)));
  s.once("close", () => reject(new Error("closed before its end")));
});
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
// `size` bytes that depend on `seed`: both ends of a transfer make them and compare hashes.
const BLOCK = crypto.randomBytes(MB);
function payload(seed, size) {
  const out = Buffer.allocUnsafe(size);
  for (let i = 0, off = (seed * 7919) % BLOCK.length; i < size; off = 0) i += BLOCK.copy(out, i, off, Math.min(BLOCK.length, off + size - i));
  if (size >= 4) out.writeUInt32BE(seed >>> 0, 0);
  return out;
}

// ---------- the delay proxy (as scripts/test-port-forward-relay.js has it) ----------
// A TCP proxy to 127.0.0.1:target that holds what it reads for `delay` ms before it writes it on, each direction
// apart and in order. drop(): every connection through it is cut (the listener stays).
function delayProxy(target) {
  const p = { delay: 0, accepted: 0, live: new Set(), port: 0, server: null };
  const lane = (from, to, conn) => {
    const queue = [];
    let timer = null, lastDue = 0;
    const put = item => (item ? to.write(item) : to.end());
    const drain = () => {
      timer = null;
      while (queue.length && queue[0].due <= now() + 0.5) put(queue.shift().chunk);
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].due - now()));
    };
    const take = chunk => {
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
    lane(a, b, conn);
    lane(b, a, conn);
  });
  p.drop = () => { for (const conn of [...p.live]) conn.end(); };
  p.stop = () => { p.drop(); p.server.close(); };
  return new Promise((resolve, reject) => {
    p.server.once("error", reject);
    p.server.listen(0, "127.0.0.1", () => { p.port = p.server.address().port; resolve(p); });
  });
}

// ---------- the fake Forward plugin: PORT-FORWARDING.md 4.1 over Node's sockets ----------
// Beyond the contract it keeps books for the test: breaches (what the page did against the contract), the most
// bytes ever delivered and not credited on one connection, what it delivered in all, the view's calls.
function fakeForward() {
  const handlers = new Map(); // event -> Set of fn
  const listeners = new Map(), conns = new Map();
  const outbox = [];          // events on their way over the "bridge": later, in the order they were raised
  const fake = { breaches: [], maxUncredited: 0, delivered: 0, written: 0, views: [], hides: 0, view: null, listeners, conns, ever: new Set() };
  let nextListener = 1, nextConn = 1, flushing = false;
  const notify = (event, data) => {
    outbox.push([event, data]);
    if (flushing) return;
    flushing = true;
    setImmediate(() => {
      flushing = false;
      for (const [name, payload] of outbox.splice(0)) for (const fn of [...(handlers.get(name) || [])]) fn(payload);
    });
  };
  const later = value => new Promise(resolve => setImmediate(() => resolve(value)));
  const gone = what => Promise.reject(new Error(`${what}: no such connection`));
  // Reads the socket while less than a window is delivered and not credited: pieces of at most 32 KB, in order.
  function pump(c) {
    while (!c.over && c.uncredited < PLUGIN_WINDOW) {
      const n = c.socket.readableLength;
      const chunk = n ? c.socket.read(Math.min(PLUGIN_PIECE, n)) : c.socket.read(); // the last read() raises "end"
      if (!chunk?.length) return;
      c.uncredited += chunk.length;
      c.delivered += chunk.length;
      fake.delivered += chunk.length;
      fake.maxUncredited = Math.max(fake.maxUncredited, c.uncredited);
      notify("data", { conn: c.id, data: chunk.toString("base64") });
    }
  }
  function accept(l, socket) {
    const c = { id: `c${nextConn++}`, socket, listener: l.id, uncredited: 0, delivered: 0, credited: 0, writing: false, over: false, error: "" };
    conns.set(c.id, c);
    fake.ever.add(c.id);
    l.conns.add(c);
    socket.setNoDelay(true);
    socket.on("readable", () => pump(c));
    socket.on("end", () => notify("end", { conn: c.id }));
    socket.on("error", e => { c.error = e.code || e.message || "error"; });
    socket.on("close", () => {
      c.over = true;
      conns.delete(c.id);
      l.conns.delete(c);
      notify("closed", { conn: c.id, error: c.error });
    });
    notify("connection", { listener: l.id, conn: c.id });
  }
  const bind = port => new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); server.on("error", () => {}); resolve(server); });
  });
  return Object.assign(fake, {
    addListener(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return Promise.resolve({ remove: async () => { handlers.get(event).delete(fn); } });
    },
    handlerCount: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
    async listen({ port } = {}) {
      const wish = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
      const server = await (wish ? bind(wish).catch(() => bind(0)) : bind(0));
      const l = { id: `l${nextListener++}`, server, conns: new Set(), port: server.address().port };
      listeners.set(l.id, l);
      server.on("connection", socket => accept(l, socket));
      return later({ listener: l.id, port: l.port });
    },
    async unlisten({ listener } = {}) {
      const l = listeners.get(listener);
      if (!l) return later({});
      listeners.delete(listener);
      l.server.close();
      for (const c of [...l.conns]) c.socket.destroy();
      return later({});
    },
    write({ conn, data } = {}) {
      const c = conns.get(conn);
      if (!c) { if (!fake.ever.has(conn)) fake.breaches.push(`write for ${conn}, which never was`); return gone("write"); }
      if (c.writing) fake.breaches.push(`two writes at once on ${conn}`);
      if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { fake.breaches.push(`write on ${conn}: not base64`); return gone("write"); }
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > PLUGIN_WRITE_MAX) fake.breaches.push(`a write of ${bytes.length} bytes on ${conn}`);
      c.writing = true;
      return new Promise((resolve, reject) => {
        c.socket.write(bytes, err => {
          c.writing = false;
          if (err) return void reject(err);
          fake.written += bytes.length;
          resolve({});
        });
      });
    },
    end({ conn } = {}) {
      const c = conns.get(conn);
      if (!c) { if (!fake.ever.has(conn)) fake.breaches.push(`end for ${conn}, which never was`); return gone("end"); }
      if (c.writing) fake.breaches.push(`end during a write on ${conn}`);
      c.socket.end();
      return later({});
    },
    close({ conn } = {}) {
      const c = conns.get(conn);
      if (!c) { if (!fake.ever.has(conn)) fake.breaches.push(`close for ${conn}, which never was`); return later({}); }
      c.socket.destroy();
      return later({});
    },
    credit({ conn, bytes } = {}) {
      const c = conns.get(conn);
      if (!c) { if (!fake.ever.has(conn)) fake.breaches.push(`credit for ${conn}, which never was`); return later({}); }
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > c.uncredited) fake.breaches.push(`credit of ${bytes} on ${conn} with ${c.uncredited} delivered and not credited`);
      c.uncredited = Math.max(0, c.uncredited - (Number(bytes) || 0));
      c.credited += Number(bytes) || 0;
      pump(c);
      return later({});
    },
    show({ url, title } = {}) { fake.view = { url, title }; fake.views.push({ url, title }); return later({}); },
    hide() { fake.view = null; fake.hides++; return later({}); },
    // The user closes the view with its own button.
    userCloses() { fake.view = null; notify("hidden", {}); },
    stop() { for (const l of [...listeners.values()]) { l.server.close(); for (const c of [...l.conns]) c.socket.destroy(); } listeners.clear(); }
  });
}

// What createServed needs of a host that has no terminals (scripts/test-port-forward.js), and what the phone's store
// asks a computer for when it links.
function makeHost() {
  const data = { registry: { projects: [] }, sessions: [], agents: [], at: Date.now() };
  return Object.assign(new EventEmitter(), {
    terminals: { getTabs: () => [] }, viewers: { leave() {}, state: () => null }, launch: {}, sendText: {}, git: {}, setup: {},
    sessions: { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } },
    home: os.homedir(), tabs: () => [], liveSessions: async () => []
  });
}

const stops = [];
async function main() {
  // The phone's modules, as the bundle has them. localStorage for the ports typed by hand (ports.js).
  const kept = new Map();
  globalThis.localStorage = { getItem: k => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => { kept.set(k, String(v)); }, removeItem: k => { kept.delete(k); } };
  const mobile = file => import(pathToFileURL(path.join(__dirname, "../mobile/src", file)).href);
  const { createRelayProvider } = await mobile("provider-relay.js");
  const { createStore } = await mobile("data.js");
  const { createForwards, toBase64, fromBase64 } = await mobile("forward.js");
  const ports = await mobile("ports.js");
  const i18n = await mobile("i18n.js");
  i18n.setLanguage("en");

  // ---------- the bridge's base64 ----------
  {
    for (const size of [0, 1, 2, 3, 8191, 8192, 8193, STREAM_PIECE, 64 * KB]) {
      const bytes = crypto.randomBytes(size), text = toBase64(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
      assert.equal(text, bytes.toString("base64"), `toBase64 of ${size} bytes`);
      assert.equal(Buffer.compare(Buffer.from(fromBase64(text)), bytes), 0, `fromBase64 of ${size} bytes`);
    }
    // A view into a larger buffer (a frame's bytes are one): only its own bytes.
    const big = crypto.randomBytes(100), part = new Uint8Array(big.buffer, big.byteOffset + 10, 50);
    assert.equal(toBase64(part), big.subarray(10, 60).toString("base64"));
    const piece = new Uint8Array(crypto.randomBytes(STREAM_PIECE)), from = now();
    for (let i = 0; i < 300; i++) fromBase64(toBase64(piece));
    const each = (now() - from) / 300;
    assert.ok(each < 20, `a 32 KB piece to base64 and back takes ${each.toFixed(2)} ms`);
    pass(`base64 for the bridge: equal to Node's for 0 B - 64 KB, a 32 KB piece there and back in ${each.toFixed(2)} ms`);
  }

  // ---------- the services on H's computer ----------
  const echo = await listen(s => { s.on("error", () => {}); s.pipe(s); });
  const sum = await listen(s => { s.on("error", () => {}); readAll(s).then(all => s.end(sha(all)), () => {}); });
  // Asked with [seed:4][size:4], sends payload(seed, size) as fast as its socket takes it, and ends.
  const source = await listen(s => {
    s.on("error", () => {});
    let head = Buffer.alloc(0);
    s.on("data", function take(d) {
      head = Buffer.concat([head, d]);
      if (head.length < 8) return;
      s.off("data", take);
      s.end(payload(head.readUInt32BE(0), head.readUInt32BE(4)));
    });
    s.on("end", () => {});
  });
  const reset = await listen(s => { s.on("error", () => {}); s.once("data", () => s.resetAndDestroy()); });
  const held = [];
  const hold = await listen(s => {
    s.on("error", () => {});
    const rec = { socket: s, data: "", ended: false, closed: false };
    held.push(rec);
    s.on("data", d => { rec.data += d; });
    s.on("end", () => { rec.ended = true; s.end(); });
    s.on("close", () => { rec.closed = true; });
  });
  // Reads nothing until told to (go()), then answers with the hash of everything once the client ended.
  const lazy = [];
  const sloth = await listen(s => {
    s.on("error", () => {});
    s.pause();
    lazy.push({ socket: s, go: () => { readAll(s).then(all => s.end(`${all.length}:${sha(all)}`), () => {}); s.resume(); } });
  });
  const servers = [echo, sum, source, reset, hold, sloth];
  stops.push(() => servers.forEach(s => s.close()));
  const portOf = s => s.address().port;
  // The host asks a port once before a forward is made (forward.js answers): that connection came to these too.
  const settled = async list => { await sleep(250); list.length = 0; };

  // ---------- the nodes ----------
  const node = (name, { port = 0, ...opts } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port }));
    return createLinks({ dir, defaultName: name, kind: "desktop", version: "test", api: async () => null, discover: false, log: () => {}, ...opts });
  };
  const served = createServed({ host: makeHost() });
  const rPort = await freePort();
  const r = node("R", { kind: "host", relayOnly: true, port: rPort });
  const h = node("H", { api: (m, p, peer) => served.api(m, p, peer) });
  // O: an AgentDeck from before forwarded ports - no ports.*, no `ports: 1`.
  const o = node("O", { api: method => {
    if (method === "host.info") return { name: "O", agents: [], terminals: 2 };
    if (method === "sessions.list") return { registry: { projects: [] }, sessions: [], agents: [] };
    if (method === "terminals.list" || method === "live.list") return [];
    throw new HostError("unknownMethod");
  } });
  stops.push(() => [r, h, o].forEach(l => l.stop()));
  const R = (await r.start()).id, H = (await h.start()).id, O = (await o.start()).id;
  served.attach(h);
  for (const x of [h, o]) await x.pair("127.0.0.1", rPort, r.self().code);
  await waitFor(() => h.online(R) && o.online(R), "H and O linked with the relay");
  const PV = await delayProxy(rPort); // the phone's way to the relay
  stops.push(() => PV.stop());

  // ---------- the phone ----------
  const { t: _kind, ...relayNode } = entry(await h.call(R, "pair.invite"));
  const text = pairCode.encode({ r: { a: "127.0.0.1", p: PV.port, ...relayNode }, n: [entry(h.invite()), entry(o.invite())] });
  const provider = createRelayProvider({ WebSocket, keypair: noise.generateKeypair(), peers: [], name: "Test phone", version: "test" });
  const store = createStore(provider);
  stops.push(() => store.disconnect());
  await store.connect();
  const rows = await provider.pairAll(text);
  assert.deepEqual(rows.map(x => [x.id, x.state]), [[R, "paired"], [H, "paired"], [O, "paired"]]);
  await waitFor(() => store.computers().length === 2 && store.computers().every(n => n.online) && !store.loading(), "H and O online and loaded");
  const PHONE = provider.id;
  const viaRelay = () => {
    assert.deepEqual(provider.nodes().find(n => n.id === H).via, [R], "the phone's link to H is a tunnel through the relay");
    assert.equal(PV.live.size, 1, "and the phone holds one connection: to the relay, through the proxy");
  };
  viaRelay();
  // A phone is a peer with control: the door ports.* is behind (links.js api, serve.js ctl) is open to it.
  assert.deepEqual([h.peers().get(PHONE).kind, h.peers().get(PHONE).control], ["mobile", true], "H knows the phone as a mobile peer that may control it");
  assert.equal(h.sees(PHONE), true);
  assert.equal(store.node(H).info.ports, 1, "H says it forwards ports");
  assert.ok((await store.ports(H, uuid())).some(p => p.port === portOf(echo)), "ports.list, asked by the phone, names the echo's port");
  pass("the phone is a peer with control on H (kind mobile): host.info ports: 1 and ports.list come through the tunnel");

  // The stream frames between the phone and H: what H sent of data and what the phone acknowledged; what the phone
  // sent and H acknowledged. (Counted before the forwards see a frame: an ack is counted before what it lets go.)
  const seen = { down: 0, downAcked: 0, up: 0, upAcked: 0, mostDown: 0, mostUp: 0 };
  provider.on("stream", ({ node: from, frame }) => {
    if (from !== H) return;
    if (frame.type === "stream-data") { seen.down += frame.bytes.length; seen.mostDown = Math.max(seen.mostDown, seen.down - seen.downAcked); }
    else if (frame.type === "stream-ack") seen.upAcked += frame.count;
  });
  const sendBinary = provider.sendBinary;
  provider.sendBinary = (to, bytes) => {
    const f = to === H ? frames.decode(bytes) : null;
    if (f?.type === "stream-data") { seen.up += f.bytes.length; seen.mostUp = Math.max(seen.mostUp, seen.up - seen.upAcked); }
    else if (f?.type === "stream-ack") seen.downAcked += f.count;
    return sendBinary(to, bytes);
  };

  const plugin = fakeForward();
  stops.push(() => plugin.stop());
  const fw = createForwards({ provider, plugin });
  stops.push(() => fw.dispose());
  assert.equal(fw.available, true);
  let changes = 0;
  const lost = [], notes = [];
  fw.on("change", () => { changes++; });
  fw.on("lost", e => lost.push(e));
  provider.on("notify", e => { if (e.node === H && e.event === "port.closed") notes.push(e.payload); });
  const streamsOf = () => served.ports.count(PHONE);
  const quiet = () => waitFor(() => fw.list().every(f => !f.streams) && !streamsOf() && !plugin.conns.size, "every stream went with its connection");
  // What waits on the phone for the relay to take it, sampled all along: the credit window has to keep it small.
  let maxBacklog = 0;
  const sampler = setInterval(() => { maxBacklog = Math.max(maxBacklog, provider.buffered(H)); }, 2);
  stops.push(() => clearInterval(sampler));

  // ---------- a forward ----------
  const [f1, f2] = await Promise.all([fw.open(H, portOf(echo)), fw.open(H, portOf(echo))]);
  assert.deepEqual(f1, f2, "asked twice at once: one forward");
  assert.deepEqual(await fw.open(H, portOf(echo)), f1, "and again: the same");
  assert.deepEqual([f1.node, f1.port], [H, portOf(echo)]);
  assert.notEqual(f1.localPort, portOf(echo), "that number is taken on this machine: another one");
  assert.deepEqual(fw.list(), [{ ...f1, streams: 0 }]);
  assert.deepEqual([changes, plugin.listeners.size], [1, 1], "one change, one listener");
  await assert.rejects(dial(portOf(echo) === 1 ? 2 : 1), "nothing of the phone's listens elsewhere");
  for (const port of [0, 65536, "80", 2.5, null]) await assert.rejects(fw.open(H, port), fails("invalidData"), `port ${JSON.stringify(port)}`);

  async function echoed(port, size, what) {
    const data = crypto.randomBytes(size), s = await dial(port), back = readAll(s);
    s.end(data);
    const got = await back;
    assert.equal(got.length, size, `${what}: every byte came back`);
    assert.equal(sha(got), sha(data), `${what}: the same bytes, in order`);
    await closed(s);
  }
  await echoed(f1.localPort, 4 * MB, "through the phone");
  await Promise.all([1, 2, 3, 4, 5, 6].map(i => echoed(f1.localPort, 300 * KB + i, `at once #${i}`)));
  await quiet();
  assert.equal(notes.length, 0, "a clean end is not reported");
  pass("a forward (made once, on another number: the port's own is taken here): 4 MB echoed by hash, six connections at once, no stream left");

  // (The port's own number, when the phone has it free, is checked with a fake provider at the end: here the phone
  // and H are one machine, and a listener of the phone's on a service's number would be what H then connects to.)

  // ---------- how a connection ends ----------
  {
    // A half close: the client sends, ends, and still gets the answer the service makes only then.
    const f = await fw.open(H, portOf(sum));
    const data = crypto.randomBytes(MB), s = await dial(f.localPort), answer = readAll(s);
    s.end(data);
    assert.equal((await answer).toString(), sha(data), "the answer came after the client's end");
    await closed(s);
    await quiet();
    assert.equal(notes.length, 0, "clean: not reported");
  }
  const fHold = await fw.open(H, portOf(hold));
  await settled(held);
  {
    // The service ends when the client does; the client first (a FIN, nothing lost).
    const s = await dial(fHold.localPort), got = readAll(s);
    s.write("first");
    await waitFor(() => held.length === 1 && held[0].data === "first", "the service has the client's bytes");
    assert.equal(held[0].ended, false);
    s.end(" and last");
    assert.equal((await got).length, 0, "the service's end reached the client");
    await closed(s);
    assert.deepEqual([held[0].data, held[0].ended], ["first and last", true], "the service saw the bytes, then the end");
    await quiet();
    held.length = 0;
  }
  for (const [how, go] of [["resets", s => s.resetAndDestroy()], ["just closes", s => s.destroy()]]) {
    // The client goes (a page closed): the service's socket on H closes, and nothing is left.
    const s = await dial(fHold.localPort);
    s.write("gone soon");
    await waitFor(() => held.length === 1 && held[0].data === "gone soon" && streamsOf() === 1, "the service has the connection");
    go(s);
    await waitFor(() => held[0].closed, `the service's socket closes after the client ${how}`);
    await quiet();
    held.length = 0;
  }
  {
    // The service resets: the client's connection goes too, told by "port.closed".
    const f = await fw.open(H, portOf(reset));
    const s = await dial(f.localPort);
    s.resume();
    s.write("hello");
    await closed(s, "the client's connection closes after the service reset its own");
    await waitFor(() => notes.length === 1, "port.closed");
    assert.ok(frames.UUID.test(notes[0].stream));
    await quiet();
    assert.equal(await fw.close(H, portOf(reset)), true);
    assert.equal(await fw.close(H, portOf(reset)), false, "closed already");
    await assert.rejects(dial(f.localPort), "nothing listens there any more");
  }
  pass("endings: a half close, the client first, a client that resets and one that just closes, a service that resets (port.closed) - no stream left on either side");

  // ---------- a client that does not read: H stops a window later, nothing is lost ----------
  const fSource = await fw.open(H, portOf(source));
  const ask = (seed, size) => { const b = Buffer.alloc(8); b.writeUInt32BE(seed, 0); b.writeUInt32BE(size, 4); return b; };
  {
    const size = 24 * MB, s = await dial(fSource.localPort);
    s.pause();
    const before = { ...seen }, backlogBefore = maxBacklog;
    s.write(ask(7, size));
    let last = -1, at = now();
    await waitFor(() => { if (seen.down !== last) { last = seen.down; at = now(); } return seen.down > before.down && now() - at > 1000; }, "the sender stops", 60000);
    const got = seen.down - before.down, out = got - (seen.downAcked - before.downAcked);
    assert.ok(got < size, `stopped before the end: ${got} of ${size} bytes sent by H`);
    assert.ok(out <= STREAM_WINDOW && out > STREAM_WINDOW - STREAM_PIECE, `one window is out (less at most a piece that did not fit), unacknowledged: an ack goes only for what the plugin wrote - ${out}`);
    console.log(`  a client that does not read: H stopped after ${got} bytes, ${out} unacknowledged; the plugin wrote ${plugin.written} bytes in all so far`);
    const hash = crypto.createHash("sha256");
    let length = 0;
    s.on("data", d => { hash.update(d); length += d.length; });
    await new Promise((resolve, reject) => { s.once("end", resolve); s.once("close", () => reject(new Error("closed before its end"))); s.resume(); });
    s.end();
    assert.equal(length, size, "every byte arrived once it read again");
    assert.equal(hash.digest("hex"), sha(payload(7, size)), "the same bytes, in order");
    assert.ok(seen.mostDown <= STREAM_WINDOW, `never more than a window unacknowledged: ${seen.mostDown}`);
    await closed(s);
    await quiet();
    pass(`a client that does not read: H stopped exactly one window (${STREAM_WINDOW / KB} KB) later, then all ${size / MB} MB arrived by hash; the phone's backlog towards the relay at most ${Math.round(Math.max(maxBacklog, backlogBefore) / KB)} KB`);
  }

  // ---------- a service that does not read: the plugin stops reading the client, the phone holds little ----------
  {
    const f = await fw.open(H, portOf(sloth));
    await settled(lazy);
    const size = 24 * MB, data = payload(11, size), s = await dial(f.localPort), answer = readAll(s);
    const before = plugin.delivered;
    plugin.maxUncredited = 0;
    seen.mostUp = 0;
    seen.up = seen.upAcked = 0;
    s.end(data);
    await waitFor(() => lazy.length === 1, "the service has the connection");
    let last = -1, at = now();
    await waitFor(() => { if (plugin.delivered !== last) { last = plugin.delivered; at = now(); } return plugin.delivered > before && now() - at > 1000; }, "the plugin stops reading the client", 60000);
    const read = plugin.delivered - before;
    assert.ok(read < size, `the client was stopped before its end: the plugin read ${read} of ${size} bytes`);
    const c = [...plugin.conns.values()][0];
    assert.ok(c.uncredited >= PLUGIN_WINDOW && c.uncredited < PLUGIN_WINDOW + PLUGIN_PIECE, `the plugin holds a window uncredited: ${c.uncredited}`);
    assert.ok(seen.up - seen.upAcked <= STREAM_WINDOW, `the phone has at most a window unacknowledged: ${seen.up - seen.upAcked}`);
    assert.ok(provider.buffered(H) < 64 * KB, `nothing waits on the phone for the relay: ${provider.buffered(H)}`);
    console.log(`  a service that does not read: the plugin read ${read} bytes and stopped with ${c.uncredited} uncredited; the phone sent ${seen.up}, ${seen.up - seen.upAcked} unacknowledged`);
    lazy[0].go();
    assert.equal((await answer).toString(), `${size}:${sha(data)}`, "every byte reached the service once it read, in order");
    await closed(s);
    await quiet();
    assert.ok(plugin.maxUncredited < PLUGIN_WINDOW + PLUGIN_PIECE, `never more than a window delivered and uncredited: ${plugin.maxUncredited}`);
    assert.ok(seen.mostUp <= STREAM_WINDOW, `never more than a window unacknowledged: ${seen.mostUp}`);
    assert.equal(await fw.close(H, portOf(sloth)), true);
    pass(`a service that does not read: the plugin stopped reading the client at ${PLUGIN_WINDOW / KB} KB uncredited, the phone never had more than a window out, then all ${size / MB} MB arrived by hash`);
  }

  // ---------- what cannot be forwarded: each with its code and its words, nothing left listening ----------
  {
    const listening = plugin.listeners.size, forwards = fw.list().length, views = plugin.views.length;
    const dead = await freePort();
    const e = await fw.show(H, dead, { title: "dead" }).then(() => null, x => x);
    assert.equal(e?.code, "refused", "a port nothing listens on: refused before anything is shown");
    assert.equal(ports.portError(e, { port: dead, name: "H" }), `Nothing answers on port ${dead} of H`);
    await assert.rejects(fw.open(H, dead), fails("refused"), "nor is a forward made for it");
    await assert.rejects(fw.address(H, dead), fails("refused"));
    await assert.rejects(fw.open(H, h.self().port), fails("notAllowed"), "the computer's own mesh port");
    // An older AgentDeck: its code is kept, and the sheet says to update it.
    const old = await fw.show(O, portOf(echo)).then(() => null, x => x);
    assert.equal(old?.code, "unknownMethod", "an older computer");
    assert.equal(ports.portError(old, { port: 1, name: "O" }), "Update AgentDeck on O to forward ports");
    const listO = await ports.loadPorts({ store, forwards: fw, node: O, term: uuid() });
    assert.equal(listO.error, "update", "its host.info has no ports: 1");
    assert.deepEqual(ports.portRows(listO), [{ kind: "note", text: "Update AgentDeck on O to forward ports" }]);
    await assert.rejects(fw.open(R, portOf(echo)), fails("relayOnly"), "the relay forwards nothing");
    await assert.rejects(fw.open("f".repeat(64), portOf(echo)), fails("offline"), "a computer that is not there");
    assert.equal(ports.portError({ code: "offline" }, { port: 1, name: "X" }), "X is not connected");
    assert.match(ports.portError({ code: "tooManyStreams" }, { port: 1, name: "X" }), /^Failed: Too many connections/);
    assert.deepEqual([plugin.listeners.size, fw.list().length, plugin.views.length, plugin.view], [listening, forwards, views, null], "nothing listens, is listed or shown for any of them");
    // A forward whose service went away since: asked again before the page is shown; the forward stays to be stopped.
    const gone = await listen(s => { s.on("error", () => {}); s.resume(); s.on("end", () => s.destroy()); });
    const port = portOf(gone), f = await fw.open(H, port);
    await new Promise(done => gone.close(done));
    await assert.rejects(fw.show(H, port), fails("refused"), "a forward whose service stopped: a message, not a blank page");
    assert.equal(plugin.view, null);
    // And a connection to it is refused by H and closed; the forward stays.
    const s = await dial(f.localPort);
    s.write("anyone?");
    s.resume();
    await closed(s, "a connection whose ports.open is refused is closed");
    assert.ok(fw.list().some(l => l.port === port && l.streams === 0), "the forward is still there");
    assert.equal(await fw.close(H, port), true);
    await quiet();
    pass("a dead port (refused, with its words), the mesh port, an older computer (update AgentDeck), the relay, a computer that is not there: nothing listens or shows; a forward whose service stopped says so");
  }

  // ---------- the view ----------
  {
    const hidden = [];
    fw.on("hidden", () => hidden.push(1));
    const at = await fw.show(H, portOf(echo), { title: "3000 · H" });
    assert.deepEqual(at, { ...f1, url: `http://127.0.0.1:${f1.localPort}/` }, "the address is 127.0.0.1 and the forward's own port");
    assert.deepEqual(plugin.view, { url: at.url, title: "3000 · H" });
    assert.deepEqual(fw.shown(), { node: H, port: portOf(echo) });
    assert.equal((await fw.show(H, portOf(echo), { https: true })).url, `https://127.0.0.1:${f1.localPort}/`, "as https");
    assert.equal(plugin.view.title, String(portOf(echo)), "without a title: the port");
    assert.deepEqual(await fw.address(H, portOf(echo)), { ...f1, url: `http://127.0.0.1:${f1.localPort}/` }, "the address alone, for Copy");
    // The user closes the view: the forward stays.
    plugin.userCloses();
    await waitFor(() => hidden.length === 1, "hidden");
    assert.equal(fw.shown(), null);
    assert.ok(fw.list().some(f => f.port === portOf(echo)), "the forward stays when the view is closed");
    // "Stop forwarding" of the one in view closes the view too; of another one it does not.
    await fw.show(H, portOf(sum));
    const hides = plugin.hides;
    assert.equal(await fw.close(H, portOf(hold)), true);
    assert.equal(plugin.hides, hides, "another forward stopped: the view stays");
    assert.equal(await fw.close(H, portOf(sum)), true);
    assert.deepEqual([plugin.hides, plugin.view, fw.shown()], [hides + 1, null, null], "the forward in view stopped: the view goes");
    assert.equal(hidden.length, 1, "hide() by the page is not reported as the user's");
    pass("the view: http://127.0.0.1:<the forward's port>/ with its title, as https, the address alone; closed by the user the forward stays; stopping the forward in view hides it");
  }

  // ---------- the Ports sheet's list and rows ----------
  {
    const cwd = "C:\\Work\\Shop\\", key = ports.portsKey(H, cwd);
    assert.equal(key, `${H}:c:/work/shop`, "the ports typed by hand are the folder's on that computer");
    ports.rememberPort(key, 9000);
    ports.rememberPort(key, portOf(sum));
    ports.rememberPort(key, 9000);
    assert.deepEqual(ports.savedPorts(key), [9000, portOf(sum)], "the newest first, each once");
    assert.deepEqual(ports.savedPorts(ports.portsKey(H, "/other")), [], "another folder has its own");
    const data = await ports.loadPorts({ store, forwards: fw, node: H, term: uuid(), cwd });
    assert.deepEqual([data.error, data.name, data.saved], [undefined, "H", [9000, portOf(sum)]]);
    assert.deepEqual(data.forwards.map(f => f.port).sort(), [portOf(echo), portOf(source)].sort(), "the forwards of that computer");
    assert.ok(data.ports.some(p => p.port === portOf(echo)) && data.ports.every(p => p.own === false && typeof p.process === "string"), "the listening ports, none the terminal's (there is none)");
    assert.ok(!data.ports.some(p => p.port === h.self().port), "the mesh port is not offered");
    const list = ports.portRows(data);
    assert.deepEqual(list.filter(x => x.kind === "group").map(x => x.text), ["Typed by hand or forwarded", "Listening on H"]);
    assert.ok(list.findIndex(x => x.kind === "other") < list.findIndex(x => x.text === "Listening on H"), '"Other port…" is above the rest of the ports of the computer');
    const echoRow = list.find(x => x.port === portOf(echo));
    assert.deepEqual([echoRow.active, echoRow.localPort, echoRow.saved, echoRow.title], [true, f1.localPort, false, String(portOf(echo))]);
    assert.ok(echoRow.meta.endsWith(`forwarded as 127.0.0.1:${f1.localPort}`), `a forward on another number says where: ${echoRow.meta}`);
    assert.deepEqual([list.find(x => x.port === portOf(sum)).saved, list.find(x => x.port === portOf(sum)).active], [true, false], "a listening port that was typed by hand is listed once, and can be forgotten");
    const keptAt = list.findIndex(x => x.kind === "group" && x.text === "Typed by hand or forwarded");
    assert.deepEqual(list.slice(keptAt + 1, list.findIndex(x => x.kind === "other")).map(x => x.port), [9000], "what was typed and does not listen has a group of its own, above Other port…");
    ports.forgetPort(key, 9000);
    ports.forgetPort(key, portOf(sum));
    assert.deepEqual([ports.savedPorts(key), kept.get("agentdeck.ports")], [[], "{}"], "forgotten");

    // The rows from plain data: the terminal's own first, the kept ones, "Other port…", then the rest.
    const shape = rows => rows.map(x => (x.kind === "port" ? `${x.port}${x.own ? " own" : ""}${x.active ? " on" : ""}${x.saved ? " saved" : ""} [${x.meta}]` : x.kind === "other" ? "other" : `${x.kind}: ${x.text}`));
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", ports: ports.cleanPorts([
      { port: 5432, process: "postgres", own: false }, { port: 3000, process: "node", own: true }, { port: 3000, address: "::", process: "node", own: false },
      { port: 0 }, { port: "80" }, null, { port: 8080, process: 5, own: "yes" }
    ]), forwards: [{ node: "n", port: 3000, localPort: 3000 }, { node: "n", port: 7000, localPort: 54021 }], saved: [9000, 5432] })), [
      "group: This terminal", "3000 own on [node · forwarded]",
      "group: Typed by hand or forwarded", "7000 on [forwarded as 127.0.0.1:54021]", "9000 saved []", "other",
      "group: Others on the computer", "5432 saved [postgres]", "8080 []"
    ]);
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", ports: [], forwards: [], saved: [] })), ["note: Nothing is listening on STUDIO-PC", "other"]);
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", error: "offline", saved: [9000] })), ["note: STUDIO-PC is not connected"]);
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", error: "update" })), ["note: Update AgentDeck on STUDIO-PC to forward ports"]);
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", error: "failed", message: "", saved: [9000] })), ["note: The ports could not be read", "group: Typed by hand or forwarded", "9000 saved []", "other"]);
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", error: "failed", message: "No answer in time." })).slice(0, 1), ["note: No answer in time."]);
    assert.deepEqual(["3000", " 65535 ", "0", "65536", "80a", "", "1e3"].map(ports.readPort), [3000, 65535, 0, 0, 0, 0, 0], "what the field holds, as a port");
    // A computer that is away, and one that could not read its ports.
    assert.equal((await ports.loadPorts({ store: { nodeName: () => "X", node: () => ({ node: { status: "offline" } }) }, forwards: fw, node: "x", term: "" })).error, "offline");
    const unread = { nodeName: () => "X", node: () => ({ node: { status: "online" }, info: { ports: 1 } }), ports: async () => { throw Object.assign(new Error("raw"), { code: "portsUnread" }); } };
    assert.deepEqual([(await ports.loadPorts({ store: unread, forwards: fw, node: "x", term: "" })).error, (await ports.loadPorts({ store: unread, forwards: fw, node: "x", term: "" })).message], ["failed", ""]);
    i18n.setLanguage("bg");
    assert.deepEqual(shape(ports.portRows({ name: "STUDIO-PC", error: "update" })), ["note: Обнови AgentDeck на STUDIO-PC, за да се препращат портове"]);
    i18n.setLanguage("en");
    pass("the sheet's list (the computer's ports, this phone's forwards, the ports typed by hand for the folder) and its rows: own first, the rest, the kept ones, Other port; the notes for offline, update, unread, nothing listening");
  }

  // ---------- the 65th stream ----------
  {
    assert.equal(MAX_STREAMS, 64);
    const fh = await fw.open(H, portOf(hold));
    await settled(held);
    const clients = [];
    for (let i = 0; i < MAX_STREAMS; i++) { const s = await dial(fh.localPort); s.resume(); s.write(`#${i}`); clients.push(s); }
    await waitFor(() => streamsOf() === MAX_STREAMS && held.length === MAX_STREAMS && held.every(x => x.data), "64 streams, each with its bytes at the service", 30000);
    assert.equal(fw.list().find(f => f.port === portOf(hold)).streams, MAX_STREAMS);
    const extra = await dial(fh.localPort);
    extra.resume();
    extra.write("one too many");
    await closed(extra, "the 65th connection is closed");
    assert.deepEqual([streamsOf(), held.length], [MAX_STREAMS, MAX_STREAMS], "H took 64 and refused the next");
    assert.equal(fw.list().find(f => f.port === portOf(hold)).streams, MAX_STREAMS, "the forward and its 64 stay");
    await assert.rejects(fw.show(H, portOf(echo)), fails("tooManyStreams"), "and nothing more is opened meanwhile, with H's own code");
    // Every one of them still works, each with its small share of the link.
    clients[63].write(" still here");
    await waitFor(() => held.some(x => x.data === "#63 still here"), "the 64th stream still carries bytes");
    for (const s of clients) s.destroy();
    await waitFor(() => held.every(x => x.closed), "the services' sockets close with their clients");
    await quiet();
    held.length = 0;
    pass("64 connections at once are 64 streams; the 65th is refused by H (tooManyStreams) and closed, the others go on");
  }

  // ---------- throughput through the phone's path ----------
  const table = [];
  {
    const roundTrip = async () => {
      const took = [];
      for (let i = 0; i < 5; i++) { const from = now(); await provider.request(H, "ports.close", { stream: uuid() }); took.push(now() - from); }
      return median(took);
    };
    async function download(port, size, seed) {
      const s = await dial(port), from = now(), all = readAll(s);
      s.write(ask(seed, size));
      const got = await all, took = now() - from;
      s.end();
      assert.equal(got.length, size, "the whole body");
      assert.equal(sha(got), sha(payload(seed, size)), "the same bytes, in order");
      await closed(s);
      return took;
    }
    async function upload(port, size, seed) {
      const data = payload(seed, size), s = await dial(port), from = now(), answer = readAll(s);
      s.end(data);
      assert.equal((await answer).toString(), sha(data), "the service got the same bytes, in order");
      const took = now() - from;
      await closed(s);
      return took;
    }
    const fSum = await fw.open(H, portOf(sum));
    // Nothing forwarded: the services asked on their own ports, for the scale of the table.
    table.push({ path: "no forward", rtt: 0, bytes: 8 * MB, down: kbs(8 * MB, await download(portOf(source), 8 * MB, 20)), up: kbs(8 * MB, await upload(portOf(sum), 8 * MB, 21)) });
    for (const [oneWay, bytes] of [[0, 8 * MB], [25, 2 * MB]]) {
      PV.delay = oneWay;
      const size = FORCED_MB ? FORCED_MB * MB : bytes, rtt = await roundTrip();
      assert.ok(rtt >= 2 * oneWay * 0.9, "the proxy holds the bytes at least that long");
      const down = kbs(size, await download(fSource.localPort, size, 30 + oneWay)), up = kbs(size, await upload(fSum.localPort, size, 31 + oneWay));
      table.push({ path: `phone -> relay -> H, ${oneWay} ms one way on the phone's leg`, rtt, bytes: size, down, up });
      assert.ok(down > FLOOR_KBS && up > FLOOR_KBS, `not a stall at ${oneWay} ms: ${down} / ${up} KB/s`);
      viaRelay();
      pass(`${size / MB} MB down and ${size / MB} MB up through the phone's path at a ${Math.round(rtt)} ms round trip: hashes equal, ${down} KB/s down, ${up} KB/s up`);
    }
    PV.delay = 0;
    await quiet();
  }

  // ---------- the link drops: the listeners, the connections on both sides and the view go ----------
  {
    const fh = fw.list().find(f => f.port === portOf(hold));
    await settled(held);
    const s = await dial(fh.localPort);
    s.resume();
    s.write("x");
    await waitFor(() => held.length === 1 && held[0].data === "x" && streamsOf() === 1, "a stream");
    await fw.show(H, portOf(echo), { title: "in view" });
    const listed = fw.list().map(f => f.port).sort(), hides = plugin.hides, before = changes, accepted = PV.accepted;
    assert.ok(listed.length >= 4 && plugin.listeners.size === listed.length, "a listener for each forward");
    const from = now();
    PV.drop();
    await Promise.all([closed(s, "the client's connection closes with the link"), waitFor(() => held[0].closed, "the service's socket on H closes with the link"), waitFor(() => lost.length === 1, "lost")]);
    assert.deepEqual([lost[0].node, [...lost[0].ports].sort()], [H, listed], "said once, with the ports that went");
    assert.deepEqual([fw.list(), plugin.listeners.size, plugin.conns.size], [[], 0, 0], "no forward, no listener and no connection is left on the phone");
    assert.deepEqual([plugin.view, fw.shown(), plugin.hides], [null, null, hides + 1], "the view is hidden");
    assert.equal(changes, before + 1, "one change for all of them");
    await waitFor(() => streamsOf() === 0, "H closed the phone's streams");
    await assert.rejects(dial(fh.localPort), "nothing listens on the forward's port any more");
    await assert.rejects(fw.open(H, portOf(echo)), fails("offline"), "no forward to a computer that is not connected");
    const cut = now() - from;
    // The phone comes back by itself (through the proxy), and a new forward works.
    await waitFor(() => store.computers().every(n => n.online) && !store.loading(), "the phone linked to H and O again", 40000);
    assert.ok(PV.accepted > accepted, "the new link went through the proxy");
    const again = await fw.open(H, portOf(echo));
    await echoed(again.localPort, 300 * KB, "after the reconnect");
    await quiet();
    assert.equal(lost.length, 1);
    pass(`link drop: the client's connection, the service's on H, the listeners and the view were gone ${Math.round(cut)} ms later, "lost" said once; back by itself ${Math.round(now() - from)} ms after the drop, a new forward echoed 300 KB`);
  }

  // ---------- the books ----------
  clearInterval(sampler);
  assert.deepEqual(plugin.breaches, [], "the page kept the plugin's contract: one write at a time, pieces within 64 KB, no credit beyond what was delivered");
  assert.ok(plugin.maxUncredited < PLUGIN_WINDOW + PLUGIN_PIECE, `the plugin never had more than a window delivered and uncredited: ${plugin.maxUncredited}`);
  assert.ok(maxBacklog < MB, `the phone's backlog towards the relay stayed far below the ${CLIENT_BACKLOG_LIMIT / MB} MB that closes its link: ${maxBacklog} bytes at most`);
  pass(`the phone's backlog towards the relay never passed ${Math.round(maxBacklog / KB)} KB (the link closes at ${CLIENT_BACKLOG_LIMIT / MB} MB); the plugin's contract was kept throughout`);

  // ---------- without the plugin (a browser build), and letting go ----------
  {
    const none = createForwards({ provider, plugin: null });
    assert.equal(none.available, false);
    await assert.rejects(none.open(H, portOf(echo)), fails("unavailable"));
    assert.deepEqual(none.list(), []);
    none.dispose();
    const handlers = plugin.handlerCount();
    assert.equal(handlers, 5, "connection, data, end, closed, hidden");
    fw.dispose();
    await sleep(50);
    assert.deepEqual([fw.list(), plugin.listeners.size, plugin.handlerCount()], [[], 0, 0], "dispose closes the forwards and lets go of the plugin's events");
    pass("no plugin: not available, nothing offered; dispose closes every forward and the plugin's listeners");
  }

  // ---------- with a fake provider: the plugin says "connection" before its answer to listen() ----------
  {
    const calls = [], sent = [];
    const fake = { on: () => () => {}, online: () => true, request: async (n, method) => { calls.push(method); return true; }, sendBinary: (n, bytes) => sent.push(frames.decode(bytes)) };
    const hasty = fakeForward(), listenNow = hasty.listen;
    // listen() answers only after a client connected and its "connection" and "data" were delivered.
    hasty.listen = async opts => {
      const made = await listenNow(opts);
      const s = await dial(made.port);
      s.write("early bird");
      await sleep(100);
      return made;
    };
    const ff = createForwards({ provider: fake, plugin: hasty });
    const free = await freePort();
    const f = await ff.open("n", free);
    assert.equal(f.localPort, free, "the same number when it is free here");
    await waitFor(() => sent.some(x => x.type === "stream-data"), "the early connection became a stream");
    assert.equal(Buffer.from(sent.find(x => x.type === "stream-data").bytes).toString(), "early bird", "with the bytes it had sent before the forward was known");
    assert.deepEqual(calls, ["ports.open", "ports.close", "ports.open"], "asked whether it answers, then the stream opened");
    assert.deepEqual(hasty.breaches, []);
    ff.dispose();
    hasty.stop();
    pass("a connection the plugin reports before its answer to listen() is kept, and becomes a stream with its bytes");
  }

  // ---------- the table ----------
  console.log("\nThroughput through a forward on the phone (KB/s): the fake plugin's base64 bridge, the phone's link to H inside a relay tunnel");
  const cols = [["path", x => x.path], ["round trip", x => (x.rtt ? `${Math.round(x.rtt)} ms` : "-")], ["size", x => `${x.bytes / MB} MB`], ["down KB/s", x => String(x.down)], ["up KB/s", x => String(x.up)]];
  const width = cols.map(([title, cell]) => Math.max(title.length, ...table.map(x => cell(x).length)));
  const line = cells => `  ${cells.map((c, i) => c.padEnd(width[i])).join("  ")}`;
  console.log(line(cols.map(c => c[0])));
  for (const row of table) console.log(line(cols.map(c => c[1](row))));
  console.log(`\nmobile port forwarding: all ${passed.length} checks passed`);
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
