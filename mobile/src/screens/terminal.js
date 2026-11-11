// A terminal on one of the computers, drawn by xterm.js at the HOST's size (MOBILE.md §6): the phone does not resize
// it. It opens at a readable font, scrolled to the cursor (the bottom-left of the screen), and the view pans in both
// directions with one finger; a pinch zooms (the font is set anew when the fingers lift, so the text stays sharp),
// a double tap switches between the whole width and the readable size, a single tap brings up the keyboard. While
// typing, the cursor is kept in view. Dragging down at the top scrolls back through the terminal's history.
// Landscape fits more: the whole width gets a bigger font, the readable size shows more columns.
// "Fit to phone" is the one thing that resizes the host's terminal - to what fits here at the readable size - and
// pressing it again gives the host its size back; so does leaving (the view detaches, the host refits its pane).
// Leaving ends nothing: a shell this phone opened keeps running, and the toast says where it is listed (Terminals);
// only the X in the header closes the terminal, after a confirmation.
// The view outlives a lost link: it says so, and draws the screen again once it is attached anew.
import { Terminal } from "@xterm/xterm";
import { t } from "../i18n.js";
import { esc, KEYS } from "../util.js";
import { iconBtn } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { keyStrip } from "./keys.js";

const READ_PX = 12;           // a readable font on a phone; also what "Fit to phone" sizes the host's terminal for
const MIN_PX = 3, MAX_PX = 30;
const PAD = 4;                // the wrap's padding around the terminal
const TAP_MS = 300, DOUBLE_MS = 320, MOVE_PX = 8;
const FONT = '"Cascadia Mono", "JetBrains Mono", "Roboto Mono", "Droid Sans Mono", ui-monospace, Menlo, Consolas, monospace';

// The zoom the user chose last, kept while the app runs: "read" (readable), "fit" (whole width) or a font size.
let lastZoom = "read";

// [label or icon, what it sends] (keys.js); "Ctrl" is index 2 (setCtrl lights it).
const XKEYS = [
  ["Esc", KEYS.esc], ["tab", KEYS.tab], ["Ctrl", "ctrl"], ["^C", KEYS.ctrlC],
  ["up", KEYS.up], ["down", KEYS.down], ["left", KEYS.left], ["right", KEYS.right],
  ["1", "1"], ["2", "2"], ["3", "3"], ["/", "/"], ["-", "-"], ["~", "~"], ["enter", KEYS.enter]
];

