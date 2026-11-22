// The phone's end of forwarded ports (docs/PORT-FORWARDING.md 2 and 4): a listener on the phone's own 127.0.0.1 for a
// port of one of the user's computers, so that the page at http://127.0.0.1:<port> in the app's own web view is
// localhost:<port> there. The counterpart of the desktop's src/port-forwards.js, with the same protocol towards the
// computer and the very same pipe (src/mesh/stream-pipe.js, bundled as it is); what differs is where the TCP is: a
// page cannot listen, so the sockets live in the app's native `Forward` plugin (PORT-FORWARDING.md 4.1 - the contract
// this file is written against) and their bytes cross the bridge as base64.
//
// No Capacitor in here: the plugin is handed in (forward-native.js on a phone, a fake over Node's sockets in
// scripts/test-mobile-forward.js), null where there is none - a browser build - and then `available` is false and
// nothing is offered.
//
// Every connection the listener takes ("connection") is a stream of its own: a fresh UUID, "ports.open"
// { stream, port } asked of the computer, then the bytes both ways through the pipe, a stream's window being its share
// of what the link may hold (frames.js streamWindow). Until the computer has answered, what the client already sent
// waits here, uncredited (the plugin stops reading the socket at 256 KB): the computer drops frames of a stream it
// has not opened yet. When it refuses, that connection is closed and the forward stays. A connection that ends here
// in any way but a clean close of both sides is said to the computer ("ports.close"); one that ended so there arrives
// as "port.closed" { stream } and is closed here. A forward lives while the link to its computer does: when that
// goes down its listeners are closed with their connections, the view is hidden if it showed one of them, and "lost"
// says so.
//
// Unlike the desktop, a forward is made only for a port that answers: the computer is asked to connect to it once
// ("ports.open", then "ports.close") before anything listens here - the page would otherwise open blank - and that
// one question also says what the desktop's probe does: "offline", "unknownMethod" (an AgentDeck from before
// forwarded ports), "relayOnly", and "refused" (nothing listens there), "notAllowed" (the mesh port).
//
// createForwards({ provider, plugin }) - provider: provider-relay.js (request, sendBinary, online, on "stream" |
//   "notify" | "link") ->
//   available: the plugin is there.
//   open(node, port) -> { node, port, localPort }: the forward, made unless it is there already. Rejects with the
//     computer's own code (above), "invalidData" for what is not a port, "unavailable" without the plugin,
//     "listenFailed" when the phone could not listen.
//   show(node, port, { https, title }) -> { node, port, localPort, url }: the forward (made, or asked again whether
//     its port still answers), then the app's web view on http(s)://127.0.0.1:<localPort>/ - never "localhost",
//     which on Android is the app itself.
//   address(node, port, { https }) -> the same forward and its url, without the view.
//   close(node, port) -> was there one; hide(); list() -> [{ node, port, localPort, streams: connections open now }];
//   shown() -> { node, port } | null: the forward the view is on.
//   on("change", fn): a forward was added or removed; on("lost", fn({ node, ports })): the link to a computer went and
//   took these forwards with it; on("hidden", fn): the user closed the view. dispose().
import { emitter } from "./util.js";
import { createPipe } from "../../src/mesh/stream-pipe.js";
import { streamWindow, STREAM_PIECE } from "../../src/mesh/frames.js";

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const isPort = v => Number.isInteger(v) && v >= 1 && v <= 65535;

