// The mesh as the rest of the app sees it: this node (identity.js), the nodes it is paired with (peers.js), one
// link to each of them that is reachable (server.js takes the ones that call, client.js calls the others, with
// reconnects), the nodes found on the network (discovery.js), and pairing. Requests from a peer go to the methods
// the app serves (api); its events come out as "event". The protocol is the same both ways (protocol.js).
//
// One link per pair of nodes: both may call each other at the same time, and then the link the node with the
// smaller id opened stays, the other goes.
//
// Phones (kind "mobile", docs/MOBILE.md) come over web links (web-link.js: a plain WebSocket on the same port, or a
// relay tunnel opened with `web: true`) and are known by their Noise key; once through the handshake they are links
// like any other (hello, the api with control, events, binary frames), except that this node never calls them (they
// call), they are leaves of the relay (relay.js), and their newest link replaces an older one. A key this node does
// not know may only pair, as an unknown certificate may.
//
// Events: "nodes" (the list changed: status, name, address), "self" (this node's settings changed), "discovered",
// "event" ({ node, name, data }), "binary" ({ node, data }: a frame, frames.js), "link" ({ node, up: true | false }).
const { EventEmitter } = require("node:events");
const { loadIdentity } = require("./identity");
const { createPeers, ID } = require("./peers");
const { createPairGuard, createAdmission, addressSource } = require("./pair-guard");
const { createInvites } = require("./invites");
const pairProof = require("./pair-proof");
const { createServer } = require("./server");
const { connect } = require("./client");
const { connectViaProxy } = require("./proxy");
const { createDiscovery } = require("./discovery");
const { createLink, PROTOCOL } = require("./protocol");
const webLink = require("./web-link");
const { idOf } = require("./noise");
const { HostError } = require("../host/errors");

const RECONNECT_MIN_MS = 2000, RECONNECT_MAX_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const PAIR_TIMEOUT_MS = 20000;
const BUSY_ANSWER_MS = 3000;

