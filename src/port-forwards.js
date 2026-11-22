// The viewer's end of forwarded ports (docs/PORT-FORWARDING.md 2): a listener on this computer's 127.0.0.1 for a
// port of another node, so that http://localhost:<port> here reaches localhost:<port> there. Pure Node (Electron's
// main requires it; the tests run it as it is).
//
// Every connection the listener takes is a stream of its own: a fresh UUID, "ports.open" { stream, port } asked of the
// node, then the bytes both ways through mesh/stream-pipe.js - the same pipe the host uses. Until the node has
// answered, the connection stays paused: what the browser already sent waits in the socket, nothing is lost. When the
// node refuses, that connection is destroyed and the forward stays. A connection that ends here in any way but a
// clean close of both sides is said to the node ("ports.close"); one that ended so there arrives as the event
// "port.closed" { stream } and is destroyed here.
//
// The listener takes the same port number when nothing answers on it here (redirects and absolute addresses in the
// page keep working), otherwise one the system picks; it is on 127.0.0.1 and ::1 both - "localhost" in a browser is
// either - and never on another address. A forward lives while the link to
// its node does: when that goes down, its connections are destroyed and its forwards closed.
//
// createPortForwards({ links }) - links: mesh/links.js (call, sendBinary, online, on "binary" | "event" | "link") ->
//   open(node, port, { answers }) -> { node, port, localPort }: the forward, made unless it is there already. Rejects
//     with the node's own code when it cannot forward: "offline", "unknownMethod" (an AgentDeck from before forwarded
//     ports), "relayOnly" (it may not be controlled from here); "invalidData" for what is not a port. answers: true -
//     a forward is made only for a port that answers on the node now: else "refused" (nobody listens there),
//     "notAllowed" (its mesh port), "tooManyStreams", and nothing listens here. One that is there already is given
//     as it is, unasked: its service may be restarting, and it must stay reachable to be stopped.
//   close(node, port), list() -> [{ node, port, localPort, streams: connections open now }],
//   on("change", fn): a forward was added or removed, dispose().
const net = require("node:net");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const frames = require("./mesh/frames");
const { createPipe } = require("./mesh/stream-pipe");
const { streamWindow } = require("./mesh/frames");
const { HostError } = require("./host/errors");

const PROBE_MS = 500;   // how long a port here is given to answer before it counts as free
const PICK_TRIES = 5;   // system-picked numbers tried until ::1 has the same one free

