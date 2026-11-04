let raw = { registry: { projects: [] }, sessions: [] };
let data = { projects: [], sessions: [], groups: [] };
let visible = [];
// Every project's path in the order shown, hidden ones too: a drag or a pin is placed within it.
let order = [];
// Each project's group id ("" for none), by normalized path, hidden ones too.
let groupOfPath = new Map();
const getGroupOf = path => groupOfPath.get(normPath(path)) || "";
const ui = { query: "", agent: "", selected: "", active: -1, renaming: "", loading: false, loaded: false, liveOnly: false };

// Running sessions, keyed like `Claude:<id>`; refreshed every couple of seconds from the agents' own registries.
let live = new Map(), liveSig = "", pendingRender = false;
const liveOf = s => live.get(sessionKey(s));
function livePill(l, loading) {
  if (loading) {
    return getLoadingPill();
  }
  if (!l) return "";
  const kind = getLiveKind(l);
  const label = kind === "other" ? esc(l.status) : esc(t(`live.label.${kind}`));
  return `<span class="live ${kind} ${isStale(l) ? "stale" : ""}" data-live="${esc(sessionKey(l))}" title="${esc(getLiveHint(l))} · PID ${l.pid}">
    <span class="${kind === "busy" ? "spinner" : kind === "waiting" ? "pulse attn" : "pulse"}"></span>${label}<span class="live-t">${esc(liveText(l))}</span></span>`;
}

function prepare() {
  const built = buildData(raw, live);
  order = built.projects.map(p => p.path);
  groupOfPath = new Map(built.projects.map(p => [p.n, p.group || ""]));
  data = conceal(built, readHidden());
  if (ui.selected && !findSelected()) ui.selected = "";
}
// The selected project, or the selected group as {group, members, sessions}.
function findSelected() {
  if (!ui.selected.startsWith("g:")) return data.projects.find(p => p.n === ui.selected);
  return getUnits(data.projects, data.groups).find(u => u.group?.n === ui.selected);
}
const isInSelected = (s, sel) => (sel.group ? sel.members.some(p => inProject(s, p)) : inProject(s, sel));

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
  // A group found by its name shows all of its projects.
  const groupHits = new Set(toks.length ? data.groups.filter(g => matches(searchable(g.name), toks)).map(g => g.id) : []);
  const projects = data.projects
    .map(p => ({ p, count: toks.length ? p.sessions.filter(s => hitSet.has(s)).length : p.sessions.length }))
    .filter(x => !toks.length || x.count > 0 || matches(x.p.hay, toks) || x.p.n === ui.selected || groupHits.has(x.p.group));
  const sel = findSelected();
  const scoped = sel ? hits.filter(s => isInSelected(s, sel)) : hits;
  const agentCounts = Object.fromEntries(AGENTS.map(a => [a, scoped.filter(s => s.agent === a).length]));
  const byAgent = ui.agent ? scoped.filter(s => s.agent === ui.agent) : scoped;
  const liveCounts = countLiveGroups(byAgent.map(liveOf).filter(Boolean));
  // Running sessions go first (blocked on the user, working, stalled, waiting for input); the rest keep their date order.
  const running = byAgent.filter(liveOf).sort((a, b) => getLiveRank(liveOf(a)) - getLiveRank(liveOf(b)) || lastSign(liveOf(b)) - lastSign(liveOf(a)));
  const sessions = ui.liveOnly ? running : [...running, ...byAgent.filter(s => !liveOf(s))];
  return { toks, hits, hitSet, projects, sel, scoped, agentCounts, liveCounts, sessions };
}

