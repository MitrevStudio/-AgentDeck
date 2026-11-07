// The other computers in the manager window: each paired node's projects below this computer's in the sidebar, its
// running sessions in the agents list, and a read-only panel in the centre for a remote project chosen there. What
// main pushes ("mesh:nodes") is each node with its last list, live status and git as it sent them; buildData
// (common.js) turns a node's list into projects and sessions the way it does for this computer's. Loaded before
// renderer.js, which calls nodesHtml(), remoteAgentsHtml() and renderRemoteSpace() and renders again on
// onNodesChanged. Uses $, esc, icon, t, tn, buildData, sessionKey, statusMark, agentMark, hue, initials, ago,
// fullDate, pathHtml and countLiveGroups from common.js.
const REMOTE_KEY = "node:"; // a remote project's space key: node:<id>:<project path, normalized>
let nodes = []; // [{ id, name, kind, status, data, live, git, view: { projects, sessions }, liveMap }]
// The tab shown above the projects: "" for this computer, else a paired computer's id (kept across restarts).
const NODE_TAB_KEY = "agentdeck.nodeTab";
let shownNode = (() => { try { return localStorage.getItem(NODE_TAB_KEY) || ""; } catch { return ""; } })();
function showNodeTab(id) {
  shownNode = id;
  try { localStorage.setItem(NODE_TAB_KEY, id); } catch {}
  if (typeof render === "function") render();
}
const shownNodeId = () => (getNode(shownNode) ? shownNode : "");
// The tabs: only when a computer is paired. This computer first, then each paired one with its state.
function nodeTabsHtml() {
  if (!nodes.length) return "";
  const shown = shownNodeId();
  return [`<button class="${shown ? "" : "on"}" data-node-tab="">${icon("window")}<span>${esc(t("manager.nodes.thisComputer"))}</span></button>`,
    ...nodes.map(n => `<button class="${shown === n.id ? "on" : ""} ${n.status}" data-node-tab="${esc(n.id)}" title="${esc(nodeLabel(n))}">${icon(n.kind === "host" ? "terminal" : "nodes")}<span>${esc(n.name || n.id.slice(0, 8))}</span><span class="dot"></span></button>`)
  ].join("");
}
function renderNodeTabs() {
  const el = $("nodeTabs");
  const html = nodeTabsHtml();
  if (el.dataset.html !== html) { el.dataset.html = html; el.innerHTML = html; }
  el.hidden = !html;
}