function createPortForwards({ links }) {
  const out = new EventEmitter();
  const forwards = new Map(); // "node:port" -> { node, port, localPort, server, streams: Set of stream ids }
  const opening = new Map();  // "node:port" -> the promise of a forward being made
  const streams = new Map();  // stream id -> { node, pipe, told }
  const perNode = new Map();  // node -> how many streams it has
  const keyOf = (node, port) => `${node}:${port}`;
  const shown = f => ({ node: f.node, port: f.port, localPort: f.localPort });

  const listen = (port, host) => new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true });
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); server.on("error", () => {}); resolve(server); });
  });
  // Does something on this computer answer on the port already? Asked by connecting, on both loopbacks: a bind does
  // not say (Windows lets 127.0.0.1:n be bound beside another program's 0.0.0.0:n or [::]:n, and ::1:n is free beside
  // a 127.0.0.1:n) and the browser would then reach that program, not the forward.
  const answers = (port, host) => new Promise(resolve => {
    const socket = net.connect({ port, host });
    const say = yes => { socket.destroy(); resolve(yes); };
    socket.setTimeout(PROBE_MS, () => say(false));
    socket.once("connect", () => say(true));
    socket.once("error", () => say(false));
  });
  // The forward's listeners: 127.0.0.1 and ::1 on one number, since "localhost" in a browser is either. ::1 is left
  // out on a computer without IPv6. port 0: a number the system picks (tried again when ::1 has it taken).
  async function listenBoth(port) {
    for (let tries = port ? 1 : PICK_TRIES; ; tries--) {
      const v4 = await listen(port, "127.0.0.1");
      try {
        return [v4, await listen(v4.address().port, "::1")];
      } catch (e) {
        if (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT") return [v4];
        v4.close();
        if (tries <= 1) throw e;
      }
    }
  }
  async function listenFor(port) {
    const taken = (await Promise.all([answers(port, "127.0.0.1"), answers(port, "::1")])).some(Boolean);
    if (!taken) try { return await listenBoth(port); } catch {}
    return listenBoth(0);
  }
  function accept(f, socket) {
    socket.pause();
    socket.setNoDelay(true);
    const id = crypto.randomUUID();
    const s = { node: f.node, pipe: null, told: false };
    s.pipe = createPipe({
      socket, id,
      send: frame => links.sendBinary(f.node, frame),
      // All the forwards to one node share its link (frames.js STREAM_BUDGET).
      window: () => streamWindow(perNode.get(f.node) || 1),
      done: clean => {
        streams.delete(id);
        f.streams.delete(id);
        if (perNode.get(f.node) > 1) perNode.set(f.node, perNode.get(f.node) - 1);
        else perNode.delete(f.node);
        // The node still holds its end, unless it was the one to say so or its link is gone.
        if (!clean && !s.told) links.call(f.node, "ports.close", { stream: id }).catch(() => {});
      }
    });
    streams.set(id, s);
    f.streams.add(id);
    perNode.set(f.node, (perNode.get(f.node) || 0) + 1);
    links.call(f.node, "ports.open", { stream: id, port: f.port }).then(() => socket.resume(), () => {
      s.told = true;
      s.pipe.destroy();
    });
  }
  async function make(node, port, live) {
    if (!links.online(node)) throw new HostError("offline", "That node is not connected.");
    // Asked before anything listens here: a node that cannot forward (older, or one this computer may not control)
    // says so now, with its own code, not at the first connection. Closing a stream that is not there does nothing.
    // live (open's `answers`): the port itself is asked for instead - a stream to it opened there and closed at
    // once - so a port nobody listens on is refused now as well, and no listener is made here for it.
    // A link that has just come back may be replaced by the node's own one a moment later (links.js keeps one of
    // the two): what was asked on it fails with "closed" while the node is still there - asked once more then.
    const ask = async () => {
      const stream = crypto.randomUUID();
      if (live) await links.call(node, "ports.open", { stream, port });
      const closed = links.call(node, "ports.close", { stream });
      if (live) closed.catch(() => {}); else await closed;
    };
    await ask().catch(e => { if (e?.code !== "closed" || !links.online(node)) throw e; return ask(); });
    const f = { node, port, localPort: 0, servers: await listenFor(port), streams: new Set() };
    f.localPort = f.servers[0].address().port;
    for (const server of f.servers) server.on("connection", socket => accept(f, socket));
    // The link went down while this was being made: "link" found nothing to close then.
    if (!links.online(node)) {
      for (const server of f.servers) server.close();
      throw new HostError("offline", "That node is not connected.");
    }
    forwards.set(keyOf(node, port), f);
    out.emit("change");
    return shown(f);
  }
  async function open(node, port, { answers = false } = {}) {
    if (typeof node !== "string" || !Number.isInteger(port) || port < 1 || port > 65535) throw new HostError("invalidData");
    const key = keyOf(node, port);
    if (forwards.has(key)) return shown(forwards.get(key));
    if (!opening.has(key)) opening.set(key, make(node, port, answers === true).finally(() => opening.delete(key)));
    return opening.get(key);
  }
  // quiet: the node's link is gone, there is nobody to tell.
  function shut(f, quiet = false) {
    forwards.delete(keyOf(f.node, f.port));
    for (const server of f.servers) server.close();
    for (const id of [...f.streams]) {
      const s = streams.get(id);
      if (quiet) s.told = true;
      s.pipe.destroy();
    }
  }
  async function close(node, port) {
    const f = forwards.get(keyOf(node, port));
    if (!f) return false;
    shut(f);
    out.emit("change");
    return true;
  }
  const list = () => [...forwards.values()].map(f => ({ ...shown(f), streams: f.streams.size }));

  const onBinary = ({ node, data }) => {
    const f = frames.decode(data);
    if (!f || !f.type.startsWith("stream-")) return;
    const s = streams.get(f.id);
    if (s?.node === node) s.pipe.frame(f);
  };
  const onEvent = ({ node, name, data }) => {
    const s = name === "port.closed" && typeof data?.stream === "string" ? streams.get(data.stream) : null;
    if (s?.node !== node) return;
    s.told = true;
    s.pipe.destroy();
  };
  const onLink = ({ node, up }) => {
    if (up) return;
    const gone = [...forwards.values()].filter(f => f.node === node);
    for (const f of gone) shut(f, true);
    if (gone.length) out.emit("change");
  };
  links.on("binary", onBinary);
  links.on("event", onEvent);
  links.on("link", onLink);
  function dispose() {
    links.off("binary", onBinary);
    links.off("event", onEvent);
    links.off("link", onLink);
    for (const f of [...forwards.values()]) shut(f);
  }

  return { open, close, list, dispose, on: (name, fn) => out.on(name, fn), off: (name, fn) => out.off(name, fn) };
}

module.exports = { createPortForwards };
