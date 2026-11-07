// Small helpers shared by the voice modules (main process and the selection worker) and a few of the app's own.

// Record ids: they become file names, so nothing that could climb out of the records folder.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
// White space folded to single spaces and trimmed; "" for anything that is not a string (settings and model answers
// are not trusted to hold strings). fold(): the same, ignoring case.
const flat = v => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const fold = v => flat(v).toLocaleLowerCase();
// A folder as a comparison key - the pages' normPath() (common.js) does the same.
const normPath = p => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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

module.exports = { SAFE_ID, isObj, flat, fold, normPath, sleep, pad, hhmm, toBuffer, keyLabel };
