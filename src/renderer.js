// The manager window's sidebar - the projects (each a space with its own terminals, workspace-ui.js), the agents
// running now and the other terminals running on any computer - and what the centre shows for a project with no
// terminals open.
let raw = { registry: { projects: [] }, sessions: [] };
let data = { projects: [], sessions: [], groups: [] };
// The same, hidden ones too (each marked .concealed): the Project sessions view lists and counts them.
let built = { projects: [], sessions: [], groups: [] };
// Every project's path in the order shown, hidden ones too: a drag or a pin is placed within it.
let order = [];
// Each project's group id ("" for none), by its path as listed, hidden ones too.
let groupOfPath = new Map();
// The open Groups menu of a project card. menuLayers: the root menu and its flyout submenus, deepest last.
let groupMenu = null, menuLayers = [];
const getGroupOf = path => groupOfPath.get(path) || "";
// selected: the shown space (workspace-ui.js decides it; a project's normalized path).
const ui = { selected: "", renaming: "", loading: false, loaded: false };

// Running sessions, keyed like `Claude:<id>`; refreshed every couple of seconds from the agents' own registries.
let live = new Map(), liveSig = "", pendingRender = false;
let allLive = new Map();
const liveOf = s => allLive.get(sessionKey(s));

// A card stands for its project by `ref`: the folder here, or the key of a project of another computer (nodes-ui.js
// mergeNodes brings those computers' sessions and live states in beside this computer's).
const refOf = p => (p.node ? p.n : p.path);
function prepare() {
  const m = mergeNodes(raw, live);
  allLive = m.live;
  built = buildData(m.raw, m.live);
  order = built.projects.map(refOf);
  groupOfPath = new Map(built.projects.map(p => [refOf(p), p.group || ""]));
  data = conceal(built, readHidden());
  if (groupMenu?.dataset.owner === "project" && !groupOfPath.has(groupMenu.dataset.path)) closeGroupMenu();
}
const getEmptyUnit = g => ({ group: g, members: [], sessions: [] });

// toks stays empty: the sidebar lists everything, searching is the palette's (palette-ui.js).
function compute() {
  const toks = [];
  const hits = data.sessions;
  const hitSet = new Set(hits);
  const projects = data.projects.map(p => ({ p, count: p.sessions.length }));
  // The agents: running sessions, those that need the user first.
  const running = hits.filter(liveOf).sort((a, b) => getLiveRank(liveOf(a)) - getLiveRank(liveOf(b)) || lastSign(liveOf(b)) - lastSign(liveOf(a)));
  const liveCounts = countLiveGroups(data.sessions.map(liveOf).filter(Boolean));
  return { toks, hits, hitSet, projects, running, liveCounts };
}

// ---------- rendering ----------
function render() {
  pendingRender = false;
  removeEndedLaunches(key => allLive.get(key));
  const v = compute();
  renderCentre();
  renderProjects(v);
  renderAgents(v);
  renderTerms(v);
  window.gitPanel?.render();
  renderTitle(v);
  if (!getShownTab()) renderSpaceEmpty($("spaceEmpty"), ws.activeSpace);
  renderFocusInfo();
  window.searchPalette?.render();
  const input = document.querySelector(".rename");
  if (input && document.activeElement !== input) { input.focus(); input.select(); }
  syncAnimations();
}

// The command centre (orchestrator.js): its space, its terminal and the state of its session.
const CENTRE = "orchestrator";
function getCentreTerm() {
  const tab = ws.tabs[ws.spaces[CENTRE]?.tabs[0]];
  return tab ? getTerminal(getPanesOf(tab.root)[0]) : null;
}
const isCentreSession = s => Boolean(s?.id && getCentreTerm()?.sessionId === s.id);
function renderCentre() {
  const term = getCentreTerm();
  const key = term?.sessionId ? `Claude:${term.sessionId}` : "";
  const l = key ? allLive.get(key) : null;
  const running = Boolean(term && !term.exited);
  const sub = !running ? t("centre.status.off") : !l ? t("live.hint.loading")
    : l.status === "busy" ? t("manager.group.working") : l.status === "waiting" ? t("manager.group.needs") : t("manager.group.ready");
  const html = `<div class="proj ${ui.selected === CENTRE ? "active" : ""}" data-centre tabindex="0" title="${esc(t("centre.sub"))}">
      <div class="proj-row"><span class="centre-mark">${icon("bolt")}</span><span class="proj-name">${esc(t("centre.title"))}</span>
        <span class="centre-sub">${esc(sub)}</span>${running ? statusMark(l, !l) : ""}</div></div>`;
  const el = $("centre");
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}
function renderProjects(v) {
  const total = data.projects.length;
  // By device (device-view.js): a section per computer, only the chosen ones when the filter is on.
  const devices = listDevices(data.projects, nodes);
  const view = deviceViewState(deviceView, devices), filter = view.filter;
  grouped = view.grouped;
  $("projectCount").textContent = v.toks.length ? `${v.projects.length} / ${total}`
    : filter.length ? `${countInSections(data.projects, devices, filter)} / ${total}` : total;
  renderOrderToggle();
  renderDeviceToggle(devices, view);
  renderDeviceChips(devices, view);
  let html = "";
  // Empty groups (just made) at the top, the newest first.
  if (!v.toks.length) html += data.groups.filter(g => !g.size).reverse().map(g => buildGroupHtml(getEmptyUnit(g), v, false)).join("");
  const counts = new Map(v.projects.map(x => [x.p, x.count]));
  const listed = v.projects.map(x => x.p);
  html += byDevice() ? buildSections(listed, devices, filter).map(s => buildDeviceHtml(s, v, counts)).join("") : buildUnitsHtml(listed, v, counts);
  if (!total && ui.loaded) html += `<div class="empty small">${esc(t("manager.projects.empty"))}</div>`;
  patchChildren($("projects"), html);
}
// Projects as listed, each group (folded or open) where its first project is.
function buildUnitsHtml(projects, v, counts) {
  return getUnits(projects, data.groups).map(u => {
    if (!u.group) return buildProjectHtml(u.project, counts.get(u.project), v);
    const shut = isCollapsed(u.group.id) && !v.toks.length;
    return buildGroupHtml(u, v, shut) + (shut ? "" : u.members.map(p => buildProjectHtml(p, counts.get(p), v)).join(""));
  }).join("");
}
// In the device view the rows are not in the list's own order, so nothing is dragged there (as while searching).
const getDraggableAttr = (v, n) => (v.toks.length || byDevice() || ui.renaming === n ? "" : 'draggable="true"');
const buildPinMark = () => `<span class="pin-mark" title="${esc(t("manager.project.pinned"))}">${icon("pin")}</span>`;
const buildPinButton = x => `<button class="icon-btn ${isPinned(x) ? "on" : ""}" data-action="pin" title="${esc(t(isPinned(x) ? "action.unpin" : "action.pin"))}">${icon("pin")}</button>`;
// Beside a project only what asks for attention - uncommitted changes, commits not in step with the upstream; the
// branch itself is in the row's tooltip.
function getProjectGit(p, node) {
  const state = node ? node.git || {} : git;
  const g = gitOf(p.path, state);
  return { g: g && !g.error ? g : null, chip: g && !g.error && (gitDirty(g) || g.ahead || g.behind) ? gitChip(p.path, state) : "" };
}
// In the device view the rows stand a step in from their computer's heading.
const getDeviceClass = () => (byDevice() ? "in-dev" : "");
const buildNameHtml = (x, v, label) => (ui.renaming === x.n
  ? `<input class="rename" value="${esc(x.name)}" maxlength="80" aria-label="${esc(t(label))}">`
  : `<span class="proj-name" title="${esc(x.name)}">${hl(x.name, v.toks)}</span>`);

