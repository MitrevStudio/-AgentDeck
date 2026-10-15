// user32/kernel32 through koffi: window targets, focus, synthetic keys, the raw clipboard and global hotkeys.
// Port of VoiceTray's KeyboardInjectionService plus the P/Invoke parts of HotkeyService, TextDeliveryService,
// SelectionCaptureService and ClipboardSnapshot. Loaded by the main thread (hotkeys, focus, delivery) and by the
// selection worker (selection-worker.js), which owns the slow part of reading the clipboard.
const koffi = require("koffi");
const { sleep } = require("./util");

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

// Named opaque pointers come back as BigInt (null for NULL) in koffi 3.
const HWND = koffi.pointer("HWND", koffi.opaque());
const HANDLE = koffi.pointer("HANDLE", koffi.opaque());

const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "long", dy: "long", mouseData: "uint32_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t"
});
const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16_t", wScan: "uint16_t", dwFlags: "uint32_t", time: "uint32_t", dwExtraInfo: "uintptr_t"
});
const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", { uMsg: "uint32_t", wParamL: "uint16_t", wParamH: "uint16_t" });
const INPUT = koffi.struct("INPUT", {
  type: "uint32_t",
  u: koffi.union("INPUT_UNION", { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT })
});
const INPUT_SIZE = koffi.sizeof(INPUT); // 40 on x64

