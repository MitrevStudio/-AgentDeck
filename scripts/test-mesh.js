// Two nodes in one process (src/mesh): identities made, B paired from A with B's code, a link up both ways, a
// request answered, an event delivered, a wrong code refused, the pair forgotten and the link gone. No mDNS.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLinks } = require("../src/mesh/links");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mesh-"));
const until = (emitter, event, test = () => true, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
  const on = data => { if (test(data)) { clearTimeout(timer); emitter.off(event, on); resolve(data); } };
  emitter.on(event, on);
});
// Any free port: the default one may be the real AgentDeck's.
const node = (name, api) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  if (!fs.existsSync(path.join(root, name, "node.json"))) fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port: 0 }));
  return createLinks({ dir: path.join(root, name), defaultName: name, kind: "desktop", version: "test", api, discover: false, log: line => console.log(`  [${name}] ${line}`) });
};

(async () => {
  const a = node("A", async method => ({ answered: `A:${method}` }));
  const b = node("B", async (method, params, peer) => ({ answered: `B:${method}`, from: peer.name, params }));
  const selfA = await a.start(), selfB = await b.start();
  assert.match(selfA.id, /^[0-9a-f]{64}$/);
  assert.notEqual(selfA.id, selfB.id);
  assert.ok(selfA.port > 0 && selfB.port > 0 && selfA.port !== selfB.port, "two ports");
  assert.match(selfB.code, /^\d{6}$/);
  // The identity is kept: the same id after a restart.
  a.stop();
  const a2 = node("A", async method => ({ answered: `A:${method}` }));
  assert.equal((await a2.start()).id, selfA.id, "the id survives a restart");

  // A wrong code is refused and leaves nothing behind.
  await assert.rejects(a2.pair("127.0.0.1", selfB.port, "000000"), e => e.code === "wrongCode");
  assert.equal(b.nodes().length, 0);
  assert.equal(a2.nodes().length, 0);

  // Pairing with the right code: both list each other, and the link comes up both ways.
  const upB = until(b, "link", l => l.up), upA = until(a2, "link", l => l.up);
  const r = await a2.pair("127.0.0.1", selfB.port, selfB.code);
  assert.equal(r.id, selfB.id);
  assert.equal(r.name, "B");
  await Promise.all([upA, upB]);
  assert.deepEqual(a2.nodes().map(n => [n.name, n.status]), [["B", "online"]]);
  assert.deepEqual(b.nodes().map(n => [n.name, n.status]), [["A", "online"]]);
  assert.notEqual(b.self().code, selfB.code, "a new code after pairing");

  // Requests both ways, and an event.
  assert.deepEqual(await a2.call(selfB.id, "sessions.list", { limit: 3 }), { answered: "B:sessions.list", from: "A", params: { limit: 3 } });
  assert.deepEqual(await b.call(selfA.id, "host.info"), { answered: "A:host.info" });
  const got = until(b, "event", e => e.name === "data");
  a2.notifyAll("data", { sessions: 2 });
  assert.deepEqual(await got, { node: selfA.id, name: "data", data: { sessions: 2 } });

  // B goes away and comes back: A reconnects by itself.
  b.stop();
  await until(a2, "link", l => !l.up);
  assert.equal(a2.nodes()[0].status, "offline");
  const b2 = node("B", async method => ({ answered: `B2:${method}` }));
  const back = until(a2, "link", l => l.up, 20000);
  await b2.start();
  await back;
  assert.deepEqual(await a2.call(selfB.id, "ping"), { answered: "B2:ping" });

  // Forgotten on one side: the link goes, and the other side sees it offline.
  const down = until(b2, "link", l => !l.up);
  a2.forget(selfB.id);
  await down;
  assert.equal(a2.nodes().length, 0);
  assert.equal(b2.nodes()[0].status, "offline");

  a2.stop();
  b2.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("mesh: all checks passed");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
