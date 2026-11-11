// Who views a host's terminal and whose size it has (src/host/viewers.js, docs/SHARED-SESSIONS.md 4.3), against a fake
// backend and a fake clock: every row of the table (attach, want, input, take, release, detach, leave, hand-back,
// exit), HOLD, the hand-back order (inputAt, then attachedAt), MAX_VIEWERS, checked params, one size event per change,
// and random sequences of want / attach / detach from three viewers that never make the size ping-pong. isReport: every
// automatic answer of xterm.js is one, no key, paste or mouse report is. Then the
// relink of tab-links.js (4.8): a linked tab whose session is gone takes over the live session in its process chain.
const assert = require("node:assert/strict");
const { createViewers, isReport, MAX_VIEWERS, HOLD_MS } = require("../src/host/viewers");
const { createTabLinks } = require("../src/host/tab-links");

const fails = code => e => e.code === code;

// A backend of terminals with sizes; resize reports back as the real ones do (onResize -> viewers.sized).
function makeHost() {
  const sizes = new Map();
  const events = { size: [], change: [] };
  let clock = 1000;
  let viewers;
  const backend = {
    add: (id, cols = 120, rows = 32) => sizes.set(id, { cols, rows }),
    remove: id => sizes.delete(id),
    resize(id, cols, rows) {
      const s = sizes.get(id);
      if (!s || (s.cols === cols && s.rows === rows)) return;
      sizes.set(id, { cols, rows });
      backend.resizes++;
      viewers.sized(id);
    },
    resizes: 0
  };
  viewers = createViewers({
    resize: backend.resize, size: id => (sizes.has(id) ? { ...sizes.get(id) } : null),
    onSize: e => events.size.push(e), onChange: id => events.change.push(id), now: () => clock
  });
  return { viewers, backend, events, sizes, tick: ms => { clock += ms; }, now: () => clock };
}
const S = (h, id) => [h.sizes.get(id).cols, h.sizes.get(id).rows];

