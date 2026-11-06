let raw = { registry: { projects: [] }, sessions: [] };
let data = { projects: [], sessions: [], groups: [] };
let visible = [];
// Every project's path in the order shown, hidden ones too: a drag or a pin is placed within it.
let order = [];
// Each project's group id ("" for none), by its path as listed, hidden ones too.
let groupOfPath = new Map();
// The open Groups menu of a project card.
let groupMenu = null;
const getGroupOf = path => groupOfPath.get(path) || "";
const ui = { query: "", agent: "", selected: "", active: -1, renaming: "", loading: false, loaded: false };

// Running sessions, keyed like `Claude:<id>`; refreshed every couple of seconds from the agents' own registries.
let live = new Map(), liveSig = "", pendingRender = false;
const liveOf = s => live.get(sessionKey(s));

function prepare() {
  const built = buildData(raw, live);
  order = built.projects.map(p => p.path);
  groupOfPath = new Map(built.projects.map(p => [p.path, p.group || ""]));
  data = conceal(built, readHidden());
  if (ui.selected && !(ui.selected.startsWith("g:") ? data.groups : data.projects).some(x => x.n === ui.selected)) ui.selected = "";
  if (groupMenu?.dataset.path && !groupOfPath.has(groupMenu.dataset.path)) closeGroupMenu();
}
// The selected project, or the selected group as {group, members, sessions}.
function findSelected() {
  if (!ui.selected.startsWith("g:")) return data.projects.find(p => p.n === ui.selected);
  const g = data.groups.find(x => x.n === ui.selected);
  if (g && !g.size) return getEmptyUnit(g);
  return getUnits(data.projects, data.groups).find(u => u.group?.n === ui.selected);
}
const getEmptyUnit = g => ({ group: g, members: [], sessions: [] });
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
  const groupHits = new Set(toks.length ? data.groups.filter(g => matches(g.hay, toks)).map(g => g.id) : []);
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
  const sessions = [...running, ...byAgent.filter(s => !liveOf(s))];
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
  // Empty groups (just made) at the top, the newest first.
  if (!v.toks.length) html += data.groups.filter(g => !g.size).reverse().map(g => buildGroupHtml(getEmptyUnit(g), v, false)).join("");
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
const buildCountHtml = (count, v) =>
  `<span class="count" title="${esc(t(v.toks.length ? "manager.project.countMatching" : "manager.project.countAll"))}">${count}</span>`;
const buildNameHtml = (x, v, label) => (ui.renaming === x.n
  ? `<input class="rename" value="${esc(x.name)}" maxlength="80" aria-label="${esc(t(label))}">`
  : `<span class="proj-name" title="${esc(x.name)}">${hl(x.name, v.toks)}</span>`);

// One line: the project's mark, name, branch, running sessions and count; its folder and last activity in the tooltip.
// A terminal and Explorer show while the row is pointed at or chosen, the rest is in its menu.
function buildProjectHtml(p, count, v) {
  const member = Boolean(p.group);
  const tip = `${p.name}\n${p.path}\n${p.last ? ago(p.last) : t("manager.project.noSessions")}`;
  return `
    <div class="proj ${member ? "member" : ""} ${ui.selected === p.n ? "active" : ""}" data-path="${esc(p.path)}" tabindex="0" ${getDraggableAttr(v, p.n)}>
      <div class="proj-row" title="${esc(tip)}"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
        ${buildNameHtml(p, v, "manager.project.newName")}
        ${isPinned(p) ? buildPinMark() : ""}
        ${gitChip(p.path)}${projectLive(p.sessions)}
        ${buildCountHtml(count, v)}
      </div>
      <span class="proj-tools">
        <button class="icon-btn" data-action="terminal" title="${esc(t("action.terminalHere"))}">${icon("terminal")}</button>
        <button class="icon-btn" data-action="explorer" title="${esc(t("action.explorerTitle"))}">${icon("open")}</button>
        <button class="icon-btn" data-action="project-menu" title="${esc(t("manager.project.more"))}" aria-haspopup="menu">${icon("more")}</button>
      </span>
    </div>`;
}

