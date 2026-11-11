// What a host serves to the computers paired with it (links.js): its projects and sessions, live status and git
// status, and terminals opened here for a peer - their output sent to it as frames (frames.js) while it is
// attached, its keystrokes and sizes taken back. What changes here is pushed to every connected peer. The same for
// Electron's main process (its windows look on too) and for the headless host (host/bin), which has nothing else.
//
// The wide view (a phone, docs/MOBILE.md): a peer that asks for terminals.list { all: true } sees every terminal
// here - this computer's own (owner "") and other peers' - and may attach to, type into, size, send to and close any
// of them, until its link drops. A peer that never asks (a desktop) keeps seeing and driving only the terminals it
// opened. Only a request reaches the wide view, and requests are refused to a peer without control (links.js), so a
// relay-only peer's frames never reach a terminal that is not its own. Wide peers also hear "terminal.size" for the
// terminals they are attached to; one that sized a terminal (the user's "fit to phone") and lets go of it hands the
// size back to the pane that shows it: "terminal:refit" on the host for this computer's own terminals, the event
// "terminal.refit" { id } to the peer that owns it otherwise.
//
// createServed({ host, env }) -> { api, attach(links) }: api(method, params, peer) answers a peer's request;
// attach(links) hooks the host's events to the links once they exist.
const { HostError } = require("../host/errors");
const { terminalEnv } = require("../host/terminal-env");
const frames = require("./frames");
const { savePaste, MAX_BYTES } = require("../host/paste");
const { localSnapshot } = require("./projects");
const { SESSION_ID, isAgent } = require("../host/launch");
const { TEXT_MAX } = require("../host/send-text");

const LIVE_MS = 3000;

const str = (v, max) => {
  if (typeof v !== "string" || !v || v.length > max) throw new HostError("invalidData");
  return v;
};

