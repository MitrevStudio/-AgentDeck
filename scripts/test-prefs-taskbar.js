// The taskbar strip and the sessions' load in prefs.js: the strip off until asked for and then showing all it can,
// never on with nothing to show, never on outside Windows; the sessions' CPU and memory on until switched off; what
// is saved, and what a change announces.
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

function strip() {
  const { taskbarMonitor: show, taskbarNet: net, taskbarCpu: cpu, taskbarMemory: memory } = prefs.get();
  return { show, net, cpu, memory };
}
function loadWith(taskbarMonitor, ui) {
  root = { ...(taskbarMonitor === undefined ? {} : { taskbarMonitor }), ...(ui ? { ui } : {}) };
  prefs.load();
  return strip();
}

(async () => {
  // Nothing stored, or nothing usable: off, and ready to show everything once switched on.
  const OFF = { show: false, net: true, cpu: true, memory: true };
  assert.deepEqual(loadWith(undefined), OFF);
  assert.deepEqual(loadWith("yes"), OFF);
  assert.deepEqual(loadWith({ show: "true", net: 1, cpu: null, memory: "on" }), OFF);
  // Stored: as stored - on Windows; elsewhere there is no taskbar to show it on.
  assert.deepEqual(loadWith({ show: true, net: false, cpu: true, memory: false }), { show: windows, net: false, cpu: true, memory: false });
  assert.deepEqual(loadWith({ show: true }), { show: windows, net: true, cpu: true, memory: true }, "on with nothing said of what it shows: all of it");
  // On with nothing to show (as the first build of the strip could save it): not on.
  assert.deepEqual(loadWith({ show: true, net: false, cpu: false, memory: false }), { show: false, net: false, cpu: false, memory: false });
  assert.equal(prefs.get().windows, windows);

  // The sessions' CPU and memory in the Agents list: on unless switched off.
  loadWith(undefined);
  assert.equal(prefs.get().agentLoad, true);
  loadWith(undefined, { agentLoad: false });
  assert.equal(prefs.get().agentLoad, false);
  loadWith(undefined, { agentLoad: "no" });
  assert.equal(prefs.get().agentLoad, true);

  loadWith(undefined);
  const changes = [];
  prefs.on("changed", (snapshot, keys) => changes.push({ keys: [...keys].sort(), show: snapshot.taskbarMonitor }));
  const before = () => ({ changes: changes.length, written: written.length });
  let mark;

  await prefs.set({ agentLoad: false });
  assert.deepEqual(changes.at(-1).keys, ["agentLoad"]);
  assert.equal(written.at(-1).ui.agentLoad, false);
  await prefs.set({ agentLoad: true });
  assert.equal(written.at(-1).ui.agentLoad, true);
  mark = before();
  await prefs.set({ agentLoad: true });
  await prefs.set({ agentLoad: "off" });
  assert.deepEqual(before(), mark, "the same value, or no switch: nothing announced, nothing written");

  if (windows) {
    // The main switch alone gives a strip that shows something at once.
    let snapshot = await prefs.set({ taskbarMonitor: true });
    assert.equal(snapshot.taskbarMonitor, true);
    assert.deepEqual(changes.at(-1), { keys: ["taskbarMonitor"], show: true });
    assert.deepEqual(written.at(-1).taskbarMonitor, { show: true, net: true, cpu: true, memory: true });
    await prefs.set({ taskbarNet: false, taskbarCpu: false });
    assert.deepEqual(changes.at(-1).keys, ["taskbarCpu", "taskbarNet"]);
    assert.deepEqual(written.at(-1).taskbarMonitor, { show: true, net: false, cpu: false, memory: true });
    // Unticking the last one switches the strip off: it is never on with nothing to show...
    await prefs.set({ taskbarMemory: false });
    assert.deepEqual(changes.at(-1), { keys: ["taskbarMemory", "taskbarMonitor"], show: false });
    assert.deepEqual(written.at(-1).taskbarMonitor, { show: false, net: false, cpu: false, memory: false });
    // ...and switching it on with none ticked ticks them all.
    await prefs.set({ taskbarMonitor: true });
    assert.deepEqual(changes.at(-1), { keys: ["taskbarCpu", "taskbarMemory", "taskbarMonitor", "taskbarNet"], show: true });
    assert.deepEqual(strip(), { show: true, net: true, cpu: true, memory: true });
    // The same value again, or something that is no switch: nothing announced, nothing written.
    mark = before();
    await prefs.set({ taskbarMonitor: true, taskbarNet: true });
    await prefs.set({ taskbarMonitor: "off", taskbarCpu: 1, taskbarMemory: null });
    assert.deepEqual(before(), mark);
    assert.equal(prefs.get().taskbarMonitor, true);
    await prefs.set({ taskbarCpu: false });
    // What was saved comes back the same.
    assert.deepEqual(loadWith(written.at(-1).taskbarMonitor), { show: true, net: true, cpu: false, memory: true });
  } else {
    // Elsewhere the strip cannot be switched on; what it would show is still kept.
    mark = before();
    assert.equal((await prefs.set({ taskbarMonitor: true })).taskbarMonitor, false);
    assert.deepEqual(before(), mark);
    await prefs.set({ taskbarCpu: false });
    assert.deepEqual(written.at(-1).taskbarMonitor, { show: false, net: true, cpu: false, memory: true });
    assert.deepEqual(loadWith({ show: true, net: true, cpu: false, memory: true }), { show: false, net: true, cpu: false, memory: true });
  }
  // Another setting leaves these alone.
  const kept = { ...strip(), agentLoad: prefs.get().agentLoad };
  await prefs.set({ dayView: true });
  assert.deepEqual({ ...strip(), agentLoad: prefs.get().agentLoad }, kept);
  assert.deepEqual(written.at(-1).taskbarMonitor, { show: kept.show, net: kept.net, cpu: kept.cpu, memory: kept.memory });
  console.log("prefs: the taskbar strip and the sessions' load OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
