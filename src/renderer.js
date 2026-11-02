let raw = { registry: { projects: [] }, sessions: [] };
let data = { projects: [], sessions: [] };
let visible = [];
const ui = { query: "", agent: "", selected: "", active: -1, renaming: "", loading: false, loaded: false, liveOnly: false };

// Running sessions, keyed like `Claude:<id>`; refreshed every couple of seconds from the agents' own registries.
let live = new Map(), liveSig = "", pendingRender = false;
const liveOf = s => live.get(sessionKey(s));
function livePill(s) {
  if (isSessionLoading(s)) {
    return `<span class="live loading" title="${esc(t("live.hint.loading"))}"><span class="spinner"></span>${esc(t("live.label.loading"))}</span>`;
  }
  const l = liveOf(s);
  if (!l) return "";
  const kind = getLiveKind(l);
  const label = kind === "other" ? esc(l.status) : esc(t(`live.label.${kind}`));
  return `<span class="live ${kind} ${isStale(l) ? "stale" : ""}" data-live="${esc(sessionKey(s))}" title="${esc(getLiveHint(l))} · PID ${l.pid}">
    <span class="${kind === "busy" ? "spinner" : kind === "waiting" ? "pulse attn" : "pulse"}"></span>${label}<span class="live-t">${esc(liveText(l))}</span></span>`;
}

function prepare() {
  data = conceal(buildData(raw, live), readHidden());
  if (ui.selected && !data.projects.some(p => p.n === ui.selected)) ui.selected = "";
}

// Whole conversations too, from main's full-text index (as in the edge menu): a session whose text matches joins the
// hits even when its title does not. Words under three letters are not searched there.
const TEXT_SEARCH_DELAY_MS = 220;
const textSearch = { q: "", keys: new Set() };
let textSearchTimer = 0, textSearchTicket = 0;
function searchConversations(value) {
  clearTimeout(textSearchTimer);
  const v = value.trim();
  if (!v.split(/\s+/).some(w => [...w].length >= 3)) {
    textSearch.q = "";
    textSearch.keys = new Set();
    return;
  }
  const ticket = ++textSearchTicket;
  textSearchTimer = setTimeout(async () => {
    let hits = [];
    try { hits = await window.manager.searchText(v); } catch {}
    if (ticket !== textSearchTicket || ui.query.trim() !== v) return;
    textSearch.q = v;
    textSearch.keys = new Set(hits.map(h => h.key));
    render();
  }, TEXT_SEARCH_DELAY_MS);
}
function isTextHit(s) {
  return textSearch.q !== "" && textSearch.q === ui.query.trim() && textSearch.keys.has(sessionKey(s));
}

function compute() {
  const toks = tokenize(ui.query);
  const hits = toks.length ? data.sessions.filter(s => matches(s.hay, toks) || isTextHit(s)) : data.sessions;
  const hitSet = new Set(hits);
  const projects = data.projects
    .map(p => ({ p, count: toks.length ? p.sessions.filter(s => hitSet.has(s)).length : p.sessions.length }))
    .filter(x => !toks.length || x.count > 0 || matches(x.p.hay, toks) || x.p.n === ui.selected);
  const sel = data.projects.find(p => p.n === ui.selected);
  const scoped = sel ? hits.filter(s => inProject(s, sel)) : hits;
  const agentCounts = Object.fromEntries(AGENTS.map(a => [a, scoped.filter(s => s.agent === a).length]));
  const byAgent = ui.agent ? scoped.filter(s => s.agent === ui.agent) : scoped;
  const liveCounts = countLiveGroups(byAgent.map(liveOf).filter(Boolean));
  // Running sessions go first (blocked on the user, working, stalled, waiting for input); the rest keep their date order.
  const running = byAgent.filter(liveOf).sort((a, b) => getLiveRank(liveOf(a)) - getLiveRank(liveOf(b)) || lastSign(liveOf(b)) - lastSign(liveOf(a)));
  const sessions = ui.liveOnly ? running : [...running, ...byAgent.filter(s => !liveOf(s))];
  return { toks, hits, projects, sel, scoped, agentCounts, liveCounts, sessions };
}

// ---------- rendering ----------
function render({ resetScroll = false } = {}) {
  pendingRender = false;
  const v = compute();
  visible = v.sessions;
  if (ui.active >= visible.length) ui.active = -1;
  renderProjects(v);
  renderSessions(v);
  $("clearSearch").hidden = !ui.query;
  if (resetScroll) $("sessions").scrollTop = 0;
  const input = document.querySelector(".rename");
  if (input && document.activeElement !== input) { input.focus(); input.select(); }
}