// One line: the project's mark, name, branch, running sessions and count; its folder and last activity in the tooltip.
// A terminal and Explorer show while the row is pointed at or chosen, the rest is in its menu.
function buildProjectHtml(p, count, v) {
  const offline = Boolean(p.node && getNode(p.node)?.status !== "online");
  const member = Boolean(p.group);
  const node = p.node ? getNode(p.node) : null;
  const { g, chip } = getProjectGit(p, node);
  const tip = `${p.name}\n${p.path}${node ? `\n${nodeLabel(node)}` : ""}\n${p.last ? ago(p.last) : t("manager.project.noSessions")}${g ? `\n\n${gitTitle(g)}` : ""}`;
  return `
    <div class="proj ${offline ? "offline" : ""} ${member ? "member" : ""} ${getDeviceClass()} ${ui.selected === p.n ? "active" : ""}" data-path="${esc(refOf(p))}" ${p.node ? `data-node="${esc(p.node)}"` : ""} tabindex="0" ${getDraggableAttr(v, p.n)}>
      <div class="proj-row" title="${esc(tip)}"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
        ${buildNameHtml(p, v, "manager.project.newName")}
        ${isPinned(p) ? buildPinMark() : ""}
        ${node && !byDevice() ? `<span class="proj-node ${node.status}" title="${esc(nodeLabel(node))}">${icon(node.kind === "host" ? "terminal" : "nodes")}${esc(node.name)}</span>` : ""}${chip}${projectLive(p.sessions)}
        ${getSpaceTabsHtml(p.n)}
      </div>
      <span class="proj-tools">
        <button class="icon-btn" data-action="terminal" ${offline ? "disabled" : ""} title="${esc(t("action.terminalHere"))}">${icon("terminal")}</button>
        ${p.node ? "" : `<button class="icon-btn" data-action="explorer" title="${esc(t("action.explorerTitle"))}">${icon("open")}</button>`}
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
  const tip = `${g.name}\n${g.size ? `${getMemberNames(u.members)}\n${getGroupMeta(u.members)} · ${tn("manager.status.sessions", u.sessions.length)}` : t("manager.projectGroup.empty")}`;
  return `
    <div class="proj grp ${getDeviceClass()} ${ui.selected === g.n ? "active" : ""}" data-group="${esc(g.id)}" tabindex="0" ${g.size ? getDraggableAttr(v, g.n) : ""}>
      <div class="proj-row" title="${esc(tip)}">
        <button class="icon-btn fold" data-action="fold" title="${esc(t(shut ? "manager.projectGroup.expand" : "manager.projectGroup.collapse"))}">${icon(shut ? "right" : "down")}</button>
        ${icon("stack")}${buildNameHtml(g, v, "manager.projectGroup.newName")}
        ${isPinned(g) ? buildPinMark() : ""}
        ${projectLive(u.sessions)}
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

// ---------- projects by device (device-view.js) ----------
// Group: None / By device, the chosen devices and the folded device sections: a view of this window only, kept in its
// localStorage like the folded groups. It never calls main, so the registry and the layout shared
// with the other computers (mesh/layout.js) stay as they are.
const DEVICE_VIEW_KEY = "agentdeck.deviceView";
function readDeviceView() {
  try {
    return normalizeDeviceView(JSON.parse(localStorage.getItem(DEVICE_VIEW_KEY)));
  } catch {
    return normalizeDeviceView(null);
  }
}
let deviceView = readDeviceView();
// In sections (the chips open, or a device filter on): set by renderProjects, read while it builds the rows.
let grouped = false;
const byDevice = () => grouped;
const pickerOpen = () => deviceView.mode === "device";
function setDeviceView(change) {
  deviceView = normalizeDeviceView({ ...deviceView, ...change });
  try {
    localStorage.setItem(DEVICE_VIEW_KEY, JSON.stringify(deviceView));
  } catch {}
  render();
}
// The toggle opens or closes the chips; a chosen filter stays either way.
const toggleDeviceMode = () => setDeviceView({ mode: pickerOpen() ? "none" : "device" });
const toggleDeviceFold = id => setDeviceView({ collapsed: toggleCollapsedDevice(deviceView.collapsed, id) });
// A chip adds its device to the filter or takes it out; "All" clears it. Devices no longer known drop out on a change.
function chooseDevice(id) {
  const known = activeFilter(deviceView.filter, listDevices(data.projects, nodes));
  setDeviceView({ filter: id ? toggleFilter(known, id) : [] });
}
const deviceName = d => (d.local ? t("manager.devices.local") : d.name);
const deviceIcon = d => (d.local ? "window" : d.kind === "host" ? "terminal" : "nodes");
// "offline · seen 3 hours ago" (or only "offline" when it was never seen).
const deviceState = d => (d.status === "online" ? "" : d.lastSeen ? t("manager.devices.offlineSince", { time: ago(d.lastSeen) }) : t("manager.node.offline"));
const deviceTip = d => [deviceName(d), t(d.local ? "manager.devices.thisOne" : d.kind === "host" ? "manager.devices.host" : "manager.devices.desktop"),
  deviceState(d) || t("manager.devices.online"), tn("manager.projectGroup.projects", d.count)].join("\n");

// Lit while a device filter is on (the chips open or not); "All" clears the filter and puts it out.
function renderDeviceToggle(devices, view) {
  const el = $("projectView");
  el.innerHTML = icon("nodes");
  el.classList.toggle("on", view.filtered);
  el.classList.toggle("open", view.picker);
  el.setAttribute("aria-pressed", String(view.filtered));
  el.setAttribute("aria-expanded", String(view.picker));
  const names = devices.filter(d => view.filter.includes(d.id)).map(deviceName).join(", ");
  el.title = view.filtered ? `${t("manager.devices.filter")}: ${names}\n${t("manager.devices.byDeviceTitle")}`
    : `${t("manager.devices.group")}: ${t(view.grouped ? "manager.devices.byDevice" : "manager.devices.none")}\n${t(view.grouped ? "manager.devices.byDeviceTitle" : "manager.devices.noneTitle")}`;
  // Only worth having with another computer paired (or to turn it off again).
  el.hidden = !data.projects.length || (devices.length < 2 && !view.grouped);
}
// The filter: "All" and a chip per device, shown while the toggle has them open and there is more than this computer.
function renderDeviceChips(devices, view) {
  const el = $("deviceChips");
  const show = view.picker && devices.length > 1;
  const chosen = new Set(view.filter);
  const chip = (id, on, label, tip, extra = "") =>
    `<button class="dev-chip ${on ? "on" : ""} ${extra}" data-device-filter="${esc(id)}" aria-pressed="${on}" title="${esc(tip)}">${label}</button>`;
  const html = !show ? "" : chip("", !chosen.size, esc(t("manager.devices.all")), t("manager.devices.allTitle"))
    + devices.map(d => chip(d.id, chosen.has(d.id), `<span class="dev-dot"></span>${icon(deviceIcon(d))}<span>${esc(deviceName(d))}</span>`,
      `${deviceTip(d)}\n${t("manager.devices.filterTitle", { device: deviceName(d) })}`, d.status)).join("");
  el.hidden = !show;
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
}
// A device's section: its header (folds the section; offline with when it was last seen), then its projects with
// the user's groups inside, in the list's own order.
function buildDeviceHtml({ device: d, projects }, v, counts) {
  const shut = deviceView.collapsed.includes(d.id);
  const state = deviceState(d);
  const head = `
    <div class="proj dev ${d.status}" data-device="${esc(d.id)}" tabindex="0" aria-expanded="${!shut}">
      <div class="proj-row" title="${esc(deviceTip(d))}">
        <button class="icon-btn fold" data-action="fold-device" title="${esc(t(shut ? "manager.projectGroup.expand" : "manager.projectGroup.collapse"))}">${icon(shut ? "right" : "down")}</button>
        <span class="dev-icon">${icon(deviceIcon(d))}</span><span class="proj-name">${esc(deviceName(d))}</span>
        ${state ? `<span class="dev-state">${esc(state)}</span>` : ""}
        <span class="count">${projects.length}</span>
      </div>
    </div>`;
  if (shut) return head;
  return head + (projects.length ? buildUnitsHtml(projects, v, counts) : `<div class="dev-empty">${esc(t("manager.devices.noProjects"))}</div>`);
}

function renderOrderToggle() {
  const custom = raw.registry.order === "custom";
  const el = $("projectOrder");
  el.innerHTML = icon(custom ? "sortCustom" : "sortActivity");
  el.classList.toggle("on", custom);
  el.title = `${t(custom ? "manager.order.custom" : "manager.order.activity")}: ${t(custom ? "manager.order.customTitle" : "manager.order.activityTitle")}`;
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

// How many tabs a project has open (workspace-ui.js), beside its name.
function getSpaceTabsHtml(n) {
  const count = ws.spaces[n]?.tabs.length || 0;
  return count ? `<span class="proj-tabs" title="${esc(tn("ws.tabCount", count))}">${icon("terminal")}${count}</span>` : "";
}
// The window title counts the sessions that need the user, else the working ones.
function renderTitle(v) {
  const { busy, waiting } = v.liveCounts;
  document.title = waiting ? `(${waiting}!) ${t("app.name")}` : busy ? `(${busy}) ${t("app.name")}` : t("app.name");
}

// ---------- agents ----------
// The sessions running now under Need you / Working / Waiting for you, each with its project and subagents. One open
// in AgentDeck is brought up by a click, one in another terminal too (or moved here from its menu).
function renderAgents(v) {
  $("agentCount").textContent = v.running.length;
  if (!v.running.length) {
    patchChildren($("agents"), `<div class="side-empty">${esc(t(ui.loaded ? "manager.agents.none" : "manager.status.scanning"))}</div>`);
    return;
  }
  let last = "", html = "";
  for (const s of v.running) {
    const l = liveOf(s), group = getSessionGroup(s, l);
    if (group !== last) html += `<div class="agroup">${esc(group)}</div>`;
    last = group;
    html += agentHtml(s, l, v.toks);
  }
  patchChildren($("agents"), html);
}
function agentHtml(s, l, toks) {
  // .here: a pane of it is in this window. "in another terminal": only one outside AgentDeck's terminals.
  const key = sessionKey(s), here = hasSessionPane(s);
  const project = isCentreSession(s) ? t("centre.title") : data.projects.find(p => inProject(s, p))?.name || s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const where = s.node ? ` · ${esc(s.nodeName || nodeNameOf(s.node))}` : findSessionTab(s) || l.term ? "" : ` · ${esc(t("manager.agents.outside"))}`;
  // One in a terminal of AgentDeck can be dragged onto a pane (workspace-ui.js); one outside cannot come here.
  const drag = getAgentTerm(s) ? 'draggable="true"' : "";
  return `<div class="agent ${here ? "here" : ""}" data-key="${esc(key)}" tabindex="0" ${drag} title="${esc(`${s.title}\n${s.cwd}${s.node ? `\n${s.nodeName || ""}` : ""}`)}">${agentMark(s.agent)}
      <div class="agent-main"><div class="agent-title">${hl(s.title, toks)}</div><div class="agent-sub">${esc(project)}${where}</div></div>
      ${statusMark(l, isLoading(key, l))}
      <span class="agent-tools"><button class="icon-btn" data-action="agent-menu" title="${esc(t("manager.agents.more"))}" aria-haspopup="menu">${icon("more")}</button></span></div>
    ${l.subagents?.length ? subagentsHtml(key, l.subagents, "data-action", SIDEBAR_SUBAGENTS) : ""}`;
}
// ---------- terminals ----------
// The terminals running on this and every online computer that the agents list does not show - shells, clones, an
// agent whose session is not live - whichever device opened them: this computer first, then the others in their
// order, the newest first in each. A click brings one up here (its pane, or a new one); Stop ends it for everyone.
function getSideTerms(v) {
  const shown = new Set(v.running.flatMap(s => [findSessionTab(s)?.id, liveOf(s)?.term]).filter(Boolean));
  const rank = x => (x.node ? 1 + nodes.findIndex(n => n.id === x.node) : 0);
  return ws.terminals.filter(x => !x.exited && !shown.has(x.id) && (!x.node || getNode(x.node)?.status === "online"))
    .sort((a, b) => rank(a) - rank(b) || (b.createdAt || 0) - (a.createdAt || 0));
}
// A remote terminal's title carries its computer's name (main adds it); the row says the computer below.
function getBareTermTitle(x) {
  const title = getTermTitle(x), suffix = x.node ? ` · ${nodeNameOf(x.node)}` : "";
  return (suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title) || x.cwd;
}
function termRowHtml(x) {
  const here = isPaned(x), title = getBareTermTitle(x);
  // Its project in the list, or as its computer lists it, else its folder's name.
  const cwdN = x.node ? remoteKey(x.node, normPath(x.cwd)) : normPath(x.cwd);
  const project = data.projects.find(p => inProject({ cwdN }, p))?.name || (x.node && getNode(x.node)?.view.projects.find(p => inProject({ cwdN: normPath(x.cwd) }, p))?.name)
    || x.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const sub = [project, x.node ? nodeNameOf(x.node) : t("manager.devices.local"), here ? "" : t("term.noPane")].filter(Boolean).map(esc).join(" · ");
  return `<div class="agent term ${here ? "here" : ""}" data-key="term:${esc(x.id)}" tabindex="0" draggable="true" title="${esc(`${title}\n${x.cwd}`)}">
      ${x.agent ? agentMark(x.agent) : `<span class="agent-mark">${icon("terminal")}</span>`}
      <div class="agent-main"><div class="agent-title">${esc(title)}</div><div class="agent-sub">${sub}</div></div>
      ${getViewersHtml(x, "term-viewers")}
      <span class="agent-tools"><button class="icon-btn danger" data-action="term-stop" title="${esc(t("term.stopAll"))}" aria-label="${esc(t("term.stopAll"))}">${icon("stop")}</button></span></div>`;
}
function renderTerms(v) {
  const list = getSideTerms(v);
  $("sideTerms").hidden = !list.length;
  $("termCount").textContent = list.length;
  patchChildren($("terms"), list.map(termRowHtml).join(""));
}
const termOfRow = row => row?.dataset.key?.startsWith("term:") ? row.dataset.key.slice(5) : "";
// The sidebar lists only the newest few of a session's subagents.
const SIDEBAR_SUBAGENTS = 3;
const sessionByKey = key => built.sessions.find(s => sessionKey(s) === key) || null;

// ---------- a project with no terminals open ----------
// Its name, a new terminal or agent session, and its latest sessions to resume.
// "" for a project of another computer: nothing opens here for it (nodes-ui.js opens there).
function getSpaceFolder(key) {
  const p = data.projects.find(p => p.n === key);
  return p && !p.node ? p.path : "";
}
// The agents found on this computer (all of them until the first scan tells).
const getInstalledAgents = () => (raw.agents?.length ? raw.agents : AGENTS);
// The keys of a new session of each agent (workspace-ui.js NEW_AGENT_KEYS), for the buttons' tooltips.
const getNewAgentKey = a => `Ctrl+Shift+${Object.keys(NEW_AGENT_KEYS).find(code => NEW_AGENT_KEYS[code] === a).slice(-1)}`;
// Ctrl+Shift+R: the shown project's newest session that runs nowhere, in a new tab.
function resumeLatest() {
  const p = data.projects.find(x => x.n === ws.activeSpace);
  if (!p) return;
  const s = p.sessions.filter(x => !liveOf(x) && !findSessionTab(x)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!s) return toast(t("keys.noSession"));
  resume(s).catch(e => toast(e.message, true));
}
function renderSpaceEmpty(el, key) {
  el.onclick = null;
  if (renderRemoteSpace(el, key)) return; // a project of another computer (nodes-ui.js)
  if (key === CENTRE) {
    setHtml(el, `<div class="se-box">
      <div class="se-head"><span class="centre-mark">${icon("bolt")}</span><div><h2>${esc(t("centre.title"))}</h2><p class="se-body">${esc(t("centre.body"))}</p></div></div>
      <div class="se-new"><button class="btn primary" data-new="centre">${icon("play")}${esc(t("centre.start"))}</button></div>
    </div>`);
    return;
  }
  const p = data.projects.find(x => x.n === key);
  if (!p) {
    setHtml(el, `<div class="se-box empty"><div class="empty-ico">${icon("terminal")}</div><h3>${esc(t("ws.pick.title"))}</h3><p>${esc(t("ws.pick.body"))}</p></div>`);
    return;
  }
  const view = getSessionView(key, (built.projects.find(x => x.n === key) || p).sessions);
  setSpaceHtml(el, `<div class="se-box">
    <div class="se-head"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
      <div><h2>${esc(p.name)}</h2>${pathHtml(p.path, [])}</div></div>
    <div class="se-new">
      <button class="btn" data-new="terminal" title="${esc(t("ws.newTerminalTitle"))}">${icon("terminal")}${esc(t("ws.newTerminal"))}</button>
      ${getInstalledAgents().map(a => `<button class="btn" data-new="${esc(a)}" title="${esc(t("ws.newAgentTitle", { agent: a, key: getNewAgentKey(a) }))}">${icon(`agent${a}`)}${esc(a)}</button>`).join("")}
    </div>
    ${view.all.length ? `<p class="se-label">${esc(t("ws.sessions"))}<span class="se-hint">${esc(t("ws.sessionsHint"))}</span></p>
    ${view.filterHtml}
    ${view.listed.map(getSessionRowHtml).join("")}
    ${view.notesHtml}` : ""}
  </div>`);
}
// What the Project sessions view lists of a project's sessions, newest first: those within the project's age filter,
// the hidden ones only when they are shown. A running session (isLive) is always listed. Also the view of a project
// of another computer (nodes-ui.js).
function getSessionView(key, sessions, isLive = s => Boolean(liveOf(s))) {
  const all = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const days = getSessionAge(key);
  const since = days ? Date.now() - days * DAY_MS : 0;
  const reveal = readHidden().reveal;
  const showHidden = reveal || hiddenShownIn.has(key);
  const isHidden = s => Boolean(s.concealed) && !isLive(s);
  const inAge = s => isLive(s) || (s.updatedAt || 0) >= since;
  const shown = all.filter(s => showHidden || !isHidden(s));
  return {
    all, isHidden,
    listed: shown.filter(inAge),
    filterHtml: getAgeFilterHtml(key, days),
    // With the hidden items revealed everywhere (the edge menu's eye) there is nothing to switch here.
    notesHtml: getListNotesHtml(shown.length - shown.filter(inAge).length, reveal ? 0 : all.filter(isHidden).length, hiddenShownIn.has(key))
  };
}
// The eye of a session's row, as the edge menu draws it: crossed out on a hidden one. None for a running session.
function getHideButtonHtml(hidden) {
  return `<button class="icon-btn" data-se="${hidden ? "unhide" : "hide"}" title="${esc(t(hidden ? "ws.unhide" : "ws.hide"))}">${icon(hidden ? "eyeOff" : "eye")}</button>`;
}
// Draws the view. A number being typed into the custom days field survives a redraw (a row's age or state changed).
function setSpaceHtml(el, html) {
  const field = el.querySelector('[data-se="days"]');
  const typed = field && document.activeElement === field ? field.value : null;
  if (!setHtml(el, html) || typed === null) return;
  const next = el.querySelector('[data-se="days"]');
  if (!next) return;
  next.value = typed;
  next.focus();
}
function getSessionRowHtml(s) {
  const hidden = s.concealed && !liveOf(s);
  const hideButton = liveOf(s) ? "" : getHideButtonHtml(hidden);
  return `<div class="se-row ${hidden ? "concealed" : ""}" data-key="${esc(sessionKey(s))}" tabindex="0">
      ${agentMark(s.agent)}<span class="se-title" title="${esc(s.title)}">${esc(s.title)}</span>${getContextChip(s)}${getLiveMark(s)}
      <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span>
      <span class="se-acts">${hideButton}${liveOf(s) ? `<button class="btn sm" data-action="show-terminal">${icon("raise")}${esc(t("term.show"))}</button>` : getSessionActions(s)}</span></div>`;
}
// All, 1 week, 1 month or a number of days of the user's own.
function getAgeFilterHtml(key, days) {
  const custom = !AGE_PRESETS.includes(days) || customAgeIn.has(key);
  const chips = AGE_PRESETS.map(d => `<button class="chip ${!custom && d === days ? "on" : ""}" data-se="age" data-days="${d}">${esc(t(`ws.age.${d}`))}</button>`).join("");
  const input = custom ? `<label class="se-days"><input type="number" min="1" max="3650" data-se="days" value="${days || ""}">${esc(t("ws.age.days"))}</label>` : "";
  return `<div class="se-filter"><div class="chips">${chips}<button class="chip ${custom ? "on" : ""}" data-se="custom">${esc(t("ws.age.custom"))}</button></div>${input}</div>`;
}
// What the list leaves out: older sessions, and the hidden ones with a switch to show them.
function getListNotesHtml(older, hiddenCount, shown) {
  const notes = [];
  if (older) {
    notes.push(`<span>${esc(t("ws.age.older", { n: older }))}</span>`);
  }
  if (hiddenCount) {
    notes.push(`<button class="link" data-se="show-hidden">${esc(t(shown ? "ws.hiddenHide" : "ws.hiddenShow", { n: hiddenCount }))}</button>`);
  }
  return notes.length ? `<p class="se-notes">${notes.join("")}</p>` : "";
}

// ---------- the Project sessions view's filters ----------
// Per project (its key): how many days back its sessions are listed, 0 for all - kept in localStorage. Per window, until
// it closes: the projects whose custom field is open and those whose hidden sessions are shown.
const SESSION_AGE_KEY = "agentdeck.sessionAge";
const AGE_PRESETS = [0, 7, 30];
const DAY_MS = 24 * 60 * 60 * 1000;
const customAgeIn = new Set();
const hiddenShownIn = new Set();
function readSessionAges() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_AGE_KEY)) || {};
  } catch {
    return {};
  }
}
let sessionAges = readSessionAges();
const getSessionAge = key => sessionAges[key] || 0;
function setSessionAge(key, days) {
  if (days) {
    sessionAges[key] = days;
  } else {
    delete sessionAges[key];
  }
  try {
    localStorage.setItem(SESSION_AGE_KEY, JSON.stringify(sessionAges));
  } catch {}
  render();
}
function setSessionHidden(key, on) {
  const h = readHidden();
  if (on) {
    h.sessions.add(key);
  } else {
    h.sessions.delete(key);
  }
  writeHidden(h);
  prepare();
  render();
}
// A click in the view's filters or on a row's eye; false when it was none of them.
function runSessionFilter(el, key) {
  const rowEl = el.closest("[data-key], [data-rkey]");
  const row = rowEl?.dataset.key || rowEl?.dataset.rkey;
  switch (el.dataset.se) {
    case "hide": setSessionHidden(row, true); return true;
    case "unhide": setSessionHidden(row, false); return true;
    case "age": customAgeIn.delete(key); setSessionAge(key, Number(el.dataset.days)); return true;
    case "custom": customAgeIn.add(key); render(); $("spaceEmpty").querySelector('[data-se="days"]')?.focus(); return true;
    case "show-hidden": if (!hiddenShownIn.delete(key)) hiddenShownIn.add(key); render(); return true;
    default: return false;
  }
}
// A running session's state (working, waiting for you, ready), as the agents list shows it.
function getLiveMark(s) {
  const l = liveOf(s);
  return l ? statusMark(l, isLoading(sessionKey(s), l)) : "";
}
// A menu for starting a terminal or agent in the shown space.
function openNewMenu(btn) {
  if (!getSpaceFolder(ws.activeSpace)) return;
  openMenu(btn, "", [
    { label: t("ws.newTerminal"), icon: "terminal", run: () => openInSpace("terminal") },
    ...getInstalledAgents().map(a => ({ label: a, icon: `agent${a}`, run: () => openInSpace(a) }))
  ]);
}
// The status bar's left end: the focused pane's folder and branch, and its session's context.
function renderFocusInfo() {
  const x = getTerminal(getShownTab()?.focus);
  const s = x && getTermSession(x);
  const html = x ? `<span class="fi-dir" title="${esc(x.cwd)}">${icon("folder")}<span>${esc(x.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop())}</span></span>` : "";
  const el = $("focusInfo");
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  $("status").hidden = false;
}
// workspace-ui.js: the layout changed - the shown space is the selected project.
function onWorkspaceChanged() {
  ui.selected = ws.activeSpace;
  renderSoon();
}

