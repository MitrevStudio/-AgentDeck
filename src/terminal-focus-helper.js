// Utility process of terminal-focus.js: finds the window - and in Windows Terminal the tab - that shows a console
// process. It lives in a process of its own for two reasons: it attaches to that process's console (AttachConsole),
// which the main process must never do (its own console output would land in the user's terminal), and UI
// Automation calls block for as long as the target window takes to answer.
//
// The console tells most of it: its window is the classic console window itself, or - for a pseudo console - a
// hidden window that Windows Terminal makes owned by the terminal window currently showing it. The tab is the one
// whose title is the console's title; when that is not unique, the console gets a unique title for a moment.
const koffi = require("koffi");

const kernel32 = koffi.load("kernel32.dll");
const user32 = koffi.load("user32.dll");
const ole32 = koffi.load("ole32.dll");
const oleaut32 = koffi.load("oleaut32.dll");

const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32", cntUsage: "uint32", th32ProcessID: "uint32", th32DefaultHeapID: "uintptr", th32ModuleID: "uint32",
  cntThreads: "uint32", th32ParentProcessID: "uint32", pcPriClassBase: "int32", dwFlags: "uint32",
  szExeFile: koffi.array("char16_t", 260, "String")
});
const EnumWindowsProc = koffi.proto("bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)");
const VARIANT = koffi.struct("VARIANT", { vt: "uint16", r1: "uint16", r2: "uint16", r3: "uint16", v1: "int64", v2: "int64" });

const f = {
  FreeConsole: kernel32.func("bool __stdcall FreeConsole()"),
  AttachConsole: kernel32.func("bool __stdcall AttachConsole(uint32_t pid)"),
  GetConsoleWindow: kernel32.func("void * __stdcall GetConsoleWindow()"),
  GetConsoleTitleW: kernel32.func("uint32_t __stdcall GetConsoleTitleW(_Out_ uint8_t *buf, uint32_t chars)"),
  SetConsoleTitleW: kernel32.func("bool __stdcall SetConsoleTitleW(str16 title)"),
  SetConsoleCtrlHandler: kernel32.func("bool __stdcall SetConsoleCtrlHandler(void *handler, bool add)"),
  CreateToolhelp32Snapshot: kernel32.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)"),
  Process32FirstW: kernel32.func("bool __stdcall Process32FirstW(void *snap, _Inout_ PROCESSENTRY32W *entry)"),
  Process32NextW: kernel32.func("bool __stdcall Process32NextW(void *snap, _Inout_ PROCESSENTRY32W *entry)"),
  OpenProcess: kernel32.func("void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
  GetProcessTimes: kernel32.func("bool __stdcall GetProcessTimes(void *proc, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)"),
  CloseHandle: kernel32.func("bool __stdcall CloseHandle(void *h)"),
  EnumWindows: user32.func("bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)"),
  GetWindow: user32.func("void * __stdcall GetWindow(void *hwnd, uint32_t cmd)"),
  GetWindowThreadProcessId: user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)"),
  GetClassNameW: user32.func("int __stdcall GetClassNameW(void *hwnd, _Out_ uint8_t *buf, int chars)"),
  GetWindowTextW: user32.func("int __stdcall GetWindowTextW(void *hwnd, _Out_ uint8_t *buf, int chars)"),
  IsWindowVisible: user32.func("bool __stdcall IsWindowVisible(void *hwnd)"),
  CoInitializeEx: ole32.func("long __stdcall CoInitializeEx(void *reserved, uint32_t model)"),
  CoCreateInstance: ole32.func("long __stdcall CoCreateInstance(const uint8_t *clsid, void *outer, uint32_t ctx, const uint8_t *iid, _Out_ void **out)"),
  SysFreeString: oleaut32.func("void __stdcall SysFreeString(void *s)")
};

const GW_OWNER = 4;
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const WT_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";
const CONSOLE_CLASS = "ConsoleWindowClass";
const PSEUDO_CONSOLE_CLASS = "PseudoConsoleWindow";
const MARKER_WAIT_MS = 400;
const tell = msg => process.parentPort?.postMessage(msg);

// Ctrl+C typed into a console this process is attached to for a moment must not end it.
f.SetConsoleCtrlHandler(null, true);

