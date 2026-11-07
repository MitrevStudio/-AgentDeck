// Whole-computer measurements, never the Electron process's CPU/memory alone.
const os = require('node:os');
const fs = require('node:fs');

function createResources({ home = os.homedir(), onChange = () => {}, system = os, statfs = fs.promises.statfs } = {}) {
  let previous = null, current = null, timer = null, flight = null, disk = null, diskAt = 0;
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
      memory: { total, free, used: total - free }, disk };
    onChange(current);
    return current;
  }
  function refresh() {
    if (!flight) flight = sample().finally(() => { flight = null; });
    return flight;
  }
  return { get: () => current, refresh,
    start() { if (!timer) { refresh().catch(() => {}); timer = setInterval(() => refresh().catch(() => {}), 5000); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; }
  };
}
module.exports = { createResources };
