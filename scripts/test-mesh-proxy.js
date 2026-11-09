// src/mesh/proxy.js (connectViaProxy) opens a TCP tunnel to host:port through an HTTP CONNECT proxy,
// and src/mesh/links.js uses the node's `proxy` setting to reach peers through it (the work laptop ->
// the VPS hub through the corporate proxy). No mDNS, everything on loopback.
const assert = require("node:assert/strict");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const listen = (server, port = 0, host = "127.0.0.1") =>
  new Promise(r => server.listen(port, host, () => r(server.address().port)));

// A minimal HTTP CONNECT proxy: records each CONNECT target, replies 200, then splices to it.
// `deny` makes it answer every CONNECT with 403 instead (to test the failure path).
function fakeProxy({ deny = false } = {}) {
  const targets = [];
  const server = net.createServer(client => {
    client.on("error", () => {});
    client.once("data", buf => {
      const line = buf.toString("latin1").split("\r\n")[0];
      const m = /^CONNECT (\S+) HTTP\/1\.1$/.exec(line);
      if (!m) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      targets.push(m[1]);
      if (deny) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const [host, port] = m[1].split(":");
      const up = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(up); up.pipe(client);
      });
      up.on("error", () => client.destroy());
    });
  });
  return { server, targets };
}

(async () => {
  const { connectViaProxy } = require("../src/mesh/proxy");

  // 1) Happy path: bytes tunnel through the proxy to an echo server, and the proxy saw the CONNECT.
  const echo = net.createServer(s => s.pipe(s));
  const echoPort = await listen(echo);
  const { server: proxy, targets } = fakeProxy();
  const proxyPort = await listen(proxy);

  const socket = await connectViaProxy({ proxy: `http://127.0.0.1:${proxyPort}`, host: "127.0.0.1", port: echoPort, timeout: 5000 });
  const got = await new Promise((resolve, reject) => {
    socket.once("data", d => resolve(d.toString()));
    socket.once("error", reject);
    socket.write("ping");
  });
  assert.equal(got, "ping", "data tunneled through the proxy and echoed back");
  assert.deepEqual(targets, [`127.0.0.1:${echoPort}`], "the proxy saw the CONNECT to the target");
  socket.destroy(); echo.close();

  // 2) A non-200 proxy reply rejects (not a silent hang).
  const { server: denyProxy } = fakeProxy({ deny: true });
  const denyPort = await listen(denyProxy);
  await assert.rejects(
    connectViaProxy({ proxy: `http://127.0.0.1:${denyPort}`, host: "127.0.0.1", port: echoPort, timeout: 5000 }),
    e => /403|proxy/i.test(e.message),
    "a 403 from the proxy is surfaced as an error"
  );
  proxy.close(); denyProxy.close();

  // 3) A node with a `proxy` setting reaches a peer THROUGH the proxy: pairing works and the proxy saw the CONNECT.
  const { createLinks } = require("../src/mesh/links");
  const until = (emitter, event, test = () => true, ms = 15000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no "${event}" within ${ms} ms`)), ms);
    const on = data => { if (test(data)) { clearTimeout(t); emitter.off(event, on); resolve(data); } };
    emitter.on(event, on);
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-meshproxy-"));
  const node = (name, extra) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "node.json"), JSON.stringify({ port: 0, ...extra }));
    return createLinks({ dir: path.join(root, name), defaultName: name, kind: "desktop", version: "test", api: async m => ({ ok: m }), discover: false, log: () => {} });
  };

  const { server: hubProxy, targets: hubTargets } = fakeProxy();
  const hubProxyPort = await listen(hubProxy);

  const B = node("B", {});                                             // the hub (no proxy)
  const A = node("A", { proxy: `http://127.0.0.1:${hubProxyPort}` });  // behind the proxy
  const selfB = await B.start();
  await A.start();

  const upA = until(A, "link", l => l.up), upB = until(B, "link", l => l.up);
  const r = await A.pair("127.0.0.1", selfB.port, selfB.code);
  assert.equal(r.id, selfB.id, "A paired with B through the proxy");
  await Promise.all([upA, upB]);
  assert.deepEqual(A.nodes().map(n => [n.name, n.status]), [["B", "online"]], "the link is up");
  assert.ok(hubTargets.includes(`127.0.0.1:${selfB.port}`), `A reached B via the proxy (CONNECTs seen: ${JSON.stringify(hubTargets)})`);

  A.stop(); B.stop(); hubProxy.close();

  console.log("OK test-mesh-proxy: connectViaProxy tunnels, fails loudly, and links go through the proxy");
  process.exit(0);
})().catch(e => { console.error("FAIL:", e); process.exit(1); });
