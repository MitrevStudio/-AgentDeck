// The host: everything AgentDeck knows and does about the agent sessions of this computer, without a window. The
// projects and sessions (sessions.js), the live status (live.js), the host's own terminals (terminals.js) and the
// launches into them (launch.js), the git status of the folders (git-status.js), the tokens and cost (usage.js), the
// full-text search (search.js) and a session's preview (session-preview.js). Electron's main process creates one for
// the computer it runs on and shows it in its windows; the headless host (host/) creates the same and serves it to
// peers. Nothing here needs Electron or the pages' language: errors carry codes (errors.js).
//
// The terminals belong to the host (docs/SHARED-SESSIONS.md): every device attaches to them and detaches - this
// computer's own window (who "") and the peers (who: their node id; mesh/serve.js) - and viewers.js keeps who has each
// one open and whose size it has. host.tabs() lists them with their viewers and driver, host.liveSessions() tells the
// terminal each live session runs in (term), host.restoreTerminals() opens those a restart took anew under their ids.
//
// Events (an EventEmitter): "data" (the scan's cache), "terminal:data" ({id, data, end}), "terminal:exit" ({id,
// code, lost}), "terminal:size" ({id, cols, rows, driver}: the size or the driver changed), "terminals" (host.tabs():
// the tabs changed, or their viewers or driver), "usage" (the summary), "git" (the snapshot).
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSessions } = require("./sessions");
// Windows: a DockPty per terminal, which outlives the host; elsewhere node-pty, children of the host.
const { createTerminals } = require(process.platform === "win32" ? "./terminals" : "./terminals-pty");
const { createViewers } = require("./viewers");
const { terminalEnv } = require("./terminal-env");
const { createLaunch, MAX_TERMINALS } = require("./launch");
const { createTabLinks } = require("./tab-links");
const { createSetup } = require("./setup");
const { liveSessions: claudeLiveSessions, findTranscript } = require("./live");
const { createCodexLive } = require("./codex-live");
const sessionPreview = require("./session-preview");
const gitStatus = require("./git-status");
const usage = require("./usage");

// A light rescan refreshes the full-text index at most this often: the search worker re-reads grown transcripts.
const LIGHT_INDEX_MS = 60000;

// The search needs node:sqlite (Node 22.5+); a host without it lists and previews sessions but does not search them.
function createSearch(dbFile) {
  try {
    require("node:sqlite");
  } catch {
    console.error("The full-text search is off: this Node has no node:sqlite.");
    return { index() {}, query: () => Promise.resolve([]) };
  }
  return require("./search").createSearch({ dbFile });
}

// The callbacks a terminal backend (terminals.js, terminals-pty.js) is made with for a host that equipTerminals then
// equips: output and exits go out as the host's events, changes as its tabs, sizes through its viewers.
function terminalEvents(host) {
  return {
    onData: (id, data, end) => host.emit("terminal:data", { id, data, end }),
    onExit: (id, code, lost) => host.emit("terminal:exit", { id, code, lost }),
    onChange: () => host.tabsChanged?.(),
    onResize: id => host.viewers?.sized(id)
  };
}

const REOPEN_AT_ONCE = 4;