const f = {
  GetForegroundWindow: user32.func("HWND __stdcall GetForegroundWindow()"),
  SetForegroundWindow: user32.func("bool __stdcall SetForegroundWindow(HWND hWnd)"),
  GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(HWND hWnd, _Out_ uint32_t *pid)"),
  GetClassNameW: user32.func("int __stdcall GetClassNameW(HWND hWnd, _Out_ uint8_t *buf, int maxChars)"),
  IsWindow: user32.func("bool __stdcall IsWindow(HWND hWnd)"),
  IsIconic: user32.func("bool __stdcall IsIconic(HWND hWnd)"),
  ShowWindow: user32.func("bool __stdcall ShowWindow(HWND hWnd, int cmd)"),
  GetAsyncKeyState: user32.func("int16_t __stdcall GetAsyncKeyState(int vKey)"),
  MapVirtualKeyW: user32.func("uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)"),
  SendInput: user32.func("uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int cbSize)"),
  keybd_event: user32.func("void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)"),
  RegisterHotKey: user32.func("bool __stdcall RegisterHotKey(HWND hWnd, int id, uint32_t mods, uint32_t vk)"),
  UnregisterHotKey: user32.func("bool __stdcall UnregisterHotKey(HWND hWnd, int id)"),
  CreateWindowExW: user32.func("HWND __stdcall CreateWindowExW(uint32_t exStyle, str16 cls, str16 name, uint32_t style, int x, int y, int w, int h, HWND parent, HANDLE menu, HANDLE inst, HANDLE param)"),
  DestroyWindow: user32.func("bool __stdcall DestroyWindow(HWND hWnd)"),
  GetClipboardSequenceNumber: user32.func("uint32_t __stdcall GetClipboardSequenceNumber()"),
  AddClipboardFormatListener: user32.func("bool __stdcall AddClipboardFormatListener(HWND hWnd)"),
  RemoveClipboardFormatListener: user32.func("bool __stdcall RemoveClipboardFormatListener(HWND hWnd)"),
  OpenClipboard: user32.func("bool __stdcall OpenClipboard(HWND owner)"),
  CloseClipboard: user32.func("bool __stdcall CloseClipboard()"),
  EmptyClipboard: user32.func("bool __stdcall EmptyClipboard()"),
  EnumClipboardFormats: user32.func("uint32_t __stdcall EnumClipboardFormats(uint32_t format)"),
  GetClipboardFormatNameW: user32.func("int __stdcall GetClipboardFormatNameW(uint32_t format, _Out_ uint8_t *buf, int maxChars)"),
  GetClipboardData: user32.func("HANDLE __stdcall GetClipboardData(uint32_t format)"),
  SetClipboardData: user32.func("HANDLE __stdcall SetClipboardData(uint32_t format, HANDLE mem)"),
  GlobalAlloc: kernel32.func("HANDLE __stdcall GlobalAlloc(uint32_t flags, size_t bytes)"),
  GlobalLock: kernel32.func("void * __stdcall GlobalLock(HANDLE mem)"),
  GlobalUnlock: kernel32.func("bool __stdcall GlobalUnlock(HANDLE mem)"),
  GlobalSize: kernel32.func("size_t __stdcall GlobalSize(HANDLE mem)"),
  GlobalFree: kernel32.func("HANDLE __stdcall GlobalFree(HANDLE mem)"),
  RtlMoveMemory: kernel32.func("void __stdcall RtlMoveMemory(void *dst, const void *src, size_t n)"),
  GetModuleHandleW: kernel32.func("HANDLE __stdcall GetModuleHandleW(str16 name)"),
  OpenProcess: kernel32.func("HANDLE __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
  GetProcessTimes: kernel32.func("bool __stdcall GetProcessTimes(HANDLE proc, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)"),
  CloseHandle: kernel32.func("bool __stdcall CloseHandle(HANDLE h)"),
  OpenMutexW: kernel32.func("HANDLE __stdcall OpenMutexW(uint32_t access, bool inherit, str16 name)")
};

const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2, KEYEVENTF_UNICODE = 0x4;
const VK = { SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, LWIN: 0x5b, RWIN: 0x5c, SPACE: 0x20, INSERT: 0x2d, C: 0x43, V: 0x56 };
const SW_RESTORE = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const FOCUS_POLL_MS = 40;
const TYPING_CHUNK_CHARS = 64; // one syscall per character is slow, one per transcript is fragile

async function waitUntil(cond, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

// Delivery and selection capture both type into the foreground window and borrow the clipboard; they must
// never interleave (VoiceTray ran each on its own queue thread).
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- windows ----------

const toHwnd = h => (h == null || h === 0 || h === 0n ? null : BigInt(h));
const hwndOf = win => win.getNativeWindowHandle().readBigUInt64LE(0);
const foregroundHwnd = () => f.GetForegroundWindow();

function className(hwnd) {
  hwnd = toHwnd(hwnd);
  if (!hwnd) return "";
  const buf = Buffer.alloc(512);
  const n = f.GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString("utf16le", 0, n * 2) : "";
}
function windowPid(hwnd) {
  const pid = [0];
  f.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}
// Process creation time in ms since the epoch, 0 when the process cannot be opened (then the pid alone is matched).
function processStart(pid) {
  if (!pid) return 0;
  const h = f.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return 0;
  try {
    const c = [0], e = [0], k = [0], u = [0];
    if (!f.GetProcessTimes(h, c, e, k, u)) return 0;
    return Number(BigInt(c[0]) / 10000n) - 11644473600000;
  } finally { f.CloseHandle(h); }
}

// The window in front, with enough identity to notice later that its handle was recycled by another process.
function foreground() {
  const hwnd = f.GetForegroundWindow();
  if (!hwnd) return { hwnd: null, pid: 0, className: "", procStart: 0 };
  const pid = windowPid(hwnd);
  return { hwnd, pid, className: className(hwnd), procStart: processStart(pid) };
}

function isAlive(target) {
  const hwnd = toHwnd(target && target.hwnd);
  if (!hwnd || !f.IsWindow(hwnd)) return false;
  if (windowPid(hwnd) !== target.pid) return false;
  if (!target.procStart) return true;
  return processStart(target.pid) === target.procStart;
}

// SetForegroundWindow's return value lies in both directions, so polling GetForegroundWindow is the verdict.
async function focus(target, timeoutMs = 400) {
  if (!isAlive(target)) return false;
  const hwnd = toHwnd(target.hwnd);
  if (f.GetForegroundWindow() === hwnd) return true;
  if (f.IsIconic(hwnd)) f.ShowWindow(hwnd, SW_RESTORE);
  f.SetForegroundWindow(hwnd);
  return waitUntil(() => f.GetForegroundWindow() === hwnd, timeoutMs, FOCUS_POLL_MS);
}

// Whether some process holds a named mutex - e.g. another app's single-instance one ("Local\VoiceTray.SingleInstance").
function mutexExists(name) {
  const h = f.OpenMutexW(SYNCHRONIZE, false, name);
  if (!h) return false;
  f.CloseHandle(h);
  return true;
}

// Terminals treat Ctrl+C as "interrupt" when nothing is selected; they all accept Ctrl+Insert as copy.
const TERMINAL_CLASSES = new Set([
  "ConsoleWindowClass",            // conhost: cmd, PowerShell
  "CASCADIA_HOSTING_WINDOW_CLASS", // Windows Terminal
  "mintty",                        // Git Bash, Cygwin
  "PuTTY",
  "VirtualConsoleClass"            // ConEmu
]);
const isTerminalClass = cls => TERMINAL_CLASSES.has(String(cls || ""));

// ---------- keyboard ----------

const isDown = vk => (f.GetAsyncKeyState(vk) & 0x8000) !== 0;
const anyModifierDown = () => [VK.CONTROL, VK.SHIFT, VK.MENU, VK.LWIN, VK.RWIN].some(isDown);

// The hotkeys fire on key-down, so the chord is usually still held. With alsoSpace a held Space counts too: once
// Ctrl/Shift are up, its auto-repeat would reach the focused window as typing and replace the selection.
function waitModifiersUp(timeoutMs = 500, { alsoSpace = false } = {}) {
  return waitUntil(() => !anyModifierDown() && !(alsoSpace && isDown(VK.SPACE)), timeoutMs, 20);
}

// A synthetic key that looks like a real one: without the scan code, apps that resolve shortcuts by physical
// key (VS Code) see an unknown key and ignore it.
function key(vk, up) {
  let flags = up ? KEYEVENTF_KEYUP : 0;
  if (vk === VK.INSERT) flags |= KEYEVENTF_EXTENDEDKEY; // Insert shares its scan code with numpad 0
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: f.MapVirtualKeyW(vk, 0), dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}
const chord = (mod, vk) => [key(mod, false), key(vk, false), key(vk, true), key(mod, true)];
const send = inputs => f.SendInput(inputs.length, inputs, INPUT_SIZE) === inputs.length;

function sendCtrlV() {
  if (send(chord(VK.CONTROL, VK.V))) return true;
  // VoiceTray fell back to SendKeys here; keybd_event is the same last resort and reports nothing.
  try {
    for (const k of chord(VK.CONTROL, VK.V)) f.keybd_event(k.u.ki.wVk, k.u.ki.wScan, k.u.ki.dwFlags, 0);
    return true;
  } catch { return false; }
}

function sendCopy({ terminal = false } = {}) {
  return send(chord(VK.CONTROL, terminal ? VK.INSERT : VK.C));
}

function typeUnicode(text) {
  const s = String(text);
  for (let off = 0; off < s.length; off += TYPING_CHUNK_CHARS) {
    const inputs = [];
    for (let i = off; i < Math.min(off + TYPING_CHUNK_CHARS, s.length); i++) {
      const cu = s.charCodeAt(i);
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: cu, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } });
      inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: cu, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } });
    }
    if (!send(inputs)) return false;
  }
  return true;
}

