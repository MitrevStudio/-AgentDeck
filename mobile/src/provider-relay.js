// The real provider (the interface is documented at the top of data.js): the user's computers through their relay,
// over the shared mesh code bundled as it is from ../src/mesh - web-client.js (WebSocket + Noise XX to the relay and,
// inside its tunnels, to every paired computer), frames.js (terminal bytes) and pair-code.js (the QR payload).
//
// createRelayProvider({ WebSocket, keypair, peers, name, version, meta, onPeersChanged, onMetaChanged, log })
//   keypair: { publicKey, privateKey } (Uint8Array) - the phone's identity, made once and kept by keystore.js
//   peers: the saved list (web-client.js's onPeersChanged shape); onPeersChanged(list): save it
//   meta: { [id]: { relay: bool, lastSeen: ms } } - what is remembered of a node beyond the pairing (shown while it is
//     offline: that it is a relay, when it was last seen); onMetaChanged(meta): save it (nothing secret)
//
// Beyond data.js's interface it offers the pairing (pairAll, pairDirect, pairVia, routes), pause() (the app went to the
// background: nothing is dialled until wake), wake() (the app came back to the foreground or the network changed:
// what is not linked is dialled at once, dead links are found and made again, live ones stay), setName and
// connection().
//
// A phone forgotten elsewhere is told so by each node while the node can reach it ("forget": web-client.js drops it).
// When that did not happen - the relay forgot the phone first, so the computers behind it could not tell it - the
// phone finds out on its own: a relay that answers "unpaired" is dropped (it would only be dialled in vain), and a
// computer left with no relay or address to reach it by says so (error "noHub": pair it again) rather than waiting.
import { emitter } from "./util.js";
import { createWebClient } from "../../src/mesh/web-client.js";
import * as frames from "../../src/mesh/frames.js";
import * as pairCode from "../../src/mesh/pair-code.js";

const PROBE_MS = 4000;
const DEAD = new Set(["timeout", "closed", "offline"]);