// Gives a host (an EventEmitter) its terminals as docs/SHARED-SESSIONS.md 4.7 describes them: host.terminals,
// host.launch, host.viewers (viewers.js), host.tabs(), host.liveSessions() (each with `term`), host.restoreTerminals()
// and host.tabsChanged(). terminals: a backend made with terminalEvents(host); launch: launch.js over it;
// liveSessions(): the live status as live.js and codex-live.js read it; log(...parts): the launch log. createHost does
// this, and tests make their hosts the same way.
function equipTerminals(host, { terminals, launch, liveSessions, log = () => {} }) {
  const viewers = createViewers({
    resize: (id, cols, rows) => terminals.resize(id, cols, rows), size: id => terminals.size(id),
    onSize: e => host.emit("terminal:size", e), onChange: () => tabsChanged()
  });
  // The tabs with their viewers ([{ id, name, kind }]: id the viewer's who, "" for this computer's own window) and
  // driver (a who, or null). Names are the caller's to fill in (mesh/serve.js, main.js): ownerName and name are "".
  function tabs() {
    return terminals.getTabs().map(x => ({
      ...x, ownerName: "", reopened: x.reopened === true,
      viewers: viewers.list(x.id).map(v => ({ id: v.who, name: "", kind: v.kind })), driver: viewers.driverOf(x.id)
    }));
  }
  // A terminal that ended or went takes its viewers with it; everyone hears of the tabs.
  function tabsChanged() {
    viewers.prune(new Set(terminals.getTabs().filter(x => !x.exited).map(x => x.id)));
    host.emit("terminals", tabs());
  }
  // The live sessions, each with the terminal here it runs in ("" when none: it runs elsewhere, or in none).
  async function liveWithTerm() {
    const live = await liveSessions();
    const running = new Map(terminals.getTabs().filter(x => !x.exited && x.sessionId).map(x => [`${x.agent}:${x.sessionId}`, x.id]));
    return live.map(l => ({ ...l, term: running.get(`${l.agent}:${l.id}`) || "" }));
  }

  // ---------- after a restart (4.6) ----------
  // A terminal the restart took, opened anew under its id: an agent resumes its session (a resume that cannot be
  // done becomes a shell), anything else is a shell in its folder - no other command runs again. "" when nothing
  // could open; its entry goes then.
  async function reopen({ id, createdAt, meta }, env) {
    const again = { id, createdAt, reopened: true, owner: meta.owner };
    if (meta.agent && meta.sessionId) {
      try {
        const spec = launch.resumeCommand(meta.agent, meta.sessionId, meta.cwd);
        return await launch.openTerminal(meta.cwd, spec.command, { ...spec.meta, title: meta.title || spec.meta.title, ...again }, env, "reopen resume", spec.argv);
      } catch (e) {
        log(`reopening ${id.slice(0, 8)} with its session failed (${e.message}), a shell instead`, `cwd="${meta.cwd}"`);
      }
    }
    try {
      return await launch.openTerminal(meta.cwd, null, again, env, "reopen", null);
    } catch (e) {
      log(`reopening ${id.slice(0, 8)} failed (${e.message})`, `cwd="${meta.cwd}"`);
      terminals.forgetEntry(id);
      return "";
    }
  }
  // The terminals the last run of the host left: those still running attached (Windows: DockPty outlives the host),
  // those a restart took opened anew under their ids, newest first while there is room (MAX_TERMINALS), marked
  // reopened. skip(meta): entries the caller brings back its own way (main.js: the command centre) - not opened anew,
  // and their entries go. env: the environment for the terminals opened anew (default: this process's, no proxy).
  // A terminal "Stop all terminals and quit" stopped left no entry: nothing opens. -> { attached, kept, reopened }.
  async function restoreTerminals({ skip = () => false, env = null } = {}) {
    const { attached, kept, dead = [] } = await terminals.restore();
    let room = Math.max(0, MAX_TERMINALS - terminals.countRunning());
    const todo = [];
    for (const entry of [...dead].sort((a, b) => b.createdAt - a.createdAt)) {
      let skipped = true;
      try { skipped = Boolean(skip(entry.meta)); } catch {}
      if (skipped || room <= 0 || !launch.isDir(entry.meta.cwd)) {
        terminals.forgetEntry(entry.id);
        continue;
      }
      room--;
      todo.push(entry);
    }
    const reopened = [];
    const theEnv = env || terminalEnv(process.env);
    const next = async () => {
      for (let entry; (entry = todo.shift());) {
        const id = await reopen(entry, theEnv);
        if (id) reopened.push(id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(REOPEN_AT_ONCE, todo.length) }, next));
    if (reopened.length) tabsChanged();
    return { attached, kept, reopened };
  }

  return Object.assign(host, { terminals, launch, viewers, tabs, tabsChanged, liveSessions: liveWithTerm, restoreTerminals });
}

