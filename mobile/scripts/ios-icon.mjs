// Draws the iOS app icon and the launch screen's picture from the app's own drawing (static/icon.svg: a rounded
// square in the accent's gradient with a prompt in white) into ios/App/App/Assets.xcassets. The results are in git;
// run it again (node scripts/ios-icon.mjs) only when the drawing changes - the numbers below are the SVG's.
// No image library: the shapes are two, so they are computed per pixel (4x4 samples each) and written as PNG by hand.
//   AppIcon-1024.png   the whole square, no rounded corners and no transparency (iOS cuts the corners itself)
//   splash@1x/2x/3x    the rounded icon on nothing, 96 pt: LaunchScreen.storyboard puts it on the page's background
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const assets = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "ios", "App", "App", "Assets.xcassets");

// The drawing, in the SVG's 64 x 64 units.
const FROM = [0x3b, 0x5f, 0xa9], TO = [0x7a, 0xa7, 0xff]; // the gradient, top left to bottom right
const RADIUS = 14;
const STROKE = 2.5; // half of stroke-width 5, round caps and joins
const LINES = [[17, 22, 27, 32], [27, 32, 17, 42], [31, 44, 47, 44]];

const distance = (x, y, [x1, y1, x2, y2]) => {
  const dx = x2 - x1, dy = y2 - y1;
  const k = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x1 - k * dx, y - y1 - k * dy);
};
const inRounded = (x, y) => {
  const cx = Math.min(Math.max(x, RADIUS), 64 - RADIUS), cy = Math.min(Math.max(y, RADIUS), 64 - RADIUS);
  return Math.hypot(x - cx, y - cy) <= RADIUS;
};

// size: px; rounded: the corners cut (transparent) as the SVG has them.
function draw(size, rounded) {
  const N = 4, px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < N; sj++) {
        for (let si = 0; si < N; si++) {
          const x = (i + (si + 0.5) / N) * 64 / size, y = (j + (sj + 0.5) / N) * 64 / size;
          if (rounded && !inRounded(x, y)) continue;
          a++;
          if (LINES.some(l => distance(x, y, l) <= STROKE)) { r += 255; g += 255; b += 255; continue; }
          const t = (x + y) / 128;
          r += FROM[0] + (TO[0] - FROM[0]) * t; g += FROM[1] + (TO[1] - FROM[1]) * t; b += FROM[2] + (TO[2] - FROM[2]) * t;
        }
      }
      const o = (j * size + i) * 4;
      if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
      px[o + 3] = Math.round(a * 255 / (N * N));
    }
  }
  return px;
}

const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let c = 0xffffffff;
  for (const x of body) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE((c ^ 0xffffffff) >>> 0, body.length + 4);
  return out;
}
// alpha: false writes RGB only (an app icon with an alpha channel is refused by the App Store).
function png(size, px, alpha) {
  const n = alpha ? 4 : 3, rows = Buffer.alloc(size * (size * n + 1));
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) px.copy(rows, j * (size * n + 1) + 1 + i * n, (j * size + i) * 4, (j * size + i) * 4 + n);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8;
  head[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const write = (file, size, rounded) => {
  writeFileSync(path.join(assets, file), png(size, draw(size, rounded), rounded));
  console.log(`${file}  ${size} x ${size}`);
};
write("AppIcon.appiconset/AppIcon-1024.png", 1024, false);
for (const k of [1, 2, 3]) write(`Splash.imageset/splash@${k}x.png`, 96 * k, true);
