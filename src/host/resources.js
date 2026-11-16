// Whole-computer measurements, never the Electron process's CPU/memory alone.
const os = require('node:os');
const fs = require('node:fs');

function createResources({ home = os.homedir(), onChange = () => {}, system = os, statfs = fs.promises.statfs,
  network = () => null, interval = 5000 } = {}) {
  let previous = null, current = null, timer = null, flight = null, disk = null, diskAt = 0, netPrevious = null;
  // network(): the computer's traffic counters ({ rx, tx, adapters: { id: { rx, tx } } } in bytes since boot,
  // net-counters.js), passed only by who shows traffic. Traffic since the last sample, in bytes a second; the
  // counters themselves too (bytes since boot), for whoever adds them up. null without a source; no rate on the
  // first sample.
  // Each adapter is compared with itself: one that came up since the last sample (Wi-Fi joining, a cable plugged
  // in, a VPN) brings all its bytes since boot with it, which are not this second's traffic - it counts from the
  // next sample on, and so does one whose counters went back (a reset). Without the adapters (a source that gives
  // sums only), a sum that went back gives no rate.
  function traffic() {
    let now = null;
    try { now = network(); } catch {}
    if (!now) { netPrevious = null; return null; }
    const at = Date.now(), last = netPrevious, seconds = last ? (at - last.at) / 1000 : 0;
    netPrevious = { at, rx: now.rx, tx: now.tx, adapters: now.adapters || null };
    const out = (rx, tx) => ({ rx, tx, rxBytes: now.rx, txBytes: now.tx });
    if (!last || seconds <= 0) return out(null, null);
    if (!now.adapters || !last.adapters) {
      const ok = now.rx >= last.rx && now.tx >= last.tx;
      return out(ok ? (now.rx - last.rx) / seconds : null, ok ? (now.tx - last.tx) / seconds : null);
    }
    let rx = 0, tx = 0;
    for (const [id, a] of Object.entries(now.adapters)) {
      const b = last.adapters[id];
      if (!b || a.rx < b.rx || a.tx < b.tx) continue;
      rx += a.rx - b.rx;
      tx += a.tx - b.tx;
    }
    return out(rx / seconds, tx / seconds);
  }
  async function sample() {
    const cpus = system.cpus();
    const times = cpus.reduce((a, c) => {
      a.idle += c.times.idle;
      a.total += Object.values(c.times).reduce((x, y) => x + y, 0);
      return a;
    }, { idle: 0, total: 0 });
    const delta = previous && times.total - previous.total;
    const cpu = delta > 0 ? Math.max(0, Math.min(100, 100 * (1 - (times.idle - previous.idle) / delta))) : null;
    previous = times;
    if (Date.now() - diskAt >= 60000) {
      try {
        const d = await statfs(home);
        disk = { path: home, total: d.blocks * d.bsize, free: d.bavail * d.bsize };
      } catch { disk = null; }
      diskAt = Date.now();
    }
    const total = system.totalmem(), free = system.freemem();
    current = { at: Date.now(), name: system.hostname(), cpu, cores: cpus.length,
      memory: { total, free, used: total - free }, disk, net: traffic() };
    onChange(current);
    return current;
  }
  function refresh() {
    if (!flight) flight = sample().finally(() => { flight = null; });
    return flight;
  }
  return { get: () => current, refresh,
    start() { if (!timer) { refresh().catch(() => {}); timer = setInterval(() => refresh().catch(() => {}), interval); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; }
  };
}
module.exports = { createResources };
