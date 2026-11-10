// Path-vector discovery and bounded byte tunnels. Only the local mesh listener is
// reachable at the end of a tunnel; TLS and pairing still happen end to end.
const { Duplex } = require("node:stream");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const ID = /^[a-f0-9]{64}$/;
const MAX_HOPS = 8;
function createRelay({ self, neighbors, changed }) {
  const adverts = new Map(), channels = new Map(), inputs = new Set();
  // The local port of each tunnel's last hop into this node's own listener -> the neighbour it came through: those
  // connections all come from 127.0.0.1, and pairing tries are counted by where they came from (sourceOf).
  const tunnelPorts = new Map();
  let routes = new Map(), signature = "";
  const key = (peer, id) => `${peer}:${id}`;
  function refresh() {
    const next = new Map();
    const choose = r => {
      const old = next.get(r.id);
      if (!old || r.path.length < old.path.length || (r.path.length === old.path.length && r.path.join() < old.path.join())) next.set(r.id, r);
    };
    for (const [id, n] of neighbors()) {
      choose({ id, name: n.info.name, kind: n.info.kind, path: [self().id, id] });
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
    for (const n of neighbors().values()) n.link.notify("relay.routes", [...routes.values()].slice(0, 512));
  }
  function event(peer, name, data) {
    if (name !== "relay.routes") return false;
    if (!neighbors().has(peer) || !Array.isArray(data) || data.length > 512) return true;
    adverts.set(peer, data.filter(r => r && ID.test(r.id) && Array.isArray(r.path) && r.path.length >= 2 && r.path.length <= MAX_HOPS && r.path[0] === peer && r.path.at(-1) === r.id && r.path.every(x => ID.test(x)) && new Set(r.path).size === r.path.length).map(r => ({ id: r.id, name: String(r.name || "").slice(0, 60), kind: r.kind === "host" ? "host" : "desktop", path: r.path })));
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
      neighbors().get(peer)?.link.call("relay.close", { id }).catch(() => {});
    });
    return stream;
  }
  async function open(path) {
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
    try { await n.link.call("relay.open", { id, path }); return stream; }
    catch (e) { stream.destroy(); throw e; }
  }
  async function request(peer, method, p) {
    if (!neighbors().has(peer) || typeof p?.id !== "string" || !/^[a-f0-9-]{36}$/.test(p.id)) throw new Error("Invalid tunnel");
    const k = key(peer, p.id);
    if (method === "relay.open") {
      const path = p.path;
      if (!Array.isArray(path) || path.length > MAX_HOPS || path[0] !== peer || path[1] !== self().id || !path.every(x => ID.test(x)) || new Set(path).size !== path.length || channels.has(k) || channels.size >= 128) throw new Error("Invalid relay route");
      // Reserve the id before asynchronous connection establishment.
      const socket = bind(peer, p.id, new Duplex({ read() {}, write(_c, _e, cb) { cb(new Error("Tunnel not ready")); } }));
      try {
        const downstream = path.length === 2
          ? await new Promise((resolve, reject) => {
            const s = net.connect(self().port, "127.0.0.1");
            s.once("connect", () => {
              const port = s.localPort;
              tunnelPorts.set(port, peer);
              s.once("close", () => { if (tunnelPorts.get(port) === peer) tunnelPorts.delete(port); });
              resolve(s);
            });
            s.once("error", reject);
          })
          : await open(path.slice(1));
        if (socket.destroyed) { downstream.destroy(); throw new Error("Tunnel closed"); }
        channels.set(k, downstream);
        bind(peer, p.id, downstream);
        downstream.on("data", chunk => {
          downstream.pause();
          (async () => {
            for (let i = 0; i < chunk.length; i += 32768) await neighbors().get(peer)?.link.call("relay.data", { id: p.id, data: chunk.subarray(i, i + 32768).toString("base64") });
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