export function createRelayProvider({ WebSocket = globalThis.WebSocket, keypair, peers = [], name = "Phone", version = "", meta = {}, onPeersChanged = () => {}, onMetaChanged = () => {}, log = () => {} }) {
  const ev = emitter();
  let started = false, pairing = 0;
  const info = { ...meta };

  const touchMeta = (id, patch) => {
    const before = JSON.stringify(info[id] || {});
    info[id] = { ...info[id], ...patch };
    if (JSON.stringify(info[id]) !== before) { try { onMetaChanged({ ...info }); } catch {} }
  };

  // One web client for the provider's life: wake and a new name act on its links (retryNow, setName) rather than
  // making them all again.
  const client = createWebClient({
    WebSocket, keypair, peers: peers.map(p => ({ ...p })), name, version, log,
    onPeersChanged: list => {
      for (const id of Object.keys(info)) if (!list.some(p => p.id === id)) delete info[id];
      try { onPeersChanged(list); } catch {}
      try { onMetaChanged({ ...info }); } catch {}
    }
  });
  client.on("nodes", list => {
    for (const n of list) if (n.status === "online") touchMeta(n.id, { lastSeen: Date.now(), ...(n.relayOnly ? { relay: true } : {}) });
    // A relay that does not know this phone any more is dropped (after this event: forget emits "nodes" again).
    const gone = list.filter(n => n.status !== "online" && n.error === "unpaired" && n.address && (n.relayOnly || info[n.id]?.relay));
    if (gone.length) queueMicrotask(() => {
      for (const n of gone) {
        log(`dropped ${n.name || n.id.slice(0, 8)}: the relay does not know this phone any more`);
        client.forget(n.id, { tell: false });
      }
    });
    ev.emit("nodes", nodes());
  });
  client.on("routes", list => ev.emit("routes", list));
  client.on("link", l => ev.emit("link", l));
  client.on("event", ({ node, name: event, data }) => ev.emit("notify", { node, event, payload: data }));
  client.on("binary", ({ node, data }) => {
    const frame = frames.decode(data);
    if (frame?.type === "output") ev.emit("frame", { node, frame });
  });
  let label = client.setName(name);

  // web-client.js's nodes as data.js wants them. A computer reached only through a hub, with no hub left at all, has
  // no way to be reached: error "noHub" (whatever its last try said).
  function nodes() {
    const list = client.nodes(), noHub = !list.some(n => n.address);
    return list.map(n => {
      const m = info[n.id] || {};
      const relay = n.relayOnly || Boolean(m.relay);
      return {
        id: n.id, name: n.name || n.id.slice(0, 8), kind: relay ? "relay" : n.kind === "host" ? "headless" : "desktop",
        version: n.version, status: n.status, error: n.status !== "online" && noHub ? "noHub" : n.error, via: n.via ? [n.via] : [], direct: n.direct,
        hub: Boolean(n.address), address: n.address, port: n.port,
        lastSeen: n.status === "online" ? Date.now() : m.lastSeen || 0
      };
    });
  }

  // Is the relay reachable at all: "none" (nothing paired), "nohub" (computers, but no relay or address to dial: they
  // have to be paired again), "connecting" (no hub online yet, none failed), "down" (no hub online; error: why the
  // last one failed), "ok".
  // name: the hub's (a relay, or the computer itself when there is no relay).
  function connection() {
    const list = nodes(), hubs = list.filter(n => n.hub);
    if (!list.length) return { state: "none", error: "", name: "" };
    if (!hubs.length) return { state: "nohub", error: "", name: "" };
    if (hubs.some(n => n.status === "online")) return { state: "ok", error: "", name: "" };
    const failed = hubs.find(n => n.error);
    return { state: failed ? "down" : "connecting", error: failed?.error || "", name: (failed || hubs[0])?.name || "" };
  }

  // Back in the foreground / the network changed / "Try now": every node that is not linked is dialled now rather
  // than at its next backoff step (up to 30 s), and a link that does not answer within PROBE_MS is made again; the
  // links that answer stay as they are.
  async function wake() {
    if (!started) return;
    client.resume();
    client.retryNow();
    const up = client.nodes().filter(n => n.status === "online");
    const alive = await Promise.all(up.map(n => client.call(n.id, "host.info", {}, { timeout: PROBE_MS }).then(() => true, e => !DEAD.has(e?.code))));
    const dead = up.filter((_, i) => !alive[i]).map(n => n.id);
    // A pairing in progress is not cut off (its tunnel may go through a link that is slow to answer).
    if (dead.length && started && !pairing) client.retryNow({ drop: dead });
  }

  // pairAll with a progress report: onProgress([{ id, name, kind, state: "pending" | "paired" | "already" | "failed",
  // error }]) as each node gets paired (a peer appears) and once more at the end.
  async function pairAll(text, onProgress = () => {}) {
    const payload = pairCode.decode(text);
    const rows = [...(payload.r ? [{ id: payload.r.id, name: payload.r.n, kind: "relay" }] : []), ...payload.n.map(x => ({ id: x.id, name: x.n, kind: x.t }))]
      .map(r => ({ ...r, state: "pending", error: "" }));
    const report = () => { try { onProgress(rows.map(r => ({ ...r }))); } catch {} };
    report();
    const c = client;
    const before = new Set(c.peers().map(p => p.id));
    const off = (() => {
      const fn = () => {
        let changed = false;
        for (const r of rows) if (r.state === "pending" && !before.has(r.id) && c.peers().some(p => p.id === r.id)) { r.state = "paired"; changed = true; }
        if (changed) report();
      };
      c.on("nodes", fn);
      return () => c.off("nodes", fn);
    })();
    pairing++;
    try {
      const results = await pairCode.pairAll(c, payload);
      for (const x of results) {
        const r = rows.find(y => y.id === x.id);
        if (!r) continue;
        r.state = x.ok ? (x.already ? "already" : "paired") : "failed";
        r.error = x.error || "";
        if (x.kind === "relay" && x.ok) touchMeta(x.id, { relay: true });
      }
    } finally { off(); pairing--; }
    report();
    return rows;
  }
  const guarded = fn => async (...a) => { pairing++; try { return await fn(...a); } finally { pairing--; } };

  return {
    demo: false,
    on: ev.on,
    get id() { return client.id; },
    async start() { started = true; client.start(); },
    stop() { started = false; client.stop(); },
    nodes,
    connection,
    request: (node, method, params = {}, opts) => client.call(node, method, params, opts),
    sendFrame(node, frame) {
      const bytes = frame.type === "input" ? frames.encodeInput(frame.id, frame.data)
        : frame.type === "resize" ? frames.encodeResize(frame.id, frame.cols, frame.rows) : null;
      if (bytes) client.sendBinary(node, bytes);
    },
    async forget(id) { client.forget(id); },
    // The app is in the background: no dialling until wake().
    pause() { if (started) client.pause(); },
    wake,
    // The name the computers know the phone by: the linked ones are told at once, the others when they link.
    setName(next) { label = client.setName(next); },
    get name() { return label; },

    // ---------- pairing ----------
    decode: text => pairCode.decode(text),
    pairAll,
    // A relay or a computer at an address, with its own code (a relay's long code, a computer's six digits).
    pairDirect: guarded((address, port, code) => client.pairDirect(address, port, code)),
    // A computer the connected relay reaches, with its six-digit code.
    pairVia: guarded((id, code) => client.pairVia(id, code)),
    // [{ id, name, kind, via, web, paired }]: what the connected hubs can reach.
    routes: () => client.routes(),
    peers: () => client.peers()
  };
}