// ---------- clipboard ----------

// Changes on every clipboard write: the only reliable way to tell "the selection was copied" from "nothing was
// selected", without which whatever was already on the clipboard (a password?) would be read out.
const clipboardSeq = () => f.GetClipboardSequenceNumber();

const CF = { TEXT: 1, BITMAP: 2, METAFILEPICT: 3, OEMTEXT: 7, DIB: 8, PALETTE: 9, UNICODETEXT: 13, ENHMETAFILE: 14, HDROP: 15, LOCALE: 16, DIBV5: 17 };
const GMEM_MOVEABLE = 0x2;
const HWND_MESSAGE = -3n;

// Runs fn with the clipboard open. Clipboard managers, RDP and Office routinely hold it open for a moment, so
// opening is retried like VoiceTray's SetDataObject(retryTimes: 10, retryDelay: 50). fn must be synchronous;
// resolves to { ok:false } when the clipboard could not be opened or fn threw.
//
// Writing (`owned`) needs a window to own what is written - EmptyClipboard with a NULL owner makes SetClipboardData
// fail. It is a message-only window made for the write and destroyed right after: the next writer anywhere sends
// the owner WM_DESTROYCLIPBOARD and waits for the answer, which a worker thread (it pumps no messages) never gives.
// The data itself stays on the clipboard.
async function withClipboard(fn, { owned = false, tries = 10, delayMs = 50 } = {}) {
  const owner = owned ? f.CreateWindowExW(0, "STATIC", "AISM clipboard", 0, 0, 0, 0, 0, HWND_MESSAGE, null, f.GetModuleHandleW(null), null) : null;
  try {
    for (let i = 0; ; i++) {
      if (f.OpenClipboard(owner)) break;
      if (i + 1 >= tries) return { ok: false };
      await sleep(delayMs);
    }
    try { return { ok: true, value: fn() }; } catch (error) {
      console.error("Clipboard access failed:", error.message);
      return { ok: false, error };
    } finally { f.CloseClipboard(); }
  } finally {
    if (owner) f.DestroyWindow(owner);
  }
}

