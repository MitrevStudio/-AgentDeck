// The binary frames of a link (protocol.js): a terminal's output, input and size pass as bytes, not as JSON.
// [type:1][terminal id:16 (the UUID's bytes)][payload]. Output carries `end` first (8 bytes BE: the output's length
// since the terminal was attached, as terminals.js counts it) and then the text; input is the text; resize is
// cols:2 BE, rows:2 BE.
// Runs in Node and, bundled, in the phone's WebView: Uint8Arrays only, no Buffer. The encoders answer Uint8Arrays
// (what a WebSocket of either kind sends as they are); decode takes any Uint8Array, a Node Buffer included.
const OUTPUT = 0, INPUT = 1, RESIZE = 2;
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
// -> { type: "output", id, data, end } | { type: "input", id, data } | { type: "resize", id, cols, rows } | null
function decode(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < HEAD) return null;
  const id = bytesToId(buf.subarray(1, HEAD)), payload = buf.subarray(HEAD);
  switch (buf[0]) {
    case OUTPUT: return payload.length < 8 ? null : { type: "output", id, end: Number(view(payload).getBigUint64(0)), data: decoder.decode(payload.subarray(8)) };
    case INPUT: return { type: "input", id, data: decoder.decode(payload) };
    case RESIZE: return payload.length < 4 ? null : { type: "resize", id, cols: view(payload).getUint16(0), rows: view(payload).getUint16(2) };
    default: return null;
  }
}

module.exports = { encodeOutput, encodeInput, encodeResize, decode, UUID };