// dataDir: the host's own files (registry, caches, terminals, prompts); home: the user's home (the agents' folders);
// isExcluded(cwd): folders whose sessions are not the user's work; untitled(agent, shortId) and noLauncher(exe):
// texts in the user's language; log(...parts): the launch log; gitActive(): whether anything shows the git status
// now (it is refreshed in the background only then).
function createHost({ dataDir, home, isExcluded, untitled, noLauncher, log = () => {}, gitActive = () => true, fetch: fetchLimits = globalThis.fetch }) {
  const host = new EventEmitter();
  const limits = require("../limits").createAllLimits({ fetch: fetchLimits, findExecutable: require("./sessions").findOnPath, onChange: l => host.emit("limits", l) });
  const resources = require("./resources").createResources({ home, onChange: r => host.emit("resources", r) });
  const search = createSearch(path.join(dataDir, "search.db"));
  let lastKeysSig = "", lastIndexAt = 0;

  const sessions = createSessions({
    dataDir, home, isExcluded, untitled,
    onChange: data => host.emit("data", data),
    onScanned: (list, full) => {
      // New or removed sessions are indexed at once; text added to known ones waits for the next index.
      const keysSig = list.map(s => `${s.agent}:${s.id}`).join(",");
      const newKeys = keysSig !== lastKeysSig;
      lastKeysSig = keysSig;
      if (full || newKeys || Date.now() - lastIndexAt >= LIGHT_INDEX_MS) {
        lastIndexAt = Date.now();
        search.index(list);
      }
      // Transcripts may have grown too, and there may be new folders: their results come as events of their own.
      usage.refresh().catch(err => console.error("Usage scan failed:", err.message));
      if (full) gitStatus.refresh().catch(err => console.error("Git status failed:", err.message));
    }
  });
  const terminals = createTerminals({ userDataDir: dataDir, ...terminalEvents(host) });
  const codexLive = createCodexLive({ sessions: () => sessions.get()?.sessions || [], tabs: () => terminals.getTabs(), link: terminals.link });
  const liveSessions = async () => (await Promise.all([claudeLiveSessions(), codexLive()])).flat();
  const launch = createLaunch({ dataDir, terminals, sessions, liveSessions, findTranscript, log, noLauncher });
  equipTerminals(host, { terminals, launch, liveSessions, log });
  const sendText = require("./send-text").createSendText({ terminals, liveSessions });
  const tabLinks = createTabLinks({ terminals, liveSessions });
  const setup = createSetup({ agents: () => sessions.agents });
  gitStatus.configure(async () => ({
    sessions: sessions.get()?.sessions || [], terminals: terminals.getTabs(), live: await liveSessions(),
    register: async dir => {
      const reg = sessions.registry.read();
      reg.removed = reg.removed.filter(x => x !== sessions.norm(dir));
      if (!reg.projects.some(p => !p.node && sessions.norm(p.path) === sessions.norm(dir))) reg.projects.push({ name: path.basename(dir) || dir, path: dir });
      sessions.registry.save(reg);
      await sessions.scan();
    },
    unregister: async dir => {
      const reg = sessions.registry.read();
      reg.projects = reg.projects.filter(p => p.node || sessions.norm(p.path) !== sessions.norm(dir));
      sessions.registry.save(reg);
      await sessions.scan();
    }
  }));
  const preview = (s, opts = {}) => sessionPreview.preview(s, { ...opts, openCodeDb: sessions.OPENCODE_DB });

  // The background work: watching the transcripts, the periodic full scan, linking tabs to their sessions, the usage
  // figures, the git status, and the first scan.
  function start() {
    limits.start();
    resources.start();
    sessions.watchTranscripts();
    sessions.scanPeriodically();
    tabLinks.start();
    usage.start({ claudeDir: sessions.CLAUDE_DIR, codexDir: sessions.CODEX_DIR, openCodeDb: sessions.OPENCODE_DB, userData: dataDir, onChange: u => host.emit("usage", u) })
      .catch(err => console.error("Usage scan failed:", err.message));
    gitStatus.start({
      projects: () => sessions.get()?.registry.projects.filter(p => !p.node).map(p => p.path) || [],
      dirs: () => { const data = sessions.get(); return data ? [...data.registry.projects.filter(p => !p.node).map(p => p.path), ...data.sessions.flatMap(s => [s.cwd, s.workDir])] : []; },
      onChange: g => host.emit("git", g),
      active: gitActive
    });
    sessions.scan().catch(err => console.error("Initial scan failed:", err.message));
  }
  // Quitting: what the usage worker has not written yet goes to disk first. The terminals are the caller's to detach
  // or stop.
  const flush = () => usage.flush();
  function stop() {
    gitStatus.stop();
    limits.stop();
    resources.stop();
    sessions.stop();
  }

  // terminals, launch, viewers, tabs, liveSessions (with term) and restoreTerminals come from equipTerminals.
  return Object.assign(host, {
    dataDir, home, sessions, sendText, setup, findTranscript, preview, search,
    git: gitStatus, usage, limits, resources, start, flush, stop
  });
}

module.exports = { createHost, equipTerminals, terminalEvents };
