// The binary frames of a link (protocol.js): a terminal's output, input and size pass as bytes, not as JSON.
// [type:1][terminal id:16 (the UUID's bytes)][payload]. Output carries `end` first (8 bytes BE: the output's length
// since the terminal was attached, as terminals.js counts it) and then the text; input is the text; resize is
// cols:2 BE, rows:2 BE.
const OUTPUT = 0, INPUT = 1, RESIZE = 2;
const HEAD = 17;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idToBytes = id => Buffer.from(id.replace(/-/g, ""), "hex");
function bytesToId(b) {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function frame(type, id, payload) {
  if (!UUID.test(id)) throw new Error("not a terminal id");
  const head = Buffer.alloc(HEAD);
  head[0] = type;
  idToBytes(id).copy(head, 1);
  return Buffer.concat([head, payload]);
}
function encodeOutput(id, data, end) {
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(BigInt(end));
  return frame(OUTPUT, id, Buffer.concat([n, Buffer.from(data, "utf8")]));
}
const encodeInput = (id, data) => frame(INPUT, id, Buffer.from(data, "utf8"));
function encodeResize(id, cols, rows) {
  const b = Buffer.alloc(4);
  b.writeUInt16BE(Math.max(0, Math.min(65535, cols | 0)), 0);
  b.writeUInt16BE(Math.max(0, Math.min(65535, rows | 0)), 2);
  return frame(RESIZE, id, b);
}
// -> { type: "output", id, data, end } | { type: "input", id, data } | { type: "resize", id, cols, rows } | null
function decode(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEAD) return null;
  const id = bytesToId(buf.subarray(1, HEAD)), payload = buf.subarray(HEAD);
  switch (buf[0]) {
    case OUTPUT: return payload.length < 8 ? null : { type: "output", id, end: Number(payload.readBigUInt64BE(0)), data: payload.subarray(8).toString("utf8") };
    case INPUT: return { type: "input", id, data: payload.toString("utf8") };
    case RESIZE: return payload.length < 4 ? null : { type: "resize", id, cols: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) };
    default: return null;
  }
}

module.exports = { encodeOutput, encodeInput, encodeResize, decode, UUID };
