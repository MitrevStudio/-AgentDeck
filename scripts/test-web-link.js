// The phone's web link (docs/MOBILE.md; src/mesh/web-link.js, web-client.js): a relay R (relay only, as installed on
// a VPS), two desktops A and B paired with it over TLS, and a "phone" (web-client.js over `ws`) - all on loopback, no
// mDNS. What this pins:
//   * one port for both: computers keep linking over TLS on the port the phone reaches with a plain WebSocket;
//   * the phone pairs with the relay by its long code and with A by A's code through the relay, end to end; a wrong
//     code is refused and the next try waits (counted by the neighbour a tunnel came through);
//   * a man in the middle that runs its own handshake with each side cannot pair in the phone's place;
//   * requests, events and binary frames both ways through the tunnel, also megabytes (chunked);
//   * the phone is a leaf: in nobody's routes, never called, served nothing by a relay; it gets the routes;
//   * the phone comes back by itself after the relay restarts; retryNow dials at once without dropping live links,
//     and with `drop` makes a dead link again; a new name (the phone's, a computer's) reaches live links;
//   * a phone A forgot is told so (and drops A); one that missed it is refused as "unpaired";
//   * a phone reaches a computer directly (same network), without a relay.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createWebClient } = require("../src/mesh/web-client");
const webLink = require("../src/mesh/web-link");
const noise = require("../src/mesh/noise");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-weblink-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, ms = 30000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await sleep(50); } throw new Error("condition timeout"); };
const until = (emitter, event, test = () => true, ms = 30000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
  const on = data => { if (test(data)) { clearTimeout(timer); emitter.off(event, on); resolve(data); } };
  emitter.on(event, on);
});
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const BIG = 5 * 1024 * 1024;
const node = (name, { kind = "desktop", relayOnly = false, port = 0 } = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port }));
  const api = (method, params, peer) => (method === "big" ? { big: "x".repeat(BIG) } : { answered: `${name}:${method}`, params, peer });
  return createLinks({ dir: path.join(root, name), defaultName: name, kind, version: "test", api, relayOnly, discover: false, log: () => {} });
};
const phoneOf = (keypair, peers = []) => {
  const saved = { peers };
  const client = createWebClient({ WebSocket, keypair, peers, name: "Phone", version: "test", onPeersChanged: p => { saved.peers = p; } });
  client.saved = saved;
  return client;
};