// ---------- actions ----------
// Messages stack above the status bar, the newest lowest. An error stays longer, can be closed, and waits while it is
// pointed at; the same message again only restarts its time. action: { label, run } for a button in the message.
const TOAST_MS = 2600, TOAST_ERROR_MS = 8000, TOASTS_MAX = 4, TOAST_OUT_MS = 180;
const getErrorText = msg => String(msg ?? "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
function toast(msg, isError = false, action = null) {
  const box = $("toasts"), text = isError ? getErrorText(msg) : String(msg ?? "");
  let el = [...box.children].find(x => x.dataset.text === text && !x.classList.contains("out"));
  if (!el) {
    el = document.createElement("div");
    el.className = `toast-item${isError ? " error" : ""}`;
    el.dataset.text = text;
    el.setAttribute("role", isError ? "alert" : "status");
    el.innerHTML = `<span class="toast-text">${esc(text)}</span>${action ? `<button class="toast-act" data-toast="act">${esc(action.label)}</button>` : ""}${isError || action ? `<button class="toast-x" data-toast="close" aria-label="${esc(t("common.close"))}">${icon("x")}</button>` : ""}`;
    const close = () => {
      clearTimeout(el.timer);
      el.classList.add("out");
      setTimeout(() => el.remove(), TOAST_OUT_MS);
    };
    el.start = () => { clearTimeout(el.timer); el.timer = setTimeout(close, isError || action ? TOAST_ERROR_MS : TOAST_MS); };
    el.addEventListener("click", e => {
      const kind = e.target.closest("[data-toast]")?.dataset.toast;
      if (!kind) return;
      close();
      if (kind === "act") Promise.resolve().then(action.run).catch(err => toast(err.message, true));
    });
    el.addEventListener("mouseenter", () => clearTimeout(el.timer));
    el.addEventListener("mouseleave", el.start);
    box.append(el);
    while (box.children.length > TOASTS_MAX) box.firstElementChild.remove();
  }
  el.start();
}
const setStatus = s => { $("status").textContent = s; $("status").title = s; };

function showSummary() {
  const byAgent = AGENTS.map(a => [a, data.sessions.filter(s => s.agent === a).length]).filter(([, n]) => n).map(([a, n]) => `${I18N.formatNumber(n)} ${a}`);
  setStatus(t("manager.status.summary", {
    sessions: tn("manager.status.sessions", data.sessions.length), agents: byAgent.join(" · ") || t("common.none"),
    projects: tn("manager.status.projects", data.projects.length), time: I18N.formatTime(Date.now())
  }));
  $("status").innerHTML = `<span class="summary-count">${icon("terminal")}${esc(I18N.formatNumber(data.sessions.length))}</span><span class="summary-count">${icon("folder")}${esc(I18N.formatNumber(data.projects.length))}</span>`;
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
    window.limitsUi?.refresh();
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
  allLive = mergeNodes(raw, live).live;
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
    const l = allLive.get(el.dataset.live);
    if (!l) return;
    el.className = getStatusClass(l);
    el.title = getStatusTitle(l);
  });
}

