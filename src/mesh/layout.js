// Replicated project presentation, separate from host-owned files and sessions.
// Lamport stamps make offline edits converge without relying on wall clocks.
const fs = require("node:fs");
const path = require("node:path");
const { writeSync } = require("../shared/atomic-file");
const { normPath } = require("../shared/util");
const { keyOf } = require("../host/registry");
const ID = /^[a-f0-9]{64}$/;
const newer = (a, b) => !b || a.clock > b.clock || (a.clock === b.clock && a.actor > b.actor);
function createLayout({ links, registry }) {
  let state = null, file, clock = 0, applying = false;
  const owner = () => links.self?.()?.id;
  const key = p => `${p.node || owner()}:${normPath(p.path)}`;
  function ensure() {
    if (state || !owner()) return Boolean(state);
    file = path.join(links.identity().dir, "project-layout.json");
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw e; state = {}; }
    for (const r of Object.values(state)) clock = Math.max(clock, r.clock || 0);
    if (!Object.keys(state).length) {
      const initial = registry.read();
      for (const p of initial.projects) put("project:" + key(p), { node: p.node || owner(), path: p.path, name: p.name, ...(p.group ? { group: p.group } : {}), ...(Number.isInteger(p.pin) ? { pin: p.pin } : {}) });
      if (initial.groups?.length) put("groups", initial.groups);
      if (initial.order === "custom") put("order", { mode: "custom", keys: initial.projects.map(key) });
      persist();
    }
    return true;
  }
  const persist = () => writeSync(file, JSON.stringify(state));
  const put = (k, value) => { state[k] = { clock: ++clock, actor: owner(), value }; };
  function apply(data) {
    if (!ensure()) return data;
    const allowed = new Set([owner(), ...links.nodes().map(n => n.id)]);
    const removed = id => state[`node:${id}`]?.value === true;
    const entries = new Map(data.projects.map(p => [key(p), p]));
    for (const [k, r] of Object.entries(state)) {
      if (!k.startsWith("project:")) continue;
      const v = r.value;
      if (!v || !allowed.has(v.node) || removed(v.node)) continue;
      const id = k.slice(8);
      if (v.hidden) {
        const old = entries.get(id);
        if (old && !data.removed.includes(keyOf(old))) data.removed.push(keyOf(old));
        entries.delete(id);
      } else {
        const item = { ...(entries.get(id) || {}), path: v.path, name: v.name };
        if (v.node !== owner()) item.node = v.node;
        else delete item.node;
        for (const field of ["group", "pin"]) {
          if (v[field] !== undefined) item[field] = v[field]; else delete item[field];
        }
        entries.set(id, item);
        data.removed = data.removed.filter(x => x !== keyOf(item));
      }
    }
    data.projects = [...entries.values()].filter(p => {
      if (!removed(p.node || owner())) return true;
      if (!data.removed.includes(keyOf(p))) data.removed.push(keyOf(p));
      return false;
    });
    if (state.groups) data.groups = structuredClone(state.groups.value);
    if (state.order) {
      data.order = state.order.value.mode;
      const ranks = new Map(state.order.value.keys.map((k, i) => [k, i]));
      data.projects.sort((a, b) => (ranks.get(key(a)) ?? Infinity) - (ranks.get(key(b)) ?? Infinity));
    }
    return data;
  }
  // The layout is the computers' business: kept in step between the ones that may see each other (links.js sees), never
  // sent to a relay or a resource host, nor to a phone, and taken only from them.
  function publish() { persist(); links.notifyAll("layout.sync", state, { phones: false }); links.emit("layout"); }
  function capture(before, after) {
    if (applying || !ensure()) return;
    const old = new Map(before.projects.map(p => [key(p), p]));
    const next = new Map(after.projects.map(p => [key(p), p]));
    const value = p => ({ node: p.node || owner(), path: p.path, name: p.name, ...(p.group ? { group: p.group } : {}), ...(Number.isInteger(p.pin) ? { pin: p.pin } : {}) });
    for (const [id, p] of next) if (JSON.stringify(value(p)) !== JSON.stringify(old.has(id) ? value(old.get(id)) : null)) put(`project:${id}`, value(p));
    for (const [id, p] of old) if (!next.has(id)) put(`project:${id}`, { ...value(p), hidden: true });
    if (JSON.stringify(before.groups) !== JSON.stringify(after.groups)) put("groups", after.groups || []);
    if (before.order !== after.order || JSON.stringify([...old.keys()]) !== JSON.stringify([...next.keys()])) {
      const known = new Set(next.keys());
      put("order", { mode: after.order || "activity", keys: [...next.keys(), ...(state.order?.value.keys || []).filter(k => !known.has(k))] });
    }
    publish();
  }
  function reconcile() {
    if (applying || !ensure()) return;
    const data = registry.read(), before = JSON.stringify(data);
    apply(data);
    if (JSON.stringify(data) !== before) {
      applying = true;
      try { registry.save(data); links.emit("layout"); } finally { applying = false; }
    }
  }
  function valid(k, r) {
    if (!r || !Number.isSafeInteger(r.clock) || r.clock < 0 || r.clock > Number.MAX_SAFE_INTEGER - 100000 || !ID.test(r.actor)) return false;
    const v = r.value;
    if (k.startsWith("node:")) return ID.test(k.slice(5)) && typeof v === "boolean";
    if (k === "order") return v && ["custom", "activity"].includes(v.mode) && Array.isArray(v.keys) && v.keys.length <= 10000 && v.keys.every(x => typeof x === "string" && x.length <= 4200);
    if (k === "groups") return Array.isArray(v) && v.length <= 1000 && v.every(g => g && typeof g.id === "string" && g.id.length <= 64 && typeof g.name === "string" && g.name.length <= 1000 && (g.pin === undefined || Number.isInteger(g.pin) && g.pin >= 0));
    return k.startsWith("project:") && v && ID.test(v.node) && typeof v.path === "string" && v.path.length > 0 && v.path.length <= 4096 && k === `project:${v.node}:${normPath(v.path)}` && typeof v.name === "string" && v.name.length <= 1000 && (v.group === undefined || typeof v.group === "string" && v.group.length <= 64) && (v.pin === undefined || Number.isInteger(v.pin) && v.pin >= 0);
  }
  links.on("event", ({ node, name, data }) => {
    if (name !== "layout.sync" || !links.sees(node, { phones: false }) || !data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length > 20000 || !ensure()) return;
    let changed = false;
    for (const [k, r] of Object.entries(data)) if (valid(k, r) && newer(r, state[k])) {
      state[k] = r; clock = Math.max(clock, r.clock); changed = true;
    }
    if (changed) { publish(); reconcile(); }
  });
  links.on("link", ({ node, up }) => {
    if (!up || !ensure()) return;
    reconcile();
    if (links.sees(node, { phones: false })) links.notify(node, "layout.sync", state);
  });
  return { apply, capture, reconcile,
    isRemoved(id) { return ensure() && state[`node:${id}`]?.value === true; },
    removeNode(id) { if (!ID.test(id) || !ensure()) return; put(`node:${id}`, true); publish(); reconcile(); },
    restoreNode(id) { if (!ensure() || !state[`node:${id}`]?.value) return; put(`node:${id}`, false); publish(); reconcile(); }
  };
}
module.exports = { createLayout };