(async () => {
  const all = [], phones = [];
  try {
    const rPort = await freePort();
    let r = node("R", { kind: "host", relayOnly: true, port: rPort });
    const a = node("A"), b = node("B");
    all.push(r, a, b);
    const selfR = await r.start(), selfA = await a.start(), selfB = await b.start();
    assert.equal(selfR.port, rPort);
    for (const x of [a, b]) await x.pair("127.0.0.1", rPort, r.self().code);
    await wait(() => a.online(selfR.id) && b.online(selfR.id) && r.online(selfA.id) && r.online(selfB.id));
    await wait(() => a.discovered().some(n => n.id === selfB.id));
    assert.ok(fs.existsSync(path.join(root, "R", "noise.json")), "each node has a Noise key of its own");

    // ---------- pairing with the relay: its long code ----------
    const keys = noise.generateKeypair();
    const phone = phoneOf(keys);
    phones.push(phone);
    phone.start();
    await assert.rejects(phone.pairDirect("127.0.0.1", rPort, "0000-0000-0000-0000-0000-0000-00"), e => e.code === "wrongCode");
    assert.equal(r.self().pairFailures.failures, 1);
    await assert.rejects(phone.pairDirect("127.0.0.1", rPort, r.self().code), e => e.code === "pairLater", "the next try waits");
    await sleep(1100);
    const codeR = r.self().code;
    const hub = await phone.pairDirect("127.0.0.1", rPort, codeR);
    assert.equal(hub.id, selfR.id, "the relay says who it is inside the channel");
    assert.notEqual(r.self().code, codeR, "a new code after a pairing");
    const mine = r.peers().get(phone.id);
    assert.equal(mine.kind, "mobile");
    assert.equal(mine.key, phone.key);
    assert.equal(mine.control, true);
    assert.equal(phone.id, noise.idOf(keys.publicKey));
    assert.deepEqual(phone.saved.peers.map(p => p.id), [selfR.id], "the caller is told what to keep");
    await wait(() => phone.online(selfR.id) && r.online(phone.id));
    // TLS on the same port still works: A and B stay linked with R, and A reaches B through R.
    assert.ok(a.online(selfR.id) && b.online(selfR.id));
    assert.ok(r.nodes().find(n => n.id === phone.id).relayOnly, "a phone serves nothing: nothing to fetch from it");

    // ---------- the phone is a leaf ----------
    await wait(() => ["A", "B"].every(n => phone.routes().some(x => x.name === n && x.web)));
    await sleep(300);
    for (const x of [r, a, b]) assert.ok(!x.discovered().some(n => n.id === phone.id), "the phone is in nobody's routes");
    assert.ok(!a.nodes().some(n => n.id === phone.id));
    await assert.rejects(a.pair(phone.id, 0, "123456"), "nobody can open a tunnel to the phone");
    await assert.rejects(phone.call(selfR.id, "sessions.list"), e => e.code === "relayOnly", "a relay serves the phone nothing but routes");
    await assert.rejects(r.call(phone.id, "anything"), e => e.code === "unknownMethod", "a phone serves nothing");

    // ---------- pairing with A through the relay: A's code ----------
    await assert.rejects(phone.pairVia(selfA.id, "000000"), e => e.code === "wrongCode");
    assert.match(a.self().pairFailures.lastSource, /^via R /, "a tunnelled try counts against the neighbour it came through");
    await assert.rejects(phone.pairVia(selfA.id, a.self().code), e => e.code === "pairLater");
    await sleep(1100);
    await phone.pairVia(selfA.id, a.self().code);
    await wait(() => phone.online(selfA.id) && a.online(phone.id));
    assert.equal(phone.nodes().find(n => n.id === selfA.id).via, selfR.id, "reached through the relay");
    assert.equal(a.peers().get(phone.id).kind, "mobile");
    assert.equal(a.nodes().find(n => n.id === phone.id).kind, "mobile");
    assert.equal(b.peers().get(phone.id), null, "B knows nothing of it");
    assert.ok(phone.routes().some(x => x.id === selfB.id && !x.paired));
    assert.equal(phone.online(selfB.id), false);

    // ---------- requests, events, binary frames, through the tunnel ----------
    const answer = await phone.call(selfA.id, "sessions.list", { limit: 3 });
    assert.equal(answer.answered, "A:sessions.list");
    assert.deepEqual(answer.params, { limit: 3 });
    assert.deepEqual(answer.peer, { id: phone.id, name: "Phone", kind: "mobile" }, "served as a mobile peer");
    assert.equal((await phone.call(selfA.id, "big", {}, { timeout: 60000 })).big.length, BIG, "megabytes in one answer");
    const toPhone = until(phone, "event", e => e.node === selfA.id && e.name === "data");
    a.notify(phone.id, "data", { sessions: 2 });
    assert.deepEqual((await toPhone).data, { sessions: 2 });
    const toA = until(a, "event", e => e.node === phone.id && e.name === "hi");
    phone.notify(selfA.id, "hi", { x: 1 });
    assert.deepEqual((await toA).data, { x: 1 });
    const out = Buffer.alloc(3 * 1024 * 1024 + 7, 7);
    const binPhone = until(phone, "binary", e => e.node === selfA.id, 60000);
    a.sendBinary(phone.id, out);
    const gotPhone = (await binPhone).data;
    assert.ok(gotPhone instanceof Uint8Array && !Buffer.isBuffer(gotPhone), "the phone gets plain bytes");
    assert.ok(Buffer.from(gotPhone).equals(out));
    const back = new Uint8Array(3 * 1024 * 1024 + 11).fill(9);
    const binA = until(a, "binary", e => e.node === phone.id, 60000);
    phone.sendBinary(selfA.id, back);
    const gotA = (await binA).data;
    assert.ok(Buffer.isBuffer(gotA) && gotA.equals(Buffer.from(back)), "a node gets a Buffer, as from a computer");

    // ---------- a man in the middle ----------
    // M answers where the phone was told B is, runs a handshake of its own with the phone and another with B, and
    // passes every frame on. The phone's proof is bound to (phone, M, its handshake), B's to (M', B, another): B
    // refuses, nobody trusts anybody, and the code is never on the wire.
    const seen = [];
    const keys2 = noise.generateKeypair();
    const mitm = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    mitm.on("connection", async ws => {
      try {
        const near = (await webLink.handshake(webLink.wsPipe(ws), { initiator: false, s: noise.generateKeypair() })).socket;
        const farWs = new WebSocket(`ws://127.0.0.1:${selfB.port}/`);
        const farPipe = webLink.wsPipe(farWs);
        await new Promise(res => farWs.addEventListener("open", res));
        const far = (await webLink.handshake(farPipe, { initiator: true, s: noise.generateKeypair() })).socket;
        near.on("message", d => { seen.push(String(d)); far.send(d); });
        far.on("message", d => { seen.push(String(d)); near.send(d); });
        near.on("close", () => far.close());
        far.on("close", () => near.close());
        near.resume(); far.resume();
      } catch {}
    });
    await new Promise(res => mitm.once("listening", res));
    const codeB = b.self().code;
    const phone2 = phoneOf(keys2);
    phones.push(phone2);
    phone2.start();
    await assert.rejects(phone2.pairDirect("127.0.0.1", mitm.address().port, codeB), e => e.code === "wrongCode");
    assert.ok(seen.length >= 3, "the messages did pass through the middle");
    assert.ok(!seen.some(t => t.includes(codeB)), "the code is never sent");
    assert.equal(phone2.nodes().length, 0, "the phone trusts nobody");
    assert.equal(b.nodes().filter(n => n.kind === "mobile").length, 0, "nor does B");
    mitm.close();
    await sleep(1100);

    // ---------- straight to a computer, no relay ----------
    const direct = await phone2.pairDirect("127.0.0.1", selfB.port, b.self().code);
    assert.equal(direct.id, selfB.id);
    await wait(() => phone2.online(selfB.id));
    assert.equal(phone2.nodes()[0].direct, true);
    assert.equal((await phone2.call(selfB.id, "ping")).answered, "B:ping");
    // B is a relay too: phone2 sees A behind it.
    await wait(() => phone2.routes().some(x => x.id === selfA.id && x.via === selfB.id));
    phone2.stop();

    // ---------- the relay goes and comes back ----------
    const lost = until(phone, "link", e => e.node === selfA.id && !e.up);
    r.stop();
    await lost;
    await wait(() => !phone.online(selfR.id));
    r = node("R", { kind: "host", relayOnly: true, port: rPort });
    all.push(r);
    await r.start();
    await wait(() => phone.online(selfR.id) && phone.online(selfA.id), 45000);
    assert.equal((await phone.call(selfA.id, "after")).answered, "A:after");

    // ---------- new names over live links, retryNow, a dead link made again ----------
    // phone3 has two hubs: R, and B directly.
    const phone3 = phoneOf(noise.generateKeypair());
    phones.push(phone3);
    phone3.start();
    await phone3.pairDirect("127.0.0.1", rPort, r.self().code);
    await phone3.pairDirect("127.0.0.1", selfB.port, b.self().code);
    await wait(() => phone3.online(selfR.id) && phone3.online(selfB.id));
    const tag = id => (id === selfB.id ? "B" : id === selfR.id ? "R" : id.slice(0, 8));
    const linkLog = [];
    phone3.on("link", e => linkLog.push(`${tag(e.node)} ${e.up ? "up" : "down"}`));
    // The phone renamed: B and R hear it over the links that are up (no new link), and keep it.
    assert.equal(phone3.setName("  Renamed phone  "), "Renamed phone");
    await wait(() => [b, r].every(x => x.nodes().find(n => n.id === phone3.id)?.name === "Renamed phone" && x.peers().get(phone3.id)?.name === "Renamed phone"), 5000);
    // A computer renamed: the phone, R (a computer's link) and what R tells its phones (the routes) hear it.
    b.setSelf({ name: "B renamed" });
    await wait(() => phone3.nodes().find(n => n.id === selfB.id)?.name === "B renamed" && phone3.peers().find(p => p.id === selfB.id)?.name === "B renamed"
      && r.nodes().find(n => n.id === selfB.id)?.name === "B renamed" && phone.routes().find(x => x.id === selfB.id)?.name === "B renamed", 5000);
    b.setSelf({ name: "B" });
    await wait(() => phone3.nodes().find(n => n.id === selfB.id)?.name === "B", 5000);
    assert.deepEqual(linkLog, [], "renamed without a link made again");
    // The relay goes: its first try again fails (the next one waits 4 s); it comes back, and retryNow dials it at
    // once. B's link stays up throughout.
    r.stop();
    await wait(() => phone3.nodes().find(n => n.id === selfR.id)?.error, 15000);
    const failedAt = Date.now();
    r = node("R", { kind: "host", relayOnly: true, port: rPort });
    all.push(r);
    await r.start();
    phone3.retryNow();
    phone.retryNow();
    await wait(() => phone3.online(selfR.id), 10000);
    assert.ok(Date.now() - failedAt < 3500, `R dialled at once, not at the next backoff step (${Date.now() - failedAt} ms)`);
    assert.deepEqual(linkLog, ["R down", "R up"], "B's link stayed up");
    // A link found dead (what wake's probe finds): dropped and made again - "link" down then up, the node offline in
    // between, as for any lost link.
    linkLog.length = 0;
    const statuses = [];
    const onNodes = list => statuses.push(list.find(n => n.id === selfB.id)?.status);
    phone3.on("nodes", onNodes);
    phone3.retryNow({ drop: [selfB.id] });
    await wait(() => linkLog.includes("B up"), 10000);
    phone3.off("nodes", onNodes);
    assert.deepEqual(linkLog, ["B down", "B up"]);
    assert.equal(statuses[0], "offline");
    assert.equal(statuses.at(-1), "online");
    assert.equal((await phone3.call(selfB.id, "ping")).answered, "B:ping", "the new link works");
    await wait(() => b.nodes().find(n => n.id === phone3.id)?.status === "online");
    phone3.stop();
    await wait(() => phone.online(selfR.id) && phone.online(selfA.id), 45000);

    // ---------- forgotten ----------
    const peersBefore = phone.saved.peers;
    const dropped = until(phone, "nodes", list => !list.some(n => n.id === selfA.id));
    a.forget(phone.id);
    await dropped;
    assert.ok(!phone.saved.peers.some(p => p.id === selfA.id), "the phone forgets A when A forgets it");
    assert.equal(a.peers().get(phone.id), null);
    // A phone that missed it (its old list, the same key) comes to talk: refused as unpaired.
    phone.stop();
    const stale = phoneOf(keys, peersBefore);
    phones.push(stale);
    stale.start();
    await wait(() => stale.nodes().find(n => n.id === selfA.id)?.error === "unpaired", 45000);
    assert.equal(stale.online(selfA.id), false);
    assert.equal(a.peers().get(phone.id), null, "and it is not let in");
    stale.forget(selfR.id);
    await wait(() => !r.peers().get(phone.id));

    // ---------- connections that say nothing ----------
    // Until its handshake is through a web connection is nobody (pair-guard.js createAdmission): at most
    // ADMIT_PER_SOURCE of one source wait - one more pushes that source's oldest out - and none of them holds a place
    // among those waiting to pair, so a paired phone from the same address still comes in.
    const { ADMIT_PER_SOURCE } = require("../src/mesh/pair-guard");
    const silent = [];
    for (let i = 0; i < ADMIT_PER_SOURCE + 2; i++) {
      const w = new WebSocket(`ws://127.0.0.1:${selfB.port}/`);
      w.on("error", () => {});
      await new Promise(res => { w.once("open", res); w.once("close", res); });
      silent.push(w);
    }
    await wait(() => silent.filter(w => w.readyState === WebSocket.OPEN).length === ADMIT_PER_SOURCE, 5000);
    assert.ok(silent.slice(0, 2).every(w => w.readyState !== WebSocket.OPEN), "the oldest of the source went");
    const back2 = phoneOf(keys2, phone2.saved.peers);
    phones.push(back2);
    back2.start();
    await wait(() => back2.online(selfB.id), 15000);
    assert.equal((await back2.call(selfB.id, "ping")).answered, "B:ping", "a paired phone comes in past them");
    for (const w of silent) w.terminate();

    console.log("web link: one port for TLS and phones, pairing (long code, through the relay, wrong code throttled, man in the middle refused), RPC/events/binary both ways incl. megabytes, leaf routing, reconnect, forget, direct link - passed");
  } finally {
    for (const p of phones) p.stop();
    for (const n of all) n.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
