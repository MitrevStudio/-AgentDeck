// The phone's side of the mesh (docs/MOBILE.md): what the app bundles to reach the user's computers over web links
// (web-link.js), and what scripts/test-web-link.js plays the phone with. Runs in the WebView and in Node: no Buffer,
// no node: modules; persistence is the caller's.
//
// The phone dials "hubs" - nodes it was paired with at an address (a relay with its long code, or a computer on the
// same network with its six digits) - and keeps a link to each, reconnecting with backoff (2 s doubling to 30 s). A
// hub sends its routes (relay.routes); every other paired node is reached through a hub that has a route to it: a
// tunnel (relay.open with `web: true`) and, inside it, a Noise handshake of its own with that node, end to end - the
// relay carries bytes it cannot read. A node is known by its Noise public key: the phone checks the key every time,
// and the node's id (its certificate fingerprint, which the routes use) by the node's own word inside that channel
// (the pairing answer and hello). Pairing proves the code without sending it, bound to the handshake and both keys
// (pair-proof.js), so nobody in the middle - the relay included - can pair in the phone's place or pass for a node.
//
// createWebClient({ WebSocket, keypair, peers, name, version, onPeersChanged, log }) -> client
//   WebSocket: the constructor (the browser's, or require("ws").WebSocket).
//   keypair: { publicKey, privateKey } - the phone's X25519 static key (noise.generateKeypair(); keep it secret, kept
//     by the app). The phone's node id is noise.idOf(publicKey).
//   peers: the paired nodes as last handed to onPeersChanged: [{ id, key, name, kind, address, port, pairedAt }]
//     id: the node's id (64 hex); key: its Noise public key (64 hex); kind: "desktop" | "host"; address/port: set for
//     a hub (dialled directly), "" / 0 for a node reached through a hub. Invalid entries are dropped.
//   name, version: what the nodes are told about the phone (name at most 60 characters).
//   onPeersChanged(peers): called with the whole list after every change (pairing, forgetting, a node that forgot the
//     phone, a node's new name) - save it.
//   log(line): diagnostics (no secrets).
//
// client.id, client.key: the phone's node id and public key (hex).
// client.start() / client.stop(): dial the hubs and keep the links / close everything.
// client.nodes() -> [{ id, name, kind, status: "online" | "offline", error, via, direct, version, relayOnly,
//   address, port }] - every paired node. via: the hub a tunnelled link goes through ("" for a direct one); error: why
//   the last try failed (a code below), "" when online; relayOnly: the node serves nothing (a relay).
// client.routes() -> [{ id, name, kind, via, web, paired }] - the nodes the connected hubs can reach, to pair with
//   (paired: already a peer); web false: something on the way needs an update.
// client.pairDirect(address, port, code, { key, id, invite }) -> Promise<peer>: pairs with the node at
//   ws://address:port (a relay's long code, a computer's six digits, or an invite); it becomes a hub.
// client.pairVia(id, code, { key, invite }) -> Promise<peer>: pairs with node `id` through a connected hub that
//   routes to it.
//   The options come from a pairing code (pair-code.js; pairAll pairs with all of one): key - the node's Noise key
//   (64 hex): another key that answers is refused before anything is sent; id - the node must say it is that one;
//   invite - the code is a one-time invite (pair.invite on the node). Without them any node that proves the code is
//   taken, as when a code is typed.
//   Both resolve with the stored peer and dial it at once; on failure they reject with an Error whose .code is one of
//   wrongCode (the code is wrong), inviteExpired (that invite was used, or is older than 10 minutes), pairLater (too
//   many wrong codes, or one try per connection), pairBusy, pairUnproven (the node did not prove it knows the code),
//   wrongKey (another key answered than the one in the pairing code), wrongNode (another node id; also: that id is
//   paired under another key - forget it first), invalidData, nodeOutdated, unreachable, timeout, closed, handshake.
// client.call(id, method, params, { timeout }) -> Promise: a request to a node (protocol.js; rejects with .code, e.g.
//   "offline", "timeout", "relayOnly", or whatever the node answers).
// client.notify(id, name, data): an event to a node. client.sendBinary(id, bytes): a binary frame (frames.js).
// client.online(id) -> boolean. client.forget(id): tells the node (when online) and drops it.
// client.retryNow({ drop }): every paired node that is not linked is dialled now rather than at its next backoff step
//   (up to 30 s; the backoff starts again from 2 s); links that are up stay. drop: ids whose link is up but found dead
//   (a probe that went unanswered) - those links are closed first and dialled again with the rest.
// client.pause() / client.resume(): the app went to the background / came back. Paused, nothing is dialled (no
//   retries, no new tries: a phone in the background would only drain its battery until the system freezes the app);
//   the links that are up stay while they last. resume() lets dialling go on; retryNow() then dials what is down.
//   client.paused() -> boolean.
// client.setName(name): the name the nodes know the phone by, told to the linked ones at once (a hello again, which
//   links.js takes as a new name) and to the others when they link; -> the name now.
// Events (client.on / off / once): "nodes" (nodes()), "routes" (routes()), "link" ({ node, up }),
//   "event" ({ node, name, data }), "binary" ({ node, data: Uint8Array }).
// The node error codes: unreachable (no hub, or no route), nodeOutdated (that computer, or one on the way, needs an
//   AgentDeck update), appOutdated (the app needs one), unpaired (the node does not know this phone any more),
//   wrongNode (another key answered there), handshake, closed, timeout.
const noise = require("./noise");
const webLink = require("./web-link");
const pairProof = require("./pair-proof");
const { inviteTag } = require("./pair-code");
const { createLink, PROTOCOL } = require("./protocol");
const { bytesToHex, randomBytes } = require("@noble/hashes/utils");

