// win32.js's interface on Linux under Hyprland (Wayland): window targets and focus through Hyprland's IPC, synthetic
// keys through wtype, the clipboard through wl-clipboard, and global hotkeys as Hyprland bindings made at run time.
//
// Wayland gives an application none of these itself. What differs from Windows:
// - A target's `hwnd` is the Hyprland window address as a BigInt (what callers compare with foregroundHwnd()).
// - A hotkey is a pair of bindings: the press, and a release (transparent, ignoring modifiers, non-consuming, as
//   Omarchy's bind_hold) that only counts after its own press. Both send an event Hyprland reports on its event
//   socket - no process per key - so whether a hotkey is still held (push-to-talk) is known without polling keys.
// - Whether modifiers are still down is asked of Hyprland (hl.is_key_down), so it is async; anyModifierDown()
//   answers what the last waitModifiersUp() saw.
// - The selection is Wayland's primary selection (selection.js reads it directly): nothing is copied, and the
//   clipboard is never borrowed for it. The raw-format clipboard functions exist only for the interface.
const fs = require("node:fs");
const { spawn, execFile } = require("node:child_process");
const hypr = require("../shared/hyprland");
const { sleep } = require("../shared/util");

const FOCUS_POLL_MS = 40;
const KEY_POLL_MS = 20;
const CLIPBOARD_TIMEOUT_MS = 3000;

async function waitUntil(cond, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return Boolean(await cond());
}

// Delivery and selection capture both type into the foreground window and borrow the clipboard; they must never
// interleave.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ---------- windows ----------

const toAddress = h => (h == null || h === 0 || h === 0n ? null : `0x${BigInt(h).toString(16)}`);
const fromAddress = a => { try { return a ? BigInt(a) : null; } catch { return null; } };
const hwndOf = () => 0n;

// Start time of a process (/proc, clock ticks since boot): tells a recycled pid from the window's own process.
function processStart(pid) {
  if (!pid) return 0;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]) || 0;
  } catch { return 0; }
}

// Hyprland is asked asynchronously: a synchronous request from the main thread can stall for seconds while Hyprland
// is busy with one of our own windows (it did, at startup). The hotkeys read the window in front before they call
// their handler (frontCache), so foreground() - synchronous, as on Windows - has the answer at hand.
let frontCache = null; // { win, at }
const FRONT_FRESH_MS = 300;
async function refreshFront() {
  const win = await hypr.activeWindowAsync().catch(() => null);
  frontCache = { win, at: Date.now() };
  return win;
}
function cachedFront() {
  if (frontCache && Date.now() - frontCache.at < FRONT_FRESH_MS) return frontCache.win;
  try { return hypr.json(hypr.requestSync(["-j", "activewindow"], 500)); } catch { return null; }
}
function foreground() {
  const w = cachedFront();
  if (!w || !w.address) return { hwnd: null, pid: 0, className: "", procStart: 0 };
  return { hwnd: fromAddress(w.address), pid: w.pid || 0, className: w.class || "", procStart: processStart(w.pid) };
}
// Async here (callers await it; Windows answers at once).
const foregroundHwnd = async () => fromAddress((await refreshFront())?.address);
function className(hwnd) {
  const w = cachedFront();
  return w && fromAddress(w.address) === (hwnd == null ? null : BigInt(hwnd)) ? w.class || "" : "";
}

// The window must still be there, still belong to the same process. Async here.
async function isAlive(target) {
  const address = toAddress(target && target.hwnd);
  if (!address) return false;
  const list = await hypr.clients().catch(() => null);
  const w = list?.find(c => c.address === address);
  if (!w || w.pid !== target.pid) return false;
  return !target.procStart || processStart(target.pid) === target.procStart;
}

async function focus(target, timeoutMs = 400) {
  if (!(await isAlive(target))) return false;
  const hwnd = BigInt(target.hwnd);
  if ((await foregroundHwnd()) === hwnd) return true;
  await hypr.focusWindow(toAddress(hwnd)).catch(() => {});
  return waitUntil(async () => (await foregroundHwnd()) === hwnd, timeoutMs, FOCUS_POLL_MS);
}

const mutexExists = () => false; // VoiceTray is Windows only

// Terminals paste with Ctrl+Shift+V and copy with Ctrl+Shift+C; Ctrl+C there is "interrupt".
const TERMINAL_CLASSES = new Set([
  "alacritty", "kitty", "com.mitchellh.ghostty", "ghostty", "foot", "footclient", "org.wezfurlong.wezterm",
  "org.gnome.console", "org.gnome.terminal", "gnome-terminal-server", "org.kde.konsole", "konsole", "xterm", "urxvt",
  "st-256color", "terminator", "tilix", "com.raggesilver.blackbox", "io.elementary.terminal", "xfce4-terminal"
]);
const isTerminalClass = cls => TERMINAL_CLASSES.has(String(cls || "").toLowerCase());

