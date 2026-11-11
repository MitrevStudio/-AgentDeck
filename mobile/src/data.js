// The one store the UI reads: the user's computers ("nodes"), per node what its host serves (the sessions snapshot,
// the live status, the terminals), and the actions on them. The UI never talks to a transport; a *provider* does.
//
// ---------------------------------------------------------------------------------------------------------------
// THE PROVIDER (the seam). Two exist: mock.js (sample data, the "Demo") and provider-relay.js (the user's relay:
// WebSocket + Noise, src/mesh/web-client.js). A provider is a thin transport that speaks the host's own protocol
// (src/mesh/serve.js) unchanged; everything above it lives here, so the UI does not know which one runs.
//
//   provider.start()                  -> Promise     connect; "nodes" follows
//   provider.stop()                                  disconnect
//   provider.nodes()                  -> Node[]
//        { id, name, kind: "desktop" | "headless" | "relay", version, status: "online" | "offline",
//          via: [node ids the route goes through], lastSeen (ms), error: "" | why the last try failed (web-client.js
//          codes: unreachable, nodeOutdated, appOutdated, unpaired, wrongNode, timeout, ...), hub: dialled directly }
//        A "relay" serves nothing (no sessions): it is only shown in the Computers screen.
//   provider.request(node, method, params) -> Promise   a request to that node's serve.js METHODS (a failure carries
//        .code: the host's error code, or "offline" / "timeout" / "closed" / "unknownMethod" for an older host):
//        "host.info"         -> { id, name, kind, version, platform, home, agents: ["Claude", "Codex", "OpenCode"] }
//        "sessions.list"     -> Snapshot (projects.js localSnapshot):
//                               { registry: { projects: [{ name, path }] },
//                                 sessions: [{ id, agent, cwd, title, prompt?, recap?, projectName?, updatedAt }],
//                                 agents: [...], at }
//        "live.list"         -> Live[] (host/live.js + codex-live.js):
//                               [{ agent, id, pid, cwd, name, kind: "" | "bg", status: "busy" | "waiting" | "idle" | ...,
//                                  waitingFor, statusAt, startedAt, activityAt, subagents: [], jobs: [] }]
//        "terminals.list"    { all: true } -> Tab[] (host/terminals.js getTabs), every terminal of the host - the
//                               "wide view", asked again after every (re)connect before any attach:
//                               [{ id, cwd, title, agent, sessionId, agentOnly, pid, owner, exited, lost, createdAt, note }]
//                               (no size: a terminal's size comes with attach and "terminal.size")
//        "terminals.open"    { cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt } -> Tab
//        "terminals.attach"  { id } -> { scrollback, end, exitCode, cols, rows }
//        "terminals.detach"  { id } -> true          (a size the phone set goes back to the desktop's pane)
//        "terminals.close"   { id }
//        "terminals.send"    { id, text } -> true    typed into the agent and submitted; refused with agentNotReady
//                                                     while the agent works (or when no agent runs there)
//        "sessions.stop"     { agent, id } -> true   a session running outside an AgentDeck terminal (Claude only;
//                                                    others answer stopUnsupported, store.stopKind says "")
//        "sessions.preview"  { agent, id } -> Preview | null (host/session-preview.js):
//                               { agent, id, startedAt, lastAt, prompts, replies, model, subagents, firstPrompt,
//                                 firstCut, more, messages: [{ role: "user" | "assistant", text, at, cut? }] }
//   provider.sendFrame(node, frame)                  a binary frame (src/mesh/frames.js), decoded:
//        { type: "input", id, data } | { type: "resize", id, cols, rows }
//   provider.forget(node)             -> Promise     unpair
//   provider.on(event, fn)            -> off()
//        "nodes"  Node[]                             the list or a status changed
//        "notify" { node, event, payload }           a host's push (serve.js attach): event "data" (Snapshot),
//                                                    "live" (Live[]), "terminals" (Tab[]), "terminal.size" ({ id, cols, rows })
//        "frame"  { node, frame: { type: "output", id, data, end } }   terminal output
//   provider.demo                     true for the mock (the UI says so)
//   provider.id                       the phone's own node id (the owner of the terminals it opens)
//   optional: provider.connection() -> { state: "none" | "nohub" | "connecting" | "down" | "ok", error },
//        provider.wake(), provider.pause()
// ---------------------------------------------------------------------------------------------------------------
//
// createStore(provider) -> store (see the bottom for the whole surface). Events: "change" (anything; the screens
// re-render), "waiting" ({ node, item }) when a running session turns to waiting while the app is open.
//
// A node coming online (also again, after a lost link) is loaded afresh - host.info, sessions.list, live.list,
// terminals.list { all: true } - and only then are the terminal views open on it attached again (their handles say
// "state" offline / online and "reset" with the new scrollback). A host too old for a method answers unknownMethod:
// that part is left empty and store.missing(node, method) says so.
import { emitter, sessionKey, normPath, baseName } from "./util.js";