// key: a project's normalized path (its space comes up with all its sessions), or "g:<id>" for a group (it folds or
// opens). The command centre's space is its one terminal.
function selectProject(key) {
  if (key.startsWith("g:")) return toggleCollapsed(key.slice(2));
  ui.selected = key;
  render();
  runWorkspace("space", { space: key, sessions: key !== CENTRE });
}

// place: "tab" (a new tab of its project) or "right" (beside the focused pane).
async function resume(s, place = "tab") {
  if (showSessionTab(s, place)) return;
  if (!s?.cwd) return toast(t("errors.sessionNoDir"), true);
  // A session of another computer resumes there, in a pane here.
  if (s.node) {
    await window.manager.remoteLaunch(s.node, { kind: "resume", cwd: s.cwd, agent: s.agent, sessionId: s.id });
    return toast(t("manager.node.toast.opened", { node: s.nodeName || nodeNameOf(s.node) }));
  }
  const l = liveOf(s);
  if (l && !(await confirmDialog({ title: t("confirm.openAgain"), body: t("manager.confirm.openAgain", { pid: l.pid }) }))) return;
  await window.manager.launchAgent(s.agent, s.id, s.cwd, place);
  toast(t("manager.toast.resuming", { agent: s.agent, cwd: s.cwd }));
}
// A running session's terminal: in AgentDeck (on any computer) its pane here; outside it, this computer's window that
// has it - one on another computer cannot come here (a host that tells says so, an older one does not know).
async function showTerminal(s, place = "tab") {
  if (!s || showSessionTab(s, place)) return;
  if (s.node) return toast(t(getSessionTerm(s) === "" ? "manager.agents.outsideOn" : "manager.node.sessionThere", { node: s.nodeName || nodeNameOf(s.node) }));
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
  const p = data.projects.find(x => refOf(x) === path);
  if (p) applyRegistry(await window.manager.pinProject(path, isPinned(p) ? null : p.slot));
}
// Empty, or with the project at `path` in it; either way named right away (an empty one shows only without a search).
async function createGroup(path) {
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
  applyRegistry(raw.registry.order === "custom" ? await window.manager.sortProjectsByActivity() : await window.manager.restoreProjectOrder());
}

