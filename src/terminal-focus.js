// "Show terminal": brings the terminal that a running session lives in to the front - in Windows Terminal the very
// tab, elsewhere (VS Code, Git Bash, a classic console) the window. Finding it is up to terminal-focus-helper.js in
// a utility process; bringing it to the front is done here, because Windows only lets the process the user has
// just clicked (or pressed a hotkey of) take the foreground.
//
// focusSession() -> { ok, how: "tab"|"window"|"none", reason, app?, ms }
//   how "tab":                   the session's Windows Terminal tab is selected and its window in front
//   how "window", reason "":     the session's own console window (classic console) is in front
//   how "window", reason:        "tabUnknown" - its Windows Terminal window, but the tab could not be told apart
//                                "host" - the app its terminal is part of (VS Code, Git Bash…), named by `app`
//   how "none", reason:          "notRunning" | "unsupported" (agent without a live registry) | "notFound"
//   ok false, reason "notFront": found, but Windows kept it from coming to the front (its taskbar button flashes)
const path = require("node:path");
const { app, utilityProcess } = require("electron");
const { liveSessions } = require("./live");

const LOCATE_TIMEOUT_MS = 1500;
const SELECT_TIMEOUT_MS = 2500;   // UI Automation; a hung terminal is given up on, its window is still raised
const START_TIMEOUT_MS = 5000;    // loading the helper (koffi, the Win32 bindings) before its first request
const RESTORE_TIMEOUT_MS = 1500;
const MARKER_GRACE_MS = 10_000;   // a helper that renamed a console is given this long to put the title back
const IDLE_EXIT_MS = 10 * 60 * 1000;
const FRONT_TIMEOUT_MS = 300;

// ---------- helper process ----------
// One request at a time (the helper is synchronous anyway), each timed from the moment the helper takes it up, so a
// second click never times out behind the first. A helper that gets stuck is replaced - but not while it has given a
// console its temporary marker title: it is left to put the title back first, and one that dies with the marker set
// has the next helper put it back.
let helper = null, idleTimer = null, nextId = 0, queue = Promise.resolve(), quitting = false;
app.on("will-quit", () => { quitting = true; });

function kill(h) {
  if (helper === h) { helper = null; clearTimeout(idleTimer); }
  clearTimeout(h.graceTimer);
  h.proc.kill();
}
// Given up on: no new request goes to it; it goes once the console's title is its own again.
function retire(h) {
  if (helper === h) helper = null;
  if (!h.marker) return kill(h);
  h.retired = true;
  h.graceTimer ??= setTimeout(() => kill(h), MARKER_GRACE_MS);
}
function startHelper() {
  if (helper) return helper;
  // Not "inherit": the helper attaches to other consoles, and nothing of it may ever be written into one.
  const proc = utilityProcess.fork(path.join(__dirname, "terminal-focus-helper.js"), [], {
    serviceName: "AgentDeck terminal focus", stdio: ["ignore", "ignore", "pipe"]
  });
  const h = helper = { proc, current: null, marker: null, retired: false, graceTimer: null };
  let started;
  h.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("the helper did not start")); retire(h); }, START_TIMEOUT_MS);
    started = err => { clearTimeout(timer); err ? reject(err) : resolve(); };
  });
  h.ready.catch(() => {});
  proc.stderr?.on("data", d => console.error("[terminal focus]", String(d).trimEnd()));
  proc.on("message", msg => {
    if (msg?.type === "ready") return started();
    if (msg?.type === "marker") { h.marker = msg.marker || null; if (!h.marker && h.retired) kill(h); return; }
    const p = h.current;
    if (!p || p.id !== msg?.id) return;
    if (msg.type === "started") return p.arm();
    h.current = null;
    p.settle(msg);
  });
  proc.on("exit", () => {
    if (helper === h) helper = null;
    clearTimeout(h.graceTimer);
    started(new Error("the helper exited"));
    h.current?.settle({ error: "the helper exited" });
    h.current = null;
    if (h.marker && !quitting) ask("restoreTitle", h.marker, RESTORE_TIMEOUT_MS).catch(e => console.error("Restoring a console title failed:", e.message));
  });
  return h;
}
function ask(op, args, timeoutMs) {
  const run = queue.then(() => askNow(op, args, timeoutMs));
  queue = run.catch(() => {});
  return run;
}
async function askNow(op, args, timeoutMs) {
  const h = startHelper();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (helper === h) retire(h); }, IDLE_EXIT_MS);
  await h.ready;
  return new Promise((resolve, reject) => {
    let timer = null;
    const p = h.current = {
      id: ++nextId,
      arm: () => { timer ??= setTimeout(() => { if (h.current !== p) return; h.current = null; reject(new Error(`${op} timed out`)); retire(h); }, timeoutMs); },
      settle: ({ result, error }) => { clearTimeout(timer); error ? reject(new Error(error)) : resolve(result); }
    };
    h.proc.postMessage({ id: p.id, op, args });
    setTimeout(p.arm, START_TIMEOUT_MS); // should "started" never come, the request is timed all the same
  });
}