// The terminal colours from the theme tokens (theme.css), as the desktop's terminals take them.
function themeFromCss() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(`--term-${name}`).trim() || undefined;
  const ansi = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const theme = { background: v("bg"), foreground: v("fg"), cursor: v("cursor"), selectionBackground: v("selection") };
  for (const c of ansi) {
    theme[c] = v(`ansi-${c}`);
    theme[`bright${c[0].toUpperCase()}${c.slice(1)}`] = v(`ansi-bright-${c}`);
  }
  return theme;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function render(el, ctx, p) {
  const store = ctx.store;
  const nodeName = store.nodeName(p.node);
  el.innerHTML = `<div class="term-head"></div>
    <main class="term-wrap"><div class="term-pan"><div class="term-host"></div></div></main>
    <div class="term-over" hidden></div>
    <textarea class="term-input" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="enter" aria-label="${esc(t("term.keyboard"))}"></textarea>
    ${keyStrip(XKEYS, "xkeys")}`;
  const head = el.querySelector(".term-head"), wrap = el.querySelector(".term-wrap"), pan = el.querySelector(".term-pan"), hostEl = el.querySelector(".term-host"), over = el.querySelector(".term-over");

  const term = new Terminal({
    // cursorInactiveStyle: xterm never has the focus here (the keyboard types into .term-input), so its cursor is
    // drawn as when focused.
    cols: 120, rows: 30, fontFamily: FONT, fontSize: READ_PX, lineHeight: 1, scrollback: 3000, cursorBlink: false, cursorInactiveStyle: "block",
    allowProposedApi: true, theme: themeFromCss(), macOptionIsMeta: true, convertEol: false
  });
  term.open(hostEl);
  // xterm draws no cursor until its own textarea was focused once ("cursor initialized"), which never happens here.
  // Private field (xterm 6 CoreService); without it the view merely shows no cursor.
  try { term._core.coreService.isCursorInitialized = true; } catch {}

  let handle = null, ctrl = false, fitted = null; // fitted: the host's own size while "Fit to phone" is on
  let hostCols = 120, hostRows = 30, closed = false, closedHere = false;
  let zoom = lastZoom;                            // "read" | "fit" | a font size (px)
  let overState = "";                             // what the overlay says: "" | "exited" | "reconnecting" | "gone"

  function drawHead() {
    head.innerHTML = header(p.title || t("session.terminal"), {
      back: true,
      sub: `${esc(nodeName)} · ${esc(t("term.hostSize", { cols: hostCols, rows: hostRows }))}`,
      actions: iconBtn("fit", t(fitted ? "term.unfit" : "term.fit"), 'data-act="fit"', fitted ? "on" : "")
        + iconBtn("keyboard", t("term.keyboard"), 'data-act="kb"')
        + iconBtn("x", t("term.close"), 'data-act="close"', "danger")
    });
    wireBack(head, ctx);
    head.querySelector("[data-act='fit']").onclick = toggleFit;
    const kb = head.querySelector("[data-act='kb']");
    kb.onpointerdown = e => e.preventDefault(); // pressing it does not take the focus from the field first
    kb.onclick = () => {
      if (keyboardUp()) input.blur(); else showKeyboard();
    };
    head.querySelector("[data-act='close']").onclick = async () => {
      if (!await ctx.confirm(t("term.closeAsk", { name: nodeName }), t("term.close"), { danger: true })) return;
      try { await store.closeTerminal(p.node, p.term); closedHere = true; ctx.back(); } catch (e) { ctx.fail(e); }
    };
  }
  function say(state) {
    overState = state;
    over.hidden = !state;
    over.textContent = state === "exited" ? t("term.exited") : state === "reconnecting" ? t("term.reconnecting") : state === "gone" ? t("term.gone") : "";
  }

  // ---------- the size and the zoom ----------
  // One cell in CSS px at the current font (measured: fonts do not scale exactly linearly).
  function cell() {
    const s = term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    if (!s?.width) return { w: term.options.fontSize * 0.6, h: term.options.fontSize * 1.2 };
    return { w: s.width / term.cols, h: s.height / term.rows };
  }
  const availW = () => Math.max(40, wrap.clientWidth - 2 * PAD);
  const availH = () => Math.max(40, wrap.clientHeight - 2 * PAD);
  // The font that makes the host's columns as wide as the screen.
  function fitPx() {
    const k = cell().w / term.options.fontSize;
    return Math.floor((availW() / (term.cols * k)) * 10) / 10;
  }
  const readPx = () => Math.max(READ_PX, fitPx());
  const targetPx = () => (zoom === "fit" ? fitPx() : zoom === "read" ? readPx() : clamp(zoom, Math.min(fitPx(), READ_PX), MAX_PX));

  // Sets the font; anchor { x, y } (a point in the wrap's view) stays over the same text.
  function setFont(px, anchor = null) {
    px = clamp(Math.round(px * 10) / 10, MIN_PX, MAX_PX);
    const before = cell(), sl = wrap.scrollLeft, st = wrap.scrollTop;
    if (Math.abs(px - term.options.fontSize) >= 0.05) term.options.fontSize = px;
    // The whole width really in (hinting, rounding).
    for (let i = 0; i < 12 && zoom === "fit" && cell().w * term.cols > availW() && term.options.fontSize > MIN_PX; i++) {
      term.options.fontSize = Math.round((term.options.fontSize - 0.1) * 10) / 10;
    }
    if (anchor) {
      const after = cell();
      wrap.scrollLeft = (sl + anchor.x) * (after.w / before.w) - anchor.x;
      wrap.scrollTop = (st + anchor.y) * (after.h / before.h) - anchor.y;
    }
  }
  const applyZoom = anchor => setFont(targetPx(), anchor);

  // The cursor in view: the bottom-left of the screen when the cursor is there, else just enough to show it.
  function ensureCursor({ snapLeft = false } = {}) {
    const b = term.buffer.active;
    if (b.viewportY !== b.baseY) return; // the user is reading the history
    const c = cell();
    const x = PAD + b.cursorX * c.w, y = PAD + b.cursorY * c.h;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (snapLeft && x + 2 * c.w <= W) wrap.scrollLeft = 0;
    else if (x < wrap.scrollLeft + c.w || x + 2 * c.w > wrap.scrollLeft + W) wrap.scrollLeft = Math.max(0, x - W * 0.7);
    if (y < wrap.scrollTop) wrap.scrollTop = Math.max(0, y - c.h);
    else if (y + 2 * c.h > wrap.scrollTop + H) wrap.scrollTop = y + 2 * c.h - H;
  }
  // The bottom of the screen and the cursor: how the view opens.
  function home() {
    wrap.scrollTop = wrap.scrollHeight;
    wrap.scrollLeft = 0;
    ensureCursor({ snapLeft: true });
  }

  function setHostSize(cols, rows) {
    hostCols = cols; hostRows = rows;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    applyZoom();
    drawHead();
  }

  async function toggleFit() {
    if (!handle) return;
    if (fitted) {
      const { cols, rows } = fitted;
      fitted = null;
      handle.resize(cols, rows);
      setHostSize(cols, rows);
      ctx.toast(t("term.fitted", { cols, rows }));
      return;
    }
    // What fits here at the readable font.
    const c = cell(), k = READ_PX / term.options.fontSize;
    const cols = Math.max(20, Math.floor(availW() / (c.w * k))), rows = Math.max(5, Math.floor(availH() / (c.h * k)));
    fitted = { cols: hostCols, rows: hostRows };
    zoom = "fit";
    handle.resize(cols, rows);
    setHostSize(cols, rows);
    home();
    ctx.toast(t("term.fitted", { cols, rows }));
  }

  // ---------- touch: pan, pinch, taps ----------
  let g = null, tapTimer = 0, lastTap = null, scrollAcc = 0, kbRaisedAt = 0;
  const pt = (touch, r = wrap.getBoundingClientRect()) => ({ x: touch.clientX - r.left, y: touch.clientY - r.top });
  // A drag's vertical part: the view first, what is left over scrolls the terminal's history.
  function panBy(dx, dy) {
    wrap.scrollLeft -= dx;
    const want = wrap.scrollTop - dy;
    wrap.scrollTop = want;
    const rest = want - wrap.scrollTop; // < 0: past the top (history), > 0: past the bottom
    if (!rest) { scrollAcc = 0; return; }
    scrollAcc += rest;
    const h = cell().h, lines = Math.trunc(scrollAcc / h);
    if (lines) { term.scrollLines(lines); scrollAcc -= lines * h; }
  }
  function toggleZoomAt(at) {
    const fit = fitPx();
    const atFit = zoom === "fit" || Math.abs(term.options.fontSize - fit) < 0.3;
    zoom = atFit ? "read" : "fit";
    if (zoom === "read" && readPx() - fit < 0.3) zoom = "fit"; // nothing to zoom: the whole width is readable already
    lastZoom = zoom;
    applyZoom(at);
    if (zoom === "fit") wrap.scrollLeft = 0;
    ctx.toast(t(zoom === "fit" ? "term.zoomFit" : "term.zoomRead"));
  }
  wrap.addEventListener("touchstart", e => {
    const r = wrap.getBoundingClientRect();
    if (e.touches.length === 1) {
      const a = pt(e.touches[0], r);
      g = { kind: "pan", x0: a.x, y0: a.y, x: a.x, y: a.y, moved: false, t0: Date.now() };
    } else if (e.touches.length === 2) {
      clearTimeout(tapTimer);
      const a = pt(e.touches[0], r), b = pt(e.touches[1], r);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      g = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, px0: term.options.fontSize, cx, cy, scale: 1 };
      pan.style.transformOrigin = `${wrap.scrollLeft + cx}px ${wrap.scrollTop + cy}px`;
    }
  }, { passive: true });
  wrap.addEventListener("touchmove", e => {
    if (!g) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    if (g.kind === "pan" && e.touches.length === 1) {
      const a = pt(e.touches[0], r);
      if (!g.moved && Math.hypot(a.x - g.x0, a.y - g.y0) < MOVE_PX) return;
      g.moved = true;
      panBy(a.x - g.x, a.y - g.y);
      g.x = a.x; g.y = a.y;
    } else if (g.kind === "pinch" && e.touches.length === 2) {
      const a = pt(e.touches[0], r), b = pt(e.touches[1], r);
      const px = clamp(g.px0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, Math.min(fitPx(), READ_PX), MAX_PX);
      g.scale = px / g.px0;
      pan.style.transform = `scale(${g.scale})`;
    }
  }, { passive: false });
  wrap.addEventListener("touchend", e => {
    if (!g) return;
    if (g.kind === "pinch") {
      if (e.touches.length) return; // the pinch ends with the last finger
      pan.style.transform = "";
      zoom = Math.abs(g.px0 * g.scale - fitPx()) < 0.3 ? "fit" : g.px0 * g.scale;
      lastZoom = zoom;
      applyZoom({ x: g.cx, y: g.cy });
      g = null;
      return;
    }
    const tap = !g.moved && Date.now() - g.t0 < 400;
    const at = { x: g.x0, y: g.y0 };
    g = null;
    if (!tap) return;
    e.preventDefault(); // no emulated click: the taps are handled here
    if (lastTap && Date.now() - lastTap.t < DOUBLE_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      // A slow double tap: the first one brought the keyboard up already - it goes again.
      if (Date.now() - kbRaisedAt < DOUBLE_MS + TAP_MS) input.blur();
      lastTap = null;
      toggleZoomAt(at);
      return;
    }
    lastTap = { ...at, t: Date.now() };
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { if (!keyboardUp()) { kbRaisedAt = Date.now(); showKeyboard(); } }, TAP_MS);
  }, { passive: false });
  wrap.addEventListener("touchcancel", () => { pan.style.transform = ""; g = null; });
  // A mouse / trackpad (the browser preview, a tablet): the wheel pans, Ctrl+wheel zooms.
  wrap.addEventListener("wheel", e => {
    e.preventDefault();
    if (e.ctrlKey) {
      const r = wrap.getBoundingClientRect();
      zoom = clamp(term.options.fontSize * (e.deltaY < 0 ? 1.1 : 1 / 1.1), Math.min(fitPx(), READ_PX), MAX_PX);
      lastZoom = zoom;
      applyZoom({ x: e.clientX - r.left, y: e.clientY - r.top });
    } else panBy(-e.deltaX, -e.deltaY);
  }, { passive: false, capture: true });
  wrap.addEventListener("dblclick", e => {
    const r = wrap.getBoundingClientRect();
    toggleZoomAt({ x: e.clientX - r.left, y: e.clientY - r.top });
  });

  // ---------- keys ----------
  let typingUntil = 0, raf = 0;
  const followCursor = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => ensureCursor()); };
  const send = data => {
    if (!handle || closed || !handle.online) return;
    handle.write(data);
    typingUntil = Date.now() + 1500;
    followCursor();
  };
  // The sticky Ctrl from the key row turns the next letter into its control code.
  const withCtrl = data => {
    if (ctrl && data.length === 1 && /[a-z@[\\\]^_]/i.test(data)) {
      setCtrl(false);
      return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f);
    }
    return data;
  };
  // What xterm sends: its answers to the program's queries (cursor position, ...), and keys typed into its own
  // textarea (a hardware keyboard in the browser preview).
  term.onData(data => send(withCtrl(data)));

  // The soft keyboard types into a field of our own, not into xterm's textarea: Android keyboards compose words
  // (autocorrect, suggestions) and xterm loses characters on the way. Whatever the field holds after each change is
  // compared with what it held before and the difference goes out as keys - backspaces for what went, then the new
  // text - so a word the keyboard corrects is corrected in the terminal too.
  const input = el.querySelector(".term-input");
  let shadow = "", composing = false;
  const clearInput = () => { input.value = ""; shadow = ""; };
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; if (input.value.length > 200) clearInput(); });
  input.addEventListener("input", () => {
    const v = input.value;
    let i = 0;
    while (i < shadow.length && i < v.length && shadow[i] === v[i]) i++;
    const gone = shadow.length - i, added = v.slice(i);
    shadow = v;
    let out = "\x7f".repeat(gone);
    for (const ch of added) out += ch === "\n" ? "\r" : withCtrl(ch);
    if (out) send(out);
    if (added.includes("\n")) clearInput();
  });
  const SPECIAL = { Enter: "\r", Tab: KEYS.tab, Escape: KEYS.esc, ArrowUp: KEYS.up, ArrowDown: KEYS.down, ArrowLeft: KEYS.left, ArrowRight: KEYS.right, Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~" };
  input.addEventListener("keydown", e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (SPECIAL[e.key]) {
      e.preventDefault();
      send(SPECIAL[e.key]);
      if (e.key === "Enter") clearInput();
    } else if (e.key === "Backspace" && !input.value) {
      e.preventDefault();
      send("\x7f");
    } else if (e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      ctrl = true;
      send(withCtrl(e.key));
    }
  });
  const keyboardUp = () => document.activeElement === input;
  const showKeyboard = () => { input.focus({ preventScroll: true }); followCursor(); };
  const keysEl = el.querySelector(".xkeys");
  const setCtrl = on => { ctrl = on; keysEl.querySelector(`[data-k="2"]`).classList.toggle("on", on); };
  keysEl.onpointerdown = e => e.preventDefault(); // the keyboard stays up
  keysEl.onclick = e => {
    const b = e.target.closest("[data-k]");
    if (!b) return;
    const v = XKEYS[b.dataset.k][1];
    if (v === "ctrl") return setCtrl(!ctrl);
    send(v);
    if (ctrl) setCtrl(false);
  };

  // ---------- attach ----------
  // The keyboard coming up, a turn to landscape: the whole width is measured again, the cursor stays in view.
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    if (wrap.clientWidth !== lastW) { lastW = wrap.clientWidth; applyZoom(); }
    followCursor();
  });
  ro.observe(wrap);
  const offs = [];
  drawHead();
  (async () => {
    try {
      handle = await store.attach(p.node, p.term);
    } catch (e) {
      say("gone");
      if (e?.code && e.code !== "invalidData") over.textContent = `${t("term.gone")} (${e.code})`;
      return;
    }
    if (closed) return handle.detach();
    setHostSize(handle.cols, handle.rows);
    if (handle.scrollback) term.write(handle.scrollback, () => home());
    else home();
    offs.push(handle.onData(d => term.write(d, () => { if (Date.now() < typingUntil) ensureCursor(); })));
    offs.push(handle.onSize(({ cols, rows }) => setHostSize(cols, rows)));
    offs.push(handle.onState(({ online }) => { if (!online) say("reconnecting"); else if (overState === "reconnecting") say(""); }));
    offs.push(handle.onReset(({ scrollback, cols, rows }) => {
      term.reset();
      setHostSize(cols, rows);
      term.write(scrollback, () => home());
    }));
    offs.push(handle.onGone(() => say("gone")));
    if (handle.exitCode != null) say("exited");
    // The tab gone or exited on the host: say so.
    offs.push(store.on("change", () => {
      if (overState === "reconnecting" || overState === "gone") return;
      const tab = store.tab(p.node, p.term);
      if (!store.node(p.node)?.loaded) return;
      say(!tab || tab.exited ? "exited" : "");
    }));
  })();

  return () => {
    closed = true;
    clearTimeout(tapTimer);
    cancelAnimationFrame(raf);
    ro.disconnect();
    for (const off of offs) off();
    handle?.detach();
    term.dispose();
    // A shell this phone opened, left running: where it is now (an agent's terminal is found through its session).
    const tab = store.tab(p.node, p.term);
    if (!closedHere && tab && !tab.exited && !tab.agent && tab.owner && tab.owner === store.selfId) ctx.toast(t("term.keptRunning"));
  };
}
