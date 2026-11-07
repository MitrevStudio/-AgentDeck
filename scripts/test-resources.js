const assert = require('node:assert/strict');
const { createResources } = require('../src/host/resources');
const { createServed } = require('../src/mesh/serve');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');

(async () => {
  let idle = 50, user = 50, diskReads = 0;
  const monitor = createResources({ home: '/home/test', system: {
    cpus: () => [{ times: { idle, user } }], totalmem: () => 1000, freemem: () => 400, hostname: () => 'LOCAL',
  }, statfs: async () => { diskReads++; return { blocks: 100, bavail: 40, bsize: 10 }; } });
  assert.equal((await monitor.refresh()).cpu, null);
  idle += 25; user += 75;
  const sample = await monitor.refresh();
  assert.equal(sample.cpu, 75);
  assert.equal(sample.memory.used, 600);
  assert.equal(sample.disk.free, 400);
  assert.equal(diskReads, 1);
  const failedDisk = createResources({ statfs: async () => { throw Error('unavailable'); } });
  assert.equal((await failedDisk.refresh()).disk, null);

  const host = Object.assign(new EventEmitter(), { terminals: {}, sessions: {}, resources: monitor,
    limits: { get: () => ({ providers: {} }), refresh: async () => ({ providers: {} }) } });
  const served = createServed({ host });
  assert.equal(served.api('resources.get').cpu, 75);
  assert.deepEqual(served.api('limits.get'), { providers: {} });
  const events = [];
  served.attach({ on() {}, nodes: () => [], notifyAll: (name, data) => events.push({ name, data }) });
  host.emit('resources', sample); host.emit('limits', host.limits.get());
  assert.deepEqual(events.map(x => x.name), ['resources', 'limits']);

  const el = {}, callbacks = {};
  const manager = {
    onLimitsChanged: cb => { callbacks.limits = cb; },
    onResourcesChanged: cb => { callbacks.resources = cb; },
    onNodesChanged: cb => { callbacks.nodes = cb; },
    onDataChanged() {}, getData: async () => ({ agents: ['Claude', 'OpenCode'] }),
    getResources: async () => sample, getNodes: async () => [], getLimits: async () => null,
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../src/limits-ui.js'), 'utf8'), {
    window: { manager }, document: { querySelector: () => true }, $: () => el,
    t: k => k, esc: s => String(s).replaceAll('<', '&lt;'),
    I18N: { formatNumber: String, formatTime: String },
  });
  await new Promise(resolve => setImmediate(resolve));
  callbacks.nodes([{ name: 'REMOTE', status: 'online', data: { agents: ['Codex', 'OpenCode'] }, resources: sample,
    limits: { providers: { codex: { installed: true, windows: [{ util: 82, durationMins: 300 }] } } } }]);
  assert.match(el.innerHTML, /LOCAL/);
  assert.match(el.innerHTML, /REMOTE/);
  assert.match(el.innerHTML, /82%/);
  assert.match(el.innerHTML, /aria-label="CPU 75%"/);
  assert.match(el.innerHTML, /class="machine-providers"/);
  assert.match(el.innerHTML, /class="machine-resources"/);
  assert.doesNotMatch(el.innerHTML, /OpenCode/);
  callbacks.nodes([{ name: 'REMOTE', status: 'offline' }]);
  assert.match(el.innerHTML, /machine-status offline/);
  console.log('CPU/RAM/disk measurement, unavailable disk, mesh telemetry and per-computer footer OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
