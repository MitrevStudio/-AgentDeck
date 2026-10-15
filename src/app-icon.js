// Draws the app icon in code (blue rounded square with a top bar and three tiles, like the edge menu),
// so the tray and taskbar have an icon without shipping an image asset.
const { nativeImage } = require("electron");

const clamp01 = v => Math.max(0, Math.min(1, v));

// badge: an amber dot in the bottom-right corner, as VoiceTray showed for recordings that failed.
function makeIcon(size = 32, scaleFactor = 1, { badge = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 32, radius = size * 0.22;
  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 * s && x < x1 * s && y >= y0 * s && y < y1 * s;
  const bx = 25 * s, by = 25 * s, bOuter = 6.5 * s, bInner = 5 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-square coverage with a one-pixel soft edge.
      const cx = Math.min(Math.max(x + 0.5, radius), size - radius);
      const cy = Math.min(Math.max(y + 0.5, radius), size - radius);
      let a = clamp01(radius - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5);
      const t = (x + y) / (2 * size);
      let r = 59 + 63 * t, g = 95 + 72 * t, b = 169 + 86 * t;
      if (inRect(x, y, 7, 7, 25, 11) || inRect(x, y, 7, 15, 12, 25) || inRect(x, y, 13.5, 15, 18.5, 25) || inRect(x, y, 20, 15, 25, 25)) r = g = b = 255;
      if (badge) {
        const d = Math.hypot(x + 0.5 - bx, y + 0.5 - by);
        const cover = clamp01(bOuter - d + 0.5);
        if (cover) {
          // Amber fill inside a dark ring, laid over the icon.
          const fill = clamp01(bInner - d + 0.5);
          const br = 40 + 205 * fill, bg = 40 + 130 * fill, bb = 40 - 10 * fill;
          const outA = cover + a * (1 - cover);
          r = (br * cover + r * a * (1 - cover)) / outA;
          g = (bg * cover + g * a * (1 - cover)) / outA;
          b = (bb * cover + b * a * (1 - cover)) / outA;
          a = outA;
        }
      }
      if (!a) continue;
      const i = (y * size + x) * 4; // BGRA, premultiplied
      buf[i] = Math.round(b * a); buf[i + 1] = Math.round(g * a); buf[i + 2] = Math.round(r * a); buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor });
}

module.exports = { makeIcon };
