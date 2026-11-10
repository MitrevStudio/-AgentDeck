#!/usr/bin/env node
// The headless host: AgentDeck's host (src/host) served to paired computers (src/mesh) with no window of its own -
// for a VM or a build machine. The desktop AgentDecks list its projects and sessions, open terminals and agent
// sessions on it and see them in their panes. Data in --data-dir (default ~/.agentdeck/host): the identity and the
// paired computers in node/, the registry of projects, the caches and the logs.
//
// Relay only by default (just routes mesh traffic); --with-api also serves this machine as a resource.
//   agentdeck-host [run] [--with-api] [--data-dir DIR] [--port N] [--name NAME] [--pair-token TOKEN] [--no-discovery]
//                  [--interface ADDR] [--listen ADDR]
//   agentdeck-host pair                       the pairing code (to enter on a desktop AgentDeck)
//   agentdeck-host pair-to ADDRESS PORT CODE  pair this host with another node (it shows CODE)
//   agentdeck-host pair-relay [--relay-data-dir DIR] [--relay-port N]
//                                             pair with the relay on this machine (its code and port read from its files)
//   agentdeck-host status | logs | update | uninstall   (the systemd service, install.sh)
// --instance NAME (any command): a second service on this machine - agentdeck-host-NAME, data in ~/.agentdeck/host-NAME.
// install.sh AGENTDECK_INSTANCE makes one: a resource host beside the relay, on loopback, paired with the relay.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// The packages are in host/node_modules; the shared code (src/) must find them too.
const ROOT = path.join(__dirname, "..", "..");
process.env.NODE_PATH = [path.join(__dirname, "..", "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
require("node:module").Module._initPaths();

const pkg = require("../package.json");
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args.shift() : "run";
const opt = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? "" : fallback;
};
const has = name => args.includes(`--${name}`);
// The arguments before the first --option (pair-to ADDRESS PORT CODE).
const firstOption = args.findIndex(a => a.startsWith("--"));
const positional = firstOption < 0 ? args : args.slice(0, firstOption);
const instance = opt("instance");
if (instance && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(instance)) {
  console.error(`agentdeck-host: --instance must be lowercase letters, digits and dashes, not "${instance}"`);
  process.exit(2);
}
const SERVICE = instance ? `agentdeck-host-${instance}` : "agentdeck-host";
const dataDir = path.resolve(opt("data-dir", path.join(os.homedir(), ".agentdeck", instance ? `host-${instance}` : "host")));
const nodeDir = path.join(dataDir, "node");
// The name peers see until it is changed; a second service is told apart from the relay beside it.
const defaultName = () => opt("name", instance ? `${os.hostname()}-${instance}` : os.hostname());

const stamp = () => new Date().toISOString();
function makeLog(name) {
  const dir = path.join(dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  return line => {
    const text = `${stamp()} ${line}`;
    console.log(text);
    fs.appendFile(file, text + "\n", () => {});
  };
}

function pairCode() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(nodeDir, "pair-token.json"), "utf8"));
    return t.code || "";
  } catch {
    return "";
  }
}
const systemctl = (...a) => spawnSync("systemctl", ["--user", ...a], { stdio: "inherit" }).status ?? 1;