// ---------- foreground ----------
let u = null;
function user32() {
  if (u) return u;
  const koffi = require("koffi");
  const lib = koffi.load("user32.dll"), k32 = koffi.load("kernel32.dll");
  return (u = {
    IsWindow: lib.func("bool __stdcall IsWindow(void *hwnd)"),
    IsIconic: lib.func("bool __stdcall IsIconic(void *hwnd)"),
    IsWindowVisible: lib.func("bool __stdcall IsWindowVisible(void *hwnd)"),
    ShowWindow: lib.func("bool __stdcall ShowWindow(void *hwnd, int cmd)"),
    SetForegroundWindow: lib.func("bool __stdcall SetForegroundWindow(void *hwnd)"),
    GetForegroundWindow: lib.func("void * __stdcall GetForegroundWindow()"),
    BringWindowToTop: lib.func("bool __stdcall BringWindowToTop(void *hwnd)"),
    GetWindowThreadProcessId: lib.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, void *pid)"),
    AttachThreadInput: lib.func("bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)"),
    GetCurrentThreadId: k32.func("uint32_t __stdcall GetCurrentThreadId()")
  });
}
const SW_SHOW = 5, SW_RESTORE = 9;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, ms) {
  for (const end = Date.now() + ms; ; await sleep(20)) {
    if (cond()) return true;
    if (Date.now() >= end) return false;
  }
}
// SetForegroundWindow's return value is not the verdict (it can claim success and only flash the taskbar button),
// GetForegroundWindow is. When the plain call is refused, sharing input state with the thread in front for a
// moment lets it through.
async function bringToFront(hwnd) {
  const w = user32();
  if (!w.IsWindow(hwnd)) return false;
  if (w.IsIconic(hwnd)) w.ShowWindow(hwnd, SW_RESTORE);
  else if (!w.IsWindowVisible(hwnd)) w.ShowWindow(hwnd, SW_SHOW);
  const inFront = () => w.GetForegroundWindow() === hwnd;
  w.SetForegroundWindow(hwnd);
  if (await until(inFront, FRONT_TIMEOUT_MS / 2)) return true;
  const fg = w.GetForegroundWindow();
  const me = w.GetCurrentThreadId(), them = fg ? w.GetWindowThreadProcessId(fg, null) : 0;
  const attached = Boolean(them) && them !== me && w.AttachThreadInput(me, them, true);
  try { w.BringWindowToTop(hwnd); w.SetForegroundWindow(hwnd); } finally { if (attached) w.AttachThreadInput(me, them, false); }
  return until(inFront, FRONT_TIMEOUT_MS / 2);
}

// ---------- API ----------
const APP_NAMES = { "code.exe": "VS Code", "code - insiders.exe": "VS Code", "cursor.exe": "Cursor", "windsurf.exe": "Windsurf",
  "mintty.exe": "Git Bash", "windowsterminal.exe": "Windows Terminal" };
const appName = exe => APP_NAMES[String(exe).toLowerCase()] || String(exe).replace(/\.exe$/i, "");

// { agent, id, pid?, cwd? }: pid and cwd come from the live registry when not given (only Claude Code keeps one;
// other agents need the pid). Asked again for the same session while it is under way (a double click), the answer
// is the same.
const inFlight = new Map();
function focusSession(opts = {}) {
  const key = `${opts.agent}:${opts.id}`;
  if (!inFlight.has(key)) inFlight.set(key, focusNow(opts).finally(() => inFlight.delete(key)));
  return inFlight.get(key);
}
async function focusNow({ agent, id, pid, cwd }) {
  const t0 = Date.now();
  const done = (how, reason = "", extra = {}) => ({ ok: how !== "none", how, reason, ...extra, ms: Date.now() - t0 });
  if (process.platform !== "win32") return done("none", "unsupported");
  if (!Number.isInteger(pid)) {
    if (agent !== "Claude") return done("none", "unsupported");
    const l = (await liveSessions()).find(x => x.agent === agent && x.id === id);
    if (!l) return done("none", "notRunning");
    pid = l.pid; cwd ??= l.cwd;
  }
  let where;
  try { where = await ask("locate", { pid, cwd: cwd || "" }, LOCATE_TIMEOUT_MS); } catch (e) {
    console.error("Locating the terminal failed:", e.message);
    return done("none", "notFound");
  }
  if (where.kind === "none") return done("none", "notFound");
  let how = "window", reason = where.kind === "host" ? "host" : "";
  if (where.kind === "tab") {
    const tab = await ask("selectTab", { hwnd: where.hwnd, pid, title: where.title }, SELECT_TIMEOUT_MS)
      .catch(e => { console.error("Selecting the tab failed:", e.message); return { found: false }; });
    if (tab.found) how = "tab"; else reason = "tabUnknown";
  }
  const extra = where.host ? { app: appName(where.host) } : {};
  if (!(await bringToFront(BigInt(where.hwnd)))) return { ...done(how, "notFront", extra), ok: false };
  return done(how, reason, extra);
}

module.exports = { focusSession };