// ---------- rendering ----------
function render({ resetScroll = false } = {}) {
  pendingRender = false;
  removeEndedLaunches(key => live.get(key));
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
  renderOrderToggle();
  let html = `<div class="proj all ${ui.selected ? "" : "active"}" data-path="" tabindex="0">
    <div class="proj-row">${icon("layers")}<span class="proj-name">${esc(t("manager.allSessions"))}</span><span class="count">${v.hits.length}</span></div></div>`;
  const counts = new Map(v.projects.map(x => [x.p, x.count]));
  html += getUnits(v.projects.map(x => x.p), data.groups).map(u => {
    if (!u.group) return buildProjectHtml(u.project, counts.get(u.project), v);
    const shut = isCollapsed(u.group.id) && !v.toks.length;
    return buildGroupHtml(u, v, shut) + (shut ? "" : u.members.map(p => buildProjectHtml(p, counts.get(p), v)).join(""));
  }).join("");
  if (!total && ui.loaded) html += `<div class="empty small">${esc(t("manager.projects.empty"))}</div>`;
  else if (!v.projects.length && v.toks.length) html += `<div class="empty small">${esc(t("manager.projects.noMatch", { q: ui.query }))}</div>`;
  $("projects").innerHTML = html;
}
const getDraggableAttr = (v, n) => (v.toks.length || ui.renaming === n ? "" : 'draggable="true"');
const buildPinMark = () => `<span class="pin-mark" title="${esc(t("manager.project.pinned"))}">${icon("pin")}</span>`;
const buildPinButton = x => `<button class="icon-btn ${isPinned(x) ? "on" : ""}" data-action="pin" title="${esc(t(isPinned(x) ? "action.unpin" : "action.pin"))}">${icon("pin")}</button>`;
const buildNameHtml = (x, v, label) => (ui.renaming === x.n
  ? `<input class="rename" value="${esc(x.name)}" maxlength="80" aria-label="${esc(t(label))}">`
  : `<span class="proj-name" title="${esc(x.name)}">${hl(x.name, v.toks)}</span>`);

function buildProjectHtml(p, count, v) {
  const member = Boolean(p.group);
  return `
    <div class="proj ${member ? "member" : ""} ${ui.selected === p.n ? "active" : ""}" data-path="${esc(p.path)}" tabindex="0" ${getDraggableAttr(v, p.n)}>
      <div class="proj-row">${icon("folder")}
        ${buildNameHtml(p, v, "manager.project.newName")}
        ${isPinned(p) ? buildPinMark() : ""}
        ${gitChip(p.path)}${projectLive(p.sessions)}
        <span class="count" title="${esc(t(v.toks.length ? "manager.project.countMatching" : "manager.project.countAll"))}">${count}</span>
      </div>
      ${pathHtml(p.path, v.toks)}
      <div class="proj-meta"><span>${esc(p.last ? ago(p.last) : t("manager.project.noSessions"))}</span>
        <span class="proj-tools">
          <button class="icon-btn" data-action="terminal" title="${esc(t("action.terminalHere"))}">${icon("terminal")}</button>
          <button class="icon-btn" data-action="explorer" title="${esc(t("action.explorerTitle"))}">${icon("open")}</button>
          <button class="icon-btn" data-action="copy" title="${esc(t("action.copyPath"))}">${icon("copy")}</button>
          ${member ? "" : buildPinButton(p)}
          <button class="icon-btn ${member ? "on" : ""}" data-action="${member ? "leave-group" : "group"}" title="${esc(t(member ? "manager.projectGroup.leave" : "manager.projectGroup.create"))}">${icon("stack")}</button>
          <button class="icon-btn" data-action="rename" title="${esc(t("action.rename"))}">${icon("pencil")}</button>
          <button class="icon-btn danger" data-action="remove" title="${esc(t("action.remove"))}">${icon("trash")}</button>
        </span>
      </div>
    </div>`;
}

function buildGroupHtml(u, v, shut) {
  const g = u.group;
  const count = v.toks.length ? u.sessions.filter(s => v.hitSet.has(s)).length : u.sessions.length;
  return `
    <div class="proj grp ${ui.selected === g.n ? "active" : ""}" data-group="${esc(g.id)}" tabindex="0" ${getDraggableAttr(v, g.n)}>
      <div class="proj-row">
        <button class="icon-btn fold" data-action="fold" title="${esc(t(shut ? "manager.projectGroup.expand" : "manager.projectGroup.collapse"))}">${icon(shut ? "right" : "down")}</button>
        ${icon("stack")}${buildNameHtml(g, v, "manager.projectGroup.newName")}
        ${isPinned(g) ? buildPinMark() : ""}
        ${projectLive(u.sessions)}
        <span class="count" title="${esc(t(v.toks.length ? "manager.project.countMatching" : "manager.project.countAll"))}">${count}</span>
      </div>
      <div class="proj-meta"><span>${esc(tn("manager.projectGroup.projects", u.members.length))} · ${esc(g.last ? ago(g.last) : t("manager.project.noSessions"))}</span>
        <span class="proj-tools">
          ${buildPinButton(g)}
          <button class="icon-btn" data-action="rename" title="${esc(t("action.rename"))}">${icon("pencil")}</button>
          <button class="icon-btn danger" data-action="ungroup" title="${esc(t("manager.projectGroup.delete"))}">${icon("x")}</button>
        </span>
      </div>
    </div>`;
}

