// The web link (docs/MOBILE.md 3.1): how a phone talks to a node without TLS. A WebSocket from a WebView cannot show
// or check self-signed certificates, so the link is encrypted and authenticated one level up, with Noise XX
// (noise.js), and inside it runs the same link protocol as between computers (protocol.js: JSON requests, answers and
// events in text frames, terminal bytes in binary frames).
//
// Two layers, each over the one below:
// - a message pipe: something that carries whole messages of up to noise.MAX_MESSAGE bytes, in order. Over a
//   WebSocket (wsPipe) one WebSocket message is one Noise message; over a byte stream - a relay tunnel, relay.js -
//   (framedPipe) each message goes as [length:4 BE][message], length 1..MAX_MESSAGE;
// - handshake(pipe, ...): Noise_XX with the prologue PROLOGUE (both sides must agree on it, so a link of another
//   protocol or version fails here), empty handshake payloads, the phone always the initiator. It resolves with
//   the other side's static public key, the handshake hash (for pairing, pair-proof.js) and a socket.
// The socket behaves as much like a `ws` WebSocket as protocol.js needs (on("message" | "close" | "pong" | "error"),
// send(text | bytes), ping(), close(code, reason), terminate(), pause()/resume(), readyState/OPEN; and limit(bytes):
// a smaller cap on incoming frames), so createLink
// runs over it unchanged. Each Noise plaintext starts with one byte:
//   0 a text frame (UTF-8), 1 a binary frame, 2 / 3 a piece of a text / binary frame that goes on in the next message
//   (a frame of more than MAX_PLAINTEXT - 1 bytes is cut up; whole frames are at most MAX_FRAME, as `ws` limits them
//   between computers), 4 ping, 5 pong, 6 close [code:2 BE][reason, at most 123 bytes].
// Anything else, a frame too big, a message that does not decrypt (lost, repeated, reordered, forged): the link is
// closed at once. A socket starts paused: what arrives is kept (up to MAX_QUEUED bytes) until resume().
//
// Runs in Node and, bundled, in the phone's WebView: Uint8Arrays only, no Buffer, no node: modules. Node's side
// passes wrapBinary to get its binary frames as Buffers.
const noise = require("./noise");
const { concatBytes, utf8ToBytes } = require("@noble/hashes/utils");

const PROLOGUE = utf8ToBytes("AgentDeck web link 1");
const HANDSHAKE_TIMEOUT_MS = 10000;
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_QUEUED = 2 * MAX_FRAME;
const TEXT = 0, BINARY = 1, MORE = 2, PING = 4, PONG = 5, CLOSE = 6;
const PIECE = noise.MAX_PLAINTEXT - 1;
const OPEN = 1, CLOSED = 3;
const EMPTY = new Uint8Array(0);

const toBytes = d => (d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
const failure = (code, message) => Object.assign(new Error(message), { code });

// The few EventEmitter calls protocol.js and links.js make.
function emitter() {
  const handlers = new Map();
  const on = (name, fn) => { handlers.set(name, [...(handlers.get(name) || []), fn]); };
  const off = (name, fn) => { handlers.set(name, (handlers.get(name) || []).filter(f => f !== fn && f.inner !== fn)); };
  const once = (name, fn) => { const w = (...a) => { off(name, w); fn(...a); }; w.inner = fn; on(name, w); };
  const emit = (name, ...args) => { for (const fn of handlers.get(name) || []) fn(...args); };
  return { on, off, once, emit };
}

// ---------- pipes ----------
// A pipe: { send(message), close(hard?), onmessage(message), onclose() }. onclose comes once, also after close().

// ws: a browser WebSocket or one of the `ws` package (either side), open or opening. A text message is not ours: the
// pipe closes.
function wsPipe(ws) {
  let closed = false;
  const gone = () => { if (closed) return; closed = true; pipe.onclose?.(); };
  const pipe = {
    onmessage: null, onclose: null,
    send(message) { if (!closed && ws.readyState === 1) ws.send(message); },
    // Bytes waiting to go out (protocol.js buffered).
    buffered: () => Number(ws.bufferedAmount) || 0,
    close(hard) {
      try { if (hard && ws.terminate) ws.terminate(); else ws.close(); } catch {}
      gone();
    }
  };
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", e => {
    if (closed) return;
    if (typeof e.data === "string") return pipe.close(true);
    pipe.onmessage?.(toBytes(e.data));
  });
  ws.addEventListener("close", gone);
  ws.addEventListener("error", () => {}); // "close" follows
  return pipe;
}