function setNodes(list) {
  nodes = (list || []).map(n => {
    const liveMap = new Map((n.live || []).map(l => [sessionKey(l), l]));
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
// How many tabs are open in a remote project's space here (workspace-ui.js's ws).
function remoteTabsHtml(key) {
  const count = typeof ws === "object" ? ws.spaces[key]?.tabs.length || 0 : 0;
  return count ? `<span class="proj-tabs" title="${esc(tn("ws.tabCount", count))}">${icon("terminal")}${count}</span>` : "";
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

// ---------- the sidebar ----------
// Each node: a header with its name and state, then its projects (by activity; a remote project has no menu, no
// drag and no git here).
function nodesHtml(selected, only = "") {
  return nodes.filter(n => !only || n.id === only).map(n => {
    const projects = n.view.projects;
    const head = `<div class="proj node-head ${n.status}" data-node="${esc(n.id)}" title="${esc(`${n.name}\n${n.address || ""}`)}">
      <div class="proj-row">${icon(n.kind === "host" ? "terminal" : "nodes")}<span class="proj-name">${esc(nodeLabel(n))}</span>
        <span class="count">${projects.length}</span></div></div>`;
    return head + projects.map(p => `
      <div class="proj remote member ${selected === remoteKey(n.id, p.n) ? "active" : ""}" data-node="${esc(n.id)}" data-remote="${esc(p.n)}" tabindex="0" title="${esc(`${p.name}\n${p.path}\n${n.name}`)}">
        <div class="proj-row"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
          <span class="proj-name">${esc(p.name)}</span>${remoteLive(n, p.sessions)}
          ${remoteTabsHtml(remoteKey(n.id, p.n))}<span class="count">${p.sessions.length}</span></div></div>`).join("");
  }).join("");
}
// The nodes' running sessions after this computer's, each group headed by the node's name.
function remoteAgentsHtml() {
  let html = "";
  for (const n of nodes) {
    const running = remoteRunning(n);
    if (!running.length) continue;
    html += `<div class="agroup">${esc(nodeLabel(n))}</div>`;
    for (const s of running) {
      const l = n.liveMap.get(sessionKey(s));
      const project = n.view.projects.find(p => p.sessions.includes(s))?.name || s.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      html += `<div class="agent remote" title="${esc(`${s.title}\n${s.cwd}\n${n.name}`)}">${agentMark(s.agent)}
        <div class="agent-main"><div class="agent-title">${esc(s.title)}</div><div class="agent-sub">${esc(project)} · ${esc(n.name)}</div></div>
        ${statusMark(l, false)}</div>`;
    }
  }
  return html;
}
const remoteAgentCount = () => nodes.reduce((sum, n) => sum + remoteRunning(n).length, 0);

// ---------- the centre: a remote project ----------
// Its name, folder and computer, a terminal or an agent session to open there (in a pane here), and its latest
// sessions as seen from there, to resume there.
const REMOTE_RECENT = 8;
const remoteAgents = n => (n.data?.agents?.length ? n.data.agents : AGENTS);
function renderRemoteSpace(el, key) {
  const r = parseRemoteKey(key);
  if (!r) return false;
  const n = getNode(r.id);
  const p = n?.view.projects.find(x => x.n === r.n);
  if (!p) {
    el.innerHTML = `<div class="se-box empty"><h3>${esc(t("ws.pick.title"))}</h3><p>${esc(t("manager.node.gone"))}</p></div>`;
    return true;
  }
  const online = n.status === "online";
  const recent = [...p.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, REMOTE_RECENT);
  el.innerHTML = `<div class="se-box">
    <div class="se-head"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
      <div><h2>${esc(p.name)}</h2>${pathHtml(p.path, [])}<p class="se-body">${esc(t(online ? "manager.node.on" : "manager.node.offlineBody", { node: n.name || n.id.slice(0, 8) }))}</p></div></div>
    ${online ? `<div class="se-new">
      <button class="btn" data-rnew="shell" title="${esc(t("ws.newTerminalTitle"))}">${icon("terminal")}${esc(t("ws.newTerminal"))}</button>
      ${remoteAgents(n).map(a => `<button class="btn" data-rnew="${esc(a)}">${icon(`agent${a}`)}${esc(a)}</button>`).join("")}
    </div>` : ""}
    ${recent.length ? `<p class="se-label">${esc(t("ws.recent"))}</p>${recent.map(s => `<div class="se-row remote" data-rkey="${esc(sessionKey(s))}">
      ${agentMark(s.agent)}<span class="se-title" title="${esc(s.title)}">${esc(s.title)}</span>
      <span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span>
      ${n.liveMap.has(sessionKey(s)) ? statusMark(n.liveMap.get(sessionKey(s)), false) : online && s.cwd ? `<span class="se-acts"><button class="btn sm" data-rresume="${esc(sessionKey(s))}">${icon("play")}${esc(t("action.resume"))}</button></span>` : ""}</div>`).join("")}` : ""}
  </div>`;
  el.onclick = e => onRemoteSpaceClick(e, n, p).catch(err => toast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), true));
  return true;
}
// A terminal, a new agent session or a resumed one on the node, placed in a new tab of this space (main does both).
async function onRemoteSpaceClick(e, n, p) {
  const make = e.target.closest("[data-rnew]"), resumeBtn = e.target.closest("[data-rresume]");
  if (make) {
    const kind = make.dataset.rnew;
    await window.manager.remoteLaunch(n.id, kind === "shell" ? { kind: "shell", cwd: p.path } : { kind: "new", cwd: p.path, agent: kind });
  } else if (resumeBtn) {
    const s = p.sessions.find(x => sessionKey(x) === resumeBtn.dataset.rresume);
    if (!s) return;
    await window.manager.remoteLaunch(n.id, { kind: "resume", cwd: s.cwd, agent: s.agent, sessionId: s.id });
  } else return;
  toast(t("manager.node.toast.opened", { node: n.name }));
}

$("nodeTabs").addEventListener("click", e => {
  const b = e.target.closest("[data-node-tab]");
  if (b) showNodeTab(b.dataset.nodeTab);
});
window.manager.onNodesChanged(list => {
  setNodes(list);
  if (typeof renderSoon === "function") renderSoon();
});
window.manager.getNodes().then(list => { setNodes(list); if (typeof renderSoon === "function") renderSoon(); }).catch(() => {});
