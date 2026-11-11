// The desktop's side of the shared terminals (docs/SHARED-SESSIONS.md 5): what main.js shows its window of the
// terminals of this computer and of the paired ones, which of this computer's terminals the window views, how the
// saved layout comes back after a start, and which computer a terminal id belongs to. Pure functions: main.js keeps
// the state and does the calls; scripts/test-desktop-terminals.js tests these.
//
// Who is who: on this computer's host the window is the viewer "" (host/index.js host.tabs()); on another computer's
// host it is this node's id (links.self().id), as mesh/serve.js tells it there. A tab of another computer comes with
// its names filled in by that computer; one of this computer with none (main fills them from the paired nodes).
const { normPath } = require("./shared/util");

// A name to show for a node id: the paired node's, else the id's first characters - never "", which would mean nobody.
const nameOr = (names, id) => names.get(id) || String(id || "").slice(0, 8) || "?";

// The size of a terminal as the window gets it (attach, terminal:size): { cols, rows, mine, by }. me: who the window is
// on that host ("" here, this node's id elsewhere); nameOf(who): the name of a viewer of that host. by is "" exactly
// when nobody drives (the pane fits itself); mine says the window drives (by is then this computer's name).
function sizeView(s, me, nameOf) {
  const driver = s?.driver ?? null;
  return { cols: s?.cols, rows: s?.rows, mine: driver !== null && driver === me, by: driver === null ? "" : nameOf(driver) || "?" };
}

// The terminals of the window's view (5.3): every terminal of this computer, every one of the online computers, and
// those with a pane here on computers that are away. Each: the Tab's fields (4.2) and node ("" here), paned (a pane
// here), viewers [{ id, name, kind, me }], driver { name, me } | null, ownerName ("" when this computer opened it),
// reopened, title (with " · computer" for another computer's), note, legacy (a host without terminals: 2: no viewers,
// no size of another device).
//   local: host.tabs(); paned: Set of the terminal ids with a pane here; self: { id, name } of this node (id "" while
//   the mesh is off); names: Map node id -> name (the paired nodes, phones too); nodes: [{ id, name, online, legacy,
//   tabs }] the paired computers, tabs their last list (null before it came); remoteTerms: Map id -> what is known of a
//   terminal of another computer with a pane here ({ id, node, cwd, title, agent, sessionId, exited, createdAt });
//   offline: the note of a pane whose computer is away; cleared: Set of ids whose "reopened" was seen to (typed into).
function composeView({ local = [], paned = new Set(), self = { id: "", name: "" }, names = new Map(), nodes = [], remoteTerms = new Map(), offline = "", cleared = new Set() }) {
  const selfName = self.name || nameOr(names, self.id);
  const nameHere = who => (who === "" ? selfName : nameOr(names, who));
  const out = local.map(x => ({
    ...x, node: "", paned: paned.has(x.id), legacy: false,
    ownerName: x.owner ? names.get(x.owner) || "" : "",
    reopened: x.reopened === true && !cleared.has(x.id),
    viewers: (x.viewers || []).map(v => ({ id: v.id === "" ? self.id : v.id, name: nameHere(v.id), kind: v.kind || (v.id === "" ? "desktop" : ""), me: v.id === "" })),
    driver: x.driver === null || x.driver === undefined ? null : { name: nameHere(x.driver), me: x.driver === "" }
  }));
  const listed = new Set();
  for (const n of nodes) {
    if (!n.online || !Array.isArray(n.tabs)) continue;
    const suffix = ` · ${n.name || nameOr(names, n.id)}`;
    for (const x of n.tabs) {
      listed.add(x.id);
      const viewers = n.legacy ? [] : (Array.isArray(x.viewers) ? x.viewers : []).map(v => ({ id: v.id, name: v.name || nameOr(names, v.id), kind: v.kind || "", me: Boolean(self.id) && v.id === self.id }));
      const driver = n.legacy || !x.driver ? null : { name: viewers.find(v => v.id === x.driver)?.name || nameOr(names, x.driver), me: Boolean(self.id) && x.driver === self.id };
      out.push({
        ...x, node: n.id, paned: paned.has(x.id), legacy: Boolean(n.legacy), title: `${x.title || ""}${suffix}`, note: "",
        ownerName: !x.owner || x.owner === self.id ? "" : x.ownerName || names.get(x.owner) || "",
        reopened: x.reopened === true && !cleared.has(x.id), viewers, driver
      });
    }
  }
  // Panes of terminals not in a list now: their computer is away (or its list has not come yet).
  const online = new Map(nodes.map(n => [n.id, n]));
  for (const x of remoteTerms.values()) {
    if (listed.has(x.id)) continue;
    const n = online.get(x.node);
    out.push({
      id: x.id, node: x.node, cwd: x.cwd, title: `${x.title || ""} · ${n?.name || nameOr(names, x.node)}`, agent: x.agent || "", sessionId: x.sessionId || "",
      exited: Boolean(x.exited), lost: false, createdAt: x.createdAt || 0, note: n?.online ? "" : offline, paned: true, legacy: Boolean(n?.legacy),
      owner: "", ownerName: "", reopened: false, viewers: [], driver: null
    });
  }
  return out;
}

