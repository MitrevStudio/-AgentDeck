// The host's list of projects: <dataDir>/registry.json - the projects (name, path, pin, group), the folders the user
// removed (so the scan does not add them again), the order mode and the groups. Read on every use (it is small and
// the scan edits it too) and written whole.
const fs = require("node:fs");
const path = require("node:path");
const { fail } = require("./errors");

const norm = p => path.resolve(p).replace(/\\/g, "/").toLowerCase();

function createRegistry(file) {
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return {
        projects: Array.isArray(data.projects) ? data.projects : [],
        removed: Array.isArray(data.removed) ? data.removed.filter(p => typeof p === "string") : [],
        order: data.order === "custom" ? "custom" : "activity",
        groups: Array.isArray(data.groups) ? data.groups.filter(g => typeof g?.id === "string" && typeof g.name === "string") : [],
        lastAdded: typeof data.lastAdded === "string" ? data.lastAdded : ""
      };
    } catch { return { projects: [], removed: [], order: "activity", groups: [], lastAdded: "" }; }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  }
  return { read, write };
}

const getProject = (data, p) => data.projects.find(x => norm(x.path) === norm(p));
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
  const byPath = new Map(data.projects.map(x => [norm(x.path), x]));
  for (const [p, id] of Object.entries(groupOf)) {
    const item = byPath.get(norm(text(p)));
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
  const units = [...new Set(data.projects.map(x => (x.group ? "g:" + x.group : norm(x.path))))];
  for (const g of data.groups.filter(isPinned)) {
    g.pin = units.indexOf("g:" + g.id);
    if (g.pin < 0) delete g.pin;
  }
  for (const x of data.projects.filter(isPinned)) x.pin = units.indexOf(norm(x.path));
}

module.exports = { createRegistry, norm, getProject, isPinned, setPin, setGroups, unpinEmptyGroups, repin };
