// Reads whatever is selected in the foreground application by sending it the copy shortcut, then puts the user's
// clipboard back. Port of VoiceTray's SelectionCaptureService and ClipboardSnapshot.
//
// UI Automation would avoid the clipboard, but Electron apps, PDF readers and most terminals do not expose their
// selection through it; copying works everywhere and the snapshot makes it acceptable. Windows Terminal does expose
// it, and is read that way first (see UIA_CLASSES). The snapshot works on raw
// Win32 formats (Electron's clipboard cannot enumerate or write several application formats at once, and its
// readImage() has crashed the main process), so text, HTML, RTF, images, copied files and application formats
// are put back together in one go.
//
// The capture runs on a worker thread of its own, as VoiceTray gave it its own thread: reading a format the source
// application renders on demand (a large Excel range) takes as long as that application needs - seconds, or for
// ever if it hangs - and the app must stay responsive meanwhile.
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const w = require("./win32");
const { sleep } = require("./util");
const i18n = require("../i18n");
const { CF } = w;

const MODIFIER_RELEASE_TIMEOUT_MS = 1000; // the hotkey fires on key-down, so the chord is still held
const COPY_TIMEOUT_MS = 600;
const POLL_MS = 25;
const SETTLE_MS = 60;                     // some applications write the clipboard in several steps
const RESTORE_RETRY_DELAY_MS = 300;
// The thread is given up on after this; an application rendering its clipboard data for longer is hung.
const CAPTURE_TIMEOUT_MS = 20_000;

// A single screenshot or Excel range can be hundreds of MB; this runs per key press.
const MAX_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
// Read-aloud reads at most 10 000 characters; the copied text is read up to a few times that, never megabytes.
const MAX_TEXT_CHARS = 32 * 1024;

// Predefined formats that are plain memory and can be copied as bytes. Text/OEM text/locale and bitmap/metafile
// variants are left out: Windows synthesises them from what is restored, and the GDI ones are not memory at all.
const CARRIED_FORMATS = new Set([4, 5, 6, CF.DIB, 10, 11, 12, CF.UNICODETEXT, CF.HDROP, CF.DIBV5]);
const SKIP_NAMES = new Set([
  "filename", "filenamew",
  // Outlook and archive "virtual files": reading them makes the source materialise the attachment, and putting
  // them back does not produce working virtual files anyway.
  "filegroupdescriptor", "filegroupdescriptorw", "filecontents",
  // OLE plumbing that points at the source process's live data object.
  "dataobject", "ole private data", "embed source", "embedded object", "link source", "object descriptor",
  "link source descriptor"
]);
const PRIORITY = ["#13", "rich text format", "html format", "image", "#15"]; // filled first under the size caps

function carries(fmt, image) {
  if (fmt.id >= 0xc000) {
    const name = fmt.name.toLowerCase();
    return !!name && !SKIP_NAMES.has(name) && !fmt.name.startsWith("System.");
  }
  if (fmt.id === CF.DIB || fmt.id === CF.DIBV5) return fmt === image; // the other one is synthesised from it
  return CARRIED_FORMATS.has(fmt.id);
}
function rank(fmt) {
  const key = fmt.id === CF.DIB || fmt.id === CF.DIBV5 ? "image" : fmt.id >= 0xc000 ? fmt.name.toLowerCase() : `#${fmt.id}`;
  const i = PRIORITY.indexOf(key);
  return i < 0 ? PRIORITY.length : i;
}

// { readable, wasEmpty, items: [{ id, name, bytes }] } in the clipboard's own format order.
async function snapshotClipboard() {
  const r = await w.withClipboard(() => {
    const formats = w.listFormats().map((fmt, order) => ({ ...fmt, order }));
    if (!formats.length) return { readable: true, wasEmpty: true, items: [] };
    // Natively placed formats are enumerated before synthesised ones.
    const image = formats.find(fmt => fmt.id === CF.DIB || fmt.id === CF.DIBV5);
    const wanted = formats.filter(fmt => carries(fmt, image)).sort((a, b) => rank(a) - rank(b) || a.order - b.order);
    const items = [];
    let total = 0;
    for (const fmt of wanted) {
      const bytes = w.readFormat(fmt.id, { max: Math.min(MAX_ITEM_BYTES, MAX_TOTAL_BYTES - total) });
      if (!bytes) continue;
      total += bytes.length;
      items.push({ ...fmt, bytes });
    }
    items.sort((a, b) => a.order - b.order);
    return { readable: true, wasEmpty: false, items };
  });
  return r.ok ? r.value : { readable: false, wasEmpty: false, items: [] };
}

