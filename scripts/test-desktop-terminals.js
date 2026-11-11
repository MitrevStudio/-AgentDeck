// The desktop's side of the shared terminals (src/desktop-terminals.js, docs/SHARED-SESSIONS.md 5): the window's view
// of the terminals of this and the paired computers, the viewer diff of syncLocalViewers, the restore plan of 5.4 (each
// row), which computer a terminal id belongs to, the space of another computer's terminal, and what a pane shown again
// missed.
const assert = require("node:assert/strict");
const desk = require("../src/desktop-terminals");
const { normPath } = require("../src/shared/util");

const SELF = "11111111-1111-4111-8111-111111111111", PEER = "22222222-2222-4222-8222-222222222222", PHONE = "33333333-3333-4333-8333-333333333333";
const OLD = "44444444-4444-4444-8444-444444444444";
const names = new Map([[SELF, "WORK-01"], [PEER, "StudioPc"], [PHONE, "Pixel 8"], [OLD, "OldBox"]]);
const self = { id: SELF, name: "WORK-01" };

// ---------- the view ----------
{
  const local = [
    // Opened here, viewed here and on the phone, which drives.
    { id: "l1", cwd: "C:/w", title: "pwsh", owner: "", exited: false, reopened: false, viewers: [{ id: "", name: "", kind: "desktop" }, { id: PHONE, name: "", kind: "mobile" }], driver: PHONE, note: "" },
    // Opened from the peer, no pane here, reopened after a restart, driven by this window... which is not a viewer.
    { id: "l2", cwd: "C:/w", title: "Claude", agent: "Claude", sessionId: "s2", owner: PEER, exited: false, reopened: true, viewers: [], driver: null, note: "" },
    // Driven by this window.
    { id: "l3", cwd: "C:/w", title: "bash", owner: "", exited: false, reopened: true, viewers: [{ id: "", name: "", kind: "desktop" }], driver: "", note: "Compacting…" }
  ];
  const nodes = [
    { id: PEER, name: "StudioPc", online: true, legacy: false, tabs: [
      { id: "r1", cwd: "D:/src/app/web", title: "zsh", owner: SELF, ownerName: "WORK-01", exited: false, reopened: false, viewers: [{ id: SELF, name: "WORK-01", kind: "desktop" }, { id: PEER, name: "StudioPc", kind: "desktop" }], driver: PEER },
      { id: "r2", cwd: "D:/src/app", title: "Codex", owner: "", ownerName: "", exited: false, reopened: true, viewers: [{ id: PEER, name: "StudioPc", kind: "desktop" }], driver: SELF }
    ] },
    { id: OLD, name: "OldBox", online: true, legacy: true, tabs: [{ id: "o1", cwd: "/home/x", title: "sh", owner: SELF, exited: false }] },
    { id: "55555555-5555-4555-8555-555555555555", name: "Away", online: false, legacy: false, tabs: [{ id: "a1", cwd: "/x", title: "gone", viewers: [], driver: null }] }
  ];
  const remoteTerms = new Map([
    ["r1", { id: "r1", node: PEER, cwd: "D:/src/app/web", title: "zsh" }],
    ["a2", { id: "a2", node: "55555555-5555-4555-8555-555555555555", cwd: "/y", title: "vim", agent: "", createdAt: 5 }],
    ["o1", { id: "o1", node: OLD, cwd: "/home/x", title: "sh" }]
  ]);
  const view = desk.composeView({ local, paned: new Set(["l1", "l3", "r1", "a2", "o1"]), self, names, nodes, remoteTerms, offline: "offline", cleared: new Set(["l3"]) });
  const by = id => view.find(x => x.id === id);
  assert.deepEqual(view.map(x => x.id), ["l1", "l2", "l3", "r1", "r2", "o1", "a2"], "every local terminal, every one of the online computers, the panes of an offline one; not the offline one's list");

  const l1 = by("l1");
  assert.equal(l1.node, "");
  assert.equal(l1.paned, true);
  assert.equal(l1.legacy, false);
  assert.equal(l1.ownerName, "", "opened here: no 'opened from'");
  assert.deepEqual(l1.viewers, [{ id: SELF, name: "WORK-01", kind: "desktop", me: true }, { id: PHONE, name: "Pixel 8", kind: "mobile", me: false }]);
  assert.deepEqual(l1.driver, { name: "Pixel 8", me: false });
  assert.equal(l1.title, "pwsh", "a local title has no suffix");

  const l2 = by("l2");
  assert.equal(l2.paned, false, "no pane here");
  assert.equal(l2.ownerName, "StudioPc", "opened from the peer");
  assert.equal(l2.reopened, true);
  assert.equal(l2.note, "", "reopened is a flag, not a note");
  assert.equal(l2.driver, null);

  const l3 = by("l3");
  assert.deepEqual(l3.driver, { name: "WORK-01", me: true });
  assert.equal(l3.reopened, false, "typed into here: the reopened note is done");
  assert.equal(l3.note, "Compacting…");

  const r1 = by("r1");
  assert.equal(r1.node, PEER);
  assert.equal(r1.title, "zsh · StudioPc", "another computer's title carries its name");
  assert.equal(r1.paned, true);
  assert.equal(r1.ownerName, "", "opened from this computer: no 'opened from'");
  assert.deepEqual(r1.viewers.map(v => [v.name, v.me]), [["WORK-01", true], ["StudioPc", false]]);
  assert.deepEqual(r1.driver, { name: "StudioPc", me: false });
  assert.equal(r1.note, "");

  const r2 = by("r2");
  assert.equal(r2.paned, false);
  assert.deepEqual(r2.driver, { name: "WORK-01", me: true }, "a remote terminal this node drives");
  assert.equal(r2.reopened, true);

  const o1 = by("o1");
  assert.equal(o1.legacy, true, "a host without terminals: 2");
  assert.deepEqual(o1.viewers, []);
  assert.equal(o1.driver, null);

  const a2 = by("a2");
  assert.equal(a2.note, "offline", "a pane whose computer is away");
  assert.equal(a2.paned, true);
  assert.equal(a2.title, "vim · Away");
  assert.deepEqual([a2.viewers, a2.driver, a2.legacy], [[], null, false]);
  assert.equal(by("a1"), undefined, "an offline computer's terminals without a pane here are not listed");

  // A pane of an online computer whose list has not come yet: no "offline".
  const early = desk.composeView({ self, names, nodes: [{ id: PEER, name: "StudioPc", online: true, legacy: false, tabs: null }], remoteTerms: new Map([["r9", { id: "r9", node: PEER, cwd: "/", title: "t" }]]), offline: "offline" });
  assert.equal(early[0].note, "");
  // The mesh off: no self id, the window still is "me".
  const off = desk.composeView({ local: [local[0]], paned: new Set(["l1"]), self: { id: "", name: "HOST" }, names: new Map() });
  assert.deepEqual(off[0].viewers.map(v => [v.name, v.me]), [["HOST", true], [PHONE.slice(0, 8), false]], "an unknown node is named by its id, never ''");
  assert.deepEqual(off[0].driver, { name: PHONE.slice(0, 8), me: false });
}

