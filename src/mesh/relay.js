// Path-vector discovery and bounded byte tunnels. Only the local mesh listener is
// reachable at the end of a tunnel; TLS and pairing still happen end to end.
//
// Phones (kind "mobile", docs/MOBILE.md 3.2) are leaves: a leaf gets the routes and may open tunnels, but is never a
// route itself and no tunnel is ever opened to it (open() only goes to neighbours). A tunnel opened with `web: true`
// carries a web link (web-link.js) instead of TLS: every hop passes the flag on, and the last one hands the stream to
// this node's web acceptor in this process (acceptWeb) instead of connecting to its own TLS port. A route says
// `web: true` when every node on it knows the flag - an older node drops it from what it passes on - so a phone can
// tell "that computer needs an update" before it tries.
const { Duplex } = require("node:stream");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const ID = /^[a-f0-9]{64}$/;
const MAX_HOPS = 8;
const MAX_LEAF_TUNNELS = 32;
// What a web tunnel's last hop may hold for a slow phone before it gives up on it (more than one frame of the link
// protocol, web-link.js MAX_FRAME, with what Noise adds to it), and what all the web tunnels that came through one
// neighbour may hold together: the neighbour acknowledges what it is sent (relay.data), and one that never does - a
// broken or hostile relay - holds at most this much here, however many tunnels it opens. Another neighbour's tunnels
// are not affected.
const MAX_WEB_BUFFER = 32 * 1024 * 1024;
const MAX_WEB_BUFFER_VIA = 48 * 1024 * 1024;
// neighbors() / leaves(): Map peer id -> its link entry (links.js). acceptWeb(io, via, origin) -> { input(bytes),
// end() }: io = { send(bytes), close() } is the tunnel's way back; via: the neighbour it came through; origin: the node
// that opened it, as that neighbour says (relay.open `from`; the neighbour itself when it says nothing).
function createRelay({ self, neighbors, leaves = () => new Map(), changed, acceptWeb }) {
  const adverts = new Map(), channels = new Map(), inputs = new Set();
  const webEnds = new Set(); // { via, stream } of the web tunnels that end here
  // The local port of each tunnel's last hop into this node's own listener -> the neighbour it came through: those
  // connections all come from 127.0.0.1, and pairing tries are counted by where they came from (sourceOf).
  const tunnelPorts = new Map();
  let routes = new Map(), signature = "";
  const key = (peer, id) => `${peer}:${id}`;
  const linkOf = peer => neighbors().get(peer) || leaves().get(peer);
  function refresh() {
    const next = new Map();
    const choose = r => {
      const old = next.get(r.id);
      if (!old || r.path.length < old.path.length || (r.path.length === old.path.length && r.path.join() < old.path.join())) next.set(r.id, r);
    };
    for (const [id, n] of neighbors()) {
      choose({ id, name: n.info.name, kind: n.info.kind, path: [self().id, id], web: n.info.web === 1 });
      for (const r of adverts.get(id) || []) {
        if (r.path.includes(self().id) || r.path.length >= MAX_HOPS) continue;
        choose({ ...r, path: [self().id, ...r.path] });
      }
    }
    routes = next;
    const sig = JSON.stringify([...routes.values()].sort((a, b) => a.id.localeCompare(b.id)));
    if (sig !== signature) { signature = sig; broadcast(); changed(); }
  }
  function broadcast() {
    const list = [...routes.values()].slice(0, 512);
    for (const n of neighbors().values()) n.link.notify("relay.routes", list);
    for (const n of leaves().values()) n.link.notify("relay.routes", list);
  }
  function event(peer, name, data) {
    if (name !== "relay.routes") return false;
    if (!neighbors().has(peer) || !Array.isArray(data) || data.length > 512) return true;
    adverts.set(peer, data.filter(r => r && ID.test(r.id) && Array.isArray(r.path) && r.path.length >= 2 && r.path.length <= MAX_HOPS && r.path[0] === peer && r.path.at(-1) === r.id && r.path.every(x => ID.test(x)) && new Set(r.path).size === r.path.length).map(r => ({ id: r.id, name: String(r.name || "").slice(0, 60), kind: r.kind === "host" ? "host" : "desktop", path: r.path, web: r.web === true })));
    refresh();
    return true;
  }
  function bind(peer, id, stream) {
    const k = key(peer, id);
    channels.set(k, stream);
    stream.on("error", () => {});
    stream.once("close", () => {
      if (channels.get(k) !== stream) return;
      channels.delete(k); inputs.delete(k);
      linkOf(peer)?.link.call("relay.close", { id }).catch(() => {});
    });
    return stream;
  }
  // from: with `web`, the node the tunnel is opened for (passed on as `from`, for the last hop's acceptWeb).
  async function open(path, { web = false, from = "" } = {}) {
    if (!Array.isArray(path) || path[0] !== self().id || path.length < 2 || path.length > MAX_HOPS || new Set(path).size !== path.length || !path.every(x => ID.test(x))) throw new Error("Invalid relay route");
    if (channels.size >= 128) throw new Error("Relay tunnel limit");
    const peer = path[1], n = neighbors().get(peer), id = randomUUID();
    if (!n) throw new Error("Relay unavailable");
    const stream = bind(peer, id, new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        (async () => {
          for (let i = 0; i < chunk.length; i += 32768) await n.link.call("relay.data", { id, data: chunk.subarray(i, i + 32768).toString("base64") });
        })().then(() => callback(), callback);
      }
    }));
    inputs.add(key(peer, id));
    // The flag only when set: what an older node is sent stays as it was.
    try { await n.link.call("relay.open", web ? { id, path, web: true, ...(from ? { from } : {}) } : { id, path }); return stream; }
    catch (e) { stream.destroy(); throw e; }
  }
  // The last hop of a web tunnel: a stream whose writes go to this node's web acceptor, and whose readable side
  // carries what the acceptor sends back.
  function webEnd(via, origin) {
    if (!acceptWeb) throw new Error("No web links here");
    let sink = null, ended = false;
    const s = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        try { sink.input(chunk); callback(); } catch (e) { callback(e); }
      },
      destroy(err, callback) { webEnds.delete(end); sink?.end(); callback(err); }
    });
    const end = { via, stream: s };
    webEnds.add(end);
    const heldVia = () => { let n = 0; for (const w of webEnds) if (w.via === via) n += w.stream.readableLength; return n; };
    sink = acceptWeb({
      send: bytes => {
        if (s.destroyed || ended) return;
        if (s.readableLength + bytes.length > MAX_WEB_BUFFER || heldVia() + bytes.length > MAX_WEB_BUFFER_VIA) s.destroy();
        else s.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      },
      // Ends after what is buffered went out (the "end" below destroys it then).
      close: () => { if (!s.destroyed && !ended) { ended = true; s.push(null); } },
      // What waits here for the tunnel to take it: the phone's link reports it (web-link.js bufferedAmount), so a
      // terminal's output to a phone that falls behind is held back (mesh/serve.js) before MAX_WEB_BUFFER closes it.
      buffered: () => s.readableLength
    }, via, origin);
    return s;
  }
  async function request(peer, method, p) {
    const leaf = !neighbors().has(peer) && leaves().has(peer);
    if ((!neighbors().has(peer) && !leaf) || typeof p?.id !== "string" || !/^[a-f0-9-]{36}$/.test(p.id)) throw new Error("Invalid tunnel");
    const k = key(peer, p.id);
    if (method === "relay.open") {
      const path = p.path, web = p.web === true;
      if (!Array.isArray(path) || path.length > MAX_HOPS || path[0] !== peer || path[1] !== self().id || !path.every(x => ID.test(x)) || new Set(path).size !== path.length || channels.has(k) || channels.size >= 128) throw new Error("Invalid relay route");
      // A leaf only goes on to another node (it has a link of its own to this one), only over a web link, and holds
      // only so many tunnels: one phone cannot use up the relay's channels.
      if (leaf && (path.length < 3 || !web || [...channels.keys()].filter(c => c.startsWith(`${peer}:`)).length >= MAX_LEAF_TUNNELS)) throw new Error("Invalid relay route");
      // Who the web tunnel is for: a leaf (a phone) is itself - its link is its key; a neighbour says whom it passes it
      // on for (`from`, a node id), or it is its own.
      const origin = !leaf && typeof p.from === "string" && ID.test(p.from) ? p.from : peer;
      // Reserve the id before asynchronous connection establishment.
      const socket = bind(peer, p.id, new Duplex({ read() {}, write(_c, _e, cb) { cb(new Error("Tunnel not ready")); } }));
      try {
        const downstream = path.length === 2
          ? (web ? webEnd(peer, origin) : await new Promise((resolve, reject) => {
            const s = net.connect(self().port, "127.0.0.1");
            s.once("connect", () => {
              const port = s.localPort;
              tunnelPorts.set(port, peer);
              s.once("close", () => { if (tunnelPorts.get(port) === peer) tunnelPorts.delete(port); });
              resolve(s);
            });
            s.once("error", reject);
          }))
          : await open(path.slice(1), { web, from: web ? origin : "" });
        if (socket.destroyed) { downstream.destroy(); throw new Error("Tunnel closed"); }
        channels.set(k, downstream);
        bind(peer, p.id, downstream);
        downstream.on("data", chunk => {
          downstream.pause();
          (async () => {
            for (let i = 0; i < chunk.length; i += 32768) await linkOf(peer)?.link.call("relay.data", { id: p.id, data: chunk.subarray(i, i + 32768).toString("base64") });
          })().then(() => downstream.resume(), () => downstream.destroy());
        });
        downstream.once("end", () => downstream.destroy());
        socket.destroy();
        return true;
      } catch (e) { socket.destroy(); throw e; }
    }
    const stream = channels.get(k);
    if (method === "relay.close") { channels.delete(k); inputs.delete(k); stream?.destroy(); return true; }
    if (method !== "relay.data" || !stream || typeof p.data !== "string" || p.data.length > 43692) throw new Error("Invalid tunnel data");
    const bytes = Buffer.from(p.data, "base64");
    // Outgoing virtual sockets receive bytes through their readable side.
    if (inputs.has(k)) {
      if (stream.readableLength + bytes.length > 1024 * 1024) { stream.destroy(); throw new Error("Relay buffer limit"); }
      stream.push(bytes);
    } else await new Promise((resolve, reject) => stream.write(bytes, e => e ? reject(e) : resolve()));
    return true;
  }
  function down(peer) {
    adverts.delete(peer);
    for (const [k, s] of channels) if (k.startsWith(`${peer}:`)) { channels.delete(k); inputs.delete(k); s.destroy(); }
    refresh();
  }
  return { refresh, broadcast, event, request, down,
    list: () => [...routes.values()],
    sourceOf: port => tunnelPorts.get(port) || "",
    open: async path => open(path),
    stop() { for (const s of channels.values()) s.destroy(); channels.clear(); inputs.clear(); tunnelPorts.clear(); adverts.clear(); routes.clear(); signature = ""; }
  };
}
module.exports = { createRelay };
