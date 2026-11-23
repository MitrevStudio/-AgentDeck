// One screenshot's BGRA as an RGB PNG, off the main thread: nativeImage.toPNG() holds it for up to a second at 4K.
const { parentPort, workerData } = require("node:worker_threads");
const zlib = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UP = 2; // the filter: each byte less the one above it

function chunk(type, data) {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(head.subarray(4))), 0);
  return [head, data, crc];
}

const { width, height, bgra } = workerData;
const stride = width * 4;
if (bgra.length !== stride * height) throw new Error("the picture is not of that size");
const rows = Buffer.allocUnsafe((width * 3 + 1) * height);
let out = 0;
for (let y = 0; y < height; y++) {
  const row = y * stride, above = y ? row - stride : row;
  rows[out++] = y ? UP : 0;
  for (let x = 0; x < stride; x += 4) {
    for (let c = 2; c >= 0; c--) rows[out++] = y ? bgra[row + x + c] - bgra[above + x + c] : bgra[row + x + c];
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8; // bits a sample
header[9] = 2; // RGB
const png = new Uint8Array(Buffer.concat([
  SIGNATURE, ...chunk("IHDR", header), ...chunk("IDAT", zlib.deflateSync(rows, { level: 3 })), ...chunk("IEND", Buffer.alloc(0))
]));
parentPort.postMessage(png, [png.buffer]);
