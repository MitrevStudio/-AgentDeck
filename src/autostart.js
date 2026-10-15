// Start with Windows: a Run entry for the installed app, started with --autostart so it comes up in the tray without
// the manager window. A copy run from source never gets one - the entry would start electron.exe without the app.
// On by default for installed builds: the first run of a version that has the switch turns it on once and remembers
// that it did (`startup` in settings.json), so turning it off sticks.
const { app } = require("electron");
const settings = require("./voice/settings");
const { isObj } = require("./voice/util");

const ARG = "--autostart";

const supported = () => app.isPackaged && process.platform === "win32";
const startedAtLogin = () => process.argv.includes(ARG);

// {supported, enabled}. Off in Task Manager's Startup list counts as off: Windows would not start it.
function state() {
  if (!supported()) return { supported: false, enabled: false };
  const s = app.getLoginItemSettings({ args: [ARG] });
  return { supported: true, enabled: Boolean(s.openAtLogin && s.executableWillLaunchAtLogin) };
}

function set(on) {
  if (!supported()) return state();
  // `enabled` also clears a "Disabled" left in Task Manager's Startup list, which would otherwise win.
  app.setLoginItemSettings({ openAtLogin: Boolean(on), enabled: Boolean(on), args: [ARG] });
  return state();
}

// Once per profile, and only for the installed app (a run from source must not use up the default).
async function applyDefault() {
  if (!supported()) return;
  const root = settings.readRoot();
  if (isObj(root.startup) && root.startup.defaultApplied) return;
  set(true);
  await settings.writeRoot({ startup: { defaultApplied: true } });
}

module.exports = { state, set, applyDefault, startedAtLogin, ARG };
