// What a host publishes of its running sessions holds nothing that changes by itself: peers and phones are pushed
// "live" when a session's state changes, not on every round while one merely runs - and listing the sessions starts
// no process and measures nothing (a headless host has nobody to show CPU and memory to).
//
// A real host (createHost) over a home of its own with one Claude session registered in it - this process, which is
// kept busy so that its CPU time and memory move - served to a fake link that counts what it is sent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-live-push-'));
process.env.HOME = process.env.USERPROFILE = home; // host/live.js reads ~/.claude/sessions
const started = [];
for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
  const real = childProcess[name];
  childProcess[name] = function (...args) { started.push(`${name} ${args[0]}`); return real.apply(this, args); };
}
const { createHost } = require('../src/host');
const { createServed } = require('../src/mesh/serve');

const wait = ms => new Promise(r => setTimeout(r, ms));
const burn = ms => { const until = Date.now() + ms; let x = []; while (Date.now() < until) x.push(new Array(2000).fill(1)); return x.length; };

(async () => {
  assert.equal(os.homedir(), home);
  const registry = path.join(home, '.claude', 'sessions'), entry = path.join(registry, `${process.pid}.json`);
  fs.mkdirSync(registry, { recursive: true });
  const write = status => fs.writeFileSync(entry, JSON.stringify({ pid: process.pid, sessionId: 's-live', cwd: home, status, startedAt: 1, updatedAt: 1 }));
  write('idle');

  const host = createHost({ dataDir: path.join(home, 'data'), home, isExcluded: () => false, untitled: () => 'Untitled', noLauncher: () => '' });
  try {
    // The list as it goes out: the same, byte for byte, however often it is asked for while the session only runs.
    const first = await host.liveAgents();
    assert.deepEqual(first.map(l => [l.agent, l.id, l.pid, l.status]), [['Claude', 's-live', process.pid, 'idle']]);
    const sigs = new Set([JSON.stringify(first)]);
    for (let i = 0; i < 6; i++) {
      burn(250); await wait(350);
      sigs.add(JSON.stringify(await host.liveAgents()));
    }
    assert.equal(sigs.size, 1, 'the list of an idle session does not change');
    assert.ok(!('proc' in (await host.liveAgents())[0]), 'no process figures in what peers get');

    // And so the peers: one push for the list, none while nothing happens, one when the state changes.
    const pushes = [];
    const served = createServed({ host, liveMs: 100 });
    served.attach({ on() {}, self: () => ({ id: 'me', name: 'WORK-01' }), sees: () => true, notify() {}, nodes: () => [{ id: 'peer', name: 'StudioPc', status: 'online' }],
      notifyAll: (name, data) => { if (name === 'live') pushes.push(data); } });
    for (let i = 0; i < 5; i++) { burn(150); await wait(250); }
    assert.equal(pushes.length, 1, `pushed once for the list, not on every round (${pushes.length})`);
    write('busy');
    await wait(1500); // the next round after the kept answer (host/shared-read.js) is too old
    assert.equal(pushes.length, 2, 'a change of state is pushed');
    assert.equal(pushes[1][0].status, 'busy');
    for (let i = 0; i < 3; i++) { burn(150); await wait(250); }
    assert.equal(pushes.length, 2);

    assert.deepEqual(started, [], 'listing the sessions starts no process');
    console.log('live list: stable while sessions only run, pushed on change, no process started OK');
  } finally {
    host.stop();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  process.exit(0); // the served host's timers and the host's own files are not this test's to wait for
})().catch(e => { console.error(e); process.exit(1); });
