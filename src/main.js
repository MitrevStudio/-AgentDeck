const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, globalShortcut } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
// Both have to be in place before anything below reads userData.
// Tests run a second, isolated instance against a throwaway profile (the single-instance lock is per profile too).
const testProfile = process.env.AGENTDECK_USER_DATA || process.env.ASM_USER_DATA;
// Kept from the app's former name: the saved API keys are encrypted with a key held in this profile's Local State,
// so the folder cannot move. Fresh installs get the default (%APPDATA%\AgentDeck).
const formerProfile = path.join(app.getPath("appData"), "ai-session-manager");
if (testProfile) app.setPath("userData", path.resolve(testProfile));
else if (fs.existsSync(formerProfile)) app.setPath("userData", formerProfile);
// Linux under Wayland: Chromium multiplies the display's scale by the desktop's text scaling factor (GNOME's
// text-scaling-factor), and a window of a fixed size then draws its page smaller than the window the compositor
// gives it - the rest stays empty. A factor of 1 leaves only the display's own scale, applied per monitor.
const wayland = process.platform === "linux" && Boolean(process.env.WAYLAND_DISPLAY)
  && !/x11/i.test(app.commandLine.getSwitchValue("ozone-platform") || process.env.ELECTRON_OZONE_PLATFORM_HINT || "");
if (wayland && !app.commandLine.hasSwitch("force-device-scale-factor")) app.commandLine.appendSwitch("force-device-scale-factor", "1");
const { terminalEnv } = require("./host/terminal-env");
const { focusSession, allowForeground, terminalWindows, raiseNewTerminal } = require("./terminal-focus");
const { createLog } = require("./shared/log-file");
const promptLaunch = require("./host/prompt-launch");
const { createOrchestrator } = require("./orchestrator");
const { createEdgeBar } = require("./edge-bar");
const { makeIcon } = require("./app-icon");
const prefs = require("./prefs");
const network = require("./network");
const updater = require("./updater");
let answerPopup = null;
const day = require("./day");
const voiceContext = require("./voice-context").createVoiceContext({ liveSessions: (...a) => liveSessions(...a), findTranscript: id => findTranscript(id) });

