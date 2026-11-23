// A terminal on one of the computers, drawn by xterm.js at the HOST's size (MOBILE.md §6): the phone does not resize
// it. It opens at a readable font, scrolled to the cursor (the bottom-left of the screen), and the view pans in both
// directions with one finger; a pinch zooms (the font is set anew when the fingers lift, so the text stays sharp),
// a double tap switches between the whole width and the readable size, a single tap brings up the keyboard. While
// typing, the cursor is kept in view. A drag up or down scrolls: the terminal's history, or - where a program has
// the alternate screen or the mouse (the agents do) - by what that program reads as a wheel (see "touch" below); let
// go at speed it runs on. Typing goes back to the end.
// Landscape fits more: the whole width gets a bigger font, the readable size shows more columns.
// A host size too wide to read at its whole width is said in a chip that offers "Fit to phone"; while the history
// is in view another chip goes back to the end.
// This is where a session that runs in an AgentDeck terminal opens (parts.js openSession), so what working in it
// from a phone takes is here. Under the terminal: the key row - two sets, switched at its end, an arrow repeats
// while held - and the tool row: a field for a message written with the phone's own keyboard and sent as one paste
// (with Enter or without; the draft is the session's), a picture (taken or chosen, made smaller, put on the computer,
// its path pasted), paste. In the header: the session's messages (the chat view) and "More" - Fit to phone, the text
// size (kept across restarts), copying what is on the screen or the last lines, a terminal in the same folder, the
// computer's ports (screens/ports.js: forwarded to the phone and opened in the app; an address in the terminal's text
// is never a link), Stop.
// Under the header, while the session waits for the user: what for.
// "Fit to phone" is the one thing that resizes the host's terminal - it takes the size, to what fits here at the
// readable size - and pressing it again gives the size back; so does leaving (the view detaches, and the host hands
// the size to the device that had it: docs/SHARED-SESSIONS.md 4.3). Under the title: the computer, the size and
// whose it is when not this phone's, and on a second line the other devices that have the terminal open.
// Leaving ends nothing: a shell this phone opened keeps running, and the toast says where it is listed (Terminals);
// only the X in the header closes the terminal, after a confirmation.
// The view outlives a lost link: it says so, and draws the screen again once it is attached anew.
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { t, errorText } from "../i18n.js";
import { esc, KEYS, buzz, baseName, terminalFilePath } from "../util.js";
import { getDraft, setDraft } from "../drafts.js";
import { shrink, toBase64, sizeText } from "../picture.js";
import { isIos, copyText as toClipboard, pasteText as fromClipboard, plainKeys } from "../phone.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack, closeAsk } from "./parts.js";
import { keyStrip, wireStrip } from "./keys.js";
import { openPorts } from "./ports.js";
import * as select from "../select.js";

const READ_DEFAULT = 12, READ_MIN = 8, READ_MAX = 22; // the readable font: what "Fit to phone" sizes the host's terminal for
const MIN_PX = 3, MAX_PX = 30;
const PAD = 4;                // the wrap's padding around the terminal
const TAP_MS = 300, DOUBLE_MS = 320, MOVE_PX = 8;
// Selecting text: a finger held still this long starts it; this near an edge of the view the terminal scrolls under
// the finger, a line every EDGE_MS.
const LONG_MS = 450, EDGE_PX = 28, EDGE_MS = 60;
const HANDLE_PX = 18;         // a selection handle's size (style.css .sel-handle)
// Scrolling: a wheel notch to a program for this many lines' height of a drag, at most so many notches or keys for one
// move; a fling starts above FLING_FROM px/ms (measured over the drag's last TRAIL_MS), is capped at FLING_MAX, slows
// down to 1/e in FLING_MS and ends below FLING_END.
const WHEEL_LINES = 2, STEP_MAX = 10;
const TRAIL_MS = 100, FLING_FROM = 0.25, FLING_MAX = 5, FLING_MS = 325, FLING_END = 0.03;
const FONT = '"Cascadia Mono", "JetBrains Mono", "Roboto Mono", "Droid Sans Mono", ui-monospace, Menlo, Consolas, monospace';

// How the user likes to see a terminal, kept across restarts: read - the readable font's size (px); zoom - "read"
// (that font), "fit" (the whole width) or a font size set by a pinch.
const VIEW_KEY = "agentdeck.term.view";
function loadView() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") || {}; } catch {}
  const read = Number(v.read);
  return { read: read >= READ_MIN && read <= READ_MAX ? Math.round(read) : READ_DEFAULT, zoom: v.zoom === "fit" || (typeof v.zoom === "number" && v.zoom > 0) ? v.zoom : "read" };
}
const view = loadView();
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {} };
const COPY_LINES = 200;        // "Copy the last N lines"
const KEYBOARD_PX = 120;       // the view grown by more than this: the soft keyboard went
const ENTER_AFTER_MS = 150;    // Enter after a pasted message (data.js typeInto has the same)
const MAX_PICTURE = 10 * 1024 * 1024; // what a host takes (src/host/paste.js)

