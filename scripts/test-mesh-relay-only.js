// Relay-only hosts and the control boundary (src/mesh).
//
// Topology, as the user runs it: a desktop A, a relay R (a VPS installed relay-only), and a resource host V (a VM
// installed with the API). R is a dumb pipe: it routes A<->V end-to-end but serves no api of its own. A uses V as a
// resource (opens things there); no host may reach back and act on A.
//
//   A (desktop) ----R (relay only)---- V (resource host, --with-api)
//
// What this pins:
//   * a relay-only node refuses its own api to anyone (even a desktop), but still relays;
//   * A reaches V through R and uses it as a resource (desktop -> host is allowed);
//   * a host peer may never control a desktop (host -> desktop is refused), and a kind change can't grant it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLinks } = require("../src/mesh/links");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-relayonly-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, ms = 15000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await sleep(50); } throw new Error("condition timeout"); };

const node = (name, { kind = "desktop", relayOnly = false } = {}) => {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port: 0 }));
  const calls = [];
  const api = (method, _params, peer) => { calls.push(method); return { answered: `${name}:${method}`, from: peer.name }; };
  const links = createLinks({ dir: path.join(root, name), defaultName: name, kind, version: "test", api, relayOnly, discover: false, log: () => {} });
  links.calls = calls;
  return links;
};

(async () => {
  const a = node("A", { kind: "desktop" });                   // a laptop/desktop
  const r = node("R", { kind: "host", relayOnly: true });     // the VPS, installed relay-only
  const v = node("V", { kind: "host" });                      // a VM, installed with --with-api
  const selfA = await a.start(), selfR = await r.start(), selfV = await v.start();

  // Pair A<->R and V<->R, so R is the hub both sides route through. R regenerates its code after each pairing, so it is
  // read fresh each time.
  await a.pair("127.0.0.1", selfR.port, r.self().code); await wait(() => a.online(selfR.id) && r.online(selfA.id));
  await v.pair("127.0.0.1", selfR.port, r.self().code); await wait(() => v.online(selfR.id) && r.online(selfV.id));

  // A learns of V through R's route, then pairs with it end-to-end (over the relay).
  await wait(() => a.discovered().some(n => n.id === selfV.id));
  await a.pair(selfV.id, 0, selfV.code);
  await wait(() => a.online(selfV.id));
  assert.ok(a.nodes().find(n => n.id === selfV.id).via.length >= 1, "A reaches V through the relay, not directly");

  // A relay advertises itself (in its hello), so the desktop can skip resource fetches and label it; a resource does not.
  assert.equal(a.nodes().find(n => n.id === selfR.id).relayOnly, true, "the relay advertises itself as relay-only");
  assert.equal(a.nodes().find(n => n.id === selfV.id).relayOnly, false, "a resource host is not relay-only");

  // Control defaults by the peer's kind: a host peer may not control a desktop; a desktop peer may control a host.
  assert.equal(a.peers().get(selfR.id).control, false, "a relay (host) peer cannot control this desktop");
  assert.equal(a.peers().get(selfV.id).control, false, "a resource host peer cannot control this desktop");
  assert.equal(v.peers().get(selfA.id).control, true, "a desktop peer may control this host");

  // A peer re-announcing a different kind must NOT gain control: the boolean set at pairing is kept.
  a.peers().update(selfV.id, { kind: "desktop" });
  assert.equal(a.peers().get(selfV.id).control, false, "a kind change does not grant control");

  // The relay refuses its own api to anyone - even to A, a desktop that would otherwise be allowed - but it still relays
  // (A reached V through it, above). Its api is never run.
  await assert.rejects(a.call(selfR.id, "terminals.open", { kind: "shell" }), e => e.code === "relayOnly");
  assert.ok(!r.calls.includes("terminals.open"), "the relay never ran the method");

  // A uses V as a resource: desktop -> host is served (V trusts the desktop A fully).
  assert.deepEqual(await a.call(selfV.id, "terminals.open", { kind: "shell" }), { answered: "V:terminals.open", from: "A" });
  assert.ok(v.calls.includes("terminals.open"), "A's request reached V's api through the relay");

  // A host may NOT control a desktop: V -> A is refused before A's api, and stays refused after the kind spoof above.
  await assert.rejects(v.call(selfA.id, "terminals.open", { kind: "shell" }), e => e.code === "relayOnly");
  assert.ok(!a.calls.includes("terminals.open"), "the blocked request never reached A's api");

  a.stop(); r.stop(); v.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("mesh relay-only: relay routes but serves nothing; desktop uses hosts as resources; hosts cannot control desktops");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