const { createNotifier } = require("./notify");
const { createHost } = require("./host");
const { savePaste } = require("./host/paste");
const { createLinks } = require("./mesh/links");
const { createServed } = require("./mesh/serve");
const { DEFAULT_PORT } = require("./mesh/identity");
const frames = require("./mesh/frames");
const { normPath } = require("./shared/util");
const { HostError } = require("./host/errors");
const { getProject, isPinned, setPin, setGroups, unpinEmptyGroups, repin, keyOf, keyify } = require("./host/registry");
const atomicFile = require("./shared/atomic-file");
// AgentDeck's own terminal tabs (prefs "sessionsIn": "tabs"); their output goes to the manager window only.
function sendToManager(channel, payload) {
  if (managerWin && !managerWin.isDestroyed()) {
    managerWin.webContents.send(channel, payload);
  }
}
// The two windows that list sessions (the voice windows have no use for the data).
function broadcast(channel, payload) {
  for (const w of [managerWin, bar?.win]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
// Where each terminal is on screen (workspace.js): spaces (projects), their tabs, and the panes a tab is split into.
// The window gets the layout and the terminals' list together, as one picture.
const { createWorkspace, getPanes } = require("./workspace");
const workspace = createWorkspace({ onChange: () => { sendWorkspace(); scheduleWorkspaceSave(); } });
// The host (host/index.js): the sessions, the terminals, the launches, the git status and the usage of this computer.
// Its events go to the windows; the command centre's own folder is left out of the user's projects and sessions.
const host = createHost({
  dataDir: app.getPath("userData"), home: os.homedir(), fetch: (url, init) => network.fetch(url, init),
  isExcluded: cwd => orchestrator.isOwn(cwd),
  untitled: (agent, id) => t("session.untitled", { agent, id }),
  noLauncher: exe => t("voice.command.error.noLauncher", { exe }),
  log: (...parts) => launchLog(...parts),
  // Git: refreshed after each scan, when the edge menu opens or the manager window gets the focus (the pages ask),
  // and every two minutes while either is in view.
  gitActive: () => Boolean(bar?.isVisible() || (managerWin && !managerWin.isDestroyed() && managerWin.isVisible() && !managerWin.isMinimized()))
});
const { sessions, terminals, launch, liveSessions, findTranscript, usage, limits, resources, git: gitStatus, search: fullText } = host;
host.on("limits", l => broadcast("limits:changed", l));
host.on("resources", r => broadcast("resources:changed", r));
host.on("data", data => broadcast("data:changed", data));
host.on("usage", u => broadcast("usage:changed", u));
host.on("git", g => broadcast("git:changed", g));
host.on("terminal:data", d => sendToManager("terminal:data", d));
// A program that ends takes its pane with it, as in Herdr. A terminal lost with its DockPty (killed, or Windows
// shutting down first) keeps its pane, which opens anew on the next start.
host.on("terminal:exit", ({ id, lost }) => { if (lost) terminals.setNote(id, t("term.lost")); else terminals.close(id); });
host.on("terminals", () => { prunePanes(); sendWorkspace(); scheduleWorkspaceSave(); updateTrayCount(); orchestrator.terminalsChanged(); });
// Panes whose terminal is gone (closed, or ended) leave the layout.
function prunePanes() {
  const alive = new Set([...terminals.getTabs().map(x => x.id), ...remoteTerms.keys()]);
  for (const tab of Object.values(workspace.snapshot().tabs)) {
    getPanes(tab.root).filter(term => !alive.has(term)).forEach(term => workspace.removeTerm(term));
  }
}
function getWorkspaceView() {
  return { ...workspace.snapshot(), terminals: [...terminals.getTabs().filter(x => !x.owner), ...remoteTabs()] };
}
// Quitting leaves AgentDeck's own terminals running (the next start attaches to them again); the tray's "Stop all
// terminals and quit" ends them, asked first while any runs.
async function stopAllAndQuit() {
  const running = terminals.countRunning();
  if (running) {
    const options = {
      type: "warning", buttons: [t("quit.stopAll.confirm"), t("common.cancel")], defaultId: 1, cancelId: 1, noLink: true,
      title: t("app.name"), message: tn("quit.stopAll.message", running), detail: t("quit.stopAll.detail")
    };
    const owner = managerWin && !managerWin.isDestroyed() && managerWin.isVisible() ? managerWin : null;
    if ((owner ? dialog.showMessageBoxSync(owner, options) : dialog.showMessageBoxSync(options)) !== 0) return;
  }
  // The layout stays as it is: the next start opens its panes anew (agents resume their sessions).
  await saveWorkspaceFinal();
  terminals.stopAll();
  app.quit();
}
// The layout is saved in userData/workspace.json (a second after a change, and on quit) with what runs in each pane,
// so the next start puts it back (restoreWorkspace). Not while it is being restored, nor once quitting began: the
// terminals stopped then would save an emptied layout over the real one.
const WORKSPACE_FILE = path.join(app.getPath("userData"), "workspace.json");
const WORKSPACE_SAVE_MS = 1000;
let workspaceSaveTimer = null, workspaceSaving = false;
function getSavedWorkspace() {
  const terms = Object.fromEntries([
    ...terminals.getTabs().filter(x => !x.owner).map(x => [x.id, { cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId }]),
    ...[...remoteTerms.values()].map(x => [x.id, { node: x.node, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId }])
  ]);
  return JSON.stringify({ version: 1, layout: { ...workspace.exportState(), pathKeyVersion: 2 }, terms });
}
function scheduleWorkspaceSave() {
  if (!workspaceSaving || workspaceSaveTimer) return;
  workspaceSaveTimer = setTimeout(() => {
    workspaceSaveTimer = null;
    if (workspaceSaving) atomicFile.write(WORKSPACE_FILE, getSavedWorkspace()).catch(e => console.error("Saving the layout failed:", e.message));
  }, WORKSPACE_SAVE_MS);
}
// The last save, on quit; nothing is saved after it.
async function saveWorkspaceFinal() {
  if (!workspaceSaving) return;
  workspaceSaving = false;
  clearTimeout(workspaceSaveTimer);
  await atomicFile.write(WORKSPACE_FILE, getSavedWorkspace()).catch(e => console.error("Saving the layout failed:", e.message));
}
function readSavedWorkspace() {
  try {
    const saved = JSON.parse(fs.readFileSync(WORKSPACE_FILE, "utf8"));
    return saved?.version === 1 && isObj(saved.layout) && isObj(saved.terms) ? saved : null;
  } catch {
    return null;
  }
}
// A saved pane whose terminal is gone opens anew: an agent resumes its session (when it still can), anything else
// becomes a shell in its folder. No other command runs again. "" when its folder is gone too: the pane goes.
async function reopenTerminal(meta, env) {
  if (!isObj(meta) || !isDir(meta.cwd)) return "";
  // The command centre comes back with its own command (and its session resumed).
  if (orchestrator.isOwn(meta.cwd)) {
    return orchestrator.open(false).catch(e => { launchLog(`the command centre failed (${e.message})`); return ""; });
  }
  if (meta.agent && meta.sessionId) {
    try {
      const { command, argv, meta: what } = launch.resumeCommand(meta.agent, meta.sessionId, meta.cwd);
      const title = typeof meta.title === "string" && meta.title ? meta.title : what.title;
      return await launch.openTerminal(meta.cwd, command, { ...what, title }, env, "resume", argv);
    } catch (e) {
      launchLog(`resuming failed (${e.message}), a shell instead`, `cwd="${meta.cwd}"`);
    }
  }
  return launch.openTerminal(meta.cwd, null, {}, env, "reopen").catch(e => {
    launchLog(`reopening failed (${e.message})`, `cwd="${meta.cwd}"`);
    return "";
  });
}
// The saved layout, each pane with its terminal: the one still running when there is one (attached again), else one
// opened anew (after a reboot, or a stop). Shown space, tabs and focus as they were. All spaces at once: a space shown
// later finds its panes ready, and the edge menu counts them. A running terminal the layout does not know (saved
// before it opened) gets a tab of its own.
async function restoreWorkspace() {
  const saved = readSavedWorkspace();
  let restored = !saved; // with no layout to put back, there is nothing a save could spoil
  try {
    const { attached, kept } = await terminals.restore();
    const running = new Set(attached), held = new Set(kept);
    const panes = saved ? new Set(Object.values(saved.layout.tabs || {}).flatMap(tab => getPanes(tab?.root))) : new Set();
    // A pane of a terminal on another computer keeps its place: once that computer is connected again, the terminal
    // is found there (or the pane goes).
    for (const [old, meta] of Object.entries(saved?.terms || {})) {
      if (isObj(meta) && typeof meta.node === "string" && meta.node && panes.has(old) && frames.UUID.test(old)) {
        remoteTerms.set(old, { id: old, node: meta.node, cwd: String(meta.cwd || ""), title: String(meta.title || ""), agent: String(meta.agent || ""), sessionId: String(meta.sessionId || ""), exited: false, pending: true });
        running.add(old);
      }
    }
    const ids = new Map([...panes].filter(old => running.has(old)).map(old => [old, old]));
    // A pane whose terminal still runs but could not be attached goes: opened anew, its agent would run a second time
    // on the same session. The terminal gets a tab of its own once a start attaches it.
    const gone = [...panes].filter(old => !running.has(old) && !held.has(old));
    if (gone.length) {
      const proxy = await network.terminalProxy().catch(() => null);
      const env = terminalEnv(process.env, proxy);
      for (const old of gone) {
        ids.set(old, await reopenTerminal(saved.terms[old], env));
      }
    }
    if (saved) workspace.importState(require("./shared/path-keys").migrateLayout(saved.layout, readRegistry().projects, keyOf), old => ids.get(old) || "");
    restored = true;
    const unplaced = terminals.getTabs().filter(x => !x.owner && !workspace.findTab(x.id));
    unplaced.forEach(x => workspace.addTab(getSpaceFor(x.cwd), x.id));
    if (unplaced.length && saved?.layout.activeSpace) workspace.activateSpace(saved.layout.activeSpace);
    prunePanes();
  } catch (e) {
    console.error("Restoring the layout failed:", e);
  } finally {
    // The saved layout never got in: it stays as it is for the next start, and nothing is saved over it this time.
    if (restored) {
      workspaceSaving = true;
      scheduleWorkspaceSave();
    } else {
      console.error("The layout is not saved this time: the saved one is kept for the next start.");
    }
  }
}
let restoring = Promise.resolve();
// The edge menu hears it too: it marks the sessions open in AgentDeck and counts a project's tabs.
function sendWorkspace() {
  const view = getWorkspaceView();
  sendToManager("workspace:changed", view);
  if (bar?.win && !bar.win.isDestroyed()) bar.win.webContents.send("workspace:changed", view);
}
function getSessionContext(key) {
  return usage.get()?.sessions.find(s => s.key === key)?.context || null;
}
const autopilot = require("./autopilot").createAutopilot({
  terminals, liveSessions: (...a) => liveSessions(...a), getContext: getSessionContext, getPrefs: () => prefs.get(), t: (...a) => t(...a)
});
let notifier = null;
const autostart = require("./autostart");
const { t, tn, LANGUAGES } = require("./i18n");
const { keyLabel, isObj } = require("./shared/util");

const { norm, findOnPath } = sessions;
const readRegistry = () => sessions.registry.read();
const saveRegistry = data => {
  served.layout.capture(readRegistry(), data);
  return sessions.registry.save(data);
};
// The command centre (orchestrator.js): a Claude Code session of AgentDeck's own, in a space of its own, that does
// what the user says or types with the tools AgentDeck serves it.
const orchestrator = createOrchestrator({
  userData: app.getPath("userData"), version: app.getVersion(), terminals, workspace,
  liveSessions: (...a) => liveSessions(...a), findTranscript: id => findTranscript(id),
  data: () => sessions.data(),
  preview: (s, o) => host.preview(s, o),
  norm,
  openTerminal: async (cwd, args, meta) => {
    const proxy = await network.terminalProxy().catch(() => null);
    return launch.openTerminal(cwd, "& " + args.map(promptLaunch.psQuote).join(" "), meta, terminalEnv(process.env, proxy), "centre", args);
  },
  launchNew: (agent, cwd, prompt) => launchNewWithPrompt(agent, cwd, prompt),
  focusSession: opts => focusSessionAnywhere(opts),
  showSpace: key => { workspace.activateSpace(key); showManager(); },
  showTab: id => showTab(id),
  balloon: (content, { onClick }) => balloon(content, { title: t("centre.title"), onClick }),
  managerInFront: () => Boolean(managerWin && !managerWin.isDestroyed() && managerWin.isVisible() && !managerWin.isMinimized() && managerWin.isFocused()),
  t: (...a) => t(...a)
});

// userData/logs/launch.log: every terminal AgentDeck opens and how it went (folder and command, never a prompt's text).
const writeLaunchLog = createLog("launch.log");
const launchLog = (...parts) => writeLaunchLog([new Date().toISOString(), ...parts].join(" "));
const { isAgent, SESSION_ID } = launch;

// ---------- the mesh (mesh/links.js): the other computers ----------
// What a peer may ask of this computer - for now only to look: the projects and sessions, the live status, the git
// status. What changes here is pushed to every connected peer.
const writeMeshLog = createLog("mesh.log");
const meshLog = line => writeMeshLog(`${new Date().toISOString()} ${line}`);
// The terminals of other computers that have a pane here: what they are, by the terminal's id (a UUID both sides
// use). Their output arrives as frames and goes to the window like a local terminal's; input and sizes go back the
// same way. One whose computer is away keeps its pane (note "offline"); one gone there loses its pane.
const remoteTerms = new Map(); // id -> { id, node, cwd, title, agent, sessionId, exited, pending }
const nodeName = id => links.nodes().find(n => n.id === id)?.name || id.slice(0, 8);
function remoteTabs() {
  return [...remoteTerms.values()].map(x => ({
    id: x.id, node: x.node, cwd: x.cwd, title: `${x.title} · ${nodeName(x.node)}`, agent: x.agent, sessionId: x.sessionId, exited: x.exited, lost: false,
    createdAt: x.createdAt || 0, note: links.online(x.node) ? "" : t("manager.node.offline")
  }));
}
function remoteTermsChanged() {
  prunePanes();
  sendWorkspace();
  scheduleWorkspaceSave();
}
// The peer's list of our terminals there: titles and states follow, and a terminal gone there takes its pane.
function reconcileRemote(node, tabs) {
  const there = new Map(tabs.map(x => [x.id, x]));
  for (const [id, x] of remoteTerms) {
    if (x.node !== node) continue;
    const tab = there.get(id);
    if (!tab) remoteTerms.delete(id);
    else Object.assign(x, { cwd: tab.cwd, title: tab.title, agent: tab.agent, sessionId: tab.sessionId, exited: tab.exited, createdAt: tab.createdAt, pending: false });
  }
  remoteTermsChanged();
}
// Attaching to a terminal: local, or on its computer (which then sends its output here) - null while that computer
// is away.
async function attachTerm(id) {
  const x = remoteTerms.get(id);
  if (!x) return terminals.attach(id);
  if (!links.online(x.node)) return null;
  return links.call(x.node, "terminals.attach", { id });
}
function closeTerm(id) {
  const x = remoteTerms.get(id);
  if (!x) return terminals.close(id);
  remoteTerms.delete(id);
  if (links.online(x.node)) links.call(x.node, "terminals.close", { id }).catch(e => meshLog(`closing ${id.slice(0, 8)} on ${nodeName(x.node)} failed: ${e.message}`));
  remoteTermsChanged();
  return true;
}
// The project's repository cloned on another computer, in a pane here (mesh/serve.js repo.clone): {url, dir, branch,
// base, agent, prompt}. The pane goes to the space of the new folder there.
async function remoteClone(node, args) {
  if (!links.online(node)) throw new HostError("offline");
  const tab = await links.call(node, "repo.clone", args, { timeout: 60000 });
  if (!isObj(tab) || !frames.UUID.test(tab.id)) throw new HostError("invalidData");
  remoteTerms.set(tab.id, { id: tab.id, node, cwd: tab.cwd, title: tab.title, agent: tab.agent, sessionId: tab.sessionId, exited: false, createdAt: tab.createdAt });
  await restoring;
  workspace.addTab(`node:${node}:${normPath(tab.dir || tab.cwd)}`, tab.id);
  showManager();
  return tab.id;
}
// A local project's origin and current branch, for the clone dialog.
function gitInfo(dir) {
  const git = (...a) => new Promise(resolve => execFile("git", ["-C", dir, ...a], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? "" : String(out).trim())));
  return Promise.all([git("remote", "get-url", "origin"), git("rev-parse", "--abbrev-ref", "HEAD")]).then(([url, branch]) => ({ url, branch }));
}
// A terminal on another computer, in a new tab of that project's space here: {cwd, kind, agent, sessionId, prompt}.
async function remoteLaunch(node, args) {
  if (!links.online(node)) throw new HostError("offline");
  const tab = await links.call(node, "terminals.open", args);
  if (!isObj(tab) || !frames.UUID.test(tab.id)) throw new HostError("invalidData");
  remoteTerms.set(tab.id, { id: tab.id, node, cwd: tab.cwd, title: tab.title, agent: tab.agent, sessionId: tab.sessionId, exited: false, createdAt: tab.createdAt });
  await restoring;
  workspace.addTab(`node:${node}:${normPath(args.cwd)}`, tab.id);
  showManager();
  return tab.id;
}
// What the peers may ask of this computer, and what it pushes to them (mesh/serve.js).
const served = createServed({ host, env: async () => terminalEnv(process.env, await network.terminalProxy().catch(() => null)) });
const links = createLinks({ dir: path.join(app.getPath("userData"), "node"), defaultName: os.hostname(), kind: "desktop", version: app.getVersion(), api: served.api, log: meshLog });
served.attach(links);
// What the other computers show - their last list, live status and git - kept per node and pushed to the manager
// window with the nodes themselves ("mesh:nodes").
const remote = new Map(); // node id -> { data, live, git }
const nodesView = () => links.nodes().filter(n => !served.layout.isRemoved(n.id)).map(n => ({ ...n, ...(remote.get(n.id) || {}) }));
let nodesTimer = null;
function nodesChanged() {
  if (nodesTimer) return;
  nodesTimer = setTimeout(() => { nodesTimer = null; syncRemoteProjects(); sendToManager("mesh:nodes", nodesView()); }, 150);
}
// The paired computers' projects are kept in this computer's registry too (node + the folder there), so they are
// pinned, ordered and grouped like its own: added as they appear there, dropped as they go (or the computer is
// forgotten); one removed here stays out. The name stays as first seen (it can be renamed here).
function syncRemoteProjects() {
  try {
    const data = readRegistry();
    const before = JSON.stringify(data);
    require("./mesh/projects").mergeProjects(data, links.nodes(), remote);
    served.layout.apply(data);
    if (JSON.stringify(data) !== before) sessions.registry.save(data);
  } catch (e) {
    meshLog(`Project sync failed: ${e.message}`);
  }
}

links.on("nodes", nodesChanged);
links.on("layout", nodesChanged);
links.on("event", ({ node, name, data }) => {
  if (name === "terminals") return reconcileRemote(node, Array.isArray(data) ? data.filter(x => isObj(x) && frames.UUID.test(x.id)) : []);
  if (!["data", "live", "git", "usage", "limits", "resources"].includes(name)) return;
  remote.set(node, { ...remote.get(node), [name]: data, ...(name === 'git' ? { gitError: '' } : {}) });
  nodesChanged();
});
// Output of this computer's terminals on other computers, to the window (keystrokes for a peer's terminals here are
// mesh/serve.js's).
links.on("binary", ({ node, data }) => {
  const f = frames.decode(data);
  if (f?.type === "output" && remoteTerms.get(f.id)?.node === node) sendToManager("terminal:data", { id: f.id, data: f.data, end: f.end });
});
// A link that just came up: everything the peer has, at once; one that went: its last picture stays, marked offline.
links.on("link", async ({ node, up }) => {
  if (!up) {
    remoteTermsChanged(); // the panes of its terminals say "offline"
    return nodesChanged();
  }
  // A relay-only peer serves no api: don't fetch sessions/git/terminals from it (they would only be refused). It still
  // relays, and its events arrive as usual; it simply has nothing of its own to show.
  if (links.nodes().find(n => n.id === node)?.relayOnly) return nodesChanged();
  try {
    const [data, live, git, tabs, info, usage, limits, resources] = await Promise.all([links.call(node, "sessions.list"), links.call(node, "live.list"), links.call(node, "git.status"), links.call(node, "terminals.list"), links.call(node, "host.info").catch(() => null), links.call(node, "usage.get").catch(() => null), links.call(node, "limits.get").catch(() => null), links.call(node, "resources.get").catch(() => null)]);
    remote.set(node, { ...remote.get(node), data, live, git, info, usage, limits, resources });
    nodesChanged();
    reconcileRemote(node, Array.isArray(tabs) ? tabs.filter(x => isObj(x) && frames.UUID.test(x.id)) : []);
    // The output missed while it was away: attaching again brings the scrollback, of which the window writes only
    // what it does not have (workspace-ui.js writeAfter).
    for (const x of remoteTerms.values()) {
      if (x.node !== node) continue;
      const a = await links.call(node, "terminals.attach", { id: x.id }).catch(() => null);
      if (a?.scrollback) sendToManager("terminal:data", { id: x.id, data: a.scrollback, end: a.end });
    }
  } catch (e) {
    meshLog(`reading ${node.slice(0, 8)} failed: ${e.message}`);
  }
});
// Settings -> Computers (voice/windows.js serves the page): the picture, the settings of this node, pairing and
// forgetting. Errors come as texts in the user's language, not as exceptions.
const ADDRESS = /^\s*(\[[0-9a-f:.]+\]|[^:\s[\]]+)(?::(\d{1,5}))?\s*$/i;
const meshSettings = {
  state: () => ({ self: links.self(), nodes: links.nodes(), discovered: links.discovered() }),
  set: patch => { links.setSelf(patch); return meshSettings.state(); },
  newCode: () => { links.regenerateCode(); return meshSettings.state(); },
  pair: async (address, code) => {
    const m = ADDRESS.exec(address);
    if (!m) return { ok: false, error: t("errors.badAddress") };
    try {
      const r = await links.pair(m[1].replace(/^\[|\]$/g, ""), Number(m[2]) || DEFAULT_PORT, code);
      served.layout.restoreNode(r.id);
      return { ok: true, node: r };
    } catch (e) {
      return { ok: false, error: translated(e).message };
    }
  },
  forget: id => { served.layout.removeNode(id); links.forget(id); return meshSettings.state(); },
  // The readiness of a node (git, SSH key, known hosts, git identity, agents) and the fixes: generateKey,
  // addKnownHost {host}, setGitIdentity {name, email}.
  setup: id => links.call(id, "setup.status"),
  setupAction: async (id, action, args) => {
    const method = { generateKey: "setup.sshKey.generate", addKnownHost: "setup.knownHosts.add", setGitIdentity: "setup.gitIdentity.set" }[action];
    if (!method) throw new HostError("invalidData");
    try {
      return { ok: true, result: await links.call(id, method, isObj(args) ? args : {}) };
    } catch (e) {
      return { ok: false, error: translated(e).message };
    }
  },
  on: cb => { for (const ev of ["nodes", "self", "discovered"]) links.on(ev, () => cb(meshSettings.state())); }
};
function spawnDetached(file, args, opts) {
  const child = spawn(file, args, { detached: true, stdio: "ignore", ...opts });
  child.unref();
  return new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}
// The space a folder belongs to: the listed project that holds it (the deepest one), else the folder itself, which
// joins the list as a project of its own (as the scan adds the folders sessions ran in) unless the user removed it.
function getSpaceFor(cwd) {
  if (orchestrator.isOwn(cwd)) return orchestrator.SPACE;
  const n = norm(cwd);
  const registry = readRegistry();
  const owner = registry.projects
    .filter(p => !p.node && (n === norm(p.path) || n.startsWith(norm(p.path).replace(/\/$/, "") + "/")))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (owner) return norm(owner.path);
  if (!registry.removed.includes(n)) {
    registry.projects.push({ name: path.basename(cwd) || cwd, path: path.resolve(cwd) });
    saveRegistry(registry);
  }
  return n;
}
// The places a terminal can open: a tab of its own in its space, or beside the shown tab's focused pane.
const PLACES = ["tab", "right", "down"];
// A terminal of AgentDeck's own: the command reaches PowerShell encoded, so no quoting of it can break the command
// line. It opens in a new tab of its project's space, or split off the focused pane (place "right" / "down").
async function openTab(cwd, command, meta, env, place = "tab", argv = null) {
  // A layout still being restored would replace a tab opened meanwhile.
  await restoring;
  const id = await launch.openTerminal(cwd, command, meta, env, place, argv);
  const shown = workspace.getActiveTab();
  if (place !== "tab" && shown) workspace.split(shown.id, id, place);
  else workspace.addTab(getSpaceFor(cwd), id);
  showManager();
}
function showTab(id) {
  workspace.focus(id);
  showManager();
}
// "Show terminal", a notification's click, a voice command: a session in one of AgentDeck's tabs comes up there, any
// other in its own terminal (terminal-focus.js; same answer).
function focusSessionAnywhere(opts) {
  const tab = terminals.getTabs().find(x => x.agent === opts.agent && x.sessionId === opts.id && !x.exited);
  if (!tab) return focusSession(opts);
  showTab(tab.id);
  return Promise.resolve({ ok: true, how: "tab", reason: "", ms: 0 });
}
// meta: {title, agent, sessionId} of what runs, for the tab; inTab: an AgentDeck terminal whatever the setting ("Move
// here", a split); place: where in the window (PLACES).
// argv: the same program as `command`, for a pseudo terminal (Linux: launch.openTerminal).
async function launchTerminal(cwd, command = null, meta = {}, inTab = false, place = "tab", argv = null) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(t("errors.folderMissing"));
  if (!PLACES.includes(place)) place = "tab";
  // Windows Terminal is Windows only: elsewhere every session opens in AgentDeck's own terminals.
  if (inTab || place !== "tab" || prefs.get().sessionsIn === "tabs" || process.platform !== "win32") {
    const proxy = await network.terminalProxy().catch(() => null);
    return openTab(cwd, command, meta, terminalEnv(process.env, proxy), place, argv);
  }
  // Pass fixed argument arrays to wt.exe. No user-supplied shell command is evaluated. "-w new" gives the session a
  // window of its own (Settings -> General); "-w 0" adds a tab to the last used window.
  const newWindow = prefs.get().newWindow;
  const args = ["-w", newWindow ? "new" : "0", "new-tab", "-d", cwd];
  // A resumed session's tab keeps its title: PowerShell would name it after the command ("claude"). wt.exe splits
  // its command line at ";".
  if (meta.sessionId) {
    args.push("--title", meta.title.replace(/;/g, ","), "--suppressApplicationTitle");
  }
  if (command) {
    args.push("powershell.exe", "-NoExit", "-Command", command);
  }
  // AgentDeck's proxy too, when the user asked for it in Settings -> Network; a terminal opens without it otherwise.
  const proxy = await network.terminalProxy().catch(e => { console.error("Could not resolve the proxy for the terminal:", e.message); return null; });
  const env = terminalEnv(process.env, proxy);
  const what = `cwd="${cwd}" cmd=${command ? `"${command.slice(0, 120)}"` : "-"}`;
  const before = newWindow ? terminalWindows() : null;
  allowForeground();
  try {
    // Never windowsHide: Windows Terminal applies the launcher's "start hidden" to the window it opens for "-w new",
    // which then stayed invisible ("nothing happens"). wt.exe has no console of its own to flash.
    await spawnDetached("wt.exe", args, { windowsHide: false, env });
  } catch (err) {
    launchLog(`wt failed (${err.code || err.message})`, what);
    if (err.code !== "ENOENT") throw err;
    // No Windows Terminal (older Windows 10): a console window of its own instead of nothing at all.
    await spawnDetached("powershell.exe", ["-NoExit", ...(command ? ["-Command", command] : [])], { cwd, env, windowsHide: false });
    launchLog("console", what);
    return;
  }
  launchLog(`wt ${newWindow ? "window" : "tab"}`, what);
  if (before) {
    raiseNewTerminal(before)
      .then(r => launchLog(`new window ${r.found ? (r.front ? "in front" : "found, not in front") : "not seen within 4 s"}`))
      .catch(e => launchLog(`raising the new window failed: ${e.message}`));
  }
}
async function launchAgent(agent, id, cwd, inTab = false, place = "tab") {
  const { command, argv, meta } = launch.resumeCommand(agent, id, cwd);
  await launchTerminal(cwd, command, meta, inTab, place, argv);
  // Only Claude reports when it is ready (live.js), which ends the windows' "Loading".
  if (agent === "Claude") {
    broadcast("launch:started", `${agent}:${id}`);
  }
}
// Continue fresh: a new Claude session with the earlier one's handoff (launch.handoffCommand).
async function launchFresh(cwd, handoff, place = "tab") {
  const { command, argv, meta, undo } = launch.handoffCommand(cwd, handoff);
  try {
    await launchTerminal(cwd, command, meta, false, place, argv);
  } catch (e) {
    undo();
    throw e;
  }
}
function launchNew(agent, cwd, place = "tab") {
  const { command, argv, meta } = launch.newCommand(agent, cwd);
  return launchTerminal(cwd, command, meta, false, place, argv);
}
// "Move here": a session running in another terminal is stopped there (launch.takeOverSession) and resumed in an
// AgentDeck tab.
async function moveToTab(agent, id) {
  const entry = await launch.takeOverSession(agent, id);
  await launchAgent(agent, id, entry.cwd, true);
}
// A new session that starts on a prompt (voice commands, the command centre): the prompt travels in a file the
// terminal reads and deletes (launch.promptCommand); one whose terminal never started goes at once.
async function launchNewWithPrompt(agent, cwd, prompt) {
  const { command, argv, meta, undo } = launch.promptCommand(agent, cwd, prompt);
  try {
    await launchTerminal(cwd, command, meta, false, "tab", argv);
  } catch (e) {
    undo();
    throw e;
  }
}
// A Claude session's tab renamed also names the session, as Claude's own /rename does: a custom-title line in its
// transcript, so the agents menu, the session cards and claude --resume show the name, after a restart too.
// A cleared name only gives the tab back its automatic title (the session's, so the last name given stays).
function renameTab(tabId, name) {
  const before = workspace.snapshot().tabs[tabId]?.name;
  if (!workspace.renameTab(tabId, name)) return false;
  const tab = workspace.snapshot().tabs[tabId];
  if (tab.name && tab.name !== before) nameClaudeSession(tab);
  return true;
}
// Only a tab of one pane: in a split tab the name belongs to no single session.
function nameClaudeSession(tab) {
  const term = terminals.getTabs().find(x => x.id === tab.root?.term && x.agent === "Claude" && x.sessionId);
  const file = term && findTranscript(term.sessionId);
  if (!file) return;
  const line = JSON.stringify({ type: "custom-title", customTitle: tab.name, sessionId: term.sessionId });
  fs.promises.appendFile(file, `${line}\n`).catch(() => {});
}
// What the window asks of the layout (workspace-ui.js). A terminal closed here ends; its pane goes once it has.
async function runWorkspaceCommand(cmd, a) {
  const id = v => text(v ?? "", 64);
  switch (cmd) {
    case "focus": return workspace.focus(id(a.term));
    case "focus-dir": return workspace.focusDirection(text(a.direction, 8));
    // The root split's path is "" (which text() refuses).
    case "ratio": return workspace.setRatio(id(a.tab), a.path === "" ? "" : text(a.path, 32), Number(a.ratio));
    case "zoom": return workspace.toggleZoom(id(a.tab));
    case "space":
      workspace.activateSpace(text(a.space ?? "", 2000));
      if (a.sessions === true) workspace.showSessions();
      return true;
    // The edge menu: the window comes up showing that project.
    case "show-space": workspace.activateSpace(text(a.space ?? "", 2000)); showManager(); return true;
    case "tab": return workspace.activateTab(id(a.tab));
    case "sessions": return workspace.showSessions();
    // "" takes the tab back to its automatic title.
    case "rename-tab": return renameTab(id(a.tab), a.name === "" ? "" : text(a.name, 200));
    case "reorder-tabs":
      if (!Array.isArray(a.ids) || a.ids.length > 1000) throw new Error(t("errors.invalidData"));
      return workspace.reorderTabs(text(a.space ?? "", 2000), a.ids.map(id));
    // Dragging: a tab's panes beside a pane of another tab; a pane beside another one; a pane into a tab of its own.
    case "merge-tab": return workspace.mergeTab(id(a.tab), id(a.into), id(a.at), text(a.side, 8));
    case "move-pane": return workspace.movePane(id(a.term), id(a.into), id(a.at), text(a.side, 8));
    case "detach-pane": return workspace.detachPane(id(a.term));
    case "close-pane": return closeTerm(id(a.term));
    case "close-tab": workspace.getTabTerms(id(a.tab)).forEach(closeTerm); return true;
    // A shell beside the focused pane, in its folder (or the shown space's).
    case "split": {
      const dir = a.dir === "down" ? "down" : "right";
      const shown = workspace.getActiveTab();
      const cwd = terminals.getTabs().find(x => x.id === shown?.focus)?.cwd;
      if (!cwd) return false;
      await launchTerminal(cwd, null, {}, true, dir);
      return true;
    }
    default: throw new Error(t("errors.invalidData"));
  }
}
// ---------- windows ----------
const PRELOAD = path.join(__dirname, "preload.js");
// The first combination no other app has claimed wins (Ctrl+Alt+Space is often taken, e.g. by Claude Desktop).
// Nothing with Alt+Shift: that pair switches the keyboard layout on Windows.
const HOTKEYS = ["Alt+`", "Control+Alt+Space", "Control+Alt+Shift+Space"];
let hotkey = "";
const hotkeyLabel = () => keyLabel(hotkey, " + ");
let managerWin = null, bar = null, tray = null, trayHintShown = false, voice = null, voiceStarting = null;
// Quitting waits this long at most for voice to put an attempt in flight back to Pending and release its hotkeys.
const QUIT_GRACE_MS = 3000;
function showManager() {
  if (managerWin && !managerWin.isDestroyed()) {
    if (managerWin.isMinimized()) managerWin.restore();
    managerWin.show(); managerWin.focus();
    return;
  }
  managerWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, minHeight: 600,
    title: t("app.name"),
    backgroundColor: prefs.background(),
    autoHideMenuBar: true,
    icon: makeIcon(64),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  managerWin.webContents.on("did-finish-load", () => managerWin?.webContents.setZoomFactor(prefs.get().uiScale));
  managerWin.loadFile(path.join(__dirname, "index.html"));
  managerWin.on("closed", () => {
    managerWin = null;
    // The app keeps running for the edge menu; say so the first time the window goes away.
    if (!trayHintShown && tray) {
      trayHintShown = true;
      const handle = prefs.get().edgeHandle;
      const body = hotkey ? (handle ? "bodyHotkeyHandle" : "bodyHotkey") : (handle ? "bodyHandle" : "body");
      balloon(t(`tray.background.${body}`, { hotkey: hotkeyLabel() }), { title: t("tray.background.title") });
    }
  });
}
// ---------- tray ----------
// Clicking a balloon acts on it: one about a failed recording retries it, one about an update downloads or installs
// it. Balloons can be swallowed by Focus Assist, so the tray menu offers the same.
let balloonClick = null, badged = null;
function balloon(content, { title = t("app.name"), iconType = "info", jobId = null, onClick = null } = {}) {
  if (!tray || tray.isDestroyed()) return;
  balloonClick = jobId ? () => voice?.retry(jobId) : onClick;
  const text = String(content);
  tray.displayBalloon({ title, iconType, content: text.length > 240 ? text.slice(0, 239) + "…" : text }); // Windows cuts it silently
}
function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const v = voice ? voice.trayMenu() : { failures: [], items: [], failureCount: 0 };
  const failed = v.failureCount, waits = notifier ? notifier.list() : [];
  if (badged !== (failed > 0 || waits.length > 0)) { badged = failed > 0 || waits.length > 0; tray.setImage(makeIcon(32, 2, { badge: badged })); }
  const cut = s => (s.length > 60 ? s.slice(0, 59) + "…" : s).replace(/&/g, "&&");
  const waitItems = waits.length ? [
    { label: tn("notify.waiting", waits.length), enabled: false },
    ...waits.slice(0, 8).map(w => ({ label: cut(`${w.title} · ${w.project}`), click: () => notifier.bringUp(w.key) })),
    { label: t("notify.clear"), click: () => notifier.clear() }
  ] : [];
  trayCount = terminals.countRunning();
  const running = trayCount ? ` · ${tn("tray.terminals", trayCount)}` : "";
  tray.setToolTip(`${t("app.name")}${hotkey ? ` — ${hotkeyLabel()}` : ""}${running}${failed ? ` · ${tn("tray.failed", failed)}` : ""}${waits.length ? ` · ${tn("notify.waiting", waits.length)}` : ""}`);
  const sep = list => (list.length ? [...list, { type: "separator" }] : []);
  const p = prefs.get();
  const radio = (key, values, label) => values.map(value => ({
    label: label(value), type: "radio", checked: p[key] === value, click: () => prefs.set({ [key]: value })
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    ...sep(waitItems),
    ...sep(v.failures),
    { label: t("tray.openMenu"), accelerator: hotkey || undefined, click: () => bar.show("hotkey") },
    { label: t("common.openManager"), click: showManager },
    { type: "separator" },
    ...sep(v.items),
    { label: t("tray.edgeHandle"), type: "checkbox", checked: p.edgeHandle, click: item => prefs.set({ edgeHandle: item.checked }) },
    { label: t("notify.toggle"), type: "checkbox", checked: prefs.get().notify !== false, click: item => prefs.set({ notify: item.checked }) },
    { label: t("tray.language"), submenu: radio("language", Object.keys(LANGUAGES), l => LANGUAGES[l]) },
    { label: t("tray.theme"), submenu: radio("theme", prefs.THEMES, th => t(`theme.${th}`)) },
    { label: t("tray.sessionsIn"), submenu: radio("sessionsIn", prefs.SESSIONS_IN, m => t(`tray.sessionsIn.${m}`)) },
    { label: t("tray.settings"), enabled: Boolean(voice), click: () => voice?.openSettings() },
    updateMenuItem(),
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
    { label: t("tray.stopAllQuit"), enabled: trayCount > 0, click: () => stopAllAndQuit().catch(e => console.error("Stopping the terminals failed:", e)) }
  ]));
}
// The tooltip counts the terminals that run (they outlive AgentDeck), and "Stop all terminals and quit" follows.
let trayCount = 0;
function updateTrayCount() {
  if (terminals.countRunning() !== trayCount) buildTrayMenu();
}