function renderProjects(v) {
  const total = data.projects.length;
  $("projectCount").textContent = v.toks.length ? `${v.projects.length} / ${total}` : total;
  let html = `<div class="proj all ${ui.selected ? "" : "active"}" data-path="" tabindex="0">
    <div class="proj-row">${icon("layers")}<span class="proj-name">${esc(t("manager.allSessions"))}</span><span class="count">${v.hits.length}</span></div></div>`;
  html += v.projects.map(({ p, count }) => `
    <div class="proj ${ui.selected === p.n ? "active" : ""}" data-path="${esc(p.path)}" tabindex="0">
      <div class="proj-row">${icon("folder")}
        ${ui.renaming === p.n
          ? `<input class="rename" value="${esc(p.name)}" maxlength="80" aria-label="${esc(t("manager.project.newName"))}">`
          : `<span class="proj-name" title="${esc(p.name)}">${hl(p.name, v.toks)}</span>`}
        ${gitChip(p.path)}${projectLive(p)}
        <span class="count" title="${esc(t(v.toks.length ? "manager.project.countMatching" : "manager.project.countAll"))}">${count}</span>
      </div>
      ${pathHtml(p.path, v.toks)}
      <div class="proj-meta"><span>${esc(p.last ? ago(p.last) : t("manager.project.noSessions"))}</span>
        <span class="proj-tools">
          <button class="icon-btn" data-action="terminal" title="${esc(t("action.terminalHere"))}">${icon("terminal")}</button>
          <button class="icon-btn" data-action="explorer" title="${esc(t("action.explorerTitle"))}">${icon("open")}</button>
          <button class="icon-btn" data-action="copy" title="${esc(t("action.copyPath"))}">${icon("copy")}</button>
          <button class="icon-btn" data-action="rename" title="${esc(t("action.rename"))}">${icon("pencil")}</button>
          <button class="icon-btn danger" data-action="remove" title="${esc(t("action.remove"))}">${icon("trash")}</button>
        </span>
      </div>
    </div>`).join("");
  if (!total && ui.loaded) html += `<div class="empty small">${esc(t("manager.projects.empty"))}</div>`;
  else if (!v.projects.length && v.toks.length) html += `<div class="empty small">${esc(t("manager.projects.noMatch", { q: ui.query }))}</div>`;
  $("projects").innerHTML = html;
}

function projectLive(p) {
  const states = p.sessions.map(liveOf).filter(Boolean);
  if (!states.length) return "";
  const { busy, waiting, idle } = countLiveGroups(states);
  const title = [waiting && tn("live.count.waiting", waiting), busy && tn("live.count.busy", busy), idle && tn("live.count.idle", idle)].filter(Boolean).join(", ");
  return `<span class="proj-live" title="${esc(title)}">${waiting ? `<span class="pulse attn"></span>${waiting}` : ""}${busy ? `<span class="spinner"></span>${busy}` : ""}${idle ? `<span class="pulse"></span>${idle}` : ""}</span>`;
}

function renderLiveFilter(v) {
  const { busy, waiting, idle } = v.liveCounts;
  document.title = waiting ? `(${waiting}!) ${t("app.name")}` : busy ? `(${busy}) ${t("app.name")}` : t("app.name");
  const parts = [
    waiting && `<span class="pulse attn"></span>${esc(tn("live.count.waiting", waiting))}`,
    busy && `<span class="spinner"></span>${esc(tn("live.count.busy", busy))}`,
    idle && `<span class="pulse"></span>${esc(tn("live.count.idle", idle))}`
  ].filter(Boolean);
  $("liveFilter").innerHTML = parts.length || ui.liveOnly
    ? `<button class="live-filter ${ui.liveOnly ? "on" : ""}" data-action="live-only" title="${esc(t(ui.liveOnly ? "manager.live.showAll" : "manager.live.showOpen"))}">
        ${parts.length ? parts.join('<span class="sep"></span>') : esc(t("manager.live.noneActive"))}
      </button>`
    : `<span class="live-none">${esc(t("manager.live.none"))}</span>`;
}

