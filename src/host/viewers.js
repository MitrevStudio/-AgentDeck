// Who has a terminal of this host open, and whose size it has (docs/SHARED-SESSIONS.md 4.3). A terminal belongs to
// the host; devices attach to it and detach, as in tmux. A viewer is one device with a view of the terminal: a pane of
// this computer's own window (who ""), or a peer (who: its node id) - a desktop's pane, a phone's open terminal
// screen. The terminal has one size; the viewer it follows is the driver.
//
// Per terminal: the driver D (a viewer, or null), and per viewer the size it wants (its pane's fit; none for a phone
// until "fit to phone"), when it last typed (inputAt) and when it attached (attachedAt). Applying a size W resizes the
// terminal, unless it has that size already.
//   attach(A)        A becomes a viewer, without a want. Neither the size nor D change.
//   want(A, W)       A wants W (a pane's fit): applied when A drives, or nobody does - then A drives. Otherwise only
//                    remembered.
//   input(A)         A typed (a person's keystrokes): A drives - its want applied - when it wants a size and D is
//                    nobody, gone, or has not typed for HOLD_MS. A viewer without a want (a phone) never takes over.
//   take(A, W)       "Use my size" / "fit to phone": A wants W, drives, and W applies.
//   release(A)       A wants nothing any more; if it drove, the size is handed back.
//   detach(A)        A goes (leave(A): from every terminal, its link dropped); if it drove, the size is handed back.
//   hand-back        D becomes the viewer with a want that typed last (then the one that attached last), and its want
//                    applies; with none, D is null and the size stays as it is.
// Typing by AgentDeck itself (terminals.type: autopilot, terminals.send, send-text.js) is not input here.
//
// No ping-pong: the automatic events (attach, want) change the size only when their viewer drives or nobody does, and
// then that viewer drives - so a second pane that fits again and again is only remembered. D changes only on a person's
// act (input after HOLD_MS, take, release) or a detach.
//
// The size itself is the backend's (terminals.js, terminals-pty.js): size(id) reads it, resize(id, cols, rows) sets it,
// and the backend's own size events come back through sized(id). onSize({ id, cols, rows, driver }) whenever the size
// or the driver changed - once per change, also for a size set by anyone else; onChange(id) when the viewers or the
// driver changed (the host sends its tabs again). Nothing here knows the peers' names, or that a peer is a peer.
const { HostError } = require("./errors");

const MAX_VIEWERS = 16;
const HOLD_MS = 2000;
const MAX_SIZE = 1000; // the backends' bound
const MAX_WHO = 200;

