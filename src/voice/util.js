// Small helpers shared by the voice modules (main process and the selection worker).

// Record ids: they become file names, so nothing that could climb out of the records folder.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, "0");
const hhmm = s => { const d = new Date(Date.parse(s) || Date.now()); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// IPC hands over typed arrays and ArrayBuffers; a Buffer view over the same memory, no copy.
function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  throw new TypeError("expected a Buffer, typed array or ArrayBuffer");
}

// An Electron accelerator as people read it: "Control+Shift+Space" -> "Ctrl+Shift+Space" (or "Ctrl + Shift + Space").
const keyLabel = (accel, sep = "+") => String(accel || "").replace(/Control/g, "Ctrl").replace(/Super/g, "Win").split("+").join(sep);

module.exports = { SAFE_ID, isObj, sleep, pad, hhmm, toBuffer, keyLabel };
