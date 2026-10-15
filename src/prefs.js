// App-wide preferences: UI language, theme and automatic updates (`ui` in settings.json) and the edge menu's hover
// switch (`hoverEdge`). Main process only. Every page gets a snapshot from its preload ("prefs:get") and
// "prefs:changed" afterwards; i18n.js applies language and theme.
//
// events: "changed" (snapshot, keys) - keys lists what changed: "language", "theme", "hoverEdge", "autoUpdate".
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
const state = { language: "bg", theme: "dark", hoverEdge: true, autoUpdate: true };

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
  state.hoverEdge = root.hoverEdge !== false;
  state.autoUpdate = ui.autoUpdate !== false;
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
  if (typeof patch.hoverEdge === "boolean" && patch.hoverEdge !== state.hoverEdge) {
    state.hoverEdge = patch.hoverEdge;
    keys.push("hoverEdge");
  }
  if (typeof patch.autoUpdate === "boolean" && patch.autoUpdate !== state.autoUpdate) {
    state.autoUpdate = patch.autoUpdate;
    keys.push("autoUpdate");
  }
  if (!keys.length) return get();
  prefs.emit("changed", get(), keys);
  // In effect at once; a file that cannot be written is only logged.
  await settings.writeRoot({ ui: { language: state.language, theme: state.theme, autoUpdate: state.autoUpdate }, hoverEdge: state.hoverEdge })
    .catch(e => console.error("Could not save settings:", e.message));
  return get();
}

module.exports = Object.assign(prefs, { load, get, set, background, LANGUAGES, THEMES });