// resize(id, cols, rows); size(id) -> { cols, rows } | null (no such terminal); now(): the clock (tests).
function createViewers({ resize, size, onSize = () => {}, onChange = () => {}, now = Date.now, maxViewers = MAX_VIEWERS, holdMs = HOLD_MS }) {
  const terms = new Map(); // id -> { driver, viewers: Map(who -> { kind, want, inputAt, attachedAt, order }) }
  let order = 0, busy = 0;

  const isWho = who => typeof who === "string" && who.length <= MAX_WHO;
  const isId = id => typeof id === "string" && id.length > 0 && id.length <= 64;
  function checkSize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_SIZE || rows > MAX_SIZE) throw new HostError("invalidData");
    return { cols, rows };
  }
  const viewerOf = (id, who) => terms.get(id)?.viewers.get(who) || null;

  // Runs a change of one terminal's viewers; then tells, once, what came of it.
  function change(id, fn) {
    const before = snapshot(id);
    busy++;
    let changed;
    try {
      changed = fn();
    } finally {
      busy--;
    }
    const after = snapshot(id);
    if (before && after && (before.cols !== after.cols || before.rows !== after.rows || before.driver !== after.driver)) {
      onSize({ id, cols: after.cols, rows: after.rows, driver: after.driver });
    }
    if (changed || before?.driver !== after?.driver) onChange(id);
  }
  function snapshot(id) {
    const s = size(id);
    return s ? { cols: s.cols, rows: s.rows, driver: terms.get(id)?.driver ?? null } : null;
  }
  // "Apply W": nothing when the terminal has that size already.
  function apply(id, want) {
    const s = size(id);
    if (want && s && (s.cols !== want.cols || s.rows !== want.rows)) resize(id, want.cols, want.rows);
  }
  function handBack(id) {
    const t = terms.get(id);
    // who "" (this computer's window) is a viewer like any: compared with null, never by truth.
    let best = null;
    for (const [who, v] of t.viewers) {
      if (!v.want) continue;
      const b = best === null ? null : t.viewers.get(best);
      if (!b || v.inputAt > b.inputAt || (v.inputAt === b.inputAt && (v.attachedAt > b.attachedAt || (v.attachedAt === b.attachedAt && v.order > b.order)))) best = who;
    }
    t.driver = best;
    if (best !== null) apply(id, t.viewers.get(best).want);
  }

  // -> { cols, rows, driver }. A viewer already attached stays as it is (attaching again after a resync).
  function attach(id, who, { kind = "" } = {}) {
    if (!isId(id) || !isWho(who) || !size(id)) throw new HostError("invalidData");
    let t = terms.get(id);
    if (!t?.viewers.has(who)) {
      if (t && t.viewers.size >= maxViewers) throw new HostError("tooManyViewers");
      change(id, () => {
        if (!t) terms.set(id, t = { driver: null, viewers: new Map() });
        t.viewers.set(who, { kind: typeof kind === "string" ? kind.slice(0, 16) : "", want: null, inputAt: 0, attachedAt: now(), order: ++order });
        return true;
      });
    }
    const s = snapshot(id);
    return { cols: s.cols, rows: s.rows, driver: s.driver };
  }
  function detach(id, who) {
    const t = terms.get(id);
    if (!t?.viewers.has(who)) return;
    change(id, () => {
      t.viewers.delete(who);
      if (t.driver === who) handBack(id);
      if (!t.viewers.size) terms.delete(id);
      return true;
    });
  }
  // A link dropped: the device goes from every terminal.
  function leave(who) {
    for (const [id, t] of [...terms]) if (t.viewers.has(who)) detach(id, who);
  }
  function want(id, who, cols, rows) {
    const v = viewerOf(id, who);
    if (!v) return;
    const w = checkSize(cols, rows);
    change(id, () => {
      const t = terms.get(id);
      v.want = w;
      if (t.driver === who || t.driver === null) {
        t.driver = who;
        apply(id, w);
      }
    });
  }
  function input(id, who) {
    const v = viewerOf(id, who);
    if (!v) return;
    const t = terms.get(id), at = now();
    v.inputAt = at;
    if (!v.want || t.driver === who) return;
    const d = t.driver === null ? null : t.viewers.get(t.driver);
    // A driver that never typed (inputAt 0) holds nothing.
    if (d && d.inputAt && at - d.inputAt < holdMs) return;
    change(id, () => {
      t.driver = who;
      apply(id, v.want);
    });
  }
  // Refused (notViewing) for one that is not a viewer: only a viewer can draw the terminal in its size. A device asks
  // this way when its take overtook its attach (just reconnected); it attaches and asks again.
  function take(id, who, cols, rows) {
    const v = viewerOf(id, who);
    if (!v) throw new HostError("notViewing");
    const w = checkSize(cols, rows);
    change(id, () => {
      v.want = w;
      terms.get(id).driver = who;
      apply(id, w);
    });
  }
  function release(id, who) {
    const v = viewerOf(id, who);
    if (!v) return;
    change(id, () => {
      v.want = null;
      if (terms.get(id).driver === who) handBack(id);
    });
  }
  // -> { cols, rows, driver, viewers: [who] } | null (no such terminal).
  function state(id) {
    const s = snapshot(id);
    return s && { ...s, viewers: [...(terms.get(id)?.viewers.keys() || [])] };
  }
  // The viewers as a tab lists them: [{ who, kind }], in the order they attached.
  const list = id => [...(terms.get(id)?.viewers || [])].map(([who, v]) => ({ who, kind: v.kind }));
  const driverOf = id => terms.get(id)?.driver ?? null;
  // The backend changed the size (whoever asked for it): told once, unless it is part of a change here.
  function sized(id) {
    if (busy) return;
    const s = snapshot(id);
    if (s) onSize({ id, ...s });
  }
  // A terminal that ended or was closed: its viewers go with it. alive: the ids that still run.
  function prune(alive) {
    for (const id of [...terms.keys()]) if (!alive.has(id)) terms.delete(id);
  }

  return { attach, detach, leave, want, input, take, release, state, list, driverOf, sized, prune };
}

// Input that is only the terminal's own answers to a program's questions, which xterm.js sends by itself - also for a
// question it replays from a scrollback (ConPTY asks for the cursor position as every terminal starts, so every new
// view of a terminal answers it). They are written to the terminal like any input, but they are no one's typing: they
// must not make a viewer the driver (input above), nor count as having typed (lastInputAt, "reopened" seen to).
// The answers of xterm.js 6 (common/InputHandler.ts, browser/CoreBrowserTerminal.ts), one or more in a row:
//   CSI r;c R           cursor position (DSR 6). Not CSI 1;m R with m 2..16: that is F3 with Shift/Ctrl/Alt (xterm.js
//                       sends modified F1-F4 as CSI 1;m P..S), a key - a cursor at row 1, columns 2-16 counts as typing
//   CSI ? r;c R         the same for DECXCPR (DSR ?6)
//   CSI 0 n             "ready" (DSR 5)
//   CSI ? ... c, CSI > ... c, CSI = ... c   device attributes (DA1, DA2, DA3)
//   CSI ? m;v $y, CSI m;v $y               a mode's state (DECRQM)
//   CSI 4;h;w t, CSI 6;h;w t, CSI 8;r;c t  window and cell sizes in pixels, the text area in cells (XTWINOPS)
//   CSI I, CSI O        focus in, focus out (DECSET 1004) - the view getting the focus, not a key
//   OSC ... BEL|ST      colour answers (OSC 4/10/11/12)
//   DCS ... ST          setting answers (DECRQSS), DA3's id
// Not answers: keys (CSI A, CSI 1;5A, CSI 15~, ...), a paste (CSI 200~ ... CSI 201~), mouse reports (CSI < ... M/m, CSI
// M...) - a person's acts on the terminal - and any input with something else besides.
const REPORT = "(?:\\x1b\\[(?!1;(?:[2-9]|1[0-6])R)\\d+;\\d+R|\\x1b\\[\\?\\d+;\\d+R|\\x1b\\[0n|\\x1b\\[[?>=][\\d;]*c|\\x1b\\[\\??\\d+;\\d+\\$y"
  + "|\\x1b\\[[468];\\d+;\\d+t|\\x1b\\[[IO]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|\\x1bP[^\\x1b]*\\x1b\\\\)";
const REPORTS = new RegExp(`^${REPORT}+$`);
const isReport = data => typeof data === "string" && data.length > 0 && data.length <= 4096 && REPORTS.test(data);

module.exports = { createViewers, isReport, MAX_VIEWERS, HOLD_MS };
