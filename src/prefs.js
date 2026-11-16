// App-wide preferences: UI language, theme and automatic updates (`ui` in settings.json), the edge handle
// (`edgeHandle`: shown or not, and where), and where sessions open (`terminal`): in Windows Terminal - a window of
// their own or a tab of the last one - or in AgentDeck's own terminals (`sessionsIn`, the default).
// Main process only. Every page gets a snapshot from its preload ("prefs:get") and "prefs:changed" afterwards;
// i18n.js applies language and theme. The handle's position is not in the snapshot: it changes with a drag, which no
// page needs to hear about.
//
// events: "changed" (snapshot, keys) - keys lists what changed: "language", "theme", "edgeHandle", "autoUpdate",
// "newWindow", "sessionsIn", "autoCompact", "autoCompactTokens", "terminalFontSize", "uiScale", "editor", "gitScope",
// "agentLoad", "taskbarMonitor", "taskbarNet", "taskbarCpu", "taskbarMemory".
const { app, nativeTheme } = require("electron");
const { EventEmitter } = require("node:events");
const settings = require("./voice/settings");
const i18n = require("./i18n");
const { isObj } = require("./shared/util");
const themes = require("./shared/themes");

const LANGUAGES = Object.keys(i18n.LANGUAGES);
const THEMES = themes.THEMES; // "system", then every theme in shared/themes.js
const SESSIONS_IN = ["windows", "tabs"];
// Context sizes from which a session in an AgentDeck tab is remembered and compacted (autopilot.js), when switched on.
const AUTO_COMPACT_TOKENS = [100000, 150000, 200000, 300000, 500000];
// The text of AgentDeck's own terminals, px before the window's scale; the manager window's scale (its zoom). The
// defaults: 16 px text at 100%.
const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24];
const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
// The editor a file opens in from the Git screens (main.js git:open-file).
const EDITORS = ["vscode", "idea"];
// Which repositories the Git panel lists (git-panel.js): those an open terminal is in, or all in the projects.
const GIT_SCOPES = ["open", "all"];

const prefs = new EventEmitter();
const state = { language: "bg", theme: themes.DEFAULT, edgeHandle: process.platform === "win32", autoUpdate: true, newWindow: true, sessionsIn: "tabs", autoCompact: false, autoCompactTokens: 150000, dayView: false, notify: null, terminalFontSize: 16, uiScale: 1, editor: "vscode", gitScope: "open" };
let sessionsInChosen = false; // the user picked where sessions open (settings or the tray menu)
let autoCompactTokensChosen = false; // the user picked a compaction threshold, so a stale old default is ignored
let handleX = 0.5; // the edge handle's centre, as a fraction of the display width
let handleDisplay = null; // the id of the display it is on (null: the primary one)
const fraction = v => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);
// The strip on the Windows taskbar (taskbar-monitor.js): off until asked for, and then with all it can show - traffic,
// CPU, memory - until some are unticked. Switched on, it always shows something: unticking the last one switches it
// off, and switching it on with none ticked ticks them all. Each is a key of "changed" too.
const TASKBAR_ITEMS = ["taskbarNet", "taskbarCpu", "taskbarMemory"];
const TASKBAR = ["taskbarMonitor", ...TASKBAR_ITEMS];
state.taskbarMonitor = false;
for (const key of TASKBAR_ITEMS) state[key] = true;
// The Claude sessions' CPU and memory at the end of their rows in the Agents list (proc-stats.js).
state.agentLoad = true;

// themeSource also gives native title bars and dialogs the chosen look: the theme's base (dark or light), or
// "system", which follows Windows. It takes nothing else.
const themeSource = theme => themes.baseOf(theme) || "system";
// resolvedTheme: dark or light, the base in effect. themeId: the theme the pages draw (<html data-theme>) - the one
// chosen, or for "system" dark or light as Windows has it.
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
const themeId = () => (themes.get(state.theme) ? state.theme : resolvedTheme());
// With the choices the pages offer (the lists above), so none keeps a copy of them.
const get = () => ({
  ...state, resolvedTheme: resolvedTheme(), themeId: themeId(), dev: !app.isPackaged,
  windows: process.platform === "win32",
  themes: THEMES.map(id => ({ id, group: themes.get(id)?.group ?? "app" })),
  terminalFontSizes: TERMINAL_FONT_SIZES, uiScales: UI_SCALES, autoCompactSizes: AUTO_COMPACT_TOKENS, editors: EDITORS, gitScopes: GIT_SCOPES,
  autoCompactChosen: autoCompactTokensChosen
});
// The theme's --bg, for windows until their page paints.
const background = () => (themes.get(themeId()) || themes.get(themes.DEFAULT)).bg;

