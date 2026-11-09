// App-wide preferences: UI language, theme and automatic updates (`ui` in settings.json), the edge handle
// (`edgeHandle`: shown or not, and where), and where sessions open (`terminal`): in Windows Terminal - a window of
// their own or a tab of the last one - or in AgentDeck's own terminals (`sessionsIn`, the default).
// Main process only. Every page gets a snapshot from its preload ("prefs:get") and "prefs:changed" afterwards;
// i18n.js applies language and theme. The handle's position is not in the snapshot: it changes with a drag, which no
// page needs to hear about.
//
// events: "changed" (snapshot, keys) - keys lists what changed: "language", "theme", "edgeHandle", "autoUpdate",
// "newWindow", "sessionsIn", "autoCompact", "autoCompactTokens", "terminalFontSize", "uiScale".
const { app, nativeTheme } = require("electron");
const { EventEmitter } = require("node:events");
const settings = require("./voice/settings");
const i18n = require("./i18n");
const { isObj } = require("./shared/util");

const LANGUAGES = Object.keys(i18n.LANGUAGES);
const THEMES = ["system", "dark", "light"];
const SESSIONS_IN = ["windows", "tabs"];
// Context sizes from which a session in an AgentDeck tab is remembered and compacted (autopilot.js).
const AUTO_COMPACT_TOKENS = [100000, 150000, 200000, 300000];
// The text of AgentDeck's own terminals, px before the window's scale; the manager window's scale (its zoom). The
// defaults: 16 px text at 100%.
const TERMINAL_FONT_SIZES = [11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24];
const UI_SCALES = [0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
// --bg of theme.css, for windows until their page paints.
const BACKGROUND = { dark: "#0d1015", light: "#f2f4f8" };

const prefs = new EventEmitter();
const state = { language: "bg", theme: "dark", edgeHandle: process.platform === "win32", autoUpdate: true, newWindow: true, sessionsIn: "tabs", autoCompact: true, autoCompactTokens: 150000, dayView: false, notify: null, terminalFontSize: 16, uiScale: 1 };
let sessionsInChosen = false; // the user picked where sessions open (settings or the tray menu)
let handleX = 0.5; // the edge handle's centre, as a fraction of the display width
let handleDisplay = null; // the id of the display it is on (null: the primary one)
const fraction = v => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);

// themeSource also gives native title bars and dialogs the chosen look; "system" follows Windows.
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
// With the choices the pages offer (the lists above), so none keeps a copy of them.
const get = () => ({ ...state, resolvedTheme: resolvedTheme(), dev: !app.isPackaged, terminalFontSizes: TERMINAL_FONT_SIZES, uiScales: UI_SCALES });
const background = () => BACKGROUND[resolvedTheme()];

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
  state.autoCompact = auto.on !== false;
  if (AUTO_COMPACT_TOKENS.includes(auto.tokens)) state.autoCompactTokens = auto.tokens;
  if (TERMINAL_FONT_SIZES.includes(term.fontSize)) state.terminalFontSize = term.fontSize;
  if (UI_SCALES.includes(ui.scale)) state.uiScale = ui.scale;
  state.dayView = isObj(root.dayView) && root.dayView.show === true;
  // null: not saved here yet (main carries the earlier choice over).
  state.notify = isObj(root.notify) && typeof root.notify.on === "boolean" ? root.notify.on : null;
  i18n.setLanguage(state.language, { dev: !app.isPackaged });
  nativeTheme.themeSource = state.theme;
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
    nativeTheme.themeSource = state.theme;
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
    keys.push("autoCompact");
  }
  if (AUTO_COMPACT_TOKENS.includes(patch.autoCompactTokens) && patch.autoCompactTokens !== state.autoCompactTokens) {
    state.autoCompactTokens = patch.autoCompactTokens;
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
  if (typeof patch.notify === "boolean" && patch.notify !== state.notify) {
    state.notify = patch.notify;
    keys.push("notify");
  }
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
    ui: { language: state.language, theme: state.theme, autoUpdate: state.autoUpdate, scale: state.uiScale },
    edgeHandle: { show: state.edgeHandle, x: Math.round(handleX * 10000) / 10000, display: handleDisplay ?? undefined },
    terminal: {
      newWindow: state.newWindow,
      sessionsIn: state.sessionsIn,
      sessionsInChosen: sessionsInChosen || undefined,
      fontSize: state.terminalFontSize,
      autoCompact: { on: state.autoCompact, tokens: state.autoCompactTokens }
    },
    dayView: { show: state.dayView },
    notify: { on: state.notify !== false },
    hoverEdge: undefined
  }).catch(e => console.error("Could not save settings:", e.message));
}

module.exports = Object.assign(prefs, { load, get, set, handlePosition, handleDisplayId, setHandlePosition, background, LANGUAGES, THEMES, SESSIONS_IN, AUTO_COMPACT_TOKENS, TERMINAL_FONT_SIZES, UI_SCALES });
