// Forwarded ports (docs/PORT-FORWARDING.md; mesh/stream-pipe.js, host/port-streams.js, mesh/serve.js, port-forwards.js):
// nodes in one process - H serves (a host with no terminals), B and C are desktop peers, X a resource host (no
// control), V reaches H only through the hub R. TCP services on H's loopback: an echo, one that answers with the hash
// of what it got once the client ended, one that pours out SOURCE_BYTES, one that resets, one that holds.
// Checked: host.info.ports; megabytes through B's forward to the echo and back, the hashes equal; a forward is made
// once; a client that sends, ends and still gets the answer (half close); a client that does not read stops the
// sender exactly one window later, and gets every byte once it reads; the same echo through the hub; the refusals -
// a peer without control (its requests and its frames), frames for a stream another peer opened, the node's own mesh
// port, a port nobody listens on, bad ports and stream ids, the 65th stream; a service on ::1 only; a connection
// whose ports.open is refused goes and the forward stays; a forward asked for only when its port answers (refused
// for a dead one, with nothing left here); a service that resets reaches the client as "port.closed";
// an idle stream is closed; a link that drops (the peer's own, and the hub) closes the sockets on both sides and
// the forwards. With a fake links: the same port number when it is free here, unknownMethod kept. No mDNS, no Electron.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createPortStreams, MAX_STREAMS } = require("../src/host/port-streams");
const { createPortForwards } = require("../src/port-forwards");
const frames = require("../src/mesh/frames");
const { STREAM_WINDOW, STREAM_PIECE } = frames;

const SOURCE_BYTES = 64 * 1024 * 1024, MB = 1024 * 1024;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-port-forward-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = (emitter, event, test = () => true, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`no "${event}" within ${ms} ms`)); }, ms);
  const on = data => { if (test(data)) { clearTimeout(timer); emitter.off(event, on); resolve(data); } };
  emitter.on(event, on);
});
const waitFor = async (test, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 20) { if (test()) return; await sleep(20); }
  throw new Error(`timed out: ${what}`);
};
const node = (name, { kind = "desktop", api = async () => null } = {}) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
  return createLinks({ dir, defaultName: name, kind, version: "test", api, discover: false, log: () => {} });
};
const fails = code => e => e.code === code;
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const uuid = () => crypto.randomUUID();