// False when the clipboard refused, or held only content that could not be carried (then it is left empty rather
// than holding the selection that was just copied).
async function restoreClipboard(snapshot) {
  if (!snapshot || !snapshot.readable) return false;
  const r = await w.withClipboard(() => {
    if (!w.emptyClipboard()) return false;
    let any = false;
    for (const item of snapshot.items) if (w.writeFormat(item.id, item.bytes)) any = true;
    return any || snapshot.wasEmpty;
  }, { owned: true });
  return r.ok && !!r.value;
}

// A clipboard manager holding the clipboard open usually lets go within moments.
async function restoreWithRetry(snapshot) {
  if (await restoreClipboard(snapshot)) return true;
  await sleep(RESTORE_RETRY_DELAY_MS);
  return restoreClipboard(snapshot);
}

async function waitForClipboardChange(before) {
  const end = Date.now() + COPY_TIMEOUT_MS;
  while (Date.now() < end) {
    let now = w.clipboardSeq();
    if (now !== before) {
      // Let the writer finish before reading what it wrote.
      await sleep(SETTLE_MS);
      while (w.clipboardSeq() !== now && Date.now() < end) {
        now = w.clipboardSeq();
        await sleep(SETTLE_MS);
      }
      return true;
    }
    await sleep(POLL_MS);
  }
  return false;
}

// diag (for selection.log): { keysMs, copyMs, seqBefore, seqAfter, read }, as far as the capture got.
const fail = (failure, diag) => ({ text: "", failure, clipboardRestored: true, diag });

// The capture itself, on the worker thread. targetHwnd: the foreground window when the hotkey was pressed - if the
// user has switched away by the time the keys are up, nothing is copied from the wrong place.
async function captureHere(targetHwnd) {
  const diag = {};
  let t0 = Date.now();
  // A held Shift turns Ctrl+C into Ctrl+Shift+C (DevTools in Chrome); a held Space types over the selection.
  const up = await w.waitModifiersUp(MODIFIER_RELEASE_TIMEOUT_MS, { alsoSpace: true });
  diag.keysMs = Date.now() - t0;
  if (!up) return fail("KeysHeld", diag);

  const fg = w.foregroundHwnd();
  if (targetHwnd && fg !== targetHwnd) return fail("FocusChanged", diag);

  const snapshot = await snapshotClipboard();
  // Taken after the snapshot, so a format rendered on demand while snapshotting cannot pass for a copy.
  const before = diag.seqBefore = w.clipboardSeq();
  t0 = Date.now();
  if (!w.sendCopy({ terminal: w.isTerminalClass(w.className(fg)) })) return fail("CopyFailed", diag);

  const copied = await waitForClipboardChange(before);
  diag.copyMs = Date.now() - t0;
  diag.seqAfter = w.clipboardSeq();
  // Nothing changed means nothing was selected: nothing to restore, and the old content is never read out.
  if (!copied) return fail("NothingSelected", diag);

  const text = await w.readClipboardText(MAX_TEXT_CHARS);
  // null: copied, but the clipboard stayed locked (a clipboard manager reading it) or held no text
  diag.read = text == null ? "fail" : text.trim() ? "ok" : "blank";
  const restored = await restoreWithRetry(snapshot);
  return text && text.trim()
    ? { text, failure: "None", clipboardRestored: restored, diag }
    : { text: "", failure: "NothingSelected", clipboardRestored: restored, diag };
}

// ---------- main thread ----------
let worker = null;
let nextCall = 1;
const pending = new Map(); // call id -> resolve

function settleAll(result) {
  for (const resolve of pending.values()) resolve(result);
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  const t = worker = new Worker(path.join(__dirname, "selection-worker.js"));
  t.unref();
  t.on("message", ({ id, result }) => { pending.get(id)?.(result); pending.delete(id); });
  const gone = message => {
    if (worker !== t) return;
    worker = null;
    settleAll({ text: "", failure: "CopyFailed", message, clipboardRestored: true });
  };
  t.on("error", e => { console.error("Selection worker failed:", e); gone(e.message); });
  t.on("exit", () => gone(i18n.t("voice.errors.copyStopped")));
  return t;
}

// msg: {hwnd} for a capture, {op: "text", max} for the clipboard's text. A thread that dies settles with a failed
// capture, whose empty text also serves as "no text".
function inWorker(msg, timedOut) {
  const t = ensureWorker();
  const id = nextCall++;
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      // Blocked inside the source application's clipboard rendering: that thread is left to it, the next capture
      // gets a new one.
      if (worker === t) { worker = null; t.terminate().catch(() => {}); }
      pending.delete(id);
      resolve(timedOut);
    }, CAPTURE_TIMEOUT_MS);
    pending.set(id, result => { clearTimeout(timer); resolve(result); });
    t.postMessage({ id, ...msg });
  });
}

