// The other computers in the manager window: each paired node's projects below this computer's in the sidebar, its
// running sessions in the agents list, and a read-only panel in the centre for a remote project chosen there. What
// main pushes ("mesh:nodes") is each node with its last list, live status and git as it sent them; buildData
// (common.js) turns a node's list into projects and sessions the way it does for this computer's. Loaded before
// renderer.js, which calls nodesHtml(), remoteAgentsHtml() and renderRemoteSpace() and renders again on
// onNodesChanged. Uses $, esc, icon, t, tn, buildData, sessionKey, statusMark, agentMark, hue, initials, ago,
// fullDate, pathHtml and countLiveGroups from common.js.
const REMOTE_KEY = "node:"; // a remote project's space key: node:<id>:<project path, normalized>
let nodes = []; // [{ id, name, kind, status, data, live, git, view: { projects, sessions }, liveMap }]
const nodeNameOf = id => getNode(id)?.name || id.slice(0, 8);
// The other computers' sessions and live states beside this computer's, for one list of projects and agents
// (renderer.js prepare): each session carries its node, and its folder key is the project's space key there.
function mergeNodes(raw, live) {
  const sessions = [...(raw.sessions || []), ...nodes.flatMap(n => (n.data?.sessions || []).map(s => ({ ...s, node: n.id, nodeName: n.name })))];
  const merged = new Map(live);
  for (const n of nodes) for (const l of n.liveMap.values()) {
    const state = { ...l, node: n.id, nodeName: n.name };
    merged.set(sessionKey(state), state);
  }
  return { raw: { ...raw, sessions }, live: merged };
}

// A phone (kind "mobile") is no computer: main leaves phones out, and so does this list should one come.
function setNodes(list) {
  nodes = (list || []).filter(n => n?.kind !== "mobile").map(n => {
    const liveMap = new Map((n.status === "online" ? n.live || [] : []).map(l => [sessionKey(l), l]));
    const view = n.data ? buildData(n.data, liveMap) : { projects: [], sessions: [], groups: [] };
    return { ...n, view, liveMap };
  });
}
const getNode = id => nodes.find(n => n.id === id) || null;
const onlineNodes = () => nodes.filter(n => n.status === "online");
const remoteKey = (id, n) => `${REMOTE_KEY}${id}:${n}`;
function parseRemoteKey(key) {
  if (typeof key !== "string" || !key.startsWith(REMOTE_KEY)) return null;
  const rest = key.slice(REMOTE_KEY.length);
  const at = rest.indexOf(":");
  return at < 0 ? null : { id: rest.slice(0, at), n: rest.slice(at + 1) };
}
const nodeLabel = n => `${n.name || n.id.slice(0, 8)}${n.status === "online" ? "" : ` · ${t("manager.node.offline")}`}`;

// Running sessions of a node, those that need the user first (as the agents list orders this computer's).
function remoteRunning(n) {
  return n.view.sessions.filter(s => n.liveMap.has(sessionKey(s)))
    .sort((a, b) => getLiveRank(n.liveMap.get(sessionKey(a))) - getLiveRank(n.liveMap.get(sessionKey(b))));
}
function remoteLive(n, sessions) {
  const states = sessions.map(s => n.liveMap.get(sessionKey(s))).filter(Boolean);
  if (!states.length) return "";
  const { busy, waiting, idle } = countLiveGroups(states);
  return `<span class="proj-live">${waiting ? `<span class="pulse attn"></span>${waiting}` : ""}${busy ? `<span class="spinner"></span>${busy}` : ""}${idle ? `<span class="pulse"></span>${idle}` : ""}</span>`;
}

