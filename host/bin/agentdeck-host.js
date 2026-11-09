#!/usr/bin/env node
// The headless host: AgentDeck's host (src/host) served to paired computers (src/mesh) with no window of its own -
// for a VM or a build machine. The desktop AgentDecks list its projects and sessions, open terminals and agent
// sessions on it and see them in their panes. Data in --data-dir (default ~/.agentdeck/host): the identity and the
// paired computers in node/, the registry of projects, the caches and the logs.
//
// Relay only by default (just routes mesh traffic); --with-api also serves this machine as a resource.
//   agentdeck-host [run] [--with-api] [--data-dir DIR] [--port N] [--name NAME] [--pair-token TOKEN] [--no-discovery] [--interface ADDR]
//   agentdeck-host pair      the pairing code (to enter on a desktop AgentDeck)
//   agentdeck-host status | logs | update | uninstall   (the systemd service, install.sh)
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
const dataDir = path.resolve(opt("data-dir", path.join(os.homedir(), ".agentdeck", "host")));
const nodeDir = path.join(dataDir, "node");
const SERVICE = "agentdeck-host";

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
    console.log(`Enter it in Settings → Computers → Add by address on a desktop AgentDeck, with this machine's address.`);
    process.exit(code ? 0 : 1);
    break;
  }
  case "status": process.exit(systemctl("status", SERVICE)); break;
  case "logs": process.exit(spawnSync("journalctl", ["--user", "-u", SERVICE, "-f", "-n", "100"], { stdio: "inherit" }).status ?? 1); break;
  case "update": {
    // The checkout this runs from, pulled, its packages refreshed, the service restarted.
    for (const [file, a] of [["git", ["pull", "--ff-only"]], ["npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]]]) {
      const r = spawnSync(file, a, { cwd: file === "git" ? ROOT : path.join(ROOT, "host"), stdio: "inherit" });
      if (r.status) process.exit(r.status);
    }
    process.exit(systemctl("restart", SERVICE));
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
  const links = createLinks({
    dir: nodeDir, defaultName: opt("name", os.hostname()), kind: "host", version: pkg.version,
    api: served ? served.api : () => {}, relayOnly: !withApi, log: meshLog, discover: !has("no-discovery")
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

  host?.start();
  const self = await links.start();
  if (opt("pair-token")) links.peers().setCode(opt("pair-token"));
  log(`agentdeck-host ${pkg.version}${withApi ? "" : " (relay only)"} on ${process.platform}, node ${process.version}: ${self.name} (${self.id.slice(0, 8)}), port ${self.port}, data ${dataDir}`);
  console.log(`\n${withApi ? "Resource host" : "Relay only"}\nPairing code: ${links.peers().code()}\nAddress: ${firstAddress()}:${self.port}\n`);
  links.on("self", () => console.log(`Pairing code now: ${links.peers().code()}`));

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

function firstAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return os.hostname();
}