// ---------- updates ----------
// One tray item that follows the updater: check, download (automatic updates off), progress, restart to install.
function updateMenuItem() {
  const u = updater.state();
  const version = u.next;
  switch (u.status) {
    case "checking": return { label: t("tray.update.checking"), enabled: false };
    case "available": return { label: t("tray.update.download", { version }), click: () => updater.download() };
    case "downloading": return { label: t("tray.update.downloading", { version }), enabled: false };
    case "ready": return { label: t("tray.update.restart", { version }), click: () => updater.install() };
    default: return { label: t("tray.update.check"), enabled: u.supported, click: checkFromTray };
  }
}
// A version is announced once when it is found (automatic updates off) and once when it is ready to install;
// clicking the balloon downloads or installs it.
const announced = new Set();
function announce(u) {
  announced.add(`${u.status} ${u.next}`);
  if (u.status === "ready")
    balloon(t("tray.update.readyBody", { version: u.next }), { title: t("tray.update.readyTitle"), onClick: () => updater.install() });
  else balloon(t("tray.update.availableBody", { version: u.next }), { title: t("tray.update.foundTitle"), onClick: () => updater.download() });
}
let trayCheck = false;
function onUpdateChanged(u, prev) {
  if (u.status !== prev.status || u.next !== prev.next) buildTrayMenu();
  if ((u.status === "ready" || (u.status === "available" && !trayCheck)) && !announced.has(`${u.status} ${u.next}`)) announce(u);
}
// Asked for from the tray, so the answer comes as a balloon there, whatever it is.
async function checkFromTray() {
  trayCheck = true;
  const u = await updater.check().finally(() => { trayCheck = false; });
  if (u.status === "available") announce(u);
  else if (u.status === "downloading") balloon(t("tray.update.downloadingBody", { version: u.next }), { title: t("tray.update.foundTitle") });
  else if (u.status === "none") balloon(t("tray.update.latest", { version: u.version }));
  else if (u.status === "error")
    balloon(t(`settings.updates.error.${u.error.reason}`, { message: u.error.message }), { title: t("tray.update.failedTitle"), iconType: "warning" });
}

