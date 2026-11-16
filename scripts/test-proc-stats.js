const assert = require('node:assert/strict');
const { createProcStats, createWindowsQuery, linuxQuery } = require('../src/host/proc-stats');

(async () => {
  // The share of the whole computer: 2 s of processor over 4 s on 2 cores is 25%.
  let clock = 0, cpuMs = 1000;
  const asked = [];
  const stats = createProcStats({
    now: () => clock, cores: () => 2, totalmem: () => 1200 * 1048576, interval: 5000,
    query: async pids => { asked.push(pids); return new Map([[42, { cpuMs, mem: 300 * 1048576 }]]); }
  });
  const list = [{ agent: 'Claude', id: 'a', pid: 42 }, { agent: 'Claude', id: 'b', pid: 0 }];
  assert.deepEqual(stats.attach(list), list, 'nothing measured yet');
  await stats.refresh([42]);
  assert.deepEqual(asked, [[42]], 'a PID of 0 is not asked for');
  let out = stats.attach(list);
  assert.deepEqual(out[0].proc, { cpu: null, mem: 300 * 1048576, memShare: 25 }, 'no processor share on the first measurement');
  assert.equal(stats.attach(list, () => false)[0].proc, undefined, "a PID that is not its agent's own process gets nothing");
  assert.equal(out[1].proc, undefined);
  assert.equal(list[0].proc, undefined, 'the list given is left as it was');

  clock = 2000; cpuMs = 2000;
  await stats.refresh([42]);
  assert.equal(asked.length, 1, 'not measured again within the interval');
  clock = 5000;
  await stats.refresh([42]);
  assert.equal(stats.get(42).cpu, 10, '1 s over 5 s on 2 cores');
  clock = 10000; cpuMs = 1000;
  await stats.refresh([42]);
  assert.equal(stats.get(42).cpu, null, 'a counter that went back (another process with the PID) gives no share');

  const failing = createProcStats({ now: () => 0, query: async () => null });
  await failing.refresh([1]);
  assert.equal(failing.get(1), null);

  // The real thing, on this process.
  const query = process.platform === 'win32' ? createWindowsQuery({ idleMs: 1000 }) : process.platform === 'linux' ? linuxQuery : null;
  if (query) {
    const real = await query([process.pid]);
    const me = real.get(process.pid);
    assert.ok(me, 'this process is measured');
    assert.ok(me.mem > 1048576, `memory ${me.mem}`);
    assert.ok(me.cpuMs >= 0, `processor time ${me.cpuMs}`);
    const again = await query([process.pid, 999999999]);
    assert.equal(again.size, 1, 'a PID that is not running is left out');
    query.stop?.();
  }
  console.log('proc-stats ok');
})().catch(e => { console.error(e); process.exit(1); });
