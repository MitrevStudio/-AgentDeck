// The projects list "By device" (renderer.js): the same projects in one section per computer - this one first, then
// the paired ones (online first, then by name) - and a filter to the chosen computers. A view only: it reads the
// arranged list and never changes a project, a group or the order, and its state (mode, filter, folded sections)
// stays in this window's localStorage, so nothing of it reaches the registry or the mesh (mesh/layout.js).
// Plain data in and out; loaded as a page script before renderer.js, and by scripts/test-device-view.js via require.
const LOCAL_DEVICE = "local";
const DEVICE_MODES = ["none", "device"];
const deviceOf = p => p?.node || LOCAL_DEVICE;

// Every computer to show: this one, each paired node (main leaves out forgotten ones) and any computer a project still
// names that the nodes list does not (yet) have, as offline. nodes: [{ id, name, kind, status, lastSeen }].
function listDevices(projects, nodes) {
  const counts = new Map();
  for (const p of projects) counts.set(deviceOf(p), (counts.get(deviceOf(p)) || 0) + 1);
  const known = new Map();
  for (const n of nodes || []) {
    if (!n?.id || known.has(n.id)) continue;
    known.set(n.id, { id: n.id, local: false, name: n.name || n.id.slice(0, 8), kind: n.kind === "host" ? "host" : "desktop",
      status: n.status === "online" ? "online" : "offline", lastSeen: Number(n.lastSeen) || 0 });
  }
  for (const id of counts.keys()) {
    if (id !== LOCAL_DEVICE && !known.has(id)) known.set(id, { id, local: false, name: id.slice(0, 8), kind: "desktop", status: "offline", lastSeen: 0 });
  }
  const others = [...known.values()].sort((a, b) => (a.status === "online" ? 0 : 1) - (b.status === "online" ? 0 : 1)
    || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  const local = { id: LOCAL_DEVICE, local: true, name: "", kind: "desktop", status: "online", lastSeen: 0 };
  return [local, ...others].map(d => ({ ...d, count: counts.get(d.id) || 0 }));
}

// The chosen devices that exist; none (or only unknown ones) means every device.
function activeFilter(filter, devices) {
  const ids = new Set(devices.map(d => d.id));
  return (filter || []).filter(id => ids.has(id));
}
const toggleDeviceId = (list, id) => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
const toggleFilter = toggleDeviceId;
const toggleCollapsedDevice = toggleDeviceId;

// [{ device, projects }] in device order, each section's projects in the order given (pins, groups and the user's own
// order already applied); only the filtered devices when a filter is active.
function buildSections(projects, devices, filter) {
  const chosen = new Set(activeFilter(filter, devices));
  const by = new Map(devices.map(d => [d.id, []]));
  for (const p of projects) by.get(deviceOf(p))?.push(p);
  return devices.filter(d => !chosen.size || chosen.has(d.id)).map(d => ({ device: d, projects: by.get(d.id) }));
}
const countInSections = (projects, devices, filter) => buildSections(projects, devices, filter).reduce((n, s) => n + s.projects.length, 0);

// The stored view state, whatever was stored: { mode: "none" | "device", filter: [id], collapsed: [id] }.
function normalizeDeviceView(raw) {
  const ids = list => [...new Set((Array.isArray(list) ? list : []).filter(x => typeof x === "string" && x))];
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return { mode: DEVICE_MODES.includes(s.mode) ? s.mode : "none", filter: ids(s.filter), collapsed: ids(s.collapsed) };
}

// What the list shows. The toggle opens the chips (mode "device"); a chosen device filters the list, and the filter stays
// when the chips are closed - the toggle stays lit - until "All" clears it. Sections show while either is on.
function deviceViewState(view, devices) {
  const filter = activeFilter(view.filter, devices), picker = view.mode === "device";
  return { filter, picker, filtered: filter.length > 0, grouped: picker || filter.length > 0 };
}

if (typeof module === "object" && module.exports) {
  module.exports = { LOCAL_DEVICE, deviceOf, listDevices, activeFilter, toggleFilter, toggleCollapsedDevice, buildSections, countInSections, normalizeDeviceView, deviceViewState };
}
