// Auto-compact in prefs.js: what a stored setting turns into, and turning the switch on.
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

let root = {};
const written = [];
const stubs = {
  electron: { app: { isPackaged: true, getPath: () => "" }, nativeTheme: { shouldUseDarkColors: false, on: () => {} } },
  [path.join(__dirname, "../src/voice/settings.js")]: { readRoot: () => root, writeRoot: patch => { written.push(patch); return Promise.resolve(); } }
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return stubs.electron;
  const file = parent && request.startsWith(".") ? path.join(path.dirname(parent.filename), request) : request;
  return stubs[file] || stubs[`${file}.js`] || load.call(this, request, parent, isMain);
};
const prefs = require("../src/prefs");

function loadWith(autoCompact) {
  root = { terminal: { autoCompact } };
  prefs.load();
  const { autoCompact: on, autoCompactTokens: tokens } = prefs.get();
  return { on, tokens };
}

// load() sets only what is stored, so the cases run from nothing stored up.
// Nothing stored: off, at 150k.
assert.deepEqual(loadWith(undefined), { on: false, tokens: 150000 });
// "On" with no threshold picked, or at the removed 1M, compacted nothing: it stays off.
assert.deepEqual(loadWith({ on: true, tokens: 150000 }), { on: false, tokens: 150000 });
assert.deepEqual(loadWith({ on: true, tokens: 1000000, chosen: true }), { on: false, tokens: 150000 });
// A threshold the user picked keeps working, on or off.
assert.deepEqual(loadWith({ on: true, tokens: 300000, chosen: true }), { on: true, tokens: 300000 });
assert.deepEqual(loadWith({ on: false, tokens: 300000, chosen: true }), { on: false, tokens: 300000 });

// Switched on: saved with its threshold marked chosen, so it is still on after a restart.
(async () => {
  await prefs.set({ autoCompact: true });
  assert.deepEqual(written.at(-1).terminal.autoCompact, { on: true, tokens: 300000, chosen: true });
  console.log("prefs auto-compact migration OK");
})();
