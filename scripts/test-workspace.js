// Checks the pane layout (src/workspace.js): tabs per space, splits, closing, focus by direction, ratios, zoom.
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

console.log("workspace: all checks passed");