const utf16 = (buf, chars) => buf.toString("utf16le", 0, chars * 2);
function windowString(fn, hwnd) {
  const buf = Buffer.alloc(1024);
  const n = fn(hwnd, buf, 512);
  return n > 0 ? utf16(buf, n) : "";
}
const className = hwnd => windowString(f.GetClassNameW, hwnd);
const windowTitle = hwnd => windowString(f.GetWindowTextW, hwnd);
function windowPid(hwnd) {
  const pid = [0];
  f.GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

// ---------- console ----------

function withConsole(pid, fn) {
  f.FreeConsole();
  if (!f.AttachConsole(pid)) return null;
  try { return fn(); } finally { f.FreeConsole(); }
}
function consoleTitle() {
  const buf = Buffer.alloc(4096);
  return utf16(buf, f.GetConsoleTitleW(buf, 2048));
}
// The console `pid` is attached to: its window and title. Null when it has none or cannot be attached to (another
// user's or an elevated process).
const consoleOf = pid => withConsole(pid, () => ({ hwnd: f.GetConsoleWindow(), title: consoleTitle() }));

// ---------- processes ----------

function processTable() {
  const snap = f.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  const table = new Map();
  if (!snap || BigInt.asIntN(64, snap) === -1n) return table; // INVALID_HANDLE_VALUE
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    for (let ok = f.Process32FirstW(snap, entry); ok; ok = f.Process32NextW(snap, entry))
      table.set(entry.th32ProcessID, { parent: entry.th32ParentProcessID, exe: entry.szExeFile });
  } finally { f.CloseHandle(snap); }
  return table;
}
function createdAt(pid) {
  const h = f.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!h) return 0n;
  try {
    const c = [0n], x = [0n], k = [0n], u = [0n];
    return f.GetProcessTimes(h, c, x, k, u) ? BigInt(c[0]) : 0n;
  } finally { f.CloseHandle(h); }
}
// pid and its ancestors, nearest first. A parent id can belong to a newer, unrelated process once the real parent
// has exited, so the chain stops at a "parent" younger than its child.
function ancestry(pid) {
  const table = processTable();
  const chain = [];
  let cur = pid, born = createdAt(pid);
  while (table.has(cur) && chain.length < 16) {
    const { parent, exe } = table.get(cur);
    chain.push({ pid: cur, exe });
    if (!parent || chain.some(p => p.pid === parent)) break;
    const parentBorn = createdAt(parent);
    if (born && parentBorn && parentBorn > born) break;
    cur = parent; born = parentBorn;
  }
  return chain;
}

// ---------- windows ----------

// Visible, unowned, titled top-level windows by process, in Z-order (the most recently active first). Console
// windows report their first client as their process; they are found through the console instead.
function appWindows() {
  const byPid = new Map();
  f.EnumWindows((hwnd) => {
    if (!f.IsWindowVisible(hwnd) || f.GetWindow(hwnd, GW_OWNER)) return true;
    const cls = className(hwnd);
    if (cls === PSEUDO_CONSOLE_CLASS || cls === CONSOLE_CLASS) return true;
    const title = windowTitle(hwnd);
    if (!title) return true;
    const pid = windowPid(hwnd);
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push({ hwnd, title });
    return true;
  }, 0);
  return byPid;
}

// The nearest ancestor that has a window of its own - the IDE, a terminal emulator. Among several windows of that
// app the one with the session's folder in its title wins (VS Code: "file - folder - …"). MSYS/Cygwin terminals
// (Git Bash's mintty) are not found: their processes' Windows parents are gone.
function hostWindow(pid, cwd) {
  const windows = appWindows();
  const folder = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase();
  for (const p of ancestry(pid).slice(1)) {
    const list = windows.get(p.pid);
    if (!list) continue;
    const pick = (folder && list.find(w => w.title.toLowerCase().includes(folder))) || list[0];
    return { hwnd: pick.hwnd, host: p.exe };
  }
  return null;
}

// ---------- UI Automation ----------

