// What a host serves to the computers paired with it (links.js): its projects and sessions, live status and git
// status, and its terminals - their output sent as frames (frames.js) to the peers attached to them, their keystrokes
// and sizes taken back. What changes here is pushed to every connected peer. The same for Electron's main process
// (its windows look on too) and for the headless host (host/bin), which has nothing else.
//
// The terminals belong to this host (docs/SHARED-SESSIONS.md 4): every peer that may control it (a desktop, a phone)
// sees all of them, attaches to any (it becomes a viewer, host/viewers.js), types into it, takes or gives back its
// size, sends to it and stops it - whoever opened it (`owner` only says who did). Requests are refused to a peer
// without control (links.js), so only such a peer gets this far; binary frames are taken only from a peer that made a
// terminals request on its current link (`ctl`), so a relay-only peer's frames never reach a terminal. A resize frame
// is a viewer's want (4.3); its input makes it the driver after HOLD. Events go only to peers that links.sees.
//
// Tabs go out as host.tabs() makes them, with names filled in: a viewer or driver "" (this computer's own window)
// becomes this node's id, and ownerName and each viewer's name come from the paired nodes.
//
// Output to a viewer whose link has more than LAG_HIGH bytes waiting is skipped and the viewer marked behind; once
// that falls under LAG_LOW (looked at with the next output, and every LAG_CHECK_MS while any is behind) it hears
// "terminal.resync" { id } once and attaches again: what it missed comes from the scrollback.
//
// Forwarded ports (docs/PORT-FORWARDING.md 2): "ports.open" joins a stream the peer names to a TCP port on this
// computer's loopback (host/port-streams.js), "ports.close" ends it, "ports.list" says what listens here. The stream's
// bytes are frames too, through the same gate: a ports request counts for `ctl` as a terminals one does, and a
// stream frame is taken only for a stream its sender opened. A stream that ends here by itself, not cleanly, is said
// to the peer as "port.closed" { stream }; a link that drops takes the peer's streams with it.
//
// createServed({ host, env }) -> { api, attach(links) }: api(method, params, peer) answers a peer's request;
// attach(links) hooks the host's events to the links once they exist. A file here is offered to a phone with
// offers.make(phone, { path }) (host/file-offers.js); the phone answers with "files.answer".
const { HostError } = require("../host/errors");
const { isReport } = require("../host/viewers");
const { terminalEnv } = require("../host/terminal-env");
const frames = require("./frames");
const { savePaste, MAX_BYTES } = require("../host/paste");
const { localSnapshot } = require("./projects");
const { SESSION_ID, isAgent } = require("../host/launch");
const { TEXT_MAX } = require("../host/send-text");
const { createPortStreams } = require("../host/port-streams");
const { resolveFolder } = require("../host/project-folder");
const { getProject, addProject } = require("../host/registry");
const { createFiles } = require("../host/files");
const { createFileOffers } = require("../host/file-offers");
// The most of one message a peer may ask sessions.preview for. A preview is six messages: at this bound it is at
// most about 100 000 characters (a few hundred kilobytes for text that is not Latin) - still quick over a mobile
// link, which carries it through the relay in 32 KB pieces - and all but the longest answers fit whole.
const PREVIEW_TEXT_MAX = 16000;

const LIVE_MS = 3000;
const GIT_SHOWN_MAX = 200; // folders in one "git.shown": more than a page can show at a time
const LAG_HIGH = 4 * 1024 * 1024, LAG_LOW = 512 * 1024, LAG_CHECK_MS = 1000;
const MAX_SIZE = 1000;

const str = (v, max) => {
  if (typeof v !== "string" || !v || v.length > max) throw new HostError("invalidData");
  return v;
};
const dim = v => {
  if (!Number.isInteger(v) || v < 1 || v > MAX_SIZE) throw new HostError("invalidData");
  return v;
};