async function runAction(action, btn) {
  const path = btn.dataset.path || btn.closest("[data-path]")?.dataset.path;
  const groupId = btn.closest("[data-group]")?.dataset.group;
  const session = () => sessionByKey(btn.closest("[data-key]")?.dataset.key);
  // The project of the card: its folder, and the computer it is on when not this one.
  const p = path ? data.projects.find(x => refOf(x) === path) : null;
  const folder = p?.path || path;
  switch (action) {
    case "resume": return resume(session());
    case "fresh": await continueFresh(session()); return toast(t("preview.fresh.started"));
    case "show-terminal": return showTerminal(session());
    case "move-here": return moveSessionHere(session());
    case "terminal":
      if (p?.node) { await window.manager.remoteLaunch(p.node, { kind: "shell", cwd: p.path }); return toast(t("manager.node.toast.opened", { node: nodeNameOf(p.node) })); }
      await window.manager.launchFolder(folder); return toast(t("manager.toast.terminal", { path: folder }));
    case "explorer": { const err = await window.manager.openPath(folder); if (err) throw new Error(err); return; }
    case "copy": await window.manager.copyText(folder); return toast(t("toast.copied", { path: folder }));
    case "rename": ui.renaming = groupId ? "g:" + groupId : normPath(path); return render();
    case "pin": return pinProject(path, groupId);
    case "group-menu": return openOwnedMenu(btn, path, getGroupMenuItems(path));
    case "project-menu": return openProjectMenu(btn, path);
    case "agent-menu": return openRowMenu(btn, session());
    case "term-stop": return stopTerm(termOfRow(btn.closest("[data-key]")));
    case "ungroup": return applyRegistry(await window.manager.deleteGroup(groupId));
    case "fold": return toggleCollapsed(groupId);
    case "fold-device": return toggleDeviceFold(btn.closest("[data-device]").dataset.device);
    case "remove":
      if (!(await confirmDialog({ title: t("action.remove"), body: t("manager.confirm.remove", { path: folder }), danger: true }))) return;
      return applyRegistry(await window.manager.removeProject(path));
    case "subagents": {
      const key = btn.dataset.key;
      subagentsOpen.set(key, !isSubagentsOpen(key, allLive.get(key)?.subagents || []));
      return render();
    }
  }
}
async function onAction(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return false;
  e.stopPropagation();
  try { await runAction(btn.dataset.action, btn); } catch (err) { toast(err.message, true); }
  return true;
}