// The shown projects only: hidden ones count neither in the number nor in the latest activity.
function getGroupMeta(members) {
  const last = Math.max(0, ...members.map(p => p.last));
  return `${tn("manager.projectGroup.projects", members.length)} · ${last ? ago(last) : t("manager.project.noSessions")}`;
}
function buildGroupHtml(u, v, shut) {
  const g = u.group;
  const count = v.toks.length ? u.sessions.filter(s => v.hitSet.has(s)).length : u.sessions.length;
  const tip = `${g.name}\n${g.size ? `${getMemberNames(u.members)}\n${getGroupMeta(u.members)}` : t("manager.projectGroup.empty")}`;
  return `
    <div class="proj grp ${ui.selected === g.n ? "active" : ""}" data-group="${esc(g.id)}" tabindex="0" ${g.size ? getDraggableAttr(v, g.n) : ""}>
      <div class="proj-row" title="${esc(tip)}">
        <button class="icon-btn fold" data-action="fold" title="${esc(t(shut ? "manager.projectGroup.expand" : "manager.projectGroup.collapse"))}">${icon(shut ? "right" : "down")}</button>
        ${icon("stack")}${buildNameHtml(g, v, "manager.projectGroup.newName")}
        ${isPinned(g) ? buildPinMark() : ""}
        ${projectLive(u.sessions)}
        ${buildCountHtml(count, v)}
      </div>
      <span class="proj-tools">
        ${g.size ? buildPinButton(g) : ""}
        <button class="icon-btn" data-action="rename" title="${esc(t("action.rename"))}">${icon("pencil")}</button>
        <button class="icon-btn danger" data-action="ungroup" title="${esc(t("manager.projectGroup.delete"))}">${icon("x")}</button>
      </span>
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
  $("newGroup").hidden = !data.projects.length;
}

function projectLive(sessions) {
  const states = sessions.map(liveOf).filter(Boolean);
  if (!states.length) return "";
  const { busy, waiting, idle } = countLiveGroups(states);
  const title = [waiting && tn("live.count.waiting", waiting), busy && tn("live.count.busy", busy), idle && tn("live.count.idle", idle)].filter(Boolean).join(", ");
  return `<span class="proj-live" title="${esc(title)}">${waiting ? `<span class="pulse attn"></span>${waiting}` : ""}${busy ? `<span class="spinner"></span>${busy}` : ""}${idle ? `<span class="pulse"></span>${idle}` : ""}</span>`;
}

// The window title counts the sessions that need the user, else the working ones; the list's groups show the rest.
function renderTitle(v) {
  const { busy, waiting } = v.liveCounts;
  document.title = waiting ? `(${waiting}!) ${t("app.name")}` : busy ? `(${busy}) ${t("app.name")}` : t("app.name");
}
function renderAgentFilter(v) {
  const options = [["", t("manager.agents.all"), v.scoped.length], ...AGENTS.map(a => [a, a, v.agentCounts[a]])];
  $("agentFilter").innerHTML = options.map(([key, label, n]) =>
    `<option value="${key}" ${ui.agent === key ? "selected" : ""} ${n || ui.agent === key || !key ? "" : "disabled"}>${esc(label)} (${n})</option>`).join("");
}

function renderSessions(v) {
  $("sessionCount").textContent = v.sessions.length;
  renderTitle(v);
  renderAgentFilter(v);

  $("scope").innerHTML = v.sel?.group ? `<div class="scope">${icon("stack")}
      <div class="grow"><div class="label">${esc(t("manager.scope.group", { name: v.sel.group.name }))}</div>
        <div class="path">${esc(getMemberNames(v.sel.members))}</div></div>
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
    const g = getSessionGroup(s, liveOf(s));
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(sessionHtml(s, i, v.toks));
  });
  $("sessions").innerHTML = [...groups].map(([g, items]) =>
    `<div class="group">${esc(g)}<span class="n">${items.length}</span></div>${items.join("")}`).join("");
}

