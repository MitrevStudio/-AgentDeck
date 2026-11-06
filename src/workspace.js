// How AgentDeck's own terminals are laid out in the manager window, as in Herdr: a project is a space, a space has
// tabs, and a tab is a tree of panes split right or down, each pane showing one terminal (terminals.js). Kept in main,
// so a terminal opened from anywhere (the edge menu, a voice command, a notification) lands in its place; the window
// only draws it and sends commands back. In memory only: the terminals themselves end with the app.
//
// A node is { term } (a pane) or { dir: "right" | "down", ratio, a, b } (a split: `a` left or above, `b` the rest).
// A split is addressed by its path from the tab's root: "" the root, "a"/"b" its children, "ab" and so on.
const crypto = require("node:crypto");

const MIN_RATIO = 0.1, MAX_RATIO = 0.9;
const DIRECTIONS = ["left", "right", "up", "down"];

const isPane = node => Boolean(node && node.term);
function getPanes(node, out = []) {
  if (!node) return out;
  if (isPane(node)) out.push(node.term);
  else { getPanes(node.a, out); getPanes(node.b, out); }
  return out;
}
const hasTerm = (node, term) => getPanes(node).includes(term);
const clampRatio = r => Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number(r) || 0.5));

// The tree with the pane of `term` replaced by what make(pane) returns (null removes the pane: its sibling takes the
// split's place).
function replacePane(node, term, make) {
  if (isPane(node)) return node.term === term ? make(node) : node;
  const a = replacePane(node.a, term, make), b = replacePane(node.b, term, make);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}
function getNode(node, path) {
  for (const step of path) {
    if (!node || isPane(node)) return null;
    node = node[step];
  }
  return node;
}
function setRatioAt(node, path, ratio) {
  if (!path) return isPane(node) ? node : { ...node, ratio: clampRatio(ratio) };
  return { ...node, [path[0]]: setRatioAt(node[path[0]], path.slice(1), ratio) };
}
// Each pane's rectangle in the tab, 0..1 both ways.
function getRects(node, box = { x: 0, y: 0, w: 1, h: 1 }, out = new Map()) {
  if (!node) return out;
  if (isPane(node)) { out.set(node.term, box); return out; }
  const r = clampRatio(node.ratio);
  if (node.dir === "right") {
    getRects(node.a, { ...box, w: box.w * r }, out);
    getRects(node.b, { ...box, x: box.x + box.w * r, w: box.w * (1 - r) }, out);
  } else {
    getRects(node.a, { ...box, h: box.h * r }, out);
    getRects(node.b, { ...box, y: box.y + box.h * r, h: box.h * (1 - r) }, out);
  }
  return out;
}
// The pane next to `term` in a direction: the nearest one that overlaps it across that direction, the one most in
// line with it when several do.
function findNeighbour(root, term, direction) {
  const rects = getRects(root), from = rects.get(term);
  if (!from) return null;
  const EPS = 1e-6;
  const horizontal = direction === "left" || direction === "right";
  let best = null, bestGap = Infinity, bestOverlap = -1;
  for (const [other, r] of rects) {
    if (other === term) continue;
    const gap = { left: from.x - (r.x + r.w), right: r.x - (from.x + from.w), up: from.y - (r.y + r.h), down: r.y - (from.y + from.h) }[direction];
    if (gap < -EPS) continue;
    const overlap = horizontal
      ? Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y)
      : Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
    if (overlap <= EPS) continue;
    if (gap < bestGap - EPS || (Math.abs(gap - bestGap) <= EPS && overlap > bestOverlap)) {
      best = other; bestGap = gap; bestOverlap = overlap;
    }
  }
  return best;
}