function guid(s) {
  const h = s.replace(/-/g, "");
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), "hex").copy(b, 8);
  return b;
}
const CLSID_CUIAutomation8 = guid("E22AD333-B25F-460C-83D0-0581107395C9");
const IID_IUIAutomation2 = guid("34723AFF-0C9D-49D0-9896-7AB52DF8CD8A");
const IID_SelectionItemPattern = guid("A8EFA66A-0FDA-421A-9194-38021F3578EA");
const UIA = {
  ControlTypeProperty: 30003, TabItemControlType: 50019, SelectionItemPattern: 10010,
  TreeScope_Descendants: 4, VT_I4: 3, RPC_E_CHANGED_MODE: 0x80010106 | 0
};
// vtable slots (UIAutomationClient.h). IUIAutomation(2): 2 Release, 6 ElementFromHandle, 23 CreatePropertyCondition,
// 59 put_AutoSetFocus, 61 put_ConnectionTimeout, 63 put_TransactionTimeout. IUIAutomationElement: 6 FindAll,
// 14 GetCurrentPatternAs, 23 get_CurrentName. IUIAutomationElementArray: 3 get_Length, 4 GetElement.
// IUIAutomationSelectionItemPattern: 3 Select, 6 get_CurrentIsSelected.
const P = {
  release: koffi.proto("uint32_t __stdcall Release(void *self)"),
  putUint: koffi.proto("long __stdcall PutUint(void *self, uint32_t value)"),
  fromHandle: koffi.proto("long __stdcall ElementFromHandle(void *self, void *hwnd, _Out_ void **out)"),
  propertyCondition: koffi.proto("long __stdcall CreatePropertyCondition(void *self, int property, VARIANT value, _Out_ void **out)"),
  findAll: koffi.proto("long __stdcall FindAll(void *self, int scope, void *condition, _Out_ void **out)"),
  getInt: koffi.proto("long __stdcall GetInt(void *self, _Out_ int *out)"),
  getElement: koffi.proto("long __stdcall GetElement(void *self, int index, _Out_ void **out)"),
  getPtr: koffi.proto("long __stdcall GetPtr(void *self, _Out_ void **out)"),
  patternAs: koffi.proto("long __stdcall GetCurrentPatternAs(void *self, int pattern, const uint8_t *iid, _Out_ void **out)"),
  call: koffi.proto("long __stdcall Call(void *self)")
};
function vcall(obj, slot, proto, ...args) {
  const fn = koffi.decode(koffi.decode(obj, "void *"), slot * 8, "void *");
  return koffi.call(fn, proto, obj, ...args);
}
function ok(hr, what) {
  if (hr < 0) throw new Error(`${what} failed (0x${(hr >>> 0).toString(16)})`);
}
function out(obj, slot, proto, what, ...args) {
  const ref = [null];
  ok(vcall(obj, slot, proto, ...args, ref), what);
  return ref[0];
}
const release = obj => { if (obj) vcall(obj, 2, P.release); };

let automation = null, tabCondition = null;
function uia() {
  if (automation) return automation;
  const hr = f.CoInitializeEx(null, 0); // multithreaded
  if (hr < 0 && hr !== UIA.RPC_E_CHANGED_MODE) ok(hr, "CoInitializeEx");
  const a = [null];
  ok(f.CoCreateInstance(CLSID_CUIAutomation8, null, 1, IID_IUIAutomation2, a), "CoCreateInstance(CUIAutomation8)");
  // Pattern calls would first try to focus the element: for a tab of a background window that waits out the 2 s
  // connection timeout before the tab switches.
  ok(vcall(a[0], 59, P.putUint, 0), "put_AutoSetFocus");
  ok(vcall(a[0], 61, P.putUint, 1000), "put_ConnectionTimeout");
  ok(vcall(a[0], 63, P.putUint, 2000), "put_TransactionTimeout");
  tabCondition = out(a[0], 23, P.propertyCondition, "CreatePropertyCondition", UIA.ControlTypeProperty,
    { vt: UIA.VT_I4, r1: 0, r2: 0, r3: 0, v1: UIA.TabItemControlType, v2: 0 });
  return (automation = a[0]);
}

// The TabItems of a window: [{ el, name }]; the caller releases every el.
function tabsOf(hwnd) {
  const win = out(uia(), 6, P.fromHandle, "ElementFromHandle", hwnd);
  let arr = null;
  try {
    arr = out(win, 6, P.findAll, "FindAll", UIA.TreeScope_Descendants, tabCondition);
    const n = [0];
    ok(vcall(arr, 3, P.getInt, n), "get_Length");
    const tabs = [];
    for (let i = 0; i < n[0]; i++) {
      const el = out(arr, 4, P.getElement, "GetElement", i);
      const bstr = out(el, 23, P.getPtr, "get_CurrentName");
      let name = "";
      if (bstr) try { name = koffi.decode(bstr, "char16_t", -1); } finally { f.SysFreeString(bstr); }
      tabs.push({ el, name });
    }
    return tabs;
  } finally { release(arr); release(win); }
}
function withSelection(el, fn) {
  const pattern = out(el, 14, P.patternAs, "GetCurrentPatternAs", UIA.SelectionItemPattern, IID_SelectionItemPattern);
  if (!pattern) throw new Error("tab cannot be selected");
  try { return fn(pattern); } finally { release(pattern); }
}
const isSelected = el => withSelection(el, p => { const v = [0]; ok(vcall(p, 6, P.getInt, v), "get_CurrentIsSelected"); return Boolean(v[0]); });
const select = el => withSelection(el, p => ok(vcall(p, 3, P.call), "Select"));
function withTabs(hwnd, fn) {
  const tabs = tabsOf(hwnd);
  try { return fn(tabs); } finally { tabs.forEach(t => release(t.el)); }
}