function load() {
  let root = {};
  try { root = settings.readRoot(); } catch (e) { console.error("Could not read settings:", e.message); }
  const ui = isObj(root.ui) ? root.ui : {};
  if (LANGUAGES.includes(ui.language)) state.language = ui.language;
  if (THEMES.includes(ui.theme)) state.theme = ui.theme;
  // Before the handle, `hoverEdge` switched the invisible hover zone it replaces; its choice carries over.
  const handle = isObj(root.edgeHandle) ? root.edgeHandle : {};
  // Off by default outside Windows: a Wayland compositor places the handle's window itself (mid-screen), not at the edge.
  state.edgeHandle = typeof handle.show === "boolean" ? handle.show : process.platform === "win32" && root.hoverEdge !== false;
  handleX = fraction(handle.x) ?? handleX;
  handleDisplay = Number.isInteger(handle.display) ? handle.display : null;
  state.autoUpdate = ui.autoUpdate !== false;
  state.newWindow = !(isObj(root.terminal) && root.terminal.newWindow === false);
  // Sessions open in AgentDeck's own terminals unless the user chose Windows Terminal. Every save used to write the
  // setting, so a stored "windows" counts only once marked as chosen (sessionsInChosen, written since).
  const term = isObj(root.terminal) ? root.terminal : {};
  if (term.sessionsInChosen === true && SESSIONS_IN.includes(term.sessionsIn)) {
    state.sessionsIn = term.sessionsIn;
    sessionsInChosen = true;
  }
  const auto = isObj(root.terminal) && isObj(root.terminal.autoCompact) ? root.terminal.autoCompact : {};
  // A stored threshold counts only once the user has picked one (chosen): older versions wrote a default of 150000, and
  // were "on" at an unchosen or 1M threshold, which compacted nothing - those stay off.
  if (auto.chosen === true && AUTO_COMPACT_TOKENS.includes(auto.tokens)) {
    state.autoCompactTokens = auto.tokens;
    autoCompactTokensChosen = true;
    state.autoCompact = auto.on !== false;
  }
  if (TERMINAL_FONT_SIZES.includes(term.fontSize)) state.terminalFontSize = term.fontSize;
  if (UI_SCALES.includes(ui.scale)) state.uiScale = ui.scale;
  if (EDITORS.includes(ui.editor)) state.editor = ui.editor;
  if (isObj(root.git) && GIT_SCOPES.includes(root.git.scope)) state.gitScope = root.git.scope;
  state.dayView = isObj(root.dayView) && root.dayView.show === true;
  const taskbar = isObj(root.taskbarMonitor) ? root.taskbarMonitor : {};
  state.taskbarNet = taskbar.net !== false;
  state.taskbarCpu = taskbar.cpu !== false;
  state.taskbarMemory = taskbar.memory !== false;
  // Never on with nothing to show, nor outside Windows (there is no taskbar to lie on).
  state.taskbarMonitor = process.platform === "win32" && taskbar.show === true && TASKBAR_ITEMS.some(key => state[key]);
  state.agentLoad = ui.agentLoad !== false;
  // null: not saved here yet (main carries the earlier choice over).
  state.notify = isObj(root.notify) && typeof root.notify.on === "boolean" ? root.notify.on : null;
  i18n.setLanguage(state.language, { dev: !app.isPackaged });
  nativeTheme.themeSource = themeSource(state.theme);
  // Windows switched between light and dark while the theme follows it.
  nativeTheme.on("updated", () => prefs.emit("changed", get(), ["theme"]));
}

