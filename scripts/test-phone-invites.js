// Adding a phone with one QR code (docs/MOBILE.md 4, 5; src/mesh/invites.js, pair-code.js, links.js pair.invite and
// peers.revoke, web-client.js): a relay R (relay only), desktops A and B, a resource host H (paired with R only), all
// on loopback, and "phones" played by web-client.js over `ws`. What this pins:
//   * A gets one-time invites from itself, from the relay and from B; a host gets one from the relay (relay-only:
//     any paired computer); a phone, a host asking a desktop, and an unpaired connection get none;
//   * encode/decode round trip, and malformed payloads are refused;
//   * pairAll pairs a phone with the relay and every computer from one payload; the nodes' own codes stay;
//   * an invite works once, expires, cannot pair a computer (nor be used over TLS);
//   * a key in the payload that is not the one that answers is refused by the phone before anything is sent;
//   * peers.revoke from a desktop forgets the phone on the relay and on a computer; a phone cannot revoke, a computer
//     cannot be revoked that way, a host may not revoke;
//   * a fresh code mends what the phone still lists but cannot use (a computer that forgot it after the relay had):
//     paired again, not "already"; one linked now is "already" and its invite stays unused; an id paired under
//     another key is refused before its invite is touched;
//   * forgetPhone on the desktop (relays last): every node tells the phone, which ends with nothing paired;
//   * a plain-HTTP or TLS connection that sends half a request and stalls is closed within ~10 s, and plain ones
//     cannot pile up per source.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createWebClient } = require("../src/mesh/web-client");
const { createInvites } = require("../src/mesh/invites");
const { createLink } = require("../src/mesh/protocol");
const { ADMIT_PER_SOURCE } = require("../src/mesh/pair-guard");
const pairCode = require("../src/mesh/pair-code");
const webLink = require("../src/mesh/web-link");
const noise = require("../src/mesh/noise");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-invites-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, ms = 30000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await sleep(50); } throw new Error("condition timeout"); };
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const node = (name, { kind = "desktop", relayOnly = false, port = 0, inviteTtlMs = 0 } = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port }));
  return createLinks({ dir: path.join(root, name), defaultName: name, kind, version: "test", api: method => ({ answered: `${name}:${method}` }), relayOnly, discover: false, inviteTtlMs });
};
const phoneOf = (name = "Phone") => createWebClient({ WebSocket, keypair: noise.generateKeypair(), name, version: "test" });
const isInvite = (x, n) => {
  assert.deepEqual(Object.keys(x).sort(), ["code", "expires", "id", "key", "kind", "name"]);
  assert.equal(x.id, n.self().id);
  assert.equal(x.key, Buffer.from(n.identity().noise.publicKey).toString("hex"), "the node's Noise key");
  assert.match(x.code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}-[0-9A-Z]{2}$/, "a long token");
  assert.ok(x.expires > Date.now() + 9 * 60 * 1000 && x.expires <= Date.now() + 10 * 60 * 1000, "ten minutes");
};
const entry = (inv, extra = {}) => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind, ...extra });
const relayEntry = (inv, port) => ({ a: "127.0.0.1", p: port, id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name });
// A web connection that went through the handshake with a key nobody knows: what an unpaired phone can send.
async function stranger(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const pipe = webLink.wsPipe(ws);
  await new Promise(res => ws.addEventListener("open", res));
  const { socket } = await webLink.handshake(pipe, { initiator: true, s: noise.generateKeypair() });
  const link = createLink(socket);
  socket.resume();
  return link;
}