// host: host/index.js (equipTerminals: terminals, launch, viewers, tabs(), liveSessions()); env(): the environment
// for a terminal opened for a peer (a promise; with the proxy, on a desktop); info(): what host.info adds (the node's
// own description comes from the links); liveMs: how often the live status is looked at for the peers.
function createServed({ host, env = async () => terminalEnv(process.env), info = () => ({}), liveMs = LIVE_MS, trash = null, offerTimes = {} }) {
  const { terminals, launch, sendText, sessions, git, setup, viewers } = host;
  const path = require("node:path");
  const fs = require("node:fs");
  let links = null, layout = null, lagTimer = null;
  // The files of this computer for the peers (docs/FILES.md); trash: the system's bin, where there is one.
  const files = createFiles({ home: host.home, trash, notify: (peer, name, data) => links?.notify(peer, name, data) });
  // A file of this computer offered to a paired phone, which pulls it itself (host/file-offers.js); offerTimes: its
  // answerMs / expireMs / idleMs (a test's are short).
  const offers = createFileOffers({
    files, ...offerTimes,
    notify: (peer, name, data) => links?.notify(peer, name, data),
    isPhone: peer => Boolean(links?.online(peer) && links.sees(peer) && links.nodes().some(n => n.id === peer && n.kind === "mobile"))
  });
  const ctl = new Set();      // peers that made a terminals or ports request on their current link: their frames are taken
  const behind = new Map();   // peer id -> Set of terminal ids whose output it is behind on
  const ports = createPortStreams({
    send: (peer, frame) => links?.sendBinary(peer, frame),
    notify: (peer, name, data) => links?.notify(peer, name, data),
    ownPort: () => links?.self()?.port || 0
  });

  // ---------- tabs as a peer sees them ----------
  const selfId = () => links?.self()?.id || "";
  function namesOf() {
    const names = new Map((links?.nodes() || []).map(n => [n.id, n.name]));
    const self = links?.self();
    if (self) names.set(self.id, self.name);
    return names;
  }
  const whoOut = who => (who === "" ? selfId() : who);
  // One tab of host.tabs() for the peers; names: namesOf().
  function tabOut(tab, names) {
    return {
      ...tab,
      ownerName: tab.owner ? names.get(tab.owner) || "" : "",
      viewers: tab.viewers.map(v => { const id = whoOut(v.id); return { id, name: names.get(id) || "", kind: v.kind }; }),
      driver: tab.driver === null ? null : whoOut(tab.driver)
    };
  }
  const tabsOut = (tabs = host.tabs()) => { const names = namesOf(); return tabs.map(x => tabOut(x, names)); };
  const findTab = id => host.tabs().find(x => x.id === id) || null;
  function tabFor(id) {
    const tab = findTab(id);
    if (!tab) throw new HostError("invalidData", "No such terminal here.");
    return tab;
  }
  const isViewer = (id, peer) => Boolean(viewers.state(id)?.viewers.includes(peer));

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
  // A host put together without liveAgents (a test's) has its live sessions only.
  const liveOut = () => (host.liveAgents || host.liveSessions)();
  const METHODS = {
    // terminals: 2 - this host shares its terminals as docs/SHARED-SESSIONS.md 4 says (viewers, driver, resize).
    // ports: 1 - it forwards its loopback ports (ports.*, docs/PORT-FORWARDING.md).
    // files: 1 - its files are listed, read, changed and taken (files.*, docs/FILES.md); trash: 1 - what is
    // deleted goes to the system's bin, 0 - for good.
    // projects: 1 - it takes a folder of its own as a project from a peer (projects.add).
    "host.info": () => ({ ...(links?.self() || {}), code: undefined, platform: process.platform, home: host.home, agents: sessions.get()?.agents || [], terminals: 2, ports: 1, projects: 1, files: 1, trash: files.hasTrash ? 1 : 0, ...info() }),
    // {path}: a folder of this computer listed as a project here, so a peer has somewhere to work on a computer that
    // lists nothing yet. The path is the peer's own typing (it sees none of the folders here): project-folder.js takes
    // it only when it is a whole path to a folder that exists (folderNotAbsolute, folderMissing, notFolder). Nothing
    // is made or changed on the disk. -> { name, path, added } - added: false when it was a project already. The
    // peers hear of it with the next "data", as of any change of the list.
    "projects.add": p => {
      const dir = resolveFolder(p?.path, { home: host.home });
      const reg = sessions.registry.read();
      const added = !getProject(reg, dir);
      const item = addProject(reg, dir);
      sessions.registry.save(reg);
      return { name: String(item.name || ""), path: item.path, added };
    },
    "sessions.list": async () => localSnapshot(await sessions.data()),
    // Each with `term`: the terminal here the session runs in, or "". With a stand-in for each agent terminal that
    // has no live session (host/index.js liveAgents), so a peer lists it under its agents too.
    "live.list": () => liveOut(),
    "git.diff": p => git.diff(p),
    "git.query": p => git.query(p),
    "git.execute": p => git.execute(p),
    "git.status": () => git.get(),
    "git.refresh": () => git.refresh({ force: true }),
    // What the peer shows now of this host's repositories ({ dirs }: their folders): those are asked about, when
    // their status is not fresh - the others stay as they are (git-status.js). With no folders it still says that
    // somebody is looking: what changed here meanwhile is taken. What it brings goes out as the "git" event.
    "git.shown": p => git.refresh({ reason: "page", shown: (Array.isArray(p?.dirs) ? p.dirs : []).slice(0, GIT_SHOWN_MAX).map(d => str(d, 4096)) }).then(() => true),
    "usage.get": () => host.usage.get(),
    "limits.get": () => { host.limits.refresh().catch(() => {}); return host.limits.get(); },
    "resources.get": () => host.resources.get() || host.resources.refresh(),
    // A session running here without a terminal of this host's own, ended for a peer (launch.stopSession).
    "sessions.stop": p => launch.stopSession(str(p?.agent, 16), str(p?.id, 200)),
    // A session's last messages and a few facts about it (host/session-preview.js): {agent, id, textMax} -> the
    // preview (at most a few messages of a bounded length), or null when there is nothing to read. A session started
    // since the last scan is looked up by its id. textMax: how many characters of each message the peer wants - a
    // phone's chat view asks for whole answers, where the desktop's preview pane shows their start (the default, and
    // what a peer that names none gets, as before); never more than PREVIEW_TEXT_MAX, a message past it comes cut.
    "sessions.preview": p => {
      const agent = str(p?.agent, 16), id = str(p?.id, 200);
      if (!isAgent(agent) || !SESSION_ID.test(id)) throw new HostError("invalidSession");
      const s = sessions.get()?.sessions.find(x => x.agent === agent && x.id === id)
        ?? { agent, id, file: agent === "Claude" ? host.findTranscript(id) : "" };
      const textMax = Number.isInteger(p?.textMax) && p.textMax > 0 ? Math.min(p.textMax, PREVIEW_TEXT_MAX) : 0;
      return textMax ? host.preview(s, { textMax }) : host.preview(s);
    },
    // Every terminal here, for every peer; `all` (what a phone asked for before) means nothing any more.
    "terminals.list": () => tabsOut(),
    // {cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt, force} -> the tab, opened here for
    // the peer (owner). A resume of a session that runs in a terminal here opens nothing: that terminal's tab, with
    // already: true. One that runs here outside AgentDeck's terminals is refused (sessionRunningOutside) unless
    // force: true. Opening nothing attaches: the peer attaches once it shows the terminal.
    "terminals.open": async (p, peer) => {
      const cwd = str(p?.cwd, 4096), kind = str(p?.kind, 16);
      if (kind === "resume") {
        const agent = str(p?.agent, 16), sessionId = str(p?.sessionId, 200);
        const running = launch.runningTab(agent, sessionId);
        if (running) return { ...tabOut(findTab(running.id), namesOf()), already: true };
        if (p?.force !== true && (await host.liveSessions({ fresh: true })).some(l => l.agent === agent && l.id === sessionId)) throw new HostError("sessionRunningOutside");
      }
      const spec = launch.commandFor({ kind, agent: p?.agent, sessionId: p?.sessionId, prompt: p?.prompt }, cwd);
      try {
        const id = await launch.openTerminal(cwd, spec.command, { ...spec.meta, owner: peer.id }, await env(), `peer ${peer.name}`, spec.argv);
        return tabOut(findTab(id), namesOf());
      } catch (e) {
        spec.undo();
        throw e;
      }
    },
    // -> { scrollback, end, exitCode, cols, rows, driver }; the peer is a viewer from now on (tooManyViewers past
    // viewers.MAX_VIEWERS), and gets the output.
    "terminals.attach": (p, peer) => {
      const tab = tabFor(str(p?.id, 64));
      const v = viewers.attach(tab.id, peer.id, { kind: peer.kind || "" });
      behind.get(peer.id)?.delete(tab.id);
      return { ...terminals.attach(tab.id), cols: v.cols, rows: v.rows, driver: v.driver === null ? null : whoOut(v.driver) };
    },
    // The peer stops viewing; the terminal goes on (a size it drove is handed back, viewers.js).
    "terminals.detach": (p, peer) => {
      const id = str(p?.id, 64);
      viewers.detach(id, peer.id);
      behind.get(peer.id)?.delete(id);
      return true;
    },
    // Stop: the terminal ends, for every device (the name stays: older peers and the phone use it).
    "terminals.close": p => terminals.close(tabFor(str(p?.id, 64)).id),
    // {id, cols, rows}: the peer takes the size (its "fit to phone", "use my size"); {id, release: true}: gives it
    // back. Only for a viewer. -> { cols, rows, driver }.
    "terminals.resize": (p, peer) => {
      const id = tabFor(str(p?.id, 64)).id;
      // Not (or no longer) a viewer: a take that overtook the attach after a reconnect. A code of its own, so that the
      // device attaches and asks again (mobile/src/data.js) instead of showing "invalid data".
      if (!isViewer(id, peer.id)) throw new HostError("notViewing");
      if (p.release === true) viewers.release(id, peer.id);
      else viewers.take(id, peer.id, dim(p.cols), dim(p.rows));
      const s = viewers.state(id);
      return { cols: s.cols, rows: s.rows, driver: s.driver === null ? null : whoOut(s.driver) };
    },
    // {id, text}: the text typed into the agent in that terminal and submitted (host/send-text.js), as the command
    // centre's send_to_session does. Refused (agentNotReady) unless an agent runs there and waits for input. Not a
    // person's keystrokes: the size stays whose it is.
    "terminals.send": async p => {
      const tab = tabFor(str(p?.id, 64));
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
      return { ...tabOut(findTab(id), namesOf()), dir };
    },
    // A file for a terminal here (a pasted picture, a dropped file): {name, data (base64)} -> its path here.
    "files.put": p => {
      if (typeof p?.data === "string" && p.data.length > Math.ceil(MAX_BYTES * 4 / 3) + 4) throw new HostError("tooBig");
      return savePaste(str(p?.name, 200), Buffer.from(str(p?.data, Infinity), "base64"));
    },
    // {term?} -> [{ port, address, pid, process, own }]: the TCP ports something listens on here; own: the process is
    // in the tree of the terminal `term` (one that is gone marks none). Asked when a menu opens, never on a timer.
    "ports.list": async p => {
      const term = p?.term === undefined ? "" : str(p.term, 64);
      const rootPid = term ? terminals.getTabs().find(x => x.id === term)?.pid : undefined;
      // host/ports.js never rejects: a list it could not read is empty and marked `failed`, which JSON would lose.
      const list = await require("../host/ports").listListening({ rootPid });
      if (list.failed) throw new HostError("portsUnread", "The listening ports could not be read there.");
      // The mesh's own port is never forwarded (port-streams.js: "notAllowed"), so it is not offered.
      const own = links?.self()?.port || 0;
      return list.filter(x => x.port !== own);
    },
    // {stream (a UUID the peer makes), port} -> true once connected to that port on this computer's loopback; the
    // stream's bytes then pass as frames (port-streams.js: refused, notAllowed, tooManyStreams, invalidData).
    "ports.open": (p, peer) => ports.open(peer.id, p?.stream, p?.port),
    "ports.close": (p, peer) => { ports.close(peer.id, str(p?.stream, 36)); return true; },
    // This computer's files (host/files.js says what each takes and answers). A copy is a job of the peer that began
    // it; an upload is that peer's too and goes with its link, and so is a folder's order kept for its next pages. A
    // read is told to the offers: a phone that pulls a file offered to it is still at it.
    "files.list": (p, peer) => files.list(p, peer.id),
    "files.stat": p => files.stat(p),
    "files.read": (p, peer) => { offers.reading(peer.id, p?.path); return files.read(p); },
    "files.mkdir": p => files.mkdir(p),
    "files.rename": p => files.rename(p),
    "files.delete": p => files.remove(p),
    "files.copy": (p, peer) => files.copy(peer.id, p),
    "files.job": (p, peer) => files.job(peer.id, p),
    "files.cancel": (p, peer) => files.cancel(peer.id, p),
    "files.begin": (p, peer) => files.begin(peer.id, p),
    "files.write": (p, peer) => files.write(peer.id, p),
    "files.commit": (p, peer) => files.commit(peer.id, p),
    "files.abort": (p, peer) => files.abort(peer.id, p),
    // {offer, state: "accepted" | "declined" | "done" | "failed", error?}: a phone's word on a file offered to it.
    "files.answer": (p, peer) => offers.answer(peer.id, p),
    "git.branches": p => setup.branches(str(p?.dir, 4096)),
    "setup.status": () => setup.status(),
    "setup.sshKey.generate": () => setup.generateKey(),
    "setup.knownHosts.add": p => setup.addKnownHost(str(p?.host, 253)),
    "setup.gitIdentity.set": p => setup.setGitIdentity({ name: p?.name, email: p?.email })
  };
  function api(method, params, peer) {
    if (!Object.hasOwn(METHODS, method)) throw new HostError("unknownMethod");
    // Only a peer that may control this computer gets here (links.js); from now on its frames are taken too.
    if ((method.startsWith("terminals.") || method.startsWith("ports.")) && typeof peer?.id === "string") ctl.add(peer.id);
    return METHODS[method](params, peer);
  }

  // ---------- output, and the viewers that fall behind ----------
  function markBehind(peer, id) {
    if (!behind.has(peer)) behind.set(peer, new Set());
    behind.get(peer).add(id);
    lagTimer ||= setInterval(checkBehind, LAG_CHECK_MS);
    lagTimer.unref?.();
  }
  // A peer whose link drained enough hears once, for each terminal it is behind on, to attach again.
  function caughtUp(peer) {
    if (links.buffered(peer) >= LAG_LOW) return false;
    for (const id of behind.get(peer) || []) links.notify(peer, "terminal.resync", { id });
    behind.delete(peer);
    return true;
  }
  function checkBehind() {
    for (const peer of [...behind.keys()]) {
      if (!links.online(peer)) behind.delete(peer);
      else caughtUp(peer);
    }
    if (!behind.size) {
      clearInterval(lagTimer);
      lagTimer = null;
    }
  }
  function sendOutput(peer, id, data, end) {
    if (behind.get(peer)?.has(id)) {
      caughtUp(peer);
      return;
    }
    if (links.buffered(peer) > LAG_HIGH) return void markBehind(peer, id);
    links.sendBinary(peer, frames.encodeOutput(id, data, end));
  }

  function attach(l) {
    links = l;
    layout = require("./layout").createLayout({ links, registry: sessions.registry });
    host.on("data", () => layout.reconcile());
    host.on("terminal:data", ({ id, data, end }) => {
      for (const who of viewers.state(id)?.viewers || []) if (who !== "" && links.sees(who)) sendOutput(who, id, data, end);
    });
    host.on("terminals", tabs => {
      for (const [peer, ids] of behind) for (const id of [...ids]) if (!tabs.some(x => x.id === id && !x.exited)) ids.delete(id);
      // Every peer that may see this computer hears of all its terminals; one that may not (a host: links.js sees)
      // hears nothing.
      const out = tabsOut(tabs);
      for (const n of links.nodes()) if (n.status === "online" && links.sees(n.id)) links.notify(n.id, "terminals", out);
    });
    // A terminal's size or driver changed: to every peer that views it (they draw at the host's size).
    host.on("terminal:size", ({ id, cols, rows, driver }) => {
      const data = { id, cols, rows, driver: driver === null || driver === undefined ? null : whoOut(driver) };
      for (const who of viewers.state(id)?.viewers || []) if (who !== "" && links.sees(who)) links.notify(who, "terminal.size", data);
    });
    // What this computer has and does, to the peers that may see it (links.js notifyAll: desktops and phones, never a
    // relay or a resource host).
    host.on("data", data => links.notifyAll("data", localSnapshot(data)));
    host.on("git", g => links.notifyAll("git", g));
    host.on("usage", u => links.notifyAll("usage", u));
    host.on("limits", l => links.notifyAll("limits", l));
    host.on("resources", r => links.notifyAll("resources", r));
    // The live status has no event of its own (the windows poll it): connected peers get it every few seconds,
    // when it changed. So it must hold nothing that changes by itself - a figure measured anew each time would send
    // the whole list to every peer and phone on every round, for as long as a session runs.
    let lastLiveSig = "";
    setInterval(async () => {
      if (!links.nodes().some(n => n.status === "online")) return;
      const live = await liveOut();
      const sig = JSON.stringify(live);
      if (sig !== lastLiveSig) {
        lastLiveSig = sig;
        links.notifyAll("live", live);
      }
    }, liveMs).unref();
    // A peer's keystrokes and sizes, taken only from a peer that asked for terminals or ports on this link (ctl) and
    // may see this computer. A forwarded port's stream frame goes to the stream that peer opened (none: dropped), never
    // on to the terminals. Keystrokes go to any running terminal; they count for the size only from a viewer. The terminal's
    // own answers (isReport: the device's xterm.js answering a program's question, also one replayed from the
    // scrollback it was just sent) are written, but are no one's typing - else merely opening a terminal would move its
    // size to the opener. A size is a viewer's want; from anyone else it is dropped.
    links.on("binary", ({ node, data }) => {
      if (!ctl.has(node) || !links.sees(node)) return;
      const f = frames.decode(data);
      if (!f || f.type === "output") return;
      if (f.type.startsWith("stream-")) return void ports.frame(node, f);
      const tab = terminals.getTabs().find(x => x.id === f.id);
      if (!tab || tab.exited) return;
      if (f.type === "input") {
        if (isReport(f.data)) terminals.type(f.id, f.data);
        else {
          viewers.input(f.id, node);
          terminals.input(f.id, f.data);
        }
      } else {
        try { viewers.want(f.id, node, f.cols, f.rows); } catch {} // a size out of bounds is dropped
      }
    });
    // A link that dropped: the peer views nothing any more (a size it drove is handed back), the streams of its
    // forwarded ports are closed, and its frames are not taken until it asks again.
    links.on("link", ({ node, up }) => {
      if (up) return;
      ctl.delete(node);
      behind.delete(node);
      ports.drop(node);
      files.drop(node);
      offers.drop(node);
      viewers.leave(node);
    });
  }

  return { api, attach, ports, files, offers, get layout() { return layout; } };
}

module.exports = { createServed };