// Unknown values are ignored; resolves with the new snapshot once settings.json has it.
async function set(patch) {
  const keys = [];
  if (!isObj(patch)) return get();
  if (LANGUAGES.includes(patch.language) && patch.language !== state.language) {
    state.language = patch.language;
    i18n.setLanguage(state.language);
    keys.push("language");
  }
  if (THEMES.includes(patch.theme) && patch.theme !== state.theme) {
    state.theme = patch.theme;
    nativeTheme.themeSource = themeSource(state.theme);
    keys.push("theme");
  }
  if (typeof patch.edgeHandle === "boolean" && patch.edgeHandle !== state.edgeHandle) {
    state.edgeHandle = patch.edgeHandle;
    keys.push("edgeHandle");
  }
  if (typeof patch.autoUpdate === "boolean" && patch.autoUpdate !== state.autoUpdate) {
    state.autoUpdate = patch.autoUpdate;
    keys.push("autoUpdate");
  }
  if (typeof patch.newWindow === "boolean" && patch.newWindow !== state.newWindow) {
    state.newWindow = patch.newWindow;
    keys.push("newWindow");
  }
  if (SESSIONS_IN.includes(patch.sessionsIn) && patch.sessionsIn !== state.sessionsIn) {
    state.sessionsIn = patch.sessionsIn;
    sessionsInChosen = true;
    keys.push("sessionsIn");
  }
  if (typeof patch.autoCompact === "boolean" && patch.autoCompact !== state.autoCompact) {
    state.autoCompact = patch.autoCompact;
    autoCompactTokensChosen ||= patch.autoCompact;
    keys.push("autoCompact");
  }
  if (AUTO_COMPACT_TOKENS.includes(patch.autoCompactTokens) && patch.autoCompactTokens !== state.autoCompactTokens) {
    state.autoCompactTokens = patch.autoCompactTokens;
    autoCompactTokensChosen = true;
    keys.push("autoCompactTokens");
  }
  if (TERMINAL_FONT_SIZES.includes(patch.terminalFontSize) && patch.terminalFontSize !== state.terminalFontSize) {
    state.terminalFontSize = patch.terminalFontSize;
    keys.push("terminalFontSize");
  }
  if (UI_SCALES.includes(patch.uiScale) && patch.uiScale !== state.uiScale) {
    state.uiScale = patch.uiScale;
    keys.push("uiScale");
  }
  if (EDITORS.includes(patch.editor) && patch.editor !== state.editor) {
    state.editor = patch.editor;
    keys.push("editor");
  }
  if (GIT_SCOPES.includes(patch.gitScope) && patch.gitScope !== state.gitScope) {
    state.gitScope = patch.gitScope;
    keys.push("gitScope");
  }
  if (typeof patch.notify === "boolean" && patch.notify !== state.notify) {
    state.notify = patch.notify;
    keys.push("notify");
  }
  const change = (key, value) => {
    if (typeof value !== "boolean" || value === state[key]) return;
    state[key] = value;
    keys.push(key);
  };
  for (const key of TASKBAR_ITEMS) change(key, patch[key]);
  // Outside Windows the strip stays off whatever asks for it.
  change("taskbarMonitor", process.platform === "win32" ? patch.taskbarMonitor : false);
  if (state.taskbarMonitor && !TASKBAR_ITEMS.some(key => state[key])) {
    if (keys.includes("taskbarMonitor")) for (const key of TASKBAR_ITEMS) change(key, true);
    else change("taskbarMonitor", false);
  }
  change("agentLoad", patch.agentLoad);
  if (typeof patch.dayView === "boolean" && patch.dayView !== state.dayView) {
    state.dayView = patch.dayView;
    keys.push("dayView");
  }
  if (!keys.length) return get();
  prefs.emit("changed", get(), keys);
  await save();
  return get();
}

// Where the edge handle was dropped (0..1 across that display). Saved quietly: no "changed" event.
const handlePosition = () => handleX;
const handleDisplayId = () => handleDisplay;
function setHandlePosition(x, display) {
  const v = fraction(x);
  const id = Number.isInteger(display) ? display : handleDisplay;
  if (v === null || (v === handleX && id === handleDisplay)) return Promise.resolve();
  handleX = v;
  handleDisplay = id;
  return save();
}

// In effect at once; a file that cannot be written is only logged. `hoverEdge: undefined` drops the former key.
function save() {
  return settings.writeRoot({
    ui: { language: state.language, theme: state.theme, autoUpdate: state.autoUpdate, scale: state.uiScale, editor: state.editor, agentLoad: state.agentLoad },
    edgeHandle: { show: state.edgeHandle, x: Math.round(handleX * 10000) / 10000, display: handleDisplay ?? undefined },
    terminal: {
      newWindow: state.newWindow,
      sessionsIn: state.sessionsIn,
      sessionsInChosen: sessionsInChosen || undefined,
      fontSize: state.terminalFontSize,
      autoCompact: { on: state.autoCompact, tokens: state.autoCompactTokens, chosen: autoCompactTokensChosen || undefined }
    },
    dayView: { show: state.dayView },
    git: { scope: state.gitScope },
    notify: { on: state.notify !== false },
    taskbarMonitor: { show: state.taskbarMonitor, net: state.taskbarNet, cpu: state.taskbarCpu, memory: state.taskbarMemory },
    hoverEdge: undefined
  }).catch(e => console.error("Could not save settings:", e.message));
}

module.exports = Object.assign(prefs, { load, get, set, handlePosition, handleDisplayId, setHandlePosition, background, LANGUAGES, THEMES, SESSIONS_IN, TERMINAL_FONT_SIZES, UI_SCALES, EDITORS });
