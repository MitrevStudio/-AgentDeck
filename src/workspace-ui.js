// The centre of the manager window: the shown project's tabs, and the shown tab split into panes, each a terminal
// (xterm.js) of AgentDeck's own. The layout lives in main (workspace.js); this page draws it and sends commands back.
// Loaded before renderer.js, which provides the session data (data, live, liveOf) and calls showSessionTab,
// findSessionTab, getPaneMark, getSessionTerm, isMoveHereOffered, moveSessionHere, openTerm, stopTerm,
// getViewersHtml, startTermDrag, endDrag, renderWorkspace and runWorkspace.
const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
];
const HEADERS_REFRESH_MS = 3000;
const TERM_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, monospace';
// prefs.js: TERMINAL_FONT_SIZES (as the prefs snapshot brings it) and its default.
const TERM_FONT_SIZES = window.prefs.terminalFontSizes, TERM_FONT_DEFAULT = 16;
let termFontSize = window.prefs.terminalFontSize || TERM_FONT_DEFAULT;
let ws = { activeSpace: "", spaces: {}, tabs: {}, terminals: [] };
const termViews = new Map(); // terminal id -> { host, term, fit, attachedEnd, queue }
let layoutSig = "";          // what the panes were last built from
let wsPushed = false;        // main sent the layout at least once
let focusAfterRender = false;

const runWorkspace = (cmd, args = {}) => window.terminals.command(cmd, args).catch(e => toast(e.message, true));
const getTerminal = id => ws.terminals.find(x => x.id === id) || null;
// A terminal belongs to the computer it runs on and every device may have it open (docs/SHARED-SESSIONS.md): X only
// hides a pane, Stop ends the terminal for everyone.
// The view lists every terminal of this and the online computers; `paned` tells those with a pane here.
const isPaned = x => Boolean(x?.paned);
// The other devices that have the terminal open (this window is one of the viewers too).
const getOtherViewers = x => (x?.viewers || []).filter(v => !v.me);
const getViewerNames = list => list.map(v => v.name).filter(Boolean).join(", ");
const getShownSpace = () => ws.spaces[ws.activeSpace] || { tabs: [], active: "" };
const getShownTab = () => ws.tabs[getShownSpace().active] || null;
// Where a terminal is in the tab in view: "active" in its focused pane, "shown" in another pane of it (none while a
// pane is zoomed over them), "" out of view.
function getPaneState(id) {
  const tab = getShownTab();
  if (!id || !tab || !getPanesOf(tab.zoom ? { term: tab.zoom } : tab.root).includes(id)) return "";
  return tab.focus === id ? "active" : "shown";
}
// A sidebar row's mark for it: the row of the focused pane is the current one, at most one in the lists.
function getPaneMark(id) {
  const state = getPaneState(id);
  return state === "active" ? 'data-pane="active" aria-current="true"' : state ? `data-pane="${state}"` : "";
}
function getPanesOf(node, out = []) {
  if (!node) return out;
  if (node.term) out.push(node.term);
  else { getPanesOf(node.a, out); getPanesOf(node.b, out); }
  return out;
}
// A layout's shape without its ratios: what the panes are rebuilt for. A ratio changes in place (applyRatios).
const getShape = node => (node.term ? node.term : [node.dir, getShape(node.a), getShape(node.b)]);
const clampRatio = r => Math.min(0.9, Math.max(0.1, Number(r) || 0.5));