// ---------- sizes ----------
{
  const nameOf = who => (who === "" ? "WORK-01" : names.get(who) || "");
  assert.deepEqual(desk.sizeView({ cols: 80, rows: 24, driver: null }, "", nameOf), { cols: 80, rows: 24, mine: false, by: "" }, "nobody drives: the pane fits itself");
  assert.deepEqual(desk.sizeView({ cols: 80, rows: 24, driver: "" }, "", nameOf), { cols: 80, rows: 24, mine: true, by: "WORK-01" });
  assert.deepEqual(desk.sizeView({ cols: 80, rows: 24, driver: PEER }, "", nameOf), { cols: 80, rows: 24, mine: false, by: "StudioPc" });
  assert.deepEqual(desk.sizeView({ cols: 80, rows: 24, driver: SELF }, SELF, nameOf), { cols: 80, rows: 24, mine: true, by: "WORK-01" }, "on another host the window is this node");
  assert.equal(desk.sizeView({ cols: 1, rows: 1, driver: "x" }, "", () => "").by, "?", "a driver always has a name");
  assert.deepEqual(desk.sizeView({ cols: 1, rows: 1, driver: SELF }, null, nameOf).mine, false, "no self id: never mine");
}

// ---------- syncLocalViewers ----------
assert.deepEqual(desk.viewerDiff(new Set(["a", "b"]), new Set(["b", "c"])), { attach: ["c"], detach: ["a"] });
assert.deepEqual(desk.viewerDiff(new Set(), new Set()), { attach: [], detach: [] });
assert.deepEqual(desk.viewerDiff(new Set(["a"]), new Set(["a"])), { attach: [], detach: [] });