// ---------- keyboard ----------

const MODIFIER_KEYS = ["Control_L", "Control_R", "Shift_L", "Shift_R", "Alt_L", "Alt_R", "Super_L", "Super_R", "ISO_Level3_Shift"];
let modifiersDown = false;
async function keysDown(names) {
  const expr = names.map(n => `hl.is_key_down(${hypr.luaString(n)})`).join(" or ");
  const r = await hypr.query(`(${expr})`).catch(() => null);
  return r === null ? null : r === "true";
}
const anyModifierDown = () => modifiersDown;

// The hotkeys fire on key-down, so the chord is usually still held. With alsoSpace a held Space counts too.
async function waitModifiersUp(timeoutMs = 500, { alsoSpace = false } = {}) {
  const names = alsoSpace ? [...MODIFIER_KEYS, "space"] : MODIFIER_KEYS;
  const up = await waitUntil(async () => {
    const down = await keysDown(names);
    modifiersDown = down === true;
    return down === false;
  }, timeoutMs, KEY_POLL_MS);
  return up;
}

function wtype(args, input) {
  return new Promise(resolve => {
    const child = execFile("wtype", args, { timeout: 10000 }, err => resolve(!err));
    if (input != null) child.stdin.end(input);
  });
}
// The window in front decides: a terminal pastes with Ctrl+Shift+V.
const frontIsTerminal = async () => isTerminalClass((await refreshFront())?.class);
const sendCtrlV = async () => wtype((await frontIsTerminal()) ? ["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"] : ["-M", "ctrl", "-k", "v", "-m", "ctrl"]);
const sendCopy = ({ terminal = false } = {}) => wtype(terminal ? ["-M", "ctrl", "-M", "shift", "-k", "c", "-m", "shift", "-m", "ctrl"] : ["-M", "ctrl", "-k", "c", "-m", "ctrl"]);
// From stdin, so nothing in the text is taken for an option.
const typeUnicode = text => wtype(["-"], String(text));

// ---------- clipboard ----------

let seq = 0;
const clipboardSeq = () => seq;

function wlPaste(args, maxChars) {
  return new Promise(resolve => {
    execFile("wl-paste", ["--no-newline", ...args], { encoding: "utf8", timeout: CLIPBOARD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const text = Number.isFinite(maxChars) ? stdout.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, "") : stdout;
        resolve(text);
      });
  });
}
const readClipboardText = (maxChars = Infinity) => wlPaste(["--type", "text"], maxChars);
// What is selected right now, in whichever application: Wayland's primary selection.
const readPrimaryText = (maxChars = Infinity) => wlPaste(["--primary", "--type", "text"], maxChars);

function writeClipboardText(text) {
  return new Promise(resolve => {
    // wl-copy keeps serving the text from a process of its own; the one started here exits once that runs.
    const child = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, CLIPBOARD_TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("exit", code => { clearTimeout(timer); if (code === 0) seq++; resolve(code === 0); });
    child.stdin.end(String(text));
  });
}

