// Old versions lowercased POSIX paths too. Only remap a legacy key when exactly one real project matches it.
function keyMigration(projects, keyOf) {
  const candidates = new Map();
  for (const p of projects) {
    const key = keyOf(p), old = key.toLowerCase();
    if (!candidates.has(old)) candidates.set(old, new Set());
    candidates.get(old).add(key);
  }
  return key => {
    const matches = candidates.get(key);
    return matches?.size === 1 ? [...matches][0] : key;
  };
}
function migrateLayout(layout, projects, keyOf) {
  if (!layout || layout.pathKeyVersion === 2) return layout;
  const candidate = keyMigration(projects, keyOf), spaces = {};
  const remap = key => {
    const next = candidate(key);
    return next !== key && Object.hasOwn(layout.spaces || {}, next) ? key : next;
  };
  for (const [key, value] of Object.entries(layout.spaces || {})) {
    const next = remap(key);
    // A pre-existing destination is not overwritten.
    spaces[next] = value;
  }
  return { ...layout, pathKeyVersion: 2, spaces, activeSpace: remap(layout.activeSpace) };
}
function migrateRemoved(data, projects, keyOf) {
  if (!data.legacyRemoved?.length) return false;
  const remap = keyMigration(projects, keyOf), known = new Set(projects.map(p => keyOf(p).toLowerCase()));
  const resolved = new Set(data.legacyRemoved.filter(key => known.has(key)));
  if (!resolved.size) return false;
  data.removed = [...new Set(data.removed.map(key => resolved.has(key) ? remap(key) : key))];
  data.legacyRemoved = data.legacyRemoved.filter(key => !resolved.has(key));
  return true;
}
module.exports = { keyMigration, migrateLayout, migrateRemoved };
