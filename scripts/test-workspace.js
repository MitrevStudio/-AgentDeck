// Checks the pane layout (src/workspace.js): tabs per space, splits, closing, focus by direction, ratios, zoom, and
// saving and restoring it.
const assert = require("node:assert/strict");
const { createWorkspace, getPanes, getRects } = require("../src/workspace");

let changes = 0;
const ws = createWorkspace({ onChange: () => changes++ });

// A tab, then two splits: [t1 | t2] over t3 is t1 right of... built as t1 -> right t2 -> down (from t2) t3.
const tab = ws.addTab("e:/bdd", "t1");
assert.equal(ws.snapshot().activeSpace, "e:/bdd");
ws.split(tab, "t2", "right");
ws.split(tab, "t3", "down");
assert.deepEqual(getPanes(ws.snapshot().tabs[tab].root), ["t1", "t2", "t3"]);
assert.equal(ws.snapshot().tabs[tab].focus, "t3");

// Geometry: t1 the left half, t2 above t3 on the right.
const rects = getRects(ws.snapshot().tabs[tab].root);
assert.deepEqual(rects.get("t1"), { x: 0, y: 0, w: 0.5, h: 1 });
assert.deepEqual(rects.get("t3"), { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });

// Focus by direction.
assert.equal(ws.focusDirection("up"), true);
assert.equal(ws.snapshot().tabs[tab].focus, "t2");
assert.equal(ws.focusDirection("left"), true);
assert.equal(ws.snapshot().tabs[tab].focus, "t1");
assert.equal(ws.focusDirection("left"), false);
assert.equal(ws.focusDirection("right"), true);
assert.equal(ws.snapshot().tabs[tab].focus, "t2", "the nearest pane to the right, most in line");

// Ratios: the root split, clamped.
assert.equal(ws.setRatio(tab, "", 0.7), true);
assert.equal(ws.snapshot().tabs[tab].root.ratio, 0.7);
ws.setRatio(tab, "b", 5);
assert.equal(ws.snapshot().tabs[tab].root.b.ratio, 0.9);
assert.equal(ws.setRatio(tab, "a", 0.3), false, "a pane has no ratio");
assert.equal(ws.setRatio(tab, "x", 0.3), false);

// Zoom, and leaving it by focusing another pane.
ws.toggleZoom(tab);
assert.equal(ws.snapshot().tabs[tab].zoom, "t2");
ws.focus("t1");
assert.equal(ws.snapshot().tabs[tab].zoom, "");

// Closing: the sibling takes the split's place; focus moves to a neighbour in the list.
ws.focus("t2");
ws.removeTerm("t2");
assert.deepEqual(getPanes(ws.snapshot().tabs[tab].root), ["t1", "t3"]);
assert.equal(ws.snapshot().tabs[tab].focus, "t3");
assert.equal(ws.snapshot().tabs[tab].root.dir, "right");

// A second tab in the same space, another space, and switching.
const tab2 = ws.addTab("e:/bdd", "t4", "logs");
assert.deepEqual(ws.snapshot().spaces["e:/bdd"].tabs, [tab, tab2]);
assert.equal(ws.snapshot().spaces["e:/bdd"].active, tab2);
const other = ws.addTab("e:/liberdent", "t5");
assert.equal(ws.snapshot().activeSpace, "e:/liberdent");
ws.focus("t1");
assert.equal(ws.snapshot().activeSpace, "e:/bdd");
assert.equal(ws.snapshot().spaces["e:/bdd"].active, tab);
ws.reorderTabs("e:/bdd", [tab2, tab]);
assert.deepEqual(ws.snapshot().spaces["e:/bdd"].tabs, [tab2, tab]);

// The last pane of a tab closes the tab; the space shows its next tab.
ws.removeTerm("t4");
assert.equal(ws.snapshot().tabs[tab2], undefined);
assert.deepEqual(ws.snapshot().spaces["e:/bdd"].tabs, [tab]);
assert.equal(ws.snapshot().spaces["e:/bdd"].active, tab);
ws.removeTerm("t5");
assert.deepEqual(ws.snapshot().spaces["e:/liberdent"].tabs, []);
assert.equal(ws.snapshot().spaces["e:/liberdent"].active, "");
assert.equal(ws.findTab("t5"), null);
assert.deepEqual(ws.getTabTerms(tab), ["t1", "t3"]);
assert.ok(changes > 10);

// Saving and restoring. A layout of two tabs in one space: [p1 | (p2 over p3)] zoomed on p2, and p4 alone.
const saved = createWorkspace();
const s1 = saved.addTab("e:/app", "p1");
saved.split(s1, "p2", "right");
saved.split(s1, "p3", "down");
saved.setRatio(s1, "", 0.3);
saved.focus("p2");
saved.toggleZoom(s1);
saved.renameTab(s1, "work");
const s2 = saved.addTab("e:/app", "p4");
saved.activateTab(s1);
saved.activateSpace("e:/empty");
saved.activateSpace("e:/app");
const state = JSON.parse(JSON.stringify(saved.exportState()));