// ---------- events ----------
// $("refresh").addEventListener("click", load);
for (const [id, open] of [["voiceHistory", window.manager.openVoiceHistory], ["settings", window.manager.openSettings]]) {
  $(id).addEventListener("click", async () => { if (!(await open())) toast(t("manager.unavailable"), true); });
}
$("add").addEventListener("click", async () => {
  try { applyRegistry(await window.manager.addProject()); } catch (e) { toast(e.message, true); }
});
$("projects").addEventListener("click", async e => {
  if (e.target.classList.contains("rename") || await onAction(e)) return;
  const card = e.target.closest(".proj");
  if (card?.dataset.device) return toggleDeviceFold(card.dataset.device);
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
    if (e.target.dataset.device) toggleDeviceFold(e.target.dataset.device);
    else selectProject(getCardKey(e.target));
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
// Up and Down walk a list's rows, Home and End go to its ends (Alt+Up/Down moves a project instead).
function onListArrows(e) {
  if (e.altKey || e.ctrlKey || e.metaKey || !["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
  if (!e.target.matches(".proj, .agent, .se-row")) return;
  const rows = [...e.currentTarget.querySelectorAll(".proj[tabindex], .agent[tabindex], .se-row[tabindex]")];
  const i = rows.indexOf(e.target);
  const next = rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1)];
  e.preventDefault();
  next?.focus();
}
for (const id of ["projects", "agents", "terms", "spaceEmpty"]) $(id).addEventListener("keydown", onListArrows);
$("projectOrder").addEventListener("click", () => toggleOrder().catch(err => toast(err.message, true)));
$("newGroup").addEventListener("click", () => createGroup().catch(err => toast(err.message, true)));
$("projectView").addEventListener("click", toggleDeviceMode);
$("deviceChips").addEventListener("click", e => {
  const chip = e.target.closest("[data-device-filter]");
  if (chip) chooseDevice(chip.dataset.deviceFilter);
});

// ---------- projects: the group menu ----------
// Moves a project into another group (Move to a group, then the group), a new one, or out of its own.
function openMenu(btn, path, items) {
  closeGroupMenu();
  btn?.closest?.(".proj, .agent")?.classList.add("menu-open");
  const root = document.createElement("div");
  root.className = "menu";
  root.dataset.path = path;
  root.returnFocus = btn;
  root.setAttribute("role", "menu");
  document.body.append(root);
  groupMenu = root;
  menuLayers = [root];
  root.__root = root;
  renderMenuLayer(root, items);
  placeGroupMenu(btn);
  focusFirst(root);
}
function openGroupMenu(btn, path, items = getGroupMenuItems(path)) { openMenu(btn, path, items); }
// A project's menu closes when its project leaves the list (prepare); any other menu stays until the user closes it.
function openOwnedMenu(btn, path, items) {
  openMenu(btn, path, items);
  groupMenu.dataset.owner = "project";
}
// A project's menu: its folder, its place in the list and its group, its name; removing it. Also on a right-click.
function openProjectMenu(btn, path) {
  const p = data.projects.find(x => refOf(x) === path);
  if (!p) return;
  const pinned = isPinned(p);
  openOwnedMenu(btn, path, [
    { label: t("action.copyPath"), icon: "copy", run: async () => { await window.manager.copyText(p.path); toast(t("toast.copied", { path: p.path })); } },
    ...(p.group ? [] : [{ label: t("action.pin"), icon: "pin", checked: pinned, run: () => pinProject(path) }]),
    { separator: true },
    ...getGroupMenuItems(path),
    // Cloned on another computer, with a branch and an agent (clone-ui.js); a project of another computer stays there.
    ...(!p.node && onlineNodes().length ? [{ label: t("clone.menu"), icon: "nodes", items: onlineNodes().map(n => ({ label: n.name, icon: n.kind === "host" ? "terminal" : "window", run: () => openCloneDialog(path, n) })) }] : []),
    { separator: true },
    { label: t("action.rename"), icon: "pencil", run: async () => { ui.renaming = p.n; render(); } },
    { separator: true },
    { label: t("action.remove"), icon: "trash", danger: true, run: () => runAction("remove", btn) }
  ]);
}
// "Stop": a session in a terminal of AgentDeck (any agent, on any computer) stops that terminal, for every device
// (workspace-ui.js stopTerm). A Claude session that runs without one (in another terminal, or left behind by one that
// died, or a background job whose parent is gone) - here or on another computer - is ended there (launch.stopSession).
const getStopTerm = s => getSessionTerm(s) || findSessionTab(s)?.id || "";
const isStopOffered = s => Boolean(liveOf(s)) && (Boolean(getStopTerm(s)) || s.agent === "Claude");
function stopRunning(s) {
  const term = getStopTerm(s);
  return term ? stopTerm(term, { cwd: s.cwd, agent: s.agent, sessionId: s.id, title: s.title, node: s.node }) : stopSession(s);
}
async function stopSession(s) {
  const where = s.node ? s.nodeName || nodeNameOf(s.node) : t("term.thisComputer");
  if (!(await confirmDialog({ title: t("term.stop"), body: t("term.stopConfirm", { title: s.title, where }), danger: true }))) return;
  try { await window.manager.stopSession(s.node, s.agent, s.id); }
  catch (e) { return toast(e.message || e, true); }
  toast(t("term.stopped"));
  pollLive();
}
// A running session's menu (the agents list, on a right-click): bring it up or move it here, stop it, its id and folder.
function openRowMenu(btn, s) {
  if (!s) return;
  const copy = (text, msg) => async () => { await window.manager.copyText(text); toast(msg); };
  openMenu(btn, "", [
    { label: t("term.show"), icon: "raise", run: () => showTerminal(s) },
    ...(!s.node && liveOf(s) && isMoveHereOffered(s) ? [{ label: t("term.moveHere"), icon: "download", run: () => moveSessionHere(s) }] : []),    { label: t("manager.session.copyId"), icon: "copy", run: copy(s.id, t("manager.toast.copiedId", { id: s.id })) },
    ...(s.cwd && !s.node ? [
      { label: t("action.copyPath"), icon: "copy", run: copy(s.cwd, t("toast.copied", { path: s.cwd })) },
      { label: t("action.terminalHere"), icon: "terminal", run: async () => { await window.manager.launchFolder(s.cwd); toast(t("manager.toast.terminal", { path: s.cwd })); } },
      { label: t("action.explorerTitle"), icon: "open", run: async () => { const err = await window.manager.openPath(s.cwd); if (err) throw new Error(err); } }
    ] : []),
    ...(isStopOffered(s) ? [{ separator: true }, { label: t("term.stop"), icon: "stop", danger: true, run: () => stopRunning(s) }] : [])
  ]);
}
function getGroupMenuItems(path) {
  const own = getGroupOf(path);
  const targets = data.groups.filter(g => g.id !== own).map(g => ({ label: g.name, icon: "stack", run: () => moveToGroup(path, g.id) }));
  return [
    ...(targets.length ? [{ label: t("manager.projectGroup.move"), icon: "stack", items: targets }] : []),
    { label: t("manager.projectGroup.create"), icon: "groupAdd", run: () => createGroup(path) },
    ...(own ? [{ label: t("manager.projectGroup.leave"), icon: "x", run: () => leaveGroup(path) }] : [])
  ];
}
// One menu layer. An item with `items` opens a flyout beside the menu on hover (and on click), as Source Control does.
function renderMenuLayer(menu, items) {
  menu.__items = items;
  menu.innerHTML = items.map((x, i) => x.separator
    ? '<div class="menu-sep" role="separator"></div>'
    : `<button role="${x.checked !== undefined ? "menuitemcheckbox" : "menuitem"}" data-i="${i}" ${x.danger ? 'class="danger"' : ""} ${x.items ? 'aria-haspopup="menu"' : ""} ${x.checked ? 'aria-checked="true"' : ""} ${x.disabled ? "disabled" : ""}>
    ${icon(x.icon)}<span>${esc(x.label)}</span>${x.checked ? `<span class="menu-check">${icon("check")}</span>` : ""}${x.items ? icon("right") : ""}</button>`).join("");
  menu.onclick = e => {
    const button = e.target.closest("[data-i]");
    if (!button) return;
    const x = items[Number(button.dataset.i)];
    if (!x || x.disabled) return;
    if (x.items) return openSubMenu(menu, button, x.items, true);
    closeGroupMenu();
    Promise.resolve().then(() => x.run()).catch(err => toast(err.message, true));
  };
  // Each item opens its flyout as the pointer reaches it, as Source Control does.
  for (const button of menu.querySelectorAll("button[data-i]")) {
    button.addEventListener("mouseenter", () => {
      const x = items[Number(button.dataset.i)];
      if (!x || x.disabled) return;
      if (!x.items) return closeDescendants(menu);
      if (menu.__sub?.__anchor === button) return;
      openSubMenu(menu, button, x.items);
    });
  }
}
function openSubMenu(parent, button, items, shouldFocus = false) {
  closeDescendants(parent);
  const sub = document.createElement("div");
  sub.className = "menu menu-sub";
  if (parent.__root.classList.contains("git-context-menu")) sub.classList.add("git-context-menu");
  sub.setAttribute("role", "menu");
  sub.__root = parent.__root;
  sub.__parent = parent;
  sub.__anchor = button;
  parent.__sub = sub;
  document.body.append(sub);
  menuLayers.push(sub);
  renderMenuLayer(sub, items);
  placeSubMenu(sub, parent, button);
  if (shouldFocus) focusFirst(sub);
}
function placeGroupMenu(btn) {
  const r = btn.getBoundingClientRect();
  const below = r.bottom + groupMenu.offsetHeight + 4 <= window.innerHeight;
  groupMenu.style.top = (below ? r.bottom + 4 : r.top - groupMenu.offsetHeight - 4) + "px";
  groupMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - groupMenu.offsetWidth - 8)) + "px";
}
function placeSubMenu(sub, parent, button) {
  const p = parent.getBoundingClientRect(), r = button.getBoundingClientRect(), gap = 2;
  const width = sub.offsetWidth, height = sub.offsetHeight;
  const left = p.right + gap + width <= window.innerWidth - 8 ? p.right + gap : p.left - width - gap;
  const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - height - 8));
  sub.style.top = top + "px";
  sub.style.left = Math.max(8, left) + "px";
}
function focusFirst(menu) { menu.querySelector("button:not(:disabled)")?.focus(); }
function closeLayer(menu) {
  if (menu.__parent?.__sub === menu) menu.__parent.__sub = null;
  if (menu.__sub) { const sub = menu.__sub; menu.__sub = null; closeLayer(sub); }
  const i = menuLayers.indexOf(menu);
  if (i >= 0) menuLayers.splice(i, 1);
  menu.remove();
}
function closeDescendants(menu) {
  if (!menu.__sub) return;
  const sub = menu.__sub; menu.__sub = null; closeLayer(sub);
}
function closeGroupMenu() {
  for (const layer of menuLayers) layer.remove();
  menuLayers = [];
  groupMenu = null;
  for (const el of document.querySelectorAll(".menu-open")) el.classList.remove("menu-open");
}
document.addEventListener("mousedown", e => {
  if (groupMenu && !menuLayers.some(menu => menu.contains(e.target))) closeGroupMenu();
}, true);
document.addEventListener("keydown", e => {
  if (!groupMenu) return;
  let layer = groupMenu;
  for (const menu of menuLayers) if (menu.contains(document.activeElement)) layer = menu;
  if (e.key === "Escape") {
    e.stopPropagation();
    if (menuLayers.length > 1) {
      const deepest = menuLayers[menuLayers.length - 1], anchor = deepest.__anchor;
      closeLayer(deepest);
      anchor?.focus();
      return;
    }
    const path = groupMenu.dataset.path;
    const returnFocus = groupMenu.returnFocus;
    closeGroupMenu();
    if (returnFocus?.isConnected) returnFocus.focus();
    else [...document.querySelectorAll(".proj[data-path]")].find(el => el.dataset.path === path)?.querySelector("[data-action=project-menu]")?.focus();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    const all = [...layer.querySelectorAll("button:not(:disabled)")];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1);
    all[(i + all.length) % all.length]?.focus();
    return;
  }
  if (e.key === "ArrowRight") {
    const button = document.activeElement?.closest?.("[data-i]");
    const x = button && layer.__items?.[Number(button.dataset.i)];
    if (x?.items) { e.preventDefault(); e.stopPropagation(); openSubMenu(layer, button, x.items, true); }
    return;
  }
  if (e.key === "ArrowLeft" && menuLayers.length > 1) {
    e.preventDefault();
    e.stopPropagation();
    const deepest = menuLayers[menuLayers.length - 1], anchor = deepest.__anchor;
    closeLayer(deepest);
    anchor?.focus();
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
$("agents").addEventListener("click", async e => {
  if (await onAction(e)) return;
  const row = e.target.closest(".agent");
  if (row) showTerminal(sessionByKey(row.dataset.key)).catch(err => toast(err.message, true));
});
$("agents").addEventListener("contextmenu", e => {
  const row = e.target.closest(".agent");
  if (!row) return;
  e.preventDefault();
  openRowMenu(row, sessionByKey(row.dataset.key));
});
// Enter brings a running session's terminal up; the Menu key (or Shift+F10) opens its menu.
$("agents").addEventListener("keydown", e => {
  if (!e.target.classList.contains("agent")) return;
  const s = sessionByKey(e.target.dataset.key);
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showTerminal(s).catch(err => toast(err.message, true)); }
  if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); openRowMenu(e.target, s); }
});
// A terminal row: brought up here (its pane, or a new one); its Stop button ends it for everyone.
$("terms").addEventListener("click", async e => {
  if (await onAction(e)) return;
  const term = termOfRow(e.target.closest(".agent"));
  if (term) openTerm(term);
});
$("terms").addEventListener("keydown", e => {
  const term = termOfRow(e.target);
  if (term && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openTerm(term); }
});
// A row dragged onto a pane or the tab bar opens its terminal there (workspace-ui.js startTermDrag).
for (const id of ["agents", "terms"]) {
  $(id).addEventListener("dragstart", e => {
    const row = e.target.closest?.(".agent[draggable]");
    if (!row) return;
    const term = termOfRow(row) || getAgentTerm(sessionByKey(row.dataset.key));
    if (term) startTermDrag(term, e);
    else e.preventDefault(); // its terminal went since the row was drawn
  });
  $(id).addEventListener("dragend", endDrag);
}
$("centre").addEventListener("click", () => selectProject(CENTRE));
$("centre").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectProject(CENTRE); } });
$("spaceEmpty").addEventListener("click", async e => {
  const make = e.target.closest("[data-new]");
  if (make?.dataset.new === "centre") return window.manager.centreStart().catch(err => toast(err.message, true));
  if (make) return openInSpace(make.dataset.new === "terminal" ? "terminal" : make.dataset.new);
  const filter = e.target.closest("button[data-se]");
  if (filter) {
    e.stopPropagation();
    runSessionFilter(filter, ws.activeSpace);
    return;
  }
  if (await onAction(e)) return;
  const row = e.target.closest(".se-row");
  if (row && e.detail === 2) openSession(sessionByKey(row.dataset.key)).catch(err => toast(err.message, true));
});
// The custom number of days: taken once typed in, 1 to 3650.
$("spaceEmpty").addEventListener("change", e => {
  if (e.target.dataset.se !== "days") return;
  const days = Math.round(Number(e.target.value));
  if (days >= 1 && days <= 3650) setSessionAge(ws.activeSpace, days);
});
$("spaceEmpty").addEventListener("keydown", e => {
  if (e.key !== "Enter" || !e.target.classList.contains("se-row") || !e.target.dataset.key) return;
  e.preventDefault();
  openSession(sessionByKey(e.target.dataset.key)).catch(err => toast(err.message, true));
});

