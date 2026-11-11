// Hardening of the web link and the mesh listener against what an internet-facing relay port meets (src/mesh:
// links.js, server.js, pair-guard.js, relay.js, identity.js, web-client.js). All on loopback; other loopback addresses
// (127.0.0.2 ...) stand for other internet addresses. What this pins:
//   1 a forgotten (or revoked) node gets no link: not when its hello was held back while it was forgotten - phone or
//     computer - and not when its record is gone without forget(): requests, events and frames all fail closed; the
//     phone (web-client.js) does not take a link to a node it forgot and paired again under another key meanwhile;
//   2 strangers cannot keep paired phones out: connections that have not shown who they are take places of their own
//     (createAdmission: per source and in all, the oldest pushed out, never refused), a pairing place only once a key
//     nobody knows has shown itself; a party that a relay lets open tunnels crowds out only itself; a pair.start
//     counts against its source at once (a start never finished is throttled, not free);
//   3 IPv4-mapped addresses ("::ffff:a.b.c.d") are their IPv4 address, as a pairing source and as loopback;
//   4 sockets that never send a byte cannot pile up, and TLS from elsewhere still gets through;
//   5 a relay that never acknowledges cannot make a computer hold more than so much for its web tunnels;
//   6 app events and the layout go only to peers that may see this computer (never a relay or a resource host);
//     a key file that cannot be read now is an error, not a new identity;
//   7 so is peers.json, pair-token.json or node.json that cannot be read now or is damaged: not written over.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createWebClient } = require("../src/mesh/web-client");
const { createLink, PROTOCOL } = require("../src/mesh/protocol");
const { createRelay } = require("../src/mesh/relay");
const { loadIdentity } = require("../src/mesh/identity");
const { connect } = require("../src/mesh/client");
const guardLib = require("../src/mesh/pair-guard");
const pairProof = require("../src/mesh/pair-proof");
const webLink = require("../src/mesh/web-link");
const noise = require("../src/mesh/noise");

const { createPairGuard, createAdmission, addressSource, ADMIT_PER_SOURCE, ADMIT_TOTAL, MAX_PER_SOURCE } = guardLib;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-hardening-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, ms = 30000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await sleep(50); } throw new Error("condition timeout"); };
const hex = b => Buffer.from(b).toString("hex");
const all = [], phones = [], sockets = [];
const node = (name, { kind = "desktop", relayOnly = false, listen = "127.0.0.1", calls = [] } = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port: 0 }));
  const links = createLinks({ dir: path.join(root, name), defaultName: name, kind, version: "test", relayOnly, listen, discover: false,
    api: (method, params, peer) => { calls.push([method, peer.id]); return { answered: `${name}:${method}` }; } });
  links.calls = calls;
  all.push(links);
  return links;
};
// A WebSocket constructor for web-client.js that dials from another loopback address.
const wsFrom = localAddress => class extends WebSocket { constructor(url, protocols, opts) { super(url, protocols, { ...opts, localAddress }); } };
const phoneOf = ({ keypair = noise.generateKeypair(), peers = [], from } = {}) => {
  const saved = { peers };
  const client = createWebClient({ WebSocket: from ? wsFrom(from) : WebSocket, keypair, peers, name: "Phone", version: "test", onPeersChanged: p => { saved.peers = p; } });
  Object.assign(client, { saved, keypair });
  phones.push(client);
  return client;
};
// A web connection taken by hand through its handshake: what any client - a phone or a stranger - can do.
async function rawWeb(port, { keypair = noise.generateKeypair(), from, onRequest } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, from ? { localAddress: from } : {});
  ws.on("error", () => {});
  sockets.push(ws);
  const pipe = webLink.wsPipe(ws);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("close", () => rej(Object.assign(new Error("closed before open"), { code: "closed" }))); });
  return overPipe(pipe, keypair, onRequest);
}
async function overPipe(pipe, keypair = noise.generateKeypair(), onRequest) {
  const { socket, remoteKey, hash } = await webLink.handshake(pipe, { initiator: true, s: keypair });
  const events = [], frames = [];
  const link = createLink(socket, { onRequest, onEvent: (name, data) => events.push({ name, data }), onBinary: d => frames.push(d) });
  socket.resume();
  return { link, socket, remoteKey, hash, keypair, events, frames };
}
const hello = (id, kind = "mobile") => ({ id, name: "raw", kind, version: "test", protocol: PROTOCOL, relay: 0, port: 0 });
// A wrong code tried over a web link that went through its handshake (rawWeb): the two calls of pair-proof.js.
async function wrongTry(r) {
  const p = pairProof.start({ code: "WRONG-CODE", initiator: hex(r.keypair.publicKey), responder: hex(r.remoteKey), binding: hex(r.hash), role: "initiator" });
  const s = await r.link.call("pair.start", { y: p.y });
  return r.link.call("pair.finish", { mac: p.finish(s.y).own });
}
const stall = (port, localAddress, bytes = "G") => {
  const s = net.connect({ port, host: "127.0.0.1", localAddress });
  s.on("error", () => {});
  if (bytes) s.once("connect", () => s.write(bytes));
  s.once("close", () => { s.closed = true; });
  sockets.push(s);
  return s;
};
const invitePhone = async (n, phone) => {
  const inv = n.invite();
  return phone.pairDirect("127.0.0.1", n.self().port, inv.code, { key: inv.key, id: inv.id, invite: true });
};

