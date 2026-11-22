// A node behind a port mapping (src/mesh/links.js `reached`): R listens on 127.0.0.2:<inside>, and a plain TCP proxy
// on 127.0.0.1:<outside> stands for the router's forward or Docker's `-p <outside>:<inside>` in front of it. R knows
// and announces only its inside number, and nothing listens on 127.0.0.1:<inside>.
// Checked: V pairs through the mapping and R cannot call V back (V listens on 127.0.0.1 only, and R sees it come from
// the proxy's address): V's peers.json holds the outside port - the one it called - not the one R announces; the
// link is dropped at the proxy, and comes back through the proxy; the same after V restarts. R still learns V's
// announced port from the link V opened, as before. W can be called back: R restarts and calls W, whose record then
// says where R came from and the port R announces - and still keeps where W itself called R, so W finds R again.
// No mDNS, no Electron. Skipped where 127.0.0.2 cannot be bound (macOS).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createLinks } = require("../src/mesh/links");

const INSIDE = "127.0.0.2", OUTSIDE = "127.0.0.1";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mesh-mapped-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (test, what, ms = 20000) => {
  for (let t = 0; t < ms; t += 25) { if (test()) return; await sleep(25); }
  throw new Error(`timed out: ${what}`);
};
const listen = (server, port, host) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, () => { server.off("error", reject); resolve(server); });
});
const logs = {};
const node = (name, { kind = "desktop", port = 0, listenOn = "" } = {}) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "node.json"))) fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port, name, discoverable: false }));
  logs[name] = logs[name] || [];
  return createLinks({ dir, defaultName: name, kind, version: "test", api: async () => null, discover: false, listen: listenOn, log: line => logs[name].push(line) });
};
const saved = (name, id) => JSON.parse(fs.readFileSync(path.join(root, name, "peers.json"), "utf8")).peers.find(p => p.id === id);

