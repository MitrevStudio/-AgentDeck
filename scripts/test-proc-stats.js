// The Claude sessions' CPU and memory (src/proc-stats.js): what a figure adds up, when it is measured - only when
// asked, at most every interval, later and later after a failure - and that reading it starts no process on Windows
// and Linux.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Every process started from here on, before proc-stats.js takes its own references.
const started = [];
for (const name of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync']) {
  const real = childProcess[name];
  childProcess[name] = function (...args) { started.push(`${name} ${args[0]}`); return real.apply(this, args); };
}
const { createProcStats, createSessionLoad, windowsQuery, linuxQuery, parsePs } = require('../src/proc-stats');
const MB = 1048576;

(async () => {
  // ---------- what a figure is ----------
  // A session's own process and the ones it started, added up. 2 cores, 1200 MB: 1 s of processor over 5 s is 10%.
  let clock = 0, trees = new Map(), fail = false;
  const asked = [];
  const stats = createProcStats({
    now: () => clock, cores: () => 2, totalmem: () => 1200 * MB, interval: 5000, maxBackoff: 60000,
    query: async pids => { asked.push(pids); if (fail) throw new Error('no'); return trees; }
  });
  const sessions = [{ key: 'Claude:a', pids: [42, 77] }, { key: 'Claude:b', pids: [50] }, { key: 'Claude:gone', pids: [0, 60] }];
  trees = new Map([[42, [{ pid: 42, start: '1', cpuMs: 1000, mem: 200 * MB }, { pid: 43, start: '2', cpuMs: 500, mem: 100 * MB }]], [50, [{ pid: 50, start: '1', cpuMs: 9000, mem: 60 * MB }]]]);
  let out = await stats.read(sessions);
  assert.deepEqual(asked, [[42, 77, 50, 60]], 'every PID once, none that is no PID');
  assert.deepEqual(out, {
    'Claude:a': { cpu: null, mem: 300 * MB, memShare: 25, procs: 2 }, 'Claude:b': { cpu: null, mem: 60 * MB, memShare: 5, procs: 1 }
  }, 'no processor share on the first measurement; a session whose process is not running has no figures');

  // Within the interval: the last figures, nothing measured.
  clock = 2000;
  assert.deepEqual(await stats.read(sessions), out);
  assert.deepEqual(await stats.read([sessions[1]]), { 'Claude:b': out['Claude:b'] }, 'only what was asked for');
  assert.equal(asked.length, 1);

  // 5 s later: the child used 1 s more, a process started meanwhile used 0.5 s, the background job (77) appeared.
  clock = 5000;
  trees = new Map([[42, [{ pid: 42, start: '1', cpuMs: 1000, mem: 200 * MB }, { pid: 43, start: '2', cpuMs: 1500, mem: 100 * MB }, { pid: 44, start: '3', cpuMs: 500, mem: 50 * MB }]],
    [77, [{ pid: 77, start: '4', cpuMs: 500, mem: 250 * MB }]], [50, [{ pid: 50, start: '1', cpuMs: 9000, mem: 60 * MB }]]]);
  out = await stats.read(sessions);
  assert.deepEqual(out['Claude:a'], { cpu: 20, mem: 600 * MB, memShare: 50, procs: 4 }, '2 s over 5 s on 2 cores');
  assert.equal(out['Claude:b'].cpu, 0, 'an idle session takes nothing');
  // A child that ended takes its time with it - never a negative share; a PID given out again starts from nothing.
  clock = 10000;
  trees = new Map([[42, [{ pid: 42, start: '1', cpuMs: 1000, mem: 200 * MB }, { pid: 44, start: '9', cpuMs: 100, mem: 50 * MB }]]]);
  out = await stats.read(sessions);
  assert.deepEqual(out, { 'Claude:a': { cpu: 1, mem: 250 * MB, memShare: 250 / 12, procs: 2 } });
  // A measurement long ago (the list was out of view meanwhile) is no measure of now: no share, then one again.
  clock = 100000;
  assert.equal((await stats.read(sessions))['Claude:a'].cpu, null);
  clock = 105000;
  assert.equal((await stats.read(sessions))['Claude:a'].cpu, 0);

  // ---------- a measurement that fails ----------
  // Tried again later and later, never every few seconds; nothing stale is shown meanwhile.
  fail = true;
  const before = asked.length, tries = [];
  for (clock = 110000; clock <= 110000 + 10 * 60000; clock += 1000) {
    const n = asked.length;
    assert.deepEqual(await stats.read(sessions), {});
    if (asked.length > n) tries.push((clock - 110000) / 1000);
  }
  assert.deepEqual(tries, [0, 10, 30, 70, 130, 190, 250, 310, 370, 430, 490, 550], 'the wait doubles up to maxBackoff');
  assert.equal(asked.length - before, tries.length);
  fail = false;
  clock += 60000;
  assert.equal((await stats.read(sessions))['Claude:a'].cpu, null, 'measured again once it works');
  // Nothing to measure with (an unknown platform), or nothing asked: nothing done.
  assert.deepEqual(await createProcStats({ query: null }).read(sessions), {});
  assert.equal(createProcStats({ query: null }).available, false);
  const n = asked.length;
  assert.deepEqual(await stats.read([]), {});
  assert.equal(asked.length, n);

  // ---------- only while someone is looking ----------
  // main.js answers the manager window through this: nothing is read and nothing measured unless wanted().
  let wanted = false, listed = 0;
  const measured = [];
  const live = [
    { agent: 'Claude', id: 's1', pid: 42, jobs: [{ id: 'j1', pid: 77 }] },
    { agent: 'Codex', id: 'c1', pid: 900 },    // its PID is its terminal's
    { agent: 'Claude', id: 's0', pid: 0 }
  ];
  const load = createSessionLoad({
    sessions: async () => { listed++; return live; }, wanted: () => wanted,
    stats: createProcStats({ interval: 0, query: async pids => { measured.push(pids); return new Map([[42, [{ pid: 42, start: '1', cpuMs: 1, mem: MB }]]]); } })
  });
  assert.equal(await load(), null);
  assert.deepEqual([listed, measured.length], [0, 0], 'out of view or switched off: nothing listed, nothing measured');
  wanted = true;
  assert.deepEqual(Object.keys(await load()), ['Claude:s1']);
  assert.deepEqual(measured, [[42, 77]], "Claude sessions only, each with its background jobs' processes");
  wanted = false;
  assert.equal(await load(), null);
  assert.equal(measured.length, 1);
  assert.equal(await createSessionLoad({ sessions: async () => live, wanted: () => true, stats: createProcStats({ query: null }) })(), null);

  // ---------- Linux: /proc, as files ----------
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-proc-'));
  try {
    const put = (pid, parent, utime, stime, start, kb, name = 'node') => {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${name}) S ${parent} ${pid} ${pid} 0 -1 4194560 100 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615\n`);
      fs.writeFileSync(path.join(proc, String(pid), 'status'), `Name:\t${name}\nVmPeak:\t  999 kB\nVmRSS:\t  ${kb} kB\n`);
    };
    put(1, 0, 5, 5, 1, 1000, 'init');
    put(100, 1, 200, 100, 50, 2048, 'claude');
    put(101, 100, 30, 20, 60, 1024, 'a (b) c');   // a name with parentheses and spaces
    put(102, 101, 1, 0, 70, 512);
    put(200, 1, 7, 0, 80, 4096);
    fs.mkdirSync(path.join(proc, 'self'));
    fs.writeFileSync(path.join(proc, 'uptime'), '1 1\n');
    const tree = linuxQuery([100, 200, 999], proc);
    assert.deepEqual([...tree.keys()], [100, 200], 'a PID that is not running is left out');
    assert.deepEqual(tree.get(100), [
      { pid: 100, start: '50', cpuMs: 3000, mem: 2048 * 1024 }, { pid: 101, start: '60', cpuMs: 500, mem: 1024 * 1024 }, { pid: 102, start: '70', cpuMs: 10, mem: 512 * 1024 }
    ], 'the process, its child and its grandchild');
    assert.deepEqual(tree.get(200).map(p => p.pid), [200]);
  } finally { fs.rmSync(proc, { recursive: true, force: true }); }

  // ---------- macOS: ps's listing ----------
  const ps = parsePs('    1     0   0:05.10   1024\n  100     1   1:02.50   2048\n  101   100 1-00:00:01.00    512\n  300     1   0:00.00     16\nnot a line\n');
  assert.deepEqual(ps.all.get(100), { pid: 100, start: '', cpuMs: 62500, mem: 2048 * 1024 });
  assert.equal(ps.all.get(101).cpuMs, (86400 + 1) * 1000);
  assert.deepEqual(ps.children.get(100), [101]);

  // ---------- the real thing ----------
  // This process and a child of it, measured in this process: no helper is started (the child below is the test's).
  const real = process.platform === 'win32' ? windowsQuery : process.platform === 'linux' ? linuxQuery : null;
  if (real) {
    const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => { for (let i = 0; i < 3e7; i++); }, 20)'], { stdio: 'ignore', windowsHide: true });
    try {
      await new Promise(r => setTimeout(r, 600));
      const from = started.length;
      const mine = real([process.pid, 999999999]);
      assert.deepEqual([...mine.keys()], [process.pid]);
      const tree = mine.get(process.pid);
      // (Windows gives a console program a console host of its own: a third process, the child's child.)
      assert.ok(tree.some(p => p.pid === child.pid) && tree.length <= 3, `this process and its child (${tree.length})`);
      assert.equal(tree[0].pid, process.pid);
      for (const p of tree) {
        assert.ok(p.mem > MB && p.mem < 4096 * MB, `memory ${p.mem}`);
        assert.ok(p.cpuMs >= 0 && p.cpuMs < 3600000, `processor time ${p.cpuMs}`);
      }
      assert.ok(Math.abs(tree[0].mem - process.memoryUsage().rss) < 64 * MB, 'the working set Node itself reports');
      // The share of the computer, through the whole of it: the child is busy, so the session is not at zero.
      const whole = createProcStats({ interval: 0 }), me = [{ key: 'k', pids: [process.pid] }];
      assert.equal((await whole.read(me)).k.cpu, null);
      await new Promise(r => setTimeout(r, 1000));
      const figures = (await whole.read(me)).k;
      assert.ok(figures.procs >= 2);
      assert.ok(figures.cpu > 0 && figures.cpu <= 100, `share ${figures.cpu}`);
      assert.ok(figures.memShare > 0 && figures.memShare < 100);
      assert.deepEqual(started.slice(from), [], 'measuring starts no process');
    } finally { child.kill(); }
  }
  console.log('proc-stats ok');
})().catch(e => { console.error(e); process.exit(1); });
