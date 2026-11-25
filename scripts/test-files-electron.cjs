// The "Files" dialog (docs/FILES.md 6) in the REAL app, end to end on one machine: the true src/main.js with its
// preload and its page, started as `electron -r <this file> <repo>` on a throwaway profile (AGENTDECK_USER_DATA), a
// throwaway home and a throwaway Downloads folder - nothing of the user's is listed, written or deleted.
//
// This file has two roles, as scripts/test-ports-electron.cjs (whose ways it follows):
//   * the driver (plain Node, `node scripts/test-files-electron.cjs`): the mesh around the app, in this process - H (a
//     desktop that serves its files and a real terminal, mesh/serve.js over host/terminals.js and host/files.js, with no
//     bin: its deletes are for good) and OLD (a computer whose host.info has no `files: 1`) - and the steps below;
//   * the hook (inside Electron's main process, before main.js is loaded: FILES_E2E_HOOK): Downloads is set to a temporary
//     folder; shell.openExternal and shell.openPath are recorded (no browser, no PDF program opens); shell.trashItem is
//     recorded and refuses any path outside this test's folder (inside it, the file is removed, as the bin would take
//     it); globalShortcut, Tray balloons and voice are off. It answers the driver: a script in the manager window, real
//     mouse and key events (webContents.sendInputEvent), screenshots, app.quit.
//   Nothing under src/ is changed for it.
//
// The app's node is paired with H and OLD directly over 127.0.0.1 before it starts (as Settings -> Computers does).
//
// Checked, on the real page with real clicks and keys: a remote pane has the Files button and a local one not; the
// panes say which computer each is ("This computer" with the app's name, "Remote" with H's) and start in Downloads and
// in the terminal's folder; a multi-megabyte file downloaded with a double click, byte for byte, into a name that is
// taken ("name (2)", the file that had the name untouched); the queue row says "H → this computer"; a folder tree (an
// empty file, an empty folder, a non-ASCII name, more than one page of entries) downloaded with the arrow and compared;
// a file uploaded with the other arrow onto a taken name; a drag from one pane onto the other (DragEvents dispatched
// in the page: the system's drag and drop is not driven); Stop in the middle of a file leaves no unfinished file; rename
// on H, and a rename onto a taken name offering "name (2)"; copy on H (a file and a folder in place); delete on H (the
// confirmation names H and says "for good") and here (names this computer and says "Recycle Bin"; the bin is the
// hook's); a .md preview and a PDF opened from a temporary copy; OLD says it needs an update; H going away fails its
// transfer under way cleanly and its dialog says it is not connected; nothing is left behind. "Send to phone" (docs/FILES.md
// 3.6): on a file of this computer's pane only, disabled with its reason while no phone is linked; then a real phone
// provider (mobile/src/provider-relay.js over `ws`, paired directly with the app's node before it starts) comes
// online: the item names it, an offer reaches it, the queue row says "this computer → the phone" and follows its
// answers - declined, and accepted and pulled through the app (mobile/src/files.js takeOffer into a fake plugin over a
// temporary folder), byte for byte, to done. The order and the search of a pane: the Size column's head clicked twice
// sorts H's folder largest first and then smallest first (folders first both ways), the order is remembered, and a name
// typed into H's pane's search lists only the matches, with their count, until Escape clears it.
//
// Screenshots go to FILES_E2E_SHOTS (default: <repo>/.tmp/files-e2e). FILES_E2E_VERBOSE=1 prints the app's output.
// Windows is where this was run. The app's window comes up and takes the focus for about a minute.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, ".."), SRC = path.join(ROOT, "src");

