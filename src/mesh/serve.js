// What a host serves to the computers paired with it (links.js): its projects and sessions, live status and git
// status, and terminals opened here for a peer - their output sent to it as frames (frames.js) while it is
// attached, its keystrokes and sizes taken back. What changes here is pushed to every connected peer. The same for
// Electron's main process (its windows look on too) and for the headless host (host/bin), which has nothing else.
//
// createServed({ host, env }) -> { api, attach(links) }: api(method, params, peer) answers a peer's request;
// attach(links) hooks the host's events to the links once they exist.
const { HostError } = require("../host/errors");
const { terminalEnv } = require("../host/terminal-env");
const frames = require("./frames");

const LIVE_MS = 3000;

const str = (v, max) => {
  if (typeof v !== "string" || !v || v.length > max) throw new HostError("invalidData");
  return v;
};

// host: host/index.js; env(): the environment for a terminal opened for a peer (a promise; with the proxy, on a
// desktop); info(): what host.info adds (the node's own description comes from the links).
function createServed({ host, env = async () => terminalEnv(process.env), info = () => ({}) }) {
  const { terminals, launch, sessions, liveSessions, git, setup } = host;
  const path = require("node:path");
  const fs = require("node:fs");
  let links = null;
  const watchers = new Map(); // terminal id -> Set of peer ids attached to it
  const peerTabs = peer => terminals.getTabs().filter(x => x.owner === peer);
  function ownTerm(id, peer) {
    const tab = terminals.getTabs().find(x => x.id === id && x.owner === peer);
    if (!tab) throw new HostError("invalidData", "Not a terminal of yours here.");
    return tab;
  }

  // The folder joins the projects once the clone has made it (a failed clone leaves nothing behind); given up after
  // CLONE_WAIT_MS.
  const CLONE_WAIT_MS = 30 * 60 * 1000, CLONE_POLL_MS = 2000;
  function registerOnceCloned(dir) {
    const from = Date.now();
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(dir, ".git"))) {
        if (Date.now() - from > CLONE_WAIT_MS) clearInterval(timer);
        return;
      }
      clearInterval(timer);
      const reg = sessions.registry.read();
      reg.removed = reg.removed.filter(x => x !== sessions.norm(dir));
      if (!reg.projects.some(x => sessions.norm(x.path) === sessions.norm(dir))) reg.projects.push({ name: path.basename(dir), path: dir });
      sessions.registry.save(reg);
    }, CLONE_POLL_MS);
    timer.unref?.();
  }
  const METHODS = {
    "host.info": () => ({ ...(links?.self() || {}), code: undefined, platform: process.platform, home: host.home, agents: sessions.get()?.agents || [], ...info() }),
    "sessions.list": () => sessions.data(),
    "live.list": () => liveSessions(),
    "git.status": () => git.get(),
    "terminals.list": (_p, peer) => peerTabs(peer.id),
    // {cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt} -> the tab, opened here for the peer.
    "terminals.open": async (p, peer) => {
      const cwd = str(p?.cwd, 4096);
      const spec = launch.commandFor({ kind: str(p?.kind, 16), agent: p?.agent, sessionId: p?.sessionId, prompt: p?.prompt }, cwd);
      try {
        const id = await launch.openTerminal(cwd, spec.command, { ...spec.meta, owner: peer.id }, await env(), `peer ${peer.name}`, spec.argv);
        return terminals.getTabs().find(x => x.id === id);
      } catch (e) {
        spec.undo();
        throw e;
      }
    },
    "terminals.attach": (p, peer) => {
      const tab = ownTerm(str(p?.id, 64), peer.id);
      if (!watchers.has(tab.id)) watchers.set(tab.id, new Set());
      watchers.get(tab.id).add(peer.id);
      return terminals.attach(tab.id);
    },
    "terminals.detach": (p, peer) => { watchers.get(str(p?.id, 64))?.delete(peer.id); return true; },
    "terminals.close": (p, peer) => terminals.close(ownTerm(str(p?.id, 64), peer.id).id),
    // A repository cloned here, a branch, an agent on a prompt: a terminal in the folder above `dir` (made when it
    // is not there), and the folder listed as a project. -> the tab, with the folder.
    "repo.clone": async (p, peer) => {
      const dir = setup.expandHome(str(p?.dir, 4096));
      const spec = launch.commandFor({ kind: "clone", url: p?.url, dir, branch: p?.branch, base: p?.base, agent: p?.agent || "", prompt: p?.prompt }, dir);
      const parent = path.dirname(dir);
      fs.mkdirSync(parent, { recursive: true });
      const id = await launch.openTerminal(parent, spec.command, { ...spec.meta, owner: peer.id }, { ...(await env()), ...spec.env }, `peer ${peer.name} clone`, spec.argv);
      registerOnceCloned(dir);
      return { ...terminals.getTabs().find(x => x.id === id), dir };
    },
    "git.branches": p => setup.branches(str(p?.dir, 4096)),
    "setup.status": () => setup.status(),
    "setup.sshKey.generate": () => setup.generateKey(),
    "setup.knownHosts.add": p => setup.addKnownHost(str(p?.host, 253)),
    "setup.gitIdentity.set": p => setup.setGitIdentity({ name: p?.name, email: p?.email })
  };
  function api(method, params, peer) {
    if (!Object.hasOwn(METHODS, method)) throw new HostError("unknownMethod");
    return METHODS[method](params, peer);
  }

  function attach(l) {
    links = l;
    host.on("terminal:data", ({ id, data, end }) => {
      const peers = watchers.get(id);
      if (peers) for (const peer of peers) links.sendBinary(peer, frames.encodeOutput(id, data, end));
    });
    host.on("terminals", tabs => {
      for (const id of watchers.keys()) if (!tabs.some(x => x.id === id)) watchers.delete(id);
      // Each peer hears of its own terminals here.
      for (const n of links.nodes()) if (n.status === "online") links.notify(n.id, "terminals", tabs.filter(x => x.owner === n.id));
    });
    host.on("data", data => links.notifyAll("data", data));
    host.on("git", g => links.notifyAll("git", g));
    // The live status has no event of its own (the windows poll it): connected peers get it every few seconds,
    // when it changed.
    let lastLiveSig = "";
    setInterval(async () => {
      if (!links.nodes().some(n => n.status === "online")) return;
      const live = await liveSessions();
      const sig = JSON.stringify(live);
      if (sig !== lastLiveSig) {
        lastLiveSig = sig;
        links.notifyAll("live", live);
      }
    }, LIVE_MS).unref();
    // A peer's keystrokes and sizes for its terminals here.
    links.on("binary", ({ node, data }) => {
      const f = frames.decode(data);
      if (!f || f.type === "output") return;
      if (!terminals.getTabs().some(x => x.id === f.id && x.owner === node)) return;
      if (f.type === "input") terminals.input(f.id, f.data);
      else terminals.resize(f.id, f.cols, f.rows);
    });
    links.on("link", ({ node, up }) => {
      if (!up) for (const peers of watchers.values()) peers.delete(node);
    });
  }

  return { api, attach };
}

module.exports = { createServed };
