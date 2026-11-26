// network.js against two local servers, in Electron (its requests are Chromium's): a request names AgentDeck and not a
// browser, a redirect within the site is followed, and one to another site fails as REDIRECTED without that site
// ever being asked - so no API key reaches it - and is described as a sign-in page in the way.
// Run: electron scripts/test-network-electron.cjs (npm run test:network)
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

if (!process.versions.electron) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(require("electron"), [__filename], { stdio: "inherit", windowsHide: true });
  process.exit(r.status ?? 1);
}

const { app, session } = require("electron");
const ROOT = path.join(__dirname, "..");

const listen = handler => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1", () => resolve(server));
});

async function main() {
  await app.whenReady();
  await session.defaultSession.setProxy({ mode: "direct" });
  const network = require(path.join(ROOT, "src/network.js"));
  const { classify } = require(path.join(ROOT, "src/voice/errors.js"));

  const seenElsewhere = [];
  const elsewhere = await listen((req, res) => { seenElsewhere.push(req.headers); res.end("<!DOCTYPE html><html>sign in</html>"); });
  const seen = [];
  const api = await listen((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/moved") { res.writeHead(307, { location: "/answer" }); res.end(); return; }
    // "localhost" is another origin than 127.0.0.1, as a proxy's sign-in site is another than the provider's.
    if (req.url === "/portal") { res.writeHead(307, { location: `http://localhost:${elsewhere.address().port}/auth?forward=x` }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const base = `http://127.0.0.1:${api.address().port}`;
  const headers = { Authorization: "Bearer secret-key" };
  let passed = 0;
  const check = async (name, fn) => { await fn(); passed++; console.log(`ok   ${name}`); };

  try {
    await check("a request names AgentDeck, not a browser", async () => {
      const res = await network.fetch(`${base}/answer`, { headers });
      assert.equal(await res.text(), '{"ok":true}');
      const ua = seen.at(-1).headers["user-agent"];
      assert.match(ua, /^AgentDeck\/\S+$/);
      assert.doesNotMatch(ua, /Mozilla|Chrome|Electron/);
    });

    await check("a User-Agent of the caller's own is kept", async () => {
      await (await network.fetch(`${base}/answer`, { headers: { "User-Agent": "something/1" } })).text();
      assert.equal(seen.at(-1).headers["user-agent"], "something/1");
    });

    await check("a redirect within the site is followed", async () => {
      const res = await network.fetch(`${base}/moved`, { method: "POST", headers, body: "{}" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '{"ok":true}');
    });

    await check("a redirect to another site fails, and that site is never asked", async () => {
      const error = await network.fetch(`${base}/portal`, { method: "POST", headers, body: "{}" }).then(() => null, e => e);
      assert.equal(error?.code, "REDIRECTED");
      assert.equal(error.host, `localhost:${elsewhere.address().port}`);
      assert.equal(error.status, 307);
      await new Promise(r => setTimeout(r, 300));
      assert.equal(seenElsewhere.length, 0, "the sign-in site got a request (and the key with it)");

      const described = classify({ error, provider: "Soniox" });
      assert.equal(described.kind, "Network");
      assert.equal(described.retryable, false);
      assert.match(described.longMessage, /Soniox/);
      assert.ok(described.longMessage.includes(error.host), described.longMessage);
    });
  } finally {
    api.close(); elsewhere.close();
  }
  console.log(`network: ${passed}/4 passed`);
}

main().then(() => app.exit(0), e => { console.error(e); app.exit(1); });