// The key row's two sets, [label or icon, what it sends] (keys.js). The first is what working with an agent takes
// most - eight keys, all in view on a small phone; the second the rest, scrolling for what does not fit. "ctrl" is
// the sticky Ctrl (setCtrl lights it).
const KEYSETS = [
  [["Esc", KEYS.esc], ["tab", KEYS.tab], ["shiftTab", KEYS.shiftTab], ["up", KEYS.up], ["down", KEYS.down], ["left", KEYS.left], ["right", KEYS.right], ["enter", KEYS.enter]],
  [["Ctrl", "ctrl"], ["^C", KEYS.ctrlC], ["1", "1"], ["2", "2"], ["3", "3"], ["/", "/"], ["PgUp", KEYS.pageUp], ["PgDn", KEYS.pageDown],
    ["Home", KEYS.home], ["End", KEYS.end], ["-", "-"], ["~", "~"], ["|", "|"]]
];
const CTRL_SET = KEYSETS.findIndex(set => set.some(k => k[1] === "ctrl"));
const CTRL_KEY = KEYSETS[CTRL_SET].findIndex(k => k[1] === "ctrl");
// The arrows repeat while held: after HOLD_MS, every REPEAT_MS.
const REPEAT = new Set([KEYS.up, KEYS.down, KEYS.left, KEYS.right]);
const HOLD_MS = 380, REPEAT_MS = 70;
// The whole width of the host's size is offered a fit below this share of the readable font.
const TOO_SMALL = 0.7;

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
// What xterm sends by itself when a program asks it something (the cursor's position, its attributes, a mode, the
// focus): no one's typing.
const isAnswer = data => /^(?:\x1b\[\??\d+;\d+R|\x1b\[0n|\x1b\[[?>=][\d;]*c|\x1b\[\??\d+;\d+\$y|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/.test(data);

export function render(el, ctx, p) {
  const store = ctx.store;
  const nodeName = store.nodeName(p.node);
  el.innerHTML = `<div class="term-head"></div>
    <div class="term-area"><main class="term-wrap"><div class="term-pan"><div class="term-host"></div><i class="sel-handle a" hidden></i><i class="sel-handle b" hidden></i></div></main>
      <div class="term-sel" role="toolbar" hidden><button class="btn primary" type="button" data-act="sel-copy">${icon("copy")}<span>${esc(t("term.selCopy"))}</span></button><button class="btn" type="button" data-act="sel-lines">${esc(t("term.selLines"))}</button>${iconBtn("x", t("common.cancel"), 'type="button" data-act="sel-cancel"')}</div>
      <button class="term-chip fit" type="button" hidden>${icon("fit")}<span></span></button>
      <button class="term-chip end" type="button" hidden aria-label="${esc(t("term.toEnd"))}" title="${esc(t("term.toEnd"))}">${icon("down")}</button>
      <div class="term-busy" role="status" hidden><i class="spinner accent"></i><span></span></div></div>
    <div class="term-over" hidden></div>
    <textarea class="term-input" rows="1" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="enter" aria-label="${esc(t("term.keyboard"))}"></textarea>
    <div class="term-dock"><div class="term-keys">${KEYSETS.map((set, i) => keyStrip(set, "xkeys", i ? "hidden" : "")).join("")}
      ${iconBtn("swap", t("term.moreKeys"), 'type="button" aria-pressed="false"', "keys-swap")}</div>
    <div class="term-tools">
      <button class="compose-open" type="button" aria-label="${esc(t("term.composeOpen"))}">${icon("pencil")}<span></span></button>
      ${iconBtn("image", t("term.picture"), 'type="button" data-act="picture"')}${iconBtn("paste", t("key.paste"), 'type="button" data-act="paste"')}
    </div>
    <form class="term-compose" hidden>
      ${iconBtn("x", t("term.composeClose"), 'type="button" data-act="compose-close"')}
      <textarea rows="1" enterkeyhint="enter" autocomplete="off" placeholder="${esc(t("term.compose"))}" aria-label="${esc(t("term.composeOpen"))}"></textarea>
      ${iconBtn("insert", t("term.insert"), 'type="button" data-act="insert"')}${iconBtn("send", t("term.sendEnter"), 'type="submit"', "send")}
    </form></div>
    <input class="pick-gallery" type="file" accept="image/*" hidden><input class="pick-camera" type="file" accept="image/*" capture="environment" hidden>`;
  const head = el.querySelector(".term-head"), wrap = el.querySelector(".term-wrap"), pan = el.querySelector(".term-pan"), hostEl = el.querySelector(".term-host"), over = el.querySelector(".term-over");
  const fitChip = el.querySelector(".term-chip.fit"), endChip = el.querySelector(".term-chip.end");

  const term = new Terminal({
    // cursorInactiveStyle: xterm never has the focus here (the keyboard types into .term-input), so its cursor is
    // drawn as when focused.
    cols: 120, rows: 30, fontFamily: FONT, fontSize: view.read, lineHeight: 1, scrollback: 3000, cursorBlink: false, cursorInactiveStyle: "block",
    allowProposedApi: true, theme: themeFromCss(), macOptionIsMeta: true, convertEol: false
  });
  // Character widths as the agents count them (Unicode 11), as on the desktop: with xterm's own Unicode 6 an emoji
  // such as ✅ takes one cell where the agent gave it two, and what it draws after one is shifted.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(hostEl);
  // xterm draws no cursor until its own textarea was focused once ("cursor initialized"), which never happens here.
  // Private field (xterm 6 CoreService); without it the view merely shows no cursor.
  try { term._core.coreService.isCursorInitialized = true; } catch {}

  let handle = null, ctrl = false, fitted = null; // fitted (an older host): its own size while "Fit to phone" is on
  let hostCols = 120, hostRows = 30, closed = false, closedHere = false;
  let zoom = view.zoom;                           // "read" | "fit" | a font size (px)
  const rememberZoom = () => { view.zoom = zoom; saveView(); };
  let beforeFit = null;                           // the zoom "Fit to phone" replaced; back once the size is not the phone's
  let overState = "";                             // what the overlay says: "" | "exited" | "reconnecting" | "gone"
  // The text selected with a finger ("selecting text" below): its first and last cell, { col, row } in the buffer.
  let sel = null;
  const selBar = el.querySelector(".term-sel"), selA = el.querySelector(".sel-handle.a"), selB = el.querySelector(".sel-handle.b");

  // The terminal has this phone's size: on a host that shares its terminals, the host says so (the driver);
  // on an older one, while the phone's own "Fit to phone" is on.
  const isMine = () => (handle?.shared ? handle.mine : Boolean(fitted));
  // The other devices that have it open, after the size and the computer on the line under the title: an eye and
  // their names (the computer's own window as "its window", not its name once more), the one whose size the terminal
  // has marked with the fit glyph (the button's); the whole sentence in its tooltip and label.
  function viewersLine() {
    const others = store.viewers(p.node, p.term);
    if (!others.length) return "";
    const driver = handle?.shared && !handle.mine ? handle.driver : null;
    const names = others.map(v => `${esc(v.id === p.node ? t("term.itsWindow") : v.name)}${v.id === driver ? icon("fit", "drives") : ""}`).join(", ");
    let label = t("term.viewers", { names: others.map(v => v.name).join(", ") });
    if (driver) label += ` · ${t("term.sizeBy", { cols: hostCols, rows: hostRows, name: store.sizeOwner(p.node, p.term, driver) })}`;
    return `<i class="sep">·</i><span class="term-viewers" role="img" aria-label="${esc(label)}" title="${esc(label)}">${icon("eye")}${names}</span>`;
  }
  // The session that runs in this terminal (an agent's), or null (a shell; an agent's terminal with no session yet
  // counts while its stand-in is listed).
  const sessionOf = () => store.sessions(p.node).find(x => x.term === p.term && x.status !== "stopped" && x.status !== "unreachable") || null;
  // The header: the title (the session's, once it has one), the size, the computer and who else has it open; at its
  // end the way to the session's messages (the chat view) and "More". Under it, while the session waits for the
  // user: what for.
  let headSig = "";
  function drawHead() {
    const x = sessionOf(), seen = viewersLine();
    const size = `${hostCols}×${hostRows}`;
    const title = x?.title || p.title || store.tab(p.node, p.term)?.title || t("session.terminal");
    const chat = Boolean(x) && !x.live?.unlinked;
    const waiting = x?.status === "waiting" ? x.waitingFor || t("status.reasonUnknown") : "";
    // Redrawn only when something it shows changed (the store changes every few seconds).
    const sig = JSON.stringify([title, size, seen, chat, waiting]);
    if (sig === headSig) return;
    headSig = sig;
    // The size first: a narrow screen cuts the line at its end.
    head.innerHTML = header(title, {
      back: true,
      sub: `<span title="${esc(t("term.hostSize", { cols: hostCols, rows: hostRows }))}">${esc(size)}</span><i class="sep">·</i>${esc(nodeName)}${seen}`,
      actions: (chat ? iconBtn("chat", t("term.chat"), 'data-act="chat"') : "") + iconBtn("more", t("term.more"), 'data-act="more"')
    }) + (waiting ? `<div class="status-line term-status"><span class="live st-waiting"><i class="dot st-waiting"></i>${esc(t("status.waiting"))}</span><span class="reason">${esc(waiting)}</span></div>` : "");
    wireBack(head, ctx);
    head.querySelector("[data-act='more']").onclick = more;
    const c = head.querySelector("[data-act='chat']");
    if (c) c.onclick = openChat;
  }
  // The session's messages; back from there is this terminal again.
  function openChat() {
    const x = sessionOf();
    if (x) ctx.go("session", { node: p.node, agent: x.agent, id: x.id, from: "terminal" });
  }
  // Ends what runs here - an agent's session with its terminal, or a shell - after a confirmation that names who
  // else has it open.
  async function stop() {
    const x = sessionOf(), others = store.viewers(p.node, p.term).length;
    const ask = x && !others ? t("session.stopAskTerm", { title: x.title, name: nodeName }) : closeAsk(store, p.node, p.term);
    if (!await ctx.confirm(ask, x ? t("session.stop") : t("term.close"), { danger: true })) return;
    try { await store.closeTerminal(p.node, p.term); closedHere = true; ctx.back(); } catch (e) { ctx.fail(e); }
  }
  // Another terminal on that computer, in this one's folder.
  async function shellHere(cwd) {
    try {
      const tab = await store.launch(p.node, { cwd, kind: "shell" });
      if (tab?.id) ctx.go("terminal", { node: p.node, term: tab.id, title: tab.title || baseName(cwd) });
    } catch (e) { ctx.fail(e); }
  }
  // "More": what is used now and then - the size, the text's size, copying, the chat view, a shell here, Ports, Stop.
  async function more() {
    const x = sessionOf(), mine = isMine(), cwd = x?.cwd || store.tab(p.node, p.term)?.cwd || "";
    const pick = await ctx.menu([
      { key: "fit", icon: "fit", label: t(mine ? "term.unfit" : "term.fit"), on: mine },
      { stepper: true, label: t("term.textSize"), value: () => `${view.read} px`, minus: () => setRead(view.read - 1), plus: () => setRead(view.read + 1), minusLabel: t("term.smaller"), plusLabel: t("term.larger") },
      { key: "copy", icon: "copy", label: t("term.copyScreen") },
      { key: "copyLast", icon: "copy", label: t("term.copyLast", { n: COPY_LINES }) },
      x && !x.live?.unlinked ? { key: "chat", icon: "chat", label: t("term.chat") } : null,
      cwd && handle?.online ? { key: "shell", icon: "termPlus", label: t("session.shell") } : null,
      // Only where the app can listen (its Forward plugin: not in a browser); lit while this computer has a forward.
      ctx.forwards?.available ? { key: "ports", icon: "globe", label: t("ports.title"), on: ctx.forwards.list().some(f => f.node === p.node) } : null,
      { key: "stop", icon: x ? "stop" : "power", label: x ? t("term.stopSession") : t("term.close"), danger: true }
    ].filter(Boolean));
    if (closed) return;
    if (pick === "fit") toggleFit();
    else if (pick === "copy") copyText(bufferText(0));
    else if (pick === "copyLast") copyText(bufferText(COPY_LINES));
    else if (pick === "chat") openChat();
    else if (pick === "shell") shellHere(cwd);
    else if (pick === "ports") openPorts(ctx, { node: p.node, term: p.term, cwd });
    else if (pick === "stop") stop();
  }
  // The terminal's text: the lines in view (count 0), or the last `count` lines of everything it holds; a line the
  // terminal wrapped is one line again, the blank ones at the end are left out.
  function bufferText(count) {
    const b = term.buffer.active;
    const end = count ? b.baseY + term.rows : b.viewportY + term.rows, start = count ? Math.max(0, end - count) : b.viewportY;
    const out = [];
    for (let i = start; i < end; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
    }
    while (out.length && !out.at(-1).trim()) out.pop();
    return out.join("\n");
  }
  // To the clipboard; where the WebView does not let the page write it, the text is shown to be copied by hand.
  async function copyText(text) {
    if (!text) return;
    try {
      await toClipboard(text);
      ctx.toast(t("term.copied"));
    } catch {
      await ctx.prompt(t("term.copyByHand"), text, t("common.done"), { multiline: true });
    }
  }
  // The readable text size (kept across restarts): the view goes to it; a terminal that has the phone's size is
  // fitted anew, to the columns that size gives.
  function setRead(px) {
    px = clamp(Math.round(px), READ_MIN, READ_MAX);
    if (px === view.read) return;
    view.read = px;
    if (isMine()) takeFit().catch(e => ctx.fail(e));
    else { zoom = "read"; rememberZoom(); applyZoom(); }
    saveView();
    drawChips();
  }
  function say(state) {
    overState = state;
    over.hidden = !state;
    over.textContent = state === "exited" ? t("term.exited") : state === "reconnecting" ? t("term.reconnecting") : state === "gone" ? t("term.gone") : "";
    drawChips();
  }
  // The chips over the terminal: "160 columns · Fit to phone" while the host's size is not the phone's and its whole
  // width would be too small to read; the way back to the end while the history is in view.
  function drawChips() {
    const tooWide = Boolean(handle) && !closed && !overState && !isMine() && fitPx() < view.read * TOO_SMALL;
    fitChip.hidden = !tooWide;
    if (tooWide) fitChip.lastElementChild.textContent = t("term.fitChip", { cols: hostCols });
    const b = term.buffer.active;
    endChip.hidden = b.viewportY >= b.baseY;
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
  const readPx = () => Math.max(view.read, fitPx());
  const targetPx = () => (zoom === "fit" ? fitPx() : zoom === "read" ? readPx() : clamp(zoom, Math.min(fitPx(), view.read), MAX_PX));

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
    drawSel();
  }
  const applyZoom = anchor => setFont(targetPx(), anchor);

  // The cursor in view, moved just enough to show it. rowOnly: only its line (the view stays at the left edge).
  function ensureCursor({ rowOnly = false } = {}) {
    const b = term.buffer.active;
    if (b.viewportY !== b.baseY) return; // the user is reading the history
    const c = cell();
    const x = PAD + b.cursorX * c.w, y = PAD + b.cursorY * c.h;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!rowOnly && !cursorHidden && (x < wrap.scrollLeft + c.w || x + 2 * c.w > wrap.scrollLeft + W)) wrap.scrollLeft = Math.max(0, x - W * 0.7);
    if (y < wrap.scrollTop) wrap.scrollTop = Math.max(0, y - c.h);
    else if (y + 2 * c.h > wrap.scrollTop + H) wrap.scrollTop = y + 2 * c.h - H;
  }
  // How the view opens: the cursor's line, from the left edge - where the lines begin - even when the cursor itself
  // is further right than the screen is wide (a long prompt); typing brings it into view.
  function home() {
    wrap.scrollTop = wrap.scrollHeight;
    wrap.scrollLeft = 0;
    ensureCursor({ rowOnly: true });
  }

  function setHostSize(cols, rows) {
    hostCols = cols; hostRows = rows;
    // The size is not the phone's any more (given back, taken by someone else, the link made anew): the whole width
    // of the host's size would be too small to read, so the zoom from before "Fit to phone" is back.
    if (beforeFit != null && !isMine()) { zoom = beforeFit; beforeFit = null; }
    if (term.cols !== cols || term.rows !== rows) { clearSel(); term.resize(cols, rows); }
    applyZoom();
    drawHead();
    drawChips();
  }

  // The terminal takes the size that fits here at the readable font.
  async function takeFit() {
    const c = cell(), k = view.read / term.options.fontSize;
    const cols = Math.max(20, Math.floor(availW() / (c.w * k))), rows = Math.max(5, Math.floor(availH() / (c.h * k)));
    if (!handle.shared && !fitted) fitted = { cols: hostCols, rows: hostRows };
    if (beforeFit == null) beforeFit = zoom;
    zoom = "fit";
    const s = await handle.take(cols, rows);
    if (closed) return;
    setHostSize(s.cols, s.rows);
    home();
    ctx.toast(t("term.fitted", { cols: s.cols, rows: s.rows }));
  }
  // "Fit to phone": takes the size; when the terminal has the phone's size already, gives it back (the host hands it
  // to the device that had it; an older host is sent the size it had before).
  let fitting = false;
  async function toggleFit() {
    if (!handle || fitting) return;
    fitting = true;
    try {
      if (isMine()) {
        const before = fitted;
        fitted = null;
        const s = await handle.release(before);
        if (closed) return;
        setHostSize(s.cols, s.rows);
        ctx.toast(t("term.released", { cols: s.cols, rows: s.rows }));
        return;
      }
      await takeFit();
    } catch (e) {
      ctx.fail(e);
    } finally {
      fitting = false;
    }
  }

  // ---------- touch: scroll, pan, pinch, taps ----------
  // A one-finger drag keeps to the axis it started on. Sideways it pans a terminal wider than the screen. Up and down
  // it scrolls - by what the program in the terminal expects, as the desktop's wheel does through xterm:
  //   * the normal screen: xterm's own history;
  //   * a program that asked for the mouse (Codex, Claude Code and OpenCode do, in the alternate screen, where there
  //     is no history of xterm's to scroll): wheel reports at the cell under the finger, in the encoding it asked
  //     for - it scrolls its own view;
  //   * the alternate screen without the mouse (a pager, an editor): arrow keys, as terminals send for a wheel there.
  // The view itself moves first, where the host's screen is taller than what shows. A drag let go at speed runs on
  // and slows down (a fling); a touch stops it. The listeners are in the capture phase: xterm's own touch handling
  // under them never gets to swallow a drag.
  let g = null, tapTimer = 0, lastTap = null, scrollAcc = 0, kbRaisedAt = 0, fling = 0;
  const pt = (touch, r = wrap.getBoundingClientRect()) => ({ x: touch.clientX - r.left, y: touch.clientY - r.top });
  // The mouse encodings a program switches (DECSET 1006 SGR, 1016 SGR in pixels, 1015 urxvt): xterm keeps them to
  // itself, so they are noted as they pass (the sequence stays xterm's to handle).
  // The same way: whether the program hid the cursor (25) - a full-screen program's cursor is nothing to follow.
  const mouseEnc = new Set();
  let cursorHidden = false;
  for (const [final, on] of [["h", true], ["l", false]]) {
    term.parser.registerCsiHandler({ prefix: "?", final }, params => {
      for (const v of params.flat()) {
        if (v === 1006 || v === 1015 || v === 1016) { if (on) mouseEnc.add(v); else mouseEnc.delete(v); }
        else if (v === 25) cursorHidden = !on;
      }
      return false;
    });
  }
  // What a vertical drag scrolls: "history" (xterm's), "mouse" (wheel reports) or "keys" (arrows).
  const wheelMode = () => (["vt200", "drag", "any"].includes(term.modes.mouseTrackingMode) ? "mouse" : term.buffer.active.type === "alternate" ? "keys" : "history");
  // One wheel notch (up: towards the history) as the program reads it, at a point of the view.
  function wheelReport(up, at) {
    const c = cell(), px = at.x + wrap.scrollLeft - PAD, py = at.y + wrap.scrollTop - PAD;
    const col = clamp(Math.floor(px / c.w) + 1, 1, term.cols), row = clamp(Math.floor(py / c.h) + 1, 1, term.rows);
    const b = up ? 64 : 65;
    if (mouseEnc.has(1016)) return `\x1b[<${b};${Math.max(1, Math.round(px))};${Math.max(1, Math.round(py))}M`;
    if (mouseEnc.has(1006)) return `\x1b[<${b};${col};${row}M`;
    if (mouseEnc.has(1015)) return `\x1b[${b + 32};${col};${row}M`;
    return col > 223 || row > 223 ? "" : `\x1b[M${String.fromCharCode(b + 32, col + 32, row + 32)}`;
  }
  // lines < 0: towards the history. To a program at most STEP_MAX notches or keys at a time (a fling's frame).
  function scrollLines(lines, at) {
    const mode = wheelMode();
    if (mode === "history") { term.scrollLines(lines); drawChips(); return; }
    const up = lines < 0, n = Math.min(Math.abs(lines), STEP_MAX);
    const one = mode === "mouse" ? wheelReport(up, at) : `\x1b${term.modes.applicationCursorKeysMode ? "O" : "["}${up ? "A" : "B"}`;
    if (one && handle?.online && !closed) handle.write(one.repeat(n));
  }
  // The finger moved dy px (down: towards the history): the view first, what is left over as lines - of a program
  // that scrolls by the wheel one notch for every WHEEL_LINES lines' height.
  function scrollBy(dy, at) {
    const want = wrap.scrollTop - dy;
    wrap.scrollTop = want;
    const rest = want - wrap.scrollTop; // < 0: past the top (history), > 0: past the bottom
    if (!rest) { scrollAcc = 0; return; }
    scrollAcc += rest;
    const unit = cell().h * (wheelMode() === "mouse" ? WHEEL_LINES : 1), lines = Math.trunc(scrollAcc / unit);
    if (lines) { scrollLines(lines, at); scrollAcc -= lines * unit; }
  }
  const stopFling = () => { cancelAnimationFrame(fling); fling = 0; };
  // vx, vy: px per ms as the finger left; one of them is 0 (the drag's axis).
  function startFling(vx, vy, at) {
    let last = performance.now();
    const step = now => {
      const dt = Math.min(48, now - last), k = Math.exp(-dt / FLING_MS);
      last = now;
      if (vx) wrap.scrollLeft -= vx * dt; else scrollBy(vy * dt, at);
      vx *= k; vy *= k;
      fling = Math.abs(vx) < FLING_END && Math.abs(vy) < FLING_END ? 0 : requestAnimationFrame(step);
    };
    fling = requestAnimationFrame(step);
  }
  function toggleZoomAt(at) {
    const fit = fitPx();
    const atFit = zoom === "fit" || Math.abs(term.options.fontSize - fit) < 0.3;
    zoom = atFit ? "read" : "fit";
    if (zoom === "read" && readPx() - fit < 0.3) zoom = "fit"; // nothing to zoom: the whole width is readable already
    rememberZoom();
    applyZoom(at);
    if (zoom === "fit") wrap.scrollLeft = 0;
    ctx.toast(t(zoom === "fit" ? "term.zoomFit" : "term.zoomRead"));
  }
  // ---------- selecting text ----------
  // A finger held still for LONG_MS selects the word under it; dragged on without lifting, the selection grows from
  // that word. Lifted, the selection stays, with a handle at each end to move and a bar over the terminal: Copy,
  // whole lines, cancel. While it stays a drag scrolls as before, a tap anywhere else puts the selection away. Near an
  // edge of the view the terminal scrolls under the finger. The selection is xterm's own (term.select), set from
  // here: xterm itself selects with a mouse only.
  let longTimer = 0, edgeTimer = 0, touchedAt = 0;
  // The arithmetic is select.js's; here it is given the view and the terminal as they are now.
  const cellAt = at => select.cellAt(at, { scroll: { left: wrap.scrollLeft, top: wrap.scrollTop }, cell: cell(), pad: PAD, cols: term.cols, rows: term.rows, top: term.buffer.active.viewportY });
  const wordAt = pos => select.wordAt(term.buffer.active.getLine(pos.row), pos, term.cols);
  function setSel({ a, b }) {
    sel = { a, b };
    term.select(a.col, a.row, select.cellCount(sel, term.cols));
    drawSel();
  }
  function clearSel() {
    if (!sel) return;
    sel = null;
    term.clearSelection();
    drawSel();
  }
  // The handles under the selection's two ends (out of sight with their line), the bar while there is a selection.
  function drawSel() {
    selBar.hidden = !sel;
    const view = sel ? { cell: cell(), cols: term.cols, rows: term.rows, top: term.buffer.active.viewportY, size: HANDLE_PX } : null;
    for (const [h, pos, last] of [[selA, sel?.a, false], [selB, sel?.b, true]]) {
      // Kept inside the terminal's own box: one that reached out of it would be cut off at the left edge, and make
      // the view scroll further than the terminal at the right and bottom ones.
      const at = pos ? select.handleAt(pos, last, view) : null;
      h.hidden = !at;
      if (!at) continue;
      h.style.left = `${at.left}px`;
      h.style.top = `${at.top}px`;
    }
  }
  // The finger moved while selecting: from the word first selected to the cell under the finger, or - a handle - from
  // the selection's other end to it.
  function moveSel() {
    const pos = cellAt({ x: g.x + g.dx, y: g.y + g.dy });
    setSel(g.word ? select.grow(g.word, pos) : select.between(g.fixed, pos));
  }
  const stopEdge = () => { clearInterval(edgeTimer); edgeTimer = 0; };
  // The finger rests near an edge: the view moves a line at a time, then xterm's history.
  function edgeStep() {
    if (g?.kind !== "sel") return stopEdge();
    const dy = g.y < EDGE_PX ? -1 : g.y > wrap.clientHeight - EDGE_PX ? 1 : 0, dx = g.x < EDGE_PX ? -1 : g.x > wrap.clientWidth - EDGE_PX ? 1 : 0;
    if (!dx && !dy) return stopEdge();
    const c = cell();
    if (dy) {
      const was = wrap.scrollTop;
      wrap.scrollTop += dy * c.h;
      if (wrap.scrollTop === was && wheelMode() === "history") term.scrollLines(dy);
    }
    if (dx) wrap.scrollLeft += dx * 2 * c.w;
    moveSel();
  }
  function startSel() {
    clearTimeout(tapTimer);
    const word = wordAt(cellAt({ x: g.x0, y: g.y0 }));
    g = { kind: "sel", word, dx: 0, dy: 0, x: g.x, y: g.y };
    buzz(12);
    setSel(word);
  }
  term.onSelectionChange(() => { if (sel && !term.hasSelection()) { sel = null; drawSel(); } }); // xterm dropped it (another screen)
  selBar.onpointerdown = e => e.preventDefault(); // the keyboard stays as it was
  selBar.onclick = e => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "sel-copy") {
      const text = term.getSelection();
      clearSel();
      copyText(text);
    } else if (act === "sel-lines" && sel) setSel(select.wholeLines(sel, term.cols));
    else if (act === "sel-cancel") clearSel();
  };
  // What a browser makes of a touch for a mouse (a long press: mousedown, the context menu) is not xterm's to act on -
  // it would start a selection of its own or put its textarea under the finger.
  for (const type of ["mousedown", "contextmenu"]) {
    wrap.addEventListener(type, e => {
      if (Date.now() - touchedAt > 1000) return;
      e.stopPropagation();
      if (type === "contextmenu") e.preventDefault();
    }, { capture: true });
  }

  wrap.addEventListener("touchstart", e => {
    stopFling();
    clearTimeout(longTimer);
    touchedAt = Date.now();
    const r = wrap.getBoundingClientRect();
    if (e.touches.length === 1) {
      const a = pt(e.touches[0], r);
      const end = sel && e.target.closest?.(".sel-handle");
      if (end) {
        // A handle hangs under its cell: the selection's end stays where it is until the finger moves.
        const pos = end === selB ? sel.b : sel.a, c = cell();
        const cx = PAD + (pos.col + 0.5) * c.w - wrap.scrollLeft, cy = PAD + (pos.row - term.buffer.active.viewportY + 0.5) * c.h - wrap.scrollTop;
        g = { kind: "sel", fixed: end === selB ? sel.a : sel.b, dx: cx - a.x, dy: cy - a.y, x: a.x, y: a.y };
        return;
      }
      g = { kind: "pan", axis: "", x0: a.x, y0: a.y, x: a.x, y: a.y, moved: false, t0: Date.now(), trail: [{ t: performance.now(), x: a.x, y: a.y }] };
      longTimer = setTimeout(() => { if (g?.kind === "pan" && !g.moved && !closed) startSel(); }, LONG_MS);
    } else if (e.touches.length === 2) {
      stopEdge();
      clearTimeout(tapTimer);
      const a = pt(e.touches[0], r), b = pt(e.touches[1], r);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      g = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, px0: term.options.fontSize, cx, cy, scale: 1 };
      pan.style.transformOrigin = `${wrap.scrollLeft + cx}px ${wrap.scrollTop + cy}px`;
    }
  }, { passive: true, capture: true });
  wrap.addEventListener("touchmove", e => {
    if (!g) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    if (g.kind === "sel" && e.touches.length === 1) {
      const a = pt(e.touches[0], r);
      g.x = a.x; g.y = a.y;
      moveSel();
      if (!edgeTimer) edgeTimer = setInterval(edgeStep, EDGE_MS);
    } else if (g.kind === "pan" && e.touches.length === 1) {
      const a = pt(e.touches[0], r);
      if (!g.moved) {
        if (Math.hypot(a.x - g.x0, a.y - g.y0) < MOVE_PX) return;
        g.moved = true;
        clearTimeout(longTimer);
        // Sideways only where there is something to pan to.
        g.axis = Math.abs(a.x - g.x0) > Math.abs(a.y - g.y0) && wrap.scrollWidth > wrap.clientWidth + 1 ? "x" : "y";
      }
      if (g.axis === "x") wrap.scrollLeft -= a.x - g.x; else scrollBy(a.y - g.y, a);
      g.x = a.x; g.y = a.y;
      const now = performance.now();
      g.trail.push({ t: now, x: a.x, y: a.y });
      while (g.trail.length > 2 && now - g.trail[0].t > TRAIL_MS) g.trail.shift();
    } else if (g.kind === "pinch" && e.touches.length === 2) {
      const a = pt(e.touches[0], r), b = pt(e.touches[1], r);
      const px = clamp(g.px0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, Math.min(fitPx(), view.read), MAX_PX);
      g.scale = px / g.px0;
      pan.style.transform = `scale(${g.scale})`;
    }
  }, { passive: false, capture: true });
  wrap.addEventListener("touchend", e => {
    clearTimeout(longTimer);
    touchedAt = Date.now();
    if (!g) return;
    if (g.kind === "sel") {
      if (e.touches.length) return;
      e.preventDefault(); // no emulated click
      stopEdge();
      g = null;
      return;
    }
    if (g.kind === "pinch") {
      if (e.touches.length) return; // the pinch ends with the last finger
      pan.style.transform = "";
      zoom = Math.abs(g.px0 * g.scale - fitPx()) < 0.3 ? "fit" : g.px0 * g.scale;
      rememberZoom();
      applyZoom({ x: g.cx, y: g.cy });
      g = null;
      return;
    }
    const tap = !g.moved && Date.now() - g.t0 < 400;
    const at = { x: g.x0, y: g.y0 }, was = g;
    g = null;
    if (was.moved) {
      // Let go while moving: the drag runs on along its axis.
      const a = was.trail[0], b = was.trail.at(-1), dt = b.t - a.t;
      if (dt > 0 && performance.now() - b.t < 80) {
        const v = clamp((was.axis === "x" ? b.x - a.x : b.y - a.y) / dt, -FLING_MAX, FLING_MAX);
        if (Math.abs(v) > FLING_FROM) startFling(was.axis === "x" ? v : 0, was.axis === "x" ? 0 : v, { x: b.x, y: b.y });
      }
      return;
    }
    if (!tap) return;
    e.preventDefault(); // no emulated click: the taps are handled here
    if (sel) { clearSel(); lastTap = null; return; } // a tap beside the selection puts it away
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
  }, { passive: false, capture: true });
  wrap.addEventListener("touchcancel", () => { clearTimeout(longTimer); stopEdge(); pan.style.transform = ""; g = null; }, { capture: true });
  // A mouse / trackpad (the browser preview, a tablet): the wheel scrolls as a drag does, Ctrl+wheel zooms.
  wrap.addEventListener("wheel", e => {
    e.preventDefault();
    e.stopPropagation(); // not xterm's as well
    const r = wrap.getBoundingClientRect(), at = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.ctrlKey) {
      zoom = clamp(term.options.fontSize * (e.deltaY < 0 ? 1.1 : 1 / 1.1), Math.min(fitPx(), view.read), MAX_PX);
      rememberZoom();
      applyZoom(at);
    } else {
      wrap.scrollLeft += e.deltaX;
      scrollBy(-e.deltaY, at);
    }
  }, { passive: false, capture: true });
  wrap.addEventListener("dblclick", e => {
    const r = wrap.getBoundingClientRect();
    toggleZoomAt({ x: e.clientX - r.left, y: e.clientY - r.top });
  });

  // ---------- keys ----------
  let typingUntil = 0, raf = 0;
  const followCursor = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => ensureCursor()); };
  // typed: the user's own input (not xterm's answers to a program) - the view goes back to the end of the history.
  const send = (data, typed = true) => {
    if (!handle || closed || !handle.online) return;
    if (typed && term.buffer.active.viewportY < term.buffer.active.baseY) { term.scrollToBottom(); drawChips(); }
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
  term.onData(data => send(withCtrl(data), !isAnswer(data)));

  // The soft keyboard types into a field of our own, not into xterm's textarea: Android keyboards compose words
  // (autocorrect, suggestions) and xterm loses characters on the way. Whatever the field holds after each change is
  // compared with what it held before and the difference goes out as keys - backspaces for what went, then the new
  // text - so a word the keyboard corrects is corrected in the terminal too. An iPhone's keyboard also turns what is
  // typed into print - curly quotes, a long dash for two hyphens - which no shell reads: there the keys go out as
  // they were typed (asKeys).
  const asKeys = isIos ? plainKeys : s => s;
  const input = el.querySelector(".term-input");
  let shadow = "", composing = false;
  const clearInput = () => { input.value = ""; shadow = ""; };
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; if (input.value.length > 200) clearInput(); });
  input.addEventListener("input", () => {
    const v = input.value;
    let i = 0;
    while (i < shadow.length && i < v.length && shadow[i] === v[i]) i++;
    const gone = asKeys(shadow.slice(i)).length, added = asKeys(v.slice(i));
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
  const showKeyboard = () => { closeCompose(); input.focus({ preventScroll: true }); followCursor(); };
  // ---------- the key row ----------
  // Two sets of keys, switched by the button at the row's end (a set scrolls sideways for what does not fit).
  const keysBox = el.querySelector(".term-keys"), strips = [...keysBox.querySelectorAll(".xkeys")], swap = keysBox.querySelector(".keys-swap");
  let keySet = 0;
  // The sticky Ctrl is lit on its key, and on the switch while its set is not the one in view.
  const setCtrl = on => {
    ctrl = on;
    strips[CTRL_SET].querySelector(`[data-k="${CTRL_KEY}"]`).classList.toggle("on", on);
    swap.classList.toggle("on", on && keySet !== CTRL_SET);
  };
  function showSet(n) {
    keySet = n;
    strips.forEach((s, i) => { s.hidden = i !== n; });
    swap.setAttribute("aria-pressed", String(n > 0));
    swap.classList.toggle("on", ctrl && n !== CTRL_SET);
  }
  const keyOf = target => {
    const b = target.closest?.("[data-k]");
    return b ? KEYSETS[strips.indexOf(b.closest(".xkeys"))]?.[b.dataset.k]?.[1] : undefined;
  };
  const press = v => {
    if (v === "ctrl") return setCtrl(!ctrl);
    send(v);
    if (ctrl) setCtrl(false);
  };
  // An arrow held down repeats; a drag that scrolls the row (pointercancel) or a lifted finger ends it. The first
  // press is the click's, as for every key, so scrolling the row by an arrow sends nothing.
  let holdTimer = 0, repeatTimer = 0, repeated = false;
  const endHold = () => { clearTimeout(holdTimer); clearInterval(repeatTimer); holdTimer = repeatTimer = 0; };
  keysBox.onpointerdown = e => {
    e.preventDefault(); // the keyboard stays up, the field being typed in keeps the focus
    endHold();
    repeated = false;
    const v = keyOf(e.target);
    if (!REPEAT.has(v)) return;
    holdTimer = setTimeout(() => {
      repeated = true;
      buzz(8);
      send(v);
      repeatTimer = setInterval(() => send(v), REPEAT_MS);
    }, HOLD_MS);
  };
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) keysBox.addEventListener(type, endHold);
  keysBox.oncontextmenu = e => e.preventDefault(); // a long press is a held key, not a menu
  keysBox.onclick = e => {
    if (e.target.closest(".keys-swap")) { buzz(8); showSet((keySet + 1) % KEYSETS.length); return; }
    const v = keyOf(e.target);
    if (v === undefined) return;
    if (repeated) { repeated = false; return; } // the held key was sent already
    buzz(8);
    press(v);
  };
  for (const s of strips) wireStrip(s);

  // ---------- the tool row: a message, a picture, paste ----------
  // Under the keys: a field that opens for a message, a picture, paste. With the keyboard up for typing straight
  // into the terminal the row is out of the way (the terminal keeps its lines); Back brings it again.
  const tools = el.querySelector(".term-tools"), pill = tools.querySelector(".compose-open");
  const compose = el.querySelector(".term-compose"), ta = compose.querySelector("textarea");
  // The draft is the session's, shared with the reply box of its chat view; a shell has one of its own.
  const draftKey = () => { const x = sessionOf(); return x ? `${p.node}:${x.agent}:${x.id}` : `${p.node}:term:${p.term}`; };
  const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`; };
  function drawPill() {
    const draft = getDraft(draftKey()).trim();
    pill.classList.toggle("has-draft", Boolean(draft));
    pill.lastElementChild.textContent = draft.split("\n")[0] || t("term.compose");
  }
  // A message is written with the phone's own keyboard - autocorrect, dictation, several lines - in a field of its
  // own, and goes into the terminal as one paste (bracketed where the program asked for that): with Enter a moment
  // later (an agent's input box takes a paste and Enter in one write as a pasted line break), or without.
  function openCompose() {
    ta.value = getDraft(draftKey());
    tools.hidden = true;
    compose.hidden = false;
    el.classList.add("composing");
    grow();
    ta.focus({ preventScroll: true });
  }
  function closeCompose() {
    if (compose.hidden) return;
    compose.hidden = true;
    tools.hidden = false;
    el.classList.remove("composing");
    if (document.activeElement === ta) ta.blur();
    drawPill();
  }
  function sendComposed(enter) {
    if (!handle?.online) return ctx.toast(errorText("offline"));
    const text = ta.value;
    if (text) term.paste(text);
    if (enter) setTimeout(() => send("\r"), text ? ENTER_AFTER_MS : 0);
    ta.value = "";
    setDraft(draftKey(), "");
    closeCompose();
  }
  ta.oninput = () => { setDraft(draftKey(), ta.value); grow(); };
  pill.onclick = openCompose;
  compose.onsubmit = e => { e.preventDefault(); sendComposed(true); };
  compose.querySelector("[data-act='insert']").onclick = () => sendComposed(false);
  compose.querySelector("[data-act='compose-close']").onclick = closeCompose;
  // The buttons beside the field do not take the keyboard away from it.
  for (const b of compose.querySelectorAll("button")) b.onpointerdown = e => e.preventDefault();
  tools.onpointerdown = e => { if (e.target.closest(".icon-btn")) e.preventDefault(); };

  // The clipboard's text as a paste (xterm brackets it where the program asked for that). A WebView that does not let
  // the page read the clipboard gets a field to paste into by hand instead.
  async function paste() {
    let text = "";
    try { text = await fromClipboard(); } catch {}
    if (!text) text = await ctx.prompt(t("term.pasteAsk"), "", t("key.paste"), { multiline: true });
    if (text && !closed) term.paste(text);
  }
  tools.querySelector("[data-act='paste']").onclick = paste;

  // A picture for the agent: taken now or chosen from the phone, made smaller here when it is large, put on the
  // computer (files.put: the host keeps it in its temp folder) and its path there pasted into the terminal, as a
  // picture dropped on the desktop's pane is - without Enter, so more can be written after it.
  const busyEl = el.querySelector(".term-busy");
  const busy = text => { busyEl.hidden = !text; busyEl.lastElementChild.textContent = text; };
  const pickers = { gallery: el.querySelector(".pick-gallery"), camera: el.querySelector(".pick-camera") };
  let sending = false;
  async function sendPicture(file) {
    if (sending) return;
    sending = true;
    try {
      busy(t("term.picturePreparing"));
      const pic = await shrink(file);
      if (pic.blob.size > MAX_PICTURE) throw Object.assign(new Error("too big"), { code: "tooBig" });
      // Back from the camera app the links are only just being made again: the computer first, then this view of
      // its terminal.
      await store.whenOnline(p.node);
      busy(t("term.pictureSending", { size: sizeText(pic.blob.size) }));
      const where = await store.putFile(p.node, pic.name, await toBase64(pic.blob));
      for (let i = 0; i < 50 && !closed && !handle?.online; i++) await new Promise(r => setTimeout(r, 200));
      if (closed) return;
      term.paste(terminalFilePath(where));
      ctx.toast(t("term.pictureSent", { name: nodeName }));
    } catch (e) {
      if (!closed) ctx.fail(e);
    } finally {
      sending = false;
      busy("");
    }
  }
  for (const inp of Object.values(pickers)) {
    inp.onchange = () => {
      const file = inp.files?.[0];
      inp.value = "";
      if (file) sendPicture(file);
    };
  }
  tools.querySelector("[data-act='picture']").onclick = async () => {
    if (!handle?.online) return ctx.toast(errorText("offline"));
    const how = await ctx.menu([
      { key: "camera", icon: "camera", label: t("term.pictureCamera") },
      { key: "gallery", icon: "image", label: t("term.pictureGallery") }
    ]);
    if (how && !closed) pickers[how].click();
  };
  drawPill();

  fitChip.onclick = toggleFit;
  endChip.onclick = () => { term.scrollToBottom(); home(); drawChips(); };
  term.onScroll(() => { drawChips(); drawSel(); });

  // ---------- attach ----------
  // The keyboard coming up, a turn to landscape: the whole width is measured again, the cursor stays in view.
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(() => {
    if (wrap.clientWidth !== lastW) { lastW = wrap.clientWidth; applyZoom(); drawChips(); }
    // The keyboard was put away by the phone's Back while the field it typed into kept the focus: the field lets go,
    // else the next touch anywhere would bring the keyboard up again.
    if (lastH && wrap.clientHeight - lastH > KEYBOARD_PX && keyboardUp() && !document.documentElement.classList.contains("kb-open")) input.blur();
    lastH = wrap.clientHeight;
    // The keyboard came up or went: the cursor stays in sight. Else the view is left where the user put it.
    if (keyboardUp() || Date.now() < typingUntil) followCursor();
  });
  ro.observe(wrap);
  const offs = [];
  drawHead();
  (async () => {
    try {
      handle = await store.attach(p.node, p.term);
    } catch (e) {
      say("gone");
      if (e?.code && e.code !== "invalidData") over.textContent = `${t("term.gone")} · ${errorText(e)}`;
      return;
    }
    if (closed) return handle.detach();
    setHostSize(handle.cols, handle.rows);
    if (handle.scrollback) term.write(handle.scrollback, () => home());
    else home();
    offs.push(handle.onData(d => term.write(d, () => { if (Date.now() < typingUntil) ensureCursor(); drawChips(); })));
    offs.push(handle.onSize(({ cols, rows }) => setHostSize(cols, rows)));
    offs.push(handle.onState(({ online }) => { if (!online) say("reconnecting"); else if (overState === "reconnecting") say(""); }));
    offs.push(handle.onReset(({ scrollback, cols, rows }) => {
      fitted = null; // a size the phone set on an older host went back to its pane with the link
      clearSel();
      term.reset();
      mouseEnc.clear();
      cursorHidden = false;
      setHostSize(cols, rows);
      term.write(scrollback, () => home());
    }));
    offs.push(handle.onGone(() => say("gone")));
    if (handle.exitCode != null) say("exited");
    // The tab gone or exited on the host: say so.
    offs.push(store.on("change", () => {
      drawHead(); // who else has it open
      if (overState === "reconnecting" || overState === "gone") return;
      const tab = store.tab(p.node, p.term);
      if (!store.node(p.node)?.loaded) return;
      say(!tab || tab.exited ? "exited" : "");
    }));
  })();

  return () => {
    closed = true;
    endHold();
    clearTimeout(tapTimer);
    clearTimeout(longTimer);
    stopEdge();
    cancelAnimationFrame(raf);
    stopFling();
    ro.disconnect();
    for (const off of offs) off();
    handle?.detach();
    term.dispose();
    // A shell this phone opened, left running: where it is now (an agent's terminal is found through its session).
    const tab = store.tab(p.node, p.term);
    if (!closedHere && tab && !tab.exited && !tab.agent && tab.owner && tab.owner === store.selfId) ctx.toast(t("term.keptRunning"));
  };
}
