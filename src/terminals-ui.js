// AgentDeck's own terminal tabs (terminals.js in main): a strip over the sessions panel - "Sessions" first, then a tab
// per terminal - and an xterm.js view per tab, coloured from theme.css. Classic script for the manager, loaded before
// renderer.js, which calls showSessionTab, canMoveHere and moveSessionHere; renderer's globals (live, liveOf, toast)
// are used only once the page runs.
const TERM_ANSI = {
  dark: {
    black: "#20252e", red: "#ff8a8a", green: "#5ee0a0", yellow: "#f2b55f", blue: "#7aa7ff", magenta: "#d7a6ff", cyan: "#6fd6e8", white: "#c9d1dc",
    brightBlack: "#6b7686", brightRed: "#ffb0b0", brightGreen: "#8ff0c0", brightYellow: "#ffd08a", brightBlue: "#a8c6ff", brightMagenta: "#e6c6ff",
    brightCyan: "#9be6f2", brightWhite: "#ffffff"
  },
  light: {
    black: "#18202c", red: "#c93434", green: "#12854f", yellow: "#a35a00", blue: "#2563d9", magenta: "#8a3fc7", cyan: "#0e7490", white: "#9aa4b2",
    brightBlack: "#5b6676", brightRed: "#e04848", brightGreen: "#16a362", brightYellow: "#c27000", brightBlue: "#3b7bf0", brightMagenta: "#a456e0",
    brightCyan: "#1590ad", brightWhite: "#6b7686"
  }
};
// A new session's tab is linked to the running session that started in its folder this long after it, at most.
const LINK_WINDOW_MS = 10000;
const LINK_POLL_MS = 3000;
const termViews = new Map(); // tab id -> { el, term, fit, attachedEnd, queue }
let termTabs = [];
let activeTab = ""; // "" = the sessions list
let sessionsIn = window.prefs.sessionsIn || "windows";

// ---------- looks ----------
function getCssVar(styles, name) {
  return styles.getPropertyValue(name).trim();
}
function getTermTheme() {
  const styles = getComputedStyle(document.documentElement);
  const mode = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return {
    background: getCssVar(styles, "--term-bg"),
    foreground: getCssVar(styles, "--term-fg"),
    cursor: getCssVar(styles, "--term-cursor"),
    selectionBackground: getCssVar(styles, "--term-selection"),
    ...TERM_ANSI[mode]
  };
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
  term.onResize(size => window.terminals.resize(id, size.cols, size.rows));
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
  return l.status === "busy" ? "busy" : "idle";
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
  strip.innerHTML = sessionsTab + termTabs.map(tab => {
    const status = getTabStatus(tab);
    return `<div class="term-tab ${tab.id === activeTab ? "active" : ""} ${tab.exited ? "exited" : ""}" data-term-tab="${esc(tab.id)}" role="tab" title="${esc(tab.cwd)}">
      <span class="term-dot ${status}"></span><span class="term-title">${esc(getTabTitle(tab))}</span>${tab.note ? `<span class="term-note">${esc(tab.note)}</span>` : ""}
      <button class="term-close" data-term-close="${esc(tab.id)}" title="${esc(t("term.tab.close"))}">${icon("x")}</button></div>`;
  }).join("");
}
function activateTab(id) {
  activeTab = termViews.has(id) ? id : "";
  termViews.forEach((view, viewId) => view.el.classList.toggle("active", viewId === activeTab));
  $("termPanes").hidden = !activeTab;
  renderTermTabs();
  if (activeTab) {
    fitActiveTab();
    termViews.get(activeTab).term.focus();
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
  linkNewTabs();
}
async function closeTermTab(id) {
  const tab = termTabs.find(x => x.id === id);
  if (tab && !tab.exited && !confirm(t("term.tab.closeConfirm"))) {
    return;
  }
  await window.terminals.close(id);
}

// ---------- sessions <-> tabs ----------
// A tab that started a new session learns its id from the live registry: the one that began in the tab's folder
// right after the tab, and is no other tab's yet.
function linkNewTabs() {
  if (typeof live === "undefined") {
    return;
  }
  const taken = new Set(termTabs.filter(tab => tab.sessionId).map(tab => `${tab.agent}:${tab.sessionId}`));
  for (const tab of termTabs.filter(x => !x.sessionId && !x.exited)) {
    const match = [...live.values()].find(l => !taken.has(`${l.agent}:${l.id}`) && normPath(l.cwd) === normPath(tab.cwd)
      && l.startedAt >= tab.createdAt - 2000 && l.startedAt <= tab.createdAt + LINK_WINDOW_MS);
    if (match) {
      taken.add(`${match.agent}:${match.id}`);
      window.terminals.link(tab.id, match.agent, match.id).catch(() => {});
    }
  }
}
function findSessionTab(s) {
  return termTabs.find(tab => tab.agent === s.agent && tab.sessionId === s.id && !tab.exited) || null;
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
function canMoveHere(s) {
  return sessionsIn === "tabs" && s.agent === "Claude" && !findSessionTab(s);
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
window.prefs.onChanged(p => {
  sessionsIn = p.sessionsIn || sessionsIn;
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
setInterval(() => {
  linkNewTabs();
  renderTermTabs();
}, LINK_POLL_MS);
window.terminals.list().then(({ tabs, activate }) => {
  syncTermTabs(tabs);
  if (activate) {
    activateTab(activate);
  }
}).catch(() => {});