// F5 scans again; "/" outside a terminal or a field opens the search.
document.addEventListener("keydown", e => {
  if (e.target.closest?.(".term-host") || e.target.matches?.("input, textarea, select")) return;
  if (e.key === "F5") { e.preventDefault(); load(); return; }
  if (e.key === "/") { e.preventDefault(); window.searchPalette.open(); }
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
  if (ui.renaming) pendingRender = true; else render();
});
// Git branches beside projects and session folders, and a session's last messages on hover (git-ui.js, preview-ui.js).
watchGit(() => { if (!ui.loaded) return; if (ui.renaming) pendingRender = true; else render(); });

// ---------- dividers: dragged, moved with the arrow keys, reset by a double-click ----------
// projects | sessions sets --projects-w on <main>; projects / agents sets --agents-h and agents / terminals --terms-h on
// the overview. Kept in localStorage. MIN_PROJECTS_H_PX: the projects section's CSS min-height (styles.css).
const MIN_PROJECTS_PX = 200, MIN_SESSIONS_PX = 420, MIN_PROJECTS_H_PX = 120, MIN_AGENTS_PX = 80, MIN_TERMS_PX = 80, SPLITTER_STEP_PX = 16;
const getMain = () => document.querySelector("main");
const getOverview = () => $("sideOverview");
const PROJECTS_SPLIT = { getHost: getMain, prop: "--projects-w", key: "agentdeck.projectsWidth" };
const AGENTS_SPLIT = { getHost: getOverview, prop: "--agents-h", key: "agentdeck.agentsHeight" };
const TERMS_SPLIT = { getHost: getOverview, prop: "--terms-h", key: "agentdeck.termsHeight" };
function setSplit(split, px) {
  split.getHost().style.setProperty(split.prop, `${px}px`);
  try {
    localStorage.setItem(split.key, String(px));
  } catch {}
}
function resetSplit(split) {
  split.getHost().style.removeProperty(split.prop);
  try {
    localStorage.removeItem(split.key);
  } catch {}
}
function restoreSplit(split) {
  let px = 0;
  try {
    px = Number(localStorage.getItem(split.key));
  } catch {}
  if (px > 0) split.getHost().style.setProperty(split.prop, `${px}px`);
}
function watchSplitter(splitter, getSize, setSize, reset, keySteps) {
  splitter.addEventListener("pointerdown", e => {
    const move = ev => setSize(getSize(ev));
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("lostpointercapture", () => splitter.removeEventListener("pointermove", move), { once: true });
  });
  splitter.addEventListener("dblclick", reset);
  splitter.addEventListener("keydown", e => {
    const step = keySteps[e.key];
    if (step) {
      e.preventDefault();
      setSize(getSize(null, step));
    }
  });
}

