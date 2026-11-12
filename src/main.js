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
const { findIdea } = require("./shared/editors");
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
const desk = require("./desktop-terminals");
const { isReport } = require("./host/viewers");
// The terminals belong to the computer they run on (docs/SHARED-SESSIONS.md): the window views those it has a pane of
// - this computer's as the viewer "" of its host (host/viewers.js), the others' as this node there - and hiding a pane
// only stops viewing. panedIds: the terminals with a pane in the layout; localViewing: this computer's terminals the
// window is a viewer of (syncLocalViewers); wants: the size each pane last fitted (a want; "Use my size" takes it);
// sentEnd: the end of the output the window got of each terminal, so a pane shown again gets only what it missed;
// shownTitles: the titles of the panes' terminals as last shown (for "ended"); stoppedHere: terminals this window
// stopped (no "ended" for them); reopenSeen: terminals typed into here, whose "reopened after a restart" is done.
let panedIds = new Set();
const localViewing = new Set(), wants = new Map(), sentEnd = new Map(), stoppedHere = new Set(), reopenSeen = new Set();
let shownTitles = new Map(), stoppingAll = false;
const workspace = createWorkspace({ onChange: snap => { panesChanged(snap); sendWorkspace(); scheduleWorkspaceSave(); } });
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
// Output goes to the window only for the terminals it has a pane of: it draws no other (one shown again gets what it
// missed from the scrollback, shownAgain).
host.on("terminal:data", d => {
  if (!panedIds.has(d.id)) return;
  noteSent(d.id, d.end);
  sendToManager("terminal:data", d);
});
// A terminal's size or driver changed (host/viewers.js): its pane draws it in that size, or fits itself.
host.on("terminal:size", s => { if (panedIds.has(s.id)) sendToManager("terminal:size", { id: s.id, ...desk.sizeView(s, "", localNameOf) }); });
// A program that ends takes its pane with it, as in Herdr. A terminal lost with its DockPty (killed, or Windows
// shutting down first) keeps its pane, which opens anew on the next start.
host.on("terminal:exit", ({ id, lost }) => { if (lost) terminals.setNote(id, t("term.lost")); else terminals.close(id); });
host.on("terminals", () => { syncLocalViewers(); prunePanes(); sendWorkspace(); scheduleWorkspaceSave(); updateTrayCount(); orchestrator.terminalsChanged(); });
const noteSent = (id, end) => { if (Number.isFinite(end)) sentEnd.set(id, Math.max(sentEnd.get(id) ?? 0, end)); };
// Panes whose terminal is gone (closed, or ended) leave the layout; the window says which ended - unless this window
// stopped it, or everything is being stopped on the way out.
function prunePanes() {
  const alive = new Set([...terminals.getTabs().map(x => x.id), ...remoteTerms.keys()]);
  // The titles as last shown, taken before the layout changes (each view made after has the gone terminals no more).
  const titles = shownTitles;
  for (const tab of Object.values(workspace.snapshot().tabs)) {
    for (const term of getPanes(tab.root).filter(term => !alive.has(term))) {
      const title = titles.get(term);
      workspace.removeTerm(term);
      sentEnd.delete(term);
      wants.delete(term);
      if (!stoppedHere.delete(term) && !stoppingAll && title !== undefined) sendToManager("terminal:ended", { id: term, title });
    }
  }
}
// The layout changed: the window views this computer's terminals it now has a pane of (and no other), and a pane shown
// again catches up. A terminal whose pane left the layout has no view in the window any more (workspace-ui.js
// renderWorkspace disposes it): what the window got of it is forgotten, and a pane shown again later attaches anew,
// with the whole scrollback - no gap to fill then.
function panesChanged(snap) {
  const next = new Set(Object.values(snap.tabs).flatMap(tab => getPanes(tab.root)));
  const added = [...next].filter(id => !panedIds.has(id));
  for (const id of panedIds) if (!next.has(id)) sentEnd.delete(id);
  panedIds = next;
  syncLocalViewers();
  added.forEach(shownAgain);
}
// This computer's terminals with a pane here have the window as their viewer "" (host/viewers.js); the others not. The
// pane's last fit goes with it, so the size follows at once when nobody else drives.
function syncLocalViewers() {
  const wanted = new Set(terminals.getTabs().filter(x => !x.exited && panedIds.has(x.id)).map(x => x.id));
  const { attach, detach } = desk.viewerDiff(localViewing, wanted);
  for (const id of detach) {
    localViewing.delete(id);
    host.viewers.detach(id, "");
  }
  for (const id of attach) {
    localViewing.add(id);
    try {
      host.viewers.attach(id, "", { kind: "desktop" });
      const w = wants.get(id);
      if (w) host.viewers.want(id, "", w.cols, w.rows);
    } catch (e) {
      localViewing.delete(id); // too many viewers: tried again with the next change
      launchLog(`viewing ${id.slice(0, 8)} failed (${e.code || e.message})`);
    }
  }
}
// A pane that came (back) into the layout. Its view in the window went with its pane, so the window attaches it itself
// (sentEnd was forgotten); what is left here is a view that outlived a short absence - the pane moved and came back
// within one change of the layout, or the window attached it before the layout said so -, which gets the output it
// missed meanwhile and the size the terminal has now.
function shownAgain(id) {
  const x = remoteTerms.get(id);
  if (x) {
    if (sentEnd.has(id) && links.online(x.node)) attachRemote(x).catch(e => meshLog(`attaching ${id.slice(0, 8)} on ${nodeName(x.node)} failed: ${e.message}`));
    return;
  }
  if (sentEnd.has(id)) fillGap(id, terminals.attach(id));
  const s = host.viewers.state(id);
  if (s) sendToManager("terminal:size", { id, ...desk.sizeView(s, "", localNameOf) });
}
// The output the window missed of a terminal it got output of before, from an attach's scrollback.
function fillGap(id, a) {
  if (!sentEnd.has(id) || !isObj(a)) return;
  const data = desk.missedOutput(a.scrollback, a.end, sentEnd.get(id));
  if (data) sendToManager("terminal:data", { id, data, end: a.end });
  noteSent(id, a.end);
}
// Who is who in the names the window shows: this computer, the paired nodes (phones too).
const selfName = () => links.self()?.name || os.hostname();
function nodeNames() {
  const names = new Map(links.nodes().map(n => [n.id, n.name]));
  const self = links.self();
  if (self) names.set(self.id, self.name);
  return names;
}
const localNameOf = who => (who === "" ? selfName() : desk.nameOr(nodeNames(), who));
function getWorkspaceView() {
  const self = links.self();
  const list = desk.composeView({
    local: host.tabs(), paned: panedIds, self: { id: self?.id || "", name: selfName() }, names: nodeNames(),
    nodes: computers().map(n => ({ id: n.id, name: n.name, online: links.online(n.id), legacy: isLegacy(n.id), tabs: remoteLists.get(n.id) || null })),
    remoteTerms, offline: t("manager.node.offline"), cleared: reopenSeen
  });
  // The bare titles of the panes' terminals, for the "ended" of one that goes.
  shownTitles = new Map([
    ...host.tabs().filter(x => panedIds.has(x.id)).map(x => [x.id, x.title]),
    ...[...remoteTerms.values()].map(x => [x.id, x.title])
  ]);
  return { ...workspace.snapshot(), terminals: list };
}
// Quitting leaves AgentDeck's own terminals running (the next start attaches to them again); the tray's "Stop all
// terminals and quit" ends them, asked first while any runs.
async function stopAllAndQuit() {
  const running = terminals.countRunning();
  if (running) {
    // They end for every device that has them open: the devices that do are named.
    const names = nodeNames();
    const others = [...new Set(host.tabs().filter(x => !x.exited).flatMap(x => x.viewers.filter(v => v.id !== "").map(v => desk.nameOr(names, v.id))))];
    const options = {
      type: "warning", buttons: [t("quit.stopAll.confirm"), t("common.cancel")], defaultId: 1, cancelId: 1, noLink: true,
      title: t("app.name"), message: tn("quit.stopAll.message", running),
      detail: t("quit.stopAll.detail") + (others.length ? `\n\n${t("term.viewers", { names: others.join(", ") })}` : "")
    };
    const owner = managerWin && !managerWin.isDestroyed() && managerWin.isVisible() ? managerWin : null;
    if ((owner ? dialog.showMessageBoxSync(owner, options) : dialog.showMessageBoxSync(options)) !== 0) return;
  }
  // The layout stays as it is: the next start opens its panes anew (agents resume their sessions).
  await saveWorkspaceFinal();
  stoppingAll = true;
  terminals.stopAll();
  app.quit();
}
// The layout is saved in userData/workspace.json (a second after a change, and on quit) with what runs in each pane,
// so the next start puts it back (restoreWorkspace). Not while it is being restored, nor once quitting began: the
// terminals stopped then would save an emptied layout over the real one.
const WORKSPACE_FILE = path.join(app.getPath("userData"), "workspace.json");
const WORKSPACE_SAVE_MS = 1000;
let workspaceSaveTimer = null, workspaceSaving = false;
// What runs in each pane: this computer's terminals with a pane here (whoever opened them), and the other computers'.
function getSavedWorkspace() {
  const terms = Object.fromEntries([
    ...terminals.getTabs().filter(x => panedIds.has(x.id)).map(x => [x.id, { cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId }]),
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
// The saved layout, each pane with its terminal (docs/SHARED-SESSIONS.md 5.4): the host first puts its terminals back -
// those still running attached again, those a restart took opened anew under the same id (host.restoreTerminals) -,
// then each pane keeps its terminal, waits for its computer, or gets one opened anew here (desk.restorePlan). Shown
// space, tabs and focus as they were. All spaces at once: a space shown later finds its panes ready, and the edge menu
// counts them. A running terminal with no pane here stays without one: it is listed under "Terminals" (putting it in
// a tab would undo the X that hid it).
async function restoreWorkspace() {
  const saved = readSavedWorkspace();
  let restored = !saved; // with no layout to put back, there is nothing a save could spoil
  try {
    // Not waited for long: without it the terminals open as they would with the option off.
    const proxy = await Promise.race([network.terminalProxy().catch(() => null), new Promise(resolve => setTimeout(resolve, 10000, null))]);
    const env = terminalEnv(process.env, proxy);
    // The command centre's terminal is never opened anew by the host: it comes back with its own command
    // (reopenTerminal -> orchestrator.open), its session resumed.
    const { attached, kept, reopened } = await host.restoreTerminals({ skip: meta => orchestrator.isOwn(meta?.cwd), env });
    if (reopened.length) launchLog(`reopened after a restart: ${reopened.map(id => id.slice(0, 8)).join(", ")}`);
    const panes = saved ? new Set(Object.values(saved.layout.tabs || {}).flatMap(tab => getPanes(tab?.root))) : new Set();
    const plan = desk.restorePlan({ panes, terms: saved?.terms || {}, attached, reopened, kept, isId: id => frames.UUID.test(id) });
    // A pane of a terminal on another computer keeps its place: once that computer is connected again, the terminal
    // is found there (or the pane goes).
    for (const old of plan.remote) {
      const meta = saved.terms[old];
      remoteTerms.set(old, { id: old, node: meta.node, cwd: String(meta.cwd || ""), title: String(meta.title || ""), agent: String(meta.agent || ""), sessionId: String(meta.sessionId || ""), exited: false, pending: true });
    }
    const ids = new Map([...plan.keep, ...plan.remote].map(old => [old, old]));
    // A pane whose terminal still runs but could not be attached (plan.drop) goes: opened anew, its agent would run a
    // second time on the same session. One with nothing left of it opens anew here, under a new id.
    for (const old of plan.reopen) {
      ids.set(old, await reopenTerminal(saved.terms[old], env));
    }
    if (saved) workspace.importState(require("./shared/path-keys").migrateLayout(saved.layout, readRegistry().projects, keyOf), old => ids.get(old) || "");
    restored = true;
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
// The terminals of other computers (docs/SHARED-SESSIONS.md 5.1). remoteLists: each computer's whole list (every
// terminal it has, whoever opened it; only this node's own from a host without terminals: 2), as terminals.list and
// its "terminals" event tell it. remoteTerms: those with a pane here, by the terminal's id (a UUID both sides use) -
// where input, sizes and attaches go. Their output arrives as frames and goes to the window like a local terminal's.
// One whose computer is away keeps its pane (note "offline"); one gone there loses its pane.
const remoteLists = new Map(); // node id -> [Tab]
const remoteTerms = new Map(); // id -> { id, node, cwd, title, agent, sessionId, exited, createdAt, pending }
const attachWaits = new Map(); // id -> [resolve]: the window's attaches of a pane whose computer is away
const nodeName = id => links.nodes().find(n => n.id === id)?.name || id.slice(0, 8);
// A host that does not share its terminals yet (no terminals: 2 in host.info, docs/SHARED-SESSIONS.md 6): only this
// node's own terminals, no viewers, no sizes of another device; X detaches.
const isLegacy = node => remote.get(node)?.info?.terminals !== 2;
const remoteEntry = (node, tab) => ({ id: tab.id, node, cwd: String(tab.cwd || ""), title: String(tab.title || ""), agent: String(tab.agent || ""), sessionId: String(tab.sessionId || ""), exited: Boolean(tab.exited), createdAt: tab.createdAt });
// Names of the viewers of a terminal there: as its computer named them in its list, else as paired here.
const remoteNameOf = (node, id) => who => remoteLists.get(node)?.find(x => x.id === id)?.viewers?.find(v => v.id === who)?.name || desk.nameOr(nodeNames(), who);
// A size there ({ cols, rows, driver }) as the window gets it: this window drives when this node does.
function remoteSize(node, id, s) {
  if (isLegacy(node)) return { cols: s?.cols, rows: s?.rows, mine: false, by: "" };
  return desk.sizeView(s, links.self()?.id ?? null, remoteNameOf(node, id));
}
const cleanTabs = data => (Array.isArray(data) ? data.filter(x => isObj(x) && frames.UUID.test(x.id)) : []);
function remoteTermsChanged() {
  prunePanes();
  sendWorkspace();
  scheduleWorkspaceSave();
}
// A computer's list of its terminals: the panes' titles and states follow, and a terminal gone there takes its pane.
function reconcileRemote(node, tabs) {
  remoteLists.set(node, tabs);
  const there = new Map(tabs.map(x => [x.id, x]));
  for (const [id, x] of remoteTerms) {
    if (x.node !== node) continue;
    const tab = there.get(id);
    if (!tab) remoteTerms.delete(id);
    else Object.assign(x, { cwd: tab.cwd, title: tab.title, agent: tab.agent, sessionId: tab.sessionId, exited: tab.exited, createdAt: tab.createdAt, pending: false });
  }
  remoteTermsChanged();
}
// The window attaches a terminal it shows: this computer's (its viewer "" follows the layout, syncLocalViewers), or
// one on another computer, which makes this node a viewer there and sends its output here. -> { scrollback, end,
// exitCode, cols, rows, mine, by } (docs/SHARED-SESSIONS.md 5.3). A pane whose computer is away waits for it; one
// hidden meanwhile gets null.
async function attachTerm(id) {
  const x = remoteTerms.get(id);
  if (!x) {
    const a = terminals.attach(id);
    if (!a) return null;
    syncLocalViewers();
    if (panedIds.has(id)) noteSent(id, a.end); // a pane hidden meanwhile: its view is gone, nothing was sent
    const s = host.viewers.state(id);
    return { ...a, ...(s ? desk.sizeView(s, "", localNameOf) : { mine: false, by: "" }) };
  }
  if (!links.online(x.node)) return new Promise(resolve => attachWaits.set(id, [...(attachWaits.get(id) || []), resolve]));
  const a = await links.call(x.node, "terminals.attach", { id });
  if (!isObj(a)) return null;
  if (panedIds.has(id)) noteSent(id, a.end);
  sendWant(x);
  return { ...a, ...remoteSize(x.node, id, a) };
}
// The window's attaches that waited for a computer: answered once it is back (null for a pane hidden meanwhile).
function answerAttachWaits(node) {
  for (const [id, waits] of attachWaits) {
    const x = remoteTerms.get(id);
    if (x && x.node !== node) continue;
    attachWaits.delete(id);
    const answer = x ? attachTerm(id).catch(() => null) : Promise.resolve(null);
    waits.forEach(resolve => resolve(answer));
  }
}
// Attaching again to a terminal there whose pane the window already shows (its computer came back, a resync, the
// pane shown again): the output it missed, the size there, and this pane's want.
async function attachRemote(x) {
  const a = await links.call(x.node, "terminals.attach", { id: x.id });
  if (remoteTerms.get(x.id) !== x) {
    // Hidden meanwhile: not viewing it after all.
    links.call(x.node, "terminals.detach", { id: x.id }).catch(() => {});
    return;
  }
  if (!isObj(a)) return;
  fillGap(x.id, a);
  sendToManager("terminal:size", { id: x.id, ...remoteSize(x.node, x.id, a) });
  sendWant(x);
}
// The size the pane last fitted, told to the terminal's computer (a want there, docs/SHARED-SESSIONS.md 4.3).
function sendWant(x) {
  const w = wants.get(x.id);
  if (w && links.online(x.node)) links.sendBinary(x.node, frames.encodeResize(x.id, w.cols, w.rows));
}
// Hide (X, a tab's X, Ctrl+Shift+W): the pane goes and the window stops viewing the terminal, which goes on running
// - listed under "Terminals", to be opened again.
function hideTerm(id) {
  const x = remoteTerms.get(id);
  workspace.removeTerm(id); // this computer's: syncLocalViewers detaches the window
  wants.delete(id);
  if (!x) return true;
  remoteTerms.delete(id);
  attachWaits.get(id)?.forEach(resolve => resolve(null));
  attachWaits.delete(id);
  if (links.online(x.node)) links.call(x.node, "terminals.detach", { id }).catch(e => meshLog(`detaching ${id.slice(0, 8)} on ${nodeName(x.node)} failed: ${e.message}`));
  remoteTermsChanged();
  return true;
}
// The computer a terminal runs on: "" this one, a node id, or null when it is known nowhere (also one known only from a
// live session's `term` there).
function nodeOfTerm(id) {
  return desk.nodeOf(id, {
    local: new Set(terminals.getTabs().map(x => x.id)), remoteTerms, lists: remoteLists,
    lives: new Map([...remote].filter(([node]) => links.online(node)).map(([node, r]) => [node, r.live]))
  });
}
// Stop: the terminal ends on its computer, for every device that has it open.
async function stopTerm(id) {
  const node = nodeOfTerm(id);
  if (node === null) throw new HostError("invalidData");
  if (node !== "" && !links.online(node)) throw new HostError("offline");
  stoppedHere.add(id);
  setTimeout(() => stoppedHere.delete(id), 60000).unref?.();
  if (node === "") return terminals.close(id) || true;
  await links.call(node, "terminals.close", { id });
  return true;
}
// Where a terminal with no pane here can open: a tab of its own, or on a side of a pane (a sidebar row dropped on it).
const PANE_PLACES = ["tab", "left", "right", "up", "down"];
// A new pane: a tab of its own in `space`, or on that side of the pane of `at` - when it has one here, else of the shown
// tab's focused pane.
function placePane(space, id, place, at = "") {
  const tab = (at && workspace.findTab(at)) || workspace.getActiveTab();
  if (place !== "tab" && tab) workspace.split(tab.id, id, place, at);
  else workspace.addTab(space, id);
}
// A terminal there in a pane here: the one it has (focused), or a new one in `space`.
async function paneForRemote(node, tab, space, place = "tab", at = "") {
  await restoring;
  if (workspace.findTab(tab.id)) workspace.focus(tab.id);
  else {
    remoteTerms.set(tab.id, remoteEntry(node, tab));
    placePane(space, tab.id, place, at);
  }
  showManager();
  return tab.id;
}
// Any terminal, of this computer or another one, comes up here (the sidebar's "Terminals", a session in "Agents", the
// palette): its pane focused, or a new one in its project's space (`place`: PANE_PLACES), beside the pane of `at` or
// the focused one.
async function openTerm(id, place = "tab", at = "") {
  await restoring;
  if (workspace.findTab(id)) {
    workspace.focus(id);
    showManager();
    return true;
  }
  const node = nodeOfTerm(id);
  if (node === null) throw new HostError("invalidData");
  if (node === "") {
    const x = terminals.getTabs().find(tab => tab.id === id);
    placePane(getSpaceFor(x.cwd), id, place, at);
    showManager();
    return true;
  }
  if (!links.online(node)) throw new HostError("offline");
  let tab = remoteLists.get(node)?.find(x => x.id === id);
  if (!tab) {
    // Known only from a live session's term: the computer's list now.
    reconcileRemote(node, cleanTabs(await links.call(node, "terminals.list")));
    tab = remoteLists.get(node)?.find(x => x.id === id);
  }
  if (!tab) throw new HostError("invalidData");
  await paneForRemote(node, tab, desk.remoteSpace(readRegistry().projects, node, tab.cwd), place, at);
  return true;
}
// The project's repository cloned on another computer, in a pane here (mesh/serve.js repo.clone): {url, dir, branch,
// base, agent, prompt}. The pane goes to the space of the new folder there.
async function remoteClone(node, args) {
  if (!links.online(node)) throw new HostError("offline");
  const tab = await links.call(node, "repo.clone", args, { timeout: 60000 });
  if (!isObj(tab) || !frames.UUID.test(tab.id)) throw new HostError("invalidData");
  return paneForRemote(node, tab, `node:${node}:${normPath(tab.dir || tab.cwd)}`);
}
// A local project's origin and current branch, for the clone dialog.
function gitInfo(dir) {
  const git = (...a) => new Promise(resolve => execFile("git", ["-C", dir, ...a], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? "" : String(out).trim())));
  return Promise.all([git("remote", "get-url", "origin"), git("rev-parse", "--abbrev-ref", "HEAD")]).then(([url, branch]) => ({ url, branch }));
}
// A terminal on another computer, in a new tab of that project's space here: {cwd, kind, agent, sessionId, prompt}.
// A resume of a session that runs in a terminal there already opens nothing there: that terminal comes up here
// (already: true).
async function remoteLaunch(node, args) {
  if (!links.online(node)) throw new HostError("offline");
  const tab = await links.call(node, "terminals.open", args);
  if (!isObj(tab) || !frames.UUID.test(tab.id)) throw new HostError("invalidData");
  const space = tab.already ? desk.remoteSpace(readRegistry().projects, node, tab.cwd) : `node:${node}:${normPath(args.cwd)}`;
  return paneForRemote(node, tab, space);
}
// What the peers may ask of this computer, and what it pushes to them (mesh/serve.js).
const served = createServed({ host, env: async () => terminalEnv(process.env, await network.terminalProxy().catch(() => null)) });
const links = createLinks({ dir: path.join(app.getPath("userData"), "node"), defaultName: os.hostname(), kind: "desktop", version: app.getVersion(), api: served.api, log: meshLog });
served.attach(links);
// The mesh starts with the app. A file of the node that cannot be read (identity.js readKept: locked, or damaged)
// keeps only the mesh off - the rest of AgentDeck runs - with the reason in Settings -> Computers and once in a
// balloon; the start is tried again every half minute (a lock goes away; a damaged file waits for the user).
const MESH_RETRY_MS = 30000;
let meshError = "";
function startMesh() {
  links.start().then(() => {
    if (meshError) meshLog("the mesh started after all");
    meshError = "";
    nodesChanged();
  }, e => {
    if (e.code !== "unreadable") return console.error("The mesh could not start:", e.message);
    if (e.message !== meshError) {
      meshError = e.message;
      meshLog(`the mesh cannot start: ${e.message}`);
      console.error("The mesh cannot start:", e.message);
      balloon(t("mesh.unreadable.body", { file: e.file }), { title: t("mesh.unreadable.title"), iconType: "warning" });
      links.emit("self", null); // Settings -> Computers, when open, shows it
    }
    setTimeout(startMesh, MESH_RETRY_MS).unref?.();
  });
}
// What the other computers show - their last list, live status and git - kept per node and pushed to the manager
// window with the nodes themselves ("mesh:nodes").
const remote = new Map(); // node id -> { data, live, git }
// The paired computers. Phones (kind "mobile", docs/MOBILE.md) are peers too, but no computers: they have no projects,
// sessions or git and take no clones, so they show only under Settings -> Computers -> Phones.
const computers = () => links.nodes().filter(n => n.kind !== "mobile");
const nodesView = () => computers().filter(n => !served.layout.isRemoved(n.id)).map(n => ({ ...n, ...(remote.get(n.id) || {}) }));
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
    require("./mesh/projects").mergeProjects(data, computers(), remote);
    served.layout.apply(data);
    if (JSON.stringify(data) !== before) sessions.registry.save(data);
  } catch (e) {
    meshLog(`Project sync failed: ${e.message}`);
  }
}

links.on("nodes", nodesChanged);
links.on("layout", nodesChanged);
links.on("event", ({ node, name, data }) => {
  if (name === "terminals") return reconcileRemote(node, cleanTabs(data));
  // The size of a terminal there, or who drives it, changed: its pane here draws it so.
  if (name === "terminal.size") {
    if (isObj(data) && remoteTerms.get(data.id)?.node === node) sendToManager("terminal:size", { id: data.id, ...remoteSize(node, data.id, data) });
    return;
  }
  // This node fell behind on a terminal's output there (mesh/serve.js): attaching again brings what it missed.
  if (name === "terminal.resync") {
    const x = remoteTerms.get(data?.id);
    if (x?.node === node) attachRemote(x).catch(e => meshLog(`attaching ${x.id.slice(0, 8)} again on ${nodeName(node)} failed: ${e.message}`));
    return;
  }
  // From a host without terminals: 2 only: another peer (a phone) that sized our terminal there let go of it - its pane
  // here sends its size again. Newer hosts hand the size back themselves.
  if (name === "terminal.refit") return void (remoteTerms.get(data?.id)?.node === node && sendToManager("terminal:refit", data.id));
  if (!["data", "live", "git", "usage", "limits", "resources"].includes(name)) return;
  remote.set(node, { ...remote.get(node), [name]: data, ...(name === 'git' ? { gitError: '' } : {}) });
  nodesChanged();
});
// Output of this computer's terminals on other computers, to the window (keystrokes for a peer's terminals here are
// mesh/serve.js's).
links.on("binary", ({ node, data }) => {
  const f = frames.decode(data);
  if (f?.type !== "output" || remoteTerms.get(f.id)?.node !== node) return;
  noteSent(f.id, f.end);
  sendToManager("terminal:data", { id: f.id, data: f.data, end: f.end });
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
    reconcileRemote(node, cleanTabs(tabs));
    // The panes the window could not attach while it was away are attached now; the others get the output they missed
    // (its link dropped, the host forgot this node as a viewer: attaching again makes it one).
    const waiting = new Set(attachWaits.keys());
    answerAttachWaits(node);
    for (const x of [...remoteTerms.values()]) {
      if (x.node !== node || waiting.has(x.id)) continue;
      await attachRemote(x).catch(e => meshLog(`attaching ${x.id.slice(0, 8)} on ${nodeName(node)} again failed: ${e.message}`));
    }
  } catch (e) {
    meshLog(`reading ${node.slice(0, 8)} failed: ${e.message}`);
  }
});
// Settings -> Computers (voice/windows.js serves the page): the picture, the settings of this node, pairing and
// forgetting. Errors come as texts in the user's language, not as exceptions.
const ADDRESS = /^\s*(\[[0-9a-f:.]+\]|[^:\s[\]]+)(?::(\d{1,5}))?\s*$/i;
// This computer's addresses on the local networks (IPv4), for a phone that pairs without a relay.
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);
// An invite as a node answered pair.invite (mesh/links.js): checked before it goes into a QR code.
function checkInvite(x, id) {
  if (!isObj(x) || x.id !== id || !/^[0-9a-f]{64}$/.test(x.key) || typeof x.code !== "string" || !/^[0-9A-Z-]{26,40}$/.test(x.code) || !Number.isFinite(x.expires)) throw new HostError("invalidData");
  return { id: x.id, key: x.key, code: x.code, name: typeof x.name === "string" ? x.name.slice(0, 60) : "", kind: x.kind === "host" ? "host" : "desktop", expires: x.expires };
}
// Adding a phone (docs/MOBILE.md 4): one-time invites from this computer and from the chosen ones, in one QR code.
// relay: the id of the paired computer the phone dials ("" for none: the same network, every computer directly);
// address: where the phone reaches that relay (or, with none, this computer), "host" or "host:port"; nodes: the ids of
// the other computers the phone may use. -> { ok, text, expires, included: [names], skipped: [{ name, error }] }.
async function invitePhone({ relay = "", address = "", nodes: wanted = [] } = {}) {
  const pairCode = require("./mesh/pair-code");
  const list = computers(), self = links.self();
  const m = ADDRESS.exec(String(address ?? ""));
  if (!m) return { ok: false, error: t("errors.badAddress") };
  const host = m[1].replace(/^\[|\]$/g, "");
  const r = relay ? list.find(n => n.id === relay && n.status === "online" && !n.via?.length) : null;
  if (relay && !r) return { ok: false, error: t("errors.offline") };
  const port = Number(m[2]) || (r ? r.port : self.port) || DEFAULT_PORT;
  if (port > 65535) return { ok: false, error: t("errors.badAddress") };
  const ids = [...new Set((Array.isArray(wanted) ? wanted : []).filter(id => typeof id === "string" && id !== relay && id !== self.id))];
  const skipped = [], entries = [];
  const own = links.invite();
  entries.push({ ...own, ...(r ? {} : { a: host, p: port }) });
  await Promise.all(ids.map(async id => {
    const n = list.find(x => x.id === id);
    if (!n) return;
    const name = n.name || id.slice(0, 8);
    if (n.status !== "online") return void skipped.push({ name, error: t("errors.offline") });
    // Without a relay the phone dials every computer itself: only one this computer reaches directly has an address.
    if (!r && (n.via?.length || !n.address || !n.port)) return void skipped.push({ name, error: t("settings.phones.needsRelay") });
    try {
      const x = checkInvite(await links.call(id, "pair.invite", {}, { timeout: 10000 }), id);
      entries.push({ ...x, ...(r ? {} : { a: n.address, p: n.port }) });
    } catch (e) {
      skipped.push({ name, error: ["unpaired", "unknownMethod"].includes(e.code) ? t("settings.phones.outdated") : translated(e).message });
    }
  }));
  let rel = null;
  if (r) {
    try { rel = checkInvite(await links.call(r.id, "pair.invite", {}, { timeout: 10000 }), r.id); } catch (e) {
      return { ok: false, error: ["unpaired", "unknownMethod"].includes(e.code) ? t("settings.phones.outdated") : translated(e).message };
    }
  }
  // This computer first, the others in the order they were ticked; the rest stays out of an easily scanned code.
  const order = new Map(ids.map((id, i) => [id, i]));
  const nodes = [entries[0], ...entries.slice(1).sort((a, b) => order.get(a.id) - order.get(b.id))];
  for (const x of nodes.splice(pairCode.MAX_NODES)) skipped.push({ name: x.name || x.id.slice(0, 8), error: t("settings.phones.tooMany", { n: pairCode.MAX_NODES }) });
  try {
    const text = pairCode.encode({
      r: rel && { a: host, p: port, id: rel.id, k: pairCode.hexToKey(rel.key), c: rel.code, n: rel.name || r.name || "" },
      n: nodes.map(x => ({ id: x.id, k: pairCode.hexToKey(x.key), c: x.code, n: x.name || "", t: x.kind, ...(x.a ? { a: x.a, p: x.p } : {}) }))
    });
    return { ok: true, text, expires: Math.min(...[rel, ...nodes].filter(Boolean).map(x => x.expires)), included: nodes.map(x => x.name || x.id.slice(0, 8)), skipped };
  } catch (e) {
    return { ok: false, error: translated(e).message };
  }
}
// "Forget" on a phone: here, and on every computer and relay this one is paired with, relays last (links.js
// forgetPhone). -> the names of those that could not hear it now: the phone may still be paired there.
async function forgetPhone(id) {
  const phone = links.nodes().find(n => n.id === id && n.kind === "mobile");
  if (!phone) return [];
  const all = computers().length;
  const still = await links.forgetPhone(id);
  meshLog(`phone ${phone.name || id.slice(0, 8)} (${id.slice(0, 8)}) forgotten here and on ${all - still.length} of ${all} computer(s)${still.length ? `; not reached now: ${still.join(", ")}` : ""}`);
  return still;
}
const meshSettings = {
  // error: why the mesh is off (self is null then).
  state: () => ({ self: links.self(), error: meshError, nodes: computers(), phones: links.nodes().filter(n => n.kind === "mobile"), discovered: links.discovered(), lan: lanAddresses() }),
  invitePhone: async args => {
    try { return await invitePhone(isObj(args) ? args : {}); } catch (e) { return { ok: false, error: translated(e).message }; }
  },
  forgetPhone: async id => ({ still: await forgetPhone(String(id ?? "")), state: meshSettings.state() }),
  set: patch => { if (links.self()) links.setSelf(patch); return meshSettings.state(); },
  newCode: () => { if (links.self()) links.regenerateCode(); return meshSettings.state(); },
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
// One of this computer's terminals comes up in the window: its pane, or a new tab in its project's space when it has
// none here (hidden, or opened from another device).
async function showTab(id) {
  await restoring;
  if (!workspace.findTab(id)) {
    const x = terminals.getTabs().find(tab => tab.id === id);
    if (x) workspace.addTab(getSpaceFor(x.cwd), id);
  }
  workspace.focus(id);
  showManager();
}
// "Show terminal", a notification's click, a voice command, the command centre's show_session: a session in one of
// this computer's terminals comes up there - whoever opened it, with a pane here or not -, any other in its own
// terminal (terminal-focus.js; same answer).
async function focusSessionAnywhere(opts) {
  const tab = terminals.getTabs().find(x => x.agent === opts.agent && x.sessionId === opts.id && !x.exited);
  if (!tab) return focusSession(opts);
  await showTab(tab.id);
  return { ok: true, how: "tab", reason: "", ms: 0 };
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
  // A session that runs in one of this computer's terminals already is shown there: never resumed a second time.
  const running = launch.runningTab(agent, id);
  if (running) {
    await openTerm(running.id, PLACES.includes(place) ? place : "tab");
    return;
  }
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
// Only a tab of one pane: in a split tab the name belongs to no single session. Only a terminal of this computer
// (terminals.getTabs() has no others): the transcript of a session running elsewhere is that computer's to write.
// The two lines are what /rename writes (checked against Claude Code 2.1.317): the title, and the name its prompt shows.
function nameClaudeSession(tab) {
  const term = terminals.getTabs().find(x => x.id === tab.root?.term && x.agent === "Claude" && x.sessionId);
  const file = term && findTranscript(term.sessionId);
  if (!file) return;
  const lines = [
    { type: "custom-title", customTitle: tab.name, sessionId: term.sessionId },
    { type: "agent-name", agentName: tab.name, sessionId: term.sessionId },
  ];
  fs.promises.appendFile(file, lines.map(x => `${JSON.stringify(x)}\n`).join("")).catch(() => {});
}
// What the window asks of the layout (workspace-ui.js). Closing a pane or a tab hides it: the terminal goes on, for
// every device (Stop is terminal:stop).
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
    case "close-pane": return hideTerm(id(a.term));
    case "close-tab": workspace.getTabTerms(id(a.tab)).forEach(hideTerm); return true;
    // A terminal with no pane here - this computer's or another's, one known only from a live session's term - in a
    // new pane (PANE_PLACES; `at`: the pane it goes beside, else the focused one); one with a pane gets the focus.
    case "open-term": return openTerm(id(a.term), PANE_PLACES.includes(a.place) ? a.place : "tab", a.at === undefined ? "" : id(a.at));
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
  // A person's keystrokes: on the terminal's computer they make this window the one whose size it has (after the
  // other's HOLD, host/viewers.js). A "reopened after a restart" note is done with once typed into. The terminal's own
  // answers (isReport, host/viewers.js: xterm.js answers a program's questions, replayed ones too) are passed on, but
  // are no one's typing - here, and on another computer's host, which tells them apart itself (mesh/serve.js).
  ipcMain.on("terminal:input", (e, id, data) => {
    if (!trusted(e) || typeof id !== "string" || typeof data !== "string" || data.length > 1_000_000) return;
    const node = remoteTerms.get(id)?.node, typed = !isReport(data);
    if (node) links.sendBinary(node, frames.encodeInput(id, data));
    else {
      if (typed) {
        host.viewers.input(id, "");
        terminals.input(id, data);
      } else terminals.type(id, data);
    }
    if (typed && !reopenSeen.has(id)) {
      reopenSeen.add(id);
      sendWorkspace();
    }
  });
  // A pane's fit: the size it wants (a want, host/viewers.js) - the terminal takes it while this window drives or
  // nobody does. Remembered for "Use my size" and for attaching again.
  ipcMain.on("terminal:resize", (e, id, cols, rows) => {
    if (!trusted(e) || typeof id !== "string") return;
    const c = Number(cols), r = Number(rows);
    if (!Number.isInteger(c) || !Number.isInteger(r) || c < 1 || r < 1 || c > 1000 || r > 1000) return;
    wants.set(id, { cols: c, rows: r });
    const node = remoteTerms.get(id)?.node;
    if (node) links.sendBinary(node, frames.encodeResize(id, c, r));
    else if (localViewing.has(id)) host.viewers.want(id, "", c, r);
  });
  // "Use my size": the pane's last fit becomes the terminal's size, for every device (until another one types).
  handle("terminal:take-size", async id => {
    const term = text(id, 64), w = wants.get(term);
    if (!w) throw new HostError("invalidData");
    const x = remoteTerms.get(term);
    if (!x) {
      syncLocalViewers();
      host.viewers.take(term, "", w.cols, w.rows);
      return true;
    }
    if (!links.online(x.node)) throw new HostError("offline");
    const s = await links.call(x.node, "terminals.resize", { id: term, cols: w.cols, rows: w.rows });
    if (isObj(s) && remoteTerms.has(term)) sendToManager("terminal:size", { id: term, ...remoteSize(x.node, term, s) });
    return true;
  });
  // Stop: the terminal ends on its computer, for every device (asked first in the window).
  handle("terminal:stop", id => stopTerm(text(id, 64)));
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
    // In the editor chosen in Settings, never through the file's default association (which could execute it).
    if (prefs.get().editor === 'idea') {
      const idea = findIdea();
      if (!idea) throw new Error(t('errors.ideaMissing'));
      // Its window must show: windowsHide would start a not yet running IDE hidden.
      await spawnDetached(idea, [realFile], { windowsHide: false });
      return true;
    }
    await shell.openExternal('vscode://file/' + realFile.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/'));
    return true;
  });
  handle("git:refresh", async force => {
    const errors = [];
    await Promise.all([gitStatus.refresh({ force: force === true }), ...(force === true ? computers().filter(n => n.status === "online").map(n => links.call(n.id, "git.refresh").then(git => { remote.set(n.id, { ...remote.get(n.id), git, gitError: '' }); nodesChanged(); }).catch(e => { errors.push(`${n.name}: ${e.message}`); remote.set(n.id, { ...remote.get(n.id), gitError: e.message }); nodesChanged(); })) : [])]);
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
  handle("centre:start", async () => { await showTab(await orchestrator.open()); return true; });
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
    // The mesh once the terminals are back: a peer connecting earlier would get a list without those still being
    // opened anew, and its panes of them would go (docs/SHARED-SESSIONS.md 4.6, as the headless host does).
    restoring.finally(startMesh);
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