(async () => {
  const all = [], phones = [];
  try {
    const rPort = await freePort();
    const r = node("R", { kind: "host", relayOnly: true, port: rPort });
    const a = node("A"), b = node("B"), h = node("H", { kind: "host" });
    all.push(r, a, b, h);
    const selfR = await r.start(), selfA = await a.start(), selfB = await b.start(), selfH = await h.start();
    for (const x of [a, b, h]) await x.pair("127.0.0.1", rPort, r.self().code);
    await a.pair("127.0.0.1", selfB.port, b.self().code);
    await a.pair("127.0.0.1", selfH.port, h.self().code); // A may control H; H may not control A
    await wait(() => [selfR, selfB, selfH].every(s => a.online(s.id)) && b.online(selfR.id) && h.online(selfR.id));

    // ---------- invites ----------
    const own = a.invite();
    isInvite(own, a);
    assert.equal(own.kind, "desktop");
    const invR = await a.call(selfR.id, "pair.invite");
    isInvite(invR, r);
    assert.equal(invR.kind, "host");
    const invB = await a.call(selfB.id, "pair.invite");
    isInvite(invB, b);
    isInvite(await h.call(selfR.id, "pair.invite"), r); // relay-only: any paired computer
    isInvite(await a.call(selfH.id, "pair.invite"), h); // A may control H
    await assert.rejects(h.call(selfA.id, "pair.invite"), e => e.code === "notAllowed", "a host may not ask a desktop");
    const lone = await stranger(selfA.port);
    await assert.rejects(lone.call("pair.invite"), e => e.code === "unpaired", "an unpaired connection gets nothing");
    lone.close();
    const codeA = a.self().code, codeB = b.self().code, codeR = r.self().code;
    assert.equal(a.self().pairFailures.failures, 0);

    // ---------- the payload ----------
    const payload = { r: relayEntry(invR, rPort), n: [entry(own), entry(invB)] };
    const text = pairCode.encode(payload);
    assert.match(text, /^AGENTDECK-PAIR:2:[A-Z2-7]+$/, "base32, upper case, no padding: the QR alphanumeric set");
    const back = pairCode.decode(`  ${text.toLowerCase().replace(/(.{40})/g, "$1\r\n ")}\n`);
    assert.equal(pairCode.encode(back), text, "a round trip gives the same text (case and white space of a paste do not matter)");
    assert.deepEqual(back, pairCode.check(payload), "the same payload, as check() gives it");
    assert.equal(back.r.k, payload.r.k);
    assert.equal(back.n[0].c, own.code.replace(/-/g, ""), "codes come back as their 26 characters");
    // An independent writer of the layout (pair-code.js header), which checks nothing: what decode must refuse.
    const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const base32 = bytes => { let o = "", bits = 0, v = 0; for (const x of bytes) { v = (v << 8) | x; bits += 8; while (bits >= 5) { o += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } v &= (1 << bits) - 1; } return bits ? o + B32[(v << (5 - bits)) & 31] : o; };
    const CF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const invite17 = c => { let v = 0n; [...c.replace(/-/g, "")].forEach((ch, i) => { v |= BigInt(CF.indexOf(ch)) << BigInt(5 * i); }); return [...Array(17)].map((_, i) => Number((v >> BigInt(8 * (16 - i))) & 255n)); };
    const nodeBytes = x => { const name = x.nameBytes || [...Buffer.from(x.n)]; return [...Buffer.from(x.id, "hex"), ...Buffer.from(x.k, "base64url"), ...(x.c17 || invite17(x.c)), name.length, ...name]; };
    const addrBytes = x => [x.a.length, ...Buffer.from(x.a, "latin1"), x.p >> 8, x.p & 255];
    const pack = (p, { flags = p.r ? 1 : 0, count = p.n.length, tail = [] } = {}) => `AGENTDECK-PAIR:2:${base32([flags, count,
      ...(p.r ? [...nodeBytes(p.r), ...addrBytes(p.r)] : []),
      ...p.n.flatMap(x => [...nodeBytes(x), x.kind ?? ((x.t === "host" ? 1 : 0) | (x.a ? 2 : 0)), ...(x.a ? addrBytes(x) : [])]), ...tail])}`;
    assert.equal(pack(payload), text, "the layout is as documented");
    const withR = patch => pack({ ...payload, r: { ...payload.r, ...patch } });
    const withN = patch => pack({ ...payload, n: [{ ...entry(own), ...patch }, entry(invB)] });
    const raw = text.slice(17);
    const bad = [
      "", "hello", text.replace("PAIR:2:", "PAIR:1:"), text.replace("PAIR:2:", "PAIR:3:"), `${text}=`, `${text}1`, `${text}A`, `${raw.slice(0, -1)}${B32[(B32.indexOf(raw.at(-1)) + 1) % 32]}`,
      text.slice(0, -8), pack(payload, { tail: [0] }), pack(payload, { flags: 3 }), pack(payload, { flags: 0 }) /* no relay: then addresses are needed */,
      pack(payload, { count: 0 }), pack({ ...payload, n: Array(7).fill(0).map(() => entry(own)) }), pack({ ...payload, n: [entry(own), entry(own)] }), pack({ ...payload, n: [entry(own), entry(invR)] }),
      withR({ a: "evil/path" }), withR({ a: "user@host" }), withR({ a: "" }), withR({ a: "café" }), withR({ p: 0 }),
      withR({ c17: [255, ...Array(16).fill(0)] }) /* more than 130 bits */, withR({ n: "x".repeat(61) }), withR({ nameBytes: [0x41, 0xff] }) /* a name that is not UTF-8 */, withR({ nameBytes: [0x41], n: "AB" }).slice(0, -2) /* cut short */,
      withN({ kind: 4 }), withN({ kind: 2 }) /* says it has an address, has none */, withN({ a: "127.0.0.1", p: 7421, kind: 0 }) /* has one, says none */,
      `AGENTDECK-PAIR:2:${"A".repeat(5000)}`
    ];
    bad.forEach((t, i) => assert.throws(() => pairCode.decode(t), e => e.code === "invalidData", `refused #${i}: ${t.slice(0, 60)}`));
    for (const p of [{ ...payload, n: [] }, { ...payload, n: Array(7).fill(0).map(() => entry(own)) }, { ...payload, r: { ...payload.r, a: "café.local" } }, { r: null, n: payload.n }, { ...payload, x: 1 }])
      assert.throws(() => pairCode.encode(p), e => e.code === "invalidData");
    // The size the QR code has to hold: one, two and six computers with ordinary names, a relay with a domain name;
    // the text goes in QR alphanumeric mode as the dialog draws it.
    const qrcode = require("qrcode-generator");
    const version = (t, level) => { const q = qrcode(0, level); q.addData(t, "Alphanumeric"); q.make(); return (q.getModuleCount() - 17) / 4; };
    const fresh = name => { const kp = noise.generateKeypair(); return { ...entry(a.invite()), id: noise.idOf(kp.publicKey), k: pairCode.hexToKey(Buffer.from(kp.publicKey).toString("hex")), n: name }; };
    const sizes = [1, 2, 6].map(m => {
      const t = pairCode.encode({ r: { ...relayEntry(invR, rPort), a: "relay.example.com", n: "VPS relay" }, n: Array(m).fill(0).map((_, i) => fresh(`DESKTOP-PC${i}`)) });
      return { m, chars: t.length, L: version(t, "L"), M: version(t, "M") };
    });
    const sixText = { length: sizes[2].chars };
    assert.ok(sizes[2].L <= 19 && sizes[2].M <= 22, `relay + 6 computers: QR version ${sizes[2].L} (L) / ${sizes[2].M} (M)`);
    assert.ok(sizes[1].M <= 14, `relay + 2 computers: QR version ${sizes[1].M} (M)`);
    console.log(`  sizes: ${sizes.map(s => `relay + ${s.m}: ${s.chars} chars, version ${s.L} (L) / ${s.M} (M)`).join("; ")}`);

    // ---------- a key that is not the one in the payload ----------
    const phone = phoneOf("Pixel");
    phones.push(phone);
    phone.start();
    const wrong = pairCode.hexToKey(Buffer.from(noise.generateKeypair().publicKey).toString("hex"));
    const [res] = await pairCode.pairAll(phone, { r: { ...payload.r, k: wrong }, n: payload.n });
    assert.deepEqual([res.kind, res.ok, res.error], ["relay", false, "wrongKey"], "another key at the relay's address is refused");
    assert.equal(phone.peers().length, 0);
    assert.equal(r.self().pairFailures.failures, 0, "nothing was tried: the invite is untouched");
    await assert.rejects(phone.pairDirect("127.0.0.1", rPort, invR.code, { key: "zz" }), e => e.code === "invalidData");

    // ---------- one payload, everything paired ----------
    const results = await pairCode.pairAll(phone, text);
    assert.deepEqual(results.map(x => [x.id, x.kind, x.ok, x.error]), [[selfR.id, "relay", true, ""], [selfA.id, "desktop", true, ""], [selfB.id, "desktop", true, ""]]);
    for (const n of [r, a, b]) {
      const p = n.peers().get(phone.id);
      assert.equal(p?.kind, "mobile");
      assert.equal(p.key, phone.key);
    }
    await wait(() => [selfR, selfA, selfB].every(s => phone.online(s.id)));
    assert.equal(phone.nodes().find(n => n.id === selfA.id).via, selfR.id, "the computers through the relay");
    assert.equal((await phone.call(selfB.id, "sessions.list")).answered, "B:sessions.list");
    assert.deepEqual([a.self().code, b.self().code, r.self().code], [codeA, codeB, codeR], "the nodes' own codes stay");
    const again = await pairCode.pairAll(phone, text);
    assert.ok(again.every(x => x.ok && x.already), "what is paired already is skipped");
    await assert.rejects(phone.call(selfA.id, "pair.invite"), e => e.code === "notAllowed", "a phone gets no invites");
    await assert.rejects(phone.call(selfR.id, "pair.invite"), e => e.code === "notAllowed", "not from the relay either");

    // ---------- an invite works once ----------
    const phone2 = phoneOf("Second");
    phones.push(phone2);
    phone2.start();
    await sleep(1100);
    const twice = await pairCode.pairAll(phone2, text);
    assert.deepEqual(twice.map(x => x.error), ["inviteExpired", "inviteExpired", "inviteExpired"], "used: refused (and the computers behind the relay with it)");
    assert.equal(r.peers().get(phone2.id), null);
    // An invite made for B, tried directly at B: once only, also when the code was wrong.
    await sleep(1100);
    const invB2 = await a.call(selfB.id, "pair.invite");
    await assert.rejects(phone2.pairDirect("127.0.0.1", selfB.port, "0000-0000-0000-0000-0000-0000-00", { invite: true }), e => e.code === "inviteExpired", "an invite nobody made");
    await sleep(2100);
    const keyB = Buffer.from(b.identity().noise.publicKey).toString("hex");
    const direct = await phone2.pairDirect("127.0.0.1", selfB.port, invB2.code, { key: keyB, id: selfB.id, invite: true });
    assert.equal(direct.id, selfB.id);
    await assert.rejects(phoneOf().pairDirect("127.0.0.1", selfB.port, invB2.code, { invite: true }), e => ["inviteExpired", "pairLater"].includes(e.code));
    assert.equal(b.self().code, codeB, "B's own code still the same");

    // ---------- an invite is for a phone, over a web link ----------
    const c = node("C");
    all.push(c);
    await c.start();
    const invForC = await a.call(selfB.id, "pair.invite");
    await sleep(4100);
    await assert.rejects(c.pair("127.0.0.1", selfB.port, invForC.code), e => e.code === "wrongCode", "a computer cannot pair with an invite (TLS)");
    assert.equal(b.peers().get(c.self().id), null);

    // ---------- an invite expires ----------
    const e = node("E", { inviteTtlMs: 300 });
    all.push(e);
    const selfE = await e.start();
    const short = e.invite();
    await sleep(500);
    const keyE = Buffer.from(e.identity().noise.publicKey).toString("hex");
    await assert.rejects(phoneOf().pairDirect("127.0.0.1", selfE.port, short.code, { key: keyE, invite: true }), err => err.code === "inviteExpired");
    // The store itself: ten minutes, single use, at most so many.
    let now = 0;
    const store = createInvites({ now: () => now });
    const one = store.mint();
    assert.equal(one.expires, 10 * 60 * 1000);
    const found = store.find(pairCode.inviteTag(one.code));
    assert.ok(found && store.live(found));
    assert.equal(store.find(pairCode.inviteTag(one.code.toLowerCase())), found, "the tag reads the code as pair-proof.js does");
    store.use(found);
    assert.equal(store.find(pairCode.inviteTag(one.code)), null, "used");
    const two = store.mint();
    now = 10 * 60 * 1000;
    assert.equal(store.find(pairCode.inviteTag(two.code)), null, "expired");
    for (let i = 0; i < 40; i++) store.mint();
    assert.equal(store.size(), 16, "a bound on what waits");

    // ---------- forgetting a phone everywhere ----------
    await assert.rejects(phone.call(selfR.id, "peers.revoke", { id: phone2.id }), err => err.code === "notAllowed", "a phone cannot revoke");
    await assert.rejects(a.call(selfR.id, "peers.revoke", { id: selfB.id }), err => err.code === "notAllowed", "a computer is not revoked this way");
    await assert.rejects(h.call(selfR.id, "peers.revoke", { id: phone.id }), err => err.code === "notAllowed", "a host may not revoke");
    await assert.rejects(a.call(selfR.id, "peers.revoke", { id: "nope" }), err => err.code === "invalidData");
    assert.ok(r.peers().get(selfB.id) && r.peers().get(phone.id));
    a.forget(phone.id);
    assert.deepEqual(await a.call(selfR.id, "peers.revoke", { id: phone.id }), { removed: true });
    assert.deepEqual(await a.call(selfB.id, "peers.revoke", { id: phone.id }), { removed: true });
    assert.deepEqual(await a.call(selfB.id, "peers.revoke", { id: phone.id }), { removed: false }, "not there any more");
    for (const n of [r, a, b]) assert.equal(n.peers().get(phone.id), null);
    // The phone hears it where the link still carried it, and is let in nowhere.
    await wait(() => phone.nodes().every(n => n.status === "offline"), 10000);
    assert.ok(!phone.nodes().some(n => n.id === selfA.id || n.id === selfR.id));

    // ---------- a fresh code mends what the phone still lists ----------
    // B forgot the phone after the relay had, so it could not tell it: the phone still lists B, under B's key, not
    // linked. A fresh code pairs it again - not "already paired" with its invite wasted - and the relay and A too.
    assert.ok(phone.peers().some(p => p.id === selfB.id && p.key === keyB) && !phone.online(selfB.id), "B could not tell the phone");
    const freshText = async () => pairCode.encode({ r: relayEntry(await a.call(selfR.id, "pair.invite"), rPort), n: [entry(a.invite()), entry(await a.call(selfB.id, "pair.invite"))] });
    const mended = await pairCode.pairAll(phone, await freshText());
    assert.deepEqual(mended.map(x => [x.id, x.ok, x.already, x.error]), [[selfR.id, true, false, ""], [selfA.id, true, false, ""], [selfB.id, true, false, ""]], "B is paired again");
    assert.equal(b.peers().get(phone.id)?.key, phone.key);
    await wait(() => [selfR, selfA, selfB].every(s => phone.online(s.id)));
    // Linked now: "already", and the invites are left unused (one of them still pairs another phone).
    const linkedText = await freshText();
    assert.ok((await pairCode.pairAll(phone, linkedText)).every(x => x.ok && x.already), "a pairing that works is kept as it is");
    // A node that still knows the phone, while the phone is not linked to it: paired again on its link (links.js).
    phone.stop();
    await wait(() => !phone.online(selfB.id) && !a.online(phone.id), 10000);
    phone.start();
    const relinked = await pairCode.pairAll(phone, await freshText());
    assert.ok(relinked.every(x => x.ok), JSON.stringify(relinked));
    await wait(() => [selfR, selfA, selfB].every(s => phone.online(s.id)));
    // An id paired under another key is refused before its invite is touched: forget that one first.
    const otherKey = pairCode.hexToKey(Buffer.from(noise.generateKeypair().publicKey).toString("hex"));
    const invB4 = await a.call(selfB.id, "pair.invite");
    const forged = await pairCode.pairAll(phone, { r: relayEntry(await a.call(selfR.id, "pair.invite"), rPort), n: [entry(a.invite()), { ...entry(invB4), k: otherKey }] });
    assert.deepEqual(forged.map(x => [x.ok, x.already, x.error]), [[true, true, ""], [true, true, ""], [false, false, "wrongNode"]]);
    assert.equal(phone.peers().find(p => p.id === selfB.id).key, keyB, "B's pairing stays as it was");
    const spare = phoneOf("Spare");
    phones.push(spare);
    assert.equal((await spare.pairDirect("127.0.0.1", selfB.port, invB4.code, { key: keyB, invite: true })).id, selfB.id, "B's invite was not used up");

    // ---------- "Forget" on the desktop: the relays last, so every node can tell the phone ----------
    assert.deepEqual(await a.forgetPhone(phone.id, { settleMs: 500 }), [], "every computer heard it");
    for (const n of [r, a, b]) assert.equal(n.peers().get(phone.id), null);
    await wait(() => phone.peers().length === 0, 10000);
    assert.deepEqual(phone.nodes(), [], "the phone was told by each, and keeps nothing it cannot reach");

    // ---------- connections that stall before they are WebSockets ----------
    // Plain HTTP: half a request line, then nothing. At most ADMIT_PER_SOURCE of one source wait (from the first byte;
    // pair-guard.js createAdmission - one more pushes the oldest out); every one is gone within about ten seconds.
    const t0 = Date.now();
    const stalled = [];
    for (let i = 0; i < ADMIT_PER_SOURCE + 4; i++) {
      const s = net.connect(selfB.port, "127.0.0.1");
      s.on("error", () => {});
      s.once("connect", () => s.write("GET / HT"));
      s.once("close", () => { s.closedAt = Date.now() - t0; });
      stalled.push(s);
    }
    await sleep(1500);
    assert.ok(stalled.filter(s => !s.closedAt).length <= ADMIT_PER_SOURCE, `at most ${ADMIT_PER_SOURCE} of one source wait`);
    const tlsStalled = [];
    for (let i = 0; i < 6; i++) {
      const s = tls.connect({ port: selfB.port, host: "127.0.0.1", rejectUnauthorized: false });
      s.on("error", () => {});
      s.once("secureConnect", () => s.write("GET / HT"));
      s.once("close", () => { s.closedAt = Date.now() - t0; });
      tlsStalled.push(s);
    }
    await wait(() => [...stalled, ...tlsStalled].every(s => s.closedAt), 14000);
    assert.ok(Math.max(...stalled.map(s => s.closedAt)) < 12000, "plain: closed within ~10 s of the first byte");
    // The places are given back: a phone pairs there again.
    const invB3 = await a.call(selfB.id, "pair.invite");
    const phone3 = phoneOf("Third");
    phones.push(phone3);
    phone3.start();
    await sleep(1100);
    assert.equal((await phone3.pairDirect("127.0.0.1", selfB.port, invB3.code, { key: keyB, invite: true })).id, selfB.id);

    console.log(`phone invites: invites from the desktop, relay and another computer (who may ask), payload round trip and ${bad.length} malformed ones refused (six computers: ${sixText.length} characters), pairAll over the relay, single use, expiry, no computers or TLS, wrong key refused, peers.revoke, a fresh code mends a stale pairing (not "already"), forgetPhone tells the phone everywhere (relays last), stalled HTTP/TLS closed - passed`);
  } finally {
    for (const p of phones) p.stop();
    for (const n of all) n.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
