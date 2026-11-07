// The mesh as the rest of the app sees it: this node (identity.js), the nodes it is paired with (peers.js), one
// link to each of them that is reachable (server.js takes the ones that call, client.js calls the others, with
// reconnects), the nodes found on the network (discovery.js), and pairing. Requests from a peer go to the methods
// the app serves (api); its events come out as "event". The protocol is the same both ways (protocol.js).
//
// One link per pair of nodes: both may call each other at the same time, and then the link the node with the
// smaller id opened stays, the other goes.
//
// Events: "nodes" (the list changed: status, name, address), "self" (this node's settings changed), "discovered",
// "event" ({ node, name, data }), "link" ({ node, up: true | false }).
const { EventEmitter } = require("node:events");
const { loadIdentity } = require("./identity");
const { createPeers } = require("./peers");
const { createServer } = require("./server");
const { connect } = require("./client");
const { createDiscovery } = require("./discovery");
const { createLink, PROTOCOL } = require("./protocol");
const { HostError } = require("../host/errors");

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 20000;

// dir: where the identity and the peers are kept; defaultName; kind: "desktop" | "host"; version;
// api(method, params, peer) -> the answer to a peer's request; log(line); discover: announce and look for nodes
// on the local network (off in tests).
function createLinks({ dir, defaultName, kind, version, api, log = () => {}, discover = true }) {
  const out = new EventEmitter();
  const links = new Map();   // peer id -> { link, initiatedHere, info, address, port }
  const retries = new Map(); // peer id -> { timer, delay }
  let identity = null, peers = null, server = null, discovery = null, running = false;

  const self = () => (!identity ? null : { id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, port: server?.port() || identity.settings.port,
    discoverable: identity.settings.discoverable, code: peers.code() });
  const hello = () => ({ id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, port: server?.port() || 0 });

  // ---------- the nodes as listed ----------
  function nodes() {
    if (!peers) return []; // not started yet
    return peers.list().map(p => {
      const l = links.get(p.id);
      return { id: p.id, name: l?.info?.name || p.name, kind: l?.info?.kind || p.kind, version: l?.info?.version || "", address: l?.address || p.address, port: l?.port || p.port,
        status: l ? "online" : "offline", lastSeen: l ? Date.now() : p.lastSeen, pairedAt: p.pairedAt };
    });
  }
  const changed = () => out.emit("nodes", nodes());

  // ---------- a link, whoever opened it ----------
  // The link is up once both said hello; a peer whose hello does not come is dropped.
  async function adopt(ws, id, { initiatedHere, address, port }) {
    const peer = peers.get(id);
    if (!peer) {
      ws.close(1008, "unpaired");
      return null;
    }
    let info = null;
    let settleHello;
    const helloSeen = new Promise(r => { settleHello = r; });
    const link = createLink(ws, {
      onRequest: (method, params) => api(method, params, { id, name: info?.name || peer.name, kind: info?.kind || peer.kind }),
      onEvent: (name, data) => {
        if (name === "hello") {
          info = data && typeof data === "object" ? data : {};
          settleHello(true);
          return;
        }
        out.emit("event", { node: id, name, data });
      },
      onClose: () => {
        if (links.get(id)?.link === link) {
          links.delete(id);
          log(`link down: ${peer.name || id.slice(0, 8)}`);
          out.emit("link", { node: id, up: false });
          changed();
          if (running) scheduleConnect(id, RECONNECT_MIN_MS);
        }
      }
    });
    link.notify("hello", hello());
    const greeted = await Promise.race([helloSeen, new Promise(r => setTimeout(() => r(false), HELLO_TIMEOUT_MS))]);
    if (!greeted) {
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
    const entry = { link, initiatedHere, info, address, port: Number(info.port) || port };
    links.set(id, entry);
    clearRetry(id);
    peers.update(id, { name: info.name || peer.name, kind: info.kind || peer.kind, address, port: entry.port, lastSeen: Date.now() });
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
    if (!running || links.has(id) || !peers.get(id)) return;
    clearRetry(id);
    const timer = setTimeout(() => { retries.delete(id); connectTo(id).catch(() => {}); }, delay);
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
        const { ws } = await connect({ identity, address: c.address, port: c.port, expectId: id });
        if (await adopt(ws, id, { initiatedHere: true, address: c.address, port: c.port })) return;
      } catch (e) {
        if (e.code === "wrongNode") log(`${c.address}:${c.port} is not ${peer.name || id.slice(0, 8)} any more`);
      }
    }
    delay = Math.min(RECONNECT_MAX_MS, delay * 2);
    retries.set(id, { timer: null, delay });
    scheduleConnect(id, delay);
  }
  const connectAll = () => peers.list().forEach(p => scheduleConnect(p.id, 0));

  // ---------- answering the peers ----------
  // An unknown node may only pair: it shows this node's code, and is trusted from then on.
  function onConnection(ws, { id, address }) {
    if (!id) {
      ws.close(1008, "no certificate");
      return;
    }
    if (peers.get(id)) {
      adopt(ws, id, { initiatedHere: false, address, port: 0 }).catch(e => console.error("Adopting a link failed:", e.message));
      return;
    }
    const timer = setTimeout(() => ws.close(1008, "unpaired"), PAIR_TIMEOUT_MS);
    const link = createLink(ws, {
      onRequest: async (method, params) => {
        if (method !== "pair") throw new HostError("unpaired", "This node is not paired with yours.");
        if (!peers.check(params?.code)) throw new HostError("wrongCode", "The pairing code is wrong.");
        clearTimeout(timer);
        const p = params || {};
        peers.add({ id, name: String(p.name || "").slice(0, 60), kind: p.kind, address, port: Number(p.port) || 0 });
        peers.regenerate();
        out.emit("self", self());
        log(`paired with ${p.name || id.slice(0, 8)} (it called)`);
        // The answer goes first; the hello exchange follows on the same socket.
        setImmediate(() => adopt(ws, id, { initiatedHere: false, address, port: Number(p.port) || 0 }).then(changed).catch(e => console.error("Adopting a link failed:", e.message)));
        return { ok: true, id: identity.id, name: identity.settings.name, kind, version };
      },
      onClose: () => clearTimeout(timer)
    });
    void link;
  }

  // ---------- pairing from here ----------
  // Pairs with the node at address:port, which must show `code` (its own, from its Settings or its installer).
  async function pair(address, port, code) {
    const { ws, id } = await connect({ identity, address, port });
    if (peers.get(id)) {
      ws.close(1000, "already paired");
      return { id, name: peers.get(id).name, already: true };
    }
    const link = createLink(ws);
    let r;
    try {
      r = await link.call("pair", { code, name: identity.settings.name, kind, version, port: server?.port() || 0 }, { timeout: PAIR_TIMEOUT_MS });
    } catch (e) {
      link.close();
      throw e;
    }
    peers.add({ id, name: String(r?.name || "").slice(0, 60), kind: r?.kind, address, port });
    log(`paired with ${r?.name || id.slice(0, 8)} at ${address}:${port}`);
    // The socket is handed over whole: its handlers go with the pairing link, so a fresh connection is simplest.
    link.close(1000, "paired");
    changed();
    scheduleConnect(id, 0);
    return { id, name: r?.name || "", kind: r?.kind || "desktop" };
  }
  function forget(id) {
    const l = links.get(id);
    links.delete(id);
    l?.link.close(1000, "forgotten");
    clearRetry(id);
    const had = peers.remove(id);
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
    await server.start(identity.settings.port);
    announce();
  }
  function regenerateCode() {
    peers.regenerate();
    out.emit("self", self());
    return peers.code();
  }

  async function start() {
    identity = await loadIdentity(dir, { defaultName });
    peers = createPeers(dir);
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
    for (const id of [...retries.keys()]) clearRetry(id);
    for (const l of links.values()) l.link.close(1001, "going away");
    links.clear();
    discovery?.stop();
    server?.stop();
  }

  return Object.assign(out, {
    start, stop, self, setSelf, regenerateCode, nodes, discovered: () => discovery?.list() || [], pair, forget, call, notifyAll, online,
    peers: () => peers, identity: () => identity
  });
}

module.exports = { createLinks, PROTOCOL };
