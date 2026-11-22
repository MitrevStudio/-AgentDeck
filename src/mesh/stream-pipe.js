// One forwarded TCP connection (docs/PORT-FORWARDING.md 2.1): a net.Socket on this side joined to a stream id on a
// link, both ways. The host (host/port-streams.js: the socket to the service) and the viewer (port-forwards.js: the
// browser's socket) both use it, so the two ends cannot disagree. Pure Node, no Electron.
//
// Out: what the socket reads goes as stream-data frames of at most STREAM_PIECE, never more than window() of them
// unacknowledged (at most STREAM_WINDOW; less with many streams on one link, frames.js streamWindow); with the window used up the rest waits here and the socket is paused, an ack sends it on and resumes
// the socket. The socket's FIN goes as stream-end, after everything read before it.
// In: stream-data is written to the socket and acknowledged once that write's callback fired (the bytes left this
// process), so a service or browser that does not read stops the sender a window later; stream-end ends the socket's
// writing side (a half close: it may still be read). A sender that ignores the window is cut off.
// Nothing is dropped or reordered: the link keeps the order, and every byte read is either sent or waiting. A socket
// that closed cleanly (both sides ended) while bytes it had read still wait for the window is not the stream's end:
// they are sent as the acks come, then stream-end, and only then is the pipe done.
//
// The socket must be made with allowHalfOpen: true. A socket paused by its owner before the pipe is made stays paused
// until the owner resumes it (the viewer does, once the host has answered ports.open): nothing is read meanwhile.
//
// createPipe({ socket, id, send(frame), done(clean), active(), window() }) -> { frame(f), destroy() }
//   window(): how much this stream may have unacknowledged now (asked before every piece).
//   frame(f): a decoded stream-* frame of this stream from the other side.
//   done(clean): once, when the pipe is over - clean: both sides ended, no error, and everything read was sent;
//   otherwise (an error, a socket closed early, destroy()) the other side has to be told: it is not told here.
//   active(): bytes or frames moved (for an idle timer). destroy(): the socket goes at once, what waits is dropped.
const frames = require("./frames");
const { STREAM_WINDOW, STREAM_PIECE } = frames;

function createPipe({ socket, id, send, done = () => {}, active = () => {}, window = () => STREAM_WINDOW }) {
  const waiting = [];   // read from the socket, not sent yet (the window was full)
  let unacked = 0;      // sent, not acknowledged yet
  let unwritten = 0;    // received, not written to the socket yet
  let held = false, readEnded = false, endSent = false, endGot = false, closed = false, over = false;

  function finish(clean) {
    if (over) return;
    over = true;
    waiting.length = 0;
    done(clean);
  }

  function pump() {
    // A piece goes out whole or waits for the acks: filling what is left of the window with a few bytes makes the
    // next ack free just those few again, and the stream goes on in slivers (a window is never under a piece).
    for (let n; waiting.length && (n = Math.min(waiting[0].length, STREAM_PIECE)) <= Math.min(window(), STREAM_WINDOW) - unacked;) {
      const chunk = waiting[0];
      send(frames.encodeStreamData(id, chunk.subarray(0, n)));
      unacked += n;
      if (n === chunk.length) waiting.shift();
      else waiting[0] = chunk.subarray(n);
    }
    if (waiting.length) {
      if (!held) { held = true; socket.pause(); }
      return;
    }
    if (held) { held = false; socket.resume(); }
    if (readEnded && !endSent) { endSent = true; send(frames.encodeStreamEnd(id)); }
    if (closed) finish(true);
  }
  socket.on("data", chunk => {
    if (over) return;
    active();
    waiting.push(chunk);
    pump();
  });
  socket.on("end", () => { readEnded = true; if (!over) pump(); });
  socket.on("error", () => {}); // "close" follows
  socket.on("close", hadError => {
    closed = true;
    if (hadError || !readEnded || !endGot) finish(false);
    else if (!over) pump(); // done once what was read has gone out
  });

  function frame(f) {
    if (over) return;
    active();
    if (f.type === "stream-ack") {
      unacked = Math.max(0, unacked - f.count);
      pump();
    } else if (f.type === "stream-end") {
      if (!endGot) { endGot = true; socket.end(); }
    } else if (f.type === "stream-data" && !endGot && f.bytes.length) {
      const n = f.bytes.length;
      unwritten += n;
      if (unwritten > STREAM_WINDOW) return void socket.destroy(); // the sender ignores the window
      socket.write(f.bytes, err => {
        unwritten -= n;
        if (!err && !over) send(frames.encodeStreamAck(id, n));
      });
    }
  }
  return { frame, destroy: () => { socket.destroy(); finish(false); } };
}

module.exports = { createPipe };
