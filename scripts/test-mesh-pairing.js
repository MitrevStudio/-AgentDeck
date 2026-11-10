// Pairing codes and how fast they may be tried (src/mesh/peers.js, pair-guard.js, links.js):
// - a host's code is long (Crockford base32, 128 bits), also after a pairing; a short one saved earlier is replaced;
//   a desktop's stays six digits; codes are read leniently (case, dashes, spaces, I/L/O); a short fixed token is refused;
// - pair-guard: the wait doubles per wrong code of a source up to 5 minutes, a right code clears it, too many wrong
//   codes from all sources lock pairing for a minute, and only so many connections may wait to pair;
// - a connection gets one try: after a wrong code it is closed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPeers, normCode, isLong } = require("../src/mesh/peers");
const { createPairGuard, MAX_DELAY_MS, GLOBAL_PER_MINUTE, GLOBAL_LOCK_MS, MAX_PENDING, MAX_PER_SOURCE } = require("../src/mesh/pair-guard");
const { createLinks } = require("../src/mesh/links");
const { loadIdentity } = require("../src/mesh/identity");
const { connect } = require("../src/mesh/client");
const { createLink } = require("../src/mesh/protocol");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-pairing-"));
const dir = name => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const LONG = /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/;

(async () => {
  // ---------- the codes ----------
  const host = createPeers(dir("host"), { long: true });
  assert.match(host.code(), LONG, "a host's code is long");
  const codes = new Set(Array.from({ length: 50 }, () => host.regenerate()));
  assert.equal(codes.size, 50, "codes differ");
  for (const c of codes) assert.match(c, LONG);
  assert.match(host.regenerate(), LONG, "regenerate() keeps a host's codes long (as after a pairing)");
  // Read leniently: lower case, no dashes, spaces, and the letters Crockford reads as digits.
  const c = host.code();
  assert.ok(host.check(c.toLowerCase().replace(/-/g, " ")));
  assert.ok(host.check(c.replace(/1/g, "l").replace(/0/g, "O")));
  assert.ok(!host.check(c.slice(0, -1)));
  assert.equal(normCode("ab-cd io l"), "ABCD101");

  // A host that saved a short code before gets a long one; a desktop keeps its six digits.
  const old = dir("old");
  fs.writeFileSync(path.join(old, "pair-token.json"), JSON.stringify({ code: "123456", long: false }));
  assert.match(createPeers(old, { long: true }).code(), LONG, "a short code on a host is replaced");
  const desk = createPeers(dir("desk"));
  assert.match(desk.code(), /^\d{6}$/);
  assert.match(desk.regenerate(), /^\d{6}$/);
  assert.match(createPeers(dir("desk")).code(), /^\d{6}$/, "a desktop's code is kept across restarts");

  // A fixed token (--pair-token) must be long and varied; a 32-hex token of an older install still counts as long.
  assert.throws(() => host.setCode("123456"));
  for (const weak of ["a".repeat(20), "_".repeat(24), "abababababababababab", "1234567 1234567 1234567"]) assert.ok(!isLong(weak), weak);
  assert.ok(isLong("0123456789abcdef0123456789abcdef"));
  host.setCode("0123456789abcdef0123456789abcdef");
  assert.ok(host.check("0123456789ABCDEF0123456789ABCDEF"));

  // ---------- pair-guard ----------
  let t = 1_000_000;
  const g = createPairGuard({ now: () => t });
  assert.ok(g.allowed("a").ok);
  const waits = [];
  for (let i = 0; i < 4; i++) { g.failed("a"); waits.push(g.allowed("a").waitMs); }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000], "the wait doubles");
  assert.ok(g.allowed("b").ok, "another source does not wait for a's tries");
  for (let i = 0; i < 20; i++) g.failed("a");
  t += 61 * 1000; // past the global lock
  assert.equal(g.allowed("a").waitMs, MAX_DELAY_MS - 61 * 1000, "capped at 5 minutes");
  g.succeeded("a");
  assert.ok(g.allowed("a").ok, "a right code clears the wait");
  assert.equal(g.stats().failures, 24);
  assert.equal(g.stats().lastSource, "a");

  // Many sources: GLOBAL_PER_MINUTE wrong codes in a minute lock pairing for everyone - on a desktop only; a host's
  // long code cannot be guessed, and there a lock would only let address-rotating clients keep pairing shut.
  const gHost = createPairGuard({ now: () => t, globalLock: false });
  for (let i = 0; i < GLOBAL_PER_MINUTE * 3; i++) gHost.failed(`10.0.0.${i}`);
  assert.ok(gHost.allowed("fresh").ok, "no global lock on a host");
  const g2 = createPairGuard({ now: () => t });
  for (let i = 0; i < GLOBAL_PER_MINUTE; i++) g2.failed(`10.0.0.${i}`);
  const locked = g2.allowed("fresh");
  assert.ok(!locked.ok && locked.waitMs === GLOBAL_LOCK_MS, "locked for a minute");
  t += GLOBAL_LOCK_MS;
  assert.ok(g2.allowed("fresh").ok, "open again after the lock");

  // Only so many may wait to pair at once: per source and in all.
  const g3 = createPairGuard();
  const mine = Array.from({ length: MAX_PER_SOURCE }, () => g3.admit("x"));
  assert.ok(mine.every(Boolean));
  assert.equal(g3.admit("x"), null, "one too many of one source");
  assert.ok(g3.admit("y"), "another source still gets a place");
  mine[0](); mine[0]();
  assert.ok(g3.admit("x"), "a released place is free again (released once)");
  assert.equal(g3.admit("x"), null);
  const g4 = createPairGuard();
  const all = Array.from({ length: MAX_PENDING }, (_, i) => g4.admit(`s${i}`));
  assert.ok(all.every(Boolean));
  assert.equal(g4.admit("new"), null, "one too many in all");

  // ---------- one try per connection ----------
  fs.writeFileSync(path.join(dir("N"), "node.json"), JSON.stringify({ port: 0 }));
  const n = createLinks({ dir: path.join(root, "N"), defaultName: "N", kind: "desktop", version: "test", api: () => ({}), discover: false });
  const selfN = await n.start();
  const identity = await loadIdentity(dir("caller"), { defaultName: "caller" });
  const { ws } = await connect({ identity, address: "127.0.0.1", port: selfN.port });
  const closed = new Promise(resolve => ws.once("close", resolve));
  const link = createLink(ws);
  ws.resume?.();
  await assert.rejects(link.call("pair", { code: "000000" }), e => e.code === "wrongCode");
  await assert.rejects(link.call("pair", { code: selfN.code }), e => e.code === "closed" || e.code === "pairLater", "no second try on the connection");
  await closed;
  assert.equal(n.nodes().length, 0, "nothing paired");

  // ---------- busy: too many waiting from one source get a reason they can show ----------
  const silent = [];
  for (let i = 0; i < MAX_PER_SOURCE; i++) silent.push((await connect({ identity, address: "127.0.0.1", port: selfN.port })).ws);
  const extra = (await connect({ identity, address: "127.0.0.1", port: selfN.port })).ws;
  const extraLink = createLink(extra);
  extra.resume?.();
  await assert.rejects(extraLink.call("pair", { code: selfN.code }), e => e.code === "pairBusy", "busy is answered as pairBusy");
  for (const w of silent) w.terminate();
  n.stop();

  fs.rmSync(root, { recursive: true, force: true });
  console.log("pairing: long host codes, lenient reading, weak tokens refused, guard backoff/lock (desktop only)/limits, one try per connection, busy answered OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
