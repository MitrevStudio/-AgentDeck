// The mesh as the rest of the app sees it: this node (identity.js), the nodes it is paired with (peers.js), one
// link to each of them that is reachable (server.js takes the ones that call, client.js calls the others, with
// reconnects), the nodes found on the network (discovery.js), and pairing. Requests from a peer go to the methods
// the app serves (api); its events come out as "event". The protocol is the same both ways (protocol.js).
//
// One link per pair of nodes: both may call each other at the same time, and then the link the node with the
// smaller id opened stays, the other goes.
//
// Events: "nodes" (the list changed: status, name, address), "self" (this node's settings changed), "discovered",
// "event" ({ node, name, data }), "binary" ({ node, data }: a frame, frames.js), "link" ({ node, up: true | false }).
const { EventEmitter } = require("node:events");
const { loadIdentity } = require("./identity");
const { createPeers } = require("./peers");
const { createPairGuard } = require("./pair-guard");
const { createServer } = require("./server");
const { connect } = require("./client");
const { connectViaProxy } = require("./proxy");
const { createDiscovery } = require("./discovery");
const { createLink, PROTOCOL } = require("./protocol");
const { HostError } = require("../host/errors");

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 20000;
const BUSY_ANSWER_MS = 3000;
// An IPv6 address's /64 ("2001:db8:1:2::/64"): one network, which may hold any number of addresses. "" for IPv4.
function ipv6Net(a) {
  if (!a.includes(":")) return "";
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [], tl = a.includes("::") && tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill("0"), ...tl];
  return `${groups.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":")}::/64`;
}