// dir: where the identity and the peers are kept; defaultName; kind: "desktop" | "host"; version;
// api(method, params, peer) -> the answer to a peer's request; log(line); discover: announce and look for nodes
// on the local network (off in tests); relayOnly: serve no api, only pair and relay; listen: the address the mesh
// server binds ("" or omitted: all; "127.0.0.1": a node reached only through a relay on the same machine);
// inviteTtlMs: how long a phone's one-time invite lives (invites.js; tests only).
function createLinks({ dir, defaultName, kind, version, api, log = () => {}, discover = true, relayOnly = false, listen = "", inviteTtlMs = 0 }) {
  const out = new EventEmitter();
  const links = new Map();   // peer id -> { link, initiatedHere, info, address, port }
  const retries = new Map(); // peer id -> { timer, delay }
  const incompatible = new Map(); // peer id -> explicit update-required reason
  const adopting = new Map();     // peer id -> its links still waiting for hello (adopt), which forget() closes too
  let identity = null, peers = null, server = null, discovery = null, running = false;
  let guard = createPairGuard();
  // Connections that have not shown who they are yet (pair-guard.js createAdmission).
  const admission = createAdmission();
  const invites = createInvites(inviteTtlMs ? { ttlMs: inviteTtlMs } : {});

  const relay = require("./relay").createRelay({
    self: () => self(),
    neighbors: () => new Map([...links].filter(([, n]) => !n.routed && !n.web && n.info.relay === 1)),
    leaves: () => new Map([...links].filter(([, n]) => n.web)),
    changed: () => { out.emit("discovered", discovered()); connectAll(); changed(); },
    // A phone's tunnel that ends here, from the node `origin` as the neighbour `via` that brought it says (viaSource).
    acceptWeb: (io, via, origin) => {
      const f = webLink.framedPipe(io);
      const source = viaSource(via, origin);
      onWebConnection(f.pipe, source, admission.admit(source, () => f.pipe.close()));
      return f;
    }
  });
  const discovered = () => {
    const found = new Map((discovery?.list() || []).map(n => [n.id, n]));
    for (const r of relay.list()) if (r.path.length > 2 && !found.has(r.id)) found.set(r.id, { ...r, address: r.id, port: 0, via: r.path.slice(1, -1) });
    return [...found.values()];
  };
  const self = () => (!identity ? null : { id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, port: server?.port() || identity.settings.port,
    discoverable: identity.settings.discoverable, proxy: identity.settings.proxy, code: peers.code(), pairFailures: guard.stats() });
  // relayOnly: this node serves no api (its installer set none); peers use it to skip resource fetches and to label it.
  // web: 1 - this node takes web links and passes relay.open's `web` on (relay.js marks its routes so).
  const hello = () => ({ id: identity.id, name: identity.settings.name, kind, version, protocol: PROTOCOL, relay: 1, relayOnly, web: 1, port: server?.port() || 0 });
  // The kind a peer is shown and served as: what it says, except that "mobile" is what was paired, never what is said.
  const kindOf = (p, info) => (p.kind === "mobile" || info?.kind === "mobile" ? p.kind : info?.kind || p.kind);

  // ---------- the nodes as listed ----------
  // A phone is listed with relayOnly: it serves no api, so there is nothing of it to fetch.
  function nodes() {
    if (!peers) return []; // not started yet
    return peers.list().map(p => {
      const l = links.get(p.id);
      return { id: p.id, name: l?.info?.name || p.name, kind: kindOf(p, l?.info), version: l?.info?.version || "", address: l?.address || p.address, port: l?.port || p.port,
        via: l?.route?.slice(1, -1) || [], status: l ? "online" : "offline", error: incompatible.get(p.id) || "", relayOnly: p.kind === "mobile" || Boolean(l?.info?.relayOnly), lastSeen: l ? Date.now() : p.lastSeen, pairedAt: p.pairedAt };
    });
  }
  const changed = () => out.emit("nodes", nodes());

  // ---------- a link, whoever opened it ----------
  // The link is up once both said hello; a peer whose hello does not come is dropped. web: a phone's web link - what
  // its handshake gave ({ hash, initiator, responder }, hex), which a pairing on it is bound to.
  async function adopt(ws, id, { initiatedHere, address, port, route, web }) {
    const peer = peers.get(id);
    // A phone only over a web link, and a computer never over one.
    if (!peer || (peer.kind === "mobile") !== Boolean(web)) {
      ws.close(1008, "unpaired");
      return null;
    }
    // Whether the peer this link was adopted for is still paired, as it was: not forgotten meanwhile (while its hello
    // was awaited, or since), and not paired anew as something else - a phone and a computer never pass for each other,
    // and a phone's key is the one it came with (peers.js). Everything the link carries is checked against it, and
    // fails closed: a link whose peer is gone is closed, whatever it asks.
    const stillPaired = () => {
      const p = peers.get(id);
      return Boolean(p) && (p.kind === "mobile") === (peer.kind === "mobile") && p.key === peer.key;
    };
    const unpaired = () => {
      link.close(1008, "unpaired");
      return new HostError("unpaired", "This node is not paired with yours.");
    };
    let info = null;
    // A new name from a hello again: shown, kept, and passed on in the routes (a computer's, relay.js). A link not yet
    // taken (adopt below) keeps it in `info`, which is what it is taken with.
    const renamed = next => {
      const name = typeof next === "string" ? next.trim().slice(0, 60) : "";
      if (!name || name === info.name || !stillPaired()) return;
      info.name = name;
      if (links.get(id)?.link !== link) return;
      peers.update(id, { name });
      relay.refresh();
      log(`renamed: ${name} (${id.slice(0, 8)})`);
      changed();
    };
    // A node this one trusts that pairs again (it forgot this one): the code is asked of it as of anyone, or whoever
    // answered in this node's place would be trusted for nothing.
    const again = { key: `peer:${id}`, label: peer.name || id.slice(0, 8) };
    let repair = null;
    let settleHello;
    const helloSeen = new Promise(r => { settleHello = r; });
    const link = createLink(ws, {
      onRequest: (method, params) => {
        if (!stillPaired()) throw unpaired();
        if (method === "pair.invite" || method === "peers.revoke") {
          if (!info) throw new HostError("handshake", "The protocol handshake has not completed.");
          return manage(id, method, params);
        }
        if (method === "pair" || method.startsWith("pair.")) {
          if (method === "pair.start") repair = pairing({ id, source: again, web });
          const step = repair || pairing({ id, source: again, web });
          if (method !== "pair.start") repair = null;
          return step(method, params, (code, message) => { repair = null; throw new HostError(code, message); });
        }
        if (!info) throw new HostError("handshake", "The protocol handshake has not completed.");
        if (method.startsWith("relay.")) return relay.request(id, method, params);
        // This computer is a relay only (its installer set no api): it routes traffic but runs no sessions of its own.
        if (relayOnly) throw new HostError("relayOnly", "This computer is a relay only; it runs no sessions or terminals.");
        // A host peer (a VPS/relay, or a resource host) may route traffic and be used as a resource, but not act on this
        // computer; a desktop peer may. Set from the peer's kind when pairing (peers.js), so a broken or hostile relay
        // cannot reach into the computers it connects. Relaying and using a host as a resource are never affected.
        // Only a peer that may (control === true) gets through; anything else, or nothing, is refused.
        if (peers.get(id)?.control !== true) throw new HostError("relayOnly", "This node may relay but not control this computer.");
        return api(method, params, { id, name: info?.name || peer.name, kind: kindOf(peer, info) });
      },
      onBinary: data => {
        if (!info) return;
        if (!stillPaired()) return void unpaired();
        out.emit("binary", { node: id, data });
      },
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
          // A hello on a link already greeted: the node was renamed (setSelf here, setName on a phone). Only the name
          // is taken; the rest stays as first said.
          if (info) return void renamed(data.name);
          info = data;
          incompatible.delete(id);
          settleHello(true);
          return;
        }
        if (!info) return;
        if (!stillPaired()) return void unpaired();
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
    if (!adopting.has(id)) adopting.set(id, new Set());
    adopting.get(id).add(link);
    const greeted = await helloSeen;
    clearTimeout(helloTimer);
    adopting.get(id)?.delete(link);
    if (!adopting.get(id)?.size) adopting.delete(id);
    if (!greeted || !link.isOpen()) {
      link.close(1002, "no hello");
      return null;
    }
    // Forgotten (or paired anew as another) while its hello was awaited: what was read of it at the start is stale.
    if (!stillPaired()) {
      unpaired();
      return null;
    }
    // Two links to the same node: the one its smaller-id end opened stays. A phone always calls; its newest link is
    // the one that works (the older is a network it left).
    const other = links.get(id);
    if (other) {
      const keepThis = Boolean(web) || initiatedHere === (identity.id < id);
      if (!keepThis) {
        link.close(1000, "duplicate");
        return other.link;
      }
      links.delete(id);
      // The tunnels the phone had opened on its old link are as dead as the link.
      if (web) relay.down(id);
      other.link.close(1000, "duplicate");
    }
    if (!web && !route && info.routed && Array.isArray(info.route) && info.route[0] === id && info.route.at(-1) === identity.id) route = [...info.route].reverse();
    const entry = { link, initiatedHere, info, address, route, web: Boolean(web), routed: Boolean(route || (!web && info.routed)), port: web ? 0 : Number(info.port) || port };
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
    // A phone is never called: it calls.
    if (!running || links.has(id) || !peers.get(id) || peers.get(id).kind === "mobile" || incompatible.has(id)) return;
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
  // Where a connection came from, for pair-guard.js: { key, group, label } - its IPv4 address or IPv6 /64
  // (addressSource), or the neighbour whose relay tunnel brought it (those all come from 127.0.0.1), keyed by its id (a
  // name it could change) and shown by name.
  function sourceOf(address, port) {
    const a = addressSource(address);
    const via = a.loopback ? relay.sourceOf(port) : "";
    if (!via) return { key: a.key, group: a.key, label: a.address || "?" };
    return viaSource(via);
  }
  // A tunnel through neighbour `via`. A phone's (web) tunnel also names the node that opened it (`origin`, relay.js):
  // the neighbour vouches for it - it knows its own phones (leaves) by their keys, and passes on what its neighbour
  // said. The key is then that node behind that neighbour, so one party the relay lets open tunnels (a phone paired
  // with it, say) waits, is throttled and is pushed out on its own, not with every phone behind the same relay. The
  // phone's Noise key could not be the key: it is known only after the handshake, and anyone can make new ones. A
  // neighbour that lies about the origin could have dropped the tunnels anyway; it stays inside its own group (the
  // neighbour), so it cannot crowd out connections that come another way (pair-guard.js createAdmission).
  const viaSource = (via, origin = "") => {
    const by = `via ${links.get(via)?.info?.name || via.slice(0, 8)} (${via.slice(0, 8)})`;
    if (!origin || origin === via) return { key: `via:${via}`, group: `via:${via}`, label: by };
    return { key: `via:${via}:${origin}`, group: `via:${via}`, label: `${by} from ${origin.slice(0, 8)}` };
  };
  // The answering side of one pairing with node `id` (pair-proof.js): "pair.start" exchanges the points, "pair.finish"
  // checks the caller's proof of this node's code and answers with this node's own. One try, and only as often as
  // pair-guard.js lets that source try. address: where the node called from (omitted for one that is known already:
  // what is kept of it stays). web: over a phone's web link, its handshake ({ hash, initiator, responder }): the proof
  // is bound to it (not to the two ids) and the phone is kept by its key. The code a pairing is for (codeOf): this
  // node's own, or - over a web link only, so only for a phone - the one-time invite pair.start names by its tag
  // (invites.js, docs/MOBILE.md 4). An invite goes after its one try, right or wrong; a pairing by invite leaves this
  // node's own code as it is. -> (method, params, refuse) => the answer; refuse(code, message) throws.
  function pairing({ id, source, address, web, paired = () => {} }) {
    let session = null, tried = false;
    // -> { code, invite } (invite null: this node's own code), or null: the invite named is not there.
    const codeOf = params => {
      if (!web || params?.invite === undefined) return { code: peers.code(), invite: null };
      const invite = invites.find(params.invite);
      return invite && { code: invite.code, invite };
    };
    // A wrong try, also one at an invite that is not there: counted against the source (its pair.start was already,
    // pair-guard.js started), and the code it was for goes (an invite at once; this node's own after a few, peers.js).
    const missed = invite => {
      guard.failed(source.key, source.label, { started: true });
      if (invite) invites.use(invite); else if (invite === null) peers.miss();
      log(`wrong pairing code from ${source.label}`);
      out.emit("self", self());
    };
    const expired = "That pairing code has expired or was used already; make a new one.";
    return (method, params, refuse) => {
      // An AgentDeck from before codes were proven sends the code itself.
      if (method === "pair") refuse("pairOutdated", "That AgentDeck is older and pairs in a way this one no longer accepts. Update it and pair again.");
      const wait = started => {
        const may = guard.allowed(source.key, { started });
        if (!may.ok) refuse("pairLater", `Too many wrong pairing codes; try again in ${Math.ceil(may.waitMs / 1000)} s.`);
      };
      if (method === "pair.start") {
        if (session || tried) refuse("pairLater", "One pairing code per connection.");
        wait(false);
        // Counted now, before the work: a start that is never finished is throttled as a wrong code is.
        guard.started(source.key);
        const want = codeOf(params);
        if (!want) {
          tried = true;
          missed(undefined);
          refuse("inviteExpired", expired);
        }
        try {
          const proof = web
            ? pairProof.start({ code: want.code, initiator: web.initiator, responder: web.responder, binding: web.hash, role: "responder" })
            : pairProof.start({ code: want.code, initiator: id, responder: identity.id, role: "responder" });
          session = { ...want, y: proof.y, ...proof.finish(params?.y) };
        } catch {
          refuse("invalidData", "That is not a pairing request.");
        }
        return { y: session.y };
      }
      if (method !== "pair.finish") refuse("unpaired", "This node is not paired with yours.");
      if (!session || tried) refuse("pairLater", "One pairing code per connection.");
      tried = true;
      wait(true);
      // The code was replaced meanwhile (another pairing, or too many wrong tries; the invite used or expired): this
      // try was for the old one.
      if (session.invite ? !invites.live(session.invite) : session.code !== peers.code()) refuse(session.invite ? "inviteExpired" : "wrongCode", session.invite ? expired : "The pairing code is wrong.");
      if (!pairProof.same(params?.mac, session.expect)) {
        missed(session.invite);
        refuse("wrongCode", "The pairing code is wrong.");
      }
      guard.succeeded(source.key);
      if (session.invite) invites.use(session.invite);
      const p = params || {};
      // A phone is "mobile" with the key it showed; a computer is never "mobile" (peers.js).
      if (web) peers.add({ id, name: String(p.name || "").slice(0, 60), kind: "mobile", key: web.initiator, address: "", port: 0 });
      else peers.add({ id, name: String(p.name || "").slice(0, 60), kind: p.kind === "host" ? "host" : "desktop", ...(address === undefined ? {} : { address: p.routed ? "" : address, port: p.routed ? 0 : Number(p.port) || 0 }) });
      if (!session.invite) peers.regenerate();
      out.emit("self", self());
      log(`paired with ${p.name || id.slice(0, 8)} (it called${session.invite ? ", by invite" : ""})`);
      paired();
      return { ok: true, mac: session.own, id: identity.id, name: identity.settings.name, kind, version };
    };
  }
  // Too many wait to pair: the pairing side hears why (a code it can translate), then the socket goes. It keeps the
  // place it had as one not known yet (admitted) until then, so these cannot pile up either.
  function turnAway(ws, admitted) {
    const busy = createLink(ws, { onRequest: () => { throw new HostError("pairBusy", "This computer is busy with other pairing attempts; try again shortly."); }, onClose: admitted });
    ws.resume?.();
    setTimeout(() => { busy.close(1013, "busy"); ws.terminate(); }, BUSY_ANSWER_MS).unref?.();
  }
  // An unknown node may only pair: it proves it knows this node's code, and is trusted from then on. admitted: the
  // place it took as one not known yet (server.js), given back now that it showed its certificate - an unknown one
  // takes a place among those waiting to pair instead.
  function onConnection(ws, { id, address, port, release: admitted = () => {} }) {
    if (!id) {
      admitted();
      ws.close(1008, "no certificate");
      return;
    }
    if (peers.get(id)) {
      admitted();
      adopt(ws, id, { initiatedHere: false, address, port: 0 }).catch(e => console.error("Adopting a link failed:", e.message));
      return;
    }
    const source = sourceOf(address, port);
    const release = guard.admit(source.key);
    if (!release) return void turnAway(ws, admitted);
    admitted();
    // A client that says nothing in time goes at once (terminate): a graceful close would keep its place until the
    // close handshake times out too.
    const timer = setTimeout(() => { link.close(1008, "unpaired"); ws.terminate(); }, PAIR_TIMEOUT_MS);
    // The error goes out first, then the connection closes.
    const refuse = (code, message) => {
      setTimeout(() => link.close(1008, code), 100).unref?.();
      throw new HostError(code, message);
    };
    const step = pairing({ id, source, address, paired: () => {
      clearTimeout(timer);
      // Pairing has its own parser. Reconnect for hello rather than attaching two parsers/heartbeats to one socket.
      setImmediate(() => { link.close(1000, "paired"); changed(); });
    } });
    const link = createLink(ws, {
      onRequest: async (method, params) => step(method, params, refuse),
      onClose: () => { clearTimeout(timer); release(); }
    });
  }
  // A phone's web link (web-link.js), from the server's plain WebSocket or from a relay tunnel: pipe carries Noise
  // messages; source: where it came from, for pair-guard.js; admitted: the place it took as one not known yet
  // (server.js, or the relay's acceptWeb: pair-guard.js createAdmission), which also closes it when that place is taken
  // back - at the latest ADMIT_MS after it came. After the handshake the phone is its key, and gives that place back: a
  // paired phone's link is adopted (it never waits for a place among those that pair), an unknown key may only pair
  // (bound to this handshake) and takes a place among those waiting to pair for PAIR_TIMEOUT_MS - or is told the node
  // is busy - and one that only says hello is told it is not paired.
  function onWebConnection(pipe, source, admitted = () => {}) {
    webLink.handshake(pipe, { initiator: false, s: identity.noise, wrapBinary: b => Buffer.from(b.buffer, b.byteOffset, b.byteLength) }).then(({ socket, remoteKey, hash }) => {
      const key = Buffer.from(remoteKey).toString("hex"), id = idOf(remoteKey);
      const web = { hash: Buffer.from(hash).toString("hex"), initiator: key, responder: Buffer.from(identity.noise.publicKey).toString("hex") };
      const peer = peers.get(id);
      if (peer) {
        admitted();
        if (peer.kind === "mobile" && peer.key === key) adopt(socket, id, { initiatedHere: false, address: "", port: 0, web }).catch(e => console.error("Adopting a link failed:", e.message));
        else socket.close(1008, "unpaired");
        return;
      }
      // Pairing messages are small: an unknown key gets no room for megabytes.
      socket.limit(64 * 1024);
      const release = guard.admit(source.key);
      if (!release) return void turnAway(socket, admitted);
      admitted();
      // One that does not pair in time goes at once (terminate), as an unpaired TLS one does.
      const timer = setTimeout(() => socket.terminate(), PAIR_TIMEOUT_MS);
      const done = () => { clearTimeout(timer); release(); };
      const refuse = (code, message) => {
        setTimeout(() => link.close(1008, code), 100).unref?.();
        throw new HostError(code, message);
      };
      const step = pairing({ id, source, web, paired: () => {
        clearTimeout(timer);
        setImmediate(() => { link.close(1000, "paired"); changed(); });
      } });
      const link = createLink(socket, {
        onRequest: async (method, params) => step(method, params, refuse),
        // A phone this node forgot (or never knew) that comes to talk, not to pair.
        onEvent: name => { if (name === "hello") link.close(1008, "unpaired"); },
        onClose: done
      });
      socket.resume();
    }, () => admitted());
  }

  // ---------- pairing from here ----------
  // Pairs with the node at address:port, whose code (from its Settings or its installer) is `code`. The code is not
  // sent: this node proves it knows it, and the node that answers must prove the same before it is trusted here
  // (pair-proof.js) - so a node that merely answers at that address, or sits on the way, gets nothing.
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
      const proof = pairProof.start({ code, initiator: identity.id, responder: id, role: "initiator" });
      const s = await link.call("pair.start", { y: proof.y }, { timeout: PAIR_TIMEOUT_MS });
      let proofs;
      try { proofs = proof.finish(s?.y); } catch { throw new HostError("pairUnproven", "The computer that answered did not prove it knows the pairing code."); }
      r = await link.call("pair.finish", { mac: proofs.own, routed: Boolean(route), name: identity.settings.name, kind, version, port: server?.port() || 0 }, { timeout: PAIR_TIMEOUT_MS });
      if (!pairProof.same(r?.mac, proofs.expect)) throw new HostError("pairUnproven", "The computer that answered did not prove it knows the pairing code.");
    } catch (e) {
      link.close();
      // An AgentDeck from before codes were proven knows only "pair" (and would be sent the code itself).
      if (e.code === "unpaired" || e.code === "handshake") throw new HostError("pairOutdated", "That AgentDeck is older and pairs in a way this one no longer accepts. Update it and pair again.");
      throw e;
    }
    peers.add({ id, name: String(r?.name || "").slice(0, 60), kind: r?.kind === "host" ? "host" : "desktop", address: route ? "" : address, port: route ? 0 : port });
    // Through a relay `address` is the node's id: the relay it went through is what says where.
    const hop = route && (links.get(route[1])?.info?.name || peers.get(route[1])?.name || route[1].slice(0, 8));
    log(`paired with ${r?.name || id.slice(0, 8)} ${route ? `through ${hop}` : `at ${address}:${port}`}`);
    // The socket is handed over whole: its handlers go with the pairing link, so a fresh connection is simplest.
    link.close(1000, "paired");
    changed();
    scheduleConnect(id, 0);
    return { id, name: r?.name || "", kind: r?.kind || "desktop", already: false };
  }
  // ---------- phones: invites and revoking (docs/MOBILE.md 4, 5) ----------
  // A one-time pairing code for a phone, made here: what pair.invite answers, and what this node's own Settings use.
  // key: this node's Noise public key (hex), which the phone checks at the handshake.
  function invite() {
    const { code, expires } = invites.mint();
    return { id: identity.id, key: Buffer.from(identity.noise.publicKey).toString("hex"), name: identity.settings.name, kind, code, expires };
  }
  // What a paired computer may ask of this node about its peers. pair.invite {} -> invite(): for a peer that may
  // control this node (a desktop), and on a relay-only node for any paired computer (the relay runs nothing a phone
  // could reach; it only routes). peers.revoke { id } -> { removed }: forgets a phone, for a peer that may control this
  // node, and only a phone - a computer is forgotten by hand where it is paired. Never for a phone: a lost one must
  // not let others in, nor shut its owner's other phones out.
  function manage(from, method, params) {
    const p = peers.get(from);
    const computer = Boolean(p) && p.kind !== "mobile";
    if (method === "pair.invite") {
      if (!computer || !(p.control === true || relayOnly)) throw new HostError("notAllowed", "Only a computer that may control this one can ask it for a pairing code.");
      log(`a pairing invite for a phone, asked by ${p.name || from.slice(0, 8)}`);
      return invite();
    }
    if (!computer || p.control !== true) throw new HostError("notAllowed", "Only a computer that may control this one can make it forget a phone.");
    const target = params?.id;
    if (typeof target !== "string" || !ID.test(target)) throw new HostError("invalidData");
    const t = peers.get(target);
    if (!t) return { removed: false };
    if (t.kind !== "mobile") throw new HostError("notAllowed", "Only a phone can be forgotten this way.");
    log(`phone ${t.name || target.slice(0, 8)} forgotten, asked by ${p.name || from.slice(0, 8)}`);
    forget(target);
    return { removed: true };
  }

  // "Forget" on a phone, everywhere: on every computer and relay this node is paired with (peers.revoke), and here.
  // -> the names of those that could not hear it now (offline, or too old to know it): the phone may still be paired
  // there. Each node that forgets the phone tells it so while it still reaches it (forget below), and the phone drops
  // that one. So the relays go last: the phone reaches the computers through them, and a relay that forgot it first
  // would leave the computers no way to tell it. A computer's "forget" travels through the relay as relay.data on its
  // own link, so the relays are asked settleMs after the computers answered, once that is through.
  async function forgetPhone(id, { settleMs = 1000, timeout = 10000 } = {}) {
    if (peers?.get(id)?.kind !== "mobile") return [];
    const still = [];
    const revoke = list => Promise.all(list.map(async n => {
      try {
        if (n.status !== "online") throw new HostError("offline");
        await call(n.id, "peers.revoke", { id }, { timeout });
      } catch { still.push(n.name || n.id.slice(0, 8)); }
    }));
    const all = nodes().filter(n => n.kind !== "mobile"), relays = all.filter(n => n.relayOnly);
    await revoke(all.filter(n => !n.relayOnly));
    forget(id);
    if (relays.length) {
      await new Promise(r => setTimeout(r, settleMs));
      await revoke(relays);
    }
    return still;
  }

  // tell: the other side hears of it (and forgets this node) before the link closes.
  function forget(id, { tell = true } = {}) {
    incompatible.delete(id);
    const l = links.get(id);
    links.delete(id);
    relay.down(id);
    if (l && tell) l.link.notify("forget", {});
    l?.link.close(1000, "forgotten");
    // A link of it that is still waiting for its hello goes too (adopt checks again before it counts, as well).
    for (const waiting of adopting.get(id) || []) waiting.close(1008, "unpaired");
    adopting.delete(id);
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
  // May node `id` see what goes on here - this computer's sessions, live status, git, usage, terminals, the project
  // layout? Only a peer that may also control it (control === true: a desktop or a phone, peers.js): a host - a relay,
  // a resource host - routes and is used, but nothing here is any of its business, so a relay sees only the metadata
  // it routes by (docs/MESH.md 4). phones: false - not a phone either (what only computers use: layout.sync).
  function sees(id, { phones = true } = {}) {
    const p = peers?.get(id), l = links.get(id);
    return Boolean(p) && p.control === true && !l?.info?.relayOnly && (phones || p.kind !== "mobile");
  }
  // An app event (serve.js, layout.js) to every connected node that may see it (sees).
  function notifyAll(name, data, opts) {
    for (const [id, l] of links) if (sees(id, opts)) l.link.notify(name, data);
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
    // A new name reaches the linked nodes at once: a hello again, which they take as a rename (adopt); a node from
    // before that ignores it and learns the name with its next link.
    if (keys.includes("name") && running) for (const l of links.values()) l.link.notify("hello", hello());
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
    server = createServer({ identity, onConnection,
      admit: (address, kill) => { const a = addressSource(address); return admission.admit({ source: a.key }, kill); },
      onWebConnection: (ws, { address, port, release }) => onWebConnection(webLink.wsPipe(ws), sourceOf(address, port), release) });
    await server.start(identity.settings.port, listen || undefined);
    announce();
  }
  function regenerateCode() {
    peers.regenerate();
    out.emit("self", self());
    return peers.code();
  }
  // A file of the node that cannot be read (identity.js readKept: code "unreadable") rejects, with nothing started:
  // the caller shows it and may try again.
  async function start() {
    const id = await loadIdentity(dir, { defaultName });
    peers = createPeers(dir, { long: kind === "host" });
    identity = id;
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
    out.emit("self", self());
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
    start, stop, self, setSelf, regenerateCode, nodes, discovered, pair, forget, forgetPhone, invite, call, notify, notifyAll, sees, sendBinary, online,
    peers: () => peers, identity: () => identity
  });
}

module.exports = { createLinks, PROTOCOL };
