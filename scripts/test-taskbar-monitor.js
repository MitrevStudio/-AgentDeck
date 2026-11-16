// The taskbar monitor's measurements and place: the rate resources.js makes of the traffic counters (each adapter by
// itself, so one coming up is no burst of traffic), what the strip is sent, and where it goes - nowhere, unless a
// taskbar stays along the bottom edge.
const assert = require("node:assert/strict");
const Module = require("node:module");

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { BrowserWindow: class {}, screen: {}, ipcMain: {}, nativeTheme: {}, systemPreferences: {}, app: { isPackaged: true } };
  return load.call(this, request, parent, isMain);
};
const { createResources } = require("../src/host/resources");
const { device, place } = require("../src/taskbar-monitor");

(async () => {
  const system = { cpus: () => [{ times: { idle: 1, user: 1 } }], totalmem: () => 1000, freemem: () => 400, hostname: () => "WORK-01" };
  const statfs = async () => ({ blocks: 1, bavail: 1, bsize: 1 });
  let counters = { rx: 1000, tx: 500 };
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    // Sums only: no rate on the first sample, bytes a second after it, none when a sum went back.
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

    // Each adapter by itself (net-counters.js gives them): the set of adapters that are up changes, and one coming
    // up brings all its bytes since boot with it.
    const GB = 2 ** 30;
    const sum = adapters => ({ rx: Object.values(adapters).reduce((a, x) => a + x.rx, 0), tx: Object.values(adapters).reduce((a, x) => a + x.tx, 0), adapters });
    let table = sum({ ethernet: { rx: 10 * GB, tx: 2 * GB } });
    const net = createResources({ system, statfs, network: () => table });
    const rates = async () => { const n = (await net.refresh()).net; return [n.rx, n.tx]; };
    assert.deepEqual(await rates(), [null, null]);
    now += 1000; table = sum({ ethernet: { rx: 10 * GB + 3000, tx: 2 * GB + 1000 } });
    assert.deepEqual(await rates(), [3000, 1000]);
    // Wi-Fi comes up with 49 GB behind it: this second's traffic is still the cable's alone...
    now += 1000; table = sum({ ethernet: { rx: 10 * GB + 5000, tx: 2 * GB + 1500 }, wifi: { rx: 49 * GB, tx: 7 * GB } });
    assert.deepEqual(await rates(), [2000, 500], "an adapter that came up is no burst of traffic");
    // ...and from the next sample on, both count.
    now += 1000; table = sum({ ethernet: { rx: 10 * GB + 6000, tx: 2 * GB + 1500 }, wifi: { rx: 49 * GB + 4000, tx: 7 * GB + 100 } });
    assert.deepEqual(await rates(), [5000, 100]);
    // The cable is pulled: what is left counts, nothing goes missing or negative.
    now += 1000; table = sum({ wifi: { rx: 49 * GB + 4500, tx: 7 * GB + 100 } });
    assert.deepEqual(await rates(), [500, 0]);
    // An adapter whose counters went back (reset) sits one sample out; the others count.
    now += 2000; table = sum({ ethernet: { rx: 100, tx: 100 }, wifi: { rx: 10, tx: 10 } });
    assert.deepEqual(await rates(), [0, 0]);
    now += 2000; table = sum({ ethernet: { rx: 2100, tx: 100 }, wifi: { rx: 10, tx: 4010 } });
    assert.deepEqual(await rates(), [1000, 2000]);
    // No adapter up at all: nothing passes.
    now += 1000; table = sum({});
    assert.deepEqual(await rates(), [0, 0]);
  } finally { Date.now = realNow; }

  // The real counters, where there are any: every adapter's add up to the sums.
  const real = require("../src/host/net-counters").read();
  if (real) {
    const of = key => Object.values(real.adapters).reduce((a, x) => a + x[key], 0);
    assert.deepEqual([of("rx"), of("tx")], [real.rx, real.tx]);
  } else assert.notEqual(process.platform, "win32", "Windows gives its interface table");

  // What the strip gets: the figures only, and nothing known before the first sample.
  const sample = { name: "WORK-01", cpu: 12.5, memory: { used: 600, total: 1000, free: 400 }, net: { rx: 1, tx: 2, rxBytes: 9, txBytes: 9 } };
  assert.deepEqual(device(sample), { cpu: 12.5, memory: { used: 600, total: 1000 }, net: { rx: 1, tx: 2 } });
  assert.deepEqual(device({ cpu: null, memory: { used: 0, total: 0 }, net: null }), { cpu: null, memory: null, net: null });
  assert.deepEqual(device(null), { cpu: null, memory: null, net: null });

  // ---------- where the strip goes (stubbed rectangles, in DIPs) ----------
  const display = { x: 0, y: 0, width: 1707, height: 960 };
  const bar = { x: 0, y: 912, width: 1707, height: 48 }, tray = { x: 1492, y: 912, width: 215, height: 48 };
  // Along the bottom: as tall as the taskbar, ending where the tray begins, as wide as its text.
  assert.deepEqual(place({ bar, tray, autoHide: false }, display, 190), { x: 1492 - 6 - 190, y: 912, width: 190, height: 48 });
  // No wider than a third of the taskbar; not narrower than a sliver; the usual tray's room when Windows names none.
  assert.equal(place({ bar, tray, autoHide: false }, display, 5000).width, 569);
  assert.equal(place({ bar, tray, autoHide: false }, display, 0).width, 40);
  assert.equal(place({ bar, tray: null, autoHide: false }, display, 190).x, 1707 - 330 - 6 - 190);
  // A second display below or beside the first: by that display's own bottom edge.
  const second = { x: 1707, y: 200, width: 1280, height: 720 };
  assert.deepEqual(place({ bar: { x: 1707, y: 880, width: 1280, height: 40 }, tray: { x: 2800, y: 880, width: 187, height: 40 }, autoHide: false }, second, 150),
    { x: 2800 - 6 - 150, y: 880, width: 150, height: 40 });
  // Nowhere - never the bottom of the screen over whatever is there:
  assert.equal(place(null, display, 190), null, "no taskbar (Explorer is not running)");
  assert.equal(place({ bar, tray, autoHide: true }, display, 190), null, "a taskbar that hides itself, even while it is out");
  assert.equal(place({ bar: { ...bar, y: 958 }, tray: { ...tray, y: 958 }, autoHide: true }, display, 190), null, "hidden: two pixels left on the screen (Windows 10)");
  assert.equal(place({ bar: { ...bar, y: 958 }, tray: { ...tray, y: 958 }, autoHide: false }, display, 190), null, "slid out of the screen, whatever the setting says");
  assert.equal(place({ bar: { ...bar, y: 960 }, tray, autoHide: false }, display, 190), null);
  assert.equal(place({ bar: { x: 0, y: 0, width: 1707, height: 48 }, tray: { x: 1492, y: 0, width: 215, height: 48 }, autoHide: false }, display, 190), null, "along the top (Windows 10)");
  assert.equal(place({ bar: { x: 0, y: 0, width: 62, height: 960 }, tray: { x: 0, y: 800, width: 62, height: 160 }, autoHide: false }, display, 190), null, "on the left");
  assert.equal(place({ bar: { x: 1645, y: 0, width: 62, height: 960 }, tray: null, autoHide: false }, display, 190), null, "on the right");
  assert.equal(place({ bar, tray, autoHide: false }, null, 190), null);
  console.log("Traffic rates per adapter, the strip's data and its place OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
