// The centre of the manager window: the shown project's tabs, and the shown tab split into panes, each a terminal
// (xterm.js) of AgentDeck's own. The layout lives in main (workspace.js); this page draws it and sends commands back.
// Loaded before renderer.js, which provides the session data (data, live) and calls showSessionTab, findSessionTab,
// isMoveHereOffered, moveSessionHere, renderWorkspace and runWorkspace.
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
const getShownSpace = () => ws.spaces[ws.activeSpace] || { tabs: [], active: "" };
const getShownTab = () => ws.tabs[getShownSpace().active] || null;
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
function applyTermTheme() {
  const theme = getTermTheme();
  termViews.forEach(view => { view.term.options.theme = theme; });
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
  if (!a) return;
  view.term.write(a.scrollback);
  view.attachedEnd = a.end;
  view.queue.forEach(chunk => writeAfter(view, chunk.data, chunk.end));
  view.queue = [];
}
function createTermView(id) {
  const host = document.createElement("div");
  host.className = "term-host";
  const term = new Terminal({ fontFamily: TERM_FONT, fontSize: termFontSize, cursorBlink: true, scrollback: 10000, theme: getTermTheme() });
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
  const view = { host, term, fit, attachedEnd: null, queue: [] };
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
function fitTerm(id) {
  const view = termViews.get(id);
  if (!view || !view.host.isConnected || !view.host.offsetWidth) return;
  try {
    view.fit.fit();
    window.terminals.resize(id, view.term.cols, view.term.rows);
  } catch {}
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
// A terminal running an agent asks first; a plain shell closes at once.
function closePane(term) {
  const x = getTerminal(term);
  if (x?.agent && !confirm(t("ws.closeConfirm"))) return;
  runWorkspace("close-pane", { term });
}
function closeTab(tabId) {
  const terms = getPanesOf(ws.tabs[tabId]?.root);
  if (terms.some(id => getTerminal(id)?.agent) && !confirm(t("ws.closeTabConfirm", { n: terms.length }))) return;
  runWorkspace("close-tab", { tab: tabId });
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
function findSessionTab(s) {
  return ws.terminals.find(x => x.agent === s.agent && x.sessionId === s.id && (x.node || "") === (s.node || "") && !x.exited) || null;
}
// Brings up the session's pane when it has one; false otherwise.
function showSessionTab(s) {
  const x = s && findSessionTab(s);
  if (!x) return false;
  focusAfterRender = true;
  runWorkspace("focus", { term: x.id });
  return true;
}
function isMoveHereOffered(s) {
  return s.agent === "Claude" && !findSessionTab(s);
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
      ${l ? statusMark(l, false) : ""}<span class="wtab-name">${esc(label)}</span>
      <button class="wtab-close wtab-rename-btn" data-ws="rename-tab" title="${esc(t("action.rename"))}" aria-label="${esc(t("action.rename"))}">${icon("pencil")}</button>
      <button class="wtab-close" data-ws="close-tab" title="${esc(t("ws.closeTab"))}">${icon("x")}</button></div>`;
  }).join("") + `<button class="icon-btn wtab-new ${!space.active ? "active" : ""}" data-ws="sessions" title="${esc(t("ws.sessions"))}" aria-label="${esc(t("ws.sessions"))}">${icon("plus")}</button>` + `<button class="icon-btn wtab-new wtab-reset" data-ws="reset-tabs" title="${esc(t("ws.resetTabs"))}" aria-label="${esc(t("ws.resetTabs"))}">${icon("equal")}</button>`;
  // Rebuilt only when something shows differently, and not while a tab is dragged: a click or a drag in progress is
  // not lost.
  const bar = $("tabbar");
  if (draggedTab || bar.querySelector(".wtab-rename") || bar.dataset.html === html) return;
  bar.dataset.html = html;
  bar.innerHTML = html;
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
    el.innerHTML = '<div class="pane-head" draggable="true"></div><div class="pane-body"></div>';
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
// Each pane's header: the agent, what runs, its context, its state, and the pane's buttons.
function renderPaneHeads(tab) {
  if (draggedPane) return; // the header being dragged stays the same element until it is let go
  const many = getPanesOf(tab.root).length > 1;
  document.querySelectorAll("#panes .pane").forEach(el => {
    const x = getTerminal(el.dataset.term);
    const s = getTermSession(x), l = getTermLive(x);
    const html = `${x?.agent ? agentMark(x.agent) : `<span class="agent-mark">${icon("terminal")}</span>`}
      <span class="pane-title" title="${esc(x?.cwd || "")}">${esc(!many && tab.name ? tab.name : getTermTitle(x))}</span>
      ${x?.note ? `<span class="pane-note">${esc(x.note)}</span>` : ""}
      ${s ? getContextChip(s) : ""}${l ? statusMark(l, isLoading(sessionKey(l), l)) : ""}
      <span class="pane-tools">
        <button class="icon-btn" data-ws="split-right" title="${esc(t("ws.splitRight"))}">${icon("splitRight")}</button>
        <button class="icon-btn" data-ws="split-down" title="${esc(t("ws.splitDown"))}">${icon("splitDown")}</button>
        ${many ? `<button class="icon-btn" data-ws="reset-panes" title="${esc(t("ws.resetPanes"))}" aria-label="${esc(t("ws.resetPanes"))}">${icon("equal")}</button>` : ""}
        ${many ? `<button class="icon-btn ${tab.zoom ? "on" : ""}" data-ws="zoom" title="${esc(t(tab.zoom ? "ws.unzoom" : "ws.zoom"))}">${icon("maximize")}</button>` : ""}
        <button class="icon-btn" data-ws="close-pane" title="${esc(t("ws.closePane"))}">${icon("x")}</button>
      </span>`;
    const head = el.querySelector(".pane-head");
    if (head.dataset.html !== html) { head.dataset.html = html; head.innerHTML = html; }
  });
}
function renderWorkspace() {
  // Terminals that went: their views go too.
  const ids = new Set(ws.terminals.map(x => x.id));
  [...termViews.keys()].filter(id => !ids.has(id)).forEach(disposeTermView);
  renderTabbar();
  renderPanes();
}

// ---------- events ----------
window.terminals.onData(({ id, data, end }) => {
  const view = termViews.get(id) || createTermView(id);
  if (view.attachedEnd === null) view.queue.push({ data, end });
  else writeAfter(view, data, end);
});
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
  if (btn?.dataset.ws === "reset-tabs") return resetRatios();
  if (tabEl) { focusAfterRender = true; runWorkspace("tab", { tab: tabEl.dataset.tab }); }
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
let draggedTab = "", draggedPane = "";
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
function clearPaneDropMarks() {
  document.querySelectorAll("#panes .pane").forEach(el => el.classList.remove(...PANE_SIDES.map(s => "drop-" + s)));
  $("tabbar").classList.remove("drop-new");
}
function endDrag() {
  draggedTab = "";
  draggedPane = "";
  clearTabDropMarks();
  clearPaneDropMarks();
}
// The pane under the pointer that the dragged tab or pane may land beside: not the dragged pane itself, nor a pane of
// the dragged tab (the shown one).
function getDropPane(e) {
  const el = e.target.closest?.(".pane");
  if (!el || (!draggedTab && !draggedPane)) return null;
  return draggedPane === el.dataset.term || draggedTab === getShownTab()?.id ? null : el;
}
$("panes").addEventListener("dragstart", e => {
  const pane = e.target.closest?.(".pane-head")?.closest(".pane");
  if (!pane) return;
  draggedPane = pane.dataset.term;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedPane);
});
$("panes").addEventListener("dragover", e => {
  const el = getDropPane(e);
  if (!el) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const mark = "drop-" + getPaneDropSide(el, e);
  if (!el.classList.contains(mark)) { clearPaneDropMarks(); el.classList.add(mark); }
});
$("panes").addEventListener("dragleave", e => { if (!$("panes").contains(e.relatedTarget)) clearPaneDropMarks(); });
$("panes").addEventListener("drop", e => {
  const el = getDropPane(e);
  if (!el) return;
  e.preventDefault();
  const side = getPaneDropSide(el, e), into = getShownTab()?.id, at = el.dataset.term;
  if (draggedTab) runWorkspace("merge-tab", { tab: draggedTab, into, at, side });
  else runWorkspace("move-pane", { term: draggedPane, into, at, side });
  endDrag();
});
$("panes").addEventListener("dragend", endDrag);
$("tabbar").addEventListener("dragstart", e => {
  const el = e.target.closest?.(".wtab");
  if (!el) return;
  draggedTab = el.dataset.tab;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedTab);
  el.classList.add("dragging");
});
$("tabbar").addEventListener("dragover", e => {
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
$("tabbar").addEventListener("dragleave", e => { if (!$("tabbar").contains(e.relatedTarget)) $("tabbar").classList.remove("drop-new"); });
$("tabbar").addEventListener("drop", e => {
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

// The headers and tab states follow the live registry and the scan.
setInterval(() => { renderTabbar(); const tab = getShownTab(); if (tab) renderPaneHeads(tab); }, HEADERS_REFRESH_MS);
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
