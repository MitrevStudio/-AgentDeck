// The projects list's "By device" view (src/device-view.js): sections per computer, the device filter and the view
// state kept on this computer. Pure data in, pure data out - no DOM, no mesh.
const assert = require('node:assert/strict');
const dv = require('../src/device-view');

const A = 'a'.repeat(64), B = 'b'.repeat(64), H = 'c'.repeat(64), GONE = 'd'.repeat(64);
const nodes = [
  { id: B, name: 'Zeta laptop', kind: 'desktop', status: 'online', lastSeen: 1000 },
  { id: H, name: 'VPS', kind: 'host', status: 'offline', lastSeen: 500 },
  { id: A, name: 'Alpha desktop', kind: 'desktop', status: 'online', lastSeen: 900 },
];
// As renderer.js has them: arranged (pins, groups, order) - the view must keep this order inside each section.
const projects = [
  { n: 'p1', name: 'one', path: 'C:/one', group: 'g1' },
  { n: 'p2', name: 'two', path: '/srv/two', node: H },
  { n: 'p3', name: 'three', path: 'C:/three', node: B, group: 'g1' },
  { n: 'p4', name: 'four', path: 'C:/four' },
  { n: 'p5', name: 'five', path: 'C:/five', node: GONE },
  { n: 'p6', name: 'six', path: 'C:/six', node: B },
];
const snapshot = JSON.stringify(projects);

// ---------- devices ----------
const devices = dv.listDevices(projects, nodes);
assert.deepEqual(devices.map(d => d.id), [dv.LOCAL_DEVICE, A, B, GONE, H], "this computer first, then online by name, then offline by name (dddd… < VPS)");
assert.equal(devices[0].local, true);
assert.equal(devices[0].status, 'online');
assert.equal(devices[0].count, 2);
assert.equal(devices.find(d => d.id === B).count, 2);
assert.equal(devices.find(d => d.id === A).count, 0, 'a paired computer with no projects is still a device');
const vps = devices.find(d => d.id === H);
assert.equal(vps.kind, 'host');
assert.equal(vps.status, 'offline');
assert.equal(vps.lastSeen, 500, 'an offline device keeps when it was last seen');
const gone = devices.find(d => d.id === GONE);
assert.equal(gone.status, 'offline', 'a computer not in the nodes list counts as offline');
assert.equal(gone.name, GONE.slice(0, 8));
assert.equal(gone.lastSeen, 0);
assert.equal(dv.deviceOf(projects[0]), dv.LOCAL_DEVICE);
assert.equal(dv.deviceOf(projects[1]), H);
assert.deepEqual(dv.listDevices([], []).map(d => d.id), [dv.LOCAL_DEVICE], 'this computer is always there');

// ---------- sections ----------
let sections = dv.buildSections(projects, devices, []);
assert.deepEqual(sections.map(s => s.device.id), [dv.LOCAL_DEVICE, A, B, GONE, H]);
assert.deepEqual(sections[0].projects.map(p => p.n), ['p1', 'p4'], 'order inside a section is the list order');
assert.deepEqual(sections[2].projects.map(p => p.n), ['p3', 'p6']);
assert.equal(sections[2].projects[0].group, 'g1', 'groups stay on the projects, for getUnits inside the section');
assert.deepEqual(sections[1].projects, []);

// ---------- filter ----------
sections = dv.buildSections(projects, devices, [H, B]);
assert.deepEqual(sections.map(s => s.device.id), [B, H], 'only the chosen devices, in device order');
sections = dv.buildSections(projects, devices, [dv.LOCAL_DEVICE]);
assert.deepEqual(sections.map(s => s.device.id), [dv.LOCAL_DEVICE]);
sections = dv.buildSections(projects, devices, ['e'.repeat(64)]);
assert.equal(sections.length, devices.length, 'a filter naming only unknown devices shows everything');
assert.deepEqual(dv.activeFilter(['e'.repeat(64), H], devices), [H], 'unknown devices drop out of the active filter');
assert.deepEqual(dv.activeFilter([], devices), []);
assert.deepEqual(dv.toggleFilter([], H), [H]);
assert.deepEqual(dv.toggleFilter([H, B], H), [B]);
assert.deepEqual(dv.toggleFilter([H], B), [H, B]);
assert.equal(dv.countInSections(projects, devices, [H, B]), 3);
assert.equal(dv.countInSections(projects, devices, []), 6);

// ---------- view state (this computer only) ----------
assert.deepEqual(dv.normalizeDeviceView(null), { mode: 'none', filter: [], collapsed: [] });
assert.deepEqual(dv.normalizeDeviceView('garbage'), { mode: 'none', filter: [], collapsed: [] });
assert.deepEqual(dv.normalizeDeviceView({ mode: 'device', filter: [H, 7, H, ''], collapsed: [B, null] }), { mode: 'device', filter: [H], collapsed: [B] });
assert.deepEqual(dv.normalizeDeviceView({ mode: 'weird' }).mode, 'none');

// The toggle opens and closes the chips; the filter outlives a closed picker (the toggle stays lit and the list stays
// in sections) until "All" clears it.
{
  const devices = dv.listDevices(projects, nodes);
  const state = view => dv.deviceViewState(dv.normalizeDeviceView(view), devices);
  assert.deepEqual(state({}), { filter: [], picker: false, filtered: false, grouped: false });
  assert.deepEqual(state({ mode: 'device' }), { filter: [], picker: true, filtered: false, grouped: true });
  assert.deepEqual(state({ mode: 'device', filter: [B] }), { filter: [B], picker: true, filtered: true, grouped: true });
  assert.deepEqual(state({ mode: 'none', filter: [B] }), { filter: [B], picker: false, filtered: true, grouped: true }, 'closing the picker keeps the filter');
  assert.deepEqual(state({ mode: 'none', filter: ['e'.repeat(64)] }), { filter: [], picker: false, filtered: false, grouped: false }, 'a device no longer known filters nothing');
}
assert.deepEqual(dv.toggleCollapsedDevice([B], B), []);
assert.deepEqual(dv.toggleCollapsedDevice([], B), [B]);

// ---------- strings: every manager.devices.* key the window uses is in both languages ----------
const fs = require('node:fs');
const path = require('node:path');
const src = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const used = new Set(src('renderer.js').match(/manager\.devices\.\w+/g).concat(src('index.html').match(/manager\.devices\.\w+/g) || []));
assert.ok(used.size >= 10, 'the renderer uses the device view strings');
const strings = src('i18n.js');
for (const key of used) assert.equal(strings.split(`"${key}":`).length - 1, 2, `${key} in English and Bulgarian`);
// The view state is the window's own: nothing of it may go to main (and from there to layout.sync).
const renderer = src('renderer.js');
const viewCode = renderer.slice(renderer.indexOf('// ---------- projects by device'), renderer.indexOf('function renderOrderToggle('));
assert.ok(viewCode.length > 0);
assert.doesNotMatch(viewCode, /window\.manager/, 'the device view never calls main');

// The view never touches the projects it is given: manual groups and order stay as they are.
assert.equal(JSON.stringify(projects), snapshot, 'the device view must not change projects, groups or order');
console.log('Device view: devices, sections, filter and local view state OK');