// One or two lines: the agent, the title, where it ran, its context and cost, when, and its state; the recap below.
// The actions show over the right end while the row is pointed at, chosen or holds the focus.
function sessionHtml(s, i, toks) {
  const l = liveOf(s);
  const key = sessionKey(s);
  const loading = isLoading(key, l);
  // A running session: its terminal is brought up, or moved into a tab; a past one is resumed or continued fresh
  // (preview-ui.js).
  const actions = l
    ? `<button class="btn sm" data-action="show-terminal" title="${esc(t("term.showTitle", { pid: l.pid }))}">${icon("raise")}${esc(t("term.show"))}</button>
      ${isMoveHereOffered(s) ? `<button class="icon-btn" data-action="move-here" title="${esc(t("term.moveHereTitle"))}">${icon("download")}</button>` : ""}`
    : getSessionActions(s);
  return `<article class="sess ${i === ui.active ? "active" : ""}" data-i="${i}">
    <div class="sess-main">
      <div class="sess-line">${agentMark(s.agent)}
        <h3 class="sess-title" title="${esc(s.title)}">${hl(s.title, toks)}</h3>
        ${whereHtml(s, toks)}
        ${getContextChip(s)}${usageChip(s)}
        <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span>
        ${statusMark(l, loading)}
      </div>
      ${s.recap ? `<p class="sess-recap" title="${esc(s.recap)}">${hl(s.recap, toks)}</p>` : ""}
      <div class="sess-acts">${actions}
        <button class="icon-btn" data-action="row-menu" title="${esc(t("manager.session.more"))}" aria-haspopup="menu">${icon("more")}</button></div>
    </div>
    ${l?.subagents?.length ? subagentsHtml(key, l.subagents, "data-action") : ""}
  </article>`;
}
// The folder's name (the whole path in the tooltip) and its branch.
function whereHtml(s, toks) {
  if (!s.cwd) return `<span class="where unknown" title="${esc(t("manager.session.noDir"))}">${icon("alert")}</span>`;
  const leaf = s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || s.cwd;
  return `<span class="where"><span class="where-dir" title="${esc(s.cwd)}">${hl(leaf, toks)}</span>${gitChip(s.workDir || s.cwd)}</span>`;
}

