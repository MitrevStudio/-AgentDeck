// host/bin/agentdeck-host.js pair-to / pair-relay: a headless host pairs with another node from the command line - a
// resource host installed as a second service beside this machine's relay (install.sh AGENTDECK_INSTANCE) pairs with
// that relay, reading its code and port from the relay's data dir. A relay R runs in this process; the CLI is spawned.
// --instance gives the CLI a service name no real unit has, so it never stops or starts an actual service. Before
// that, the command line itself: --help, and wrong ones refused.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
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
  // ---------- the command line itself ----------
  // --help / -h / help: every command and option, exit 0, and nothing started (no data dir made).
  const defaultData = path.join(os.homedir(), ".agentdeck", `host-${INSTANCE}`);
  let res;
  for (const help of [["--help"], ["-h"], ["help"], ["run", "--help"]]) {
    res = await cli(...help);
    assert.equal(res.code, 0, `${help.join(" ")}: ${res.out}`);
    assert.match(res.out, /^agentdeck-host .*\n[\s\S]*Usage: agentdeck-host \[COMMAND\] \[OPTIONS\]/);
    for (const word of ["run", "pair", "pair-to ADDRESS PORT CODE", "pair-relay", "status", "logs", "update", "uninstall", "--with-api", "--data-dir DIR", "--relay-port N", "--pair-token TOKEN"]) assert.ok(res.out.includes(word), `the usage names ${word}`);
  }
  const usage = res.out;
  // A wrong command line: an error (exit 2) that points at --help - never a node started with the rest ignored.
  for (const [line, why] of [[["--hepl"], /unknown option --hepl for run/], [["frobnicate"], /unknown command "frobnicate"/], [["run", "--port"], /--port needs a value/],
    [["pair", "--relay-port", "1"], /unknown option --relay-port for pair/], [["pair-to", "a", "1", "c", "d"], /unexpected argument "d" for pair-to/], [["run", "--name", "x", "stray"], /unexpected argument "stray"/]]) {
    res = await cli(...line);
    assert.equal(res.code, 2, `${line.join(" ")}: ${res.out}`);
    assert.match(res.out, why);
    assert.match(res.out, /agentdeck-host --help/);
  }
  assert.ok(!fs.existsSync(defaultData), "nothing ran: no data dir was made");
  // What the installer (and its systemd unit), the Dockerfile and the README run: options the usage lists for that
  // command (or for every command).
  const sections = new Map();
  let section = null;
  for (const line of usage.split("\n")) {
    const head = /^Options for (every command|[a-z-]+):$/.exec(line);
    if (head) { section = head[1] === "every command" ? "*" : head[1]; sections.set(section, new Set()); continue; }
    const o = /^\s+(--[a-z-]+)/.exec(line);
    if (section && o) sections.get(section).add(o[1]);
  }
  const allowed = (cmd, flag) => sections.get("*").has(flag) || Boolean(sections.get(cmd)?.has(flag));
  const ROOT = path.join(__dirname, "..");
  const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
  const used = [];
  for (const line of read("host/install.sh").split("\n")) {
    if (/\bEXEC="/.test(line)) used.push(["install.sh (systemd unit)", "run", line]);
    const m = /\$BIN"?\s+([a-z-]+)(.*)$/.exec(line);
    if (m && m[1] !== "run") used.push(["install.sh", m[1], m[2]]);
  }
  const docker = read("host/Dockerfile");
  used.push(["Dockerfile", ...JSON.parse(/^CMD (\[.*\])$/m.exec(docker)[1]).join(" ").split(/ (.*)/)]);
  assert.match(docker, /agentdeck-host\.js "\$@" --data-dir \/data/, "the wrapper adds --data-dir (allowed for every command)");
  for (const f of ["README.md", "host/docker-compose.yml", "docs/MOBILE.md"]) {
    for (const m of read(f).matchAll(/agentdeck-host(?:\.js)? ([a-z][a-z-]*)([^\n`]*)/g)) if (Object.hasOwn({ run: 1, pair: 1, "pair-to": 1, "pair-relay": 1, status: 1, logs: 1, update: 1, uninstall: 1 }, m[1])) used.push([f, m[1], m[2]]);
  }
  assert.ok(used.length >= 10, "the examples are found");
  for (const [file, cmd, rest] of used) for (const flag of rest.match(/--[a-z][a-z-]*/g) || []) assert.ok(allowed(cmd, flag), `${file}: ${cmd} ${flag} is an option it takes`);

  // The relay, with its data laid out as the headless host keeps it: <data>/node/{node.json, pair-token.json, ...}.
  const relayData = path.join(root, "relay"), relayNode = path.join(relayData, "node");
  fs.mkdirSync(relayNode, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(relayNode, "node.json"), JSON.stringify({ port }));
  const r = createLinks({ dir: relayNode, defaultName: "R", kind: "host", version: "test", api: () => {}, relayOnly: true, discover: false, log: () => {} });
  const selfR = await r.start();
  assert.equal(selfR.port, port, "the relay listens on the port in its node.json");
  assert.match(selfR.code, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/, "a host's code is long (Crockford base32)");

  // pair-relay: the code and the port come from the relay's files.
  const resource = path.join(root, "resource");
  res = await cli("pair-relay", "--data-dir", resource, "--relay-data-dir", relayData);
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
  await new Promise(done => setTimeout(done, 1100)); // the next try from this address waits after a wrong one
  res = await cli("pair-to", "127.0.0.1", String(port), r.self().code, "--data-dir", other);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /Paired with R/);
  assert.equal(r.peers().list().length, 2);

  // A damaged peers.json: pair-to says so and fails; `run` neither exits (a restart loop under systemd) nor starts
  // empty - it says why once, keeps trying, and starts as soon as the file is readable again. The file is left alone.
  const peersFile = path.join(other, "node", "peers.json");
  const good = fs.readFileSync(peersFile, "utf8");
  fs.writeFileSync(peersFile, good.slice(0, 30));
  res = await cli("pair-to", "127.0.0.1", String(port), "000000", "--data-dir", other);
  assert.notEqual(res.code, 0);
  assert.match(res.out, /peers\.json is damaged/);
  const child = spawn(process.execPath, [BIN, "run", "--data-dir", other, "--port", String(await freePort()), "--listen", "127.0.0.1", "--no-discovery", "--instance", INSTANCE],
    { env: { ...process.env, AGENTDECK_RETRY_START_MS: "200" } });
  let out = "", exited = null;
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  child.on("exit", code => { exited = code; });
  try {
    const until = async (f, what) => { for (let i = 0; i < 300 && !f(); i++) await new Promise(done => setTimeout(done, 50)); assert.ok(f(), `${what}\n${out}`); };
    await until(() => /The mesh cannot start: .*peers\.json is damaged/.test(out), "the reason is shown");
    await new Promise(done => setTimeout(done, 1200)); // several tries
    assert.equal(exited, null, "the host does not exit");
    assert.equal(out.match(/The mesh cannot start/g).length, 1, "the reason is shown once, not at every try");
    assert.equal(fs.readFileSync(peersFile, "utf8"), good.slice(0, 30), "the damaged file is left as it is");
    fs.writeFileSync(peersFile, good);
    await until(() => /Pairing code: /.test(out), "it starts once the file is repaired");
    assert.equal(JSON.parse(fs.readFileSync(peersFile, "utf8")).peers[0].id, selfR.id, "with its pairing");
  } finally {
    const gone = new Promise(done => (child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", done)));
    child.kill();
    await gone;
  }

  r.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("host pair: --help / -h / help and a wrong command line (refused, nothing started); the installer, Dockerfile and README pass options the usage lists; pair-relay reads the local relay's code and port; pair-to pairs by code; repeats and wrong codes handled; a damaged peers.json is reported, not replaced, and the host waits for it");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
