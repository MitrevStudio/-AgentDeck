// App-wide preferences: UI language, theme and automatic updates (`ui` in settings.json), the edge handle
// (`edgeHandle`: shown or not, and where), and where sessions open (`terminal`): in Windows Terminal - a window of
// their own or a tab of the last one - or in AgentDeck's own tabs (`sessionsIn`).
// Main process only. Every page gets a snapshot from its preload ("prefs:get") and "prefs:changed" afterwards;
// i18n.js applies language and theme. The handle's position is not in the snapshot: it changes with a drag, which no
// page needs to hear about.
//
// events: "changed" (snapshot, keys) - keys lists what changed: "language", "theme", "edgeHandle", "autoUpdate",
// "newWindow", "sessionsIn", "autoCompact", "autoCompactTokens".
const { app, nativeTheme } = require("electron");
const { EventEmitter } = require("node:events");
const settings = require("./voice/settings");
const i18n = require("./i18n");
const { isObj } = require("./voice/util");

const LANGUAGES = Object.keys(i18n.LANGUAGES);
const THEMES = ["system", "dark", "light"];
const SESSIONS_IN = ["windows", "tabs"];
// Context sizes from which a session in an AgentDeck tab is remembered and compacted (autopilot.js).
const AUTO_COMPACT_TOKENS = [100000, 150000, 200000, 300000];
// --bg of theme.css, for windows until their page paints.
const BACKGROUND = { dark: "#0d1015", light: "#f2f4f8" };

const prefs = new EventEmitter();
const state = { language: "bg", theme: "dark", edgeHandle: true, autoUpdate: true, newWindow: true, sessionsIn: "windows", autoCompact: true, autoCompactTokens: 150000, dayView: false };
let handleX = 0.5; // the edge handle's centre, as a fraction of the display width
const fraction = v => (typeof v === "number" && v >= 0 && v <= 1 ? v : null);

// themeSource also gives native title bars and dialogs the chosen look; "system" follows Windows.
const resolvedTheme = () => (nativeTheme.shouldUseDarkColors ? "dark" : "light");
const get = () => ({ ...state, resolvedTheme: resolvedTheme(), dev: !app.isPackaged });
const background = () => BACKGROUND[resolvedTheme()];

function load() {
  let root = {};
  try { root = settings.readRoot(); } catch (e) { console.error("Could not read settings:", e.message); }
  const ui = isObj(root.ui) ? root.ui : {};
  if (LANGUAGES.includes(ui.language)) state.language = ui.language;
  if (THEMES.includes(ui.theme)) state.theme = ui.theme;
  // Before the handle, `hoverEdge` switched the invisible hover zone it replaces; its choice carries over.
  const handle = isObj(root.edgeHandle) ? root.edgeHandle : {};
  state.edgeHandle = typeof handle.show === "boolean" ? handle.show : root.hoverEdge !== false;
  handleX = fraction(handle.x) ?? handleX;
  state.autoUpdate = ui.autoUpdate !== false;
  state.newWindow = !(isObj(root.terminal) && root.terminal.newWindow === false);
  if (isObj(root.terminal) && SESSIONS_IN.includes(root.terminal.sessionsIn)) state.sessionsIn = root.terminal.sessionsIn;
  const auto = isObj(root.terminal) && isObj(root.terminal.autoCompact) ? root.terminal.autoCompact : {};
  state.autoCompact = auto.on !== false;
  if (AUTO_COMPACT_TOKENS.includes(auto.tokens)) state.autoCompactTokens = auto.tokens;
  state.dayView = isObj(root.dayView) && root.dayView.show === true;
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
  if (typeof patch.dayView === "boolean" && patch.dayView !== state.dayView) {
    state.dayView = patch.dayView;
    keys.push("dayView");
  }
  if (!keys.length) return get();
  prefs.emit("changed", get(), keys);
  await save();
  return get();
}

// Where the edge handle was dropped (0..1 across the display). Saved quietly: no "changed" event.
const handlePosition = () => handleX;
function setHandlePosition(x) {
  const v = fraction(x);
  if (v === null || v === handleX) return Promise.resolve();
  handleX = v;
  return save();
}

// In effect at once; a file that cannot be written is only logged. `hoverEdge: undefined` drops the former key.
function save() {
  return settings.writeRoot({
    ui: { language: state.language, theme: state.theme, autoUpdate: state.autoUpdate },
    edgeHandle: { show: state.edgeHandle, x: Math.round(handleX * 10000) / 10000 },
    terminal: {
      newWindow: state.newWindow,
      sessionsIn: state.sessionsIn,
      autoCompact: { on: state.autoCompact, tokens: state.autoCompactTokens }
    },
    dayView: { show: state.dayView },
    hoverEdge: undefined
  }).catch(e => console.error("Could not save settings:", e.message));
}

module.exports = Object.assign(prefs, { load, get, set, handlePosition, setHandlePosition, background, LANGUAGES, THEMES, SESSIONS_IN, AUTO_COMPACT_TOKENS });