// ---------- IPC ----------
// Only the manager window and the edge menu may call these (not the voice windows, nor any other), and every
// argument is checked: they reach a shell, a terminal and the file system.
const trusted = e => [managerWin, bar?.win].some(w => w && !w.isDestroyed() && e.sender === w.webContents);
// A file for a terminal (host/paste.js): saved here for a terminal of this computer, or sent to the computer whose
// terminal it is (mesh/serve.js files.put) - either way the path answered is one the program there can read.
async function putFile(termId, name, bytes) {
  const x = remoteTerms.get(termId);
  if (!x) return savePaste(name, bytes);
  if (!links.online(x.node)) throw new HostError("offline");
  return links.call(x.node, "files.put", { name, data: bytes.toString("base64") }, { timeout: 120000 });
}
// A picture copied to the clipboard, pasted into a terminal: saved as a PNG and its path typed in, which Claude Code
// and Codex attach as an image (a program in a pseudo console cannot read the clipboard picture the window holds the
// paste for). Only when the clipboard has no text, so a normal paste stays a normal paste.
async function saveClipboardImage(termId) {
  if (await clipboard.readText()) return "";
  const item = (await clipboard.read()).find(i => i.types.includes("image/png"));
  if (!item) return "";
  const png = Buffer.from(await (await item.getType("image/png")).arrayBuffer());
  return putFile(termId, `paste-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, png);
}

// An error from the host carries a code (host/errors.js); the window gets its text in the user's language.
function translated(e) {
  const key = e?.code ? `errors.${e.code}` : "";
  return key && t(key) !== key ? new Error(t(key)) : e;
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!trusted(e)) throw new Error(t("errors.accessDenied"));
    try { return await fn(...args); } catch (err) { throw translated(err); }
  });
}
function text(v, max = 4096) {
  if (typeof v !== "string" || !v || v.length > max) throw new Error(t("errors.invalidData"));
  return v;
}
const isDir = p => { try { return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };

function registerIpc() {
  handle("app:get-data", opts => (opts?.cached === true && sessions.get() ? sessions.get() : sessions.scan()));
  // A picker without defaultPath opens in Downloads (Electron 43+; the last folder is no longer remembered), so it
  // starts where the last project was picked, or else beside the most recently registered one.
  let pickedFrom = null;
  handle("project:add", async () => {
    const registry = readRegistry();
    const last = registry.lastAdded || registry.projects.at(-1)?.path;
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: pickedFrom ?? (last && path.dirname(last)) });
    if (result.canceled || !result.filePaths[0]) return readRegistry();
    const p = path.resolve(result.filePaths[0]);
    pickedFrom = path.dirname(p);
    const data = readRegistry();
    data.removed = data.removed.filter(x => x !== norm(p));
    if (!getProject(data, p)) data.projects.push({ name: path.basename(p) || p, path: p });
    data.lastAdded = p;
    return saveRegistry(data);
  });
  // remember: false when it only leaves with its last deleted session - a new session there brings it back.
  handle("project:remove", (p, remember) => {
    text(p);
    const data = readRegistry();
    const n = keyify(p);
    data.projects = data.projects.filter(x => keyOf(x) !== n);
    if (remember !== false && !data.removed.includes(n)) data.removed.push(n);
    unpinEmptyGroups(data);
    return saveRegistry(data);
  });
  handle("project:rename", (p, name) => {
    text(p);
    text(name, 1000);
    const data = readRegistry();
    const item = getProject(data, p);
    if (item && name.trim()) item.name = name.trim().slice(0, 80);
    return saveRegistry(data);
  });
  // The list in the user's own order (all projects, as shown); each pinned item is pinned where it now is. groupOf:
  // the group ids ("" for none) of the projects that changed groups.
  handle("project:arrange", (paths, groupOf) => {
    if (!Array.isArray(paths) || paths.length > 10000) throw new Error(t("errors.invalidData"));
    const at = new Map(paths.map((p, i) => [keyify(text(p)), i]));
    const data = readRegistry();
    setGroups(data, groupOf, text);
    const rank = x => at.get(keyOf(x)) ?? paths.length;
    data.projects.sort((a, b) => rank(a) - rank(b));
    repin(data);
    data.order = "custom";
    return saveRegistry(data);
  });
  // Into a group (id) or out of it (""), keeping the order and the order mode as they are.
  handle("project:set-group", (p, id) => {
    const data = readRegistry();
    setGroups(data, { [text(p)]: id === "" ? "" : text(id, 64) }, text);
    unpinEmptyGroups(data);
    return saveRegistry(data);
  });
  handle("project:restore-order", () => {
    const data = readRegistry();
    data.order = "custom";
    return saveRegistry(data);
  });
  handle("project:sort-by-activity", () => {
    const data = readRegistry();
    data.order = "activity";
    return saveRegistry(data);
  });
  handle("project:pin", (p, slot) => {
    const data = readRegistry();
    setPin(getProject(data, text(p)), slot);
    return saveRegistry(data);
  });
  // Empty, or holding the project `p` in its place.
  handle("group:create", p => {
    const data = readRegistry();
    const group = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: t("manager.projectGroup.newName") };
    data.groups.push(group);
    const item = p ? getProject(data, text(p)) : null;
    if (!item) return saveRegistry(data);
    if (isPinned(item)) group.pin = item.pin;
    delete item.pin;
    item.group = group.id;
    unpinEmptyGroups(data);
    return saveRegistry(data);
  });
  handle("group:rename", (id, name) => {
    text(id, 64);
    text(name, 1000);
    const data = readRegistry();
    const group = data.groups.find(g => g.id === id);
    if (group && name.trim()) group.name = name.trim().slice(0, 80);
    return saveRegistry(data);
  });
  handle("group:pin", (id, slot) => {
    text(id, 64);
    const data = readRegistry();
    setPin(data.groups.find(g => g.id === id), slot);
    return saveRegistry(data);
  });
  // Its projects stay where they are, outside any group.
  handle("group:delete", id => {
    text(id, 64);
    const data = readRegistry();
    data.groups = data.groups.filter(g => g.id !== id);
    for (const x of data.projects) {
      if (x.group === id) delete x.group;
    }
    return saveRegistry(data);
  });
  // place (optional): "tab", "right" or "down" - where in AgentDeck's window (PLACES).
  const placeOf = p => (PLACES.includes(p) ? p : "tab");
  handle("launch:folder", async (p, place) => { await launchTerminal(text(p), null, {}, false, placeOf(place)); return true; });
  handle("launch:agent", async (agent, id, cwd, place) => { await launchAgent(text(agent), text(id), text(cwd), false, placeOf(place)); return true; });
  handle("launch:new", async (agent, cwd, place) => { await launchNew(text(agent), text(cwd), placeOf(place)); return true; });
  handle("launch:fresh", async (cwd, handoff, place) => {
    await launchFresh(text(cwd), text(handoff, 20000), placeOf(place));
    return true;
  });
  // Folders only: shell.openPath() on a file runs it.
  handle("open:path", p => (isDir(p) ? shell.openPath(p) : t("errors.folderMissing")));
  handle("clipboard:write", async value => { await clipboard.writeText(text(value, 1_000_000)); return true; });
  handle("clipboard:read", () => clipboard.readText());
  handle("clipboard:image-file", id => saveClipboardImage(text(id, 64)));
  // A file dropped on a pane of a terminal on another computer: sent there, its path there answered.
  handle("terminal:upload", (id, name, bytes) => putFile(text(id, 64), text(name, 200), Buffer.from(bytes)));
  handle("live:get", () => liveSessions());
  // AgentDeck's own terminals and their layout. Keystrokes and sizes come as plain messages (many, no answer needed).
  handle("workspace:get", () => getWorkspaceView());
  // The terminals' text size and the window's scale, from the window's own keys (Ctrl+= / Ctrl+- / Ctrl+0).
  handle("prefs:set-view", patch => prefs.set({ terminalFontSize: patch?.terminalFontSize, uiScale: patch?.uiScale }));
  handle("workspace:command", (cmd, args) => runWorkspaceCommand(text(cmd, 32), isObj(args) ? args : {}));
  handle("terminal:attach", id => attachTerm(text(id, 64)));
  handle("terminal:move", async (agent, id) => {
    await moveToTab(text(agent), text(id));
    return true;
  });
  // "Stop": a session running without a terminal here, on this computer or on another one (launch.stopSession).
  handle("session:stop", (node, agent, id) => {
    if (!node) return launch.stopSession(text(agent), text(id));
    if (!links.online(text(node, 64))) throw new HostError("offline");
    return links.call(text(node, 64), "sessions.stop", { agent: text(agent), id: text(id) });
  });
  ipcMain.on("terminal:input", (e, id, data) => {
    if (!trusted(e) || typeof data !== "string" || data.length > 1_000_000) return;
    const node = remoteTerms.get(id)?.node;
    if (node) links.sendBinary(node, frames.encodeInput(id, data)); else terminals.input(id, data);
  });
  ipcMain.on("terminal:resize", (e, id, cols, rows) => {
    if (!trusted(e)) return;
    const node = remoteTerms.get(id)?.node;
    if (node) links.sendBinary(node, frames.encodeResize(id, Number(cols), Number(rows))); else terminals.resize(id, Number(cols), Number(rows));
  });
  // Tokens and API-equivalent cost (usage.js): the last result at once, or a fresh pass over the transcripts.
  handle("usage:get", () => usage.get());
  // The shortcuts as set now: the menu's hotkey and the voice ones (labels such as "Ctrl + Shift + Space").
  handle("app:shortcuts", () => {
    let v = {};
    try { v = require("./voice/settings").load() || {}; } catch {}
    const k = a => (a ? keyLabel(a, " + ") : "");
    return { menu: hotkeyLabel(), dictate: k(v.hotkeys?.dictate), readAloud: k(v.hotkeys?.readAloud), editSelection: k(v.hotkeys?.editSelection),
      ask: k(v.hotkeys?.ask), commandHold: Boolean(voice) && v.commands?.enabled !== false && v.commands?.trigger === "hold" };
  });
  // One day's work (day.js); the summary leaves out the sessions the menu hides (skip: "Agent:id" keys).
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const dayReport = async date => {
    if (!DAY.test(text(date, 10))) throw new Error(t("errors.invalidData"));
    return day.reportAsync({ date, sessions: (await sessions.data()).sessions, projects: readRegistry().projects });
  };
  handle("day:get", dayReport);
  handle("day:summary", async (date, skip) => {
    const rep = day.exclude(await dayReport(date), Array.isArray(skip) ? skip.filter(k => typeof k === "string") : []);
    const claude = day.findClaude();
    if (!claude) throw new Error(t("bar.day.noClaude"));
    return day.summarize(rep, { claude, language: require("./i18n").language() });
  });
  handle("search:text", q => fullText.query(text(q, 500)));
  handle("resources:get", () => resources.get() || resources.refresh());
  handle("limits:get", () => limits.refresh());
  handle("limits:refresh", () => limits.refresh(true));
  // The figures themselves come as "usage:changed" when they changed; the answer only says when they were checked.
  handle("usage:refresh", async () => { const u = await usage.refresh(); return u && { at: u.at, stats: u.stats, version: u.version }; });
  // A session's last messages and a few facts about it (session-preview.js). The transcript is the one the scan
  // found; one started since is looked up by its id.
  handle("session:preview", (agent, id) => {
    if (!SESSION_ID.test(text(id)) || !isAgent(agent)) throw new Error(t("errors.invalidSession"));
    const s = sessions.get()?.sessions.find(x => x.agent === agent && x.id === id)
      ?? { agent, id, file: agent === "Claude" ? findTranscript(id) : "" };
    return host.preview(s);
  });
  // Deletes a session (launch.deleteSession): a Claude or Codex transcript goes to the Recycle Bin, an OpenCode
  // session is deleted by its CLI. The windows hear about it as "data:changed".
  handle("session:delete", async (agent, id) => {
    if (!SESSION_ID.test(text(id)) || !isAgent(agent)) throw new Error(t("errors.invalidSession"));
    await launch.deleteSession(agent, id, f => shell.trashItem(f));
    return true;
  });
  // Branch and changes of the projects' and sessions' folders (git-status.js); a refresh is answered by "git:changed".
  handle("git:diff", (node, root, file) => {
    const params = { root: text(root), file: text(file) };
    if (!node) return gitStatus.diff(params);
    return links.call(text(node, 64), "git.diff", params);
  });
  handle("git:get", () => gitStatus.get());
  handle('git:query', (node, params) => {
    if (!isObj(params)) throw new Error('Invalid Git request');
    return node ? links.call(text(node, 64), 'git.query', params, { timeout: 130000 }) : gitStatus.query(params);
  });
  handle('git:execute', (node, params) => {
    if (!isObj(params)) throw new Error('Invalid Git request');
    return node ? links.call(text(node, 64), 'git.execute', params, { timeout: 130000 }) : gitStatus.execute(params);
  });
  handle('git:open-file', async (node, root, file) => {
    if (node) throw new Error('Open a terminal on the owning computer to edit remote files.');
    await gitStatus.diff({ root, file }); // Validate a known repo and changed path.
    const target = path.resolve(root, file);
    const realRoot = await fs.promises.realpath(root), realFile = await fs.promises.realpath(target);
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('File is outside the repository');
    // An editor URI opens text in VS Code, never executes the file's default association.
    await shell.openExternal('vscode://file/' + realFile.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/'));
    return true;
  });
  handle("git:refresh", async force => {
    const errors = [];
    await Promise.all([gitStatus.refresh({ force: force === true }), ...(force === true ? links.nodes().filter(n => n.status === "online").map(n => links.call(n.id, "git.refresh").then(git => { remote.set(n.id, { ...remote.get(n.id), git, gitError: '' }); nodesChanged(); }).catch(e => { errors.push(`${n.name}: ${e.message}`); remote.set(n.id, { ...remote.get(n.id), gitError: e.message }); nodesChanged(); })) : [])]);
    if (errors.length) throw new Error(errors.join('\n'));
    return true;
  });
  // Brings a running session's own terminal (tab) to the front; pid and folder come from the live registry.
  handle("terminal:focus", (agent, id) => {
    if (!SESSION_ID.test(text(id))) throw new Error(t("errors.invalidSession"));
    notifier?.seen(agent, id);
    return focusSessionAnywhere({ agent: text(agent), id });
  });
  // A path typed into the menu's search: offer a new session there if it is an existing directory.
  handle("fs:is-dir", p => (isDir(p) ? path.resolve(p) : ""));
  handle("voice:open-history", () => { voice?.openHistory(); return Boolean(voice); });
  handle("voice:open-settings", () => { voice?.openSettings(); return Boolean(voice); });
  // The edge menu's microphone: a voice command by click; its state is also pushed as "voice:command-state".
  handle("voice:command", () => voice?.command.toggle() ?? { ok: false });
  handle("voice:command-state", () => voice?.command.state() ?? { enabled: false, state: "idle" });
  // The command centre (orchestrator.js): its terminal, and what the edge menu's command field says to it.
  handle("centre:start", async () => { showTab(await orchestrator.open()); return true; });
  // The other computers (mesh/links.js) with what they show.
  handle("mesh:nodes", () => nodesView());
  handle("mesh:launch", (node, args) => remoteLaunch(text(node, 64), isObj(args) ? args : {}));
  handle("mesh:clone", (node, args) => remoteClone(text(node, 64), isObj(args) ? args : {}));
  handle("project:git-info", p => (isDir(p) ? gitInfo(p) : { url: "", branch: "" }));
  handle("centre:send", s => orchestrator.send(text(s, 20000)));
  // Every page, voice ones included, reads the language and theme from its preload before it renders.
  ipcMain.on("prefs:get", e => {
    e.returnValue = { ...prefs.get(), claudePlan: limits.get().providers.claude.plan || "" };
  });
}

// ---------- preferences ----------
// A new language reloads every page (main's own strings follow at once); a new theme only swaps the page's tokens.
// Before Settings had it, the notification switch was kept in notify.json.
function carryOverNotify() {
  if (prefs.get().notify !== null) {
    return;
  }
  let on = true;
  try {
    on = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "notify.json"), "utf8")).enabled !== false;
  } catch {}
  prefs.set({ notify: on });
}
function onPrefsChanged(p, keys) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("prefs:changed", p);
  if (keys.includes("theme") && managerWin && !managerWin.isDestroyed()) managerWin.setBackgroundColor(prefs.background());
  if (keys.includes("language")) {
    sessions.invalidate(); // fallback session titles are in the old language
    for (const w of [managerWin, bar?.win, bar?.handleWin]) if (w && !w.isDestroyed()) w.webContents.reload();
  }
  if (keys.includes("edgeHandle")) bar?.syncHandle();
  if (keys.includes("uiScale") && managerWin && !managerWin.isDestroyed()) managerWin.webContents.setZoomFactor(p.uiScale);
  if (keys.includes("autoUpdate")) updater.setAuto(p.autoUpdate);
  buildTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showManager);
  app.whenReady().then(async () => {
    prefs.load();
    carryOverNotify();
    prefs.on("changed", onPrefsChanged);
    // The proxy settings, before anything goes online (requests made meanwhile wait for them).
    network.start();
    // The command centre's tool server, before its terminal (restored or new) looks for it.
    await orchestrator.start().catch(e => console.error("The command centre could not start:", e.message));
    // Before the window: it shows the layout as soon as it is back (and updates as it comes).
    restoring = restoreWorkspace();
    registerIpc();
    autopilot.start();

    bar = createEdgeBar({
      preload: PRELOAD, onOpenManager: showManager, hotkeyLabel,
      handle: { shown: () => prefs.get().edgeHandle, position: prefs.handlePosition, displayId: prefs.handleDisplayId, savePosition: prefs.setHandlePosition }
    });
    tray = new Tray(makeIcon(32, 2));
    // A press opens or closes the menu at once (here, where Windows lets it take the focus); held down after opening
    // it, the same hotkey speaks a voice command while the menu stays open (voice/controller.js edgeKey()).
    hotkey = HOTKEYS.find(k => globalShortcut.register(k, () => { if (!voice?.edgeKey(k, () => bar.toggle())) bar.toggle(); })) || "";
    if (!hotkey) console.error(`None of the hotkeys is free: ${HOTKEYS.join(", ")}`);
    // Double-click would also fire this click, so recording is offered in the menu instead (VoiceTray: double-click).
    tray.on("click", () => bar.show("hotkey"));
    // Not reset on "balloon-closed": replacing a balloon can report the old one closed after the new one is up.
    tray.on("balloon-click", () => { const click = balloonClick; balloonClick = null; click?.(); });
    updater.on("changed", onUpdateChanged);
    updater.start({ auto: prefs.get().autoUpdate });
    notifier = createNotifier({
      liveSessions, focus: focusSessionAnywhere, balloon, t, tn, onChange: buildTrayMenu,
      quiet: () => Boolean(bar?.isVisible()),
      isEnabled: () => prefs.get().notify !== false,
      describe: (agent, id, cwd) => {
        const data = sessions.get();
        const s = data?.sessions.find(x => x.agent === agent && x.id === id);
        const dir = s?.cwd || cwd || "";
        const p = dir ? data?.registry.projects.find(x => norm(x.path) === norm(dir)) : null;
        return { title: s?.title, project: p?.name || path.basename(dir) };
      }
    });
    notifier.start();
    buildTrayMenu();

    // Started with Windows: the tray and the edge menu only, until the user asks for the window.
    if (!autostart.startedAtLogin()) showManager();
    autostart.applyDefault().catch(err => console.error("Could not set up starting with Windows:", err.message));
    launch.sweepPrompts(); // prompts of voice commands whose terminal never started
    host.start(); // the scans, the usage figures, the git status, the tabs' links to their sessions
    links.start().then(nodesChanged, e => console.error("The mesh could not start:", e.message));
    answerPopup = require("./answer-popup").createAnswerPopup({ preload: PRELOAD, background: prefs.background, copy: async s => clipboard.writeText(s), icon: makeIcon(64) });
    voiceContext.start();
    // Started once the windows are up: the first run copies VoiceTray's history first, and a voice part that cannot
    // start (native module, broken data) must not take the session manager down with it.
    // Voice needs the platform's hotkeys, focus, synthetic keys and clipboard (voice/native.js): Windows, or Linux
    // under Hyprland.
    voiceStarting = !require("./voice/native").supported() ? Promise.resolve() : Promise.resolve()
      .then(() => require("./voice/controller").initVoice({
        balloon, onTrayChanged: buildTrayMenu, icon: makeIcon(64), prefs, showAnswer: a => answerPopup?.show(a),
        // The dictionary may include the projects' names.
        projectNames: () => [...readRegistry().projects.map(p => p.name), ...voiceContext.terms()],
        general: { set: patch => prefs.set(patch), hotkey: () => ({ current: hotkeyLabel(), candidates: HOTKEYS.map(k => keyLabel(k, " + ")) }), updates: updater, network,
          autostart, mesh: meshSettings },
        // What a voice command says goes to the command centre.
        commands: {
          orchestrate: s => orchestrator.send(s),
          // While a command is being spoken the menu stays, wherever the pointer or the focus goes (edge-bar.js).
          onState: s => {
            bar.keepOpen(s.state === "recording");
            if (!bar.win.isDestroyed()) bar.win.webContents.send("voice:command-state", s);
          }
        }
      }))
      .then(v => { voice = v; buildTrayMenu(); }, e => console.error("Voice features could not start:", e));
  });
  // Gives an in-flight transcription a moment to settle back to Pending and frees the voice hotkeys first - briefly:
  // quitting must never hang on it.
  let quitting = false;
  app.on("before-quit", e => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const shutdown = Promise.all([(async () => { await voiceStarting; await voice?.dispose(); })(), host.flush(), saveWorkspaceFinal()]);
    Promise.race([shutdown, new Promise(r => setTimeout(r, QUIT_GRACE_MS))])
      .catch(err => console.error("Voice shutdown failed:", err))
      .finally(() => app.quit());
  });
  app.on("will-quit", () => {
    orchestrator.stop();
    host.stop();
    links.stop();
    globalShortcut.unregisterAll();
    // Quitting without before-quit (Windows ending the session) still saves the layout, at once.
    if (workspaceSaving) {
      workspaceSaving = false;
      try {
        fs.writeFileSync(`${WORKSPACE_FILE}.quit`, getSavedWorkspace());
        fs.renameSync(`${WORKSPACE_FILE}.quit`, WORKSPACE_FILE);
      } catch (e) {
        console.error("Saving the layout failed:", e.message);
      }
    }
    // The terminals keep running; the next start attaches to them again.
    terminals.detachAll();
  });
  // The hidden edge menu keeps the app alive after the manager window is closed; quitting is done from the tray.
  app.on("window-all-closed", () => {});
}