// The following run only inside withClipboard().
function formatName(id) {
  const buf = Buffer.alloc(512);
  const n = f.GetClipboardFormatNameW(id, buf, 256);
  return n > 0 ? buf.toString("utf16le", 0, n * 2) : "";
}
function listFormats() {
  const out = [];
  for (let id = f.EnumClipboardFormats(0); id; id = f.EnumClipboardFormats(id)) out.push({ id, name: formatName(id) });
  return out;
}
// Formats whose data is an HGLOBAL. Anything else (CF_BITMAP, CF_PALETTE, CF_ENHMETAFILE, private and GDI-object
// ranges) holds a different kind of handle, and GlobalSize/GlobalLock on one corrupts the heap.
const MEMORY_FORMATS = new Set([CF.TEXT, 4, 5, 6, CF.OEMTEXT, CF.DIB, 10, 11, 12, CF.UNICODETEXT, CF.HDROP, CF.LOCALE, CF.DIBV5]);
const isMemoryFormat = id => id >= 0xc000 || MEMORY_FORMATS.has(id);

// Bytes of an HGLOBAL-backed format; null when absent or not memory. Larger than `max`: null, or with `prefix` its
// first `max` bytes.
function readFormat(id, { max = Infinity, prefix = false } = {}) {
  if (!isMemoryFormat(id)) return null;
  const h = f.GetClipboardData(id);
  if (!h) return null;
  let size = Number(f.GlobalSize(h));
  if (!size || (size > max && !prefix)) return null;
  size = Math.min(size, max);
  const p = f.GlobalLock(h);
  if (!p) return null;
  // A copy, not koffi.view(): Electron forbids ArrayBuffers over external memory (fatal napi error).
  const out = Buffer.alloc(size);
  try { f.RtlMoveMemory(out, p, size); } finally { f.GlobalUnlock(h); }
  return out;
}
function writeFormat(id, bytes) {
  if (!isMemoryFormat(id) || !bytes || !bytes.length) return false;
  const h = f.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
  if (!h) return false;
  const p = f.GlobalLock(h);
  if (!p) { f.GlobalFree(h); return false; }
  f.RtlMoveMemory(p, bytes, bytes.length);
  f.GlobalUnlock(h);
  if (f.SetClipboardData(id, h)) return true; // the system owns the memory now
  f.GlobalFree(h);
  return false;
}
const emptyClipboard = () => f.EmptyClipboard();
function decodeText(buf) {
  if (!buf) return null;
  let end = buf.length & ~1;
  for (let i = 0; i + 1 < end; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) { end = i; break; }
  return buf.toString("utf16le", 0, end);
}
const encodeText = text => Buffer.concat([Buffer.from(String(text), "utf16le"), Buffer.alloc(2)]);

