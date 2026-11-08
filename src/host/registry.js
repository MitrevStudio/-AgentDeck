// The host's list of projects: <dataDir>/registry.json - the projects (name, path, pin, group), the folders the user
// removed (so the scan does not add them again), the order mode and the groups. Read on every use (it is small and
// the scan edits it too) and written whole.
const fs = require("node:fs");
const path = require("node:path");
const { fail } = require("./errors");
const { normPath } = require("../shared/util");
const { writeSync } = require("../shared/atomic-file");

const norm = p => normPath(path.resolve(p));
// A project's key: its folder here, or "node:<id>:<folder there>" for one of another computer (the pages use the
// same key as the project's space). keyify: a path or a key as the pages send it.
const keyOf = x => (x.node ? `node:${x.node}:${normPath(x.path)}` : norm(x.path));
const keyify = p => (typeof p === "string" && p.startsWith("node:") ? p : norm(p));

function createRegistry(file) {
  let readError = null;
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || typeof data !== "object" || !Array.isArray(data.projects)) throw new Error("Invalid project registry");
      readError = null;
      return {
        pathKeyVersion: 2,
        legacyRemoved: (data.pathKeyVersion === 2 ? (Array.isArray(data.legacyRemoved) ? data.legacyRemoved : []) : (Array.isArray(data.removed) ? data.removed : [])).filter(p => typeof p === "string"),
        projects: Array.isArray(data.projects) ? data.projects : [],
        removed: Array.isArray(data.removed) ? data.removed.filter(p => typeof p === "string") : [],
        order: data.order === "custom" ? "custom" : "activity",
        groups: Array.isArray(data.groups) ? data.groups.filter(g => typeof g?.id === "string" && typeof g.name === "string") : [],
        lastAdded: typeof data.lastAdded === "string" ? data.lastAdded : ""
      };
    } catch (e) {
      if (e.code === "ENOENT") { readError = null; return { pathKeyVersion: 2, legacyRemoved: [], projects: [], removed: [], order: "activity", groups: [], lastAdded: "" }; }
      readError = e;
      throw e;
    }
  }
  function write(data) {
    if (readError) throw readError;
    writeSync(file, JSON.stringify({ ...data, pathKeyVersion: 2 }, null, 2));
  }
  return { read, write };
}

const getProject = (data, p) => data.projects.find(x => keyOf(x) === keyify(p));
const isPinned = x => Number.isInteger(x?.pin);
// slot: where to keep the item, or null to let it move again.
function setPin(item, slot) {
  if (slot !== null && !(Number.isInteger(slot) && slot >= 0)) fail("invalidData");
  if (item && slot === null) delete item.pin;
  else if (item) item.pin = slot;
}
// groupOf: {path: groupId or ""}. A project joining a group drops its own pin. text(p): the caller's check of a path.
function setGroups(data, groupOf, text = p => p) {
  if (!groupOf || typeof groupOf !== "object") return;
  const ids = new Set(data.groups.map(g => g.id));
  const byPath = new Map(data.projects.map(x => [keyOf(x), x]));
  for (const [p, id] of Object.entries(groupOf)) {
    const item = byPath.get(keyify(text(p)));
    if (!item || (id && !ids.has(id))) continue;
    if (!id) delete item.group;
    else {
      item.group = id;
      delete item.pin;
    }
  }
}
// A group without projects has no place of its own to keep.
function unpinEmptyGroups(data) {
  const used = new Set(data.projects.map(x => x.group));
  for (const g of data.groups) {
    if (!used.has(g.id)) delete g.pin;
  }
}
// Each pinned project or group is pinned where it now is among the top-level items.
function repin(data) {
  const units = [...new Set(data.projects.map(x => (x.group ? "g:" + x.group : keyOf(x))))];
  for (const g of data.groups.filter(isPinned)) {
    g.pin = units.indexOf("g:" + g.id);
    if (g.pin < 0) delete g.pin;
  }
  for (const x of data.projects.filter(isPinned)) x.pin = units.indexOf(keyOf(x));
}

module.exports = { createRegistry, norm, keyOf, keyify, getProject, isPinned, setPin, setGroups, unpinEmptyGroups, repin };