// Round trip: every terminal still there (under a new id), so the layout comes back as it was.
const back = createWorkspace();
back.importState(state, term => term.replace("p", "n"));
const b = back.snapshot();
assert.equal(b.activeSpace, "e:/app");
assert.deepEqual(b.spaces["e:/app"], { tabs: [s1, s2], active: s1 });
assert.deepEqual(b.spaces["e:/empty"], { tabs: [], active: "" });
assert.deepEqual(getPanes(b.tabs[s1].root), ["n1", "n2", "n3"]);
assert.equal(b.tabs[s1].root.ratio, 0.3);

// A project chosen in the sidebar shows its session picker; its tabs stay.
const picked = createWorkspace();
picked.importState(state, term => term);
picked.activateSpace("e:/app");
picked.showSessions();
assert.deepEqual(picked.snapshot().spaces["e:/app"], { tabs: [s1, s2], active: "" });
assert.equal(b.tabs[s1].focus, "n2");
assert.equal(b.tabs[s1].zoom, "n2");
assert.equal(b.tabs[s1].name, "work");
assert.equal(back.getActiveTab().id, s1);

// A dropped pane collapses its split; a dropped focus and zoom fall back; an emptied tab goes and the space shows the
// next one.
const gone = new Set(["p2", "p1"]);
const part = createWorkspace();
part.importState(state, term => (gone.has(term) ? "" : term));
const p = part.snapshot();
assert.deepEqual(p.tabs[s1].root, { term: "p3" }, "both splits collapse onto the one pane left");
assert.equal(p.tabs[s1].focus, "p3");
assert.equal(p.tabs[s1].zoom, "");
const noP4 = createWorkspace();
noP4.importState(state, term => (term === "p4" ? "" : term));
assert.deepEqual(noP4.snapshot().spaces["e:/app"].tabs, [s1]);
const none = createWorkspace();
none.importState({ ...state, spaces: { ...state.spaces, "e:/app": { tabs: [s1, s2], active: "missing" } } }, term => (term === "p4" ? term : ""));
assert.deepEqual(none.snapshot().spaces["e:/app"], { tabs: [s2], active: s2 });

// A damaged file restores what it can and nothing that would break the window.
const bad = createWorkspace();
bad.importState({ activeSpace: "e:/nowhere", spaces: { "e:/x": { tabs: ["t", "u", 5] }, "e:/y": null },
  tabs: { t: { root: { dir: "sideways", a: { term: "a" }, b: { term: "b" } } }, u: { root: { term: "c" }, focus: 7, zoom: "c" } } }, x => x);
const d = bad.snapshot();
assert.equal(d.activeSpace, "");
assert.deepEqual(d.spaces["e:/x"], { tabs: ["u"], active: "u" });
assert.deepEqual(d.tabs.u, { id: "u", space: "e:/x", name: "", root: { term: "c" }, focus: "c", zoom: "" });
bad.importState(null, x => x);
assert.deepEqual(bad.snapshot(), { activeSpace: "", spaces: {}, tabs: {}, hidden: [] });

// A pane opened on the left or above goes first in its split (a session dropped on that side of a pane).
const sides = createWorkspace();
const st = sides.addTab("e:/app", "m1");
sides.split(st, "m2", "left");
assert.deepEqual(getPanes(sides.snapshot().tabs[st].root), ["m2", "m1"]);
assert.equal(sides.snapshot().tabs[st].root.dir, "right");
sides.split(st, "m3", "up", "m1");
assert.deepEqual(getPanes(sides.snapshot().tabs[st].root), ["m2", "m3", "m1"]);

// A pane dragged onto the agents list leaves the layout and keeps its terminal: saved as hidden, placed again as a tab
// (before a given one) or beside a pane.
const parked = createWorkspace();
const pa = parked.addTab("e:/app", "h1");
parked.split(pa, "h2", "right");
assert.equal(parked.hideTerm("h2"), true);
assert.deepEqual(getPanes(parked.snapshot().tabs[pa].root), ["h1"]);
assert.deepEqual(parked.snapshot().hidden, ["h2"]);
assert.equal(parked.hideTerm("h2"), false, "a hidden terminal is not hidden twice");
const reloaded = createWorkspace();
reloaded.importState(JSON.parse(JSON.stringify(parked.exportState())), term => term);
assert.equal(reloaded.isHidden("h2"), true);
reloaded.placeTab("h2", "e:/app", pa);
const placed = reloaded.snapshot();
assert.deepEqual(placed.hidden, []);
assert.equal(placed.spaces["e:/app"].tabs.length, 2);
assert.deepEqual(placed.tabs[placed.spaces["e:/app"].tabs[0]].root, { term: "h2" }, "the new tab goes before the given one");
assert.equal(placed.spaces["e:/app"].active, placed.spaces["e:/app"].tabs[0]);
reloaded.hideTerm("h2");
assert.equal(reloaded.movePane("h2", pa, "h1", "left"), true);
assert.deepEqual(getPanes(reloaded.snapshot().tabs[pa].root), ["h2", "h1"]);
reloaded.hideTerm("h1");
assert.equal(reloaded.removeTerm("h1"), true, "a hidden terminal that ends goes from the list");
assert.deepEqual(reloaded.snapshot().hidden, []);

console.log("workspace: all checks passed");