// Which of this computer's terminals the window views (5.1 syncLocalViewers): those with a pane in its layout.
// viewing: the ids it views now; wanted: those it should. -> { attach: [ids], detach: [ids] }.
function viewerDiff(viewing, wanted) {
  return { attach: [...wanted].filter(id => !viewing.has(id)), detach: [...viewing].filter(id => !wanted.has(id)) };
}

// What the saved layout's panes get on a start (5.4), once the host restored its terminals (host.restoreTerminals):
//   a pane of another computer's terminal waits for that computer (pending; attached once it is there, gone if the
//     terminal is not);
//   a pane whose terminal was attached again, or opened anew under its id (reopened), keeps it;
//   a pane whose terminal runs but could not be attached (kept) goes - opened anew, its agent would run twice;
//   any other (nothing left of it: "Stop all and quit", the command centre, a terminal the host could not open) opens
//     anew under a new id (main.js reopenTerminal).
// panes: Set of the saved panes' ids; terms: the saved workspace's terms (id -> { node?, cwd, title, agent,
// sessionId }); isId(id): a terminal id another computer can have (a UUID). -> { keep: [ids], remote: [ids], reopen:
// [ids], drop: [ids] } (every pane in exactly one).
function restorePlan({ panes, terms = {}, attached = [], reopened = [], kept = [], isId = () => true }) {
  const running = new Set([...attached, ...reopened]), held = new Set(kept);
  const plan = { keep: [], remote: [], reopen: [], drop: [] };
  for (const id of panes) {
    const meta = Object.hasOwn(terms, id) ? terms[id] : null;
    if (meta && typeof meta === "object" && typeof meta.node === "string" && meta.node && isId(id)) plan.remote.push(id);
    else if (running.has(id)) plan.keep.push(id);
    else if (held.has(id)) plan.drop.push(id);
    else plan.reopen.push(id);
  }
  return plan;
}

// The computer a terminal id runs on: "" this one, a node id, or null when it is known nowhere. local: Set of this
// computer's terminal ids; remoteTerms: Map id -> { node } (panes here); lists: Map node -> its tabs; lives: Map node ->
// its live sessions (a terminal known only from a session's `term`).
function nodeOf(id, { local = new Set(), remoteTerms = new Map(), lists = new Map(), lives = new Map() }) {
  if (!id) return null;
  if (local.has(id)) return "";
  if (remoteTerms.has(id)) return remoteTerms.get(id).node;
  for (const [node, tabs] of lists) if (Array.isArray(tabs) && tabs.some(x => x?.id === id)) return node;
  for (const [node, live] of lives) if (Array.isArray(live) && live.some(l => l?.term === id)) return node;
  return null;
}

// The space a terminal of another computer opens in here: the deepest of that computer's projects that holds its
// folder, else the folder itself (as a project page of that computer keys it).
function remoteSpace(projects, node, cwd) {
  const n = normPath(cwd);
  const owner = (projects || [])
    .filter(p => p?.node === node && typeof p.path === "string" && (n === normPath(p.path) || n.startsWith(normPath(p.path).replace(/\/$/, "") + "/")))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return `node:${node}:${owner ? normPath(owner.path) : n}`;
}

// What a pane shown again lacks: the output that came while it was hidden (sent: the end of what the window got),
// from the terminal's scrollback (whose end is `end`). "" when nothing is missing; all of the scrollback when more is
// missing than it holds (a gap, but nothing twice).
function missedOutput(scrollback, end, sent) {
  const text = typeof scrollback === "string" ? scrollback : "";
  if (!Number.isFinite(sent) || !Number.isFinite(end) || end <= sent) return "";
  const missing = end - sent;
  return missing >= text.length ? text : text.slice(text.length - missing);
}

module.exports = { composeView, sizeView, viewerDiff, restorePlan, nodeOf, remoteSpace, missedOutput, nameOr };