// A pipe over a byte stream. io: { send(bytes), close() } - the stream's two ways out. -> { pipe, input(bytes): what
// came in, end(): the stream ended }.
function framedPipe(io) {
  let closed = false, buf = EMPTY;
  const gone = () => { if (closed) return; closed = true; buf = EMPTY; pipe.onclose?.(); };
  const pipe = {
    onmessage: null, onclose: null,
    send(message) {
      if (closed) return;
      const head = new Uint8Array(4);
      new DataView(head.buffer).setUint32(0, message.length);
      io.send(concatBytes(head, message));
    },
    // Bytes waiting to go out, as far as the stream can say (a relay tunnel's: what it passes on to; otherwise 0).
    buffered: () => Number(io.buffered?.()) || 0,
    close() { if (closed) return; io.close(); gone(); }
  };
  function input(chunk) {
    if (closed) return;
    chunk = toBytes(chunk);
    buf = buf.length ? concatBytes(buf, chunk) : chunk;
    // What stays between calls is less than one message: a whole one is taken out at once.
    while (!closed && buf.length >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0);
      if (!len || len > noise.MAX_MESSAGE) return pipe.close();
      if (buf.length < 4 + len) break;
      const message = buf.slice(4, 4 + len);
      buf = buf.subarray(4 + len);
      pipe.onmessage?.(message);
    }
  }
  return { pipe, input, end: gone };
}

// ---------- the handshake ----------
// pipe: a fresh pipe; initiator: true on the phone; s: this side's static keypair; wrapBinary(bytes): how binary
// frames are handed on (Node: as Buffers). -> Promise<{ socket, remoteKey, hash }>: remoteKey and hash are 32-byte
// Uint8Arrays. Rejects with code "handshake" (a broken or foreign handshake, or no answer in time) or "closed" (the
// pipe went before it was done - an older node that does not know web links ends there too); the pipe is closed.
function handshake(pipe, { initiator, s, timeoutMs = HANDSHAKE_TIMEOUT_MS, wrapBinary } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const fail = e => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pipe.onmessage = null;
      pipe.close(true);
      reject(e);
    };
    const timer = setTimeout(() => fail(failure("handshake", "no handshake in time")), timeoutMs);
    let hs;
    try { hs = noise.createHandshake({ initiator, s, prologue: PROLOGUE }); } catch (e) { fail(failure("handshake", e.message)); return; }
    pipe.onclose = () => fail(failure("closed", "the connection closed during the handshake"));
    pipe.onmessage = message => {
      try {
        hs.readMessage(message);
        if (!hs.done) pipe.send(hs.writeMessage());
      } catch (e) { fail(failure("handshake", e.message)); return; }
      if (hs.done) finish();
    };
    function finish() {
      done = true;
      clearTimeout(timer);
      const remoteKey = hs.remoteStatic, hash = hs.hash;
      // Takes the pipe over at once: a message right behind the last handshake message is the socket's.
      const socket = createSocket(pipe, hs.split(), { wrapBinary });
      resolve({ socket, remoteKey, hash });
    }
    if (initiator) {
      try { pipe.send(hs.writeMessage()); } catch (e) { fail(failure("handshake", e.message)); }
    }
  });
}