function emptySessions(v) {
  const box = (title, body, actions = []) => `<div class="empty"><h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ""}
    ${actions.length ? `<div class="actions">${actions.map(([action, label]) => `<button class="btn" data-action="${action}">${esc(t(label))}</button>`).join("")}</div>` : ""}</div>`;
  if (v.toks.length) return box(t(v.sel ? "manager.empty.searchInProject" : "manager.empty.search", { q: ui.query }), t("manager.empty.searchBody"),
    [["clear-search", "manager.empty.clearSearch"], ...(v.sel ? [["all", "manager.empty.searchAll"]] : [])]);
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

// Returns true when the set of running sessions, any of their states or their subagents changed.
function setLive(list) {
  live = new Map(list.map(l => [sessionKey(l), l]));
  const sig = liveSignature(list);
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

// Between state changes only the "activity N sec ago" texts and a stalled spinner move; update them in place.
function updateLiveTexts() {
  document.querySelectorAll("[data-live]").forEach(el => {
    const l = live.get(el.dataset.live);
    if (!l) return;
    el.className = getStatusClass(l);
    el.title = getStatusTitle(l);
  });
}

// key: a project's normalized path, or "g:<id>" for a group.
function selectProject(key) {
  ui.selected = ui.selected === key ? "" : key;
  ui.active = -1;
  render({ resetScroll: true });
  const sel = ui.selected && findSelected();
  if (sel) showProjectTab(sel);
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
  const { group, path } = input.closest(".proj").dataset;
  const item = group ? data.groups.find(g => g.id === group) : data.projects.find(p => p.n === ui.renaming);
  const name = input.value.trim();
  ui.renaming = "";
  if (!item || !name || name === item.name || pendingRender) render();
  if (!item || !name || name === item.name) return;
  applyRegistry(await (group ? window.manager.renameGroup(item.id, name) : window.manager.renameProject(path, name)));
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
// Empty, or with the project at `path` in it; either way named right away (an empty one shows only without a search).
async function createGroup(path) {
  if (!path && ui.query) setQuery("");
  const known = new Set(data.groups.map(g => g.id));
  applyRegistry(await window.manager.createGroup(path));
  const g = data.groups.find(x => !known.has(x.id));
  if (!g) return;
  collapsed.delete(g.id);
  ui.renaming = g.n;
  render();
}
// In "My order" the project goes after the group's last one; by activity only its group changes.
async function moveToGroup(path, id) {
  if (raw.registry.order !== "custom") return applyRegistry(await window.manager.setProjectGroup(path, id));
  await applyDrop(getDropPlan({ path }, { dataset: { group: id } }, "into"));
}
// The shown order with `src` ({path} or {group}) moved before, after or into the item of `card`, and the group the
// moved project ends up in.
function getDropPlan(src, card, where) {
  const moving = src.group ? order.filter(x => getGroupOf(x) === src.group) : [src.path];
  const isMoving = new Set(moving);
  const rest = order.filter(x => !isMoving.has(x));
  const joins = getJoinedGroup(card, where);
  const anchor = getAnchor(rest, card, where, card.dataset.group || (src.group ? joins : ""));
  if (!anchor && where === "into") return { list: order, groupOf: { [src.path]: joins } };
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
// Out of its group, right after the group's other projects; the group stays even when this was its last one.
async function leaveGroup(path) {
  const id = getGroupOf(path);
  if (raw.registry.order !== "custom") return applyRegistry(await window.manager.setProjectGroup(path, ""));
  const list = order.filter(x => x !== path);
  const last = list.findLast(x => getGroupOf(x) === id);
  list.splice(last ? list.indexOf(last) + 1 : order.indexOf(path), 0, path);
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
    case "group-menu": return openGroupMenu(btn, path);
    case "project-menu": return openProjectMenu(btn, path);
    case "ungroup": return applyRegistry(await window.manager.deleteGroup(groupId));
    case "fold": return toggleCollapsed(groupId);
    case "remove":
      if (!confirm(t("manager.confirm.remove", { path }))) return;
      return applyRegistry(await window.manager.removeProject(path));
    case "all": ui.selected = ""; return render({ resetScroll: true });
    case "all-agents": ui.agent = ""; return render({ resetScroll: true });
    case "row-menu": return openRowMenu(btn, visible[Number(btn.closest(".sess").dataset.i)]);
    case "subagents": {
      const key = btn.dataset.key;
      subagentsOpen.set(key, !isSubagentsOpen(key, live.get(key)?.subagents || []));
      return render();
    }
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
$("agentFilter").addEventListener("change", e => {
  ui.agent = e.target.value; ui.active = -1;
  render({ resetScroll: true });
});
$("scope").addEventListener("click", onAction);
$("projects").addEventListener("click", async e => {
  if (e.target.classList.contains("rename") || await onAction(e)) return;
  const card = e.target.closest(".proj");
  if (card) selectProject(getCardKey(card));
});
$("projects").addEventListener("contextmenu", e => {
  const card = e.target.closest(".proj[data-path]");
  if (!card?.dataset.path || e.target.classList.contains("rename")) return;
  e.preventDefault();
  openProjectMenu(card.querySelector("[data-action=project-menu]"), card.dataset.path);
});
$("projects").addEventListener("keydown", e => {
  if (e.target.classList.contains("rename")) {
    if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ui.renaming = ""; render(); }
    return;
  }
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("proj")) {
    e.preventDefault();
    selectProject(getCardKey(e.target));
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && e.target.matches(".proj[draggable]")) {
    e.preventDefault();
    moveByKey(e.target, e.key === "ArrowDown").catch(err => toast(err.message, true));
  }
});
// The card to move past. An open group is one block: going down, a group skips its own projects; going up, anything
// outside a group passes it whole (at its header) instead of joining it.
function getNextCard(card, down) {
  let next = down ? card.nextElementSibling : card.previousElementSibling;
  while (down && card.dataset.group && next?.dataset.path && getGroupOf(next.dataset.path) === card.dataset.group) next = next.nextElementSibling;
  const above = !down && next?.dataset.path ? getGroupOf(next.dataset.path) : "";
  if (above && above !== getGroupOf(card.dataset.path)) next = document.querySelector(`.proj.grp[data-group="${CSS.escape(above)}"]`);
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
$("newGroup").addEventListener("click", () => createGroup().catch(err => toast(err.message, true)));

// ---------- projects: the group menu ----------
// Moves a project into another group (Move to a group, then the group), a new one, or out of its own.
function openGroupMenu(btn, path, items = getGroupMenuItems(path)) {
  closeGroupMenu();
  groupMenu = document.createElement("div");
  groupMenu.dataset.path = path;
  groupMenu.className = "menu";
  groupMenu.setAttribute("role", "menu");
  document.body.append(groupMenu);
  showMenuItems(items, btn);
}
// A project's menu: its folder, its place in the list and its group, its name; removing it. Also on a right-click.
function openProjectMenu(btn, path) {
  const p = data.projects.find(x => x.n === normPath(path));
  if (!p) return;
  openGroupMenu(btn, path, [
    { label: t("action.copyPath"), icon: "copy", run: async () => { await window.manager.copyText(path); toast(t("toast.copied", { path })); } },
    ...(p.group ? [] : [{ label: t(isPinned(p) ? "action.unpin" : "action.pin"), icon: "pin", run: () => pinProject(path) }]),
    ...getGroupMenuItems(path),
    { label: t("action.rename"), icon: "pencil", run: async () => { ui.renaming = p.n; render(); } },
    { label: t("action.remove"), icon: "trash", run: () => runAction("remove", btn) }
  ]);
}
// A session's own menu: its id and folder, a terminal or Explorer there. Also on a right-click of the row.
function openRowMenu(btn, s) {
  if (!s) return;
  closeGroupMenu();
  groupMenu = document.createElement("div");
  groupMenu.className = "menu";
  groupMenu.setAttribute("role", "menu");
  document.body.append(groupMenu);
  const copy = (text, msg) => async () => { await window.manager.copyText(text); toast(msg); };
  showMenuItems([
    { label: t("manager.session.copyId"), icon: "copy", run: copy(s.id, t("manager.toast.copiedId", { id: s.id })) },
    ...(s.cwd ? [
      { label: t("action.copyPath"), icon: "copy", run: copy(s.cwd, t("toast.copied", { path: s.cwd })) },
      { label: t("action.terminalHere"), icon: "terminal", run: async () => { await window.manager.launchFolder(s.cwd); toast(t("manager.toast.terminal", { path: s.cwd })); } },
      { label: t("action.explorerTitle"), icon: "open", run: async () => { const err = await window.manager.openPath(s.cwd); if (err) throw new Error(err); } }
    ] : [])
  ], btn);
}
function getGroupMenuItems(path) {
  const own = getGroupOf(path);
  const targets = data.groups.filter(g => g.id !== own).map(g => ({ label: g.name, icon: "stack", run: () => moveToGroup(path, g.id) }));
  return [
    ...(targets.length ? [{ label: t("manager.projectGroup.move"), icon: "stack", items: targets }] : []),
    { label: t("manager.projectGroup.create"), icon: "plus", run: () => createGroup(path) },
    ...(own ? [{ label: t("manager.projectGroup.leave"), icon: "x", run: () => leaveGroup(path) }] : [])
  ];
}
// A submenu opens in place of the menu, with Back to return.
function showMenuItems(items, btn) {
  groupMenu.innerHTML = items.map((x, i) => `<button role="menuitem" data-i="${i}" ${x.items ? 'aria-haspopup="menu"' : ""}>
    ${icon(x.icon)}<span>${esc(x.label)}</span>${x.items && !x.back ? icon("right") : ""}</button>`).join("");
  groupMenu.onclick = e => {
    const item = items[e.target.closest("[data-i]")?.dataset.i];
    if (item?.items) return showMenuItems(item.back ? item.items : [{ label: t("manager.projectGroup.back"), icon: "left", items, back: true }, ...item.items], btn);
    if (!item) return;
    closeGroupMenu();
    item.run().catch(err => toast(err.message, true));
  };
  placeGroupMenu(btn);
  groupMenu.querySelector("button").focus();
}
function placeGroupMenu(btn) {
  const r = btn.getBoundingClientRect();
  const below = r.bottom + groupMenu.offsetHeight + 4 <= window.innerHeight;
  groupMenu.style.top = (below ? r.bottom + 4 : r.top - groupMenu.offsetHeight - 4) + "px";
  groupMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - groupMenu.offsetWidth - 8)) + "px";
}
function closeGroupMenu() {
  groupMenu?.remove();
  groupMenu = null;
}
document.addEventListener("mousedown", e => {
  if (groupMenu && !groupMenu.contains(e.target)) closeGroupMenu();
}, true);
document.addEventListener("keydown", e => {
  if (!groupMenu) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    const path = groupMenu.dataset.path;
    closeGroupMenu();
    [...document.querySelectorAll(".proj[data-path]")].find(el => el.dataset.path === path)?.querySelector("[data-action=project-menu]")?.focus();
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    const all = [...groupMenu.querySelectorAll("button")];
    const i = all.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1);
    all[(i + all.length) % all.length].focus();
  }
}, true);

// ---------- projects: drag and drop ----------
// A project goes before or after another, into a group (the lower half of its row) or out of it; a group moves whole.
let drag = null;
const getSource = card => (card.dataset.group ? { group: card.dataset.group } : { path: card.dataset.path });
function getDropCard(e) {
  const card = e.target.closest(".proj[draggable], .proj.grp");
  if (!card || !drag) return null;
  if (drag.group) return card.dataset.group === drag.group || getGroupOf(card.dataset.path) === drag.group || !card.draggable ? null : card;
  return card.dataset.path === drag.path ? null : card;
}
function getDropWhere(card, e) {
  const r = card.getBoundingClientRect();
  const lower = e.clientY > r.top + r.height / 2;
  if (card.dataset.group && drag.path) return lower || !card.draggable ? "into" : "before";
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
$("sessions").addEventListener("contextmenu", e => {
  const card = e.target.closest(".sess");
  if (!card) return;
  e.preventDefault();
  setActive(Number(card.dataset.i));
  openRowMenu(card.querySelector("[data-action=row-menu]"), visible[Number(card.dataset.i)]);
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
