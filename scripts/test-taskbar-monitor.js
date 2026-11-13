// The taskbar monitor's measurements: the rate resources.js makes of the traffic counters, today's total, and what
// the strip is sent.
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { BrowserWindow: class {}, screen: {}, ipcMain: {}, systemPreferences: {}, app: { isPackaged: true } };
  return load.call(this, request, parent, isMain);
};
const { createResources } = require("../src/host/resources");
const { createDayTraffic, device } = require("../src/taskbar-monitor");

(async () => {
  // The rate: none on the first sample, bytes a second after it, none when a counter went back.
  const system = { cpus: () => [{ times: { idle: 1, user: 1 } }], totalmem: () => 1000, freemem: () => 400, hostname: () => "PC" };
  const statfs = async () => ({ blocks: 1, bavail: 1, bsize: 1 });
  let counters = { rx: 1000, tx: 500 };
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const monitor = createResources({ system, statfs, network: () => counters });
    assert.deepEqual((await monitor.refresh()).net, { rx: null, tx: null, rxBytes: 1000, txBytes: 500 });
    now += 2000; counters = { rx: 5000, tx: 1500 };
    assert.deepEqual((await monitor.refresh()).net, { rx: 2000, tx: 500, rxBytes: 5000, txBytes: 1500 });
    now += 1000; counters = { rx: 10, tx: 1600 };
    assert.deepEqual((await monitor.refresh()).net, { rx: null, tx: null, rxBytes: 10, txBytes: 1600 });
    now += 1000; counters = null;
    assert.equal((await monitor.refresh()).net, null);
    // No source given (the mesh's own sampler): no traffic, and the counters are never read.
    assert.equal((await createResources({ system, statfs }).refresh()).net, null);
    const failing = createResources({ system, statfs, network: () => { throw Error("no table"); } });
    assert.equal((await failing.refresh()).net, null);
  } finally { Date.now = realNow; }

  // Today's total: adds what passed between samples, skips a counter reset, survives a restart.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-taskbar-")), "traffic.json");
  const today = createDayTraffic(file);
  today.add({ rxBytes: 100, txBytes: 10 });
  today.add({ rxBytes: 400, txBytes: 30 });
  assert.deepEqual(today.get(), { rx: 300, tx: 20 });
  today.add({ rxBytes: 5, txBytes: 5 });    // the computer's counters started over
  today.add({ rxBytes: 25, txBytes: 6 });
  assert.deepEqual(today.get(), { rx: 320, tx: 21 });
  today.add(null);                           // no source for a while: nothing is added across the gap
  today.add({ rxBytes: 9000, txBytes: 9000 });
  assert.deepEqual(today.get(), { rx: 320, tx: 21 });
  today.pause();
  assert.deepEqual(createDayTraffic(file).get(), { rx: 320, tx: 21 });
  fs.writeFileSync(file, JSON.stringify({ day: "2000-01-01", rx: 7, tx: 7 }));
  assert.deepEqual(createDayTraffic(file).get(), { rx: 0, tx: 0 });

  // What the strip gets: the figures only, and nothing known before the first sample.
  const sample = { name: "PC", cpu: 12.5, memory: { used: 600, total: 1000, free: 400 }, net: { rx: 1, tx: 2, rxBytes: 9, txBytes: 9 } };
  assert.deepEqual(device(sample), { cpu: 12.5, memory: { used: 600, total: 1000 }, net: { rx: 1, tx: 2 } });
  assert.deepEqual(device({ cpu: null, memory: { used: 0, total: 0 }, net: null }), { cpu: null, memory: null, net: null });
  assert.deepEqual(device(null), { cpu: null, memory: null, net: null });
  console.log("Traffic rates, today's total and the taskbar strip's data OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