// At most maxChars characters: a whole copied document can be megabytes, and only its start is ever read aloud.
async function readClipboardText(maxChars = Infinity) {
  const r = await withClipboard(() => decodeText(readFormat(CF.UNICODETEXT, { max: maxChars * 2, prefix: true })));
  return r.ok && r.value != null ? r.value.replace(/[\uD800-\uDBFF]$/, "") : null; // half a character where it was cut
}
async function writeClipboardText(text) {
  const r = await withClipboard(() => f.EmptyClipboard() && writeFormat(CF.UNICODETEXT, encodeText(text)), { owned: true });
  return r.ok && !!r.value;
}

// When the clipboard last changed, as seen by one of our windows: {at, seq}, or null before the first change since
// the start. Windows posts WM_CLIPBOARDUPDATE to listeners; nothing is polled.
const WM_CLIPBOARDUPDATE = 0x031d;
function watchClipboard(browserWindow) {
  const hwnd = hwndOf(browserWindow);
  let last = null;
  browserWindow.hookWindowMessage(WM_CLIPBOARDUPDATE, () => { last = { at: Date.now(), seq: clipboardSeq() }; });
  const listening = f.AddClipboardFormatListener(hwnd);
  return {
    last: () => last,
    dispose() {
      if (browserWindow.isDestroyed()) return;
      if (listening) f.RemoveClipboardFormatListener(hwnd);
      browserWindow.unhookWindowMessage(WM_CLIPBOARDUPDATE);
    }
  };
}

// ---------- hotkeys ----------

const WM_HOTKEY = 0x0312;
const MOD = { ALT: 0x1, CONTROL: 0x2, SHIFT: 0x4, WIN: 0x8, NOREPEAT: 0x4000 };
const MODIFIER_TOKENS = {
  control: MOD.CONTROL, ctrl: MOD.CONTROL, commandorcontrol: MOD.CONTROL, cmdorctrl: MOD.CONTROL,
  alt: MOD.ALT, option: MOD.ALT, altgr: MOD.CONTROL | MOD.ALT, shift: MOD.SHIFT,
  super: MOD.WIN, meta: MOD.WIN, command: MOD.WIN, cmd: MOD.WIN
};
const KEY_TOKENS = {
  space: 0x20, tab: 0x09, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, return: 0x0d, enter: 0x0d,
  escape: 0x1b, esc: 0x1b, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, printscreen: 0x2c, capslock: 0x14, numlock: 0x90, scrolllock: 0x91, pause: 0x13,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, medianexttrack: 0xb0, mediaprevioustrack: 0xb1,
  mediastop: 0xb2, mediaplaypause: 0xb3,
  plus: 0xbb, "=": 0xbb, "-": 0xbd, ",": 0xbc, ".": 0xbe, "/": 0xbf, "`": 0xc0, ";": 0xba, "'": 0xde,
  "[": 0xdb, "]": 0xdd, "\\": 0xdc,
  numdec: 0x6e, numadd: 0x6b, numsub: 0x6d, nummult: 0x6a, numdiv: 0x6f
};