function getProjectsWidth(ev, step = 0) {
  const side = document.querySelector("main > .side").getBoundingClientRect();
  const projects = (ev ? ev.clientX : side.right + step) - side.left;
  return Math.round(Math.max(MIN_PROJECTS_PX, Math.min(projects, getMain().getBoundingClientRect().width - MIN_SESSIONS_PX)));
}
const setProjectsWidth = px => setSplit(PROJECTS_SPLIT, px);
const resetProjectsWidth = () => resetSplit(PROJECTS_SPLIT);
watchSplitter($("splitter"), getProjectsWidth, setProjectsWidth, resetProjectsWidth, { ArrowLeft: -SPLITTER_STEP_PX, ArrowRight: SPLITTER_STEP_PX });
restoreSplit(PROJECTS_SPLIT);

// A section below the projects (agents, terminals) and the line above it: the line moves only the section's top - its
// bottom stays, the sections below keep their heights and the projects give or take the difference, so it grows at
// most by what the projects have above their minimum.
function watchSectionSplitter(splitter, section, split, min) {
  const getHeight = (ev, step = 0) => {
    const rect = section.getBoundingClientRect(), projects = $("sideProjects").getBoundingClientRect().height;
    const height = ev ? rect.bottom - ev.clientY : rect.height + step;
    return Math.round(Math.max(min, Math.min(height, rect.height + projects - MIN_PROJECTS_H_PX)));
  };
  watchSplitter(splitter, getHeight, px => setSplit(split, px), () => resetSplit(split), { ArrowUp: SPLITTER_STEP_PX, ArrowDown: -SPLITTER_STEP_PX });
  restoreSplit(split);
}
watchSectionSplitter($("sideSplitter"), $("sideAgents"), AGENTS_SPLIT, MIN_AGENTS_PX);
watchSectionSplitter($("termsSplitter"), $("sideTerms"), TERMS_SPLIT, MIN_TERMS_PX);

load();
setInterval(pollLive, 2000);
