// The binary frames of a link (protocol.js): a terminal's output, input and size pass as bytes, not as JSON.
// [type:1][terminal id:16 (the UUID's bytes)][payload]. Output carries `end` first (8 bytes BE: the output's length
// since the terminal was attached, as terminals.js counts it) and then the text; input is the text; resize is
// cols:2 BE, rows:2 BE.
// Runs in Node and, bundled, in the phone's WebView: Uint8Arrays only, no Buffer. The encoders answer Uint8Arrays
// (what a WebSocket of either kind sends as they are); decode takes any Uint8Array, a Node Buffer included.
//
// A forwarded port's TCP stream (docs/PORT-FORWARDING.md) rides in the same shape, the id being the stream's:
// stream data is the raw bytes, never text; stream end says this side has no more to send (the other may still);
// stream ack is count:4 BE, the bytes of this stream the receiver has handed on since its last ack (the sender keeps
// at most STREAM_WINDOW unacknowledged, in pieces of at most STREAM_PIECE).
const OUTPUT = 0, INPUT = 1, RESIZE = 2, STREAM_DATA = 3, STREAM_END = 4, STREAM_ACK = 5;
const STREAM_WINDOW = 256 * 1024, STREAM_PIECE = 32 * 1024;
// What all the streams of one link may have unacknowledged together, more or less: a link through a relay that is
// older than relay.js's flow control is closed by that relay once 1 MB waits there for a slow last leg, and a
// browser loads a page over six connections at once. A stream's share: streamWindow(how many streams the link has).
const STREAM_BUDGET = 512 * 1024;
const streamWindow = streams => Math.max(STREAM_PIECE, Math.min(STREAM_WINDOW, Math.floor(STREAM_BUDGET / Math.max(1, streams))));
const HEAD = 17;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder(), decoder = new TextDecoder();

function idToBytes(id) {
  const h = id.replace(/-/g, ""), out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
function bytesToId(b) {
  let h = "";
  for (const x of b) h += x.toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function frame(type, id, payload) {
  if (!UUID.test(id)) throw new Error("not a terminal id");
  const out = new Uint8Array(HEAD + payload.length);
  out[0] = type;
  out.set(idToBytes(id), 1);
  out.set(payload, HEAD);
  return out;
}
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
function encodeOutput(id, data, end) {
  const text = encoder.encode(data), payload = new Uint8Array(8 + text.length);
  view(payload).setBigUint64(0, BigInt(end));
  payload.set(text, 8);
  return frame(OUTPUT, id, payload);
}
const encodeInput = (id, data) => frame(INPUT, id, encoder.encode(data));
function encodeResize(id, cols, rows) {
  const b = new Uint8Array(4);
  view(b).setUint16(0, Math.max(0, Math.min(65535, cols | 0)));
  view(b).setUint16(2, Math.max(0, Math.min(65535, rows | 0)));
  return frame(RESIZE, id, b);
}
// bytes: a Uint8Array (a Buffer is one) of at most STREAM_PIECE.
const encodeStreamData = (id, bytes) => frame(STREAM_DATA, id, bytes);
const encodeStreamEnd = id => frame(STREAM_END, id, new Uint8Array(0));
function encodeStreamAck(id, count) {
  const b = new Uint8Array(4);
  view(b).setUint32(0, count);
  return frame(STREAM_ACK, id, b);
}
// -> { type: "output", id, data, end } | { type: "input", id, data } | { type: "resize", id, cols, rows }
//  | { type: "stream-data", id, bytes: a view into buf } | { type: "stream-end", id } | { type: "stream-ack", id, count }
//  | null
function decode(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < HEAD) return null;
  const id = bytesToId(buf.subarray(1, HEAD)), payload = buf.subarray(HEAD);
  switch (buf[0]) {
    case OUTPUT: return payload.length < 8 ? null : { type: "output", id, end: Number(view(payload).getBigUint64(0)), data: decoder.decode(payload.subarray(8)) };
    case INPUT: return { type: "input", id, data: decoder.decode(payload) };
    case RESIZE: return payload.length < 4 ? null : { type: "resize", id, cols: view(payload).getUint16(0), rows: view(payload).getUint16(2) };
    case STREAM_DATA: return { type: "stream-data", id, bytes: payload };
    case STREAM_END: return { type: "stream-end", id };
    case STREAM_ACK: return payload.length < 4 ? null : { type: "stream-ack", id, count: view(payload).getUint32(0) };
    default: return null;
  }
}

module.exports = { encodeOutput, encodeInput, encodeResize, encodeStreamData, encodeStreamEnd, encodeStreamAck, decode, UUID, STREAM_WINDOW, STREAM_PIECE, streamWindow };