// Terminals whose selection UI Automation reads: at once, from the hotkey, with no keys and no clipboard. The copy
// shortcut has to wait until the chord is let go, and a key that reaches the terminal meanwhile (the hotkey's own key
// repeating once the modifiers are up) dismisses the selection; the copy also needs a clipboard that clipboard
// managers and RDP's clipboard sync keep locked at times. The classic console has a UI Automation text area too, but
// reading its selection is untested; mintty, PuTTY and ConEmu do not expose theirs.
const UIA_CLASSES = new Set(["CASCADIA_HOSTING_WINDOW_CLASS"]);
const terminalFocus = () => require("../terminal-focus"); // main thread only: it needs Electron

async function readUia(hwnd) {
  const t0 = Date.now();
  try {
    const text = await terminalFocus().terminalSelection(hwnd, MAX_TEXT_CHARS);
    return { text, ms: Date.now() - t0, status: text.trim() ? "text" : "empty" };
  } catch (e) { return { text: "", ms: Date.now() - t0, status: "error", error: e.message }; }
}

// target: win32.foreground() taken when the hotkey was pressed.
// -> { text, failure: "None"|"NothingSelected"|"FocusChanged"|"KeysHeld"|"CopyFailed", clipboardRestored, message? }
// Copying never happens at the same time as a delivery: both borrow the clipboard.
async function capture(target) {
  const t0 = Date.now();
  const uia = UIA_CLASSES.has(target?.className) ? await readUia(target.hwnd) : null;
  const r = uia?.text.trim() ? { text: uia.text, failure: "None", clipboardRestored: true }
    : await w.exclusive(() => inWorker({ hwnd: target?.hwnd ?? null },
      { text: "", failure: "CopyFailed", message: i18n.t("voice.errors.copyHung"), clipboardRestored: false }));
  logCapture(target, uia, r, Date.now() - t0);
  return r;
}

// The clipboard's text as it is (at most maxChars characters), or null. On the capture's thread, for the same
// reason as the capture: the application that copied it may render it only now.
async function clipboardText(maxChars) {
  const r = await w.exclusive(() => inWorker({ op: "text", max: maxChars }, { text: null }));
  return r.text || null;
}

// userData/logs/selection.log: one line per capture, how it went - never what was selected.
const LOG_MAX_BYTES = 200 * 1024;
let logFile = null, logging = Promise.resolve();
function logCapture(target, uia, r, totalMs) {
  const d = r.diag || {};
  const ms = v => (v == null ? "-" : `${v}ms`);
  const line = [
    new Date().toISOString(), `class=${target?.className || "-"}`, `method=${uia?.text.trim() ? "uia" : "copy"}`,
    `uia=${uia ? `${uia.status}/${uia.ms}ms` : "-"}`, `keys=${ms(d.keysMs)}`, `copy=${ms(d.copyMs)}`,
    `seq=${d.seqBefore ?? "-"}>${d.seqAfter ?? "-"}`, `read=${d.read ?? "-"}`, `total=${totalMs}ms`,
    `result=${r.failure}`, `chars=${r.text.length}`,
    ...(uia?.error ? [`uiaError=${JSON.stringify(uia.error)}`] : [])
  ].join(" ");
  writeLog(line);
}
// The "nothing selected" notice's fallback, taken: the clipboard was read instead. via: "button" | "hotkey".
function logClipboardRead({ via, chars, ageMs }) {
  writeLog([new Date().toISOString(), "method=clipboard", `via=${via}`, `chars=${chars}`,
    `age=${ageMs == null ? "-" : `${Math.round(ageMs / 1000)}s`}`].join(" "));
}
function writeLog(line) {
  logging = logging.then(() => appendLog(line)).catch(e => console.error("Writing selection.log failed:", e.message));
}
async function appendLog(line) {
  logFile ??= path.join(require("electron").app.getPath("userData"), "logs", "selection.log");
  await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
  const size = await fs.promises.stat(logFile).then(s => s.size, () => 0);
  if (size > LOG_MAX_BYTES) await fs.promises.rename(logFile, `${logFile}.1`);
  await fs.promises.appendFile(logFile, line + "\n");
}

// Starts the thread - and the terminal helper - ahead of the first capture; dispose() ends the thread.
const warmUp = () => { ensureWorker(); terminalFocus().keepWarm(); };
function dispose() {
  const t = worker;
  worker = null;
  settleAll({ text: "", failure: "CopyFailed", clipboardRestored: true });
  t?.terminate().catch(() => {});
}

module.exports = { capture, captureHere, clipboardText, logClipboardRead, warmUp, dispose, snapshotClipboard, restoreClipboard };