// Electron-style accelerator ("Control+Shift+Space", "Escape") -> { mods, vk }, or null if it is not one key
// with optional modifiers.
function parseAccelerator(accelerator) {
  const tokens = String(accelerator || "").split("+").map(t => t.trim().toLowerCase());
  let mods = 0, vk = 0;
  for (const t of tokens) {
    if (t in MODIFIER_TOKENS) { mods |= MODIFIER_TOKENS[t]; continue; }
    let code = 0;
    if (/^[a-z0-9]$/.test(t)) code = t.toUpperCase().charCodeAt(0);
    else if (/^f([1-9]|1\d|2[0-4])$/.test(t)) code = 0x6f + Number(t.slice(1));
    else if (/^num[0-9]$/.test(t)) code = 0x60 + Number(t.slice(3));
    else if (t in KEY_TOKENS) code = KEY_TOKENS[t];
    if (!code || vk) return null;
    vk = code;
  }
  return vk ? { mods, vk } : null;
}

// A reader for "is this combination still held": its key and every modifier it has (either Ctrl, either Win...).
// For push-to-talk, which polls it; null for an accelerator that is not one.
function keyHeld(accelerator) {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return null;
  const { mods, vk } = parsed;
  return () => isDown(vk)
    && (!(mods & MOD.CONTROL) || isDown(VK.CONTROL))
    && (!(mods & MOD.ALT) || isDown(VK.MENU))
    && (!(mods & MOD.SHIFT) || isDown(VK.SHIFT))
    && (!(mods & MOD.WIN) || isDown(VK.LWIN) || isDown(VK.RWIN));
}

// Global hotkeys on one of our windows. RegisterHotKey with MOD_NOREPEAT, not globalShortcut: the latter fires on
// every auto-repeat of a held key. The window must live as long as the hotkeys (a hidden one is fine) and this
// registry owns its WM_HOTKEY hook.
function createHotkeys(browserWindow) {
  const hwnd = hwndOf(browserWindow);
  // Each name keeps one RegisterHotKey id for good (applications must stay below 0xC000), however often it is
  // registered again - Escape is, for every recording.
  const nums = new Map(); // name -> id
  const held = new Map(); // id -> onPress, while registered
  const numOf = name => { if (!nums.has(name)) nums.set(name, 0x100 + nums.size); return nums.get(name); };
  let alive = true;

  browserWindow.hookWindowMessage(WM_HOTKEY, wParam => {
    const onPress = held.get(wParam.readUInt32LE(0));
    // Called synchronously: while the hotkey message is being handled our process may take the foreground.
    if (onPress) try { onPress(); } catch (err) { console.error("Hotkey handler failed:", err); }
  });
  browserWindow.once("closed", () => { alive = false; held.clear(); });

  // With onPress: only while that handler still holds the name - another one may have taken it over since.
  function unregister(name, onPress) {
    const num = nums.get(name);
    if (num === undefined || (onPress && held.get(num) !== onPress) || !held.delete(num)) return;
    if (alive) f.UnregisterHotKey(hwnd, num);
  }
  // False when the accelerator is invalid or another application already owns the combination.
  function register(name, accelerator, onPress) {
    unregister(name);
    const parsed = parseAccelerator(accelerator);
    if (!alive || !parsed) return false;
    const num = numOf(name);
    if (!f.RegisterHotKey(hwnd, num, parsed.mods | MOD.NOREPEAT, parsed.vk)) return false;
    held.set(num, onPress);
    return true;
  }
  return {
    register,
    unregister,
    unregisterAll() { for (const name of nums.keys()) unregister(name); }
  };
}

module.exports = {
  foreground, foregroundHwnd, isAlive, focus, className, hwndOf, isTerminalClass, mutexExists,
  waitModifiersUp, sendCtrlV, sendCopy, typeUnicode, clipboardSeq,
  withClipboard, listFormats, readFormat, writeFormat, emptyClipboard, decodeText, encodeText,
  readClipboardText, writeClipboardText, watchClipboard, CF,
  createHotkeys, parseAccelerator, keyHeld, exclusive, waitUntil
};