// Claude Code puts a status glyph in front of its title (✳ waiting, ◐ ◓ ◑ ◒ working) and changes it as it goes.
const bare = title => String(title).replace(/^[^\p{L}\p{N}]+/u, "").trim();
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Selects the tab showing console `pid` (titled `title`) in Windows Terminal window `hwnd`.
// -> { found, by: "only"|"title"|"marker" }
function selectTab(hwnd, pid, title) {
  const picked = withTabs(hwnd, tabs => {
    if (tabs.length <= 1) return { found: true, by: "only" }; // one tab, or the tab row is hidden
    const same = tabs.filter(t => bare(t.name) === bare(title));
    if (same.length !== 1) return null;
    if (!isSelected(same[0].el)) select(same[0].el);
    return { found: true, by: "title" };
  });
  if (picked) return picked;
  // Several tabs look alike (two new sessions are both "Claude Code"), or none does: name this one uniquely for a
  // moment. Its program would overwrite the name on its next title change, which Claude Code does rarely. Main hears
  // of the marker first, so that it never kills this process while the console wears it (or has the next one put the
  // title back).
  const marker = `AgentDeck ${process.pid}.${Date.now().toString(36)}`;
  tell({ type: "marker", marker: { pid, title, marker } });
  if (!withConsole(pid, () => f.SetConsoleTitleW(marker))) { tell({ type: "marker", marker: null }); return { found: false }; }
  try {
    const end = Date.now() + MARKER_WAIT_MS;
    do {
      const found = withTabs(hwnd, tabs => {
        const tab = tabs.find(t => t.name === marker);
        if (tab && !isSelected(tab.el)) select(tab.el);
        return Boolean(tab);
      });
      if (found) return { found: true, by: "marker" };
      sleepSync(20);
    } while (Date.now() < end);
    return { found: false };
  } finally {
    restoreTitle({ pid, title, marker });
    tell({ type: "marker", marker: null });
  }
}
// The console's own title back - unless its program has put up a title of its own meanwhile.
function restoreTitle({ pid, title, marker }) {
  return Boolean(withConsole(pid, () => consoleTitle() === marker && f.SetConsoleTitleW(title)));
}

// ---------- requests ----------

// Where console process `pid` is shown. -> { kind: "tab"|"console"|"host"|"none", hwnd, title (tab), host (exe) }
function locate(pid, cwd) {
  const con = consoleOf(pid);
  if (con?.hwnd) {
    const cls = className(con.hwnd);
    if (cls === CONSOLE_CLASS && f.IsWindowVisible(con.hwnd)) return { kind: "console", hwnd: con.hwnd };
    const owner = cls === PSEUDO_CONSOLE_CLASS ? f.GetWindow(con.hwnd, GW_OWNER) : null;
    // A hidden Windows Terminal window (minimised to the tray, a dismissed quake window) is shown again.
    if (owner && className(owner) === WT_CLASS) return { kind: "tab", hwnd: owner, title: con.title };
    if (owner && f.IsWindowVisible(owner)) return { kind: "host", hwnd: owner, host: processTable().get(windowPid(owner))?.exe || "" };
  }
  const host = hostWindow(pid, cwd);
  return host ? { kind: "host", ...host } : { kind: "none" };
}

const handlers = {
  locate: ({ pid, cwd }) => locate(pid, cwd),
  selectTab: ({ hwnd, pid, title }) => selectTab(BigInt(hwnd), pid, title),
  restoreTitle
};
// BigInt window handles travel as strings.
const wire = v => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

// Requests are answered one after another; "started" lets main time each one from when it is taken up.
if (process.parentPort) {
  process.parentPort.on("message", ({ data }) => {
    const { id, op, args } = data;
    tell({ type: "started", id });
    let reply;
    try {
      if (!Object.hasOwn(handlers, op)) throw new Error(`unknown request ${op}`);
      reply = { type: "reply", id, result: wire(handlers[op](args)) };
    } catch (e) { reply = { type: "reply", id, error: e.message }; }
    tell(reply);
  });
  tell({ type: "ready" });
} else {
  module.exports = { locate, selectTab, restoreTitle, consoleOf, ancestry, tabsOf, release, isSelected, select, bare }; // tests
}
