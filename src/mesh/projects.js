const { keyOf, unpinEmptyGroups } = require("../host/registry");

// A snapshot belongs to its publisher. Never relay another host's registry or preferences.
function localSnapshot(data) {
  return { ...data, registry: { projects: (data?.registry?.projects || []).filter(p => !p.node).map(p => ({ name: p.name, path: p.path })) } };
}

function mergeProjects(data, nodes, remote) {
  const paired = new Set(nodes.map(n => n.id)), known = new Set(), wanted = new Map();
  for (const n of nodes) {
    const projects = remote.get(n.id)?.data?.registry?.projects;
    if (!Array.isArray(projects)) continue; // unknown/offline is not an empty snapshot
    known.add(n.id);
    for (const p of projects) {
      if (p?.node || typeof p?.path !== "string" || !p.path) continue;
      const project = { node: n.id, name: String(p.name || p.path.split(/[\\/]/).at(-1)), path: p.path };
      wanted.set(keyOf(project), project);
    }
  }
  const before = JSON.stringify(data);
  require("../shared/path-keys").migrateRemoved(data, [...data.projects, ...wanted.values()], keyOf);
  data.projects = data.projects.filter(p => !p.node || (paired.has(p.node) && (!known.has(p.node) || wanted.has(keyOf(p)))));
  const have = new Set(data.projects.map(keyOf)), removed = new Set(data.removed);
  for (const [key, p] of wanted) if (!have.has(key) && !removed.has(key)) data.projects.push(p);
  if (before !== JSON.stringify(data)) { unpinEmptyGroups(data); return true; }
  return false;
}

module.exports = { localSnapshot, mergeProjects };