// dir: where the identity and the peers are kept; defaultName; kind: "desktop" | "host"; version;
// api(method, params, peer) -> the answer to a peer's request; log(line); discover: announce and look for nodes
// on the local network (off in tests); relayOnly: serve no api, only pair and relay; listen: the address the mesh
// server binds ("" or omitted: all; "127.0.0.1": a node reached only through a relay on the same machine).
function createLinks({ dir, defaultName, kind, version, api, log = () => {}, discover = true, relayOnly = false, listen = "" }) {
  const out = new EventEmitter();
  const links = new Map();   // peer id -> { link, initiatedHere, info, address, port }
  const retries = new Map(); // peer id -> { timer, delay }
  const incompatible = new Map(); // peer id -> explicit update-required reason
  let identity = null, peers = null, server = null, discovery = null, running = false;
  let guard = createPairGuard();

  const relay = require("./relay").createRelay({
    self: () => self(),
    neighbors: () => new Map([...links].filter(([, n]) => !n.routed && n.info.relay === 1)),
    changed: () => { out.emit("discovered", discovered()); connectAll(); changed(); }
  });
  const discovered = () => {
    const found = new Map((discovery?.list() || []).map(n => [n.id, n]));
    for (const r of relay.list()) if (r.path.length > 2 && !found.has(r.id)) found.set(r.id, { ...r, address: r.id, port: 0, via: r.path.slice(1, -1) });
    return [...found.values()];
  };
  const self = () => (!identity ? null : { id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, port: server?.port() || identity.settings.port,
    discoverable: identity.settings.discoverable, proxy: identity.settings.proxy, code: peers.code(), pairFailures: guard.stats() });
  // relayOnly: this node serves no api (its installer set none); peers use it to skip resource fetches and to label it.
  const hello = () => ({ id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, relay: 1, relayOnly, port: server?.port() || 0 });

  // ---------- the nodes as listed ----------
  function nodes() {
    if (!peers) return []; // not started yet
    return peers.list().map(p => {
      const l = links.get(p.id);
      return { id: p.id, name: l?.info?.name || p.name, kind: l?.info?.kind || p.kind, version: l?.info?.version || "", address: l?.address || p.address, port: l?.port || p.port,
        via: l?.route?.slice(1, -1) || [], status: l ? "online" : "offline", error: incompatible.get(p.id) || "", relayOnly: Boolean(l?.info?.relayOnly), lastSeen: l ? Date.now() : p.lastSeen, pairedAt: p.pairedAt };
    });
  }
  const changed = () => out.emit("nodes", nodes());

  // ---------- a link, whoever opened it ----------
  // The link is up once both said hello; a peer whose hello does not come is dropped.
  async function adopt(ws, id, { initiatedHere, address, port, route }) {
    const peer = peers.get(id);
    if (!peer) {
      ws.close(1008, "unpaired");
      return null;
    }
    let info = null;
    let settleHello;
    const helloSeen = new Promise(r => { settleHello = r; });
    const link = createLink(ws, {
      onRequest: (method, params) => {
        // A node this one trusts that asks to pair again (it forgot this one): no code needed, it is the same node.
        if (method === "pair") return { ok: true, id: identity.id, name: identity.settings.name, kind, version, already: true };
        if (!info) throw new HostError("handshake", "The protocol handshake has not completed.");
        if (method.startsWith("relay.")) return relay.request(id, method, params);
        // This computer is a relay only (its installer set no api): it routes traffic but runs no sessions of its own.
        if (relayOnly) throw new HostError("relayOnly", "This computer is a relay only; it runs no sessions or terminals.");
        // A host peer (a VPS/relay, or a resource host) may route traffic and be used as a resource, but not act on this
        // computer; a desktop peer may. Set from the peer's kind when pairing (peers.js), so a broken or hostile relay
        // cannot reach into the computers it connects. Relaying and using a host as a resource are never affected.
        if (peers.get(id)?.control === false) throw new HostError("relayOnly", "This node may relay but not control this computer.");
        return api(method, params, { id, name: info?.name || peer.name, kind: info?.kind || peer.kind });
      },
      onBinary: data => { if (info) out.emit("binary", { node: id, data }); },
      onEvent: (name, data) => {
        if (name === "hello") {
          if (data?.protocol !== PROTOCOL || data?.id !== id) {
            info = null;
            incompatible.set(id, "Incompatible mesh protocol. Update AgentDeck on both computers.");
            clearRetry(id);
            settleHello(false);
            changed();
            link.close(1002, "incompatible protocol");
            return;
          }
          info = data;
          incompatible.delete(id);
          settleHello(true);
          return;
        }
        if (!info) return;
        // The other side forgot this node: this one forgets it too, so neither keeps calling.
        if (name === "forget") {
          forget(id, { tell: false });
          return;
        }
        if (relay.event(id, name, data)) return;
        out.emit("event", { node: id, name, data });
      },
      onClose: () => {
        settleHello(false);
        if (links.get(id)?.link === link) {
          links.delete(id);
          relay.down(id);
          log(`link down: ${peer.name || id.slice(0, 8)}`);
          out.emit("link", { node: id, up: false });
          changed();
          if (running) scheduleConnect(id, RECONNECT_MIN_MS);
        }
      }
    });
    ws.resume?.();
    link.notify("hello", { ...hello(), routed: Boolean(route), route });
    const helloTimer = setTimeout(() => settleHello(false), HELLO_TIMEOUT_MS);
    const greeted = await helloSeen;
    clearTimeout(helloTimer);
    if (!greeted || !link.isOpen()) {
      link.close(1002, "no hello");
      return null;
    }
    // Two links to the same node: the one its smaller-id end opened stays.
    const other = links.get(id);
    if (other) {
      const keepThis = initiatedHere === (identity.id < id);
      if (!keepThis) {
        link.close(1000, "duplicate");
        return other.link;
      }
      links.delete(id);
      other.link.close(1000, "duplicate");
    }
    if (!route && info.routed && Array.isArray(info.route) && info.route[0] === id && info.route.at(-1) === identity.id) route = [...info.route].reverse();
    const entry = { link, initiatedHere, info, address, route, routed: Boolean(route || info.routed), port: Number(info.port) || port };
    links.set(id, entry);
    clearRetry(id);
    relay.refresh(); relay.broadcast();
    peers.update(id, { name: info.name || peer.name, kind: info.kind || peer.kind, address: entry.routed ? peer.address : address, port: entry.routed ? peer.port : entry.port, lastSeen: Date.now() });
    log(`link up: ${info.name || id.slice(0, 8)} at ${address}:${entry.port} (${initiatedHere ? "called" : "answered"})`);
    out.emit("link", { node: id, up: true });
    changed();
    return link;
  }

  // ---------- calling the peers ----------
  function clearRetry(id) {
    const r = retries.get(id);
    if (r) clearTimeout(r.timer);
    retries.delete(id);
  }
  function scheduleConnect(id, delay) {
    if (!running || links.has(id) || !peers.get(id) || incompatible.has(id)) return;
    clearRetry(id);
    const timer = setTimeout(() => { connectTo(id).catch(() => {}); }, delay);
    timer.unref?.();
    retries.set(id, { timer, delay });
  }
  // Where a peer may be: where it was last reached, and where the network says it is now.
  function candidates(peer) {
    const list = [];
    const seen = discovery?.list().find(x => x.id === peer.id);
    if (seen) list.push({ address: seen.address, port: seen.port });
    if (peer.address && peer.port && !list.some(c => c.address === peer.address && c.port === peer.port)) list.push({ address: peer.address, port: peer.port });
    return list;
  }
  async function connectTo(id) {
    const peer = peers.get(id);
    if (!running || !peer || links.has(id)) return;
    let delay = retries.get(id)?.delay || RECONNECT_MIN_MS;
    for (const c of candidates(peer)) {
      try {
        const socket = identity.settings.proxy ? await connectViaProxy({ proxy: identity.settings.proxy, host: c.address, port: c.port }) : undefined;
        const { ws } = await connect({ identity, address: c.address, port: c.port, expectId: id, socket });
        if (await adopt(ws, id, { initiatedHere: true, address: c.address, port: c.port })) return;
      } catch (e) {
        if (e.code === "wrongNode") log(`${c.address}:${c.port} is not ${peer.name || id.slice(0, 8)} any more`);
      }
    }
    const route = relay.list().find(r => r.id === id && r.path.length > 2)?.path;
    if (route) try {
      const socket = await relay.open(route);
      const { ws } = await connect({ identity, address: "localhost", port: 443, expectId: id, socket });
      if (await adopt(ws, id, { initiatedHere: true, address: "", port: 0, route })) return;
    } catch (e) { log(e.message); }
    delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    retries.set(id, { timer: null, delay });
    scheduleConnect(id, delay);
  }
  const connectAll = () => peers.list().forEach(p => scheduleConnect(p.id, 0));

  // ---------- answering the peers ----------
  // Where a connection came from, for pair-guard.js: { key, label } - its IPv4 address or IPv6 /64, or the neighbour
  // whose relay tunnel brought it (those all come from 127.0.0.1), keyed by its id (a name it could change) and shown
  // by name.
  function sourceOf(address, port) {
    const a = String(address || "").replace(/^::ffff:(?=d+.)/, "");
    const via = a === "127.0.0.1" || a === "::1" ? relay.sourceOf(port) : "";
    if (!via) return { key: ipv6Net(a) || a || "?", label: a || "?" };
    return { key: `via:${via}`, label: `via ${links.get(via)?.info?.name || via.slice(0, 8)} (${via.slice(0, 8)})` };
  }
  // An unknown node may only pair: it shows this node's code, and is trusted from then on. One try per connection,
  // and only as often as pair-guard.js lets that source try.
  function onConnection(ws, { id, address, port }) {
    if (!id) {
      ws.close(1008, "no certificate");
      return;
    }
    if (peers.get(id)) {
      adopt(ws, id, { initiatedHere: false, address, port: 0 }).catch(e => console.error("Adopting a link failed:", e.message));
      return;
    }
    const source = sourceOf(address, port);
    const release = guard.admit(source.key);
    if (!release) {
      // Too many wait to pair: the pairing side hears why (a code it can translate), then the socket goes.
      const busy = createLink(ws, { onRequest: () => { throw new HostError("pairBusy", "This computer is busy with other pairing attempts; try again shortly."); } });
      setTimeout(() => { busy.close(1013, "busy"); ws.terminate(); }, BUSY_ANSWER_MS).unref?.();
      return;
    }
    let tried = false;
    // A client that says nothing in time goes at once (terminate): a graceful close would keep its place until the
    // close handshake times out too.
    const timer = setTimeout(() => { link.close(1008, "unpaired"); ws.terminate(); }, PAIR_TIMEOUT_MS);
    // The error goes out first, then the connection closes.
    const refuse = (code, message) => {
      setTimeout(() => link.close(1008, code), 100).unref?.();
      throw new HostError(code, message);
    };
    const link = createLink(ws, {
      onRequest: async (method, params) => {
        if (method !== "pair") refuse("unpaired", "This node is not paired with yours.");
        if (tried) refuse("pairLater", "One pairing code per connection.");
        tried = true;
        const may = guard.allowed(source.key);
        if (!may.ok) refuse("pairLater", `Too many wrong pairing codes; try again in ${Math.ceil(may.waitMs / 1000)} s.`);
        if (!peers.check(params?.code)) {
          guard.failed(source.key, source.label);
          log(`wrong pairing code from ${source.label}`);
          out.emit("self", self());
          refuse("wrongCode", "The pairing code is wrong.");
        }
        guard.succeeded(source.key);
        clearTimeout(timer);
        const p = params || {};
        peers.add({ id, name: String(p.name || "").slice(0, 60), kind: p.kind, address: p.routed ? "" : address, port: p.routed ? 0 : Number(p.port) || 0 });
        peers.regenerate();
        out.emit("self", self());
        log(`paired with ${p.name || id.slice(0, 8)} (it called)`);
        // Pairing has its own parser. Reconnect for hello rather than attaching two parsers/heartbeats to one socket.
        setImmediate(() => { link.close(1000, "paired"); changed(); });
        return { ok: true, id: identity.id, name: identity.settings.name, kind, version };
      },
      onClose: () => { clearTimeout(timer); release(); }
    });
  }

  // ---------- pairing from here ----------
  // Pairs with the node at address:port, which must show `code` (its own, from its Settings or its installer).
  async function pair(address, port, code) {
    const route = relay.list().find(r => r.id === address && r.path.length > 2)?.path;
    const socket = route ? await relay.open(route)
      : identity.settings.proxy ? await connectViaProxy({ proxy: identity.settings.proxy, host: address, port })
      : undefined;
    const { ws, id } = await connect({ identity, address: route ? "localhost" : address, port: route ? 443 : port, expectId: route ? address : "", socket });
    if (peers.get(id)) {
      ws.close(1000, "already paired");
      return { id, name: peers.get(id).name, already: true };
    }
    const link = createLink(ws);
    ws.resume?.();
    let r;
    try {
      r = await link.call("pair", { code, routed: Boolean(route), name: identity.settings.name, kind, version, port: server?.port() || 0 }, { timeout: PAIR_TIMEOUT_MS });
    } catch (e) {
      link.close();
      throw e;
    }
    peers.add({ id, name: String(r?.name || "").slice(0, 60), kind: r?.kind, address: route ? "" : address, port: route ? 0 : port });
    log(`paired with ${r?.name || id.slice(0, 8)} at ${address}:${port}`);
    // The socket is handed over whole: its handlers go with the pairing link, so a fresh connection is simplest.
    link.close(1000, "paired");
    changed();
    scheduleConnect(id, 0);
    return { id, name: r?.name || "", kind: r?.kind || "desktop", already: r?.already === true };
  }
  // tell: the other side hears of it (and forgets this node) before the link closes.
  function forget(id, { tell = true } = {}) {
    incompatible.delete(id);
    const l = links.get(id);
    links.delete(id);
    relay.down(id);
    if (l && tell) l.link.notify("forget", {});
    l?.link.close(1000, "forgotten");
    clearRetry(id);
    const had = peers.remove(id);
    if (l) out.emit("link", { node: id, up: false });
    if (had) changed();
    return had;
  }

  // ---------- talking to the nodes ----------
  function call(id, method, params, opts) {
    const l = links.get(id);
    if (!l) return Promise.reject(new HostError("offline", "That node is not connected."));
    return l.link.call(method, params, opts);
  }
  function notifyAll(name, data) {
    for (const l of links.values()) l.link.notify(name, data);
  }
  // An event to one node (dropped when it is not connected), and to all of them.
  function notify(id, name, data) {
    links.get(id)?.link.notify(name, data);
  }
  // A binary frame (frames.js) to one node; dropped when it is not connected.
  function sendBinary(id, buffer) {
    links.get(id)?.link.sendBinary(buffer);
  }
  const online = id => links.has(id);

  // ---------- this node ----------
  function setSelf(patch) {
    const keys = identity.update(patch);
    if (keys.includes("port") && running) restartServer().catch(e => console.error("The mesh server could not restart:", e.message));
    else if (keys.length && running) announce();
    if (keys.length) out.emit("self", self());
    return self();
  }
  function announce() {
    if (!discovery) return;
    if (identity.settings.discoverable && server?.port()) discovery.advertise(server.port());
    else discovery.stopAdvertising();
  }
  async function restartServer() {
    server?.stop();
    server = createServer({ identity, onConnection });
    await server.start(identity.settings.port, listen || undefined);
    announce();
  }
  function regenerateCode() {
    peers.regenerate();
    out.emit("self", self());
    return peers.code();
  }
  async function start() {
    identity = await loadIdentity(dir, { defaultName });
    peers = createPeers(dir, { long: kind === "host" });
    // A host's long code cannot be guessed: no lock for everyone there (pair-guard.js).
    guard = createPairGuard({ globalLock: kind !== "host" });
    if (discover) {
      discovery = createDiscovery({ self: () => self(), iface: identity.settings.interface });
      discovery.on("changed", () => { out.emit("discovered", discovery.list()); connectAll(); });
    }
    running = true;
    await restartServer();
    discovery?.browse();
    connectAll();
    log(`mesh up: ${identity.settings.name} ${identity.id.slice(0, 8)} on port ${server.port()}`);
    return self();
  }
  function stop() {
    running = false;
    relay.stop();
    for (const id of [...retries.keys()]) clearRetry(id);
    for (const l of links.values()) l.link.close(1001, "going away");
    links.clear();
    discovery?.stop();
    server?.stop();
  }

  return Object.assign(out, {
    start, stop, self, setSelf, regenerateCode, nodes, discovered, pair, forget, call, notify, notifyAll, sendBinary, online,
    peers: () => peers, identity: () => identity
  });
}

module.exports = { createLinks, PROTOCOL };