// host: host/index.js; env(): the environment for a terminal opened for a peer (a promise; with the proxy, on a
// desktop); info(): what host.info adds (the node's own description comes from the links).
function createServed({ host, env = async () => terminalEnv(process.env), info = () => ({}) }) {
  const { terminals, launch, sendText, sessions, liveSessions, git, setup } = host;
  const path = require("node:path");
  const fs = require("node:fs");
  let links = null, layout = null;
  const watchers = new Map(); // terminal id -> Set of peer ids attached to it
  const wide = new Set();     // peers with the wide view (terminals.list { all: true }) on their current link
  const sizedBy = new Map();  // terminal id -> the wide peer whose size it has, when that peer does not own it
  const peerTabs = peer => terminals.getTabs().filter(x => x.owner === peer);
  const mayUse = (tab, peer) => tab.owner === peer || wide.has(peer);
  function ownTerm(id, peer) {
    const tab = terminals.getTabs().find(x => x.id === id && mayUse(x, peer));
    if (!tab) throw new HostError("invalidData", "Not a terminal of yours here.");
    return tab;
  }
  // The peer let go of the terminal (detached, or its link dropped): a size it set goes back to the pane that shows
  // the terminal, which sends its own fit again. Nothing when another size came since (sizedBy is dropped then).
  function release(id, peer) {
    if (sizedBy.get(id) !== peer) return;
    sizedBy.delete(id);
    const tab = terminals.getTabs().find(x => x.id === id);
    if (!tab || tab.exited) return;
    if (tab.owner === "") host.emit("terminal:refit", { id });
    else if (tab.owner !== peer && links?.online(tab.owner)) links.notify(tab.owner, "terminal.refit", { id });
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
      if (!reg.projects.some(x => sessions.norm(x.path) === sessions.norm(dir))) reg.projects.push({ name: path.basename(dir) || dir, path: dir });
      sessions.registry.save(reg);
    }, CLONE_POLL_MS);
    timer.unref?.();
  }
  const METHODS = {
    "host.info": () => ({ ...(links?.self() || {}), code: undefined, platform: process.platform, home: host.home, agents: sessions.get()?.agents || [], ...info() }),
    "sessions.list": async () => localSnapshot(await sessions.data()),
    "live.list": () => liveSessions(),
    "git.diff": p => git.diff(p),
    "git.query": p => git.query(p),
    "git.execute": p => git.execute(p),
    "git.status": () => git.get(),
    "git.refresh": () => git.refresh({ force: true }),
    "usage.get": () => host.usage.get(),
    "limits.get": () => { host.limits.refresh().catch(() => {}); return host.limits.get(); },
    "resources.get": () => host.resources.get() || host.resources.refresh(),
    // A session running here without a terminal of this host's own, ended for a peer (launch.stopSession).
    "sessions.stop": p => launch.stopSession(str(p?.agent, 16), str(p?.id, 200)),
    // A session's last messages and a few facts about it (host/session-preview.js): {agent, id} -> the preview (at
    // most a few messages of a bounded length), or null when there is nothing to read. A session started since the
    // last scan is looked up by its id.
    "sessions.preview": p => {
      const agent = str(p?.agent, 16), id = str(p?.id, 200);
      if (!isAgent(agent) || !SESSION_ID.test(id)) throw new HostError("invalidSession");
      const s = sessions.get()?.sessions.find(x => x.agent === agent && x.id === id)
        ?? { agent, id, file: agent === "Claude" ? host.findTranscript(id) : "" };
      return host.preview(s);
    },
    // {all}: true -> every terminal here, and the wide view for this link (above); otherwise those the peer opened.
    "terminals.list": (p, peer) => {
      if (p?.all !== true) return peerTabs(peer.id);
      wide.add(peer.id);
      return terminals.getTabs();
    },
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
    "terminals.detach": (p, peer) => {
      const id = str(p?.id, 64);
      watchers.get(id)?.delete(peer.id);
      release(id, peer.id);
      return true;
    },
    "terminals.close": (p, peer) => terminals.close(ownTerm(str(p?.id, 64), peer.id).id),
    // {id, text}: the text typed into the agent in that terminal and submitted (host/send-text.js), as the command
    // centre's send_to_session does. Refused (agentNotReady) unless an agent runs there and waits for input.
    "terminals.send": async (p, peer) => {
      const tab = ownTerm(str(p?.id, 64), peer.id);
      const text = str(p?.text, TEXT_MAX);
      if (!tab.agent) throw new HostError("agentNotReady");
      await sendText.typeLine(tab.id, text);
      return true;
    },
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
    // A file for a terminal here (a pasted picture, a dropped file): {name, data (base64)} -> its path here.
    "files.put": p => {
      if (typeof p?.data === "string" && p.data.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) throw new HostError("tooBig");
      return savePaste(str(p?.name, 200), Buffer.from(str(p?.data, Infinity), "base64"));
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
    layout = require("./layout").createLayout({ links, registry: sessions.registry });
    host.on("data", () => layout.reconcile());
    host.on("terminal:data", ({ id, data, end }) => {
      const peers = watchers.get(id);
      if (peers) for (const peer of peers) links.sendBinary(peer, frames.encodeOutput(id, data, end));
    });
    host.on("terminals", tabs => {
      for (const id of watchers.keys()) if (!tabs.some(x => x.id === id)) watchers.delete(id);
      for (const id of sizedBy.keys()) if (!tabs.some(x => x.id === id)) sizedBy.delete(id);
      // Each peer hears of its own terminals here; one with the wide view, of all of them. A peer that may not see
      // this computer (a host: links.js sees) can have none here, and hears nothing.
      for (const n of links.nodes()) if (n.status === "online" && links.sees(n.id)) links.notify(n.id, "terminals", wide.has(n.id) ? tabs : tabs.filter(x => x.owner === n.id));
    });
    // A terminal's new size, to the wide peers attached to it (they draw at the host's size). Whoever sized it last
    // holds the size now: a wide peer's own resize marks itself just after this (links.on("binary") below).
    host.on("terminal:size", ({ id, cols, rows }) => {
      sizedBy.delete(id);
      for (const peer of watchers.get(id) || []) if (wide.has(peer)) links.notify(peer, "terminal.size", { id, cols, rows });
    });
    // What this computer has and does, to the peers that may see it (links.js notifyAll: desktops and phones, never a
    // relay or a resource host).
    host.on("data", data => links.notifyAll("data", localSnapshot(data)));
    host.on("git", g => links.notifyAll("git", g));
    host.on("usage", u => links.notifyAll("usage", u));
    host.on("limits", l => links.notifyAll("limits", l));
    host.on("resources", r => links.notifyAll("resources", r));
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
    // A peer's keystrokes and sizes for its terminals here (any terminal, with the wide view).
    links.on("binary", ({ node, data }) => {
      const f = frames.decode(data);
      if (!f || f.type === "output") return;
      const tab = terminals.getTabs().find(x => x.id === f.id);
      if (!tab || !mayUse(tab, node)) return;
      if (f.type === "input") terminals.input(f.id, f.data);
      else {
        terminals.resize(f.id, f.cols, f.rows);
        if (wide.has(node) && tab.owner !== node) sizedBy.set(f.id, node);
      }
    });
    links.on("link", ({ node, up }) => {
      if (up) return;
      for (const peers of watchers.values()) peers.delete(node);
      for (const [id, peer] of [...sizedBy]) if (peer === node) release(id, node);
      wide.delete(node);
    });
  }

  return { api, attach, get layout() { return layout; } };
}

module.exports = { createServed };