// ---------- the restore plan (5.4) ----------
{
  const terms = {
    attached: { cwd: "C:/w" }, reopened: { cwd: "C:/w", agent: "Claude", sessionId: "s" }, gone: { cwd: "C:/w" }, centre: { cwd: "C:/c" },
    kept: { cwd: "C:/w" }, [PEER]: { node: PEER, cwd: "/r" }, "not-a-uuid": { node: PEER, cwd: "/r" }
  };
  const plan = desk.restorePlan({
    panes: new Set(["attached", "reopened", "gone", "centre", "kept", PEER, "not-a-uuid", "nometa"]), terms,
    attached: ["attached", "unpaned"], reopened: ["reopened"], kept: ["kept"], isId: id => /^[0-9a-f-]{36}$/.test(id)
  });
  assert.deepEqual(plan.keep, ["attached", "reopened"], "local, its DockPty alive; local, opened anew by the host under its id");
  assert.deepEqual(plan.drop, ["kept"], "local, running but not attached: the pane goes");
  assert.deepEqual(plan.remote, [PEER], "remote: pending until its computer is there");
  assert.deepEqual(plan.reopen, ["gone", "centre", "not-a-uuid", "nometa"], "nothing left of it (stopAll, the command centre): opened anew here");
  assert.deepEqual(desk.restorePlan({ panes: new Set(), terms: {} }), { keep: [], remote: [], reopen: [], drop: [] }, "no saved layout");
  assert.deepEqual(desk.restorePlan({ panes: new Set(["__proto__"]), terms: {} }).reopen, ["__proto__"], "a pane without its meta never reads the prototype");
}

// ---------- which computer ----------
{
  const where = {
    local: new Set(["l1"]), remoteTerms: new Map([["p1", { node: PEER }]]),
    lists: new Map([[PEER, [{ id: "r1" }]], [OLD, null]]), lives: new Map([[OLD, [{ id: "s", term: "" }, { id: "t", term: "v1" }]]])
  };
  assert.equal(desk.nodeOf("l1", where), "");
  assert.equal(desk.nodeOf("p1", where), PEER, "a pane here");
  assert.equal(desk.nodeOf("r1", where), PEER, "in a computer's list");
  assert.equal(desk.nodeOf("v1", where), OLD, "known only from a live session's term");
  assert.equal(desk.nodeOf("nope", where), null);
  assert.equal(desk.nodeOf("", where), null, "an empty term is no terminal");
}

// ---------- the space of another computer's terminal ----------
{
  const projects = [{ node: PEER, path: "D:\\src\\app" }, { node: PEER, path: "D:/src/app/web" }, { node: OLD, path: "D:/src" }, { path: "D:/src/app" }];
  assert.equal(desk.remoteSpace(projects, PEER, "D:\\src\\app\\web\\ui"), `node:${PEER}:${normPath("D:/src/app/web")}`, "the deepest project of that computer");
  assert.equal(desk.remoteSpace(projects, PEER, "D:/src/app"), `node:${PEER}:${normPath("D:/src/app")}`);
  assert.equal(desk.remoteSpace(projects, PEER, "D:/src/application"), `node:${PEER}:${normPath("D:/src/application")}`, "a sibling folder is no subfolder");
  assert.equal(desk.remoteSpace([], PEER, "/home/x/"), `node:${PEER}:/home/x`);
}

// ---------- what a pane shown again missed ----------
assert.equal(desk.missedOutput("abcdef", 10, 7), "def", "the tail written since");
assert.equal(desk.missedOutput("abcdef", 10, 10), "", "nothing missed");
assert.equal(desk.missedOutput("abcdef", 10, 12), "", "a terminal opened anew starts again: nothing twice");
assert.equal(desk.missedOutput("\x1b[?25habcdef", 100, 20), "\x1b[?25habcdef", "more missed than kept: all of it");
assert.equal(desk.missedOutput("abc", 3, undefined), "", "never sent: the window attaches itself");

console.log("desktop terminals: view (local, remote, paned, me, driver, owner, reopened, legacy, offline), sizes, viewer diff, restore plan, routing, remote space, missed output - passed");