// Folded groups: this window's own convenience.
const COLLAPSED_KEY = "agentdeck.collapsedGroups";
function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []);
  } catch {
    return new Set();
  }
}
let collapsed = readCollapsed();
const isCollapsed = id => collapsed.has(id);
function toggleCollapsed(id) {
  if (!collapsed.delete(id)) collapsed.add(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {}
  render();
}

function renderOrderToggle() {
  const custom = raw.registry.order === "custom";
  const el = $("projectOrder");
  el.textContent = t(custom ? "manager.order.custom" : "manager.order.activity");
  el.title = t(custom ? "manager.order.customTitle" : "manager.order.activityTitle");
  el.hidden = !data.projects.length;
}

function projectLive(sessions) {
  const states = sessions.map(liveOf).filter(Boolean);
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

  $("scope").innerHTML = v.sel?.group ? `<div class="scope">${icon("stack")}
      <div class="grow"><div class="label">${esc(t("manager.scope.group", { name: v.sel.group.name }))}</div>
        <div class="path">${esc(v.sel.members.map(p => p.name).join(", "))}</div></div>
      <button class="btn sm" data-action="all" title="${esc(t("manager.scope.allTitle"))}">${icon("x")}${esc(t("common.all"))}</button>
    </div>` : v.sel ? `<div class="scope">${icon("folder")}
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
  const loading = isLoading(sessionKey(s), l);
  const liveCls = loading ? "live-loading" : l ? `live-${getLiveGroup(l) === "busy" && isStale(l) ? "stale" : getLiveGroup(l)}` : "";
  // A running session: its terminal is brought up, or moved into a tab; a past one is resumed or continued fresh
  // (preview-ui.js). The secondary actions' labels (.bl) give way to their icon and tooltip in a narrow panel.
  const runningBtns = l
    ? `<button class="btn sm primary" data-action="show-terminal" title="${esc(t("term.showTitle", { pid: l.pid }))}">${icon("raise")}${esc(t("term.show"))}</button>
      ${isMoveHereOffered(s) ? `<button class="btn sm" data-action="move-here" title="${esc(t("term.moveHereTitle"))}">${icon("download")}<span class="bl">${esc(t("term.moveHere"))}</span></button>` : ""}`
    : "";
  return `<article class="card sess ${liveCls} ${i === ui.active ? "active" : ""}" data-i="${i}">
    <div class="sess-head"><span class="agent ${s.agent.toLowerCase()}">${esc(s.agent)}</span>
      <h3 class="sess-title">${hl(s.title, toks)}</h3>
      ${livePill(l, loading)}
      <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span></div>
    <div class="sid" title="${esc(t("manager.session.id"))}">${hl(s.id, toks)}</div>
    ${s.recap ? `<p class="sess-recap" title="${esc(s.recap)}"><span class="recap-label">${esc(t("manager.session.recap"))}</span>${hl(s.recap, toks)}</p>` : ""}
    ${dir}
    <div class="sess-foot">${getContextChip(s)}${usageChip(s)}<div class="grow"></div>
      ${runningBtns}
      ${l ? "" : getSessionActions(s)}
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

// key: a project's normalized path, or "g:<id>" for a group.
function selectProject(key) {
  ui.selected = ui.selected === key ? "" : key;
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

const getCardKey = card => (card.dataset.group ? "g:" + card.dataset.group : normPath(card.dataset.path));
async function commitRename(input) {
  const card = input.closest(".proj");
  const item = card.dataset.group ? data.groups.find(g => g.id === card.dataset.group) : data.projects.find(p => p.n === ui.renaming);
  const name = input.value.trim();
  ui.renaming = "";
  if (!item || !name || name === item.name || pendingRender) render();
  if (!item || !name || name === item.name) return;
  applyRegistry(await (card.dataset.group ? window.manager.renameGroup(item.id, name) : window.manager.renameProject(card.dataset.path, name)));
  toast(t("manager.toast.renamed", { name }));
}

async function pinProject(path, groupId) {
  if (groupId) {
    const g = data.groups.find(x => x.id === groupId);
    if (g) applyRegistry(await window.manager.pinGroup(g.id, isPinned(g) ? null : g.slot));
    return;
  }
  const p = data.projects.find(x => x.n === normPath(path));
  if (p) applyRegistry(await window.manager.pinProject(path, isPinned(p) ? null : p.slot));
}
async function createGroup(path) {
  applyRegistry(await window.manager.createGroup(path));
  const id = getGroupOf(path);
  if (!id) return;
  collapsed.delete(id);
  ui.renaming = "g:" + id;
  render();
}
// The shown order with `src` ({path} or {group}) moved before, after or into the item of `card`, and the group the
// moved project ends up in.
function getDropPlan(src, card, where) {
  const moving = src.group ? order.filter(x => getGroupOf(x) === src.group) : [src.path];
  const isMoving = new Set(moving);
  const rest = order.filter(x => !isMoving.has(x));
  const joins = getJoinedGroup(card, where);
  const anchor = getAnchor(rest, card, where, card.dataset.group || (src.group ? joins : ""));
  if (!anchor) return null;
  rest.splice(rest.indexOf(anchor) + (where === "before" ? 0 : 1), 0, ...moving);
  return { list: rest, groupOf: src.group ? null : { [src.path]: joins } };
}
// Into a group, beside one of its projects, or (beside anything else) none.
function getJoinedGroup(card, where) {
  if (where === "into") return card.dataset.group;
  return card.dataset.group ? "" : getGroupOf(card.dataset.path);
}
// The path the moved item goes beside: the card's project, or the first or last project of the group it stands for.
function getAnchor(rest, card, where, groupId) {
  if (!groupId) return card.dataset.path;
  const block = rest.filter(x => getGroupOf(x) === groupId);
  return where === "before" ? block[0] : block.at(-1);
}
async function applyDrop(plan) {
  if (plan) applyRegistry(await window.manager.arrangeProjects(plan.list, plan.groupOf));
}
// Out of its group, right after the group's other projects; the last one out takes the group with it.
async function leaveGroup(path) {
  const id = getGroupOf(path);
  const last = order.findLast(x => getGroupOf(x) === id && x !== path);
  if (!last) return applyRegistry(await window.manager.deleteGroup(id));
  const list = order.filter(x => x !== path);
  list.splice(list.indexOf(last) + 1, 0, path);
  applyRegistry(await window.manager.arrangeProjects(list, { [path]: "" }));
  document.querySelector(`.proj.grp[data-group="${CSS.escape(id)}"]`)?.focus();
}
async function toggleOrder() {
  applyRegistry(raw.registry.order === "custom" ? await window.manager.sortProjectsByActivity() : await window.manager.arrangeProjects(order));
}

async function runAction(action, btn) {
  const path = btn.dataset.path || btn.closest("[data-path]")?.dataset.path;
  const groupId = btn.closest("[data-group]")?.dataset.group;
  switch (action) {
    case "resume": return resume(visible[Number(btn.closest(".sess").dataset.i)]);
    case "fresh": await continueFresh(visible[Number(btn.closest(".sess").dataset.i)]); return toast(t("preview.fresh.started"));
    case "show-terminal": return showTerminal(visible[Number(btn.closest(".sess").dataset.i)]);
    case "move-here": return moveSessionHere(visible[Number(btn.closest(".sess").dataset.i)]);
    case "terminal": await window.manager.launchFolder(path); return toast(t("manager.toast.terminal", { path }));
    case "explorer": { const err = await window.manager.openPath(path); if (err) throw new Error(err); return; }
    case "copy": await window.manager.copyText(path); return toast(t("toast.copied", { path }));
    case "rename": ui.renaming = groupId ? "g:" + groupId : normPath(path); return render();
    case "pin": return pinProject(path, groupId);
    case "group": return createGroup(path);
    case "leave-group": return leaveGroup(path);
    case "ungroup": return applyRegistry(await window.manager.deleteGroup(groupId));
    case "fold": return toggleCollapsed(groupId);
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
  if (card) selectProject(getCardKey(card));
});
$("projects").addEventListener("keydown", e => {
  if (e.target.classList.contains("rename")) {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ui.renaming = ""; render(); }
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("proj")) { e.preventDefault(); selectProject(getCardKey(e.target)); }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target.matches(".proj[draggable]")) {
    e.preventDefault();
    moveByKey(e.target, e.key === "ArrowDown").catch(err => toast(err.message, true));
  }
});
// The card to move past: below an open group come its own projects, which it moves with.
function getNextCard(card, down) {
  let next = down ? card.nextElementSibling : card.previousElementSibling;
  while (down && card.dataset.group && next?.dataset.path && getGroupOf(next.dataset.path) === card.dataset.group) next = next.nextElementSibling;
  return next;
}
async function moveByKey(card, down) {
  const next = getNextCard(card, down);
  if (!next?.matches(".proj[draggable]")) return;
  const key = getCardKey(card);
  await applyDrop(getDropPlan(getSource(card), next, down ? "after" : "before"));
  [...document.querySelectorAll(".proj[draggable]")].find(el => getCardKey(el) === key)?.focus();
}
$("projectOrder").addEventListener("click", () => toggleOrder().catch(err => toast(err.message, true)));

// ---------- projects: drag and drop ----------
// A project goes before or after another, into a group (the lower half of its row) or out of it; a group moves whole.
let drag = null;
const getSource = card => (card.dataset.group ? { group: card.dataset.group } : { path: card.dataset.path });
function getDropCard(e) {
  const card = e.target.closest(".proj[draggable]");
  if (!card || !drag) return null;
  if (drag.group) return card.dataset.group === drag.group || getGroupOf(card.dataset.path) === drag.group ? null : card;
  return card.dataset.path === drag.path ? null : card;
}
function getDropWhere(card, e) {
  const r = card.getBoundingClientRect();
  const lower = e.clientY > r.top + r.height / 2;
  if (card.dataset.group && drag.path) return lower ? "into" : "before";
  return lower ? "after" : "before";
}
const DROP_MARKS = ["drop-before", "drop-after", "drop-into"];
function clearDropMarks(keepDragging = false) {
  document.querySelectorAll(".proj.drop-before, .proj.drop-after, .proj.drop-into, .proj.dragging").forEach(el => {
    el.classList.remove(...DROP_MARKS);
    if (!keepDragging) el.classList.remove("dragging");
  });
}
$("projects").addEventListener("dragstart", e => {
  const card = e.target.closest?.(".proj[draggable]");
  if (!card) return;
  drag = getSource(card);
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", card.dataset.path || card.dataset.group);
  card.classList.add("dragging");
});
$("projects").addEventListener("dragover", e => {
  const card = getDropCard(e);
  if (!card) return;
  e.preventDefault();
  const cls = "drop-" + getDropWhere(card, e);
  if (card.classList.contains(cls)) return;
  clearDropMarks(true);
  card.classList.add(cls);
});
$("projects").addEventListener("drop", e => {
  const card = getDropCard(e);
  if (!card) return;
  e.preventDefault();
  const plan = getDropPlan(drag, card, getDropWhere(card, e));
  drag = null;
  clearDropMarks();
  applyDrop(plan).catch(err => toast(err.message, true));
});
$("projects").addEventListener("dragend", () => {
  drag = null;
  clearDropMarks();
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
// A session just opened shows "Loading" at once (common.js keeps the launches).
// Re-rendering would throw away a half-typed project name.
const renderSoon = () => (ui.renaming ? (pendingRender = true) : render());
window.manager.onLaunch(() => {
  renderSoon();
  setTimeout(renderSoon, LOADING_MAX_MS + 1000);
});
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
  el.addEventListener("lostpointercapture", () => el.removeEventListener("pointermove", move), { once: true });
});
$("splitter").addEventListener("dblclick", resetProjectsWidth);
$("splitter").addEventListener("keydown", e => {
  const step = { ArrowLeft: -SPLITTER_STEP_PX, ArrowRight: SPLITTER_STEP_PX }[e.key];
  if (step) {
    e.preventDefault();
    setProjectsWidth(getProjectsWidth(document.querySelector("main > .panel").getBoundingClientRect().right + step));
  }
});
restoreProjectsWidth();

load();
setInterval(pollLive, 2000);
