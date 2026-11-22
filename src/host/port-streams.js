// The host's end of forwarded ports (docs/PORT-FORWARDING.md 2.1, 2.2; served by mesh/serve.js): a peer opens a
// stream to a TCP port of this computer, and its bytes pass both ways through mesh/stream-pipe.js.
//
// The target is always this computer's loopback - 127.0.0.1, and ::1 when nothing answers there (dev servers often
// listen on ::1 only). The peer gives a port number and nothing else: never an address. The node's own mesh port is
// refused. A stream belongs to the peer that opened it: frames are looked up under their sender, so another peer's
// frames for it find nothing. At most MAX_STREAMS per peer (those still connecting count); a stream nothing moved on
// for idleMs is closed; drop(peer) closes all of a peer's (its link went down).
//
// A stream that ends here on its own in any way but a clean close of both sides (the service reset it, it sat idle)
// is said to the peer: notify(peer, "port.closed", { stream }). One the peer closed (close, drop) is not.
//
// createPortStreams({ send(peer, frame), notify(peer, name, data), ownPort(), idleMs }) ->
//   open(peer, stream, port): a promise, true once connected; HostError invalidData (not a UUID, not a port, a stream
//     id in use), notAllowed (the mesh port), tooManyStreams, refused (nothing listens there).
//   close(peer, stream), frame(peer, f: a decoded stream-* frame), drop(peer), count(peer).
const net = require("node:net");
const { HostError } = require("./errors");
const { UUID } = require("../mesh/frames");
const { createPipe } = require("../mesh/stream-pipe");
const { streamWindow } = require("../mesh/frames");

const MAX_STREAMS = 64;
const IDLE_MS = 10 * 60 * 1000;

const dial = (host, port) => new Promise((resolve, reject) => {
  const socket = net.connect({ host, port, allowHalfOpen: true });
  socket.once("error", reject);
  socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
});

function createPortStreams({ send, notify, ownPort = () => 0, idleMs = IDLE_MS }) {
  const peers = new Map(); // peer id -> Map of stream id -> { pipe, timer, closed }

  // The stream leaves the books; its socket goes. tell: the peer did not ask for it, so it hears.
  function end(peer, stream, tell) {
    const mine = peers.get(peer), s = mine?.get(stream);
    if (!s) return;
    mine.delete(stream);
    if (!mine.size) peers.delete(peer);
    s.closed = true;
    clearTimeout(s.timer);
    s.pipe?.destroy();
    if (tell) notify(peer, "port.closed", { stream });
  }
  async function open(peer, stream, port) {
    if (typeof stream !== "string" || !UUID.test(stream) || !Number.isInteger(port) || port < 1 || port > 65535) throw new HostError("invalidData");
    if (port === ownPort()) throw new HostError("notAllowed", "The mesh port itself cannot be forwarded.");
    if (!peers.has(peer)) peers.set(peer, new Map());
    const mine = peers.get(peer);
    if (mine.has(stream)) throw new HostError("invalidData");
    if (mine.size >= MAX_STREAMS) throw new HostError("tooManyStreams");
    const s = { pipe: null, timer: null, closed: false };
    mine.set(stream, s);
    let socket;
    try {
      socket = await dial("127.0.0.1", port).catch(e => {
        if (e.code !== "ECONNREFUSED") throw e;
        return dial("::1", port);
      });
    } catch {
      end(peer, stream, false);
      throw new HostError("refused");
    }
    // Closed, or its link gone, while it was connecting.
    if (s.closed) {
      socket.destroy();
      throw new HostError("refused");
    }
    socket.setNoDelay(true);
    s.timer = setTimeout(() => end(peer, stream, true), idleMs);
    s.timer.unref?.();
    s.pipe = createPipe({
      socket, id: stream,
      send: frame => send(peer, frame),
      active: () => s.timer.refresh(),
      window: () => streamWindow(mine.size),
      done: clean => end(peer, stream, !clean)
    });
    return true;
  }
  const close = (peer, stream) => end(peer, stream, false);
  const frame = (peer, f) => peers.get(peer)?.get(f.id)?.pipe?.frame(f);
  function drop(peer) {
    for (const stream of [...(peers.get(peer)?.keys() || [])]) end(peer, stream, false);
  }
  const count = peer => peers.get(peer)?.size || 0;

  return { open, close, frame, drop, count };
}

module.exports = { createPortStreams, MAX_STREAMS, IDLE_MS };