// ---------- the socket ----------
function createSocket(pipe, { send: out, recv: inn }, { wrapBinary = b => b } = {}) {
  const ev = emitter();
  const decoder = new TextDecoder();
  let state = OPEN, paused = true, queue = [], queued = 0, maxFrame = MAX_FRAME;
  let parts = [], size = 0, binaryFrame = null; // the frame coming in, piece by piece

  const put = (type, data = EMPTY) => pipe.send(out.encrypt(concatBytes(Uint8Array.of(type), data)));
  function finish(code, reason) {
    if (state === CLOSED) return;
    state = CLOSED;
    parts = []; queue = []; queued = 0;
    ev.emit("close", code, reason);
  }
  function abort(code, reason) {
    finish(code, reason);
    pipe.close(true);
  }
  function deliver(data, binary, n) {
    if (!paused) return ev.emit("message", data, binary);
    queued += n;
    if (queued > MAX_QUEUED) return abort(1009, "too much waiting");
    queue.push([data, binary, n]);
  }

  pipe.onclose = () => finish(1006, "");
  pipe.onmessage = message => {
    if (state !== OPEN) return;
    let p;
    try { p = inn.decrypt(message); } catch { return abort(1002, "broken message"); }
    if (!p.length) return abort(1002, "empty message");
    const type = p[0], data = p.subarray(1);
    if (type === PING) { try { put(PONG); } catch { abort(1011, "cipher"); } return; }
    if (type === PONG) return ev.emit("pong");
    if (type === CLOSE) {
      const code = data.length >= 2 ? (data[0] << 8) | data[1] : 1005;
      finish(code, decoder.decode(data.subarray(2, 125)));
      pipe.close();
      return;
    }
    if (type > (BINARY | MORE)) return abort(1002, "unknown message");
    const binary = (type & BINARY) === BINARY;
    if (binaryFrame !== null && binaryFrame !== binary) return abort(1002, "mixed frame");
    if (size + data.length > maxFrame) return abort(1009, "too big");
    binaryFrame = binary;
    parts.push(data);
    size += data.length;
    if (type & MORE) return;
    const whole = parts.length === 1 ? parts[0] : concatBytes(...parts);
    parts = []; size = 0; binaryFrame = null;
    deliver(binary ? wrapBinary(whole) : decoder.decode(whole), binary, whole.length);
  };

  const socket = {
    OPEN, CLOSED,
    get readyState() { return state; },
    // What the pipe below has waiting to go out (protocol.js buffered: a sender of much output holds back).
    get bufferedAmount() { return state === OPEN ? pipe.buffered?.() || 0 : 0; },
    on(name, fn) { ev.on(name, fn); return socket; },
    once(name, fn) { ev.once(name, fn); return socket; },
    off(name, fn) { ev.off(name, fn); return socket; },
    removeListener(name, fn) { ev.off(name, fn); return socket; },
    // text: a string; anything else is a binary frame.
    send(data) {
      if (state !== OPEN) return;
      const binary = typeof data !== "string";
      const bytes = binary ? toBytes(data) : utf8ToBytes(data);
      if (bytes.length > MAX_FRAME) return abort(1009, "too big");
      try {
        for (let at = 0; ; at += PIECE) {
          const end = Math.min(at + PIECE, bytes.length), more = end < bytes.length;
          put((binary ? BINARY : TEXT) | (more ? MORE : 0), bytes.subarray(at, end));
          if (!more) break;
        }
      } catch { abort(1011, "cipher"); }
    },
    ping() {
      if (state !== OPEN) return;
      try { put(PING); } catch { abort(1011, "cipher"); }
    },
    // A smaller limit for the frames that come in (one that may only pair needs no megabytes).
    limit(bytes) { maxFrame = Math.min(MAX_FRAME, bytes); },
    pause() { paused = true; },
    resume() {
      paused = false;
      while (queue.length && !paused && state === OPEN) {
        const [data, binary, n] = queue.shift();
        queued -= n;
        ev.emit("message", data, binary);
      }
    },
    close(code = 1000, reason = "") {
      if (state !== OPEN) return;
      try { put(CLOSE, concatBytes(Uint8Array.of(code >> 8, code & 255), utf8ToBytes(String(reason)).subarray(0, 123))); } catch {}
      finish(code, String(reason));
      pipe.close();
    },
    terminate() { abort(1006, ""); }
  };
  return socket;
}

module.exports = { PROLOGUE, MAX_FRAME, handshake, wsPipe, framedPipe, emitter };
