// AgentDeck's own terminal tabs (terminals.js in main): a strip over the sessions panel and an xterm.js view per tab.
// Loaded before renderer.js, which calls showSessionTab, showProjectTab, isMoveHereOffered and moveSessionHere.
const ANSI_NAMES = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"
];
const TABS_REFRESH_MS = 3000;
const termViews = new Map(); // tab id -> { el, term, fit, attachedEnd, queue }
let termTabs = [];
let activeTab = ""; // "" = the sessions list
let tabsHtml = "";

// ---------- looks ----------
function getCssVar(styles, name) {
  return styles.getPropertyValue(name).trim();
}
// theme.css --term-* tokens: --term-ansi-black ... --term-ansi-bright-white for the 16 colours.
function getTermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const theme = {
    background: getCssVar(styles, "--term-bg"),
    foreground: getCssVar(styles, "--term-fg"),
    cursor: getCssVar(styles, "--term-cursor"),
    selectionBackground: getCssVar(styles, "--term-selection")
  };
  for (const name of ANSI_NAMES) {
    theme[name] = getCssVar(styles, `--term-ansi-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
  }
  return theme;
}
function applyTermTheme() {
  const theme = getTermTheme();
  termViews.forEach(view => {
    view.term.options.theme = theme;
  });
}

// ---------- views ----------
function handleTermKey(term, e) {
  if (e.type !== "keydown" || !e.ctrlKey) {
    return true;
  }
  if (e.key === "c" && term.hasSelection()) {
    window.manager.copyText(term.getSelection());
    term.clearSelection();
    return false;
  }
  // The browser pastes; xterm picks the text up from the paste event.
  return e.key !== "v";
}
// Output that arrived before the scrollback did: only what the scrollback does not hold yet is written.
function writeAfter(view, data, end) {
  const start = end - data.length;
  if (end > view.attachedEnd) {
    view.term.write(data.slice(Math.max(0, view.attachedEnd - start)));
  }
}
async function attachView(id, view) {
  const a = await window.terminals.attach(id);
  if (!a) {
    return;
  }
  view.term.write(a.scrollback);
  view.attachedEnd = a.end;
  view.queue.forEach(chunk => writeAfter(view, chunk.data, chunk.end));
  view.queue = [];
  if (a.exitCode !== null) {
    writeExitNote(view, a.exitCode);
  }
}
function createTermView(id) {
  const el = document.createElement("div");
  el.className = "term-pane";
  $("termPanes").appendChild(el);
  const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 13, cursorBlink: true, scrollback: 10000, theme: getTermTheme() });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.attachCustomKeyEventHandler(e => handleTermKey(term, e));
  term.onData(data => window.terminals.input(id, data));
  const view = { el, term, fit, attachedEnd: null, queue: [] };
  termViews.set(id, view);
  attachView(id, view).catch(e => toast(e.message, true));
  return view;
}
function disposeTermView(id) {
  const view = termViews.get(id);
  view.term.dispose();
  view.el.remove();
  termViews.delete(id);
}
function writeExitNote(view, code) {
  view.term.write(`\r\n\x1b[2m${t("term.tab.ended", { code })}\x1b[0m\r\n`);
}
function fitActiveTab() {
  const view = termViews.get(activeTab);
  if (!view) {
    return;
  }
  try {
    view.fit.fit();
    window.terminals.resize(activeTab, view.term.cols, view.term.rows);
  } catch {
  }
}

// ---------- tabs ----------
function getTabStatus(tab) {
  const l = tab.sessionId && typeof live !== "undefined" ? live.get(`${tab.agent}:${tab.sessionId}`) : null;
  if (!l) {
    return "";
  }
  return getLiveGroup(l);
}
function isTabLoading(tab) {
  const key = `${tab.agent}:${tab.sessionId}`;
  return !tab.exited && Boolean(tab.sessionId) && isLoading(key, typeof live !== "undefined" ? live.get(key) : null);
}
function getTabTitle(tab) {
  const s = tab.sessionId && typeof data !== "undefined" ? data.sessions.find(x => x.agent === tab.agent && x.id === tab.sessionId) : null;
  return s?.title || tab.title;
}
function renderTermTabs() {
  const strip = $("termTabs");
  strip.hidden = !termTabs.length;
  $("sessionsPanel").classList.toggle("showing-term", Boolean(activeTab));
  if (!termTabs.length) {
    return;
  }
  const sessionsTab = `<button class="term-tab ${activeTab ? "" : "active"}" data-term-tab="" role="tab">${icon("layers")}${esc(t("manager.sessions"))}</button>`;
  const html = sessionsTab + termTabs.map(tab => {
    const status = getTabStatus(tab);
    return `<div class="term-tab ${tab.id === activeTab ? "active" : ""} ${tab.exited ? "exited" : ""}" data-term-tab="${esc(tab.id)}" role="tab" title="${esc(tab.cwd)}">
      <span class="term-dot ${isTabLoading(tab) ? "loading" : status}"></span><span class="term-title">${esc(getTabTitle(tab))}</span>${tab.note ? `<span class="term-note">${esc(tab.note)}</span>` : ""}
      <button class="term-close" data-term-close="${esc(tab.id)}" title="${esc(t("term.tab.close"))}">${icon("x")}</button></div>`;
  }).join("");
  // Rebuilt only when something shows differently, so a click in progress is not lost.
  if (html !== tabsHtml) {
    tabsHtml = html;
    strip.innerHTML = html;
  }
}
function activateTab(id, focus = true) {
  activeTab = termViews.has(id) ? id : "";
  termViews.forEach((view, viewId) => view.el.classList.toggle("active", viewId === activeTab));
  $("termPanes").hidden = !activeTab;
  renderTermTabs();
  if (activeTab) {
    fitActiveTab();
    if (focus) termViews.get(activeTab).term.focus();
  }
}
function syncTermTabs(list) {
  termTabs = list;
  const ids = new Set(list.map(tab => tab.id));
  list.forEach(tab => termViews.has(tab.id) || createTermView(tab.id));
  [...termViews.keys()].filter(id => !ids.has(id)).forEach(disposeTermView);
  if (activeTab && !ids.has(activeTab)) {
    activeTab = "";
  }
  activateTab(activeTab);
}
async function closeTermTab(id) {
  const tab = termTabs.find(x => x.id === id);
  if (tab && !tab.exited && !confirm(t("term.tab.closeConfirm"))) {
    return;
  }
  await window.terminals.close(id);
}

// ---------- sessions <-> tabs (main links a new session's tab: tab-links.js) ----------
function findSessionTab(s) {
  return termTabs.find(tab => tab.agent === s.agent && tab.sessionId === s.id && !tab.exited) || null;
}
// A selected project's (or group's) open tab comes up: the session that needs the user first, else the latest one.
// Without one, the sessions list does. The keyboard stays in the project list.
function showProjectTab(sel) {
  const tab = getProjectTab(sel);
  if (tab || activeTab) {
    activateTab(tab?.id || "", false);
  }
}
function getProjectTab(sel) {
  const open = sel.sessions.map(s => ({ s, tab: findSessionTab(s), l: liveOf(s) })).filter(x => x.tab);
  const rank = x => (x.l ? getLiveRank(x.l) : Infinity);
  open.sort((a, b) => rank(a) - rank(b) || (b.s.updatedAt || 0) - (a.s.updatedAt || 0));
  return open[0]?.tab || null;
}
// Brings up the session's tab when it has one; false otherwise.
function showSessionTab(s) {
  const tab = s && findSessionTab(s);
  if (!tab) {
    return false;
  }
  activateTab(tab.id);
  return true;
}
function isMoveHereOffered(s) {
  return s.agent === "Claude" && !findSessionTab(s);
}
async function moveSessionHere(s) {
  toast(t("term.moving"));
  try {
    await window.terminals.move(s.agent, s.id);
  } catch (e) {
    toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true);
  }
}

// ---------- wiring ----------
window.terminals.onData(({ id, data, end }) => {
  const view = termViews.get(id);
  if (!view) {
    return;
  }
  if (view.attachedEnd === null) {
    view.queue.push({ data, end });
  } else {
    writeAfter(view, data, end);
  }
});
window.terminals.onExit(({ id, code }) => {
  const view = termViews.get(id);
  if (view) {
    writeExitNote(view, code);
  }
});
window.terminals.onChanged(syncTermTabs);
window.terminals.onActivate(id => activateTab(id));
window.prefs.onChanged(() => {
  requestAnimationFrame(applyTermTheme);
});
$("termTabs").addEventListener("click", e => {
  const close = e.target.closest("[data-term-close]");
  if (close) {
    e.stopPropagation();
    closeTermTab(close.dataset.termClose).catch(err => toast(err.message, true));
    return;
  }
  const tab = e.target.closest("[data-term-tab]");
  if (tab) {
    activateTab(tab.dataset.termTab);
  }
});
new ResizeObserver(fitActiveTab).observe($("termPanes"));
// The status dots and titles follow the live registry.
setInterval(renderTermTabs, TABS_REFRESH_MS);
window.terminals.getTabs().then(({ tabs, activate }) => {
  syncTermTabs(tabs);
  if (activate) {
    activateTab(activate);
  }
}).catch(() => {});