// ====================================================== the hook ======================================================
if (process.versions.electron && process.env.FILES_E2E_HOOK) {
  const { app, shell, globalShortcut, Tray, BrowserWindow } = require("electron");
  const testRoot = path.resolve(process.env.FILES_E2E_ROOT);
  const inRoot = p => path.resolve(p).toLowerCase().startsWith(testRoot.toLowerCase() + path.sep);
  // Before main.js asks for it: the left pane starts here, never in the user's own Downloads.
  app.setPath("downloads", process.env.FILES_E2E_DOWNLOADS);
  const opened = [], paths = [], trashed = [];
  shell.openExternal = async url => { opened.push(String(url)); };
  shell.openPath = async p => { paths.push({ path: String(p), bytes: fs.existsSync(p) ? fs.readFileSync(p).toString("base64") : null }); return ""; };
  shell.trashItem = async p => {
    trashed.push(String(p));
    if (!inRoot(p)) throw new Error(`refused: ${p} is outside the test's folder`);
    fs.rmSync(p, { recursive: true, force: true });
  };
  globalShortcut.register = () => false;
  Tray.prototype.displayBalloon = function () {};
  const Module = require("node:module");
  const native = require.resolve(path.join(SRC, "voice", "native.js"));
  const fake = new Module(native);
  Object.assign(fake, { filename: native, loaded: true, exports: { supported: () => false, platform: null } });
  require.cache[native] = fake;

  const isManager = w => !w.isDestroyed() && /\/src\/index\.html$/.test(w.webContents.getURL().split(/[?#]/)[0]);
  const manager = () => {
    const w = BrowserWindow.getAllWindows().find(isManager);
    if (!w) throw new Error("the manager window is not there");
    return w;
  };
  const within = (promise, ms, what) => Promise.race([promise, new Promise((_r, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms: ${what}`)), ms))]);
  const commands = {
    eval: ({ code }) => within(manager().webContents.executeJavaScript(code, true), 20000, code.slice(-200)),
    mouse: ({ events }) => { for (const e of events) manager().webContents.sendInputEvent(e); return true; },
    keys: ({ text = "", key = "", modifiers = [] }) => {
      const wc = manager().webContents;
      for (const ch of text) for (const type of ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type, keyCode: ch });
      if (key) for (const type of modifiers.length ? ["keyDown", "keyUp"] : ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type, keyCode: key, modifiers });
      return true;
    },
    capture: async ({ file }) => { fs.writeFileSync(file, (await within(manager().webContents.capturePage(), 10000, "capturePage")).toPNG()); return true; },
    recorded: () => ({ opened: opened.splice(0), paths: paths.splice(0), trashed: trashed.splice(0) }),
    info: () => ({ pid: process.pid, userData: app.getPath("userData"), home: os.homedir(), downloads: app.getPath("downloads"), focused: manager().isFocused() }),
    quit: () => { setImmediate(() => app.quit()); return true; }
  };
  process.on("message", async m => {
    try { process.send({ id: m.id, ok: true, result: await commands[m.cmd](m.args || {}) }); }
    catch (e) { try { process.send({ id: m.id, ok: false, error: String(e?.message || e) }); } catch {} }
  });
  process.on("disconnect", () => app.quit());
  app.on("browser-window-created", (_e, win) => {
    win.webContents.on("did-finish-load", () => { if (isManager(win)) try { process.send({ event: "loaded" }); } catch {} });
    win.webContents.on("console-message", (...args) => {
      const d = args[0] && typeof args[0] === "object" && "message" in args[0] ? args[0] : { level: args[1], message: args[2] };
      if (d.level === "error" || d.level >= 3) try { process.send({ event: "pageError", message: String(d.message) }); } catch {}
    });
  });
  return;
}

// ===================================================== the driver =====================================================
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createLaunch } = require("../src/host/launch");
const { equipTerminals, terminalEvents } = require("../src/host");
const { HostError } = require("../src/host/errors");
const { normPath } = require("../src/shared/util");

const WIN = process.platform === "win32";
const VERBOSE = Boolean(process.env.FILES_E2E_VERBOSE);
const LANG = process.env.FILES_E2E_LANG === "bg" ? "bg" : "en"; // the texts are read from the page: either language runs
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-files-e2e-"));
const NEEDLE = path.basename(root); // in the command line of every process this test starts, and of no other
const profile = path.join(root, "profile"), home = path.join(root, "home"), downloads = path.join(root, "downloads");
const hWork = path.join(root, "work"), hProject = path.join(hWork, "shop-api"), localProject = path.join(root, "local-notes");
const shots = path.resolve(process.env.FILES_E2E_SHOTS || path.join(ROOT, ".tmp", "files-e2e"));
for (const dir of [profile, home, downloads, hProject, localProject, shots]) fs.mkdirSync(dir, { recursive: true });
const inRoot = p => path.resolve(p).toLowerCase().startsWith(root.toLowerCase() + path.sep);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (test, what, ms = 20000, step = 50) => {
  const from = Date.now();
  for (;;) {
    const v = await test();
    if (v) return v;
    if (Date.now() - from > ms) throw new Error(`timed out: ${what}`);
    await sleep(step);
  }
};
const say = line => console.log(`  ${line}`);
const J = JSON.stringify;

// ---------- files on disk ----------
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return data; };
const random = n => crypto.randomBytes(n);
// A folder as [relative path, bytes or "<dir>"], sorted: two trees are the same when these are.
function treeOf(dir, rel = "") {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name, p = path.join(dir, d.name);
    if (d.isDirectory()) out.push([r, "<dir>"], ...treeOf(p, r));
    else out.push([r, crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const parts = dir => fs.readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith(".agentdeck-part"));

// ---------- the processes of this test ----------
const ours = () => new Promise(resolve => {
  if (!WIN) return void execFile("ps", ["-eo", "pid=,args="], (_e, out) => resolve(String(out || "").split("\n").filter(l => l.includes(NEEDLE) && !l.includes("ps -eo")).map(l => ({ pid: Number(l.trim().split(/\s+/)[0]), name: l.trim().split(/\s+/)[1] }))));
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${NEEDLE}*' } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 30000 }, (_e, out) =>
    resolve(String(out || "").split(/\r?\n/).filter(Boolean).map(l => ({ pid: Number(l.split("|")[0]), name: l.split("|")[1] }))));
});
const kill = pid => new Promise(resolve => {
  if (!WIN) { try { process.kill(pid, "SIGKILL"); } catch {} return void resolve(); }
  execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
});

// ---------- the mesh around the app ----------
const VERSION = require("../package.json").version;
function node(name, { api = async () => null, dir = path.join(root, "nodes", name), port = 0 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port, name, discoverable: false }));
  return createLinks({ dir, defaultName: name, kind: "desktop", version: VERSION, api, discover: false, listen: "127.0.0.1", log: () => {} });
}
// What a desktop serves (as test-ports-electron.cjs): real terminals and one project; its home is the test's work folder.
function makeHost() {
  const dir = path.join(root, "h-data");
  fs.mkdirSync(dir, { recursive: true });
  const host = new EventEmitter();
  const { createTerminals } = require(WIN ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({ userDataDir: dir, ...terminalEvents(host) });
  const data = { registry: { projects: [{ name: "shop-api", path: hProject }] }, sessions: [], agents: [], at: Date.now() };
  const sessions = { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} }, scan: async () => {} };
  const liveSessions = async () => [];
  const launch = createLaunch({ dataDir: dir, terminals, liveSessions, findTranscript: () => "", sessions });
  equipTerminals(host, { terminals, launch, liveSessions });
  return Object.assign(host, { git: { get: () => ({}), refresh: async () => {} }, setup: {}, sessions, home: hWork, sendText: {}, findTranscript: () => "", preview: () => null });
}
// A computer with an AgentDeck from before the files: it shares one terminal, its host.info has no `files`.
const OLD_TERM = crypto.randomUUID();
const oldApi = method => {
  const tab = { id: OLD_TERM, cwd: "/srv/legacy", title: "bash", agent: "", sessionId: "", exited: false, createdAt: Date.now() - 60000, owner: "", ownerName: "", reopened: false, viewers: [], driver: null };
  if (method === "host.info") return { name: "OLD-BOX", kind: "desktop", platform: "linux", home: "/home/dev", agents: [], terminals: 2, ports: 1 };
  if (method === "sessions.list") return { registry: { projects: [{ name: "legacy", path: "/srv/legacy" }] }, sessions: [], agents: [] };
  if (method === "live.list") return [];
  if (method === "git.status") return {};
  if (method === "terminals.list") return [tab];
  if (method === "terminals.attach") return { scrollback: "dev@old-box:/srv/legacy$ ", end: 25, exitCode: null, cols: 80, rows: 24, driver: null };
  if (method === "terminals.detach") return true;
  throw new HostError("unknownMethod");
};

// ---------- the app ----------
// The page's side of the steps: what the dialog shows, and where an element is.
const LIB = `(() => { if (window.__ft) return;
  const ft = window.__ft = {
    view: () => document.getElementById("filesView"),
    shown: () => Boolean(ft.view() && !ft.view().hidden),
    pane: side => document.querySelector('#filesView .fpane[data-side="' + side + '"]'),
    rows: side => [...(ft.pane(side)?.querySelectorAll(".frow[data-i]") || [])].map(r => ({ i: Number(r.dataset.i), name: r.querySelector(".fname span").textContent, dir: r.classList.contains("dir"), sel: r.classList.contains("sel"), size: r.querySelector(".fsize").textContent })),
    row: (side, name) => [...(ft.pane(side)?.querySelectorAll(".frow[data-i]") || [])].find(r => r.querySelector(".fname span").textContent === name) || null,
    head: side => { const p = ft.pane(side); return p && { badge: p.querySelector(".fpane-badge").textContent.trim(), name: p.querySelector(".fpane-name").textContent, remote: p.classList.contains("remote"), note: p.querySelector(".fpane-note")?.textContent.trim() || "" }; },
    crumbs: side => [...(ft.pane(side)?.querySelectorAll(".fcrumb") || [])].map(c => c.textContent),
    path: side => filesPanes.find(p => p.side === side)?.path ?? null,
    loading: side => Boolean(filesPanes.find(p => p.side === side)?.loading),
    queue: () => [...document.querySelectorAll("#filesView .fq-row")].map(r => ({ name: r.querySelector(".fq-name").textContent, route: r.querySelector(".fq-route").textContent.replace(/\\s+/g, " ").trim(), state: ["queued", "running", "done", "failed", "stopped", "waiting", "noAnswer", "declined", "expired"].find(s => r.classList.contains(s)), shown: r.querySelector(".fq-state").textContent, detail: r.querySelector(".fq-detail").textContent })),
    menu: () => document.querySelector(".menu.files-menu"),
    menuRows: () => [...(ft.menu()?.querySelectorAll(":scope > button[data-i]") || [])].map(b => ({ i: Number(b.dataset.i), label: b.querySelector("span").textContent, disabled: b.disabled, danger: b.classList.contains("danger") })),
    menuRow: label => [...(ft.menu()?.querySelectorAll(":scope > button[data-i]") || [])].find(b => b.querySelector("span").textContent === label) || null,
    dialog: () => { const d = [...document.querySelectorAll("dialog[open]")].at(-1); return d && { cls: d.className, title: d.querySelector("h2")?.textContent || "", body: d.querySelector("p")?.textContent || "", value: d.querySelector("input")?.value ?? null, html: d.querySelector(".fpv-body")?.innerHTML || "" }; },
    dialogButton: value => [...document.querySelectorAll("dialog[open]")].at(-1)?.querySelector('button[value="' + value + '"]') || null,
    toasts: () => [...document.querySelectorAll("#toasts .toast-item:not(.out)")].map(el => ({ text: el.dataset.text, error: el.classList.contains("error") })),
    at: el => {
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect(), x = Math.round(r.left + Math.min(r.width / 2, 60)), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: Boolean(hit && (hit === el || el.contains(hit))), over: hit ? hit.tagName.toLowerCase() + "." + String(hit.className?.baseVal ?? hit.className) : "nothing" };
    },
    // A drag from a row of one pane onto the other pane's list, as the page's own DragEvents (see the header).
    drag: (side, name, onto) => {
      const row = ft.row(side, name), list = ft.pane(onto).querySelector(".fpane-list"), dt = new DataTransfer();
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire(row, "dragstart");
      const over = !fire(list, "dragover");
      const shown = ft.pane(onto).classList.contains("drop") ? ft.pane(onto).dataset.drop : "";
      fire(list, "drop");
      fire(row, "dragend");
      return { accepted: over, shown };
    }
  };
})();`;
const electronEnv = () => {
  const roaming = path.join(home, "AppData", "Roaming"), local = path.join(home, "AppData", "Local");
  for (const dir of [roaming, local]) fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, AGENTDECK_USER_DATA: profile, FILES_E2E_HOOK: "1", FILES_E2E_ROOT: root, FILES_E2E_DOWNLOADS: downloads, USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ASM_USER_DATA;
  for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|OPENAI|ANTHROPIC|OPENCODE|GEMINI)/i.test(key)) delete env[key];
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path") || "PATH";
  const sys = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  env[pathKey] = WIN ? [path.join(sys, "System32"), sys, path.join(sys, "System32", "Wbem"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";") : "/usr/local/bin:/usr/bin:/bin";
  return env;
};
const started = [], stops = [];
let app = null, phone = null, appId = "";
async function startApp() {
  const flags = ["--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"];
  const child = spawn(require("electron"), [...flags, "-r", __filename, ROOT, `--files-e2e=${NEEDLE}`], { cwd: ROOT, env: electronEnv(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: false });
  started.push(child);
  let output = "", loaded = 0, seq = 0;
  const pending = new Map(), pageErrors = [];
  for (const stream of [child.stdout, child.stderr]) stream.on("data", d => { output += d; if (VERBOSE) process.stderr.write(d); });
  child.on("message", m => {
    if (m.event === "loaded") return void loaded++;
    if (m.event === "pageError") return void pageErrors.push(m.message);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
  });
  const exited = new Promise(resolve => child.once("exit", code => { for (const p of pending.values()) p.reject(new Error("the app exited")); resolve(code); }));
  const send = (cmd, args) => new Promise((resolve, reject) => {
    if (!child.connected) return void reject(new Error("the app is gone"));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.send({ id, cmd, args });
  });
  const ev = code => send("eval", { code: `${LIB}\n${code}` });
  const a = { child, pid: child.pid, send, ev, exited, pageErrors, output: () => output };
  const ready = async () => {
    await until(() => loaded > 0, "the manager window loads", 60000);
    await until(() => ev("document.readyState === 'complete' && typeof openFilesDialog === 'function' && ui.loaded === true").catch(() => false), "the page is ready", 30000, 150);
  };
  await Promise.race([ready(), exited.then(code => { throw new Error(`the app exited at once (code ${code}):\n${output}`); })]);
  return a;
}

// ---------- the steps' tools ----------
const tools = a => {
  const { ev, send } = a;
  const mouse = (...events) => send("mouse", { events });
  async function pointAt(expr, what) {
    const at = await ev(`__ft.at(${expr})`);
    assert.ok(at, `${what}: the element is there`);
    assert.ok(at.hit, `${what}: the pointer lands on it (there: ${at.over})`);
    await mouse({ type: "mouseMove", x: at.x, y: at.y });
    await sleep(50);
    return at;
  }
  // hold: the button is held that long, as a person's click is - long enough for the page to draw meanwhile.
  async function click(expr, what, { button = "left", count = 1, modifiers = [], hold = 0 } = {}) {
    const at = await pointAt(expr, what);
    for (let c = 1; c <= count; c++) {
      await mouse({ type: "mouseDown", x: at.x, y: at.y, button, clickCount: c, modifiers });
      if (hold) await sleep(hold);
      await mouse({ type: "mouseUp", x: at.x, y: at.y, button, clickCount: c, modifiers });
    }
    await sleep(80);
  }
  const keys = (text, key, modifiers = []) => send("keys", { text, key, modifiers });
  const t = (key, vars = {}) => ev(`t(${J(key)}, ${J(vars)})`);
  const shot = async name => { await sleep(250); const file = path.join(shots, `${name}.png`); await send("capture", { file }); return file; };
  // The menu of a row, opened with a right click; then a click on one of its items.
  async function menu(side, name, label) {
    await click(`__ft.row(${J(side)}, ${J(name)})`, `the row ${name}`, { button: "right" });
    await until(() => ev("Boolean(__ft.menu())"), `the menu of ${name} opens`, 5000);
    const rows = await ev("__ft.menuRows()");
    assert.ok(rows.some(r => r.label === label), `the menu of ${name} has "${label}" (it has: ${rows.map(r => r.label).join(" | ")})`);
    await click(`__ft.menuRow(${J(label)})`, `"${label}"`);
    return rows;
  }
  const dialog = () => until(() => ev("__ft.dialog()"), "a dialog opens", 8000);
  const rowThere = (side, name) => until(() => ev(`Boolean(__ft.row(${J(side)}, ${J(name)}))`), `${name} is listed in the ${side} pane`, 20000, 100);
  const rowGone = (side, name) => until(async () => !(await ev(`Boolean(__ft.row(${J(side)}, ${J(name)}))`)), `${name} leaves the ${side} pane`, 20000, 100);
  const queueRow = (name, test, what) => until(async () => (await ev("__ft.queue()")).filter(r => r.name === name).find(test), what, 60000, 100);
  return { mouse, click, keys, t, shot, menu, dialog, rowThere, rowGone, queueRow };
};

// ======================================================= the run =======================================================
async function main() {
  // ---------- what H holds ----------
  const big = write(path.join(hProject, "build.bin"), random(5 * 1024 * 1024 + 12345));
  const huge = write(path.join(hProject, "huge.bin"), random(64 * 1024 * 1024));
  const tree = path.join(hProject, "tree");
  write(path.join(tree, "readme.txt"), "a tree to copy");
  write(path.join(tree, "empty.txt"), "");
  write(path.join(tree, "sub", "deeper", "бележки ü.txt"), "не-ASCII име");
  write(path.join(tree, "sub", "odd.bin"), random(300 * 1024 + 7));
  fs.mkdirSync(path.join(tree, "empty-folder"));
  for (let i = 0; i < 620; i++) write(path.join(tree, "many", `item-${String(i).padStart(4, "0")}.txt`), `item ${i}\n`);
  write(path.join(hProject, "notes.md"), "# Release notes\n\n- first *thing*\n- `second`\n\n```\ncode <b>here</b>\n```\n");
  write(path.join(hProject, "taken.txt"), "H's own taken.txt");
  write(path.join(hProject, "spec.pdf"), "%PDF-1.4\n% a test file, not a real PDF\n");
  // What is here: Downloads already has a build.bin (so H's arrives as "build (2).bin"), and a taken.txt of its own.
  const ownBuild = write(path.join(downloads, "build.bin"), "this computer's own build.bin");
  const localTaken = write(path.join(downloads, "taken.txt"), "this computer's taken.txt, going to H");
  const upload = write(path.join(downloads, "upload-me.bin"), random(1024 * 1024 + 3));

  // ---------- the nodes ----------
  const host = makeHost();
  const served = createServed({ host });
  // Every path the app asks H to change is in this test's folder, or refused here (and the run fails at the end).
  const outside = [];
  const h = node("H-FILES", { api: (m, p, peer) => {
    if (["files.delete", "files.rename", "files.copy", "files.mkdir", "files.begin"].includes(m)) {
      const wild = [p?.path, p?.from, p?.to].filter(v => v !== undefined && !(typeof v === "string" && inRoot(v)));
      if (wild.length) { outside.push(`${m} ${J(wild)}`); throw new HostError("notAllowed"); }
    }
    return served.api(m, p, peer);
  } });
  const old = node("OLD-BOX", { api: oldApi });
  // The app's node listens on a port of its own, the same before and after it starts: the phone dials it there.
  const appPort = await new Promise(resolve => { const srv = require("node:net").createServer().listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
  const seed = node("FILES-APP", { dir: path.join(profile, "node"), port: appPort });
  stops.push(() => [h, old].forEach(l => l.stop()));
  const H = (await h.start()).id, OLD = (await old.start()).id;
  served.attach(h);
  await seed.start();
  for (const [l, id] of [[h, H], [old, OLD]]) {
    await seed.pair("127.0.0.1", l.self().port, l.self().code);
    await until(() => seed.online(id), "the nodes link", 15000);
    await sleep(1100); // one pairing a second from one address (pair-guard.js)
  }
  // A phone, paired with the app's node directly (no relay: the address is in the pairing text), then put away until
  // step 6b. Its WebSocket and the Noise inside it are the real phone app's.
  const { createRelayProvider } = await import(require("node:url").pathToFileURL(path.join(ROOT, "mobile", "src", "provider-relay.js")).href);
  const pairCode = require("../src/mesh/pair-code");
  const inv = seed.invite();
  appId = seed.self().id;
  phone = createRelayProvider({ WebSocket: require("ws").WebSocket, keypair: require("../src/mesh/noise").generateKeypair(), name: "Test phone", version: "test" });
  stops.push(() => phone.stop());
  await phone.start();
  const paired = await phone.pairAll(pairCode.encode({ r: null, n: [{ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind, a: "127.0.0.1", p: appPort }] }));
  assert.ok(paired.every(x => x.state === "paired"), `the phone pairs with the app's node: ${J(paired)}`);
  await until(() => phone.online(appId), "the phone links with the app's node", 15000);
  phone.stop();
  seed.stop();
  await sleep(300);
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ ui: { language: LANG, autoUpdate: false }, edgeHandle: { show: false }, notify: { on: false } }));
  const idle = path.join(root, "idle.js");
  fs.writeFileSync(idle, "console.log('shop-api shell ready'); setInterval(() => {}, 1e9);\n");
  const idleCmd = [process.execPath, idle];
  const tH = await host.terminals.open({ cwd: hProject, commandLine: idleCmd.map(x => `"${x}"`).join(" "), argv: idleCmd, title: "shop-api shell", owner: "", env: process.env });
  stops.push(async () => { for (const x of host.terminals.getTabs()) try { await host.terminals.close(x.id); } catch {} });

  // ---------- the app ----------
  app = await startApp();
  const u = tools(app);
  const info = await app.send("info");
  assert.equal(path.resolve(info.userData), path.resolve(profile), "the app runs on the throwaway profile");
  assert.equal(path.resolve(info.downloads), path.resolve(downloads), "and its Downloads is the test's folder");
  say(`the app runs: pid ${info.pid}, focused ${info.focused}; Downloads ${info.downloads}`);
  await until(async () => {
    const nodes = await app.ev("window.manager.getNodes()");
    return nodes.find(n => n.id === H)?.info?.files === 1 && nodes.find(n => n.id === OLD)?.status === "online";
  }, "the app is linked with H and OLD and has read their host.info", 40000, 200);

  // ---------- 1. the button: on a remote pane, not on a local one ----------
  await app.ev(`window.manager.launchFolder(${J(localProject)})`);
  const wsOf = () => app.ev("window.terminals.getWorkspace()");
  const tLocal = (await until(async () => (await wsOf()).terminals.find(x => x.node === "" && x.paned && normPath(x.cwd) === normPath(localProject)), "a local terminal has a pane", 40000, 200)).id;
  const paneSel = term => `document.querySelector('#panes .pane[data-term="${term}"]')`;
  await until(() => app.ev(`Boolean(${paneSel(tLocal)}?.querySelector('[data-ws="ports"]'))`), "the local pane is drawn");
  assert.equal(await app.ev(`Boolean(${paneSel(tLocal)}.querySelector('[data-ws="files"]'))`), false, "a terminal of this computer has no Files button");
  const sideRow = term => `document.querySelector('#terms .agent.term[data-key="term:${term}"] .agent-title')`;
  await until(() => app.ev(`Boolean(${sideRow(tH)})`), "H's terminal is listed in the sidebar");
  await u.click(sideRow(tH), "H's terminal in the sidebar");
  const filesBtn = term => `${paneSel(term)}?.querySelector('[data-ws="files"]')`;
  await until(() => app.ev(`Boolean(${filesBtn(tH)})`), "H's pane has the Files button");
  assert.equal(await app.ev(`${filesBtn(tH)}.getAttribute("aria-label")`), await u.t("files.button", { name: "H-FILES" }));
  say("the Files button: on the pane of H's terminal, not on the local one");

  // ---------- 2. the dialog: which computer is which ----------
  await u.click(filesBtn(tH), "the Files button");
  await until(() => app.ev("__ft.shown()"), "the dialog opens");
  await until(async () => (await app.ev("__ft.path('left')")) && (await app.ev("__ft.path('right')")), "both panes are listed", 20000, 100);
  const en = { thisComputer: await u.t("files.thisComputer"), remote: await u.t("files.remote") };
  assert.deepEqual(await app.ev("__ft.head('left')"), { badge: en.thisComputer, name: "FILES-APP", remote: false, note: "" }, "the left pane is this computer, by name");
  assert.deepEqual(await app.ev("__ft.head('right')"), { badge: en.remote, name: "H-FILES", remote: true, note: "" }, "the right pane is H, marked remote");
  assert.equal(path.resolve(await app.ev("__ft.path('left')")), path.resolve(downloads), "the left pane starts in Downloads");
  assert.equal(path.resolve(await app.ev("__ft.path('right')")), path.resolve(hProject), "the right pane starts in the terminal's folder");
  assert.equal((await app.ev("__ft.crumbs('right')")).at(-1), "shop-api");
  const rightRows = await app.ev("__ft.rows('right')");
  assert.deepEqual(rightRows.map(r => r.name), ["tree", "build.bin", "huge.bin", "notes.md", "spec.pdf", "taken.txt"], "H's folder: folders first, then files by name");
  assert.equal(rightRows.find(r => r.name === "build.bin").size, "5 MB", "sizes are shown");
  assert.equal(await app.ev(`document.querySelector('#filesView [data-send="left"]').getAttribute("aria-label")`), await u.t("files.sendTo", { from: "H-FILES", to: "FILES-APP" }), "◀ says it copies from H to this computer");
  assert.equal(await app.ev(`document.querySelector('#filesView [data-send="right"]').getAttribute("aria-label")`), await u.t("files.sendTo", { from: "FILES-APP", to: "H-FILES" }), "▶ says it copies from this computer to H");
  const shotPanes = await u.shot("01-two-panes");
  say(`the dialog: left "${en.thisComputer} FILES-APP" in Downloads, right "${en.remote} H-FILES" in shop-api (${shotPanes})`);

  // ---------- 2b. moving about: into folders, a page more, the breadcrumb, up ----------
  const listed = async side => { await until(async () => !(await app.ev(`__ft.loading(${J(side)})`)), "the folder is listed", 20000, 50); return app.ev(`__ft.rows(${J(side)})`); };
  await u.click("__ft.row('right', 'tree')", "the tree folder", { count: 2 });
  await until(async () => (await app.ev("__ft.crumbs('right')")).at(-1) === "tree", "a double click on a folder opens it");
  assert.deepEqual((await listed("right")).map(r => r.name), ["empty-folder", "many", "sub", "empty.txt", "readme.txt"]);
  await u.click("__ft.row('right', 'many')", "the many folder", { count: 2 });
  await until(async () => (await app.ev("__ft.crumbs('right')")).at(-1) === "many", "into many");
  let page = await listed("right");
  assert.equal(page.length, 500, "a folder of 620 shows its first page of 500");
  await u.click(`__ft.pane('right').querySelector('[data-fa="more"]')`, `"${await u.t("files.loadMore")}"`);
  page = await until(async () => { const rows = await app.ev("__ft.rows('right')"); return rows.length > 500 ? rows : null; }, "the next page comes");
  assert.equal(page.length, 620, "and the rest when asked");
  assert.equal(new Set(page.map(r => r.name)).size, 620, "no entry twice");
  assert.equal(await app.ev(`Boolean(__ft.pane('right').querySelector('[data-fa="more"]'))`), false, "nothing more to ask for");
  await u.click(`[...__ft.pane('right').querySelectorAll('.fcrumb')].find(c => c.textContent === "shop-api")`, "the shop-api crumb");
  await until(async () => (await app.ev("__ft.crumbs('right')")).at(-1) === "shop-api", "the breadcrumb leads back");
  await u.click(`__ft.pane('left').querySelector('[data-fa="up"]')`, "Up in the left pane");
  await until(async () => path.resolve(await app.ev("__ft.path('left')")) === path.resolve(root), "Up goes to the folder above");
  await u.click("__ft.row('left', 'downloads')", "the downloads folder", { count: 2 });
  await until(async () => path.resolve(await app.ev("__ft.path('left')")) === path.resolve(downloads), "back into Downloads");
  await listed("left");
  await listed("right");
  say("moving about: a double click opens a folder, 500 then 620 entries with Show more, the breadcrumb and Up lead back");

  // ---------- 2c. the order and the search of a pane ----------
  const names = async side => (await listed(side)).map(r => r.name);
  const head = (side, key) => `__ft.pane(${J(side)}).querySelector('.fhead [data-sort="${key}"]')`;
  const arrow = (side, key) => app.ev(`${head(side, key)}.querySelector('.fsort').textContent`);
  assert.equal(await app.ev(`__ft.pane('right').querySelector('.fpane-find').hidden`), false, "H can sort and search: the search is there");
  await u.click(head("right", "size"), "the Size column of H's pane");
  await until(async () => (await arrow("right", "size")) === "▼", "the Size column says largest first");
  assert.deepEqual(await names("right"), ["tree", "huge.bin", "build.bin", "notes.md", "spec.pdf", "taken.txt"], "largest first, the folder first");
  await u.click(head("right", "size"), "the Size column again");
  await until(async () => (await arrow("right", "size")) === "▲", "and then smallest first");
  assert.deepEqual(await names("right"), ["tree", "taken.txt", "spec.pdf", "notes.md", "build.bin", "huge.bin"], "smallest first, the folder still first");
  assert.equal(await arrow("right", "name"), "", "only the column in use has an arrow");
  assert.deepEqual(await app.ev("JSON.parse(localStorage.getItem('agentdeck.files.sort')).right"), { sort: "size", desc: false }, "the order of H's side is remembered");
  assert.equal(await arrow("left", "name"), "▲", "the other pane keeps its own order");
  const shotSorted = await u.shot("02b-sorted-by-size");
  await u.click(head("right", "name"), "the Name column");
  await until(async () => (await arrow("right", "name")) === "▲", "back to name A-Z");
  assert.deepEqual(await names("right"), ["tree", "build.bin", "huge.bin", "notes.md", "spec.pdf", "taken.txt"]);
  // The search: a name typed, the matches only, after a pause; Escape clears it.
  await u.click(`__ft.pane('right').querySelector('.fpane-filter')`, "H's search field");
  await u.keys("TA");
  await until(async () => J(await names("right")) === J(["taken.txt"]), "only the names that hold the text, whatever the case", 8000, 100);
  assert.equal(await app.ev(`__ft.pane('right').querySelector('.fpane-count').textContent`), await u.t("files.count.matching", { n: 1 }));
  const shotFiltered = await u.shot("02c-filtered");
  await u.keys("", "Escape");
  await until(async () => (await names("right")).length === 6, "Escape clears the search and lists all again", 8000, 100);
  assert.equal(await app.ev("__ft.shown()"), true, "Escape in the search does not close the dialog");
  assert.equal(await app.ev(`__ft.pane('right').querySelector('.fpane-filter').value`), "");
  say(`order and search: Size twice - largest then smallest first, folders first (${shotSorted}); "TA" lists taken.txt only (${shotFiltered}); Escape clears it`);

  // ---------- 3. a multi-megabyte file, downloaded with a double click onto a name that is taken ----------
  await u.click("__ft.row('right', 'build.bin')", "build.bin on H", { count: 2 });
  const down = await u.queueRow("build.bin", r => r.state === "done", "the download ends");
  assert.equal(down.route, `H-FILES → FILES-APP (${await u.t("term.thisComputer")})`, "the queue row says from H to this computer");
  const got = path.join(downloads, "build (2).bin");
  assert.ok(fs.readFileSync(got).equals(big), "build (2).bin is H's file, byte for byte");
  assert.equal(fs.readFileSync(path.join(downloads, "build.bin"), "utf8"), ownBuild, "the build.bin that was here is untouched");
  assert.deepEqual(parts(downloads), [], "no unfinished file is left");
  await u.rowThere("left", "build (2).bin");
  say(`download: build.bin (${big.length} bytes) arrived as "build (2).bin", equal; the own build.bin untouched; queue: "${down.route}" ${down.shown}`);

  // ---------- 4. Stop in the middle of a file ----------
  await u.click("__ft.row('right', 'huge.bin')", "huge.bin on H", { count: 2 });
  await u.queueRow("huge.bin", r => r.state === "running" && /\d+ %/.test(r.shown) && r.shown !== "0 %", "huge.bin is on its way");
  const shotQueue = await u.shot("02-transfer-in-queue");
  await u.click(`[...document.querySelectorAll("#filesView .fq-row")].find(r => r.querySelector(".fq-name").textContent === "huge.bin" && r.classList.contains("running")).querySelector('[data-fa="stop"]')`, "Stop", { hold: 400 });
  await u.queueRow("huge.bin", r => r.state === "stopped", "the transfer stops");
  assert.equal(fs.existsSync(path.join(downloads, "huge.bin")), false, "the stopped file is not there");
  assert.deepEqual(parts(downloads), [], "and nothing unfinished is left of it");
  say(`Stop: huge.bin stopped part-way, nothing of it left (${shotQueue})`);

  // ---------- 5. a folder tree, with the arrow ----------
  await u.click("__ft.row('right', 'tree')", "the tree folder on H");
  await u.click(`document.querySelector('#filesView [data-send="left"]')`, "◀");
  const treeRow = await u.queueRow("tree", r => r.state === "done", "the folder arrives");
  assert.deepEqual(treeOf(path.join(downloads, "tree")), treeOf(tree), "the folder arrived whole: every file, byte for byte, the empty file and folder, the non-ASCII name, more than one page of entries");
  assert.deepEqual(parts(downloads), []);
  say(`folder: tree (${treeOf(tree).length} entries) arrived equal; "${treeRow.detail}"`);

  // ---------- 6. upload with the other arrow, onto a name that is taken there ----------
  await u.rowThere("left", "taken.txt");
  await u.click("__ft.row('left', 'taken.txt')", "taken.txt here");
  await u.click(`document.querySelector('#filesView [data-send="right"]')`, "▶");
  const up = await u.queueRow("taken.txt", r => r.state === "done", "the upload ends");
  assert.equal(up.route, `FILES-APP (${await u.t("term.thisComputer")}) → H-FILES`, "the queue row says from this computer to H");
  assert.equal(fs.readFileSync(path.join(hProject, "taken (2).txt"), "utf8"), localTaken, "it arrived as taken (2).txt");
  assert.equal(fs.readFileSync(path.join(hProject, "taken.txt"), "utf8"), "H's own taken.txt", "H's taken.txt is untouched");
  await u.rowThere("right", "taken (2).txt");
  // A drag from the left pane onto the right one.
  const drag = await app.ev("__ft.drag('left', 'upload-me.bin', 'right')");
  assert.deepEqual(drag, { accepted: true, shown: await u.t("files.dropHere", { name: "H-FILES" }) }, "the right pane takes the drag and says where it goes");
  await u.queueRow("upload-me.bin", r => r.state === "done", "the dragged file arrives");
  assert.ok(fs.readFileSync(path.join(hProject, "upload-me.bin")).equals(upload), "the dragged file arrived on H, equal");
  assert.deepEqual(parts(hProject), []);
  say(`upload: taken.txt arrived on H as "taken (2).txt" ("${up.route}"); upload-me.bin dragged across, equal`);

  // ---------- 6b. send to phone ----------
  const toPhone = await u.t("files.menu.toPhone");
  const rightClick = async (side, name) => {
    await u.click(`__ft.row(${J(side)}, ${J(name)})`, `the row ${name}`, { button: "right" });
    await until(() => app.ev("Boolean(__ft.menu())"), `the menu of ${name} opens`, 5000);
    return app.ev("__ft.menuRows()");
  };
  const closeMenu = async () => { await u.keys("", "Escape"); await until(async () => !(await app.ev("Boolean(__ft.menu())")), "the menu closes", 5000); };
  let rows = await rightClick("left", "upload-me.bin");
  const off = rows.find(r => r.label.startsWith(toPhone));
  assert.ok(off, `a file of this computer has "${toPhone}" (the menu has: ${rows.map(r => r.label).join(" | ")})`);
  assert.equal(off.disabled, true, "disabled while no phone is linked");
  assert.equal(off.label, toPhone + (await u.t("files.toPhone.offline")), "and it says why: the phone is paired, not connected");
  const shotNoPhone = await u.shot("08-send-to-phone-none");
  await closeMenu();
  rows = await rightClick("right", "notes.md");
  assert.ok(!rows.some(r => r.label.startsWith(toPhone)), "a file of H is not sent to the phone from here (the phone pulls from the computer it is linked to)");
  await closeMenu();
  rows = await rightClick("left", "tree");
  assert.ok(!rows.some(r => r.label.startsWith(toPhone)), "a folder is not sent to a phone");
  await closeMenu();
  // The phone comes online.
  const offers = [];
  phone.on("notify", n => { if (n.event === "files.offer") offers.push(n); });
  await phone.start();
  phone.wake();
  await until(() => phone.online(appId), "the phone links with the app", 40000, 200);
  const named = await u.t("files.menu.toPhoneNamed", { name: "Test phone" });
  await until(async () => { const r = await rightClick("left", "upload-me.bin"); const ok = r.some(x => x.label === named && !x.disabled); if (!ok) await closeMenu(); return ok; }, "the menu names the phone once it is linked", 15000, 300);
  const shotMenu = await u.shot("09-send-to-phone-menu");
  await u.click(`__ft.menuRow(${J(named)})`, `"${named}"`);
  await until(() => offers.length === 1, "the offer reaches the phone", 15000);
  assert.equal(offers[0].node, appId, "from the app's node");
  assert.equal(offers[0].payload.name, "upload-me.bin");
  assert.equal(offers[0].payload.size, upload.length);
  let sentRow = await u.queueRow("upload-me.bin", r => r.state === "waiting", "the queue has the offer, waiting for the phone");
  assert.equal(sentRow.route, `FILES-APP (${await u.t("term.thisComputer")}) → Test phone`, "the row says from this computer to the phone");
  await phone.request(appId, "files.answer", { offer: offers[0].payload.offer, state: "declined" });
  sentRow = await u.queueRow("upload-me.bin", r => r.state === "declined", "the row says the phone declined");
  assert.equal(sentRow.shown, await u.t("files.state.declined"));
  // Again, accepted this time: the phone pulls it through the app with the phone app's own logic, into a fake plugin.
  await rightClick("left", "upload-me.bin");
  await u.click(`__ft.menuRow(${J(named)})`, `"${named}"`);
  await until(() => offers.length === 2, "the second offer reaches the phone", 15000);
  const phoneDir = path.join(root, "phone-downloads");
  fs.mkdirSync(phoneDir, { recursive: true });
  const plugin = {
    begin: async ({ name }) => { const file = path.join(phoneDir, name); fs.writeFileSync(file, Buffer.alloc(0)); return { file }; },
    write: async ({ file, data }) => { fs.appendFileSync(file, Buffer.from(data, "base64")); return {}; },
    finish: async ({ file }) => ({ shown: path.basename(file) }),
    cancel: async ({ file }) => { fs.rmSync(file, { force: true }); return {}; }
  };
  const M = await import(require("node:url").pathToFileURL(path.join(ROOT, "mobile", "src", "files.js")).href);
  const offerSeen = M.checkOffer(offers[1].payload);
  assert.ok(offerSeen, "the offer passes the phone's check");
  const kept = await M.takeOffer({ provider: phone, node: appId, plugin, offer: offerSeen, save: true });
  assert.ok(fs.readFileSync(path.join(phoneDir, kept.shown)).equals(upload), "the phone has the file, byte for byte");
  sentRow = await u.queueRow("upload-me.bin", r => r.state === "done" && r.route.endsWith("Test phone"), "the row reaches done");
  await app.ev("document.querySelector('#filesView .fq-list').scrollTop = 1e6");
  const shotQueuePhone = await u.shot("10-send-to-phone-queue");
  phone.stop();
  say(`send to phone: disabled with its reason while the phone is away (${shotNoPhone}); named once linked (${shotMenu}); declined, then accepted and pulled byte for byte - the row "${sentRow.route}" ${sentRow.shown} (${shotQueuePhone})`);

  // ---------- 7. rename on H, and onto a name that is taken ----------
  await u.menu("right", "notes.md", await u.t("files.menu.rename"));
  let d = await u.dialog();
  assert.equal(d.value, "notes.md");
  assert.equal(d.body, await u.t("files.rename.body", { name: "notes.md", computer: "H-FILES" }), "the rename names H");
  await u.keys("release");
  await u.keys("", "Enter");
  await u.rowThere("right", "release.md");
  assert.ok(fs.existsSync(path.join(hProject, "release.md")) && !fs.existsSync(path.join(hProject, "notes.md")), "renamed on H");
  assert.equal(await app.ev("document.activeElement === __ft.pane('right').querySelector('.fpane-list')"), true, "the keyboard is back in H's list after the rename");
  // F2 there renames too: its dialog opens, and Escape gives it up.
  await u.click("__ft.row('right', 'release.md')", "release.md");
  await u.keys("", "F2");
  assert.equal((await u.dialog()).value, "release.md", "F2 on the list asks for a new name");
  await u.keys("", "Escape");
  await until(async () => !(await app.ev("__ft.dialog()")), "the question goes", 5000);
  say("rename: notes.md -> release.md on H; the keyboard back in the list; F2");
  // Onto a name that is taken: the whole name written over (Ctrl+A), then the offer of a free one.
  await u.menu("right", "release.md", await u.t("files.menu.rename"));
  await u.dialog();
  await u.keys("", "A", ["control"]);
  await u.keys("taken.txt");
  await u.keys("", "Enter");
  d = await until(async () => { const x = await app.ev("__ft.dialog()"); return x && x.value === "taken (2).txt" ? x : null; }, "the rename onto a taken name asks again, with a numbered name", 8000);
  assert.equal(d.body, await u.t("files.rename.taken", { name: "taken.txt", computer: "H-FILES" }), "it says the name is taken on H");
  // "taken (2).txt" is taken too (the upload above): the offer goes on to (3).
  await u.keys("", "Enter");
  d = await until(async () => { const x = await app.ev("__ft.dialog()"); return x && x.value === "taken (3).txt" ? x : null; }, '"taken (2).txt" is taken too: "taken (3).txt" is offered', 8000);
  assert.equal(d.body, await u.t("files.rename.taken", { name: "taken (2).txt", computer: "H-FILES" }));
  await u.keys("", "Enter");
  await u.rowThere("right", "taken (3).txt");
  assert.equal(fs.readFileSync(path.join(hProject, "taken.txt"), "utf8"), "H's own taken.txt", "nothing was written over");
  assert.equal(fs.readFileSync(path.join(hProject, "taken (2).txt"), "utf8"), localTaken);
  assert.ok(fs.readFileSync(path.join(hProject, "taken (3).txt"), "utf8").startsWith("# Release notes"), "the renamed file got the free name");
  say('rename onto a taken name: "taken (2).txt" offered, then "taken (3).txt"; nothing written over');

  // ---------- 8. copy on H: a file and a folder in place ----------
  await u.menu("right", "build.bin", await u.t("files.menu.copy"));
  d = await u.dialog();
  assert.equal(path.resolve(d.value), path.resolve(hProject), "the copy asks for a folder, starting with the one shown");
  await u.keys("", "Enter");
  await u.rowThere("right", "build (2).bin");
  assert.ok(fs.readFileSync(path.join(hProject, "build (2).bin")).equals(big), "copied on H as build (2).bin");
  await u.menu("right", "tree", await u.t("files.menu.copy"));
  await u.dialog();
  await u.keys("", "Enter");
  await u.rowThere("right", "tree (2)");
  assert.deepEqual(treeOf(path.join(hProject, "tree (2)")), treeOf(tree), "the folder copied on H as tree (2)");
  const copyRoute = await u.t("files.row.copy", { name: "H-FILES" });
  const copyRow = (await app.ev("__ft.queue()")).find(r => r.name === "tree" && r.route === copyRoute);
  assert.ok(copyRow && copyRow.state === "done", `the copy is a row of the queue (${J(copyRow)})`);
  say('copy on H: build.bin -> "build (2).bin", tree -> "tree (2)"');

  // ---------- 9. delete: on H for good, here into the bin ----------
  await u.menu("right", "build (2).bin", await u.t("files.menu.delete"));
  d = await u.dialog();
  assert.equal(d.title, await u.t("files.delete.title", { name: "build (2).bin" }));
  assert.equal(d.body, await u.t("files.delete.forGood", { name: "build (2).bin", computer: "H-FILES" }), "the confirmation names H and says it is for good (H has no bin)");
  const shotDelete = await u.shot("03-delete-confirmation");
  await u.click('__ft.dialogButton("ok")', "Delete");
  await u.rowGone("right", "build (2).bin");
  assert.equal(fs.existsSync(path.join(hProject, "build (2).bin")), false, "deleted on H");
  assert.ok(fs.existsSync(path.join(hProject, "build.bin")), "the rest is there");
  await u.menu("left", "build (2).bin", await u.t("files.menu.delete"));
  d = await u.dialog();
  assert.equal(d.body, await u.t("files.delete.trash", { name: "build (2).bin", computer: "FILES-APP" }), "here the confirmation names this computer and says it goes to the Recycle Bin");
  const shotDeleteLocal = await u.shot("04-delete-confirmation-local");
  await u.click('__ft.dialogButton("ok")', "Delete");
  await u.rowGone("left", "build (2).bin");
  const trashed = (await app.send("recorded")).trashed;
  assert.deepEqual(trashed.map(p => path.resolve(p)), [path.resolve(downloads, "build (2).bin")], "the bin was asked for that one file");
  assert.ok(trashed.every(inRoot), "every delete stayed in the test's folder");
  // Cancel leaves it.
  await u.menu("right", "huge.bin", await u.t("files.menu.delete"));
  await u.dialog();
  await u.click('__ft.dialogButton("cancel")', "Cancel");
  await sleep(300);
  assert.ok(fs.existsSync(path.join(hProject, "huge.bin")), "a delete that was cancelled deletes nothing");
  say(`delete: on H for good after a confirmation naming H (${shotDelete}); here into the bin, naming this computer (${shotDeleteLocal}); Cancel deletes nothing`);

  // ---------- 10. previews ----------
  await u.menu("right", "taken (3).txt", await u.t("files.menu.preview"));
  d = await until(async () => { const x = await app.ev("__ft.dialog()"); return x?.cls.includes("files-preview") ? x : null; }, "the preview opens");
  assert.ok(d.html.includes("# Release notes"), "a text file is shown as it is");
  await u.keys("", "Escape");
  await sleep(200);
  write(path.join(hProject, "guide.md"), "# Guide\n\n- one *two*\n- `three`\n\n```\n<script>alert(1)</script>\n```\n");
  await u.click(`document.querySelector('#filesView .fpane[data-side="right"] [data-fa="refresh"]')`, "refresh H's pane");
  await u.rowThere("right", "guide.md");
  await u.menu("right", "guide.md", await u.t("files.menu.preview"));
  d = await until(async () => { const x = await app.ev("__ft.dialog()"); return x?.cls.includes("files-preview") ? x : null; }, "the .md preview opens");
  assert.ok(d.html.includes("<h3>Guide</h3>") && d.html.includes("<i>two</i>") && d.html.includes("<code>three</code>"), "the .md is laid out");
  assert.ok(d.html.includes("&lt;script&gt;") && !d.html.includes("<script>"), "and its text stays text");
  const shotPreview = await u.shot("05-preview-md");
  await u.keys("", "Escape");
  await sleep(200);
  await u.menu("right", "spec.pdf", await u.t("files.menu.preview"));
  const pdf = (await until(async () => (await app.send("recorded")).paths[0], "the PDF is handed to its program", 15000));
  assert.ok(path.resolve(pdf.path).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()) && /agentdeck-preview-/.test(pdf.path), `the PDF opens from a temporary copy (${pdf.path})`);
  assert.equal(Buffer.from(pdf.bytes, "base64").toString(), fs.readFileSync(path.join(hProject, "spec.pdf"), "utf8"), "the copy is H's file");
  say(`previews: text, .md laid out and escaped (${shotPreview}), PDF from a temporary copy`);

  // ---------- 11. a computer too old for files ----------
  await u.click("__ft.view().querySelector('[data-fa=\"close\"]')", "Close");
  await until(async () => !(await app.ev("__ft.shown()")), "the dialog closes");
  await until(() => app.ev(`Boolean(${sideRow(OLD_TERM)})`), "OLD's terminal is listed");
  await u.click(sideRow(OLD_TERM), "OLD's terminal in the sidebar");
  await until(() => app.ev(`Boolean(${filesBtn(OLD_TERM)})`), "OLD's pane has the Files button");
  await u.click(filesBtn(OLD_TERM), "the Files button of OLD's pane");
  await until(() => app.ev("__ft.shown()"), "the dialog opens");
  const oldHead = await until(async () => { const x = await app.ev("__ft.head('right')"); return x?.note ? x : null; }, "the remote pane says why it is empty");
  assert.equal(oldHead.note, await u.t("files.needsUpdate", { name: "OLD-BOX" }), "OLD needs an update");
  await u.shot("06-needs-update");
  await u.keys("", "Escape");
  await until(async () => !(await app.ev("__ft.shown()")), "Escape closes the dialog");
  say(`a computer without files: "${oldHead.note}"`);

  // ---------- 12. H goes away during a transfer ----------
  await u.click(sideRow(tH), "H's terminal in the sidebar");
  await u.click(filesBtn(tH), "the Files button");
  await until(async () => (await app.ev("__ft.path('right')")) && !(await app.ev("__ft.loading('right')")), "H's pane is listed again", 20000, 100);
  await u.rowThere("right", "huge.bin");
  await u.click("__ft.row('right', 'huge.bin')", "huge.bin on H", { count: 2 });
  await until(async () => (await app.ev("__ft.queue()")).some(r => r.name === "huge.bin" && r.state === "running" && r.shown !== "0 %"), "huge.bin is on its way again", 20000, 50);
  h.stop();
  const lost = await u.queueRow("huge.bin", r => r.state === "failed", "the transfer fails with the link");
  assert.equal(lost.detail.split(" · ").at(-1), await u.t("files.error", { computer: "H-FILES", message: await u.t("errors.offline") }), "it says H is not connected");
  await until(() => parts(downloads).length === 0, "the unfinished file is removed", 10000);
  assert.equal(fs.existsSync(path.join(downloads, "huge.bin")), false);
  await u.click("__ft.view().querySelector('[data-fa=\"close\"]')", "Close");
  await until(async () => (await app.ev("window.manager.getNodes()")).find(n => n.id === H)?.status === "offline", "H is offline");
  await u.click(filesBtn(tH), "the Files button, H away");
  const offHead = await until(async () => { const x = await app.ev("__ft.head('right')"); return x?.note ? x : null; }, "the remote pane says H is away");
  assert.equal(offHead.note, await u.t("files.offline", { name: "H-FILES" }));
  await u.shot("07-offline");
  say(`H went away during a transfer: "${lost.detail}"; nothing unfinished left; the dialog says "${offHead.note}"`);

  // ---------- 13. the end ----------
  assert.deepEqual(app.pageErrors, [], "the page logged no error");
  assert.deepEqual(outside, [], "the app asked H to change nothing outside the test's folder");
  for (const term of (await wsOf()).terminals.filter(y => y.node === "" && !y.exited)) await app.ev(`window.terminals.stop(${J(term.id)})`);
  await until(async () => !(await wsOf()).terminals.some(y => y.node === ""), "the local terminals stopped", 15000, 200);
  await app.send("quit");
  assert.equal(await Promise.race([app.exited, sleep(20000).then(() => "still running")]), 0, "the app quits by itself");
  for (const y of host.terminals.getTabs()) await host.terminals.close(y.id);
  const left = await until(async () => { const list = await ours(); return list.length ? null : list; }, "no process of this test is left", 20000, 500).catch(async () => ours());
  assert.deepEqual(left, [], "no process left behind");
}

async function cleanup() {
  if (app && app.child.exitCode === null && app.child.signalCode === null) { try { await app.send("quit"); } catch {} await Promise.race([app.exited, sleep(8000)]); }
  for (const child of started) if (child.exitCode === null && child.signalCode === null) await kill(child.pid);
  for (const stop of stops.reverse()) try { await stop(); } catch {}
  await sleep(300);
  for (const p of await ours()) await kill(p.pid);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (e) { console.error(`could not remove ${root}: ${e.message}`); }
}
const watchdog = setTimeout(() => finish(new Error("the test did not finish in 5 minutes")), 5 * 60 * 1000);
let finishing = false;
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(watchdog);
  if (error) {
    console.error(error);
    if (app && !VERBOSE) console.error(`--- the app's output (its end) ---\n${app.output().slice(-2500)}`);
    try { if (app?.child.connected) console.error(`saved a screenshot of the failure: ${await tools(app).shot("failure")}`); } catch {}
  }
  await cleanup();
  if (!error) {
    console.log(`\n  screenshots: ${shots}`);
    console.log("files in the real app: the button on remote panes only, send to phone (none linked, then declined and done), which pane is which computer, download (double click, taken name), Stop, a folder tree, upload (arrow, drag), rename (taken name offered as (2)), copy, delete (for good on H, the bin here, with confirmations), previews, a computer too old, H going away - passed");
  }
  process.exit(error ? 1 : 0);
}
main().then(() => finish(), finish);
