// The host: everything AgentDeck knows and does about the agent sessions of this computer, without a window. The
// projects and sessions (sessions.js), the live status (live.js), the host's own terminals (terminals.js) and the
// launches into them (launch.js), the git status of the folders (git-status.js), the tokens and cost (usage.js), the
// full-text search (search.js) and a session's preview (session-preview.js). Electron's main process creates one for
// the computer it runs on and shows it in its windows; the headless host (host/) creates the same and serves it to
// peers. Nothing here needs Electron or the pages' language: errors carry codes (errors.js).
//
// Events (an EventEmitter): "data" (the scan's cache), "terminal:data" ({id, data, end}), "terminal:exit" ({id,
// code, lost}), "terminals" (the tabs), "usage" (the summary), "git" (the snapshot).
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSessions } = require("./sessions");
// Windows: a DockPty per terminal, which outlives the host; elsewhere node-pty, children of the host.
const { createTerminals } = require(process.platform === "win32" ? "./terminals" : "./terminals-pty");
const { createLaunch } = require("./launch");
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
  const terminals = createTerminals({
    userDataDir: dataDir,
    onData: (id, data, end) => host.emit("terminal:data", { id, data, end }),
    onExit: (id, code, lost) => host.emit("terminal:exit", { id, code, lost }),
    onChange: tabs => host.emit("terminals", tabs)
  });
  const codexLive = createCodexLive({ sessions: () => sessions.get()?.sessions || [], tabs: () => terminals.getTabs() });
  const liveSessions = async () => (await Promise.all([claudeLiveSessions(), codexLive()])).flat();
  const launch = createLaunch({ dataDir, terminals, sessions, liveSessions, findTranscript, log, noLauncher });
  const tabLinks = createTabLinks({ terminals, liveSessions });
  const setup = createSetup({ agents: () => sessions.agents });
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
    limits.stop();
    resources.stop();
    sessions.stop();
  }

  return Object.assign(host, {
    dataDir, home, sessions, terminals, launch, setup, liveSessions, findTranscript, preview, search,
    git: gitStatus, usage, limits, resources, start, flush, stop
  });
}

module.exports = { createHost };