(async () => {
  try {
    // ================= 3: sources =================
    const as = a => { const s = addressSource(a); return [s.key, s.loopback]; };
    assert.deepEqual(as("::ffff:203.0.113.7"), ["203.0.113.7", false], "an IPv4-mapped address is its IPv4 address");
    assert.deepEqual(as("203.0.113.7"), ["203.0.113.7", false]);
    assert.notEqual(addressSource("::ffff:203.0.113.7").key, addressSource("::ffff:198.51.100.2").key, "two IPv4 clients are two sources");
    assert.deepEqual(as("::ffff:127.0.0.1"), ["127.0.0.1", true], "mapped loopback is loopback");
    assert.deepEqual(as("127.0.0.1"), ["127.0.0.1", true]);
    assert.deepEqual(as("::1"), ["0:0:0:0::/64", true]);
    assert.deepEqual(as("127.0.0.2"), ["127.0.0.2", false], "only the address relay tunnels come from counts as loopback");
    assert.deepEqual(as("2001:db8:1:2:3:4:5:6"), ["2001:db8:1:2::/64", false], "IPv6: its /64");
    assert.equal(addressSource("2001:db8:1:2::9").key, "2001:db8:1:2::/64");
    assert.equal(addressSource("::ffff:1:2").key, "0:0:0:0::/64", "not an IPv4 tail: IPv6 as it is");
    // Through a node listening on "::" (where the socket shows IPv4 clients mapped): the source is the IPv4 address.
    const dual = node("Dual", { listen: "::" });
    const selfDual = await dual.start();
    await assert.rejects(wrongTry(await rawWeb(selfDual.port, { from: "127.0.0.7" })), e => e.code === "wrongCode");
    assert.equal(dual.self().pairFailures.lastSource, "127.0.0.7", "a mapped client counts as its IPv4 address");
    dual.stop();

    // ================= 2: the guard and the admission, by themselves =================
    let t = 1_000_000;
    const g = createPairGuard({ now: () => t });
    g.started("s");
    assert.equal(g.allowed("s").waitMs, 1000, "a pair.start counts as a try");
    assert.ok(g.allowed("s", { started: true }).ok, "but does not hold back its own finish");
    g.failed("s", "s", { started: true });
    assert.equal(g.allowed("s").waitMs, 1000, "the wrong code that follows is not counted twice");
    assert.equal(g.stats().failures, 1, "it is one wrong code for Settings");
    t += 1000;
    g.started("s");
    assert.equal(g.allowed("s").waitMs, 2000, "starts double the wait as wrong codes do");
    g.succeeded("s");
    assert.ok(g.allowed("s").ok, "a right code clears it");
    assert.equal(g.stats().failures, 1, "starts are not wrong codes");

    const killed = [];
    const kill = name => () => killed.push(name);
    const ad = createAdmission({ perSource: 2, total: 4, deadlineMs: 200 });
    const a1 = ad.admit({ source: "a" }, kill("a1"));
    ad.admit({ source: "a" }, kill("a2"));
    ad.admit({ source: "a" }, kill("a3"));
    assert.deepEqual(killed, ["a1"], "one more of a full source pushes out its own oldest");
    a1();
    ad.admit({ source: "b" }, kill("b1"));
    ad.admit({ source: "c" }, kill("c1"));
    assert.equal(ad.size(), 4);
    ad.admit({ source: "d" }, kill("d1"));
    assert.deepEqual(killed, ["a1", "a2"], "all taken: the oldest of the largest source goes - never refused");
    assert.equal(ad.size(), 4);
    // Tunnels: one group per neighbour, one source per node behind it. A flood behind a relay crowds out only itself.
    const tun = createAdmission({ perSource: 3, total: 6, deadlineMs: 60000 });
    const out = [];
    tun.admit({ group: "via:R", source: "via:R:P" }, () => out.push("P"));
    tun.admit({ source: "1.2.3.4" }, () => out.push("D"));
    for (let i = 0; i < 5; i++) tun.admit({ group: "via:R", source: "via:R:X" }, () => out.push(`X${i}`));
    tun.admit({ group: "via:R", source: "via:R:Y" }, () => out.push("Y"));
    tun.admit({ source: "5.6.7.8" }, () => out.push("Z"));
    assert.ok(!out.includes("P") && !out.includes("D") && !out.includes("Y"), `only X's go: ${out}`);
    // The deadline, and a release in time.
    const late = createAdmission({ deadlineMs: 100 });
    const dead = [];
    late.admit({ source: "s" }, () => dead.push("slow"));
    const quick = late.admit({ source: "s" }, () => dead.push("quick"));
    quick(); quick();
    await sleep(250);
    assert.deepEqual(dead, ["slow"], "closed at the deadline unless it showed who it is");
    assert.equal(late.size(), 0);

    // ================= nodes =================
    const callsA = [];
    const r = node("R", { kind: "host", relayOnly: true });
    const a = node("A", { calls: callsA }), b = node("B"), h = node("H", { kind: "host" });
    const selfR = await r.start(), selfA = await a.start(), selfB = await b.start(), selfH = await h.start();
    for (const x of [a, b]) await x.pair("127.0.0.1", selfR.port, r.self().code);
    await a.pair("127.0.0.1", selfB.port, b.self().code);
    await a.pair("127.0.0.1", selfH.port, h.self().code);
    await wait(() => [selfR, selfB, selfH].every(s => a.online(s.id)) && b.online(selfR.id));

    // ================= 1: forgotten while the hello was held back =================
    const kp = noise.generateKeypair(), phoneId = noise.idOf(kp.publicKey);
    const pairer = phoneOf({ keypair: kp }); // never started: it only pairs, the links below are by hand
    await invitePhone(a, pairer);
    const tries = async (label, act) => {
      const held = await rawWeb(selfA.port, { keypair: kp });
      await sleep(200);
      await act();
      assert.equal(a.peers().get(phoneId), null, `${label}: forgotten`);
      held.link.notify("hello", hello(phoneId));
      await sleep(300);
      assert.equal(a.online(phoneId), false, `${label}: no link after the forget`);
      assert.ok(!a.nodes().some(n => n.id === phoneId), `${label}: not listed`);
      await assert.rejects(held.link.call("terminals.list", { all: true }, { timeout: 2000 }), `${label}: nothing served`);
      assert.ok(!callsA.some(([, id]) => id === phoneId), `${label}: the api never ran for it`);
    };
    await tries("forget()", () => a.forget(phoneId));
    // The same through peers.revoke from a desktop that may control A (B: A paired with it, so each may control the
    // other).
    await wait(() => b.online(selfA.id));
    await invitePhone(a, pairer);
    await tries("peers.revoke", async () => assert.deepEqual(await b.call(selfA.id, "peers.revoke", { id: phoneId }), { removed: true }));
    // A computer: C pairs with A and goes; something with C's certificate comes back and holds its hello.
    const c = node("C");
    const selfC = await c.start();
    await c.pair("127.0.0.1", selfA.port, a.self().code);
    await wait(() => a.online(selfC.id));
    c.stop();
    await wait(() => !a.online(selfC.id));
    const idC = await loadIdentity(path.join(root, "C"), { defaultName: "C" });
    const { ws: wsC } = await connect({ identity: idC, address: "127.0.0.1", port: selfA.port, expectId: selfA.id });
    const linkC = createLink(wsC);
    wsC.resume?.();
    await sleep(200);
    a.forget(selfC.id);
    linkC.notify("hello", { ...hello(selfC.id, "desktop"), relay: 1 });
    await sleep(300);
    assert.equal(a.online(selfC.id), false, "a computer forgotten while its hello was held back gets no link");
    await assert.rejects(linkC.call("terminals.list", {}, { timeout: 2000 }));
    assert.ok(!callsA.some(([, id]) => id === selfC.id));
    // A record that is gone without forget() (the file edited, a bug): requests, events and frames fail closed.
    await invitePhone(a, pairer);
    const live = await rawWeb(selfA.port, { keypair: kp });
    live.link.notify("hello", hello(phoneId));
    await wait(() => a.online(phoneId));
    assert.equal((await live.link.call("ping")).answered, "A:ping");
    let frames = 0;
    a.on("binary", e => { if (e.node === phoneId) frames++; });
    a.peers().remove(phoneId);
    live.socket.send(Buffer.from([1, 2, 3]));
    await assert.rejects(live.link.call("ping", {}, { timeout: 2000 }), "no stored peer: refused");
    await sleep(200);
    assert.equal(frames, 0, "nor its frames");
    assert.equal(a.online(phoneId), false, "and its link is closed");

    // ---------- the phone's side: a node it forgot and paired again under another key ----------
    // N1 (key K1) answers as node X and holds its hello; meanwhile the phone forgets X and pairs with N2 (key K2),
    // which says it is X too. N1's link must not become the phone's link to X.
    const X = "f".repeat(64), CODE = "123456";
    const fake = (keypair, { holdHello = null } = {}) => {
      const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      const state = { links: 0, closed: 0, server };
      server.on("connection", async ws => {
        let hs;
        try { hs = await webLink.handshake(webLink.wsPipe(ws), { initiator: false, s: keypair }); } catch { return; }
        state.links++;
        let session = null;
        const link = createLink(hs.socket, {
          onRequest: (method, params) => {
            if (method === "pair.start") {
              const proof = pairProof.start({ code: CODE, initiator: hex(hs.remoteKey), responder: hex(keypair.publicKey), binding: hex(hs.hash), role: "responder" });
              session = { y: proof.y, ...proof.finish(params.y) };
              return { y: session.y };
            }
            if (method === "pair.finish") {
              if (!pairProof.same(params.mac, session.expect)) throw Object.assign(new Error("wrong"), { code: "wrongCode" });
              return { ok: true, mac: session.own, id: X, name: "N", kind: "desktop" };
            }
            return { who: hex(keypair.publicKey) };
          },
          onEvent: async name => {
            if (name !== "hello") return;
            if (holdHello) await holdHello;
            link.notify("hello", { id: X, name: "N", kind: "desktop", version: "test", protocol: PROTOCOL, relay: 0, port: 0 });
          },
          onClose: () => { state.closed++; }
        });
        hs.socket.resume();
      });
      return new Promise(res => server.once("listening", () => res({ ...state, port: server.address().port, state })));
    };
    let release;
    const k1 = noise.generateKeypair(), k2 = noise.generateKeypair();
    const n1 = await fake(k1, { holdHello: new Promise(res => { release = res; }) });
    const n2 = await fake(k2);
    const mobile = phoneOf({ peers: [{ id: X, key: hex(k1.publicKey), name: "N", kind: "desktop", address: "127.0.0.1", port: n1.port }] });
    mobile.start();
    await wait(() => n1.state.links === 1);
    mobile.forget(X);
    await mobile.pairDirect("127.0.0.1", n2.port, CODE);
    assert.equal(mobile.peers()[0].key, hex(k2.publicKey));
    release();
    await wait(() => n1.state.closed >= 1, 5000);
    if (mobile.online(X)) assert.equal((await mobile.call(X, "who")).who, hex(k2.publicKey), "the link to X is to the key paired now");
    await wait(() => mobile.online(X), 15000);
    assert.equal((await mobile.call(X, "who")).who, hex(k2.publicKey), "the link to X is to the key paired now");
    mobile.stop();
    n1.server.close(); n2.server.close();

    // ================= 2: strangers cannot keep a paired phone out =================
    // The phone is paired with A and dials from 127.0.0.3.
    const kpP = noise.generateKeypair(), idP = noise.idOf(kpP.publicKey);
    await invitePhone(a, phoneOf({ keypair: kpP }));
    // Strangers from the phone's own address went through the handshake with keys nobody knows: they hold every
    // pairing place of that source; one more is told the node is busy (it hears why).
    const strangers = [];
    for (let i = 0; i < MAX_PER_SOURCE; i++) strangers.push(await rawWeb(selfA.port, { from: "127.0.0.3" }));
    const extra = await rawWeb(selfA.port, { from: "127.0.0.3" });
    await assert.rejects(extra.link.call("pair.start", { y: "00" }), e => e.code === "pairBusy", "one more is busy, and told so");
    // ... more that stall before their handshake, from the same address and from others ...
    for (let i = 0; i < ADMIT_PER_SOURCE + 4; i++) stall(selfA.port, "127.0.0.3");
    for (let i = 0; i < 40; i++) stall(selfA.port, `127.0.0.${10 + (i % 8)}`);
    await sleep(300);
    // ... and the paired phone still comes in.
    const back = await rawWeb(selfA.port, { keypair: kpP, from: "127.0.0.3" });
    back.link.notify("hello", hello(idP));
    await wait(() => a.online(idP), 5000);
    assert.equal((await back.link.call("ping")).answered, "A:ping", "a paired phone is never kept out by strangers' pairing places");
    back.link.close();
    // Everything not known yet taken (ADMIT_TOTAL from many addresses): one more still gets in, an old one goes.
    const flood = [];
    for (let i = 0; i < ADMIT_TOTAL; i++) flood.push(stall(selfA.port, `127.0.1.${1 + (i % 128)}`));
    await sleep(800);
    const viaWeb = await rawWeb(selfA.port, { keypair: kpP, from: "127.0.0.4" });
    viaWeb.link.notify("hello", hello(idP));
    await wait(() => a.online(idP), 5000);
    assert.equal((await viaWeb.link.call("ping")).answered, "A:ping", "a paired phone gets in when every place is taken");
    assert.ok(flood.some(s => s.closed), "an old stranger was pushed out instead");
    viaWeb.link.close();
    for (const s of [...flood, ...sockets.filter(x => x instanceof net.Socket)]) s.destroy();
    for (const s of strangers) s.link.close();

    // ---------- a pair.start that is never finished is counted ----------
    const s1 = await rawWeb(selfA.port, { from: "127.0.0.5" });
    const p1 = pairProof.start({ code: "x", initiator: hex(s1.keypair.publicKey), responder: hex(s1.remoteKey), binding: hex(s1.hash), role: "initiator" });
    await s1.link.call("pair.start", { y: p1.y });
    s1.link.close();
    const s2 = await rawWeb(selfA.port, { from: "127.0.0.5" });
    await assert.rejects(s2.link.call("pair.start", { y: p1.y }), e => e.code === "pairLater", "the next start from that source waits");
    s2.link.close();

    // ---------- through a relay: one party behind it crowds out only itself ----------
    // P is paired with R and with A (through R); X is paired with R only, and opens tunnels to A through R: some hold
    // pairing places at A (keys nobody knows), the others say nothing. P still reaches A.
    const kpX = noise.generateKeypair(), idX = noise.idOf(kpX.publicKey);
    const invR = await a.call(selfR.id, "pair.invite");
    await phoneOf({ keypair: kpX }).pairDirect("127.0.0.1", selfR.port, invR.code, { key: invR.key, id: invR.id, invite: true });
    const kpP2 = noise.generateKeypair();
    const p = phoneOf({ keypair: kpP2 });
    p.start();
    const invR2 = await a.call(selfR.id, "pair.invite");
    await p.pairDirect("127.0.0.1", selfR.port, invR2.code, { key: invR2.key, id: invR2.id, invite: true });
    await wait(() => p.routes().some(x => x.id === selfA.id && x.web));
    const invA = a.invite();
    await p.pairVia(selfA.id, invA.code, { key: invA.key, invite: true });
    await wait(() => p.online(selfA.id));
    const savedP = p.saved.peers;
    p.stop();
    await wait(() => !a.online(p.id));
    // X's own link to R, by hand, and tunnels over it.
    const tunnels = new Map();
    const xr = await rawWeb(selfR.port, { keypair: kpX, onRequest: (method, params) => {
      const tt = tunnels.get(params?.id);
      if (tt && method === "relay.data") tt.input(Buffer.from(params.data, "base64"));
      if (tt && method === "relay.close") tt.end();
      return true;
    } });
    xr.link.notify("hello", hello(idX));
    await wait(() => r.online(idX));
    const openTunnel = async () => {
      const id = randomUUID();
      const f = webLink.framedPipe({
        send: bytes => { xr.link.call("relay.data", { id, data: Buffer.from(bytes).toString("base64") }).catch(() => {}); },
        close: () => { xr.link.call("relay.close", { id }).catch(() => {}); }
      });
      tunnels.set(id, f);
      await xr.link.call("relay.open", { id, path: [idX, selfR.id, selfA.id], web: true });
      return f.pipe;
    };
    const held = [];
    for (let i = 0; i < MAX_PER_SOURCE; i++) held.push(await overPipe(await openTunnel()));
    const busy = await overPipe(await openTunnel());
    await assert.rejects(busy.link.call("pair.start", { y: "00" }), e => e.code === "pairBusy", "X's own pairing places are full");
    for (let i = 0; i < ADMIT_PER_SOURCE + 4; i++) await openTunnel();
    await sleep(300);
    const p2 = phoneOf({ keypair: kpP2, peers: savedP });
    p2.start();
    await wait(() => p2.online(selfA.id), 20000);
    assert.equal((await p2.call(selfA.id, "ping")).answered, "A:ping", "P reaches A through R past X's tunnels");
    assert.equal(p2.nodes().find(n => n.id === selfA.id).via, selfR.id);
    p2.stop();
    xr.link.close();

    // ================= 4: sockets that never send a byte =================
    const mute = [];
    for (let i = 0; i < ADMIT_PER_SOURCE + 8; i++) mute.push(stall(selfA.port, "127.0.0.6", ""));
    await sleep(800);
    assert.ok(mute.filter(s => !s.closed).length <= ADMIT_PER_SOURCE, `at most ${ADMIT_PER_SOURCE} silent sockets of one address`);
    const t1 = tls.connect({ port: selfA.port, host: "127.0.0.1", localAddress: "127.0.0.8", rejectUnauthorized: false });
    t1.on("error", () => {});
    await new Promise((res, rej) => { t1.once("secureConnect", res); t1.once("close", () => rej(new Error("TLS refused"))); });
    t1.destroy();
    for (const s of mute) s.destroy();

    // ================= 5: what a relay that never acknowledges can make a computer hold =================
    const selfId = "a".repeat(64), N1 = "b".repeat(64), N2 = "c".repeat(64);
    const never = { call: m => (m === "relay.data" ? new Promise(() => {}) : Promise.resolve(true)), notify() {} };
    const neighbours = new Map([[N1, { link: never, info: { name: "N1", relay: 1, web: 1 } }], [N2, { link: never, info: { name: "N2", relay: 1, web: 1 } }]]);
    // acceptWeb's end() is called when the tunnel's last hop gives up on it (it is destroyed).
    const relay = createRelay({ self: () => ({ id: selfId, port: 0 }), neighbors: () => neighbours, changed() {},
      acceptWeb: io => { const t = { io, ended: false }; relay.ends.push(t); return { input() {}, end() { t.ended = true; } }; } });
    relay.ends = [];
    const openWeb = async via => {
      await relay.request(via, "relay.open", { id: randomUUID(), path: [via, selfId], web: true });
      return relay.ends.at(-1);
    };
    // What the computer sends back to the phone, in Noise-message-sized pieces, as web-link.js does.
    const push = (t, mb) => { const piece = new Uint8Array(64 * 1024); for (let i = 0; i < mb * 16; i++) t.io.send(piece); };
    const w1 = await openWeb(N1), w2 = await openWeb(N1), w3 = await openWeb(N2);
    push(w1, 20); push(w2, 20); push(w3, 20);
    assert.ok(![w1, w2, w3].some(w => w.ended), "multi-megabyte answers are held while the phone reads slowly");
    // A third tunnel through N1 takes N1 past what all its web tunnels may hold: it is dropped. N2's are not affected.
    const w4 = await openWeb(N1);
    push(w4, 20);
    assert.equal(w4.ended, true, "one neighbour's tunnels hold at most so much together");
    const w5 = await openWeb(N2);
    push(w5, 20);
    assert.ok(!w3.ended && !w5.ended, "another neighbour's tunnels are not affected");
    relay.stop();

    // ================= 6: who hears what =================
    const heard = name => { const got = []; name.on("event", e => { if (e.name === "probe") got.push(e.node); }); return got; };
    const atR = heard(r), atH = heard(h), atB = heard(b);
    const ph = phoneOf();
    await invitePhone(a, ph);
    ph.start();
    await wait(() => ph.online(selfA.id));
    const atPhone = [];
    ph.on("event", e => { if (e.name === "probe") atPhone.push(e.node); });
    a.notifyAll("probe", { sessions: 1 });
    await sleep(500);
    assert.deepEqual(atB, [selfA.id], "a desktop sees another desktop's sessions");
    assert.deepEqual(atPhone, [selfA.id], "and so does a phone");
    assert.deepEqual(atR, [], "a relay hears nothing of them");
    assert.deepEqual(atH, [], "nor a resource host");
    const atA = heard(a);
    h.notifyAll("probe", { sessions: 2 });
    await sleep(300);
    assert.deepEqual(atA, [selfH.id], "a desktop still sees a resource host's sessions");
    assert.equal(a.sees(selfR.id), false);
    assert.equal(a.sees(ph.id, { phones: false }), false, "no layout to a phone");
    ph.stop();

    // ================= 6: a key file that cannot be read now =================
    const idDir = path.join(root, "ident");
    const first = await loadIdentity(idDir, { defaultName: "I" });
    const files = ["noise.json", "cert.pem", "key.pem"].map(f => path.join(idDir, f));
    const before = files.map(f => fs.readFileSync(f, "utf8"));
    const realRead = fs.readFileSync;
    for (const [file, code] of [["noise.json", "EBUSY"], ["cert.pem", "EPERM"], ["key.pem", "EBUSY"]]) {
      fs.readFileSync = function (f, ...rest) {
        if (String(f).endsWith(file)) throw Object.assign(new Error(`${code}: locked, read '${f}'`), { code });
        return realRead.call(this, f, ...rest);
      };
      try { await assert.rejects(loadIdentity(idDir, { defaultName: "I" }), e => e.code === code, `${file} ${code} surfaces`); } finally { fs.readFileSync = realRead; }
      assert.deepEqual(files.map(f => fs.readFileSync(f, "utf8")), before, `${file}: nothing was replaced`);
    }
    fs.writeFileSync(files[0], "{\"privateKey\":\"zz\"}");
    await assert.rejects(loadIdentity(idDir, { defaultName: "I" }), "a noise.json that holds something else is not replaced");
    fs.writeFileSync(files[0], before[0]);
    const again = await loadIdentity(idDir, { defaultName: "I" });
    assert.equal(again.id, first.id);
    assert.equal(hex(again.noise.publicKey), hex(first.noise.publicKey), "the same node after the error went");
    fs.unlinkSync(files[0]);
    const fresh = await loadIdentity(idDir, { defaultName: "I" });
    assert.notEqual(hex(fresh.noise.publicKey), hex(first.noise.publicKey), "a missing key is made");

    // ================= 7: the paired nodes and the settings that cannot be read now =================
    // peers.json, pair-token.json and node.json: locked (EBUSY/EPERM) or damaged (not JSON) - the node does not start
    // (code "unreadable", the file named), nothing is written over, and once the file is readable again the node starts
    // with its pairings as they were. Only a file that is not there starts empty.
    const pDir = path.join(root, "P");
    fs.mkdirSync(pDir, { recursive: true });
    fs.writeFileSync(path.join(pDir, "node.json"), JSON.stringify({ port: 0 }));
    const nodeP = () => { const l = createLinks({ dir: pDir, defaultName: "P", kind: "desktop", version: "test", listen: "127.0.0.1", discover: false, api: () => null }); all.push(l); return l; };
    let P = nodeP();
    const selfP = await P.start();
    const paired = { id: "ab".repeat(32), name: "X", kind: "desktop", address: "127.0.0.1", port: 9 };
    P.peers().add(paired);
    const codeP = P.self().code;
    P.setSelf({ name: "P-named" });
    P.stop();
    const kept = ["peers.json", "pair-token.json", "node.json"];
    const keptBefore = kept.map(f => fs.readFileSync(path.join(pDir, f), "utf8"));
    const unchanged = what => assert.deepEqual(kept.map(f => fs.readFileSync(path.join(pDir, f), "utf8")), keptBefore, `${what}: nothing was written over`);
    for (const [file, code] of [["peers.json", "EBUSY"], ["pair-token.json", "EPERM"], ["node.json", "EBUSY"]]) {
      fs.readFileSync = function (f, ...rest) {
        if (String(f).endsWith(file)) throw Object.assign(new Error(`${code}: locked, read '${f}'`), { code });
        return realRead.call(this, f, ...rest);
      };
      P = nodeP();
      try {
        await assert.rejects(P.start(), e => e.code === "unreadable" && e.file === path.join(pDir, file) && e.message.includes(code), `${file} ${code} surfaces`);
      } finally { fs.readFileSync = realRead; }
      assert.equal(P.self(), null, "nothing started");
      assert.deepEqual(P.nodes(), []);
      unchanged(`${file} ${code}`);
    }
    for (const file of kept) {
      const text = keptBefore[kept.indexOf(file)];
      fs.writeFileSync(path.join(pDir, file), text.slice(0, 20)); // cut off, as by a crash mid-write
      P = nodeP();
      await assert.rejects(P.start(), e => e.code === "unreadable" && e.damaged && e.message.includes(file), `a damaged ${file} surfaces`);
      assert.equal(fs.readFileSync(path.join(pDir, file), "utf8"), text.slice(0, 20), `the damaged ${file} is left as it is`);
      fs.writeFileSync(path.join(pDir, file), text);
    }
    P = nodeP();
    const selfAgain = await P.start();
    assert.equal(selfAgain.id, selfP.id);
    assert.equal(selfAgain.code, codeP, "the same code");
    assert.equal(selfAgain.name, "P-named", "the same settings");
    assert.deepEqual(P.peers().list().map(p => p.id), [paired.id], "the pairing is still there");
    P.stop();
    assert.ok(!fs.readdirSync(pDir).some(f => f.endsWith(".tmp")), "the saves leave no temporary files");

    console.log("web hardening: forget/revoke races closed (phone, computer, phone side), fail-closed requests/events/frames, strangers cannot keep paired phones out (direct, every place taken, behind a relay), pair.start counted, mapped IPv4 sources, silent sockets capped, relay buffers capped, events only to peers that may see them, unreadable key files surface, unreadable or damaged peers/code/settings files surface and are not written over - passed");
  } finally {
    for (const s of sockets) try { s.terminate ? s.terminate() : s.destroy(); } catch {}
    for (const p of phones) p.stop();
    for (const n of all) n.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
