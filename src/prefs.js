// App-wide preferences: UI language, theme and automatic updates (`ui` in settings.json), the edge handle
// (`edgeHandle`: shown or not, and where) and whether sessions open in a terminal window of their own (`terminal`).
// Main process only. Every page gets a snapshot from its preload ("prefs:get") and "prefs:changed" afterwards;
// i18n.js applies language and theme. The handle's position is not in the snapshot: it changes with a drag, which no
// page needs to hear about.
//
// events: "changed" (snapshot, keys) - keys lists what changed: "language", "theme", "edgeHandle", "autoUpdate",
// "newWindow".
const { app, nativeTheme } = require("electron");
const { EventEmitter } = require("node:events");
const settings = require("./voice/settings");
const i18n = require("./i18n");
const { isObj } = require("./voice/util");

const LANGUAGES = Object.keys(i18n.LANGUAGES);
const THEMES = ["system", "dark", "light"];
// --bg of theme.css, for windows until their page paints.
const BACKGROUND = { dark: "#0d1015", light: "#f2f4f8" };

const prefs = new EventEmitter();
const state = { language: "bg", theme: "dark", edgeHandle: true, autoUpdate: true, newWindow: true };
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
    terminal: { newWindow: state.newWindow },
    hoverEdge: undefined
  }).catch(e => console.error("Could not save settings:", e.message));
}

module.exports = Object.assign(prefs, { load, get, set, handlePosition, setHandlePosition, background, LANGUAGES, THEMES });
