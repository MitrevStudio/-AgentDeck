const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createLayout } = require('../src/mesh/layout');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-sync-'));
const ids = ['a', 'b', 'c'].map(x => x.repeat(64));
const machines = [], queue = [];
function machine(i) {
  const links = new EventEmitter(), id = ids[i], dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  let data = { projects: [{ path: `C:/project${i}`, name: `P${i}` }], removed: [], groups: [], order: 'activity' };
  const registry = { read: () => structuredClone(data), save: d => { data = structuredClone(d); } };
  links.self = () => ({ id }); links.identity = () => ({ dir });
  links.nodes = () => ids.filter(x => x !== id).map(id => ({ id }));
  links.notify = (to, name, value) => queue.push({ from: id, to, name, data: structuredClone(value) });
  links.notifyAll = (name, value) => ids.filter(x => x !== id).forEach(to => links.notify(to, name, value));
  const m = { id, links, registry, online: true };
  m.layout = createLayout({ links, registry });
  m.edit = f => { const before = registry.read(), after = structuredClone(before); f(after); m.layout.capture(before, after); registry.save(after); };
  machines.push(m); return m;
}
function flush() {
  let count = 0;
  while (queue.length) {
    assert.ok(++count < 1000, 'no synchronization echo loop');
    const e = queue.shift(), m = machines.find(x => x.id === e.to);
    if (m?.online) m.links.emit('event', { node: e.from, name: e.name, data: e.data });
  }
}
try {
  const [a, b, c] = [machine(0), machine(1), machine(2)];
  for (const m of machines) m.layout.reconcile();
  for (const m of machines) for (const id of ids) if (id !== m.id) m.links.emit('link', { node: id, up: true });
  flush();
  assert.equal(a.registry.read().projects.length, 3);
  a.edit(d => { d.projects.reverse(); d.order = 'custom'; d.groups = [{ id: 'g', name: 'Work' }]; d.projects[0].group = 'g'; }); flush();
  assert.deepEqual(b.registry.read().projects.map(p => p.name), a.registry.read().projects.map(p => p.name));
  assert.equal(c.registry.read().groups[0].name, 'Work');
  c.online = false;
  a.edit(d => { d.projects.find(p => p.name === 'P0').name = 'A edit'; });
  b.edit(d => { d.projects.find(p => p.name === 'P1').name = 'B edit'; }); flush();
  assert.ok(a.registry.read().projects.some(p => p.name === 'B edit'));
  assert.ok(b.registry.read().projects.some(p => p.name === 'A edit'));
  a.layout.removeNode(c.id); flush();
  assert.ok(!b.registry.read().projects.some(p => p.node === c.id));
  assert.equal(c.registry.read().projects.length, 3, 'offline node retains its last view');
  c.online = true; a.links.emit('link', { node: c.id, up: true }); flush();
  assert.ok(!c.registry.read().projects.some(p => !p.node), 'offline owner receives durable removal');
  const stored = JSON.parse(fs.readFileSync(path.join(root, a.id, 'project-layout.json')));
  assert.equal(stored[`node:${c.id}`].value, true);
  b.links.removeAllListeners();
  b.layout = createLayout({ links: b.links, registry: b.registry });
  b.layout.reconcile();
  assert.ok(!b.registry.read().projects.some(p => p.node === c.id), "removal survives restart");
  a.layout.restoreNode(c.id); flush();
  assert.equal(c.registry.read().projects.filter(p => !p.node).length, 1);
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');
  const toggle = src.match(/async function toggleOrder\(\) \{[\s\S]*?\n\}/)[0];
  const saved = ['B', 'A'];
  const ctx = { raw: { registry: { order: 'activity' } }, window: { manager: { restoreProjectOrder: async () => ({ order: 'custom', projects: saved }), arrangeProjects: () => { throw new Error('overwrote saved order'); } } }, applyRegistry: r => { ctx.result = r; } };
  vm.runInNewContext(toggle + '\nglobalThis.done = toggleOrder();', ctx);
  ctx.done.then(() => { assert.deepEqual(ctx.result.projects, saved); console.log('layout sync and custom-order restoration passed'); }).catch(e => { console.error(e); process.exitCode = 1; });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