const stops = [];
async function main() {
  const probe = await listen(net.createServer(), 0, INSIDE).catch(() => null);
  if (!probe) return void console.log(`mesh behind a port mapping: skipped (${INSIDE} cannot be bound here)`);
  // R's inside port is a fixed one, so that R has it again after a restart.
  const inside = probe.address().port;
  await new Promise(r => probe.close(r));

  // ---------- the mapping: OUTSIDE:<outside> -> INSIDE:<inside>, its connections counted and droppable ----------
  const through = new Set();
  let taken = 0;
  const proxy = await listen(net.createServer(client => {
    taken++;
    const up = net.connect({ host: INSIDE, port: inside, localAddress: INSIDE });
    for (const [a, b] of [[client, up], [up, client]]) {
      through.add(a);
      a.on("error", () => {});
      a.on("close", () => { through.delete(a); b.destroy(); });
      a.pipe(b);
    }
  }), 0, OUTSIDE);
  stops.push(() => { proxy.close(); for (const s of through) s.destroy(); });
  const outside = proxy.address().port;
  assert.notEqual(outside, inside, "the outside number differs from the inside one");
  const cut = () => { for (const s of [...through]) s.destroy(); };

  // ---------- the nodes ----------
  let r = node("R", { kind: "host", port: inside, listenOn: INSIDE });
  let v = node("V", { listenOn: OUTSIDE });
  let w = node("W", { listenOn: INSIDE });
  stops.push(() => [r, v, w].forEach(l => l.stop()));
  const R = (await r.start()).id;
  assert.equal(r.self().port, inside);
  await assert.rejects(new Promise((resolve, reject) => { const s = net.connect({ host: OUTSIDE, port: inside }); s.once("connect", resolve); s.once("error", reject); }), "nothing answers on the inside number at the outside address");
  const V = (await v.start()).id;

  // ---------- V pairs through the mapping ----------
  await v.pair(OUTSIDE, outside, r.self().code);
  await waitFor(() => v.online(R) && r.online(V), "V and R are linked");
  const called = { address: OUTSIDE, port: outside };
  const held = what => {
    const p = saved("V", R);
    assert.deepEqual([p.address, p.port], [OUTSIDE, outside], `${what}: V's peers.json holds the port it called, not the one R announces (${inside})`);
    assert.deepEqual(p.reached, called, `${what}: and that it called R there itself`);
    assert.equal(v.nodes().find(n => n.id === R).port, outside, `${what}: the node is listed at the port it was called at`);
  };
  held("paired");
  // R took the link V opened: it learns V's announced port, as before, and never called V itself.
  assert.equal(saved("R", V).port, v.self().port, "R holds the port V announces");
  assert.equal(saved("R", V).reached, undefined, "R did not call V");

  // ---------- the link drops at the mapping: it comes back through it ----------
  for (const what of ["dropped once", "dropped again"]) {
    const before = taken;
    cut();
    await waitFor(() => !v.online(R) && !r.online(V), `${what}: both see the link go`);
    await waitFor(() => v.online(R) && r.online(V), `${what}: the link comes back`);
    assert.ok(taken > before, `${what}: through the mapping`);
    held(what);
  }
  // V restarts (a new port of its own, which R does not know yet): it calls the outside number again.
  {
    const before = taken;
    v.stop();
    await waitFor(() => !r.online(V), "R sees V go");
    v = node("V", { listenOn: OUTSIDE });
    await v.start();
    await waitFor(() => v.online(R) && r.online(V), "V is linked again after its restart");
    assert.ok(taken > before, "after V's restart: through the mapping");
    held("after V's restart");
    assert.equal(saved("R", V).port, v.self().port, "R holds V's new announced port");
  }
  assert.ok(!logs.V.some(l => l.includes(`:${inside} `)), "V never linked at the inside number");

  // ---------- W can be called back: R restarts and calls it ----------
  await sleep(1100); // one pairing a second from one address (pair-guard.js)
  const W = (await w.start()).id;
  await w.pair(OUTSIDE, outside, r.self().code);
  await waitFor(() => w.online(R) && r.online(W), "W and R are linked");
  assert.deepEqual(saved("W", R).reached, called);
  r.stop();
  await waitFor(() => !w.online(R) && !v.online(R), "V and W see R go");
  r = node("R", { kind: "host", port: inside, listenOn: INSIDE });
  await r.start();
  assert.equal(r.self().port, inside, "R has its inside port again");
  await waitFor(() => w.online(R) && r.online(W) && v.online(R), "everyone is linked again");
  const answered = logs.W.filter(l => l.startsWith("link up")).at(-1).endsWith("(answered)");
  let p = saved("W", R);
  if (answered) {
    assert.equal(p.port, inside, "the link R opened: W's record has the port R announces, as before");
    console.log(`  R called W back: W's record says ${p.address}:${p.port}, and keeps ${p.reached.address}:${p.reached.port} as where it called R itself`);
  } else console.log("  W called R before R called it back: its record is the port it called");
  assert.deepEqual(p.reached, called, "where W itself called R is kept beside it");
  held("after R's restart");
  // W restarts: R cannot call its new port, and W finds R - by the outside number, unless the record R's own link
  // left is R's true address on this one machine.
  {
    const before = taken, direct = p.address === INSIDE && p.port === inside;
    w.stop();
    await waitFor(() => !r.online(W), "R sees W go");
    w = node("W", { listenOn: INSIDE });
    await w.start();
    await waitFor(() => w.online(R) && r.online(W), "W is linked again after its restart");
    if (!direct) assert.ok(taken > before, "after W's restart: through the mapping");
    p = saved("W", R);
    assert.deepEqual(p.reached, direct ? { address: INSIDE, port: inside } : called);
    if (!direct) assert.deepEqual([p.address, p.port], [OUTSIDE, outside], "W's record is the port it called again");
  }

  console.log("mesh behind a port mapping: all checks passed");
}

const watchdog = setTimeout(() => { console.error("the test did not finish in time"); process.exit(1); }, 120000);
main().then(() => 0, e => { console.error(e); for (const [name, lines] of Object.entries(logs)) console.error(lines.map(l => `  [${name}] ${l}`).join("\n")); return 1; }).then(async code => {
  clearTimeout(watchdog);
  for (const stop of stops.reverse()) try { stop(); } catch {}
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(code);
});