const ID = /^[0-9a-f]{64}$/;
const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000, HELLO_TIMEOUT_MS = 10000, PAIR_TIMEOUT_MS = 20000;
const MAX_HOPS = 8, MAX_TUNNELS = 32;
// As relay.js: 32 KB of a tunnel per relay.data (43692 characters of base64), and what may wait to go.
const PIECE = 32768, MAX_DATA = 43692, MAX_BACKLOG = 32 * 1024 * 1024;

const failure = (code, message) => Object.assign(new Error(message), { code });
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}
function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function uuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const ADDRESS = /^[^\s/?#@[\]]+$|^\[[0-9a-fA-F:.]+\]$/;
function cleanPeer(p) {
  if (!isObj(p) || !ID.test(p.id) || !ID.test(p.key)) return null;
  const port = Number.isInteger(p.port) && p.port > 0 && p.port < 65536 ? p.port : 0;
  const address = port && typeof p.address === "string" && ADDRESS.test(p.address) ? p.address : "";
  return { id: p.id, key: p.key, name: typeof p.name === "string" ? p.name.slice(0, 60) : "", kind: p.kind === "host" ? "host" : "desktop",
    address, port: address ? port : 0, pairedAt: Number(p.pairedAt) || 0 };
}

function createWebClient({ WebSocket, keypair, peers: initial = [], name = "Phone", version = "", onPeersChanged = () => {}, log = () => {} }) {
  noise.createHandshake({ initiator: true, s: keypair }); // throws on a keypair that does not hold together
  const selfKey = bytesToHex(keypair.publicKey), selfId = noise.idOf(keypair.publicKey);
  const out = webLink.emitter();
  const peers = new Map();       // id -> peer
  const conns = new Map();       // id -> { link, info, direct, via }
  const routesOf = new Map();    // hub id -> its routes
  const tunnels = new Map();     // tunnel id -> { hub, input(bytes), end() }
  const retries = new Map();     // id -> { timer, delay }
  const dialing = new Set();
  const errors = new Map();      // id -> why the last try failed
  let running = false, paused = false;
  name = String(name).slice(0, 60);
  for (const p of Array.isArray(initial) ? initial : []) { const c = cleanPeer(p); if (c && c.id !== selfId) peers.set(c.id, c); }

  const saved = () => { try { onPeersChanged([...peers.values()].map(p => ({ ...p }))); } catch (e) { log(`saving the peers failed: ${e.message}`); } };
  const emitNodes = () => out.emit("nodes", nodes());

  // ---------- what is shown ----------
  function nodes() {
    return [...peers.values()].map(p => {
      const c = conns.get(p.id);
      return { id: p.id, name: c?.info?.name || p.name, kind: p.kind, status: c ? "online" : "offline", error: c ? "" : errors.get(p.id) || "",
        via: c?.via || "", direct: Boolean(c?.direct), version: c?.info?.version || "", relayOnly: Boolean(c?.info?.relayOnly), address: p.address, port: p.port };
    });
  }
  function routes() {
    const found = new Map();
    for (const [hub, list] of routesOf) for (const r of list) {
      const old = found.get(r.id);
      if (!old || (r.web && !old.web)) found.set(r.id, { id: r.id, name: r.name, kind: r.kind, via: hub, web: r.web, paired: peers.has(r.id) });
    }
    return [...found.values()];
  }
  // The best way through a connected hub to node `id`: one that takes web links, then the shortest.
  function routeFor(id) {
    let best = null;
    for (const [hub, list] of routesOf) {
      if (!conns.get(hub)?.direct) continue;
      for (const r of list) if (r.id === id && (!best || (r.web && !best.web) || (r.web === best.web && r.path.length < best.path.length))) best = r;
    }
    return best;
  }
  // A hub's relay.routes, checked as relay.js checks a neighbour's: the paths start at the hub and end at the node,
  // and leave room for the phone in front.
  function setRoutes(hub, data) {
    if (!Array.isArray(data) || data.length > 512) return;
    routesOf.set(hub, data.filter(r => isObj(r) && ID.test(r.id) && r.id !== selfId && Array.isArray(r.path) && r.path.length >= 2 && r.path.length < MAX_HOPS
      && r.path[0] === hub && r.path.at(-1) === r.id && r.path.every(x => ID.test(x) && x !== selfId) && new Set(r.path).size === r.path.length)
      .map(r => ({ id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 60) : "", kind: r.kind === "host" ? "host" : "desktop", path: r.path, web: r.web === true })));
    out.emit("routes", routes());
    ensureAll();
  }

  // ---------- the ways to a node ----------
  function openDirect(address, port) {
    return new Promise((resolve, reject) => {
      const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
      let ws;
      try { ws = new WebSocket(`ws://${host}:${port}/`); } catch (e) { reject(failure("unreachable", e.message)); return; }
      const pipe = webLink.wsPipe(ws);
      const timer = setTimeout(() => { pipe.close(true); reject(failure("timeout", "no answer")); }, CONNECT_TIMEOUT_MS);
      pipe.onclose = () => { clearTimeout(timer); reject(failure("unreachable", `${address}:${port} did not answer`)); };
      ws.addEventListener("open", () => { clearTimeout(timer); pipe.onclose = null; resolve(pipe); });
    });
  }
  // A tunnel through the hub at route.path[0]: a pipe of Noise messages, [length:4][message] as bytes, 32 KB per
  // relay.data, one at a time (each waits for the hub's answer: that is the flow control).
  async function openTunnel(route) {
    const hubId = route.path[0], hubLink = conns.get(hubId)?.link;
    const path = [selfId, ...route.path];
    if (!hubLink || !conns.get(hubId).direct) throw failure("unreachable", "That relay is not connected.");
    if (path.length > MAX_HOPS || tunnels.size >= MAX_TUNNELS) throw failure("unreachable", "Too far, or too many tunnels.");
    const id = uuid();
    let chain = Promise.resolve(), backlog = 0, gone = false, f = null;
    const finish = () => { gone = true; tunnels.delete(id); };
    f = webLink.framedPipe({
      send(bytes) {
        if (gone) return;
        backlog += bytes.length;
        if (backlog > MAX_BACKLOG) { f.pipe.close(); return; }
        for (let i = 0; i < bytes.length; i += PIECE) {
          const piece = bytes.subarray(i, i + PIECE);
          chain = chain.then(() => hubLink.call("relay.data", { id, data: toBase64(piece) })).then(() => { backlog -= piece.length; }, () => { if (!gone) f.pipe.close(); });
        }
      },
      // Closed from this side: what is queued goes first, then the hub hears.
      close() { finish(); chain.then(() => hubLink.call("relay.close", { id })).catch(() => {}); }
    });
    tunnels.set(id, { hub: hubId, input: f.input, end: () => { finish(); f.end(); } });
    try {
      await hubLink.call("relay.open", { id, path, web: true });
    } catch (e) {
      tunnels.get(id)?.end();
      throw failure("unreachable", e.message);
    }
    return f.pipe;
  }
  // A request from a node to the phone: only a hub's tunnel traffic. The phone serves nothing else.
  function request(from, method, params) {
    if (method === "relay.data" || method === "relay.close") {
      const t = tunnels.get(params?.id);
      if (!t || t.hub !== from) throw failure("invalidData", "Invalid tunnel");
      if (method === "relay.close") { t.end(); return true; }
      if (typeof params.data !== "string" || params.data.length > MAX_DATA) throw failure("invalidData", "Invalid tunnel data");
      let bytes;
      try { bytes = fromBase64(params.data); } catch { throw failure("invalidData", "Invalid tunnel data"); }
      t.input(bytes);
      return true;
    }
    throw failure("unknownMethod", "A phone serves nothing.");
  }

  // ---------- a link ----------
  // Over a fresh pipe to `peer`: the handshake (its key must be the one paired with), hellos both ways (its id must be
  // the one paired with, its protocol this one), then the link is up.
  async function linkUp(peer, pipe, { direct, via }) {
    const { socket, remoteKey } = await webLink.handshake(pipe, { initiator: true, s: keypair });
    if (bytesToHex(remoteKey) !== peer.key) {
      socket.close(1008, "wrong node");
      throw failure("wrongNode", "Another computer answered there.");
    }
    let info = null, settle;
    const greeted = new Promise(r => { settle = r; });
    const link = createLink(socket, {
      onRequest: (method, params) => request(peer.id, method, params),
      onEvent: (name, data) => {
        if (name === "hello") {
          // A hello on a link that is up: the node was renamed (links.js setSelf); the rest stays as first said.
          if (info) return renamed(peer, info, data);
          if (!isObj(data) || data.id !== peer.id) return settle("wrongNode");
          if (data.protocol !== PROTOCOL) return settle(Number(data.protocol) > PROTOCOL ? "appOutdated" : "nodeOutdated");
          info = { name: typeof data.name === "string" ? data.name.slice(0, 60) : "", version: typeof data.version === "string" ? data.version.slice(0, 40) : "", relayOnly: data.relayOnly === true };
          return settle("");
        }
        if (!info) return;
        if (name === "forget") return drop(peer.id);
        if (name === "relay.routes") { if (direct) setRoutes(peer.id, data); return; }
        out.emit("event", { node: peer.id, name, data });
      },
      onBinary: data => { if (info) out.emit("binary", { node: peer.id, data }); },
      onClose: (_code, reason) => { settle(reason === "unpaired" ? "unpaired" : "closed"); down(peer.id, link); }
    });
    socket.resume();
    link.notify("hello", hello());
    const timer = setTimeout(() => settle("timeout"), HELLO_TIMEOUT_MS);
    const problem = await greeted;
    clearTimeout(timer);
    // Forgotten while its hello was awaited, or forgotten and paired again under another key (keep): this link is to
    // the node as it was, not as it is paired now.
    if (problem || !running || peers.get(peer.id)?.key !== peer.key) {
      link.close(1000, "no hello");
      throw failure(problem || "closed", `No link to ${peer.name || peer.id.slice(0, 8)}: ${problem || "stopped"}`);
    }
    // Already linked to it (a link that came up beside this one): the newest one stays, as links.js keeps a phone's
    // newest - the older is a network the phone left. The old one goes as if it had dropped ("link" down, the node
    // offline), so whatever was held on it (an attached terminal) is taken up again on this one.
    const old = conns.get(peer.id);
    if (old) {
      lose(peer.id);
      old.link.close(1000, "duplicate");
    }
    conns.set(peer.id, { link, info, direct, via });
    errors.delete(peer.id);
    if (info.name && info.name !== peer.name) { peer.name = info.name; saved(); }
    log(`link up: ${info.name || peer.id.slice(0, 8)}${via ? ` via ${via.slice(0, 8)}` : ""}`);
    out.emit("link", { node: peer.id, up: true });
    emitNodes();
  }
  const hello = () => ({ id: selfId, name, kind: "mobile", version, protocol: PROTOCOL, relay: 0, port: 0 });
  // A node's new name, from a hello on its link that is up (only the name: nothing else changes on a live link).
  function renamed(peer, info, data) {
    const next = isObj(data) && data.id === peer.id && typeof data.name === "string" ? data.name.slice(0, 60) : "";
    if (!next || next === info.name) return;
    info.name = next;
    if (peers.get(peer.id) === peer) { peer.name = next; saved(); }
    emitNodes();
  }
  // The link to `id` taken out of the picture: its routes and tunnels (a hub's) with it, and everybody told.
  function lose(id) {
    const c = conns.get(id);
    conns.delete(id);
    if (c.direct) {
      routesOf.delete(id);
      for (const t of [...tunnels.values()]) if (t.hub === id) t.end();
      out.emit("routes", routes());
    }
    log(`link down: ${c.info.name || id.slice(0, 8)}`);
    out.emit("link", { node: id, up: false });
    emitNodes();
  }
  function down(id, link) {
    if (conns.get(id)?.link !== link) return;
    lose(id);
    schedule(id, RECONNECT_MIN_MS);
  }
  async function dial(id) {
    const peer = peers.get(id);
    const ways = [];
    if (peer.address) ways.push(async () => ({ pipe: await openDirect(peer.address, peer.port), direct: true, via: "" }));
    const r = routeFor(id);
    if (r) ways.push(async () => {
      if (!r.web) throw failure("nodeOutdated", "That computer, or one on the way to it, needs an AgentDeck update.");
      return { pipe: await openTunnel(r), direct: false, via: r.path[0] };
    });
    if (!ways.length) throw failure("unreachable", "No connected relay reaches that computer now.");
    let last;
    for (const way of ways) {
      try {
        const { pipe, direct, via } = await way();
        return await linkUp(peer, pipe, { direct, via });
      } catch (e) { last = e; }
    }
    throw last;
  }

  // ---------- keeping the links ----------
  function clearRetry(id) {
    clearTimeout(retries.get(id)?.timer);
    retries.delete(id);
  }
  function schedule(id, delay) {
    if (!running || paused || conns.has(id) || dialing.has(id) || !peers.has(id)) return;
    clearRetry(id);
    const timer = setTimeout(() => connect(id), delay);
    timer.unref?.();
    retries.set(id, { timer, delay });
  }
  async function connect(id) {
    if (!running || paused || conns.has(id) || dialing.has(id) || !peers.has(id)) return;
    const delay = retries.get(id)?.delay || RECONNECT_MIN_MS;
    retries.delete(id);
    dialing.add(id);
    try {
      await dial(id);
    } catch (e) {
      if (!peers.has(id)) return;
      errors.set(id, e.code || "unreachable");
      emitNodes();
      // Nothing to try until a hub or a route comes (setRoutes calls ensureAll).
      if (peers.get(id).address || routeFor(id)) {
        dialing.delete(id);
        schedule(id, Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, delay * 2)));
      }
    } finally { dialing.delete(id); }
  }
  // Every paired node that is not linked and not waiting for its next try is tried now.
  function ensureAll() {
    for (const id of peers.keys()) if (!retries.has(id)) schedule(id, 0);
  }
  // The same, waiting or not (the app is back in the foreground, the network changed, "Try now"); `drop`: links that
  // are up but dead go first (down() as when they close by themselves; the close itself may take long on a dead one).
  function retryNow({ drop = [] } = {}) {
    if (!running || paused) return;
    for (const id of drop) {
      const c = conns.get(id);
      if (!c) continue;
      down(id, c.link);
      c.link.close(1000, "no answer");
    }
    for (const id of peers.keys()) {
      if (conns.has(id) || dialing.has(id)) continue;
      clearRetry(id);
      schedule(id, 0);
    }
  }

  // ---------- pairing ----------
  // Over a fresh pipe: the handshake, then the code proven (pair-proof.js, bound to this handshake and both keys).
  // expectId: the node the tunnel was opened to, or the one the pairing code names - the node must say it is that one.
  // expectKey: the Noise key the pairing code names (hex) - another key that answers is refused before anything is
  // sent. invite: the code is a one-time invite (pair-code.js), named to the node by its tag.
  async function pairOver(pipe, code, { expectId = "", expectKey = "", invite = false } = {}) {
    const { socket, remoteKey, hash } = await webLink.handshake(pipe, { initiator: true, s: keypair });
    const key = bytesToHex(remoteKey);
    if (expectKey && key !== expectKey) {
      socket.close(1008, "wrong key");
      throw failure("wrongKey", "The computer that answered is not the one in the pairing code (another key).");
    }
    const link = createLink(socket);
    socket.resume();
    const unproven = () => failure("pairUnproven", "The computer that answered did not prove it knows the pairing code.");
    try {
      const proof = pairProof.start({ code, initiator: selfKey, responder: key, binding: bytesToHex(hash), role: "initiator" });
      const s = await link.call("pair.start", invite ? { y: proof.y, invite: inviteTag(code) } : { y: proof.y }, { timeout: PAIR_TIMEOUT_MS });
      let proofs;
      try { proofs = proof.finish(s?.y); } catch { throw unproven(); }
      const r = await link.call("pair.finish", { mac: proofs.own, name: String(name).slice(0, 60), kind: "mobile", version }, { timeout: PAIR_TIMEOUT_MS });
      if (!pairProof.same(r?.mac, proofs.expect)) throw unproven();
      if (!ID.test(r?.id) || r.id === selfId || (expectId && r.id !== expectId)) throw failure("wrongNode", "Another computer answered there.");
      return { id: r.id, key, name: typeof r.name === "string" ? r.name.slice(0, 60) : "", kind: r.kind === "host" ? "host" : "desktop" };
    } finally {
      link.close(1000, "paired");
    }
  }
  // A node that says it is one already paired under another key does not replace it: forget that one first (a node
  // whose key was made anew), so a node that knows one code cannot take another's place.
  function keep(peer) {
    if (peers.has(peer.id) && peers.get(peer.id).key !== peer.key) throw failure("wrongNode", "A computer with that id is paired under another key; forget it first.");
    const old = conns.get(peer.id);
    clearRetry(peer.id);
    errors.delete(peer.id);
    peers.set(peer.id, peer);
    saved();
    // Paired again (perhaps under another key): the old link goes, the new pairing is dialled.
    if (old) old.link.close(1000, "paired again");
    else schedule(peer.id, 0);
    emitNodes();
    out.emit("routes", routes());
    return { ...peer };
  }
  // The optional { key, id, invite } of a pairing code (pair-code.js): key/id must be what the node shows and says.
  function expected({ key = "", id = "", invite = false } = {}) {
    if ((key && !ID.test(key)) || (id && !ID.test(id))) throw failure("invalidData", "Not a key or a node id.");
    return { expectKey: key, expectId: id, invite: invite === true };
  }
  async function pairDirect(address, port, code, opts) {
    address = String(address ?? "").trim();
    if (!ADDRESS.test(address) || !Number.isInteger(port) || port <= 0 || port > 65535) throw failure("invalidData", "Not an address and port.");
    const want = expected(opts);
    const p = await pairOver(await openDirect(address.replace(/^\[|\]$/g, ""), port), code, want);
    log(`paired with ${p.name || p.id.slice(0, 8)} at ${address}:${port}`);
    return keep({ ...p, address: address.replace(/^\[|\]$/g, ""), port, pairedAt: Date.now() });
  }
  async function pairVia(id, code, opts) {
    const want = expected({ ...opts, id });
    const r = ID.test(id) ? routeFor(id) : null;
    if (!r) throw failure("unreachable", "No connected relay reaches that computer now.");
    if (!r.web) throw failure("nodeOutdated", "That computer, or one on the way to it, needs an AgentDeck update.");
    const p = await pairOver(await openTunnel(r), code, want);
    log(`paired with ${p.name || id.slice(0, 8)} via ${r.path[0].slice(0, 8)}`);
    return keep({ ...p, address: "", port: 0, pairedAt: Date.now() });
  }

  // ---------- forgetting ----------
  // tell: the node hears it first (and forgets the phone).
  function forget(id, { tell = true } = {}) {
    const c = conns.get(id), had = peers.delete(id);
    clearRetry(id);
    errors.delete(id);
    if (c) {
      if (tell) c.link.notify("forget", {});
      c.link.close(1000, "forgotten");
    }
    if (had) { saved(); emitNodes(); out.emit("routes", routes()); }
    return had;
  }
  const drop = id => { forget(id, { tell: false }); };

  // ---------- talking to the nodes ----------
  function call(id, method, params = {}, opts) {
    const c = conns.get(id);
    if (!c) return Promise.reject(failure("offline", "That computer is not connected."));
    return c.link.call(method, params, opts);
  }
  const notify = (id, event, data) => conns.get(id)?.link.notify(event, data);
  const sendBinary = (id, bytes) => conns.get(id)?.link.sendBinary(bytes);

  // A new name for the phone: the linked nodes hear it now (a hello again), the others with their next link's hello.
  function setName(next) {
    const clean = String(next ?? "").trim().slice(0, 60);
    if (!clean || clean === name) return name;
    name = clean;
    for (const c of conns.values()) c.link.notify("hello", hello());
    return name;
  }

  function start() {
    running = true;
    ensureAll();
  }
  function stop() {
    running = false;
    for (const id of [...retries.keys()]) clearRetry(id);
    for (const c of [...conns.values()]) c.link.close(1001, "going away");
    for (const t of [...tunnels.values()]) t.end();
  }
  // In the background: the tries waiting go, and none is made until resume().
  function pause() {
    paused = true;
    for (const id of [...retries.keys()]) clearRetry(id);
  }
  function resume() { paused = false; }

  return Object.assign(out, {
    id: selfId, key: selfKey, start, stop, pause, resume, nodes, routes, pairDirect, pairVia, call, notify, sendBinary, forget, retryNow, setName,
    paused: () => paused,
    online: id => conns.has(id), peers: () => [...peers.values()].map(p => ({ ...p }))
  });
}

module.exports = { createWebClient };