// ---------- the table ----------
{
  const h = makeHost(), v = h.viewers, T = "t1";
  h.backend.add(T);
  // attach: a viewer, nothing else changes.
  assert.deepEqual(v.attach(T, "A", { kind: "desktop" }), { cols: 120, rows: 32, driver: null });
  assert.deepEqual(h.events.size, [], "attach changes no size");
  assert.deepEqual(h.events.change, [T], "attach changes the viewers");
  assert.deepEqual(v.state(T), { cols: 120, rows: 32, driver: null, viewers: ["A"] });
  assert.deepEqual(v.attach(T, "A"), { cols: 120, rows: 32, driver: null }, "attaching again is a no-op");
  assert.equal(h.events.change.length, 1);

  // want with nobody driving: A drives, its size applies - one size event.
  v.want(T, "A", 100, 30);
  assert.deepEqual(S(h, T), [100, 30]);
  assert.deepEqual(h.events.size, [{ id: T, cols: 100, rows: 30, driver: "A" }], "one event for size and driver together");
  assert.equal(v.state(T).driver, "A");
  // want from the driver applies.
  v.want(T, "A", 101, 30);
  assert.deepEqual(S(h, T), [101, 30]);

  // B attaches and wants: only remembered.
  v.attach(T, "B", { kind: "desktop" });
  h.tick(10);
  const before = h.events.size.length;
  v.want(T, "B", 80, 24);
  assert.deepEqual(S(h, T), [101, 30], "a want from a viewer that does not drive is only remembered");
  assert.equal(h.events.size.length, before);

  // input: A typed now; B typing within HOLD does not take over, after HOLD it does.
  v.input(T, "A");
  h.tick(HOLD_MS - 1);
  v.input(T, "B");
  assert.equal(v.state(T).driver, "A", "within HOLD the driver stays");
  h.tick(1);
  v.input(T, "A"); // A types again: its HOLD starts anew
  h.tick(HOLD_MS);
  v.input(T, "B");
  assert.equal(v.state(T).driver, "B", "after HOLD the typing viewer drives");
  assert.deepEqual(S(h, T), [80, 24], "and its want applies");
  assert.deepEqual(h.events.size.at(-1), { id: T, cols: 80, rows: 24, driver: "B" });

  // A phone (no want) that types never takes over.
  v.attach(T, "P", { kind: "mobile" });
  h.tick(HOLD_MS * 2);
  v.input(T, "P");
  assert.equal(v.state(T).driver, "B", "a viewer without a want does not drive");
  // A non-viewer's input and want do nothing.
  v.input(T, "X");
  v.want(T, "X", 10, 10);
  assert.equal(v.state(T).driver, "B");
  assert.deepEqual(S(h, T), [80, 24]);

  // take: the phone's "fit to phone".
  v.take(T, "P", 50, 20);
  assert.deepEqual([...S(h, T), v.state(T).driver], [50, 20, "P"]);
  assert.throws(() => v.take(T, "X", 50, 20), fails("notViewing"), "only a viewer takes the size");
  for (const [c, r] of [[0, 10], [10, 0], [1001, 10], [10.5, 10], ["10", 10], [null, 1]]) {
    assert.throws(() => v.take(T, "P", c, r), fails("invalidData"), `take ${c}x${r}`);
    assert.throws(() => v.want(T, "A", c, r), fails("invalidData"), `want ${c}x${r}`);
  }

  // release: back to the viewer with a want that typed last (B typed after A).
  v.release(T, "P");
  assert.deepEqual([...S(h, T), v.state(T).driver], [80, 24, "B"], "hand-back to the last to type");
  v.release(T, "X"); // nothing to release
  v.release(T, "A"); // A gives up its want; it did not drive
  assert.equal(v.state(T).driver, "B");
  v.want(T, "A", 101, 30);

  // detach of the driver: hand-back to A (B is gone).
  v.detach(T, "B");
  assert.deepEqual([...S(h, T), v.state(T).driver], [101, 30, "A"]);
  // detach of the last viewer with a want: nobody drives, the size stays.
  v.detach(T, "A");
  assert.deepEqual([...S(h, T), v.state(T).driver], [101, 30, null], "no want left: D = null, S stays");
  assert.deepEqual(v.state(T).viewers, ["P"]);
  v.detach(T, "nobody");
  // leave: from every terminal.
  h.backend.add("t2");
  v.attach("t2", "P");
  v.take("t2", "P", 40, 10);
  v.leave("P");
  assert.deepEqual(v.state(T).viewers, []);
  assert.deepEqual(v.state("t2"), { cols: 40, rows: 10, driver: null, viewers: [] });
  // exit / close: the state goes.
  v.attach(T, "A");
  v.want(T, "A", 90, 20);
  h.backend.remove(T);
  v.prune(new Set(["t2"]));
  assert.equal(v.state(T), null, "no such terminal");
  h.backend.add(T, 90, 20);
  assert.deepEqual(v.state(T), { cols: 90, rows: 20, driver: null, viewers: [] }, "a terminal that ended takes its viewers along");
  // A size set by anyone else (the backend directly) is told once, with the driver.
  v.attach(T, "A");
  v.want(T, "A", 91, 20);
  const n = h.events.size.length;
  h.backend.resize(T, 70, 20);
  assert.deepEqual(h.events.size.slice(n), [{ id: T, cols: 70, rows: 20, driver: "A" }]);
  // Checked params.
  assert.throws(() => v.attach("nope", "A"), fails("invalidData"), "no such terminal");
  assert.throws(() => v.attach(T, 5), fails("invalidData"), "who is a string");
  assert.throws(() => v.attach("", "A"), fails("invalidData"));
  assert.equal(v.state("nope"), null);
}