// ---------- looks ----------
// theme.css --term-* tokens: --term-ansi-black ... --term-ansi-bright-white for the 16 colours.
function getTermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const v = name => styles.getPropertyValue(name).trim();
  const theme = { background: v("--term-bg"), foreground: v("--term-fg"), cursor: v("--term-cursor"), selectionBackground: v("--term-selection") };
  for (const name of ANSI_NAMES) theme[name] = v(`--term-ansi-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
  return theme;
}
// Agents paint their own RGB colours (Claude's question highlight), made for a dark terminal: on a light one xterm
// darkens any text too faint for its background.
const getTermMinContrast = () => (getComputedStyle(document.documentElement).colorScheme === "light" ? 4.5 : 1);
function applyTermTheme() {
  const theme = getTermTheme();
  const minimumContrastRatio = getTermMinContrast();
  termViews.forEach(view => {
    view.term.options.theme = theme;
    view.term.options.minimumContrastRatio = minimumContrastRatio;
  });
}
function applyTermFont(size) {
  if (!size || size === termFontSize) return;
  termFontSize = size;
  termViews.forEach(view => { view.term.options.fontSize = size; });
  requestAnimationFrame(fitShown);
}
// Ctrl+= / Ctrl+- one size up or down, Ctrl+0 back to the default (saved, as in Settings).
function stepTermFont(step) {
  const i = TERM_FONT_SIZES.indexOf(termFontSize);
  const next = step === 0 ? TERM_FONT_DEFAULT : TERM_FONT_SIZES[Math.max(0, Math.min(TERM_FONT_SIZES.length - 1, (i < 0 ? TERM_FONT_SIZES.indexOf(TERM_FONT_DEFAULT) : i) + step))];
  applyTermFont(next);
  window.terminals.setView({ terminalFontSize: next }).catch(() => {});
}

// ---------- terminals ----------
// Agent CLIs can interpret backslashes as escapes when recognizing an attachment path.
// Windows accepts forward slashes too. Leave POSIX paths alone: a backslash can be part of a filename there.
function terminalFilePath(file) {
  const value = /^(?:[a-z]:[\\/]|\\\\)/i.test(file) ? file.replace(/\\/g, "/") : file;
  return /\s/.test(value) ? `"${value}"` : value;
}
// Output that arrived before the scrollback did: only what the scrollback does not hold yet is written.
function writeAfter(view, data, end) {
  const start = end - data.length;
  if (end > view.attachedEnd) view.term.write(data.slice(Math.max(0, view.attachedEnd - start)));
}
async function attachView(id, view) {
  const a = await window.terminals.attach(id);
  if (!a || termViews.get(id) !== view) return; // its pane went meanwhile, and the view with it
  // The terminal's size first, so the scrollback wraps as it was written.
  setTermSize(id, a);
  view.term.write(a.scrollback);
  view.attachedEnd = a.end;
  view.queue.forEach(chunk => writeAfter(view, chunk.data, chunk.end));
  view.queue = [];
}
function createTermView(id) {
  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({
    fontFamily: TERM_FONT,
    fontSize: termFontSize,
    cursorBlink: true,
    scrollback: 10000,
    theme: getTermTheme(),
    minimumContrastRatio: getTermMinContrast()
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  term.attachCustomKeyEventHandler(e => handleTermKey(term, e, id));
  term.onData(d => window.terminals.input(id, d));
  // OSC 52: a program sets the clipboard. Agents (Claude Code, Codex, OpenCode) turn mouse reporting on, so a drag is
  // theirs, not xterm's: they select themselves and send the text this way ("copied to clipboard"). Only writes - a
  // query ("?") is not answered, so a program cannot read the clipboard.
  term.parser.registerOscHandler(52, data => {
    const payload = data.slice(data.indexOf(";") + 1);
    if (!payload || payload === "?" || payload.length > 1_400_000) return true;
    try {
      const bytes = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
      window.manager.copyText(new TextDecoder().decode(bytes));
    } catch {}
    return true;
  });
  // As Windows Terminal: text selected with the mouse is copied at once - the agent's redraws and any keystroke clear a
  // selection (xterm), and a Ctrl+C that finds none goes to the agent -, and the right button copies a selection or pastes.
  host.addEventListener("mouseup", () => { if (term.hasSelection()) window.manager.copyText(term.getSelection()); });
  // The right button is AgentDeck's alone: reported to an agent with mouse reporting on, the agent pasted a second time.
  for (const type of ["mousedown", "mouseup"]) {
    host.addEventListener(type, e => {
      if (e.button === 2) e.stopPropagation();
    }, true);
  }
  host.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (term.hasSelection()) { window.manager.copyText(term.getSelection()); term.clearSelection(); return; }
    pasteClipboard(term, id);
  });
  // Files dropped on a terminal: their paths typed in, quoted when they have spaces (as Windows Terminal does).
  host.addEventListener("dragover", e => {
    if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  host.addEventListener("drop", e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    term.focus();
    // A terminal on another computer cannot read a path here: the files go there first (up to 10 MB each).
    if (getTerminal(id)?.node) {
      Promise.all(files.map(async f => {
        if (f.size > 10 * 1024 * 1024) { toast(t("term.uploadTooBig", { name: f.name }), true); return ""; }
        return window.terminals.uploadFile(id, f.name, await f.arrayBuffer());
      })).then(paths => { const list = paths.filter(Boolean); if (list.length) term.paste(list.map(terminalFilePath).join(" ")); }, err => toast(err.message, true));
      return;
    }
    const paths = files.map(f => window.terminals.getPathForFile(f)).filter(Boolean);
    if (paths.length) term.paste(paths.map(terminalFilePath).join(" "));
  });
  // Clicking into a terminal makes its pane the focused one.
  term.textarea?.addEventListener("focus", () => { if (getShownTab()?.focus !== id) runWorkspace("focus", { term: id }); });
  // size: the terminal's size on its computer and who sets it ({cols, rows, mine, by}), null until attached or when
  // main does not say.
  const view = { host, term, fit, attachedEnd: null, queue: [], size: null, sized: false };
  termViews.set(id, view);
  attachView(id, view).catch(e => toast(e.message, true));
  return view;
}
function disposeTermView(id) {
  const view = termViews.get(id);
  view.term.dispose();
  view.host.remove();
  termViews.delete(id);
}
// One size per terminal: the one of the device that typed last (the host decides, docs/SHARED-SESSIONS.md §4.3). A pane
// always tells what fits it (a "want"); it takes that size itself only while it sets the size or nobody does, and
// otherwise shows the terminal in the size it has there, from the top left (the pane scrolls when that is larger). A
// terminal of a host without these rules (legacy), or a main that does not say, is fitted as always.
function isForeignSize(id) {
  const size = termViews.get(id)?.size;
  return Boolean(size && !size.mine && size.by && !getTerminal(id)?.legacy);
}
function fitTerm(id) {
  const view = termViews.get(id);
  if (!view || !view.host.isConnected || !view.host.offsetWidth) return;
  try {
    // What fits the pane itself: measured without the scrollbars it has while the size is another's (.sized), which
    // would make the want a cell short - and the terminal resized twice once this pane drives.
    const pane = view.host.closest(".pane"), sized = pane?.classList.contains("sized"), body = view.host.parentElement;
    const scroll = sized && body ? [body.scrollLeft, body.scrollTop] : null;
    if (sized) pane.classList.remove("sized");
    const want = view.fit.proposeDimensions();
    if (sized) {
      pane.classList.add("sized");
      if (scroll) [body.scrollLeft, body.scrollTop] = scroll;
    }
    if (!want?.cols || !want?.rows) return;
    window.terminals.resize(id, want.cols, want.rows);
    const size = isForeignSize(id) ? view.size : want;
    if (view.term.cols !== size.cols || view.term.rows !== size.rows) view.term.resize(size.cols, size.rows);
  } catch {}
}
// The terminal drawn in the size it has to have now: another device's, or its pane's own - fitted again when it just
// stopped being another's (or `refit`).
function applyTermSize(id, refit = false) {
  const view = termViews.get(id);
  if (!view) return;
  const foreign = isForeignSize(id), was = view.sized;
  view.sized = foreign;
  // The pane scrolls only while the size is another's: its scrollbars go before it measures what fits it, else the
  // first fit is a cell short and a second one follows (two resizes of the terminal for one change).
  view.host.closest(".pane")?.classList.toggle("sized", foreign);
  if (!foreign) { if (refit || was) fitTerm(id); return; }
  if (view.term.cols !== view.size.cols || view.term.rows !== view.size.rows) view.term.resize(view.size.cols, view.size.rows);
}
// The size main reported (attach, onSize), drawn: the terminal in that size or in its own, the header's chip with it.
function setTermSize(id, s) {
  const view = termViews.get(id);
  if (!view) return;
  view.size = Number(s?.cols) > 0 && Number(s?.rows) > 0 ? { cols: s.cols, rows: s.rows, mine: Boolean(s.mine), by: s.by || "" } : null;
  applyTermSize(id, true);
  const tab = getShownTab();
  if (tab && getPanesOf(tab.zoom ? { term: tab.zoom } : tab.root).includes(id)) renderPaneHeads(tab);
}
// "Use my size": this pane's size for the terminal, on every device (until another one types).
function takeSize(id) {
  window.terminals.takeSize(id).catch(e => toast(e.message, true));
}
const fitShown = () => document.querySelectorAll("#panes .pane[data-term]").forEach(el => fitTerm(el.dataset.term));

// ---------- keys ----------
// Ctrl+Shift+1/2/3: a new session of that agent in the shown project (Alt as well: beside the focused pane). By
// e.code, so the keys stay where they are on any keyboard layout (a Bulgarian one too).
const NEW_AGENT_KEYS = { Digit1: "Claude", Digit2: "Codex", Digit3: "OpenCode" };
// The window's own keys, as in Windows Terminal; everything else goes to the program. Ctrl+C copies a selection.
// Only chords no program in a terminal needs: Ctrl+Shift or Alt+Shift ones and Ctrl+, - never a plain Ctrl+letter.
// F1 (the keys popup) only outside a terminal (inTerm false): mc, htop and cmd.exe use it.
function getWorkspaceKey(e, inTerm = false) {
  const plus = e.code === "Equal" || e.code === "NumpadAdd", minus = e.code === "Minus" || e.code === "NumpadSubtract";
  if (e.ctrlKey && e.shiftKey && NEW_AGENT_KEYS[e.code]) return ["new-agent", { agent: NEW_AGENT_KEYS[e.code], place: e.altKey ? "right" : "tab" }];
  if (e.key === "F1" && !inTerm && !e.ctrlKey && !e.altKey && !e.shiftKey) return ["keys", {}];
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "Comma") return ["window", { button: "settings" }];
  if (e.altKey && e.shiftKey && !e.ctrlKey && plus) return ["split", { dir: "right" }];
  if (e.altKey && e.shiftKey && !e.ctrlKey && minus) return ["split", { dir: "down" }];
  if (e.altKey && !e.shiftKey && !e.ctrlKey) {
    const direction = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
    if (direction) return ["focus-dir", { direction }];
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey) {
    if (e.code === "KeyW") return ["close-pane", {}];
    if (e.code === "KeyT") return ["new-tab", {}];
    if (e.code === "KeyZ") return ["zoom", {}];
    if (e.code === "KeyR") return ["resume-latest", {}];
    if (e.code === "KeyH") return ["window", { button: "voiceHistory" }];
    if (e.code === "KeyU") return ["window", { button: "usage" }];
  }
  if (e.ctrlKey && !e.altKey && e.key === "Tab") return ["next-tab", { back: e.shiftKey }];
  if (e.ctrlKey && !e.altKey && !e.shiftKey) {
    if (e.code === "Equal" || e.code === "NumpadAdd") return ["font", { step: 1 }];
    if (e.code === "Minus" || e.code === "NumpadSubtract") return ["font", { step: -1 }];
    if (e.code === "Digit0" || e.code === "Numpad0") return ["font", { step: 0 }];
  }
  return null;
}
function runWorkspaceKey([cmd, args]) {
  if (cmd === "font") return stepTermFont(args.step);
  if (cmd === "keys") return window.shortcutsHelp.toggle();
  // Settings, History and Usage: as their sidebar buttons do (Usage opens and closes).
  if (cmd === "window") return $(args.button).click();
  const tab = getShownTab();
  focusAfterRender = true;
  if (cmd === "split") return tab ? runWorkspace("split", args) : null;
  if (cmd === "focus-dir") return runWorkspace("focus-dir", args);
  if (cmd === "close-pane") return tab ? closePane(tab.focus) : null;
  if (cmd === "zoom") return tab ? runWorkspace("zoom", { tab: tab.id }) : null;
  if (cmd === "new-tab") return runWorkspace("sessions");
  if (cmd === "new-agent") return getInstalledAgents().includes(args.agent) ? openInSpace(args.agent, args.place) : null;
  if (cmd === "resume-latest") return resumeLatest();
  if (cmd === "next-tab") {
    const list = getShownSpace().tabs;
    if (list.length < 2) return null;
    const i = list.indexOf(getShownSpace().active);
    return runWorkspace("tab", { tab: list[(i + (args.back ? -1 : 1) + list.length) % list.length] });
  }
}
function handleTermKey(term, e, id) {
  if (e.type !== "keydown") return true;
  const key = getWorkspaceKey(e, true);
  if (key) {
    e.preventDefault();
    runWorkspaceKey(key);
    return false;
  }
  if (!e.ctrlKey) return true;
  if (e.code === "KeyC" && term.hasSelection()) {
    window.manager.copyText(term.getSelection());
    term.clearSelection();
    return false;
  }
  // The browser pastes; xterm picks the text up from the paste event. A picture has no text: its saved file's path goes in.
  if (e.code !== "KeyV") return true;
  pasteImage(term, id);
  return false;
}
function pasteImage(term, id) {
  window.terminals.saveClipboardImage(id).then(file => { if (file) term.paste(terminalFilePath(file)); }, err => toast(err.message, true));
}
// The clipboard's text typed in (xterm wraps it for bracketed paste), or a picture's saved file.
function pasteClipboard(term, id) {
  term.focus();
  window.manager.readClipboardText().then(text => (text ? term.paste(text) : pasteImage(term, id)), err => toast(err.message, true));
}
// The same keys when the keyboard is elsewhere in the window (not typing in a field).
document.addEventListener("keydown", e => {
  if (e.target.closest?.(".term-host") || e.target.matches?.("input, textarea, select")) return;
  const key = getWorkspaceKey(e);
  if (!key) return;
  e.preventDefault();
  runWorkspaceKey(key);
});

// ---------- actions ----------
// X (and Ctrl+Shift+W, a tab's X or middle click) hides the pane: the terminal keeps running and can be opened again
// from the sidebar, so nothing is asked.
const closePane = term => runWorkspace("close-pane", { term });
const closeTab = tabId => runWorkspace("close-tab", { tab: tabId });
// Stop: the terminal ends on its computer, for every device that has it open - asked first, naming them. x: the
// terminal as the view lists it, or what is known of it ({id, cwd, agent, sessionId, title, node}) when it is not listed.
function confirmStop(x) {
  const names = getViewerNames(getOtherViewers(x));
  const vars = { title: getTermTitle(x), cwd: x.cwd || "", where: x.node ? nodeNameOf(x.node) : t("term.thisComputer"), viewers: names ? t("term.viewersSuffix", { names }) : "" };
  return confirmDialog({ title: t("term.stopAll"), body: t(x.agent ? "term.stopAgentConfirm" : "term.stopShellConfirm", vars), confirmLabel: t("term.stop"), danger: true });
}
async function stopTerm(id, known = null) {
  const x = getTerminal(id) || (known && { ...known, id });
  if (!x || !(await confirmStop(x))) return;
  try { await window.terminals.stop(id); } catch (e) { toast(e.message, true); }
}
// A terminal comes up here: its pane focused, or - with no pane here - a new one (a tab of its project unless `place`
// says beside the focused pane).
function openTerm(id, place = "tab") {
  focusAfterRender = true;
  return isPaned(getTerminal(id)) ? runWorkspace("focus", { term: id }) : runWorkspace("open-term", { term: id, place });
}
// what: "terminal" or an agent's name; a new tab in the shown space's folder.
async function openInSpace(what, place = "tab") {
  const folder = getSpaceFolder(ws.activeSpace);
  if (!folder) return;
  try {
    if (what === "terminal") await window.manager.launchFolder(folder, place);
    else await window.manager.launchNew(what, folder, place);
  } catch (e) { toast(e.message, true); }
}

// ---------- sessions <-> terminals (main links a new session's terminal: tab-links.js) ----------
// The terminal of AgentDeck a session runs in, on its computer - with a pane here or not, whichever device opened it:
// linked to the session, or the one its live state names (`term`, the host's own word for it).
function findSessionTab(s) {
  if (!s) return null;
  const term = getSessionTerm(s);
  return ws.terminals.find(x => (x.node || "") === (s.node || "") && !x.exited && ((x.agent === s.agent && x.sessionId === s.id) || (term && x.id === term))) || null;
}
// The terminal id a running session's live state names ("" outside a terminal of AgentDeck; undefined from a host
// that does not say).
const getSessionTerm = s => (s ? liveOf(s)?.term : undefined);
// The terminal of AgentDeck a running session is in, on its computer ("" outside one).
const getAgentTerm = s => (s && (findSessionTab(s)?.id || getSessionTerm(s))) || "";
// Brings up the session's terminal - its pane, or a new one (placed as openTerm's) when it has none here; false when it
// runs in none.
function showSessionTab(s, place = "tab") {
  const term = getAgentTerm(s);
  if (!term) return false;
  openTerm(term, place);
  return true;
}
// "Move here" ends a session elsewhere and resumes it here: only for one that runs outside AgentDeck's terminals.
function isMoveHereOffered(s) {
  return s.agent === "Claude" && !findSessionTab(s) && !getSessionTerm(s);
}
async function moveSessionHere(s) {
  toast(t("term.moving"));
  try { await window.terminals.move(s.agent, s.id); }
  catch (e) { toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true); }
}
// The session a terminal runs, from the scan (renderer.js data), if it is linked to one.
function getTermSession(x) {
  return x?.sessionId ? data.sessions.find(s => s.agent === x.agent && s.id === x.sessionId && (s.node || "") === (x.node || "")) || null : null;
}
const getTermTitle = x => getTermSession(x)?.title || x?.title || "";
function getTermLive(x) {
  return x?.sessionId ? allLive.get(sessionKey({ agent: x.agent, id: x.sessionId, node: x.node })) || null : null;
}
// The computer a terminal runs on, as a small mark beside its title - drawn once any terminal runs on another
// computer, and then on every one (this computer's too), so none is left to guess.
const getNodeName = id => (typeof getNode === "function" && getNode(id)?.name) || id;
// Only terminals with a pane here count: the list also carries every terminal of the other computers.
const hasRemoteTerminals = () => ws.terminals.some(x => x.node && !x.exited && isPaned(x));
function getComputerMark(nodeIds) {
  if (!hasRemoteTerminals()) return "";
  // The other computers first: in a tab that mixes them, theirs is the name worth the room.
  const ids = [...new Set(nodeIds.map(id => id || ""))].sort((a, b) => Boolean(b) - Boolean(a));
  if (!ids.length) return "";
  const names = ids.map(id => (id ? getNodeName(id) : window.limitsUi?.getLocalName?.() || t("manager.devices.local")));
  const remote = ids.some(Boolean);
  const offline = remote && ids.filter(Boolean).every(id => typeof getNode === "function" && getNode(id)?.status !== "online");
  return `<span class="term-node ${remote ? "remote" : "local"} ${offline ? "offline" : ""}" title="${esc(names.join(", "))}">${icon(remote ? "nodes" : "window")}<span>${esc(names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0])}</span></span>`;
}
// A tab's state: the most urgent of its panes' (needs you, working, waiting).
function getTabLive(tab) {
  const states = getPanesOf(tab.root).map(id => getTermLive(getTerminal(id))).filter(Boolean);
  return states.sort((a, b) => getLiveRank(a) - getLiveRank(b))[0] || null;
}

// ---------- drawing ----------
function renderTabbar() {
  const space = getShownSpace();
  const tabs = space.tabs.map(id => ws.tabs[id]).filter(Boolean);
  const html = tabs.map((tab, i) => {
    const l = getTabLive(tab);
    const label = tab.name || getTermTitle(getTerminal(tab.focus)) || String(i + 1);
    return `<div class="wtab ${tab.id === space.active ? "active" : ""}" data-tab="${esc(tab.id)}" role="tab" draggable="true" title="${esc(label)}">
      ${l ? statusMark(l, false) : ""}<span class="wtab-name">${esc(label)}</span>${getComputerMark(getPanesOf(tab.root).map(id => getTerminal(id)?.node))}
      <button class="wtab-close wtab-rename-btn" data-ws="rename-tab" title="${esc(t("action.rename"))}" aria-label="${esc(t("action.rename"))}">${icon("pencil")}</button>
      <button class="wtab-close" data-ws="close-tab" title="${esc(t("ws.hideTab"))}">${icon("x")}</button></div>`;
  }).join("") + `<button class="icon-btn wtab-new ${!space.active ? "active" : ""}" data-ws="sessions" title="${esc(t("ws.sessions"))}" aria-label="${esc(t("ws.sessions"))}">${icon("plus")}</button>`;
  // Rebuilt only when something shows differently, and not while a tab is dragged: a click or a drag in progress is
  // not lost.
  const bar = $("tabbar");
  if (draggedTab || bar.querySelector(".wtab-rename") || bar.dataset.html === html) return;
  bar.dataset.html = html;
  bar.innerHTML = html;
  bar.querySelector(".wtab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  markTabOverflow();
}
// More tabs than fit: the bar fades at the end that hides some, and the wheel moves along it.
function markTabOverflow() {
  const bar = $("tabbar");
  bar.classList.toggle("more-left", bar.scrollLeft > 1);
  bar.classList.toggle("more-right", bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1);
}
// The panes of the shown tab (or its zoomed pane), built anew only when the layout changed; the terminals' own
// elements move into them, so nothing they show is lost.
function renderPanes() {
  const tab = getShownTab();
  const root = tab ? (tab.zoom ? { term: tab.zoom } : tab.root) : null;
  const sig = JSON.stringify([ws.activeSpace, tab?.id, root && getShape(root)]);
  $("panes").hidden = !tab;
  $("spaceEmpty").hidden = Boolean(tab);
  if (!tab) {
    layoutSig = sig;
    // The last tab of the space went: its panes go from the page too (not only out of sight).
    $("panes").replaceChildren();
    renderSpaceEmpty($("spaceEmpty"), ws.activeSpace);
    return;
  }
  if (sig !== layoutSig) {
    layoutSig = sig;
    const box = $("panes");
    box.replaceChildren(buildNode(root, ""));
    requestAnimationFrame(fitShown);
  } else if (applyRatios($("panes").firstElementChild, root)) {
    requestAnimationFrame(fitShown);
  }
  renderPaneHeads(tab);
  document.querySelectorAll("#panes .pane").forEach(el => el.classList.toggle("focused", el.dataset.term === tab.focus));
  if (focusAfterRender) {
    focusAfterRender = false;
    termViews.get(tab.focus)?.term.focus();
  }
}
function buildNode(node, path) {
  if (node.term) {
    const el = document.createElement("div");
    el.className = "pane";
    el.dataset.term = node.term;
    el.innerHTML = '<div class="pane-head"><div class="pane-info" draggable="true"></div><span class="pane-tools"></span></div><div class="pane-body"></div>';
    const view = termViews.get(node.term) || createTermView(node.term);
    el.lastChild.appendChild(view.host);
    return el;
  }
  const el = document.createElement("div");
  el.className = `split ${node.dir}`;
  const divider = document.createElement("div");
  divider.className = "divider";
  divider.dataset.path = path;
  el.append(buildNode(node.a, path + "a"), divider, buildNode(node.b, path + "b"));
  setSplitRatio(el, clampRatio(node.ratio));
  return el;
}
// A split's two sides sharing it `ratio` to 1 - `ratio`. Answers whether that changed.
function setSplitRatio(split, ratio) {
  if (split.dataset.ratio === String(ratio)) return false;
  split.dataset.ratio = String(ratio);
  const [a, , b] = split.children;
  a.style.flex = `${ratio} 1 0`;
  b.style.flex = `${1 - ratio} 1 0`;
  return true;
}
// The layout's ratios on the splits built for it, in place; a split being dragged keeps the pointer's. Answers whether
// any changed (the terminals are then fitted again).
function applyRatios(el, node) {
  if (!node || node.term || !el?.classList.contains("split")) return false;
  const [a, , b] = el.children;
  const here = !el.classList.contains("dragging") && setSplitRatio(el, clampRatio(node.ratio));
  const inA = applyRatios(a, node.a), inB = applyRatios(b, node.b);
  return here || inA || inB;
}
// Every split back to half - one tab's, or all of them. Uses the per-split command main already has, so it works even
// when the layout changed under a page that predates a reset command.
function resetRatios(tabId = "") {
  const jobs = [];
  const visit = (tab, node, path) => {
    if (!node || node.term) return;
    if (node.ratio !== 0.5) jobs.push(runWorkspace("ratio", { tab: tab.id, path, ratio: 0.5 }));
    visit(tab, node.a, path + "a"); visit(tab, node.b, path + "b");
  };
  for (const tab of tabId ? [ws.tabs[tabId]] : Object.values(ws.tabs)) if (tab) visit(tab, tab.root, "");
  return Promise.all(jobs);
}
// Each pane's header: the agent, what runs, its context and its state on the left, the pane's buttons on the right.
// The two halves are drawn apart, so the buttons stay the same elements while a title or a state changes - a click on
// one is never lost to a redraw. A pane alone in its tab shows its folder: the tab above already carries its title.
function renderPaneHeads(tab) {
  if (draggedPane) return; // the header being dragged stays the same element until it is let go
  const many = getPanesOf(tab.root).length > 1;
  document.querySelectorAll("#panes .pane").forEach(el => {
    const id = el.dataset.term, x = getTerminal(id);
    const s = getTermSession(x), l = getTermLive(x);
    // Opened from another device: said in the title's tooltip.
    const from = x?.ownerName ? `\n${t("term.openedBy", { name: x.ownerName })}` : "";
    const title = many ? `<span class="pane-title" title="${esc((x?.cwd || "") + from)}">${esc(getTermTitle(x))}</span>`
      : `<span class="pane-title pane-dir" title="${esc(getTermTitle(x) + from)}">${esc(x?.cwd || getTermTitle(x))}</span>`;
    const note = x?.note || (x?.reopened ? t("term.reopened") : "");
    const foreign = isForeignSize(id);
    el.classList.toggle("sized", foreign);
    setHtml(el.querySelector(".pane-info"), `${x?.agent ? agentMark(x.agent) : `<span class="agent-mark">${icon("terminal")}</span>`}${title}
      ${x ? getComputerMark([x.node]) : ""}${note ? `<span class="pane-note">${esc(note)}</span>` : ""}
      ${s ? getContextChip(s) : ""}${l ? statusMark(l, isLoading(sessionKey(l), l)) : ""}${getViewersHtml(x, "pane-viewers")}${foreign ? getSizeChipHtml(termViews.get(id).size) : ""}`);
    setHtml(el.querySelector(".pane-tools"), `<button class="icon-btn" data-ws="split-right" title="${esc(t("ws.splitRight"))}">${icon("splitRight")}</button>
        <button class="icon-btn" data-ws="split-down" title="${esc(t("ws.splitDown"))}">${icon("splitDown")}</button>
        ${many ? `<button class="icon-btn" data-ws="reset-panes" title="${esc(t("ws.resetPanes"))}" aria-label="${esc(t("ws.resetPanes"))}">${icon("equal")}</button>` : ""}
        ${many ? `<button class="icon-btn ${tab.zoom ? "on" : ""}" data-ws="zoom" title="${esc(t(tab.zoom ? "ws.unzoom" : "ws.zoom"))}">${icon("maximize")}</button>` : ""}
        ${foreign ? `<button class="icon-btn on" data-ws="take-size" title="${esc(t("term.useMySize"))}" aria-label="${esc(t("term.useMySize"))}">${icon("fit")}</button>` : ""}
        <button class="icon-btn danger" data-ws="stop" title="${esc(t("term.stopAll"))}" aria-label="${esc(t("term.stopAll"))}">${icon("stop")}</button>
        <button class="icon-btn" data-ws="close-pane" title="${esc(t("ws.closePane"))}" aria-label="${esc(t("ws.closePane"))}">${icon("x")}</button>`);
  });
}
// The other devices that have a terminal open: an eye and how many, their names in the tooltip ("" when none).
function getViewersHtml(x, cls) {
  const others = getOtherViewers(x);
  return others.length ? `<span class="${cls}" title="${esc(t("term.viewers", { names: getViewerNames(others) }))}">${icon("eye")}${others.length}</span>` : "";
}
// The size another device set: small, with who it is; what to do about it in the tooltip.
function getSizeChipHtml(size) {
  return `<span class="size-chip" title="${esc(t("term.sizeBy", { cols: size.cols, rows: size.rows, name: size.by }))}">${size.cols}×${size.rows} · ${esc(size.by)}</span>`;
}
// The terminals with a pane in the layout (any tab of any space): the window keeps a view of these only.
const getPanedIds = () => new Set(Object.values(ws.tabs).flatMap(tab => getPanesOf(tab?.root)));
function renderWorkspace() {
  // A terminal whose pane went (hidden, or the terminal ended) loses its view: main sends no output for it any more,
  // and a pane shown again later attaches anew with the whole scrollback (main.js panesChanged).
  const paned = getPanedIds();
  [...termViews.keys()].filter(id => !paned.has(id)).forEach(disposeTermView);
  // A terminal can turn legacy or plain again (its computer was updated, reconnected): its size follows.
  termViews.forEach((_view, id) => applyTermSize(id));
  renderTabbar();
  renderPanes();
  syncAnimations();
}

// ---------- events ----------
// Output of a terminal with a pane (main sends no other; the layout that adds a pane comes before its output). One
// that arrives after its pane went (hidden just now) has nothing to go to.
window.terminals.onData(({ id, data, end }) => {
  const view = termViews.get(id) || (getPanedIds().has(id) ? createTermView(id) : null);
  if (!view) return;
  if (view.attachedEnd === null) view.queue.push({ data, end });
  else writeAfter(view, data, end);
});
// Another viewer (a phone) sized the terminal and let go of it: its pane, when shown, gives it its own size back (a
// hidden one does when it is shown next). Only older hosts send this; newer ones hand the size back themselves.
window.terminals.onRefit(id => fitTerm(id));
// The terminal's size there changed, or who sets it.
window.terminals.onSize(s => setTermSize(s?.id, s));
// A terminal with a pane here ended, or was stopped from another device: its pane goes (the layout says so), this says why.
window.terminals.onEnded(e => toast(t("term.ended", { title: e?.title || getTermTitle(getTerminal(e?.id)) })));
// The drawing reads renderer.js's session data, and the page may hear from main between two of its scripts (a layout
// restored on start arrives at once): nothing is drawn before every script ran.
const isPageLoading = () => document.readyState === "loading";
window.terminals.onWorkspace(next => {
  const before = getShownTab()?.focus;
  ws = next;
  wsPushed = true;
  if (isPageLoading()) return;
  // Something new came up (a launch, a split, "show terminal"): the keyboard goes to it.
  if (getShownTab()?.focus !== before) focusAfterRender = true;
  renderWorkspace();
  onWorkspaceChanged();
});
window.prefs.onChanged(p => { requestAnimationFrame(applyTermTheme); applyTermFont(p.terminalFontSize); });
new ResizeObserver(() => fitShown()).observe($("panes"));

$("tabbar").addEventListener("click", e => {
  if (e.target.closest(".wtab-rename")) return;
  const tabEl = e.target.closest("[data-tab]");
  const btn = e.target.closest("[data-ws]");
  if (btn?.dataset.ws === "close-tab") { e.stopPropagation(); return closeTab(tabEl.dataset.tab); }
  if (btn?.dataset.ws === "rename-tab") { e.stopPropagation(); return renameWorkspaceTab(tabEl); }
  if (btn?.dataset.ws === "sessions") return runWorkspace("sessions");
  if (tabEl) { focusAfterRender = true; runWorkspace("tab", { tab: tabEl.dataset.tab }); }
});
$("tabbar").addEventListener("scroll", markTabOverflow);
$("tabbar").addEventListener("wheel", e => {
  const bar = e.currentTarget;
  if (e.deltaX || !e.deltaY || bar.scrollWidth <= bar.clientWidth) return;
  e.preventDefault();
  bar.scrollLeft += e.deltaY;
}, { passive: false });
new ResizeObserver(markTabOverflow).observe($("tabbar"));
// A press on a tab's button is a click, never the start of dragging the tab.
$("tabbar").addEventListener("pointerdown", e => {
  const tabEl = e.target.closest("button") && e.target.closest(".wtab");
  if (!tabEl) return;
  tabEl.draggable = false;
  window.addEventListener("pointerup", () => { tabEl.draggable = true; }, { once: true });
});
$("tabbar").addEventListener("auxclick", e => {
  const tabEl = e.target.closest("[data-tab]");
  if (tabEl && e.button === 1) closeTab(tabEl.dataset.tab);
});
$("tabbar").addEventListener("dblclick", e => {
  const tabEl = e.target.closest("[data-tab]");
  if (!tabEl || e.target.closest("button")) return;
  renameWorkspaceTab(tabEl);
});
function renameWorkspaceTab(tabEl) {
  if (!tabEl || tabEl.querySelector("input")) return;
  const tab = ws.tabs[tabEl.dataset.tab];
  if (!tab) return;
  const input = document.createElement("input");
  input.className = "wtab-rename";
  input.maxLength = 80;
  input.value = tab.name || getTermTitle(getTerminal(tab.focus));
  input.setAttribute("aria-label", t("action.rename"));
  tabEl.draggable = false;
  tabEl.querySelector(".wtab-name").replaceWith(input);
  let cancelled = false;
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") { cancelled = true; input.blur(); }
    else if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  });
  input.addEventListener("blur", async () => {
    const name = input.value.trim();
    input.remove();
    $("tabbar").dataset.html = "";
    if (!cancelled) await runWorkspace("rename-tab", { tab: tab.id, name });
    renderTabbar();
  }, { once: true });
  input.focus(); input.select();
}
$("panes").addEventListener("click", e => {
  const btn = e.target.closest("[data-ws]");
  const pane = e.target.closest(".pane");
  if (!pane) return;
  const term = pane.dataset.term, tab = getShownTab();
  if (!btn) { if (tab?.focus !== term) runWorkspace("focus", { term }); return; }
  focusAfterRender = true;
  const run = () => {
    if (btn.dataset.ws === "split-right") return runWorkspace("split", { dir: "right" });
    if (btn.dataset.ws === "split-down") return runWorkspace("split", { dir: "down" });
    if (btn.dataset.ws === "reset-panes") return resetRatios(tab.id);
    if (btn.dataset.ws === "zoom") return runWorkspace("zoom", { tab: tab.id });
    if (btn.dataset.ws === "close-pane") return closePane(term);
    if (btn.dataset.ws === "take-size") return takeSize(term);
    if (btn.dataset.ws === "stop") return stopTerm(term);
  };
  // A pane's buttons act on that pane: it is focused first.
  if (tab?.focus !== term) runWorkspace("focus", { term }).then(run); else run();
});
// Dragging a divider: the panes follow the pointer, main hears the new share once it is let go.
$("panes").addEventListener("pointerdown", e => {
  const divider = e.target.closest(".divider");
  if (!divider) return;
  e.preventDefault();
  const split = divider.parentElement;
  const across = split.classList.contains("right");
  const rect = split.getBoundingClientRect();
  let ratio = null; // the pointer's, once it moved
  divider.setPointerCapture(e.pointerId);
  split.classList.add("dragging");
  const move = ev => {
    ratio = Math.min(0.9, Math.max(0.1, across ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height));
    setSplitRatio(split, ratio);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("lostpointercapture", () => {
    divider.removeEventListener("pointermove", move);
    split.classList.remove("dragging");
    if (ratio === null) return; // a click: the split stays as it is
    fitShown();
    runWorkspace("ratio", { tab: getShownTab()?.id, path: divider.dataset.path, ratio });
  }, { once: true });
});

// ---------- dragging: tabs to reorder or to join, panes to move ----------
// A tab dragged onto another tab takes its place; onto a pane, its panes go beside that one. A pane's header dragged
// onto another pane moves the pane there; onto the tab bar, the pane gets a tab of its own.
// A sidebar row (a terminal in "Terminals", a session with a terminal in "Agents") dragged onto a pane opens its
// terminal on that side of it, or in a tab of its own from the pane's middle or the tab bar; one with a pane here moves.
// A pane or a tab dragged onto the sidebar is hidden (close-pane / close-tab: the terminal keeps running).
// Held over another tab for SPRING_MS while dragging, that tab comes up, so its panes can take the drop.
let draggedTab = "", draggedPane = "", draggedTerm = "";
// Marks on the drag's data: what is dragged is told by the drag itself, not only by the variables above, which a
// dragend lost with its row (the sidebar redraws while a row is dragged) would leave set.
const DRAG_LAYOUT = "application/x-agentdeck-layout", DRAG_TERM = "application/x-agentdeck-term";
const isDragOf = (e, type) => Boolean(e.dataTransfer?.types.includes(type));
let springTab = "", springTimer = null;
const SPRING_MS = 600;
function springToTab(el) {
  const id = el?.dataset.tab || "";
  if (id === springTab) return;
  clearTimeout(springTimer);
  springTab = id;
  if (id && id !== draggedTab && id !== getShownTab()?.id) springTimer = setTimeout(() => runWorkspace("tab", { tab: id }), SPRING_MS);
}
const PANE_SIDES = ["left", "right", "up", "down"];
const getTabDropSide = (el, e) => (e.clientX > el.getBoundingClientRect().left + el.offsetWidth / 2 ? "after" : "before");
// The side of the pane the pointer is nearest to.
function getPaneDropSide(el, e) {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  return Math.min(x, 1 - x) < Math.min(y, 1 - y) ? (x < 0.5 ? "left" : "right") : (y < 0.5 ? "up" : "down");
}
function clearTabDropMarks() {
  document.querySelectorAll(".wtab.drop-before, .wtab.drop-after, .wtab.dragging").forEach(el => el.classList.remove("drop-before", "drop-after", "dragging"));
}
// A sidebar row's terminal over a pane: its middle (a fifth of it each way from the centre) means a tab of its own.
function getTermDropPlace(el, e) {
  const r = el.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  return Math.abs(x - 0.5) < 0.2 && Math.abs(y - 0.5) < 0.2 ? "center" : getPaneDropSide(el, e);
}
function clearPaneDropMarks() {
  document.querySelectorAll("#panes .pane").forEach(el => el.classList.remove(...[...PANE_SIDES, "center"].map(s => "drop-" + s)));
  $("tabbar").classList.remove("drop-new");
}
function endDrag() {
  draggedTab = "";
  draggedPane = "";
  draggedTerm = "";
  springToTab(null);
  clearTabDropMarks();
  clearPaneDropMarks();
  $("sideOverview").classList.remove("drop-hide");
}
// A tab or a pane of this window is what is dragged now. The drag has to say so itself: a tab that comes up under a
// held drag (springToTab) redraws the panes, the dragged header leaves the page and its dragend with it, so the
// variables alone would make the next drag - a file, a selection - move a pane nobody touched.
const isLayoutDrag = e => Boolean((draggedPane || draggedTab) && isDragOf(e, DRAG_LAYOUT));
// The pointer moves only when nothing is dragged (a drag takes it): whatever a lost dragend left behind goes.
window.addEventListener("pointermove", () => { if (draggedPane || draggedTab || draggedTerm) endDrag(); }, true);
// The terminal a sidebar row drags ("" in any other drag). renderer.js starts it (startTermDrag).
const getDraggedTerm = e => (draggedTerm && isDragOf(e, DRAG_TERM) ? draggedTerm : "");
function startTermDrag(term, e) {
  endDrag();
  draggedTerm = term;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData(DRAG_TERM, term);
}
// The tab that has a pane of `term` here, if any.
const getTermTab = term => Object.values(ws.tabs).find(tab => getPanesOf(tab?.root).includes(term)) || null;
// A row's terminal dropped on `place` of the pane of `at`: one with no pane here opens there (on this or another
// computer - main finds it), one with a pane moves there.
function dropTerm(term, at, place) {
  if (place === "center") return dropTermAsTab(term);
  focusAfterRender = true;
  if (getTermTab(term)) return runWorkspace("move-pane", { term, into: getShownTab()?.id, at, side: place });
  return runWorkspace("open-term", { term, place, at });
}
// ... in a tab of its own: a new one in its project's space, or its pane out of its tab (just focused when alone there).
function dropTermAsTab(term) {
  focusAfterRender = true;
  const tab = getTermTab(term);
  if (!tab) return runWorkspace("open-term", { term, place: "tab" });
  return runWorkspace(getPanesOf(tab.root).length > 1 ? "detach-pane" : "focus", { term });
}
// The pane under the pointer that the dragged tab, pane or row may land beside: not the dragged pane itself (nor the
// row's own), nor a pane of the dragged tab (the shown one).
function getDropPane(e) {
  const el = e.target.closest?.(".pane"), term = getDraggedTerm(e);
  if (!el || (!term && !isLayoutDrag(e))) return null;
  if (term) return term === el.dataset.term ? null : el;
  return draggedPane === el.dataset.term || draggedTab === getShownTab()?.id ? null : el;
}
$("panes").addEventListener("dragstart", e => {
  const pane = e.target.closest?.(".pane-head")?.closest(".pane");
  if (!pane) return;
  endDrag();
  draggedPane = pane.dataset.term;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedPane);
  e.dataTransfer.setData(DRAG_LAYOUT, draggedPane);
});
$("panes").addEventListener("dragover", e => {
  const el = getDropPane(e);
  if (!el) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const mark = "drop-" + (getDraggedTerm(e) ? getTermDropPlace(el, e) : getPaneDropSide(el, e));
  if (!el.classList.contains(mark)) { clearPaneDropMarks(); el.classList.add(mark); }
});
$("panes").addEventListener("dragleave", e => { if (!$("panes").contains(e.relatedTarget)) clearPaneDropMarks(); });
$("panes").addEventListener("drop", e => {
  const el = getDropPane(e);
  if (!el) return;
  e.preventDefault();
  const side = getPaneDropSide(el, e), into = getShownTab()?.id, at = el.dataset.term, term = getDraggedTerm(e);
  if (term) dropTerm(term, at, getTermDropPlace(el, e));
  else if (draggedTab) runWorkspace("merge-tab", { tab: draggedTab, into, at, side });
  else runWorkspace("move-pane", { term: draggedPane, into, at, side });
  endDrag();
});
$("panes").addEventListener("dragend", endDrag);
$("tabbar").addEventListener("dragstart", e => {
  const el = e.target.closest?.(".wtab");
  if (!el) return;
  endDrag();
  draggedTab = el.dataset.tab;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedTab);
  e.dataTransfer.setData(DRAG_LAYOUT, draggedTab);
  el.classList.add("dragging");
});
$("tabbar").addEventListener("dragover", e => {
  const term = getDraggedTerm(e);
  if (!term && !isLayoutDrag(e)) return;
  springToTab(e.target.closest?.(".wtab"));
  if (term) {
    // A row's terminal on the tab bar: a tab of its own.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    $("tabbar").classList.add("drop-new");
    return;
  }
  if (draggedPane) {
    // A pane alone in its tab has a tab of its own already.
    if (getPanesOf(getShownTab()?.root).length < 2) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    $("tabbar").classList.add("drop-new");
    return;
  }
  const el = e.target.closest?.(".wtab");
  if (!el || !draggedTab || el.dataset.tab === draggedTab) return;
  e.preventDefault();
  document.querySelectorAll(".wtab.drop-before, .wtab.drop-after").forEach(x => x.classList.remove("drop-before", "drop-after"));
  el.classList.add("drop-" + getTabDropSide(el, e));
});
$("tabbar").addEventListener("dragleave", e => {
  if ($("tabbar").contains(e.relatedTarget)) return;
  $("tabbar").classList.remove("drop-new");
  springToTab(null);
});
$("tabbar").addEventListener("drop", e => {
  const term = getDraggedTerm(e);
  if (term) {
    e.preventDefault();
    dropTermAsTab(term);
    endDrag();
    return;
  }
  if (!isLayoutDrag(e)) return;
  if (draggedPane) {
    e.preventDefault();
    runWorkspace("detach-pane", { term: draggedPane });
    endDrag();
    return;
  }
  const el = e.target.closest?.(".wtab");
  if (!el || !draggedTab) return;
  e.preventDefault();
  const ids = getShownSpace().tabs.filter(id => id !== draggedTab);
  ids.splice(ids.indexOf(el.dataset.tab) + (getTabDropSide(el, e) === "after" ? 1 : 0), 0, draggedTab);
  endDrag();
  runWorkspace("reorder-tabs", { space: ws.activeSpace, ids });
});
$("tabbar").addEventListener("dragend", endDrag);
// A pane or a tab dragged onto the sidebar (projects, agents, terminals) is hidden: it stays in "Agents" / "Terminals"
// and opens again from there.
$("sideOverview").addEventListener("dragover", e => {
  if (!isLayoutDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const side = $("sideOverview");
  side.dataset.dropHint = t(draggedTab ? "ws.dropToHideTab" : "ws.dropToHide");
  side.classList.add("drop-hide");
});
$("sideOverview").addEventListener("dragleave", e => {
  if (!$("sideOverview").contains(e.relatedTarget)) $("sideOverview").classList.remove("drop-hide");
});
$("sideOverview").addEventListener("drop", e => {
  if (!isLayoutDrag(e)) return;
  e.preventDefault();
  const pane = draggedPane, tab = draggedTab;
  endDrag();
  if (pane) closePane(pane); else closeTab(tab);
});

// The headers and tab states follow the live registry and the scan.
setInterval(() => { renderTabbar(); const tab = getShownTab(); if (tab) renderPaneHeads(tab); syncAnimations(); }, HEADERS_REFRESH_MS);
// The first drawing: of the layout main sent while the page loaded when it did, else of the one asked for - unless
// main sends one before the answer comes (a layout restored on start): the older answer would put back what that showed.
function drawFirst() {
  const draw = () => { renderWorkspace(); onWorkspaceChanged(); };
  if (wsPushed) return draw();
  window.terminals.getWorkspace().then(next => {
    if (wsPushed) return;
    ws = next;
    draw();
  }).catch(e => console.error(e));
}
if (isPageLoading()) document.addEventListener("DOMContentLoaded", drawFirst, { once: true });
else drawFirst();