// ---------- TCP on this machine ----------
const listen = (onConnection, host = "127.0.0.1") => new Promise((resolve, reject) => {
  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.once("error", reject);
  server.listen(0, host, () => resolve(server));
});
const dial = port => new Promise((resolve, reject) => {
  const s = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  s.once("error", reject);
  s.once("connect", () => { s.off("error", reject); s.on("error", () => {}); resolve(s); });
});
// The socket closed. These sockets stay half open, so the other side's end is answered with this side's.
const closed = s => new Promise(r => {
  if (s.destroyed) return void r();
  s.once("end", () => s.end());
  s.once("close", r);
});
// Everything a socket gets until the other side ends.
const readAll = s => new Promise((resolve, reject) => {
  const parts = [];
  s.on("data", d => parts.push(d));
  s.once("end", () => resolve(Buffer.concat(parts)));
  s.once("close", () => reject(new Error("closed before its end")));
});
// A port nothing listens on (it was free a moment ago).
async function deadPort() {
  const s = await listen(() => {});
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}
// `size` random bytes to the echo behind `port` and back: both directions at once, then the client's end.
async function echoed(port, size, what) {
  const data = crypto.randomBytes(size), s = await dial(port);
  const back = readAll(s);
  s.end(data);
  const got = await back;
  assert.equal(got.length, size, `${what}: every byte came back`);
  assert.equal(sha(got), sha(data), `${what}: the same bytes, in order`);
  await closed(s);
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
  // ---------- the services on H's computer ----------
  const echo = await listen(s => { s.on("error", () => {}); s.pipe(s); });
  const sum = await listen(s => { s.on("error", () => {}); readAll(s).then(all => s.end(sha(all)), () => {}); });
  // Pours out SOURCE_BYTES in megabytes that all differ, as fast as its socket takes them. Counted for each
  // connection apart - `source` is the newest one: a forward first looks whether the port answers on this machine
  // (port-forwards.js), and here it does, the service being on the same one.
  const block = crypto.randomBytes(MB);
  let source = null;
  const pour = await listen(s => {
    s.on("error", () => {});
    const mine = source = { sent: 0, hash: crypto.createHash("sha256") };
    const more = () => {
      while (mine.sent < SOURCE_BYTES) {
        const piece = Buffer.from(block);
        piece.writeUInt32BE(mine.sent / MB, 0);
        mine.hash.update(piece);
        mine.sent += MB;
        if (!s.write(piece)) return void s.once("drain", more);
      }
      s.end();
    };
    more();
  });
  const reset = await listen(s => { s.on("error", () => {}); s.once("data", () => s.resetAndDestroy()); });
  const held = [];
  const hold = await listen(s => { s.on("error", () => {}); s.resume(); s.on("end", () => s.end()); held.push(s); });
  const sunk = [];
  const sink = await listen(s => { s.on("error", () => {}); const got = { data: "", ended: false }; sunk.push(got); s.on("data", d => { got.data += d; }); s.on("end", () => { got.ended = true; s.end(); }); });
  // A forward first looks whether its port answers on this machine (port-forwards.js) - and here it does, the service
  // being on the same one: that connection came to `hold` too, and went at once. Forgotten before the real one.
  const unprobed = async () => { await sleep(200); held.length = 0; };
  const servers = [echo, sum, pour, reset, hold, sink];
  stops.push(() => servers.forEach(s => s.close()));
  const portOf = s => s.address().port;

  // ---------- the nodes ----------
  const served = createServed({ host: makeHost() });
  const h = node("H", { api: (m, p, peer) => served.api(m, p, peer) });
  const b = node("B"), c = node("C"), x = node("X", { kind: "host" }), r = node("R"), v = node("V");
  const all = [h, b, c, x, r, v];
  stops.push(() => all.forEach(l => l.stop()));
  const H = (await h.start()).id;
  served.attach(h);
  const id = {};
  for (const [name, l] of Object.entries({ B: b, C: c, X: x, R: r })) {
    id[name] = (await l.start()).id;
    await l.pair("127.0.0.1", h.self().port, h.self().code);
    await sleep(1100); // one pairing per second from one address (pair-guard.js)
  }
  await waitFor(() => [b, c, x, r].every(l => l.online(H)) && Object.values(id).every(i => h.online(i)), "every peer linked");
  // V knows only the hub R, and pairs with H through it.
  id.V = (await v.start()).id;
  await v.pair("127.0.0.1", r.self().port, r.self().code);
  await waitFor(() => v.online(id.R) && v.discovered().some(n => n.id === H), "V sees H through the hub");
  await v.pair(H, 0, h.self().code);
  await waitFor(() => v.online(H) && h.online(id.V), "V linked to H through the hub");
  assert.equal(v.nodes().find(n => n.id === H).via.length, 1, "through the hub");
  assert.equal(h.peers().get(id.X).control, false, "X is a host: no control");

  const events = { B: [], V: [] };
  b.on("event", e => e.node === H && events.B.push(e));
  v.on("event", e => e.node === H && events.V.push(e));
  const streamsOf = who => served.ports.count(id[who]);

  // ---------- host.info ----------
  assert.equal((await b.call(H, "host.info")).ports, 1, "the capability");
  assert.equal((await b.call(H, "host.info")).terminals, 2, "next to the terminals'");

  // ---------- B forwards the echo ----------
  const fb = createPortForwards({ links: b });
  stops.push(() => fb.dispose());
  let changes = 0;
  fb.on("change", () => { changes++; });
  const [f1, f2] = await Promise.all([fb.open(H, portOf(echo)), fb.open(H, portOf(echo))]);
  assert.deepEqual(f1, f2, "asked twice at once: one forward");
  assert.deepEqual(await fb.open(H, portOf(echo)), f1, "and again: the same");
  assert.deepEqual([f1.node, f1.port], [H, portOf(echo)]);
  assert.notEqual(f1.localPort, portOf(echo), "that number is taken on this machine: another one");
  assert.deepEqual(fb.list(), [{ ...f1, streams: 0 }]);
  assert.equal(changes, 1, "one change");
  await echoed(f1.localPort, 8 * MB, "direct");
  // Several connections at once, each a stream of its own.
  await Promise.all([1, 2, 3, 4].map(i => echoed(f1.localPort, MB + i, `at once #${i}`)));
  await waitFor(() => !fb.list()[0].streams && !streamsOf("B"), "the streams went with their connections");
  assert.ok(!events.B.some(e => e.name === "port.closed"), "a clean end is not reported");

  // ---------- half close: the client sends, ends, and still gets the answer ----------
  {
    const f = await fb.open(H, portOf(sum));
    const data = crypto.randomBytes(MB), s = await dial(f.localPort);
    const answer = readAll(s);
    s.end(data);
    assert.equal((await answer).toString(), sha(data), "the answer came after the client's end");
    await closed(s);
    assert.equal(await fb.close(H, portOf(sum)), true);
    assert.equal(await fb.close(H, portOf(sum)), false, "closed already");
    await assert.rejects(dial(f.localPort), "nothing listens there any more");
    assert.equal(changes, 3);
  }

  // ---------- a client that does not read: the sender stops one window later, nothing is lost ----------
  {
    const f = await fb.open(H, portOf(pour));
    // What H sent B of the stream, and what B acknowledged to H; never more than a window apart.
    let got = 0, acked = 0, most = 0;
    const onData = ({ node: from, data }) => {
      const fr = frames.decode(data);
      if (from === H && fr?.type === "stream-data") { got += fr.bytes.length; most = Math.max(most, got - acked); }
    };
    const onAck = ({ node: from, data }) => {
      const fr = frames.decode(data);
      if (from === id.B && fr?.type === "stream-ack") acked += fr.count;
    };
    b.on("binary", onData);
    h.on("binary", onAck);
    const s = await dial(f.localPort);
    s.pause();
    // Stopped: nothing new for a second.
    let last = 0, at = Date.now();
    await waitFor(() => { if (got !== last) { last = got; at = Date.now(); } return got > 0 && Date.now() - at > 1000; }, "the sender stops", 60000);
    assert.ok(got < SOURCE_BYTES && source.sent < SOURCE_BYTES, `stopped before the end: ${got} got, ${source.sent} written by the service`);
    // A piece goes out whole or waits (stream-pipe.js): what is out is a window, less at most the piece that did not
    // fit any more - how the service's writes were cut into reads decides (64 KB ones on Windows, others on Linux).
    assert.ok(got - acked <= STREAM_WINDOW && got - acked > STREAM_WINDOW - STREAM_PIECE, `one window is out, unacknowledged: ${got - acked}`);
    console.log(`  a client that does not read: the sender stopped after ${got} bytes (${got - acked} unacknowledged), the service after ${source.sent}`);
    const hash = crypto.createHash("sha256");
    let length = 0;
    s.on("data", d => { hash.update(d); length += d.length; });
    await new Promise((resolve, reject) => { s.once("end", resolve); s.once("close", () => reject(new Error("closed before its end"))); s.resume(); });
    s.end();
    assert.equal(length, SOURCE_BYTES, "every byte arrived once it read again");
    assert.equal(hash.digest("hex"), source.hash.digest("hex"), "the same bytes, in order");
    assert.ok(most <= STREAM_WINDOW, `never more than a window unacknowledged: ${most}`);
    b.off("binary", onData);
    h.off("binary", onAck);
    await closed(s);
    await fb.close(H, portOf(pour));
  }

  // ---------- the same through the hub ----------
  const fv = createPortForwards({ links: v });
  stops.push(() => fv.dispose());
  const viaHub = await fv.open(H, portOf(echo));
  await echoed(viaHub.localPort, 4 * MB, "through the hub");
  await Promise.all([1, 2].map(i => echoed(viaHub.localPort, MB + i, `through the hub, at once #${i}`)));

  // ---------- refusals ----------
  // A peer without control: its requests, its forward, its frames.
  await assert.rejects(x.call(H, "ports.open", { stream: uuid(), port: portOf(echo) }), fails("relayOnly"), "a host may not ask");
  await assert.rejects(x.call(H, "ports.list"), fails("relayOnly"));
  const fx = createPortForwards({ links: x });
  stops.push(() => fx.dispose());
  await assert.rejects(fx.open(H, portOf(echo)), fails("relayOnly"), "nor forward");
  assert.deepEqual(fx.list(), []);
  assert.equal(streamsOf("X"), 0);
  // The mesh port, a port nobody listens on, what is not a port or a stream id.
  await assert.rejects(b.call(H, "ports.open", { stream: uuid(), port: h.self().port }), fails("notAllowed"), "the node's own mesh port");
  const dead = await deadPort();
  await assert.rejects(b.call(H, "ports.open", { stream: uuid(), port: dead }), fails("refused"), "nobody listens there");
  for (const port of [0, -1, 65536, 1.5, "80", null, undefined, {}]) await assert.rejects(b.call(H, "ports.open", { stream: uuid(), port }), fails("invalidData"), `port ${JSON.stringify(port)}`);
  for (const stream of ["", "abc", 5, null, undefined, `${uuid()}x`]) await assert.rejects(b.call(H, "ports.open", { stream, port: portOf(echo) }), fails("invalidData"), `stream ${JSON.stringify(stream)}`);
  assert.equal(await b.call(H, "ports.open", { stream: uuid(), port: portOf(echo), host: "example.com", address: "10.0.0.1" }), true, "an address in the request means nothing: loopback it is");
  await assert.rejects(b.call(H, "ports.close", {}), fails("invalidData"));
  await assert.rejects(b.call(H, "ports.list", { term: 5 }), fails("invalidData"));
  // The list itself is host/ports.js's (test-ports-list.js); here only that it comes through, when that file is there.
  if (fs.existsSync(path.join(__dirname, "../src/host/ports.js"))) {
    const list = await b.call(H, "ports.list", { term: uuid() });
    assert.ok(list.some(l => l.port === portOf(echo)), "ports.list names the echo's port");
    assert.ok(list.every(l => l.own === false), "a terminal that is not there owns none");
  }
  assert.equal(await b.call(H, "ports.close", { stream: uuid() }), true, "closing what is not there does nothing");
  await waitFor(() => streamsOf("B") === 1, "only the stream with the stray fields is left");

  // Frames for a stream another peer opened: dropped, also from one that may send frames (C asked for ports).
  {
    const stream = uuid();
    assert.equal(await b.call(H, "ports.open", { stream, port: portOf(sink) }), true);
    await assert.rejects(b.call(H, "ports.open", { stream, port: portOf(sink) }), fails("invalidData"), "a stream id in use");
    await c.call(H, "ports.close", { stream: uuid() });
    for (const l of [c, x]) {
      l.sendBinary(H, frames.encodeStreamData(stream, Buffer.from("evil")));
      l.sendBinary(H, frames.encodeStreamEnd(stream));
    }
    assert.equal(await c.call(H, "ports.close", { stream }), true, "nor can it close it");
    await sleep(300);
    b.sendBinary(H, frames.encodeStreamData(stream, Buffer.from("good")));
    await waitFor(() => sunk.at(-1)?.data === "good", `only its opener's bytes arrive: ${JSON.stringify(sunk.at(-1))}`);
    assert.equal(sunk.at(-1).ended, false, "another peer's end did not end it");
    b.sendBinary(H, frames.encodeStreamEnd(stream));
    await waitFor(() => sunk.at(-1).ended, "its opener's end does");
    await waitFor(() => streamsOf("B") === 1, "and the stream is over (the service ended too)");
    assert.equal(sunk.at(-1).data, "good");
    assert.deepEqual([streamsOf("C"), streamsOf("X")], [0, 0]);
  }

  // A service on ::1 only is found (where this machine has IPv6).
  {
    const six = await listen(s => s.end("six"), "::1").catch(() => null);
    if (!six) console.log("  no ::1 here: a service on ::1 only is not checked");
    else {
      const stream = uuid();
      assert.equal(await b.call(H, "ports.open", { stream, port: portOf(six) }), true, "::1 after 127.0.0.1 refused");
      await b.call(H, "ports.close", { stream });
      six.close();
    }
  }

  // The 65th stream.
  {
    const before = streamsOf("B"), ids = Array.from({ length: MAX_STREAMS - before }, uuid);
    assert.equal(MAX_STREAMS, 64);
    await Promise.all(ids.map(stream => b.call(H, "ports.open", { stream, port: portOf(hold) })));
    assert.equal(streamsOf("B"), 64);
    await assert.rejects(b.call(H, "ports.open", { stream: uuid(), port: portOf(hold) }), fails("tooManyStreams"), "the 65th");
    const other = uuid();
    assert.equal(await c.call(H, "ports.open", { stream: other, port: portOf(hold) }), true, "the limit is each peer's own");
    await Promise.all([...ids.map(stream => b.call(H, "ports.close", { stream })), c.call(H, "ports.close", { stream: other })]);
    assert.deepEqual([streamsOf("B"), streamsOf("C")], [before, 0]);
    await waitFor(() => held.every(s => s.destroyed), "ports.close closes the socket to the service");
    held.length = 0;
  }

  // A connection whose ports.open is refused goes; the forward stays.
  {
    // It lets go of what connects to it (the forward looking whether the port answers here), so that it can close.
    const gone = await listen(s => { s.on("error", () => {}); s.resume(); s.on("end", () => s.destroy()); });
    const port = portOf(gone), f = await fb.open(H, port);
    await new Promise(done => gone.close(done));
    const s = await dial(f.localPort);
    s.write("anyone?");
    s.resume();
    await closed(s);
    assert.ok(fb.list().some(l => l.port === port && l.streams === 0), "the forward is still there");
    await fb.close(H, port);
  }

  // A forward asked for only when its port answers (what the app's menu does): a port nobody listens on and the mesh
  // port are refused with H's code and leave nothing here; one that answers is forwarded, and the stream that asked
  // is closed again; a forward that is there already is given unasked, its service gone or not.
  {
    const before = fb.list().length, streams = streamsOf("B"), none = await deadPort();
    await assert.rejects(fb.open(H, none, { answers: true }), fails("refused"), "nobody listens there: no forward");
    await assert.rejects(fb.open(H, h.self().port, { answers: true }), fails("notAllowed"), "the mesh port: no forward");
    assert.equal(fb.list().length, before, "nothing was added");
    await assert.rejects(dial(none), "and nothing listens here for it");
    const gone = await listen(s => { s.on("error", () => {}); s.resume(); s.on("end", () => s.destroy()); });
    const port = portOf(gone), f = await fb.open(H, port, { answers: true });
    await waitFor(() => streamsOf("B") === streams, "the stream that asked is closed on H");
    await new Promise(done => gone.close(done));
    assert.deepEqual(await fb.open(H, port, { answers: true }), f, "there already: given as it is, though nothing listens now");
    await fb.close(H, port);
    await assert.rejects(fb.open(H, port, { answers: true }), fails("refused"), "stopped: asked again, and refused");
    await assert.rejects(fx.open(H, portOf(echo), { answers: true }), fails("relayOnly"), "a peer without control: its own code");
  }

  // A service that resets the connection: the client's goes too, told by "port.closed".
  {
    const f = await fb.open(H, portOf(reset));
    const s = await dial(f.localPort);
    s.resume();
    s.write("hello");
    await closed(s);
    await waitFor(() => events.B.some(e => e.name === "port.closed"), "port.closed");
    assert.ok(frames.UUID.test(events.B.find(e => e.name === "port.closed").data.stream));
    await fb.close(H, portOf(reset));
  }

  // ---------- an idle stream (port-streams.js on its own, with a short limit) ----------
  {
    const said = [];
    const streams = createPortStreams({ send: () => {}, notify: (peer, name, data) => said.push([peer, name, data]), idleMs: 400 });
    const stream = uuid();
    assert.equal(await streams.open("p", stream, portOf(hold)), true);
    await waitFor(() => held.length === 1, "connected");
    await sleep(200);
    streams.frame("p", frames.decode(frames.encodeStreamData(stream, Buffer.from("still here"))));
    await sleep(250);
    assert.deepEqual([streams.count("p"), said.length], [1, 0], "traffic keeps it");
    await waitFor(() => held[0].destroyed, "closed once idle", 3000);
    assert.deepEqual(said, [["p", "port.closed", { stream }]], "and its peer is told");
    assert.equal(streams.count("p"), 0);
    held.length = 0;
  }

  // ---------- a link that drops ----------
  // The hub goes: V's client and H's socket to the service both close, V's forwards too.
  {
    const f = await fv.open(H, portOf(hold));
    await unprobed();
    const s = await dial(f.localPort);
    s.resume();
    s.write("x");
    await waitFor(() => held.length === 1 && streamsOf("V") === 1, "a stream through the hub");
    const changed = new Promise(done => fv.on("change", done));
    r.stop();
    await Promise.all([closed(s), closed(held[0]), changed]);
    assert.deepEqual(fv.list(), [], "its forwards went with the link");
    assert.equal(streamsOf("V"), 0);
    await assert.rejects(dial(f.localPort), "nothing listens there any more");
    await assert.rejects(fv.open(H, portOf(echo)), fails("offline"), "no forward to a node that is not connected");
    held.length = 0;
  }
  // B's own link, with a stream and a second idle forward.
  {
    const f = await fb.open(H, portOf(hold));
    await unprobed();
    const s = await dial(f.localPort);
    s.resume();
    s.write("x");
    await waitFor(() => held.length === 1 && streamsOf("B") === 2, "a stream");
    assert.equal(fb.list().length, 2);
    const down = until(h, "link", l => !l.up && l.node === id.B);
    b.stop();
    await Promise.all([closed(s), closed(held[0]), down]);
    assert.deepEqual(fb.list(), []);
    assert.equal(streamsOf("B"), 0, "the stream B opened by hand went as well");
    await assert.rejects(dial(f1.localPort), "the first forward's listener is gone too");
  }

  // ---------- with a fake links: the port number, an older node ----------
  {
    const fake = Object.assign(new EventEmitter(), { online: () => true, sendBinary() {}, call: async () => true });
    const ff = createPortForwards({ links: fake });
    const free = await deadPort();
    assert.deepEqual(await ff.open("n", free), { node: "n", port: free, localPort: free }, "the same number when it is free here");
    const taken = await listen(() => {});
    assert.notEqual((await ff.open("n", portOf(taken))).localPort, portOf(taken), "another when it is not");
    assert.equal(ff.list().length, 2);
    fake.emit("link", { node: "other", up: false });
    assert.equal(ff.list().length, 2, "another node's link");
    fake.emit("link", { node: "n", up: false });
    assert.deepEqual(ff.list(), []);
    taken.close();
    fake.call = async () => { throw Object.assign(new Error("Unknown method."), { code: "unknownMethod" }); };
    await assert.rejects(ff.open("n", free), fails("unknownMethod"), "an older node: its code is kept");
    assert.deepEqual(ff.list(), []);
    for (const port of [0, 65536, "80", 2.5]) await assert.rejects(ff.open("n", port), fails("invalidData"));
    fake.online = () => false;
    await assert.rejects(ff.open("n", free), fails("offline"));
    ff.dispose();
    assert.deepEqual(["binary", "event", "link"].map(e => fake.listenerCount(e)), [0, 0, 0], "dispose lets go of the links");
  }

  console.log("port forwarding: all checks passed");
}

const watchdog = setTimeout(() => { console.error("the test did not finish in time"); process.exit(1); }, 240000);
main().then(() => 0, e => { console.error(e); return 1; }).then(async code => {
  clearTimeout(watchdog);
  for (const stop of stops.reverse()) try { stop(); } catch {}
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(code);
});