// ---------- hand-back order ----------
{
  const h = makeHost(), v = h.viewers, T = "t";
  h.backend.add(T);
  v.attach(T, "A"); v.want(T, "A", 100, 30);
  h.tick(5);
  v.attach(T, "B"); v.want(T, "B", 90, 30);
  h.tick(5);
  v.attach(T, "C"); v.want(T, "C", 80, 30);
  // Nobody typed: the one that attached last.
  v.detach(T, "A");
  assert.equal(v.state(T).driver, "C", "no input: the latest attachedAt");
  assert.deepEqual(S(h, T), [80, 30]);
  // A driver that never typed holds nothing: B's input takes over at once.
  h.tick(5);
  v.input(T, "B");
  assert.equal(v.state(T).driver, "B");
  assert.deepEqual(S(h, T), [90, 30]);
  // A attaches again (latest attachedAt); B leaves: A and C never typed, so the later attach wins.
  h.tick(5);
  v.attach(T, "A"); v.want(T, "A", 100, 30);
  v.detach(T, "B");
  assert.equal(v.state(T).driver, "A");
  // C types, then the driver gives the size back: C typed last.
  h.tick(5);
  v.input(T, "C"); // A never typed: C takes over
  assert.equal(v.state(T).driver, "C");
  h.tick(5);
  v.input(T, "A"); // C typed 5 ms ago: within HOLD, A only marks its input
  assert.equal(v.state(T).driver, "C");
  v.release(T, "C");
  assert.equal(v.state(T).driver, "A", "A typed after C");
  // Same time and same attach time: the later attach order decides.
  const g = makeHost();
  g.backend.add(T);
  g.viewers.attach(T, "X"); g.viewers.attach(T, "Y");
  g.viewers.want(T, "X", 50, 10); g.viewers.want(T, "Y", 60, 10);
  g.viewers.detach(T, "X");
  assert.equal(g.viewers.state(T).driver, "Y");
}

// ---------- this computer's own window (who "") is a viewer like any ----------
{
  const h = makeHost(), v = h.viewers, T = "t";
  h.backend.add(T);
  v.attach(T, "", { kind: "desktop" });
  v.want(T, "", 100, 30);
  assert.equal(v.state(T).driver, "");
  v.attach(T, "peer");
  v.take(T, "peer", 50, 20);
  v.detach(T, "peer");
  assert.deepEqual([...S(h, T), v.state(T).driver], [100, 30, ""], "hand-back to the window");
  v.attach(T, "peer");
  v.take(T, "peer", 50, 20);
  v.leave("peer");
  assert.deepEqual([...S(h, T), v.state(T).driver], [100, 30, ""], "and when the peer's link drops");
}

// ---------- MAX_VIEWERS ----------
{
  const h = makeHost(), v = h.viewers;
  h.backend.add("t");
  for (let i = 0; i < MAX_VIEWERS; i++) v.attach("t", `n${i}`);
  assert.throws(() => v.attach("t", "one-more"), fails("tooManyViewers"));
  v.attach("t", "n3"); // one already there attaches again
  v.detach("t", "n3");
  v.attach("t", "one-more");
  assert.equal(v.state("t").viewers.length, MAX_VIEWERS);
  assert.equal(MAX_VIEWERS, 16);
}

// ---------- no ping-pong ----------
{
  // Two panes that fit again and again with different sizes: the first one drives, the second is only remembered.
  const h = makeHost(), v = h.viewers;
  h.backend.add("t");
  v.attach("t", "A"); v.attach("t", "B");
  for (let i = 0; i < 50; i++) {
    v.want("t", "A", 100 + (i % 3), 30);
    v.want("t", "B", 60 + (i % 5), 20);
    h.tick(100);
  }
  assert.equal(v.state("t").driver, "A");
  assert.ok(h.sizes.get("t").cols >= 100, "B's fits never applied");

  // Random sequences of want / attach / detach from three viewers, no input or take: the size changes only for a
  // want of the driver (or with nobody driving - then the sender drives) and for a hand-back when the driver leaves.
  let seed = 7;
  const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let run = 0; run < 200; run++) {
    const r = makeHost(), w = r.viewers, T = "t";
    r.backend.add(T);
    for (let step = 0; step < 60; step++) {
      const who = ["A", "B", "C"][rand(3)], op = rand(3);
      const d0 = w.state(T).driver, s0 = S(r, T).join("x"), viewing = w.state(T).viewers.includes(who);
      if (op === 0) w.attach(T, who);
      else if (op === 1) w.want(T, who, 40 + rand(60), 10 + rand(30));
      else w.detach(T, who);
      r.tick(rand(3000));
      const d1 = w.state(T).driver, s1 = S(r, T).join("x");
      if (op === 0) assert.ok(s0 === s1 && d0 === d1, "attach changes neither size nor driver");
      if (op === 1) {
        if (!viewing) assert.ok(s0 === s1 && d0 === d1, "a non-viewer's want does nothing");
        else if (d0 === null || d0 === who) assert.equal(d1, who, "the sender drives");
        else assert.ok(s0 === s1 && d0 === d1, "a want from one that does not drive is only remembered");
      }
      if (op === 2 && d0 !== who) assert.ok(s0 === s1 && d0 === d1, "a viewer that did not drive leaves the size alone");
      if (d1 !== null) assert.ok(w.state(T).viewers.includes(d1), "the driver is a viewer");
    }
  }
}

