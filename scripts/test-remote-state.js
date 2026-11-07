const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const read = name => fs.readFileSync(require('node:path').join(__dirname, '../src', name), 'utf8');
const common = read('common.js');
const sandbox = vm.createContext({
  window: { manager: { onNodesChanged() {}, getNodes: () => Promise.resolve([]) } },
  setInterval() {},
  t: key => key, esc: String,
  fmtTokens: String, I18N: { formatNumber: String, formatTime: String },
});
vm.runInContext(common.match(/const sessionKey = .*;/)[0], sandbox);
vm.runInContext(read('nodes-ui.js'), sandbox);
vm.runInContext(read('usage-ui.js'), sandbox);
vm.runInContext(`
  const local = { agent: 'Claude', id: 'same', status: 'idle' };
  const distant = { ...local, status: 'busy' };
  nodes = [{ id: 'peer', name: 'DEV-01', data: { sessions: [distant] },
    liveMap: new Map([[sessionKey(distant), distant]]),
    usage: { at: 100, sessions: [{ key: 'Claude:same', context: { tokens: 123, window: 1000, warmUntil: 0 } }] } }];
  const merged = mergeNodes({ sessions: [local] }, new Map([[sessionKey(local), local]]));
  globalThis.result = {
    size: merged.live.size,
    local: merged.live.get(sessionKey(local)).status,
    remote: merged.live.get(sessionKey(merged.raw.sessions[1])).status,
    remoteChip: getContextChip({ ...distant, node: 'peer' }),
    localChip: getContextChip(local),
  };
`, sandbox);
assert.equal(sandbox.result.size, 2);
assert.equal(sandbox.result.local, 'idle');
assert.equal(sandbox.result.remote, 'busy');
assert.match(sandbox.result.remoteChip, /data-ctx-node="peer"/);
assert.equal(sandbox.result.localChip, '');

const { createServed } = require('../src/mesh/serve');
const host = Object.assign(new EventEmitter(), {
  terminals: {}, launch: {}, sessions: {}, liveSessions: () => [], git: {}, setup: {},
  usage: { get: () => ({ sessions: [{ key: 'Claude:same', context: { tokens: 123 } }] }) },
});
const served = createServed({ host });
assert.equal(served.api('usage.get').sessions[0].context.tokens, 123);
let pushed;
served.attach({ notifyAll: (name, data) => { pushed = { name, data }; }, on() {}, nodes: () => [] });
host.emit('usage', host.usage.get());
assert.equal(pushed.name, 'usage');
assert.equal(pushed.data.sessions[0].context.tokens, 123);
console.log('Remote live isolation, context ownership, initial usage and usage updates OK');