function renderSessions(v) {
  $("sessionCount").textContent = v.sessions.length;
  renderLiveFilter(v);
  $("agentChips").innerHTML = [["", t("common.all"), v.scoped.length], ...AGENTS.map(a => [a, a, v.agentCounts[a]])]
    .map(([key, label, n]) => `<button class="chip ${ui.agent === key ? "on" : ""}" data-agent="${key}" ${n || ui.agent === key || !key ? "" : "disabled"}>
      ${key ? `<span class="dot ${key.toLowerCase()}"></span>` : ""}${esc(label)}<span class="n">${n}</span></button>`).join("");

  $("scope").innerHTML = v.sel ? `<div class="scope">${icon("folder")}
      <div class="grow"><div class="label">${esc(t("manager.scope.label", { name: v.sel.name }))}</div>${pathHtml(v.sel.path, v.toks)}</div>
      <button class="icon-btn" data-action="copy" data-path="${esc(v.sel.path)}" title="${esc(t("action.copyPath"))}">${icon("copy")}</button>
      <button class="btn sm" data-action="terminal" data-path="${esc(v.sel.path)}">${icon("terminal")}${esc(t("action.terminal"))}</button>
      <button class="btn sm" data-action="explorer" data-path="${esc(v.sel.path)}">${icon("open")}${esc(t("action.explorer"))}</button>
      <button class="btn sm" data-action="all" title="${esc(t("manager.scope.allTitle"))}">${icon("x")}${esc(t("common.all"))}</button>
    </div>` : "";

  if (!ui.loaded) { $("sessions").innerHTML = '<div class="skel"></div>'.repeat(5); return; }
  if (!visible.length) { $("sessions").innerHTML = emptySessions(v); return; }

  const groups = new Map();
  visible.forEach((s, i) => {
    const g = liveOf(s) ? t("manager.group.open") : dayGroup(s.updatedAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(sessionHtml(s, i, v.toks));
  });
  $("sessions").innerHTML = [...groups].map(([g, items]) =>
    `<div class="group">${esc(g)}<span class="n">${items.length}</span></div>${items.join("")}`).join("");
}

function sessionHtml(s, i, toks) {
  const dir = s.cwd
    ? `<div class="dir">${icon("folder")}${pathHtml(s.cwd, toks)}${gitChip(s.cwd)}<button class="icon-btn" data-action="copy" data-path="${esc(s.cwd)}" title="${esc(t("action.copyPath"))}">${icon("copy")}</button></div>`
    : `<div class="dir unknown">${icon("alert")}${esc(t("manager.session.noDir"))}</div>`;
  const l = liveOf(s);
  const liveCls = isSessionLoading(s) ? "live-loading" : l ? `live-${getLiveGroup(l) === "busy" && isStale(l) ? "stale" : getLiveGroup(l)}` : "";
  // A running session: its terminal is brought up, or moved into a tab. Resume and Continue fresh are in the preview
  // (preview-ui.js). The secondary actions' labels (.bl) give way to their icon and tooltip in a narrow panel.
  const runningBtns = l
    ? `<button class="btn sm primary" data-action="show-terminal" title="${esc(t("term.showTitle", { pid: l.pid }))}">${icon("raise")}${esc(t("term.show"))}</button>
      ${isMoveHereOffered(s) ? `<button class="btn sm" data-action="move-here" title="${esc(t("term.moveHereTitle"))}">${icon("download")}<span class="bl">${esc(t("term.moveHere"))}</span></button>` : ""}`
    : "";
  return `<article class="card sess ${liveCls} ${i === ui.active ? "active" : ""}" data-i="${i}">
    <div class="sess-head"><span class="agent ${s.agent.toLowerCase()}">${esc(s.agent)}</span>
      <h3 class="sess-title">${hl(s.title, toks)}</h3>
      ${livePill(s)}
      <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span></div>
    <div class="sid" title="${esc(t("manager.session.id"))}">${hl(s.id, toks)}</div>
    ${s.recap ? `<p class="sess-recap" title="${esc(s.recap)}"><span class="recap-label">${esc(t("manager.session.recap"))}</span>${hl(s.recap, toks)}</p>` : ""}
    ${dir}
    <div class="sess-foot">${getContextChip(s)}${usageChip(s)}<div class="grow"></div>
      ${runningBtns}
      ${s.cwd && !l ? `<button class="btn sm" data-action="terminal" data-path="${esc(s.cwd)}" title="${esc(t("action.terminalHere"))}" aria-label="${esc(t("action.terminal"))}">${icon("terminal")}<span class="bl">${esc(t("action.terminal"))}</span></button>` : ""}
      ${s.cwd ? `<button class="btn sm" data-action="explorer" data-path="${esc(s.cwd)}" title="${esc(t("action.explorerTitle"))}" aria-label="${esc(t("action.explorer"))}">${icon("open")}<span class="bl">${esc(t("action.explorer"))}</span></button>` : ""}
    </div></article>`;
}

function emptySessions(v) {
  const box = (title, body, actions = []) => `<div class="empty"><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.map(([action, label]) => `<button class="btn" data-action="${action}">${esc(t(label))}</button>`).join("")}</div>` : ""}</div>`;
  if (v.toks.length) return box(t(v.sel ? "manager.empty.searchInProject" : "manager.empty.search", { q: ui.query }), t("manager.empty.searchBody"),
    [["clear-search", "manager.empty.clearSearch"], ...(v.sel ? [["all", "manager.empty.searchAll"]] : [])]);
  if (ui.liveOnly) return box(t(v.sel ? "manager.empty.liveInProject" : "manager.empty.live"), t("manager.empty.liveBody"), [["live-only", "manager.live.showAll"]]);
  if (ui.agent) return box(t("manager.empty.agent", { agent: ui.agent }), "", [["all-agents", "manager.empty.allAgents"]]);
  if (v.sel) return box(t("manager.empty.project"), t("manager.empty.projectBody"));
  return box(t("manager.empty.none"), t("manager.empty.noneBody"));
}

// ---------- actions ----------
let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 2200);
}
const setStatus = s => { $("status").textContent = s; };

function showSummary() {
  const byAgent = AGENTS.map(a => [a, data.sessions.filter(s => s.agent === a).length]).filter(([, n]) => n).map(([a, n]) => `${I18N.formatNumber(n)} ${a}`);
  setStatus(t("manager.status.summary", {
    sessions: tn("manager.status.sessions", data.sessions.length), agents: byAgent.join(" · ") || t("common.none"),
    projects: tn("manager.status.projects", data.projects.length), time: I18N.formatTime(Date.now())
  }));
}

async function load() {
  if (ui.loading) return;
  ui.loading = true;
  // Refresh is hidden: main.js scans by itself (FULL_SCAN_MS); F5 still scans. To bring the button back, uncomment it in index.html, styles.css and renderer.js.
  // $("refresh").classList.add("spin"); $("refresh").disabled = true;
  setStatus(t("manager.status.scanning"));
  if (!ui.loaded) render();
  try {
    const [res, running] = await Promise.all([window.manager.getData(), window.manager.getLive().catch(() => [])]);
    raw = res;
    setLive(running);
    ui.loaded = true;
    prepare();
    render();
    showSummary();
  } catch (e) {
    setStatus(t("manager.status.scanFailed", { error: e.message }));
    toast(e.message, true);
  } finally {
    ui.loading = false;
    // $("refresh").classList.remove("spin"); $("refresh").disabled = false;
  }
}

window.addEventListener("storage", e => { if (e.key === HIDDEN_KEY && ui.loaded) { prepare(); render(); } });
function applyRegistry(registry) { raw.registry = registry; prepare(); render(); }

// Returns true when the set of running sessions or any of their states changed.
function setLive(list) {
  live = new Map(list.map(l => [sessionKey(l), l]));
  const sig = list.map(l => `${sessionKey(l)}:${l.status}`).sort().join("|");
  if (sig === liveSig) return false;
  liveSig = sig;
  return true;
}

async function pollLive() {
  if (!ui.loaded) return;
  let list;
  try { list = await window.manager.getLive(); } catch { return; }
  if (!setLive(list)) return updateLiveTexts();
  // A session started after the last scan shows as "new" until its transcript appears: main rescans then by itself.
  prepare();
  // Re-rendering would throw away a half-typed project name.
  if (ui.renaming) pendingRender = true; else render();
}

// Between state changes only the "activity N sec ago" texts move; update them in place.
function updateLiveTexts() {
  document.querySelectorAll("[data-live]").forEach(el => {
    const l = live.get(el.dataset.live);
    if (!l) return;
    el.querySelector(".live-t").textContent = liveText(l);
    el.classList.toggle("stale", isStale(l));
    el.closest(".sess")?.classList.toggle("live-stale", isStale(l));
    el.closest(".sess")?.classList.toggle("live-busy", l.status === "busy" && !isStale(l));
  });
}

function selectProject(path) {
  const n = normPath(path);
  ui.selected = ui.selected === n ? "" : n;
  ui.active = -1;
  render({ resetScroll: true });
}

function setActive(i) {
  if (!visible.length) return;
  ui.active = Math.max(0, Math.min(visible.length - 1, i));
  document.querySelectorAll(".sess.active").forEach(el => el.classList.remove("active"));
  const el = document.querySelector(`.sess[data-i="${ui.active}"]`);
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "nearest" }); }
}

async function resume(s) {
  if (showSessionTab(s)) return;
  if (!s?.cwd) return toast(t("errors.sessionNoDir"), true);
  const l = liveOf(s);
  if (l && !confirm(t("manager.confirm.openAgain", { pid: l.pid }))) return;
  await window.manager.launchAgent(s.agent, s.id, s.cwd);
  toast(t("manager.toast.resuming", { agent: s.agent, cwd: s.cwd }));
}
async function showTerminal(s) {
  if (!s || showSessionTab(s)) return;
  const r = await window.manager.focusTerminal(s.agent, s.id);
  const note = focusNote(r);
  if (note) toast(note, !r.ok);
}
// Double-click and Enter: a running session's terminal comes up, any other session is resumed.
const openSession = s => (s && liveOf(s) ? showTerminal(s) : resume(s));

async function commitRename(input) {
  const path = input.closest(".proj").dataset.path;
  const project = data.projects.find(p => p.n === ui.renaming);
  const name = input.value.trim();
  ui.renaming = "";
  if (!project || !name || name === project.name || pendingRender) render();
  if (!project || !name || name === project.name) return;
  applyRegistry(await window.manager.renameProject(path, name));
  toast(t("manager.toast.renamed", { name }));
}

async function runAction(action, btn) {
  const path = btn.dataset.path || btn.closest("[data-path]")?.dataset.path;
  switch (action) {
    case "resume": return resume(visible[Number(btn.closest(".sess").dataset.i)]);
    case "show-terminal": return showTerminal(visible[Number(btn.closest(".sess").dataset.i)]);
    case "move-here": return moveSessionHere(visible[Number(btn.closest(".sess").dataset.i)]);
    case "terminal": await window.manager.launchFolder(path); return toast(t("manager.toast.terminal", { path }));
    case "explorer": { const err = await window.manager.openPath(path); if (err) throw new Error(err); return; }
    case "copy": await window.manager.copyText(path); return toast(t("toast.copied", { path }));
    case "rename": ui.renaming = normPath(path); return render();
    case "remove":
      if (!confirm(t("manager.confirm.remove", { path }))) return;
      return applyRegistry(await window.manager.removeProject(path));
    case "all": ui.selected = ""; return render({ resetScroll: true });
    case "all-agents": ui.agent = ""; return render({ resetScroll: true });
    case "live-only": ui.liveOnly = !ui.liveOnly; ui.active = -1; return render({ resetScroll: true });
    case "clear-search": return setQuery("");
  }
}
async function onAction(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return false;
  e.stopPropagation();
  try { await runAction(btn.dataset.action, btn); } catch (err) { toast(err.message, true); }
  return true;
}

function setQuery(q) {
  ui.query = q; ui.active = -1;
  if ($("search").value !== q) $("search").value = q;
  searchConversations(q);
  render({ resetScroll: true });
}

// ---------- events ----------
$("search").addEventListener("input", e => setQuery(e.target.value));
$("clearSearch").addEventListener("click", () => { setQuery(""); $("search").focus(); });
// $("refresh").addEventListener("click", load);
for (const [id, open] of [["voiceHistory", window.manager.openVoiceHistory], ["settings", window.manager.openSettings]]) {
  $(id).addEventListener("click", async () => { if (!(await open())) toast(t("manager.unavailable"), true); });
}
$("add").addEventListener("click", async () => {
  try { applyRegistry(await window.manager.addProject()); } catch (e) { toast(e.message, true); }
});
$("agentChips").addEventListener("click", e => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.disabled) return;
  ui.agent = chip.dataset.agent; ui.active = -1;
  render({ resetScroll: true });
});
$("scope").addEventListener("click", onAction);
$("liveFilter").addEventListener("click", onAction);
$("projects").addEventListener("click", async e => {
  if (e.target.classList.contains("rename") || await onAction(e)) return;
  const card = e.target.closest(".proj");
  if (card) selectProject(card.dataset.path);
});
$("projects").addEventListener("keydown", e => {
  if (e.target.classList.contains("rename")) {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ui.renaming = ""; render(); }
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("proj")) { e.preventDefault(); selectProject(e.target.dataset.path); }
});
$("projects").addEventListener("focusout", e => {
  if (e.target.classList.contains("rename") && ui.renaming) commitRename(e.target).catch(err => toast(err.message, true));
});
$("sessions").addEventListener("click", async e => {
  if (await onAction(e)) return;
  const card = e.target.closest(".sess");
  if (card) setActive(Number(card.dataset.i));
});
$("sessions").addEventListener("dblclick", e => {
  const card = e.target.closest(".sess");
  if (card && !e.target.closest("button")) openSession(visible[Number(card.dataset.i)]).catch(err => toast(err.message, true));
});

document.addEventListener("keydown", e => {
  // Keys typed into a terminal tab belong to what runs there (Ctrl+K included).
  if (e.target.closest?.(".term-panes")) return;
  const inSearch = e.target === $("search");
  const typing = !inSearch && e.target.matches?.("input, textarea");
  if ((e.ctrlKey && (e.key === "k" || e.key === "f")) || (e.key === "/" && !typing && !inSearch)) {
    e.preventDefault(); $("search").focus(); $("search").select(); return;
  }
  if (e.key === "F5") { e.preventDefault(); load(); return; }
  if (typing) return;
  if (e.key === "Escape") {
    if (ui.query) setQuery("");
    else if (ui.selected) { ui.selected = ""; ui.active = -1; render({ resetScroll: true }); }
    else if (ui.active >= 0) { ui.active = -1; render(); }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!inSearch && e.target.closest?.("button, .proj")) return;
    e.preventDefault();
    setActive(ui.active < 0 ? 0 : ui.active + (e.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (e.key === "Enter" && ui.active >= 0 && (inSearch || e.target === document.body)) {
    e.preventDefault();
    openSession(visible[ui.active]).catch(err => toast(err.message, true));
  }
});

// A scan started elsewhere (e.g. by the edge menu) updates this window as well.
// Main rescans by itself when transcripts change: the list, the status line and an open search follow.
window.manager.onDataChanged(d => {
  if (!ui.loaded || ui.loading) return;
  raw = d;
  prepare();
  showSummary();
  if (ui.query) searchConversations(ui.query);
  if (ui.renaming) pendingRender = true; else render();
});
// Git branches beside projects and session folders, and a session's last messages on hover (git-ui.js, preview-ui.js).
watchGit(() => { if (!ui.loaded) return; if (ui.renaming) pendingRender = true; else render(); });
previewHoverCard($("sessions"), card => visible[Number(card.dataset.i)]);

// ---------- projects | sessions divider: dragged, moved with the arrow keys, reset by a double-click ----------
const PROJECTS_WIDTH_KEY = "agentdeck.projectsWidth";
const MIN_PROJECTS_PX = 220, MIN_SESSIONS_PX = 420, SPLITTER_STEP_PX = 16;
function getProjectsWidth(left) {
  const main = document.querySelector("main").getBoundingClientRect();
  const projects = left - document.querySelector("main > .panel").getBoundingClientRect().left;
  return Math.round(Math.max(MIN_PROJECTS_PX, Math.min(projects, main.width - MIN_SESSIONS_PX)));
}
function setProjectsWidth(px) {
  document.querySelector("main").style.setProperty("--projects-w", `${px}px`);
  try {
    localStorage.setItem(PROJECTS_WIDTH_KEY, String(px));
  } catch {}
}
function resetProjectsWidth() {
  document.querySelector("main").style.removeProperty("--projects-w");
  try {
    localStorage.removeItem(PROJECTS_WIDTH_KEY);
  } catch {}
}
function restoreProjectsWidth() {
  let px = 0;
  try {
    px = Number(localStorage.getItem(PROJECTS_WIDTH_KEY));
  } catch {}
  if (px > 0) {
    document.querySelector("main").style.setProperty("--projects-w", `${px}px`);
  }
}
$("splitter").addEventListener("pointerdown", e => {
  const el = e.currentTarget;
  const move = ev => setProjectsWidth(getProjectsWidth(ev.clientX));
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", () => el.removeEventListener("pointermove", move), { once: true });
});
$("splitter").addEventListener("dblclick", resetProjectsWidth);
$("splitter").addEventListener("keydown", e => {
  const step = { ArrowLeft: -SPLITTER_STEP_PX, ArrowRight: SPLITTER_STEP_PX }[e.key];
  if (step) {
    e.preventDefault();
    setProjectsWidth(getProjectsWidth(e.currentTarget.getBoundingClientRect().left + step));
  }
});
restoreProjectsWidth();

load();
setInterval(pollLive, 2000);