// ---------- the terminal's own answers are no one's typing (isReport) ----------
// Every automatic answer of xterm.js 6 (common/InputHandler.ts, browser/CoreBrowserTerminal.ts), exactly as it sends
// it; and the keys, pastes and mouse reports a person makes - none of which may pass for an answer.
{
  const answers = {
    "cursor position (DSR 6), ConPTY's start": "\x1b[1;1R",
    "cursor position": "\x1b[24;80R",
    "cursor position, row 1 past column 16": "\x1b[1;17R",
    "cursor position, row 2 column 5": "\x1b[2;5R",
    "cursor position, big": "\x1b[999;999R",
    "DECXCPR (DSR ?6)": "\x1b[?3;7R",
    "DECXCPR row 1 (never a key)": "\x1b[?1;5R",
    "ready (DSR 5)": "\x1b[0n",
    "DA1": "\x1b[?1;2c",
    "DA1 vt100": "\x1b[?6c",
    "DA2 xterm": "\x1b[>0;276;0c",
    "DA2 rxvt": "\x1b[>85;95;0c",
    "DA2 screen": "\x1b[>83;40003;0c",
    "DECRQM private": "\x1b[?2004;2$y",
    "DECRQM ansi": "\x1b[4;0$y",
    "XTWINOPS 14t": "\x1b[4;600;800t",
    "XTWINOPS 16t": "\x1b[6;17;9t",
    "XTWINOPS 18t": "\x1b[8;30;120t",
    "focus in": "\x1b[I",
    "focus out": "\x1b[O",
    "OSC 11 with ST": "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\",
    "OSC 10 with BEL": "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "OSC 4": "\x1b]4;1;rgb:cdcd/3131/3131\x1b\\",
    "OSC 12": "\x1b]12;rgb:ffff/ffff/ffff\x1b\\",
    "DECRQSS SGR": "\x1bP1$r0m\x1b\\",
    "DECRQSS cursor style": "\x1bP1$r2 q\x1b\\",
    "DECRQSS conformance": "\x1bP1$r61;1\"p\x1b\\",
    "DECRQSS invalid": "\x1bP0$r\x1b\\",
    "DA3 / XTVERSION style DCS": "\x1bP>|xterm.js(6.0.0)\x1b\\",
    "several at once (a replayed scrollback)": "\x1b[1;1R\x1b[?1;2c\x1b[0n\x1b]11;rgb:0000/0000/0000\x1b\\"
  };
  for (const [what, data] of Object.entries(answers)) assert.equal(isReport(data), true, `${what}: ${JSON.stringify(data)}`);
  const typing = {
    "a letter": "a", "a word": "ls -la", "Cyrillic": "щ", Enter: "\r", Backspace: "\x7f", "Ctrl+C": "\x03",
    Esc: "\x1b", "Alt+x": "\x1bx", "Alt+Backspace": "\x1b\x7f", "Alt+[": "\x1b[", "Alt+]": "\x1b]", "Alt+Shift+O": "\x1bO", "Alt+Shift+P": "\x1bP",
    up: "\x1b[A", "Ctrl+left": "\x1b[1;5D", "Shift+Tab": "\x1b[Z", Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~", F5: "\x1b[15~",
    F3: "\x1bOR", "Shift+F3": "\x1b[1;2R", "Ctrl+F3": "\x1b[1;5R", "Ctrl+Alt+Shift+F3 (mod 8)": "\x1b[1;8R", "Meta+... F3 (mod 16)": "\x1b[1;16R",
    "Ctrl+F1": "\x1b[1;5P", "Ctrl+F4": "\x1b[1;5S",
    paste: "\x1b[200~echo hi\r\x1b[201~", "plain paste": "hello\rworld",
    "SGR mouse press": "\x1b[<0;10;5M", "SGR mouse release": "\x1b[<0;10;5m", "SGR wheel": "\x1b[<64;3;4M", "X10 mouse": "\x1b[M !!",
    "typing then an answer": "ls\x1b[2;21R", "an answer then typing": "\x1b[2;21Rls", "an answer and a key": "\x1b[I\x1b[A",
    "an OSC without its end": "\x1b]11;rgb:0/0/0", "a DCS without its end": "\x1bP1$r0m",
    empty: ""
  };
  for (const [what, data] of Object.entries(typing)) assert.equal(isReport(data), false, `${what}: ${JSON.stringify(data)}`);
  for (const odd of [null, undefined, 42, {}, "\x1b[1;1R".repeat(1000)]) assert.equal(isReport(odd), false, "not a string, or too long to be an answer");
}