// When the clipboard last changed: {at, seq}, or null before the first change since the start. wl-paste --watch
// runs a command on every change; each line it prints is one.
function watchClipboard() {
  let last = null, child = null, stopped = false, first = true;
  const start = () => {
    if (stopped) return;
    child = spawn("wl-paste", ["--watch", "echo", "change"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => {
      for (const _ of d.split("\n").filter(Boolean)) {
        // The first line is the clipboard as it already was when watching started.
        if (first) { first = false; continue; }
        seq++;
        last = { at: Date.now(), seq };
      }
    });
    child.on("error", () => {});
    child.on("exit", () => { child = null; if (!stopped) setTimeout(start, 2000).unref(); });
  };
  start();
  return { last: () => last, dispose() { stopped = true; child?.kill(); } };
}

// Raw formats are a Windows notion; the selection is read from the primary selection instead (selection.js).
const CF = { UNICODETEXT: 13, DIB: 8, DIBV5: 17, HDROP: 15 };
const withClipboard = async () => ({ ok: false });
const listFormats = () => [];
const readFormat = () => null;
const writeFormat = () => false;
const emptyClipboard = () => false;
const decodeText = buf => (buf ? buf.toString("utf8") : null);
const encodeText = text => Buffer.from(String(text), "utf8");

// ---------- hotkeys ----------

// Electron accelerator tokens -> Hyprland's modifier names and xkb key names.
const MODS = { control: "CTRL", ctrl: "CTRL", commandorcontrol: "CTRL", cmdorctrl: "CTRL", alt: "ALT", option: "ALT",
  altgr: "CTRL + ALT", shift: "SHIFT", super: "SUPER", meta: "SUPER", command: "SUPER", cmd: "SUPER" };
const MOD_BITS = { SHIFT: 1, CTRL: 4, ALT: 8, SUPER: 64 };
const KEYS = {
  space: "space", tab: "Tab", backspace: "BackSpace", delete: "Delete", del: "Delete", insert: "Insert", ins: "Insert",
  return: "Return", enter: "Return", escape: "Escape", esc: "Escape", up: "Up", down: "Down", left: "Left", right: "Right",
  home: "Home", end: "End", pageup: "Prior", pagedown: "Next", printscreen: "Print", capslock: "Caps_Lock",
  numlock: "Num_Lock", scrolllock: "Scroll_Lock", pause: "Pause",
  volumeup: "XF86AudioRaiseVolume", volumedown: "XF86AudioLowerVolume", volumemute: "XF86AudioMute",
  medianexttrack: "XF86AudioNext", mediaprevioustrack: "XF86AudioPrev", mediastop: "XF86AudioStop", mediaplaypause: "XF86AudioPlay",
  plus: "equal", "=": "equal", "-": "minus", ",": "comma", ".": "period", "/": "slash", "`": "grave", ";": "semicolon",
  "'": "apostrophe", "[": "bracketleft", "]": "bracketright", "\\": "backslash",
  numdec: "KP_Decimal", numadd: "KP_Add", numsub: "KP_Subtract", nummult: "KP_Multiply", numdiv: "KP_Divide"
};

// Electron-style accelerator -> { mods: ["CTRL", ...], key, keys: "CTRL + space", modmask }, or null if it is not one
// key with optional modifiers.
function parseAccelerator(accelerator) {
  const tokens = String(accelerator || "").split("+").map(t => t.trim().toLowerCase());
  const mods = new Set();
  let key = null;
  for (const t of tokens) {
    if (t in MODS) { MODS[t].split(" + ").forEach(m => mods.add(m)); continue; }
    let k = null;
    if (/^[a-z0-9]$/.test(t)) k = t;
    else if (/^f([1-9]|1\d|2[0-4])$/.test(t)) k = t.toUpperCase();
    else if (/^num[0-9]$/.test(t)) k = `KP_${t.slice(3)}`;
    else if (t in KEYS) k = KEYS[t];
    if (!k || key) return null;
    key = k;
  }
  if (!key) return null;
  const list = ["SUPER", "CTRL", "ALT", "SHIFT"].filter(m => mods.has(m));
  return { mods: list, key, keys: [...list, key].join(" + "), modmask: list.reduce((a, m) => a | MOD_BITS[m], 0) };
}

const EVENT_PREFIX = `agentdeck${process.pid}:`;
const bindDescription = name => `AgentDeck ${name}`;

// Hyprland's bindings as last read (refreshed asynchronously: at the start, and on every config reload), for
// "is this combination taken" - register() answers synchronously, as RegisterHotKey does.
let bindsCache = [];
async function refreshBinds() {
  const list = hypr.json(await hypr.request("j/binds", 5000).catch(() => "null"));
  if (Array.isArray(list)) bindsCache = list;
  return bindsCache;
}
const ours = b => String(b.description || "").startsWith("AgentDeck ");
// Taken: a binding of Hyprland's (or another application's) has the combination. Non-consuming ones count too:
// Omarchy's Ctrl+Space passes the key on because it is the terminal multiplexer's prefix, which ours would swallow.
const takenBy = parsed => bindsCache.some(b => !b.release && !ours(b) && !b.submap
  && b.modmask === parsed.modmask && String(b.key).toLowerCase() === parsed.key.toLowerCase());

// Binding changes go to Hyprland one after another, never blocking the main thread.
let ops = Promise.resolve();
const queueLua = code => (ops = ops.then(() => hypr.lua(code)).catch(e => console.error("Hyprland hotkeys:", e.message)));

const MOD_ORDER = ["SUPER", "CTRL", "ALT", "SHIFT"];
const keysOf = b => [...MOD_ORDER.filter(m => b.modmask & MOD_BITS[m]), b.key].join(" + ");
// hl.unbind drops every binding of a combination, not only ours: one that also has a binding of someone else's
// (added by a config reload since) is left bound - its events are ignored once nothing of ours is registered.
const sameCombo = (b, keys) => keysOf(b).toLowerCase() === keys.toLowerCase();
const foreignOn = keys => bindsCache.some(b => !ours(b) && !b.submap && sameCombo(b, keys));
const unbindLua = keys => `hl.unbind(${hypr.luaString(keys)})`;

// Held state per accelerator, for keyHeld(): set by the press event, cleared by the release.
const heldKeys = new Map(); // keys string -> boolean

function createHotkeys() {
  const registered = new Map(); // name -> { parsed, onPress }
  let alive = true;

  const bindLua = (name, parsed) => {
    const keys = hypr.luaString(parsed.keys), desc = hypr.luaString(bindDescription(name));
    const down = hypr.luaString(`${EVENT_PREFIX}${name}:down`), up = hypr.luaString(`${EVENT_PREFIX}${name}:up`);
    return `hl.bind(${keys}, hl.dsp.event(${down}), { description = ${desc} })
hl.bind(${keys}, hl.dsp.event(${up}), { description = ${desc}, release = true, transparent = true, ignore_mods = true, non_consuming = true })`;
  };

  const stopEvents = hypr.onEvent((event, data) => {
    if (event !== "custom" || !data.startsWith(EVENT_PREFIX)) return;
    const [name, edge] = data.slice(EVENT_PREFIX.length).split(":");
    const r = registered.get(name);
    if (!r) return;
    // Bindings without `repeating` fire once per press, so a press is always a new one.
    heldKeys.set(r.parsed.keys, edge !== "up");
    if (edge === "up") return;
    // The window in front is read before the handler runs, which takes it as its target (foreground()).
    refreshFront().finally(() => {
      if (registered.get(name) !== r) return;
      try { r.onPress(); } catch (err) { console.error("Hotkey handler failed:", err); }
    });
  });
  // A config reload drops what was bound at run time.
  const stopReload = hypr.onReload(() => {
    refreshBinds();
    if (!alive || !registered.size) return;
    queueLua([...registered].map(([name, r]) => bindLua(name, r.parsed)).join("\n"));
  });

  function unregister(name, onPress) {
    const r = registered.get(name);
    if (!r || (onPress && r.onPress !== onPress)) return;
    registered.delete(name);
    heldKeys.delete(r.parsed.keys);
    // Another name may hold the same combination (Escape for two purposes never does, but be safe).
    if ([...registered.values()].some(x => x.parsed.keys === r.parsed.keys)) return;
    if (foreignOn(r.parsed.keys)) return;
    queueLua(unbindLua(r.parsed.keys));
  }
  // False when the accelerator is invalid or Hyprland already binds the combination to something else.
  function register(name, accelerator, onPress) {
    unregister(name);
    const parsed = parseAccelerator(accelerator);
    if (!alive || !parsed || takenBy(parsed)) return false;
    queueLua(bindLua(name, parsed));
    registered.set(name, { parsed, onPress });
    if (!heldKeys.has(parsed.keys)) heldKeys.set(parsed.keys, false);
    return true;
  }
  function unregisterAll() { for (const name of [...registered.keys()]) unregister(name); }
  return {
    register, unregister,
    unregisterAll() { unregisterAll(); },
    // Reads Hyprland's bindings, and drops those an earlier AgentDeck left behind (it crashed, or was killed): they
    // would make the combinations look taken. Awaited before the first register().
    async ready() {
      const stale = new Set((await refreshBinds()).filter(b => ours(b) && !b.release).map(keysOf));
      for (const k of stale) if (foreignOn(k)) stale.delete(k);
      if (stale.size) await queueLua([...stale].map(unbindLua).join("\n"));
      bindsCache = bindsCache.filter(b => !ours(b));
    },
    // Resolves once Hyprland has every change asked for so far (at quit: nothing left bound).
    async dispose() { unregisterAll(); alive = false; stopEvents(); stopReload(); await ops; }
  };
}

// A reader for "is this combination still held", from the bindings' press and release events. Null for a
// combination no hotkey of ours binds (nothing would report its release).
function keyHeld(accelerator) {
  const parsed = parseAccelerator(accelerator);
  if (!parsed || !heldKeys.has(parsed.keys)) return null;
  return () => heldKeys.get(parsed.keys) === true;
}

const supported = () => hypr.available();

module.exports = {
  foreground, foregroundHwnd, isAlive, focus, className, hwndOf, isTerminalClass, mutexExists,
  waitModifiersUp, anyModifierDown, sendCtrlV, sendCopy, typeUnicode, clipboardSeq,
  withClipboard, listFormats, readFormat, writeFormat, emptyClipboard, decodeText, encodeText,
  readClipboardText, writeClipboardText, watchClipboard, CF, readPrimaryText,
  createHotkeys, parseAccelerator, keyHeld, exclusive, waitUntil, supported
};
