// host/bin/agentdeck-host.js pair-to / pair-relay: a headless host pairs with another node from the command line - a
// resource host installed as a second service beside this machine's relay (install.sh AGENTDECK_INSTANCE) pairs with
// that relay, reading its code and port from the relay's data dir. A relay R runs in this process; the CLI is spawned.
// --instance gives the CLI a service name no real unit has, so it never stops or starts an actual service.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createLinks } = require("../src/mesh/links");

const BIN = path.join(__dirname, "..", "host", "bin", "agentdeck-host.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-hostpair-"));
const INSTANCE = `test${process.pid}`;
// The CLI, asynchronously: the relay in this process must keep answering while it runs.
const cli = (...args) => new Promise(resolve => {
  execFile(process.execPath, [BIN, ...args, "--instance", INSTANCE], { timeout: 30000 }, (error, stdout, stderr) =>
    resolve({ code: error ? error.code ?? 1 : 0, out: `${stdout}${stderr}` }));
});
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const peersOf = dataDir => JSON.parse(fs.readFileSync(path.join(dataDir, "node", "peers.json"), "utf8")).peers;

(async () => {
  // The relay, with its data laid out as the headless host keeps it: <data>/node/{node.json, pair-token.json, ...}.
  const relayData = path.join(root, "relay"), relayNode = path.join(relayData, "node");
  fs.mkdirSync(relayNode, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(relayNode, "node.json"), JSON.stringify({ port }));
  const r = createLinks({ dir: relayNode, defaultName: "R", kind: "host", version: "test", api: () => {}, relayOnly: true, discover: false, log: () => {} });
  const selfR = await r.start();
  assert.equal(selfR.port, port, "the relay listens on the port in its node.json");

  // pair-relay: the code and the port come from the relay's files.
  const resource = path.join(root, "resource");
  let res = await cli("pair-relay", "--data-dir", resource, "--relay-data-dir", relayData);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Paired with R/);
  assert.equal(r.peers().list().length, 1, "the relay trusts the resource host now");
  assert.equal(r.peers().list()[0].kind, "host");
  const mine = peersOf(resource);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, selfR.id, "the resource host trusts the relay");
  assert.equal(mine[0].control, false, "the relay may not control the resource host");

  // Again: already paired, no code needed (an install run a second time).
  res = await cli("pair-relay", "--data-dir", resource, "--relay-data-dir", relayData);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Already paired with R/);

  // pair-to with a wrong code fails loudly; with the relay's current code it pairs.
  const other = path.join(root, "other");
  res = await cli("pair-to", "127.0.0.1", String(port), "000000", "--data-dir", other);
  assert.notEqual(res.code, 0, "a wrong code is an error");
  assert.match(res.out, /pairing code is wrong/i);
  res = await cli("pair-to", "127.0.0.1", String(port), r.self().code, "--data-dir", other);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Paired with R/);
  assert.equal(r.peers().list().length, 2);

  r.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("host pair: pair-relay reads the local relay's code and port; pair-to pairs by code; repeats and wrong codes handled");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