// ---------- tab-links: /clear starts a new session in the same terminal (4.8) ----------
(async () => {
  const tabs = [
    { id: "tab-1", pid: 100, agent: "Claude", sessionId: "old", exited: false }, // its session is gone
    { id: "tab-2", pid: 200, agent: "Claude", sessionId: "keep", exited: false }, // its session lives
    { id: "tab-3", pid: 300, agent: "Codex", sessionId: "cx-old", exited: false }, // Codex: linked by its log
    { id: "tab-4", pid: 400, agent: "", sessionId: "", exited: false } // not linked yet
  ];
  const links = [];
  const terminals = {
    getTabs: () => tabs,
    getUnlinkedTabs: () => tabs.filter(x => !x.sessionId).map(x => ({ id: x.id, pid: x.pid })),
    link: (id, agent, sessionId, opts) => {
      links.push([id, agent, sessionId, Boolean(opts?.replace)]);
      Object.assign(tabs.find(x => x.id === id), { agent, sessionId });
    }
  };
  // The processes: the new Claude session runs under tab-1's DockPty, a Codex one under tab-3, a Claude one under
  // tab-4, and an OpenCode one under tab-1 too (another agent: not taken).
  const live = [
    { agent: "Claude", id: "keep", pid: 201 },
    { agent: "Claude", id: "new", pid: 101 },
    { agent: "OpenCode", id: "oc", pid: 102 },
    { agent: "Codex", id: "cx-new", pid: 301 },
    { agent: "Claude", id: "fresh", pid: 401 }
  ];
  const parents = new Map([[101, 100], [102, 100], [201, 200], [301, 300], [401, 400]]);
  const tl = createTabLinks({ terminals, liveSessions: async () => live, parentMap: async () => parents });
  await tl.linkTabs();
  assert.deepEqual(links.sort(), [["tab-1", "Claude", "new", true], ["tab-4", "Claude", "fresh", false]].sort());
  assert.equal(tabs[1].sessionId, "keep", "a live session keeps its tab");
  assert.equal(tabs[2].sessionId, "cx-old", "Codex is left to codex-live.js");
  // Nothing new: nothing linked again.
  links.length = 0;
  await tl.linkTabs();
  assert.deepEqual(links, []);
  console.log("terminal viewers: the 4.3 table, HOLD, hand-back order, MAX_VIEWERS, no ping-pong (200 random runs), the terminal's own answers (isReport), tab relink after /clear - passed");
})().catch(e => {
  console.error(e);
  process.exit(1);
});