// ---------- base64, for the bridge ----------
// A piece is at most 32 KB and there are thousands of them in a page's bundle: the WebView's own codec where it has
// one (Uint8Array.fromBase64 / toBase64), else atob / btoa over whole strings - never a string grown byte by byte.
const SLICE = 8192; // what String.fromCharCode takes as arguments at once without overflowing the stack
export const toBase64 = typeof Uint8Array.prototype.toBase64 === "function" ? bytes => bytes.toBase64() : bytes => {
  const parts = [];
  for (let i = 0; i < bytes.length; i += SLICE) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + SLICE)));
  return btoa(parts.join(""));
};
export const fromBase64 = typeof Uint8Array.fromBase64 === "function" ? text => Uint8Array.fromBase64(text) : text => {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

// A stream's id. crypto.randomUUID is not in every WebView the app runs in (iOS 15.0 - 15.3).
function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- one connection of the plugin, as the socket stream-pipe.js is written against ----------
// The few things the pipe does with a net.Socket, over the plugin's calls and events for `conn`:
//   on("data" | "end" | "close" | "error"), pause(), resume(), write(bytes, cb), end(), destroy().
// As a Node socket made with allowHalfOpen and read in flowing mode behaves:
//   * paused, nothing is handed over: the plugin's "data" waits here and is not credited, so the plugin stops reading
//     its socket once 256 KB wait - that is the back pressure on the client. A piece is credited as it is handed on;
//   * "end" comes after every byte before it was handed on, and "close" after "end" when the connection closed
//     cleanly (the client ended, and so did this side). A connection that goes any other way - an error, a close
//     with no "end" before it - is "close" with hadError at once, and what waited is dropped;
//   * write(): one plugin write at a time, in order, each of at most a piece (the plugin takes 64 KB); the callback
//     fires once the plugin resolved - the bytes are in the client's socket -, which is when the pipe acknowledges
//     them to the computer. end(): after what is being written; destroy(): now, what waits either way is dropped.
// take(event, data): the plugin's "data" | "end" | "closed" for this connection.
//
// What this counts on from the plugin beyond the letter of 4.1 (the fake in scripts/test-mobile-forward.js does it so):
//   * a connection's events reach the page in the order they were raised: "connection", its "data" in the order
//     read, "end" after the last of them, "closed" last - nothing of a connection after its "closed";
//   * "closed" with error "" after an "end" means the client got everything written before end() - a clean close
//     of both sides. Any error text, or a "closed" with no "end" before it, is taken as an abort (the computer's end
//     is then closed with "ports.close"); what the text says does not matter;
//   * after the client's FIN ("end") the connection stays open for writing until end() or close(): "closed" is not
//     raised merely because the client finished sending;
//   * write() resolves only once the bytes were handed to the socket (that is the acknowledgement the computer
//     waits for, so a client that does not read stops the computer a window later), and rejects - it never hangs -
//     for a connection that is closed or unknown; end(), close() and credit() for such a one may resolve or reject,
//     nothing is read from the answer;
//   * credit is counted per connection, in bytes of the decoded "data"; a piece is credited once, whole;
//   * listen() may answer another port than the one wished for (it is the one shown and listened on); the listener
//     and connection ids are non-empty strings; a "connection" may even arrive before the answer to its listen();
//   * unlisten() and close() raise "closed" for the connections they end; the page does not wait for it.
function connSocket(plugin, conn) {
  const handlers = new Map();
  const inbox = [];  // read by the plugin, not handed to the pipe yet (paused)
  const writes = []; // [bytes, callback] not written yet; the first one is in the plugin's hands while `writing`
  let paused = false, destroyed = false, writing = false, ending = false;
  let endSeen = false, endOut = false, closedSeen = false, closeOut = false;
  const emit = (name, arg) => { for (const fn of handlers.get(name) || []) fn(arg); };
  const quiet = promise => { promise?.catch?.(() => {}); };

  // Hands on what waits, in order: the pieces (each credited), then the end, then a clean close.
  function flow() {
    while (!paused && !destroyed && inbox.length) {
      const chunk = inbox.shift();
      quiet(plugin.credit({ conn, bytes: chunk.length }));
      emit("data", chunk);
    }
    if (paused || destroyed || inbox.length) return;
    if (endSeen && !endOut) { endOut = true; emit("end"); }
    if (closedSeen && endOut && !closeOut) { closeOut = true; emit("close", false); }
  }
  // The connection is gone with what waited for it: the callbacks of what was never written still fire.
  function drop() {
    destroyed = true;
    inbox.length = 0;
    for (const [, cb] of writes.splice(writing ? 1 : 0)) cb?.(failure("closed"));
  }
  async function drain() {
    if (writing) return;
    writing = true;
    while (writes.length) {
      const [bytes, cb] = writes[0];
      let error = destroyed ? failure("closed") : null;
      for (let i = 0; i < bytes.length && !error; i += STREAM_PIECE) {
        try { await plugin.write({ conn, data: toBase64(bytes.subarray(i, i + STREAM_PIECE)) }); } catch (e) { error = e || failure("closed"); }
        if (destroyed) error ||= failure("closed");
      }
      writes.shift();
      cb?.(error);
    }
    writing = false;
    if (ending && !destroyed) quiet(plugin.end({ conn }));
  }

  return {
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    // "close" was said (or is on its way): nothing more comes of this connection.
    get over() { return closeOut; },
    pause() { paused = true; },
    resume() { paused = false; flow(); },
    write(bytes, cb) {
      if (destroyed || ending) return void cb?.(failure("closed"));
      writes.push([bytes, cb]);
      drain();
    },
    // No more bytes for the client, after what is being written (a half close: it may still send).
    end() {
      if (ending || destroyed) return;
      ending = true;
      if (!writing) quiet(plugin.end({ conn }));
    },
    // "close" follows, as after a Node socket's destroy(): the pipe waits for it when it cut a sender off itself.
    destroy() {
      if (destroyed) return;
      drop();
      quiet(plugin.close({ conn }));
      if (!closeOut) { closeOut = true; queueMicrotask(() => emit("close", true)); }
    },
    take(event, data) {
      if (destroyed) return;
      if (event === "data") {
        let bytes;
        try { bytes = fromBase64(String(data?.data ?? "")); } catch { return void this.destroy(); }
        if (bytes.length) { inbox.push(bytes); flow(); }
      } else if (event === "end") {
        endSeen = true;
        flow();
      } else if (event === "closed") {
        if (closedSeen) return;
        closedSeen = true;
        if (endSeen && !data?.error) return void flow();
        drop();
        if (!closeOut) { closeOut = true; emit("close", true); }
      }
    }
  };
}

// ---------- the forwards ----------
export function createForwards({ provider, plugin = null }) {
  const out = emitter();
  const forwards = new Map();  // "node:port" -> { node, port, localPort, listener, streams: Set of stream ids }
  const opening = new Map();   // "node:port" -> the promise of a forward being made
  const listeners = new Map(); // the plugin's listener id -> its forward
  const conns = new Map();     // the plugin's connection id -> its socket (connSocket)
  const streams = new Map();   // stream id -> { node, pipe, told }
  const perNode = new Map();   // node -> how many streams it has
  const early = new Map();     // connection id -> { listener, socket }: here before the answer to its listen() was
  let view = null;             // { node, port } of the forward the web view is on
  let disposed = false;
  const keyOf = (node, port) => `${node}:${port}`;
  const shown = f => ({ node: f.node, port: f.port, localPort: f.localPort });
  const quiet = promise => { promise?.catch?.(() => {}); };

  // socket: the one made for it already, when the connection was here before its listener was (onConnection).
  function accept(f, conn, socket = connSocket(plugin, conn)) {
    socket.pause(); // until the computer has opened the stream
    conns.set(conn, socket);
    const id = uuid();
    const s = { node: f.node, pipe: null, told: false };
    s.pipe = createPipe({
      socket, id,
      send: frame => provider.sendBinary(f.node, frame),
      // All the forwards to one computer share its link (frames.js STREAM_BUDGET).
      window: () => streamWindow(perNode.get(f.node) || 1),
      done: clean => {
        streams.delete(id);
        f.streams.delete(id);
        conns.delete(conn);
        if (perNode.get(f.node) > 1) perNode.set(f.node, perNode.get(f.node) - 1);
        else perNode.delete(f.node);
        // The computer still holds its end, unless it was the one to say so or its link is gone.
        if (!clean && !s.told) quiet(provider.request(f.node, "ports.close", { stream: id }));
      }
    });
    streams.set(id, s);
    f.streams.add(id);
    perNode.set(f.node, (perNode.get(f.node) || 0) + 1);
    provider.request(f.node, "ports.open", { stream: id, port: f.port }).then(() => socket.resume(), () => {
      s.told = true;
      s.pipe.destroy();
    });
  }

  // Does that port answer there? The computer connects to it and lets go again. Rejects with the computer's code.
  // A link that has just come back may be replaced by a newer one a moment later (web-client.js keeps the newest):
  // what was asked on it fails with "closed" while the computer is still there - asked once more then.
  async function answers(node, port) {
    const ask = async () => {
      const stream = uuid();
      await provider.request(node, "ports.open", { stream, port });
      quiet(provider.request(node, "ports.close", { stream }));
    };
    if (!provider.online(node)) throw failure("offline", "That computer is not connected.");
    await ask().catch(e => { if (e?.code !== "closed" || !provider.online(node)) throw e; return ask(); });
  }
  async function make(node, port) {
    await answers(node, port);
    // The same number where the phone has it free (redirects and absolute addresses in the page keep working), else
    // one the system picks: the plugin's choice.
    let made;
    try { made = await plugin.listen({ port }); } catch (e) { throw failure("listenFailed", e?.message || "The phone could not listen."); }
    const listener = made?.listener, localPort = made?.port;
    if (typeof listener !== "string" || !listener || !isPort(localPort)) {
      if (typeof listener === "string" && listener) quiet(plugin.unlisten({ listener }));
      throw failure("listenFailed", "The phone could not listen.");
    }
    // The link went down while this was being made ("link" found nothing to close then), or everything was let go.
    if (disposed || !provider.online(node)) {
      quiet(plugin.unlisten({ listener }));
      throw failure("offline", "That computer is not connected.");
    }
    const f = { node, port, localPort, listener, streams: new Set() };
    listeners.set(listener, f);
    forwards.set(keyOf(node, port), f);
    for (const [conn, o] of [...early]) {
      if (o.listener !== listener) continue;
      early.delete(conn);
      if (o.socket.over) conns.delete(conn); // it went again meanwhile
      else accept(f, conn, o.socket);
    }
    out.emit("change");
    return f;
  }
  // A listener that is no forward's: closed with whatever connected to it.
  function orphaned() {
    for (const [conn, o] of [...early]) { early.delete(conn); conns.delete(conn); o.socket.destroy(); }
  }
  // -> the forward itself, and whether this call made it.
  async function ensure(node, port) {
    if (!plugin) throw failure("unavailable", "Ports cannot be forwarded in this build of the app.");
    if (typeof node !== "string" || !isPort(port)) throw failure("invalidData");
    const key = keyOf(node, port);
    if (forwards.has(key)) return { f: forwards.get(key), made: false };
    if (!opening.has(key)) opening.set(key, make(node, port).finally(() => { opening.delete(key); if (!opening.size) orphaned(); }));
    return { f: await opening.get(key), made: true };
  }
  const open = async (node, port) => shown((await ensure(node, port)).f);
  // The forward and its address here. One that was there already is asked again whether its port still answers: a
  // dev server stopped since gives a message, not a blank page.
  async function address(node, port, { https = false } = {}) {
    const { f, made } = await ensure(node, port);
    if (!made) await answers(node, port);
    if (forwards.get(keyOf(node, port)) !== f) throw failure("offline", "That computer is not connected.");
    return { ...shown(f), url: `${https ? "https" : "http"}://127.0.0.1:${f.localPort}/` };
  }
  async function show(node, port, { https = false, title = "" } = {}) {
    const at = await address(node, port, { https });
    await plugin.show({ url: at.url, title: String(title || port) });
    // Gone while the view was opening (the link dropped): nothing is left behind it.
    if (!forwards.has(keyOf(node, port))) { quiet(plugin.hide()); throw failure("offline", "That computer is not connected."); }
    view = { node, port };
    return at;
  }
  function hide() {
    if (!view) return;
    view = null;
    quiet(plugin.hide());
  }

  // silent: the computer's link is gone, there is nobody to tell.
  function shut(f, silent = false) {
    forwards.delete(keyOf(f.node, f.port));
    listeners.delete(f.listener);
    quiet(plugin.unlisten({ listener: f.listener }));
    for (const id of [...f.streams]) {
      const s = streams.get(id);
      if (silent) s.told = true;
      s.pipe.destroy();
    }
    if (view?.node === f.node && view.port === f.port) hide();
  }
  async function close(node, port) {
    const f = forwards.get(keyOf(node, port));
    if (!f) return false;
    shut(f);
    out.emit("change");
    return true;
  }
  const list = () => [...forwards.values()].map(f => ({ ...shown(f), streams: f.streams.size }));

  // ---------- what the plugin says ----------
  const onConnection = e => {
    const f = listeners.get(e?.listener);
    if (typeof e?.conn !== "string" || !e.conn || conns.has(e.conn)) return;
    if (f) return accept(f, e.conn);
    // A listener closed a moment ago: its connection goes. Unless a forward is being made: the plugin may say
    // "connection" before its answer to listen() got here - kept, unread, until that forward is known (make).
    if (!opening.size || typeof e.listener !== "string") return quiet(plugin.close({ conn: e.conn }));
    const socket = connSocket(plugin, e.conn);
    socket.pause();
    conns.set(e.conn, socket);
    early.set(e.conn, { listener: e.listener, socket });
  };
  const toConn = event => e => conns.get(e?.conn)?.take(event, e);
  const onHidden = () => {
    if (!view) return;
    view = null;
    out.emit("hidden");
  };
  // ---------- what the computer says ----------
  const onStream = ({ node, frame }) => {
    const s = streams.get(frame.id);
    if (s?.node === node) s.pipe.frame(frame);
  };
  const onNotify = ({ node, event, payload }) => {
    const s = event === "port.closed" && typeof payload?.stream === "string" ? streams.get(payload.stream) : null;
    if (s?.node !== node) return;
    s.told = true;
    s.pipe.destroy();
  };
  const onLink = ({ node, up }) => {
    if (up) return;
    const gone = [...forwards.values()].filter(f => f.node === node);
    if (!gone.length) return;
    for (const f of gone) shut(f, true);
    out.emit("change");
    out.emit("lost", { node, ports: gone.map(f => f.port) });
  };

  const offs = [];
  if (plugin) {
    offs.push(provider.on("stream", onStream), provider.on("notify", onNotify), provider.on("link", onLink));
    // Capacitor's addListener answers a promise of a handle; its remove() lets go.
    for (const [name, fn] of [["connection", onConnection], ["data", toConn("data")], ["end", toConn("end")], ["closed", toConn("closed")], ["hidden", onHidden]]) {
      const handle = Promise.resolve(plugin.addListener(name, fn));
      offs.push(() => quiet(handle.then(h => h?.remove?.())));
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of [...forwards.values()]) shut(f);
    hide();
    for (const off of offs.splice(0)) off();
  }

  return { available: Boolean(plugin), open, show, address, close, hide, list, shown: () => (view ? { ...view } : null), on: out.on, dispose };
}