// onChange(snapshot) after every change.
function createWorkspace({ onChange = () => {} } = {}) {
  const spaces = new Map(); // space key -> { tabs: [tab id], active: tab id }
  const tabs = new Map();   // tab id -> { id, space, name, root, focus: term, zoom: term | "" }
  let activeSpace = "";

  const changed = () => onChange(snapshot());
  function getSpace(key) {
    if (!spaces.has(key)) spaces.set(key, { tabs: [], active: "" });
    return spaces.get(key);
  }
  const findTab = term => [...tabs.values()].find(tab => hasTerm(tab.root, term)) || null;

  // A new tab in `space` with `term` as its only pane; it becomes the shown one.
  function addTab(space, term, name = "") {
    const id = crypto.randomUUID();
    tabs.set(id, { id, space, name, root: { term }, focus: term, zoom: "" });
    const s = getSpace(space);
    s.tabs.push(id);
    s.active = id;
    activeSpace = space;
    changed();
    return id;
  }
  // `term` beside the pane of `target` (the tab's focused one when not given), taking half of it.
  function split(tabId, term, dir, target = "") {
    const tab = tabs.get(tabId);
    if (!tab || !["right", "down"].includes(dir)) return false;
    const at = target && hasTerm(tab.root, target) ? target : tab.focus;
    tab.root = replacePane(tab.root, at, pane => ({ dir, ratio: 0.5, a: pane, b: { term } }));
    tab.focus = term;
    tab.zoom = "";
    const s = getSpace(tab.space);
    s.active = tabId;
    activeSpace = tab.space;
    changed();
    return true;
  }
  // The pane of a terminal that ended or was closed goes; an emptied tab goes with it.
  function removeTerm(term) {
    const tab = findTab(term);
    if (!tab) return false;
    const panes = getPanes(tab.root);
    const at = panes.indexOf(term);
    tab.root = replacePane(tab.root, term, () => null);
    if (!tab.root) {
      closeTabOnly(tab.id);
    } else {
      if (tab.focus === term) {
        const rest = getPanes(tab.root);
        tab.focus = rest[Math.min(at, rest.length - 1)];
      }
      if (tab.zoom === term) tab.zoom = "";
    }
    changed();
    return true;
  }
  function closeTabOnly(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tabs.delete(tabId);
    const s = getSpace(tab.space);
    const i = s.tabs.indexOf(tabId);
    s.tabs.splice(i, 1);
    if (s.active === tabId) s.active = s.tabs[Math.min(i, s.tabs.length - 1)] || "";
  }
  // The terminals of a tab, for the caller to end (their panes then go through removeTerm).
  const getTabTerms = tabId => (tabs.has(tabId) ? getPanes(tabs.get(tabId).root) : []);

  function focus(term) {
    const tab = findTab(term);
    if (!tab) return false;
    tab.focus = term;
    if (tab.zoom && tab.zoom !== term) tab.zoom = "";
    const s = getSpace(tab.space);
    s.active = tab.id;
    activeSpace = tab.space;
    changed();
    return true;
  }
  // From the focused pane of the shown tab to its neighbour; false when there is none that way.
  function focusDirection(direction) {
    const tab = getActiveTab();
    if (!tab || !DIRECTIONS.includes(direction) || tab.zoom) return false;
    const next = findNeighbour(tab.root, tab.focus, direction);
    return next ? focus(next) : false;
  }
  function setRatio(tabId, path, ratio) {
    const tab = tabs.get(tabId);
    if (!tab || typeof path !== "string" || !/^[ab]*$/.test(path)) return false;
    const node = getNode(tab.root, path);
    if (!node || isPane(node)) return false;
    tab.root = setRatioAt(tab.root, path, ratio);
    changed();
    return true;
  }
  function toggleZoom(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return false;
    tab.zoom = tab.zoom || getPanes(tab.root).length < 2 ? "" : tab.focus;
    changed();
    return true;
  }
  function activateSpace(space) {
    activeSpace = String(space);
    getSpace(activeSpace);
    changed();
  }
  function activateTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return false;
    getSpace(tab.space).active = tabId;
    activeSpace = tab.space;
    changed();
    return true;
  }
  function renameTab(tabId, name) {
    const tab = tabs.get(tabId);
    if (!tab) return false;
    tab.name = String(name).trim().slice(0, 80);
    changed();
    return true;
  }
  // The tabs of a space in a new order (ids missing from the list keep their place after it).
  function reorderTabs(space, ids) {
    const s = spaces.get(space);
    if (!s) return false;
    s.tabs = [...new Set([...ids.filter(id => s.tabs.includes(id)), ...s.tabs])];
    changed();
    return true;
  }
  function getActiveTab() {
    const s = spaces.get(activeSpace);
    return (s && tabs.get(s.active)) || null;
  }

  function snapshot() {
    return {
      activeSpace,
      spaces: Object.fromEntries([...spaces].map(([key, s]) => [key, { tabs: [...s.tabs], active: s.active }])),
      tabs: Object.fromEntries([...tabs].map(([id, tab]) => [id, { ...tab }]))
    };
  }

  return {
    addTab, split, removeTerm, getTabTerms, focus, focusDirection, setRatio, toggleZoom, activateSpace, activateTab,
    renameTab, reorderTabs, getActiveTab, findTab, snapshot
  };
}

module.exports = { createWorkspace, getPanes, getRects, findNeighbour };