// ---------- the centre: a remote project ----------
// Its name, folder and computer, a terminal or an agent session to open there (in a pane here), and its latest
// sessions as seen from there, to resume there.
const remoteAgents = n => (n.data?.agents?.length ? n.data.agents : AGENTS);
function renderRemoteSpace(el, key) {
  const r = parseRemoteKey(key);
  if (!r) return false;
  const n = getNode(r.id);
  const p = (typeof data !== "undefined" ? data.projects.find(x => x.n === key) : null) || n?.view.projects.find(x => x.n === r.n);
  if (!p) {
    setHtml(el, `<div class="se-box empty"><h3>${esc(t("ws.pick.title"))}</h3><p>${esc(t("manager.node.gone"))}</p></div>`);
    return true;
  }
  const online = n?.status === "online";
  // The project as the lists have it (hidden sessions too, each marked), so its sessions hide and filter by age as
  // this computer's do; until the lists have it, as the computer sent it.
  const listedProject = typeof built !== "undefined" ? built.projects.find(x => x.n === key) : null;
  const view = getSessionView(key, (listedProject || p).sessions, s => Boolean(liveOf(s) || n?.liveMap.get(sessionKey(s))));
  setSpaceHtml(el, `<div class="se-box">
    <div class="se-head"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
      <div><h2>${esc(p.name)}</h2>${pathHtml(p.path, [])}<p class="se-body">${esc(t(online ? "manager.node.on" : "manager.node.offlineBody", { node: n?.name || r.id.slice(0, 8) }))}</p></div></div>
    ${online ? `<div class="se-new">
      <button class="btn" data-rnew="shell" title="${esc(t("ws.newTerminalTitle"))}">${icon("terminal")}${esc(t("ws.newTerminal"))}</button>
      ${remoteAgents(n).map(a => `<button class="btn" data-rnew="${esc(a)}">${icon(`agent${a}`)}${esc(a)}</button>`).join("")}
    </div>` : ""}
    ${view.all.length ? `<p class="se-label">${esc(t("ws.sessions"))}</p>
    ${view.filterHtml}
    ${view.listed.map(s => `<div class="se-row remote ${view.isHidden(s) ? "concealed" : ""}" data-rkey="${esc(sessionKey(s))}">
      ${agentMark(s.agent)}<span class="se-title" title="${esc(s.title)}">${esc(s.title)}</span>
      ${getContextChip({ ...s, node: r.id })}
      <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span>
      ${listedProject && !liveOf(s) && !n?.liveMap.get(sessionKey(s)) ? `<span class="se-acts">${getHideButtonHtml(view.isHidden(s))}</span>` : ""}${remoteSessionActs(n, s, online)}</div>`).join("")}
    ${view.notesHtml}` : ""}
  </div>`);
  el.onclick = e => n && onRemoteSpaceClick(e, n, listedProject || p).catch(err => toast(err.message || err, true));
  return true;
}
// A session's state and what can be done with it there: a running one in a terminal of AgentDeck there comes up in a
// pane here (whichever device opened it); one that runs nowhere is resumed there.
function remoteSessionActs(n, s, online) {
  const l = n?.liveMap.get(sessionKey(s));
  if (l) return `${l.term ? `<span class="se-acts"><button class="btn sm" data-rshow="${esc(sessionKey(s))}">${icon("raise")}${esc(t("term.show"))}</button></span>` : ""}${statusMark(l, false)}`;
  return online && s.cwd ? `<span class="se-acts"><button class="btn sm" data-rresume="${esc(sessionKey(s))}">${icon("play")}${esc(t("action.resume"))}</button></span>` : "";
}
// A terminal, a new agent session or a resumed one on the node, placed in a new tab of this space (main does both).
async function onRemoteSpaceClick(e, n, p) {
  if (e.target.closest("[data-se]")) return; // the age filter and a row's eye: renderer.js runSessionFilter
  const make = e.target.closest("[data-rnew]"), resumeBtn = e.target.closest("[data-rresume]"), showBtn = e.target.closest("[data-rshow]");
  if (showBtn) {
    const s = p.sessions.find(x => sessionKey(x) === showBtn.dataset.rshow);
    if (s) showSessionTab({ ...s, node: n.id, nodeName: n.name });
    return;
  }
  if (make) {
    const kind = make.dataset.rnew;
    await window.manager.remoteLaunch(n.id, kind === "shell" ? { kind: "shell", cwd: p.path } : { kind: "new", cwd: p.path, agent: kind });
  } else if (resumeBtn) {
    const s = p.sessions.find(x => sessionKey(x) === resumeBtn.dataset.rresume);
    if (!s) return;
    await window.manager.remoteLaunch(n.id, { kind: "resume", cwd: s.cwd, agent: s.agent, sessionId: s.id });
  } else {
    const row = e.target.closest("[data-rkey]");
    const s = row && p.sessions.find(x => sessionKey(x) === row.dataset.rkey);
    if (s && e.detail === 2) await openSession({ ...s, node: n.id, nodeName: n.name });
    return;
  }
  toast(t("manager.node.toast.opened", { node: n.name }));
}

// The other computers' sessions and live states are part of the lists (prepare), so a change there - a session
// that started working or finished - is worked in, not only drawn again.
function applyNodes(list) {
  setNodes(list);
  if (typeof prepare !== "function" || typeof renderSoon !== "function") return;
  if (ui.loaded && !ui.loading) prepare();
  renderSoon();
}
window.manager.onNodesChanged(applyNodes);
window.manager.getNodes().then(applyNodes).catch(() => {});
