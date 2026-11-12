// The taskbar monitor in prefs.js: off until asked for, what it shows, what is saved, and what a change announces.
const assert = require("node:assert/strict");
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
const windows = process.platform === "win32";

function loadWith(taskbarMonitor) {
  root = taskbarMonitor === undefined ? {} : { taskbarMonitor };
  prefs.load();
  const { taskbarMonitor: show, taskbarNet: net, taskbarCpu: cpu, taskbarMemory: memory } = prefs.get();
  return { show, net, cpu, memory };
}

(async () => {
  // Nothing stored: off, and nothing chosen to show - each only once asked for.
  const NONE = { show: false, net: false, cpu: false, memory: false };
  assert.deepEqual(loadWith(undefined), NONE);
  assert.deepEqual(loadWith("yes"), NONE);
  assert.deepEqual(loadWith({ show: "true", net: 1, cpu: null, memory: "on" }), NONE);
  // Stored: as stored - on Windows; elsewhere there is no taskbar to show it on.
  assert.deepEqual(loadWith({ show: true, net: false, cpu: true, memory: false }), { show: windows, net: false, cpu: true, memory: false });
  assert.equal(prefs.get().windows, windows);

  // A change is announced with its key and saved with the rest of the strip's settings.
  loadWith(undefined);
  const changes = [];
  prefs.on("changed", (snapshot, keys) => changes.push({ keys, show: snapshot.taskbarMonitor, net: snapshot.taskbarNet }));
  let snapshot = await prefs.set({ taskbarMonitor: true });
  assert.equal(snapshot.taskbarMonitor, true);
  assert.deepEqual(changes.at(-1), { keys: ["taskbarMonitor"], show: true, net: false });
  assert.deepEqual(written.at(-1).taskbarMonitor, { show: true, net: false, cpu: false, memory: false });
  snapshot = await prefs.set({ taskbarNet: true, taskbarCpu: true });
  assert.deepEqual(changes.at(-1).keys.sort(), ["taskbarCpu", "taskbarNet"]);
  assert.deepEqual(written.at(-1).taskbarMonitor, { show: true, net: true, cpu: true, memory: false });
  await prefs.set({ taskbarCpu: false, taskbarMemory: true });
  assert.deepEqual(written.at(-1).taskbarMonitor, { show: true, net: true, cpu: false, memory: true });
  // The same value again, or something that is no switch: nothing announced, nothing written.
  const before = { changes: changes.length, written: written.length };
  await prefs.set({ taskbarMonitor: true, taskbarNet: true });
  await prefs.set({ taskbarMonitor: "off", taskbarCpu: 1, taskbarMemory: null });
  assert.deepEqual({ changes: changes.length, written: written.length }, before);
  assert.equal(prefs.get().taskbarMonitor, true);
  // What was saved comes back the same.
  const saved = written.at(-1).taskbarMonitor;
  assert.deepEqual(loadWith(saved), { show: windows, net: true, cpu: false, memory: true });
  // Another setting leaves the strip's alone.
  await prefs.set({ dayView: true });
  assert.deepEqual(written.at(-1).taskbarMonitor, { show: windows, net: true, cpu: false, memory: true });
  console.log("prefs taskbar monitor OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