const RANK = { waiting: 0, busy: 1, idle: 2, other: 2, stopped: 3 };
// Why a computer cannot come back by itself (provider-relay.js, web-client.js): it does not know this phone any more,
// another key answers there, or nothing is left to reach it through. What was loaded of it before is stale; it is
// not shown as its sessions until it is paired again.
const LOST = new Set(["unpaired", "wrongNode", "noHub"]);
// "Type it into the terminal" after terminals.send was refused: the text, then Enter a moment later (an agent's
// input box takes text and Enter in one write as a pasted line break).
const ENTER_AFTER_MS = 150;

export function createStore(provider) {
  const out = emitter();
  const nodes = new Map(); // id -> { node, info, data, live, terminals, loaded, missing, gen }
  const attached = new Map(); // `${node}:${termId}` -> handle internals
  let started = false;
  const offs = [];

  const entry = id => {
    if (!nodes.has(id)) nodes.set(id, { node: null, info: null, data: null, live: [], terminals: [], loaded: false, loading: false, liveSeen: false, missing: new Set(), error: "", gen: 0 });
    return nodes.get(id);
  };
  const changed = why => out.emit("change", why);
  const handlesOf = id => [...attached.values()].filter(h => h.node === id);

  // ---------- incoming ----------
  async function load(id) {
    const e = entry(id);
    if (e.node?.kind === "relay") return;
    const gen = ++e.gen;
    e.loading = true;
    const ask = (method, params) => provider.request(id, method, params).then(v => ({ ok: true, v }), err => ({ ok: false, err }));
    // The wide view first in the queue; attaches wait for the whole load below.
    const [terminals, info, data, live] = await Promise.all([ask("terminals.list", { all: true }), ask("host.info"), ask("sessions.list"), ask("live.list")]);
    if (gen !== e.gen) return; // went offline (or loaded again) meanwhile
    e.loading = false;
    e.error = "";
    const take = (method, r) => {
      if (r.ok) { e.missing.delete(method); return r.v; }
      if (r.err?.code === "unknownMethod") e.missing.add(method);
      else { e.error ||= r.err?.code || "error"; console.warn(`${method} on ${id.slice(0, 8)} failed`, r.err); }
      return undefined;
    };
    const vInfo = take("host.info", info), vData = take("sessions.list", data), vLive = take("live.list", live), vTerms = take("terminals.list", terminals);
    if (vInfo !== undefined) e.info = vInfo;
    if (vData !== undefined) e.data = vData;
    if (vTerms !== undefined) e.terminals = vTerms || [];
    if (vLive !== undefined) setLive(id, vLive || []);
    e.loaded = true;
    changed("node");
    for (const h of handlesOf(id)) h.reattach();
  }

  function setNodes(list) {
    const seen = new Set();
    for (const n of list) {
      seen.add(n.id);
      const e = entry(n.id);
      const wasOnline = e.node?.status === "online";
      const online = n.status === "online";
      e.node = n;
      if (online && !wasOnline) load(n.id);
      else if (online && !e.loaded && !e.loading) load(n.id);
      else if (!online && wasOnline) {
        e.gen++;
        e.loaded = false;
        e.loading = false;
        for (const h of handlesOf(n.id)) h.lost();
      }
    }
    for (const id of [...nodes.keys()]) if (!seen.has(id)) nodes.delete(id);
    changed("nodes");
  }

  // A session that turns to waiting while the app looks on raises "waiting" (not on the first list of a node:
  // what already waited is at the top of the inbox anyway).
  function setLive(id, live) {
    const e = entry(id);
    const before = new Map(e.live.map(l => [`${l.agent}:${l.id}`, l.status]));
    e.live = live;
    if (e.liveSeen) {
      for (const l of live) {
        if (l.status === "waiting" && before.get(`${l.agent}:${l.id}`) !== "waiting") {
          const item = itemOf(id, l.agent, l.id);
          if (item) out.emit("waiting", { node: id, item });
        }
      }
    }
    e.liveSeen = true;
  }

  function onNotify({ node, event, payload }) {
    const e = entry(node);
    if (event === "data") e.data = payload;
    else if (event === "live") setLive(node, payload || []);
    else if (event === "terminals") e.terminals = payload || [];
    else if (event === "terminal.size") {
      const h = attached.get(`${node}:${payload?.id}`);
      if (h) { h.cols = payload.cols; h.rows = payload.rows; h.emit("size", { cols: payload.cols, rows: payload.rows }); }
      return;
    } else return;
    changed(event);
  }

  function onFrame({ node, frame }) {
    if (frame.type !== "output") return;
    const h = attached.get(`${node}:${frame.id}`);
    if (!h) return;
    if (h.attaching || h.held.length) h.held.push(frame);
    // Output the scrollback already held (it was attached midway through a chunk) is skipped.
    else if (h.online) deliver(h, frame);
  }

  // ---------- derived ----------
  const nodeName = id => entry(id).node?.name || entry(id).info?.name || id.slice(0, 8);
  const isOnline = id => entry(id).node?.status === "online";

  // The terminal a session runs in: the snapshot's `term` once the host sends it, else the tab that carries its agent
  // and sessionId (with the wide view: the desktop's own tabs too).
  function termOf(id, agent, sessionId, s) {
    if (s?.term) return s.term;
    return entry(id).terminals.find(x => x.agent === agent && x.sessionId === sessionId && !x.exited)?.id || "";
  }
  function statusOf(live) {
    if (!live) return "stopped";
    return live.status === "busy" || live.status === "waiting" || live.status === "idle" ? live.status : "other";
  }
  function projectOf(e, cwd, s) {
    if (s?.projectName) return s.projectName;
    const p = (e.data?.registry?.projects || []).find(x => normPath(x.path) === normPath(cwd));
    return p?.name || baseName(cwd);
  }

  // One inbox row: the snapshot's session joined with its live state and terminal.
  function makeItem(id, s, live) {
    const e = entry(id);
    const agent = s?.agent || live.agent, sid = s?.id || live.id, cwd = s?.cwd || live?.cwd || "";
    const status = isOnline(id) ? statusOf(live) : "stopped";
    return {
      key: sessionKey(id, agent, sid), node: id, nodeName: nodeName(id), online: isOnline(id),
      agent, id: sid, cwd, project: projectOf(e, cwd, s),
      title: s?.title || live?.name || `${agent} ${sid.slice(0, 8)}`,
      updatedAt: Math.max(s?.updatedAt || 0, live?.activityAt || 0, live?.statusAt || 0),
      live: status === "stopped" ? null : live, status, waitingFor: live?.status === "waiting" ? live.waitingFor || "" : "",
      term: termOf(id, agent, sid, s),
      group: status === "waiting" ? "waiting" : status === "stopped" ? "recent" : "working"
    };
  }
  function itemsOf(id) {
    const e = entry(id);
    const liveMap = new Map((isOnline(id) ? e.live : []).map(l => [`${l.agent}:${l.id}`, l]));
    const items = (e.data?.sessions || []).map(s => {
      const k = `${s.agent}:${s.id}`, live = liveMap.get(k);
      liveMap.delete(k);
      return makeItem(id, s, live);
    });
    // Running sessions the snapshot does not list yet (just started).
    for (const l of liveMap.values()) items.push(makeItem(id, null, l));
    return items;
  }
  function itemOf(id, agent, sid) {
    return itemsOf(id).find(x => x.agent === agent && x.id === sid) || null;
  }

  // A computer that cannot come back by itself (LOST): offline with such an error.
  const isLost = id => entry(id).node?.status !== "online" && LOST.has(entry(id).node?.error);

  // Every computer's sessions in one list: waiting first, then running, then the rest by last activity. A lost
  // computer's sessions are left out (what was loaded of it is stale).
  function inbox({ query = "", recent = 60 } = {}) {
    const q = query.trim().toLowerCase();
    let all = [...nodes.keys()].filter(id => !isLost(id)).flatMap(itemsOf);
    if (q) all = all.filter(x => `${x.title} ${x.project} ${x.nodeName} ${x.agent} ${x.waitingFor}`.toLowerCase().includes(q));
    all.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt);
    const groups = { waiting: [], working: [], recent: [] };
    for (const x of all) groups[x.group].push(x);
    groups.recent = groups.recent.slice(0, recent);
    return groups;
  }

  // ---------- terminals ----------
  // Every terminal of the computers that are online, from the wide view (terminals.list { all: true }): the
  // computer's own (a shell pane on its desktop, an agent's terminal), those this phone opened, those other peers
  // opened. One row each, newest first:
  //   { key, node, nodeName, id, title, cwd, project, agent, sessionId, item, owner, ownerName, exited, lost, createdAt }
  //   item: the session's inbox row, for an agent's terminal whose session is known (open it there); owner: "here" (the
  //   computer itself), "phone" (this phone), "peer" (another computer or phone; ownerName when this phone knows it).
  // node: that computer's only; query: a filter as the inbox's; running: without the exited and lost ones; loose:
  // without those whose session runs and is listed in the inbox anyway (what the inbox lists under Terminals).
  function terminals({ node = "", query = "", running = false, loose = false } = {}) {
    const q = query.trim().toLowerCase();
    const out = [];
    for (const [id, e] of nodes) {
      if ((node && id !== node) || !isOnline(id) || e.node?.kind === "relay") continue;
      const items = new Map(itemsOf(id).map(x => [`${x.agent}:${x.id}`, x]));
      for (const tab of e.terminals) {
        if (!tab?.id || (running && (tab.exited || tab.lost))) continue;
        const item = tab.agent && tab.sessionId ? items.get(`${tab.agent}:${tab.sessionId}`) || null : null;
        if (loose && item && item.status !== "stopped") continue;
        const owner = !tab.owner ? "here" : tab.owner === provider.id ? "phone" : "peer";
        const row = {
          key: `${id}:${tab.id}`, node: id, nodeName: nodeName(id), id: tab.id, cwd: tab.cwd || "", project: projectOf(e, tab.cwd || ""),
          title: item?.title || tab.title || baseName(tab.cwd || "") || tab.id.slice(0, 8), agent: tab.agent || "", sessionId: tab.sessionId || "", item,
          owner, ownerName: owner === "peer" && nodes.has(tab.owner) ? nodeName(tab.owner) : "",
          exited: Boolean(tab.exited), lost: Boolean(tab.lost), createdAt: Number(tab.createdAt) || 0
        };
        if (q && !`${row.title} ${row.project} ${row.cwd} ${row.nodeName} ${row.agent}`.toLowerCase().includes(q)) continue;
        out.push(row);
      }
    }
    return out.sort((a, b) => Number(a.exited || a.lost) - Number(b.exited || b.lost) || b.createdAt - a.createdAt);
  }

  // A view's hold on a host terminal. It survives a lost link: "state" { online: false } when the link drops, then,
  // once the node is loaded again, a fresh attach and "reset" { scrollback, cols, rows, exitCode } (the view draws
  // the screen again from it) and "state" { online: true }; "gone" when the terminal is no longer there.
  // Output that arrives while an attach is on its way is held (it may be newer than the scrollback the answer
  // carries) and handed on after it, minus what the scrollback already had.
  function deliver(h, frame) {
    if (frame.end <= h.end) return;
    const skip = frame.data.length - (frame.end - h.end);
    h.end = frame.end;
    h.emit("data", skip > 0 ? frame.data.slice(skip) : frame.data);
  }
  async function attach(id, termId) {
    const key = `${id}:${termId}`;
    if (attached.has(key)) throw new Error("already attached");
    const ev = emitter();
    const h = { node: id, termId, end: 0, cols: 120, rows: 30, online: false, attaching: 0, held: [], emit: ev.emit, closed: false };
    attached.set(key, h);
    const ask = async () => {
      h.attaching++;
      try { return await provider.request(id, "terminals.attach", { id: termId }); } finally { h.attaching--; }
    };
    const apply = r => {
      h.end = r.end || 0;
      if (r.cols && r.rows) { h.cols = r.cols; h.rows = r.rows; }
      h.online = true;
    };
    const flush = () => { for (const f of h.held.splice(0)) deliver(h, f); };
    h.lost = () => { h.online = false; h.held = []; ev.emit("state", { online: false }); };
    h.reattach = async () => {
      if (h.closed) return;
      try {
        const again = await ask();
        if (h.closed) return;
        if (!again) { ev.emit("gone"); return; }
        apply(again);
        ev.emit("reset", { scrollback: again.scrollback || "", cols: h.cols, rows: h.rows, exitCode: again.exitCode ?? null });
        flush();
        ev.emit("state", { online: true });
      } catch (err) {
        if (err?.code === "invalidData") ev.emit("gone");
        else console.warn("re-attach failed", err);
      }
    };
    let r;
    try {
      r = await ask();
      if (!r) throw Object.assign(new Error("no such terminal"), { code: "invalidData" });
    } catch (err) {
      attached.delete(key);
      throw err;
    }
    apply(r);
    // The caller draws the scrollback and subscribes first.
    setTimeout(flush, 0);
    return {
      id: termId, node: id,
      scrollback: r.scrollback || "", exitCode: r.exitCode ?? null,
      get cols() { return h.cols; },
      get rows() { return h.rows; },
      get online() { return h.online; },
      onData: fn => ev.on("data", fn),
      onSize: fn => ev.on("size", fn),
      onReset: fn => ev.on("reset", fn),
      onState: fn => ev.on("state", fn),
      onGone: fn => ev.on("gone", fn),
      write: data => { if (h.online) provider.sendFrame(id, { type: "input", id: termId, data }); },
      // Only "Fit to phone" resizes: the phone looks at the host's size otherwise (MOBILE.md §6).
      resize(cols, rows) {
        h.cols = cols; h.rows = rows;
        provider.sendFrame(id, { type: "resize", id: termId, cols, rows });
      },
      // Leaving the view: the host hears it (and gives a size the phone set back to the desktop's pane).
      detach() {
        if (attached.get(key) !== h) return;
        h.closed = true;
        attached.delete(key);
        if (isOnline(id)) provider.request(id, "terminals.detach", { id: termId }).catch(() => {});
      }
    };
  }

  // ---------- the store ----------
  return {
    on: out.on,
    demo: Boolean(provider.demo),
    provider,

    async connect() {
      if (started) return;
      started = true;
      offs.push(provider.on("nodes", setNodes), provider.on("notify", onNotify), provider.on("frame", onFrame));
      await provider.start();
      setNodes(provider.nodes());
    },
    disconnect() {
      for (const off of offs.splice(0)) off();
      for (const h of attached.values()) h.closed = true;
      attached.clear();
      nodes.clear();
      provider.stop();
      started = false;
    },
    // The relay link as a whole (see provider-relay.js connection()); the Demo is always "ok".
    connection: () => provider.connection?.() || { state: "ok", error: "" },
    // Back in the foreground / the network changed.
    wake: () => provider.wake?.(),
    // In the background: nothing is dialled until wake.
    pause: () => provider.pause?.(),
    // The phone's own node id (the owner of the terminals it opens).
    get selfId() { return provider.id || ""; },

    // [{ ...Node, online, info, running }] - relays included (the Computers screen); computers() without them.
    nodes: () => [...nodes.values()].filter(e => e.node).map(e => ({
      ...e.node, online: e.node.status === "online", info: e.info,
      running: (e.node.status === "online" ? e.live : []).length
    })),
    computers() { return this.nodes().filter(n => n.kind !== "relay"); },
    // The node cannot come back by itself (it does not know this phone any more, or nothing reaches it): pair again.
    lost: isLost,
    // The node's raw state: { node, info, data (Snapshot), live (Live[]), terminals (Tab[]) }.
    node: id => (nodes.has(id) ? { ...entry(id) } : null),
    nodeName,
    // A method the node's host does not have (an older AgentDeck there).
    missing: (id, method) => entry(id).missing.has(method),
    // True while an online computer has not answered its first lists yet.
    loading: () => [...nodes.values()].some(e => e.node?.status === "online" && e.node.kind !== "relay" && !e.loaded),
    // { waiting: Item[], working: Item[], recent: Item[] }; Item = see makeItem.
    inbox,
    item: (id, agent, sid) => itemOf(id, agent, sid),
    // The node's projects (registry) and its sessions per project, newest first, for "New session".
    projects(id) {
      const e = entry(id);
      return (e.data?.registry?.projects || []).map(p => ({
        ...p, sessions: itemsOf(id).filter(x => normPath(x.cwd) === normPath(p.path)).sort((a, b) => b.updatedAt - a.updatedAt)
      }));
    },
    agents: id => entry(id).info?.agents || entry(id).data?.agents || [],
    // The terminal tab (Tab) by id, or null.
    tab: (id, termId) => entry(id).terminals.find(x => x.id === termId) || null,
    // The terminals as rows (see terminals above).
    terminals,

    // ---------- actions ----------
    preview: (id, agent, sid) => provider.request(id, "sessions.preview", { agent, id: sid }),
    // A reply typed into the session's agent and submitted (refused with agentNotReady while it works).
    send: (id, termId, text) => provider.request(id, "terminals.send", { id: termId, text }),
    // The same, straight into the terminal as keystrokes (the agent may queue it, or it lands in whatever runs).
    typeInto(id, termId, text) {
      provider.sendFrame(id, { type: "input", id: termId, data: text });
      setTimeout(() => provider.sendFrame(id, { type: "input", id: termId, data: "\r" }), ENTER_AFTER_MS);
    },
    // Raw keys (the quick-key row) without attaching.
    keys: (id, termId, data) => provider.sendFrame(id, { type: "input", id: termId, data }),
    // How Stop ends a session: "terminal" - it runs in an AgentDeck terminal, which is closed (the agent with it);
    // "session" - it runs elsewhere and the host stops it (sessions.stop: Claude sessions only, whose process the host
    // knows for sure); "" - it cannot be stopped from here (a Codex or OpenCode session outside an AgentDeck
    // terminal: no process the host could stop without risking another one), so no Stop is offered.
    stopKind(id, agent, sid) {
      if (termOf(id, agent, sid, (entry(id).data?.sessions || []).find(s => s.agent === agent && s.id === sid))) return "terminal";
      return agent === "Claude" ? "session" : "";
    },
    stop(id, agent, sid) {
      const termId = termOf(id, agent, sid, (entry(id).data?.sessions || []).find(s => s.agent === agent && s.id === sid));
      return termId ? provider.request(id, "terminals.close", { id: termId }) : provider.request(id, "sessions.stop", { agent, id: sid });
    },
    // { cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt } -> Tab
    launch: (id, spec) => provider.request(id, "terminals.open", spec),
    attach,
    closeTerminal: (id, termId) => provider.request(id, "terminals.close", { id: termId }),
    forget: id => provider.forget(id),
    refresh: id => load(id)
  };
}