switch (command) {
  case "pair": {
    const code = pairCode();
    console.log(code ? `Pairing code: ${code}` : "No code yet: the host has not run.");
    console.log("Enter it on a desktop AgentDeck: Settings → Computers → Add by address (this machine's address), or under Found when it is reached through a relay.");
    process.exit(code ? 0 : 1);
    break;
  }
  case "pair-to": pairWith(positional[0], Number(positional[1]), positional[2]); break;
  case "pair-relay": { const t = relayTarget(); pairWith("127.0.0.1", t.port, t.code); break; }
  case "status": process.exit(systemctl("status", SERVICE)); break;
  case "logs": process.exit(spawnSync("journalctl", ["--user", "-u", SERVICE, "-f", "-n", "100"], { stdio: "inherit" }).status ?? 1); break;
  case "update": {
    // The checkout this runs from, pulled, its packages refreshed, the services restarted - all of this machine's
    // AgentDeck services (a relay and a resource beside it) run this same code.
    for (const [file, a] of [["git", ["pull", "--ff-only"]], ["npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]]]) {
      const r = spawnSync(file, a, { cwd: file === "git" ? ROOT : path.join(ROOT, "host"), stdio: "inherit" });
      if (r.status) process.exit(r.status);
    }
    systemctl("try-restart", "agentdeck-host*");
    process.exit(systemctl("start", SERVICE));
    break;
  }
  case "uninstall": {
    systemctl("disable", "--now", SERVICE);
    try { fs.rmSync(path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE}.service`)); } catch {}
    console.log(`The service is gone. The data stays in ${dataDir}; the code in ${ROOT}.`);
    break;
  }
  case "run": run().catch(e => { console.error(e); process.exit(1); }); break;
  default:
    console.error(`agentdeck-host: unknown command "${command}"`);
    process.exit(2);
}

async function run() {
  const { createLinks } = require(path.join(ROOT, "src", "mesh", "links"));
  const log = makeLog("host.log"), meshLog = makeLog("mesh.log");
  fs.mkdirSync(dataDir, { recursive: true });

  // Relay only by default (install.sh): this machine routes mesh traffic between paired computers but runs no sessions
  // of its own - a pure, untrusted pipe (the tunnels are end-to-end TLS, so it cannot read or act on what it carries).
  // --with-api turns it into a resource too: projects, sessions, terminals and agents served to paired computers.
  const withApi = has("with-api");
  let host = null, served = null;
  if (withApi) {
    const { createHost } = require(path.join(ROOT, "src", "host"));
    const { createServed } = require(path.join(ROOT, "src", "mesh", "serve"));
    host = createHost({
      dataDir, home: os.homedir(), isExcluded: () => false,
      untitled: (agent, id) => `${agent} session ${id}`, noLauncher: exe => `${exe} is not installed on this host`,
      log: (...parts) => log(parts.join(" ")), gitActive: () => true
    });
    // A program that ends takes its terminal with it, as on a desktop.
    host.on("terminal:exit", ({ id, lost }) => { if (!lost) host.terminals.close(id); });
    served = createServed({ host, info: () => ({ headless: true, dataDir }) });
  }
  // --listen 127.0.0.1: reached only through the relay on this machine, so no port of its own is open to the network.
  const links = createLinks({
    dir: nodeDir, defaultName: defaultName(), kind: "host", version: pkg.version,
    api: served ? served.api : () => {}, relayOnly: !withApi, listen: opt("listen"), log: meshLog, discover: !has("no-discovery")
  });
  served?.attach(links);
  // Before the first start: the settings given on the command line.
  const patch = {};
  if (opt("port")) patch.port = Number(opt("port"));
  if (opt("name")) patch.name = opt("name");
  fs.mkdirSync(nodeDir, { recursive: true });
  const nodeFile = path.join(nodeDir, "node.json");
  if (Object.keys(patch).length || opt("interface")) {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(nodeFile, "utf8")); } catch {}
    fs.writeFileSync(nodeFile, JSON.stringify({ ...saved, ...patch, ...(opt("interface") ? { interface: opt("interface") } : {}) }, null, 2));
  }

  // A fixed pairing token must be one that cannot be guessed (peers.js).
  const { isLong } = require(path.join(ROOT, "src", "mesh", "peers"));
  if (opt("pair-token") && !isLong(opt("pair-token"))) {
    console.error("--pair-token: the token needs at least 20 letters or digits (leave it out and one is made).");
    process.exit(2);
  }
  host?.start();
  const self = await links.start();
  if (opt("pair-token")) links.peers().setCode(opt("pair-token"));
  log(`agentdeck-host ${pkg.version}${withApi ? "" : " (relay only)"} on ${process.platform}, node ${process.version}: ${self.name} (${self.id.slice(0, 8)}), port ${self.port}, data ${dataDir}`);
  console.log(`\n${withApi ? "Resource host" : "Relay only"}\nPairing code: ${links.peers().code()}\nAddress: ${firstAddress()}:${self.port}\n`);
  let shownCode = links.peers().code();
  links.on("self", () => {
    if (links.peers().code() === shownCode) return;
    shownCode = links.peers().code();
    console.log(`Pairing code now: ${shownCode}`);
  });

  const stop = () => {
    log("stopping");
    links.stop();
    host?.stop();
    host?.terminals.stopAll();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Pairs this host with the node at address:port, which must show `code`; an already paired node needs none. The
// service is stopped meanwhile: it keeps its own copy of the paired nodes and would write over the new one.
async function pairWith(address, port, code) {
  if (!address || !Number.isInteger(port) || port <= 0 || port > 65535 || !code) {
    console.error("Usage: agentdeck-host pair-to ADDRESS PORT CODE");
    process.exit(2);
  }
  const { createLinks } = require(path.join(ROOT, "src", "mesh", "links"));
  const wasActive = spawnSync("systemctl", ["--user", "is-active", "--quiet", SERVICE]).status === 0;
  if (wasActive) systemctl("stop", SERVICE);
  fs.mkdirSync(nodeDir, { recursive: true });
  const links = createLinks({ dir: nodeDir, defaultName: defaultName(), kind: "host", version: pkg.version, api: () => {}, relayOnly: true, listen: "127.0.0.1", discover: false });
  let failed = false;
  try {
    await links.start();
    const r = await links.pair(address, port, code);
    console.log(`${r.already ? "Already paired" : "Paired"} with ${r.name || r.id.slice(0, 8)}.`);
  } catch (e) {
    failed = true;
    console.error(`Pairing with ${address}:${port} failed: ${e.message}`);
  } finally {
    links.stop();
    if (wasActive) systemctl("start", SERVICE);
  }
  process.exit(failed ? 1 : 0);
}

// The relay on this machine: its pairing code and port, from its data dir (default ~/.agentdeck/host).
function relayTarget() {
  const dir = path.join(path.resolve(opt("relay-data-dir", path.join(os.homedir(), ".agentdeck", "host"))), "node");
  if (dir === nodeDir) {
    console.error("pair-relay: that is this host's own data dir; pass the relay's with --relay-data-dir.");
    process.exit(2);
  }
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); } catch { return {}; } };
  const code = read("pair-token.json").code || "";
  if (!code) {
    console.error(`pair-relay: no relay found here (${path.join(dir, "pair-token.json")}). Install the relay first, or use pair-to.`);
    process.exit(1);
  }
  let port = Number(opt("relay-port")) || read("node.json").port;
  if (port === undefined) port = require(path.join(ROOT, "src", "mesh", "identity")).DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    console.error("pair-relay: the relay listens on a port chosen at start; pass it with --relay-port.");
    process.exit(1);
  }
  return { code, port };
}

function firstAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return os.hostname();
}
