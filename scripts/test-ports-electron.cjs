// The "Ports" menu and forwarded ports (docs/PORT-FORWARDING.md) in the REAL app, end to end on one machine: the true
// src/main.js with its preload and its page, started as `electron -r <this file> <repo>` on a throwaway profile
// (AGENTDECK_USER_DATA) and a throwaway home (USERPROFILE/HOME: no session, credential or key of the user is read).
//
// This file has two roles:
//   * the driver (plain Node, `node scripts/test-ports-electron.cjs`): the mesh around the app, in this process - R (a
//     relay-only host), H (a desktop that serves real terminals and its loopback ports, mesh/serve.js over
//     host/terminals.js) and OLD (a computer whose host.info has no `ports: 1`) - HTTP services on loopback for H to
//     "own" (one of them a child of a terminal of H), and the steps below, asked of the app over the child's IPC channel;
//   * the hook (inside Electron's main process, before main.js is loaded: PORTS_E2E_HOOK): it replaces what would
//     reach outside the test - shell.openExternal (recorded, no browser opens), globalShortcut.register (no global
//     hotkey is taken), Tray.displayBalloon, and src/voice/native.js's supported() (voice off: no hotkeys, no
//     microphone, no VoiceTray import; Settings is a voice window, so there is none) - and answers the driver: run a script in the manager window, real mouse events
//     (webContents.sendInputEvent), screenshots (capturePage), the clipboard, prefs.set (the language), app.quit.
//   Nothing under src/ is changed for it. The app's PATH is the system's own folders and it gets no agent's
//   variables: no `codex`, `claude` or `git` of the user's is found, so no account of theirs is asked for its limits.
//
// Pairing: the app's node folder (<profile>/node) is made before the app starts - a links.js node of the same folder
// pairs with R directly and with H and OLD through R (as Settings -> Computers does: links.pair), then stops; the app
// starts with that identity and those peers, and reaches H only through R (H is not announced and has no address).
// Settings -> Computers itself is a voice window and is not driven here.
//
// Checked (each on the real page, with real clicks unless said): the pane of a terminal of H and of a local one have
// the Ports button; the menu says "Loading…" and then lists H's ports with process names, the terminal's own first;
// a row forwards and "opens the browser" (the recorded address); GET through 127.0.0.1 and ::1 returns the service's
// page (300 KB, a service on ::1 only, the terminal's own); ticks and "port → localhost:n"; Open as https; Copy
// address (the clipboard, put back after); "Other port…" - what it refuses, a port remembered in <profile>/ports.json,
// shown again, forgotten; a port nobody listens on (said in the window; no browser, no forward, not remembered - typed
// by hand, copied, and from a remembered port's row); Stop forwarding (the listener refuses, the count on the button);
// when the count is visible; the Bulgarian texts; quitting with forwards open; the saved port after a restart; a
// computer too old to forward; H going away with a forward open; no process left behind.
//
// Screenshots go to PORTS_E2E_SHOTS (default: <repo>/.tmp/ports-e2e). PORTS_E2E_VERBOSE=1 prints the app's output.
// A product bug the run shows (a text cut off, say) is listed at the end and does not stop the steps after it;
// PORTS_E2E_STRICT=1 makes such a run fail.
// Windows is where this was run. The app's window comes up on screen and takes the focus for the length of the test
// (about 40 seconds, two runs of the app); its tray icon shows meanwhile. The pointer and the keys are the page's own
// (sendInputEvent), not the system's - but a real pointer moved over the window in that time can get in the way.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, ".."), SRC = path.join(ROOT, "src");

// ====================================================== the hook ======================================================
if (process.versions.electron && process.env.PORTS_E2E_HOOK) {
  const { app, shell, globalShortcut, Tray, BrowserWindow, clipboard, ClipboardItem } = require("electron");
  const opened = [], balloons = [];
  shell.openExternal = async url => { opened.push(String(url)); };
  globalShortcut.register = () => false;
  Tray.prototype.displayBalloon = function (o) { balloons.push({ title: o?.title, content: o?.content }); };
  // main.js asks voice/native.js whether voice can run here before it loads any of it: this answer keeps it off.
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
  let kept = null; // the clipboard as it was
  const commands = {
    eval: ({ code }) => within(manager().webContents.executeJavaScript(code, true), 20000, code.slice(-200)),
    mouse: ({ events }) => { for (const e of events) manager().webContents.sendInputEvent(e); return true; },
    // Keys as a keyboard sends them: keyDown, char, keyUp - for a character, and for a named key ("Enter").
    keys: ({ text = "", key = "" }) => {
      const wc = manager().webContents;
      for (const ch of text) for (const type of ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type, keyCode: ch });
      if (key) for (const type of ["keyDown", "char", "keyUp"]) wc.sendInputEvent({ type, keyCode: key });
      return true;
    },
    capture: async ({ file, rect }) => {
      const image = await within(manager().webContents.capturePage(rect || undefined), 10000, "capturePage");
      fs.writeFileSync(file, image.toPNG());
      return image.getSize();
    },
    opened: () => opened.splice(0),
    balloons: () => balloons.splice(0),
    // The clipboard as it is (Electron's clipboard is the asynchronous one: items of typed blobs), to be put back:
    // every type that can be read is, so a picture or formatted text comes back too.
    clipKeep: async () => {
      const text = await clipboard.readText().catch(() => "");
      const items = [];
      for (const item of await clipboard.read().catch(() => [])) {
        const data = {};
        for (const type of item.types) try { data[type] = await item.getType(type); } catch {}
        if (Object.keys(data).length) items.push(data);
      }
      kept = { text, items };
      return { formats: [...new Set(items.flatMap(Object.keys))] };
    },
    clipRead: () => clipboard.readText(),
    // -> whether the text there is again what it was.
    clipRestore: async () => {
      if (!kept) return false;
      let done = false;
      if (kept.items.length) try { await clipboard.write(kept.items.map(data => new ClipboardItem(data))); done = true; } catch {}
      if (!done) { if (kept.text) await clipboard.writeText(kept.text); else clipboard.clear(); }
      return (await clipboard.readText().catch(() => "")) === kept.text;
    },
    // What Settings does for the language: the app's own prefs.set (the same module main.js loaded).
    prefs: ({ patch }) => { require(path.join(SRC, "prefs.js")).set(patch); return true; },
    info: () => ({ pid: process.pid, userData: app.getPath("userData"), home: os.homedir(), version: app.getVersion(), hooked: shell.openExternal.constructor.name,
      bounds: manager().getContentBounds(), visible: manager().isVisible(), focused: manager().isFocused() }),
    quit: () => { setImmediate(() => app.quit()); return true; }
  };
  process.on("message", async m => {
    try { process.send({ id: m.id, ok: true, result: await commands[m.cmd](m.args || {}) }); }
    catch (e) { try { process.send({ id: m.id, ok: false, error: String(e?.message || e) }); } catch {} }
  });
  // The driver went away: so does the app.
  process.on("disconnect", () => app.quit());
  app.on("browser-window-created", (_e, win) => {
    win.webContents.on("did-finish-load", () => { if (isManager(win)) try { process.send({ event: "loaded" }); } catch {} });
    win.webContents.on("console-message", (_ev, level, message) => { if (level >= 3) try { process.send({ event: "pageError", message }); } catch {} });
  });
  return;
}

// ===================================================== the driver =====================================================
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createLaunch } = require("../src/host/launch");
const { equipTerminals, terminalEvents } = require("../src/host");
const { HostError } = require("../src/host/errors");
const { normPath } = require("../src/shared/util");

const WIN = process.platform === "win32";
const VERBOSE = Boolean(process.env.PORTS_E2E_VERBOSE);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-ports-e2e-"));
const NEEDLE = path.basename(root); // in the command line of every process this test starts, and of no other
const profile = path.join(root, "profile"), home = path.join(root, "home");
const hProject = path.join(root, "work", "shop-api"), localProject = path.join(root, "work", "local-notes");
const shots = path.resolve(process.env.PORTS_E2E_SHOTS || path.join(ROOT, ".tmp", "ports-e2e"));
for (const dir of [profile, home, hProject, localProject, shots]) fs.mkdirSync(dir, { recursive: true });

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
const notes = []; // what the report at the end lists: behaviour seen, oddities
const note = line => { notes.push(line); };
// A product bug this run showed: listed at the end (once each), and failing the run with PORTS_E2E_STRICT=1 - so the
// steps after it are still seen.
const bugs = new Map();
const bug = (id, line) => { if (!bugs.has(id)) bugs.set(id, line); };

// ---------- TCP and HTTP on this machine ----------
const PAD = crypto.randomBytes(150 * 1024).toString("hex"); // 300 KB: more than one stream window (256 KB)
const pageOf = (name, big = false) => `<!doctype html><title>${name}</title><h1>${name}</h1>${big ? `<!--${PAD}-->` : ""}`;
const serve = (name, host, big = false, port = 0) => new Promise((resolve, reject) => {
  const server = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end(pageOf(name, big)); });
  server.once("error", reject);
  server.listen(port, host, () => resolve(server));
});
// The service is gone: nothing listens on its port any more (connections kept alive are dropped).
const unserve = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
// -> { status, body } or { error: code }
const get = (host, port) => new Promise(resolve => {
  const req = http.get({ host, port, path: "/", agent: false, timeout: 15000, headers: { host: `localhost:${port}` } }, res => {
    const parts = [];
    res.on("data", d => parts.push(d));
    res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    res.on("error", e => resolve({ error: e.code || e.message }));
  });
  req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
  req.on("error", e => resolve({ error: e.code || e.message }));
});
// "open" when a TCP connection is accepted, else the error's code.
const knock = (host, port) => new Promise(resolve => {
  const s = net.connect({ host, port });
  s.once("connect", () => { s.destroy(); resolve("open"); });
  s.once("error", e => resolve(e.code));
  s.setTimeout(3000, () => { s.destroy(); resolve("TIMEOUT"); });
});
// A port nothing listens on (it was free a moment ago), on both loopbacks.
async function deadPort() {
  for (;;) {
    const s = net.createServer();
    await new Promise(r => s.listen(0, "127.0.0.1", r));
    const { port } = s.address();
    await new Promise(r => s.close(r));
    if ((await knock("::1", port)) !== "open") return port;
  }
}

// ---------- the processes of this test ----------
// Every process whose command line names this test's folder: Electron's (--user-data-dir), the terminals' (their cwd).
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
function node(name, { kind = "desktop", relayOnly = false, api = async () => null, dir = path.join(root, "nodes", name) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0, name, discoverable: false }));
  return createLinks({ dir, defaultName: name, kind, version: VERSION, api, relayOnly, discover: false, listen: "127.0.0.1", log: () => {} });
}
// What a desktop serves: real terminals, equipped as host/index.js equips them, and one project.
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
  return Object.assign(host, { git: { get: () => ({}), refresh: async () => {} }, setup: {}, sessions, home: path.join(root, "work"), sendText: {}, findTranscript: () => "", preview: () => null });
}
// A computer with an AgentDeck from before forwarded ports: it shares one terminal, its host.info has no `ports`.
const OLD_TERM = crypto.randomUUID();
const oldApi = method => {
  const tab = { id: OLD_TERM, cwd: "/srv/legacy", title: "bash", agent: "", sessionId: "", exited: false, createdAt: Date.now() - 60000, owner: "", ownerName: "", reopened: false, viewers: [], driver: null };
  if (method === "host.info") return { name: "OLD-BOX", kind: "desktop", platform: "linux", home: "/home/dev", agents: [], terminals: 2 };
  if (method === "sessions.list") return { registry: { projects: [{ name: "legacy", path: "/srv/legacy" }] }, sessions: [], agents: [] };
  if (method === "live.list") return [];
  if (method === "git.status") return {};
  if (method === "terminals.list") return [tab];
  if (method === "terminals.attach") return { scrollback: "dev@old-box:/srv/legacy$ ", end: 25, exitCode: null, cols: 80, rows: 24, driver: null };
  if (method === "terminals.detach") return true;
  throw new HostError("unknownMethod");
};

// ---------- the app ----------
// The page's side of the steps: what the menus and messages show, and where an element is.
const LIB = `(() => { if (window.__pt) return;
  const text = el => el.querySelector("span:not(.menu-check)");
  const rowsOf = menu => !menu ? null : [...menu.querySelectorAll(":scope > button[data-i], :scope > .menu-sep")].map(el => {
    if (el.matches(".menu-sep")) return { sep: true };
    const s = text(el);
    return { i: Number(el.dataset.i), label: s.textContent, disabled: el.disabled, role: el.getAttribute("role"), checked: el.getAttribute("aria-checked") === "true",
      flyout: el.getAttribute("aria-haspopup") === "menu", danger: el.classList.contains("danger"), cut: s.scrollWidth > s.clientWidth };
  });
  const pt = window.__pt = {
    pane: id => document.querySelector('#panes .pane[data-term="' + id + '"]'),
    portsBtn: id => pt.pane(id)?.querySelector('[data-ws="ports"]'),
    menu: () => document.querySelector(".menu.ports-menu"), sub: () => document.querySelector(".menu.menu-sub"),
    rows: () => rowsOf(pt.menu()), subRows: () => rowsOf(pt.sub()),
    row: (menu, i) => menu?.querySelector(':scope > button[data-i="' + i + '"]'),
    // The middle of an element (scrolled into view), and whether a click there lands on it.
    at: el => {
      if (!el) return null;
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = el.getBoundingClientRect(), x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, left: Math.floor(r.left), top: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height), hit: Boolean(hit && (hit === el || el.contains(hit))), over: hit ? hit.tagName.toLowerCase() + "." + String(hit.className?.baseVal ?? hit.className).trim() + " in " + (hit.closest("dialog, .menu, .toast-item, .pane")?.className || "the page") : "nothing", shown: Math.round(r.width) + "x" + Math.round(r.height) + " at " + Math.round(r.left) + "," + Math.round(r.top) + "; dialog open: " + Boolean(document.querySelector("dialog[open]")) + "; menus: " + document.querySelectorAll(".menu").length + "; focus: " + document.hasFocus() };
    },
    toasts: () => [...document.querySelectorAll("#toasts .toast-item:not(.out)")].map(el => { const s = el.querySelector(".toast-text"); return { text: el.dataset.text, error: el.classList.contains("error"), cut: s.scrollWidth > s.clientWidth }; }),
    button: id => { const b = pt.portsBtn(id); return b && { title: b.getAttribute("title") || b.dataset.tip || "", label: b.getAttribute("aria-label"), count: b.querySelector(".port-count")?.textContent ?? null, on: b.classList.contains("on"), counted: b.classList.contains("counted") }; },
    // How visible a pane's buttons are: the opacity of .pane-tools (terminals.css shows them on a hovered or focused pane).
    tools: id => { const p = pt.pane(id), tools = p.querySelector(".pane-tools"); return { opacity: getComputedStyle(tools).opacity, hovered: p.matches(":hover"), focused: p.classList.contains("focused") }; }
  };
})();`;
const electronEnv = () => {
  // Windows finds its known folders under the profile: Electron needs "appData" to be there.
  const roaming = path.join(home, "AppData", "Roaming"), local = path.join(home, "AppData", "Local");
  for (const dir of [roaming, local]) fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, AGENTDECK_USER_DATA: profile, PORTS_E2E_HOOK: "1", USERPROFILE: home, HOME: home, APPDATA: roaming, LOCALAPPDATA: local };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ASM_USER_DATA;
  // No agent of the user's is found or asked anything (the app reads Codex's limits through the `codex` on the PATH,
  // which knows the user's account wherever the home is): the system's own folders only, and no agent's variables.
  for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|OPENAI|ANTHROPIC|OPENCODE|GEMINI)/i.test(key)) delete env[key];
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === "path") || "PATH";
  const sys = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  env[pathKey] = WIN ? [path.join(sys, "System32"), sys, path.join(sys, "System32", "Wbem"), path.join(sys, "System32", "WindowsPowerShell", "v1.0")].join(";") : "/usr/local/bin:/usr/bin:/bin";
  return env;
};
// One run of the app. -> { send(cmd, args), ev(code), exited (a promise of its exit code), pid, output() }
async function startApp() {
  // The page keeps drawing while the window is behind others or without the focus: the test must not depend on what
  // else is on the user's screen.
  const flags = ["--disable-features=CalculateNativeWinOcclusion", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"];
  const child = spawn(require("electron"), [...flags, "-r", __filename, ROOT, `--ports-e2e=${NEEDLE}`], { cwd: ROOT, env: electronEnv(), stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: false });
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
  const exited = new Promise(resolve => child.once("exit", code => {
    for (const p of pending.values()) p.reject(new Error("the app exited"));
    resolve(code);
  }));
  const send = (cmd, args) => new Promise((resolve, reject) => {
    if (!child.connected) return void reject(new Error("the app is gone"));
    const id = ++seq;
    pending.set(id, { resolve, reject });
    child.send({ id, cmd, args });
  });
  const ev = code => send("eval", { code: `${LIB}\n${code}` });
  const app = { child, pid: child.pid, send, ev, exited, pageErrors, output: () => output, loads: () => loaded };
  // The page is there and has drawn: its scripts ran, the layout came.
  app.ready = async (before = 0) => {
    await until(() => loaded > before, "the manager window loads", 60000);
    await until(() => ev("document.readyState === 'complete' && typeof ws === 'object' && typeof openPortsMenu === 'function' && ui.loaded === true").catch(() => false), "the page is ready", 30000, 150);
  };
  await Promise.race([app.ready(), exited.then(code => { throw new Error(`the app exited at once (code ${code}):\n${output}`); })]);
  return app;
}

// ---------- the steps' tools (a: one run of the app) ----------
const tools = a => {
  const { ev, send } = a;
  const mouse = (...events) => send("mouse", { events });
  const move = (x, y) => mouse({ type: "mouseMove", x, y });
  // A real click in the middle of the element `expr` evaluates to; the pointer goes there first (hover, mouseenter).
  async function click(expr, what) {
    const at = await ev(`__pt.at(${expr})`);
    assert.ok(at, `${what}: the element is there`);
    assert.ok(at.hit, `${what}: a click in its middle lands on it (there: ${at.over}; the element: ${at.shown})`);
    await move(at.x, at.y);
    await sleep(60);
    await mouse({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 }, { type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(60);
    return at;
  }
  async function hover(expr, what) {
    const at = await ev(`__pt.at(${expr})`);
    assert.ok(at?.hit, `${what}: it can be pointed at`);
    await move(at.x, at.y);
    await sleep(80);
    return at;
  }
  const t = (key, vars = {}) => ev(`t(${JSON.stringify(key)}, ${JSON.stringify(vars)})`);
  const escape = async () => { await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`); await sleep(50); };
  const closeMenu = async () => { for (let i = 0; i < 3 && await ev("Boolean(__pt.menu())"); i++) await escape(); assert.equal(await ev("Boolean(__pt.menu())"), false, "the menu closes"); };
  // The Ports menu of a pane, opened with a click on its button: -> its rows once the list has come.
  async function openPorts(term) {
    await closeMenu();
    const loading = await t("term.ports.loading");
    await click(`__pt.portsBtn(${JSON.stringify(term)})`, "the Ports button");
    return until(async () => {
      const rows = await ev("__pt.rows()");
      return rows && rows.length && !(rows.length === 1 && rows[0].label === loading) ? rows : null;
    }, "the menu gets its rows");
  }
  const portOfRow = r => (r.sep ? null : Number(/^(\d+)/.exec(r.label)?.[1]) || null);
  const rowOf = (rows, port) => rows.find(r => portOfRow(r) === port);
  // A click on a port's own row (its action; the pointer reaching it opens its flyout too).
  async function clickRow(rows, port) {
    const row = rowOf(rows, port);
    assert.ok(row, `the menu has a row for port ${port}`);
    await click(`__pt.row(__pt.menu(), ${row.i})`, `the row of port ${port}`);
  }
  // The flyout of a port's row, opened as a pointer does: -> its rows.
  async function flyout(rows, port) {
    const row = rowOf(rows, port);
    assert.ok(row, `the menu has a row for port ${port}`);
    await hover(`__pt.row(__pt.menu(), ${row.i})`, `the row of port ${port}`);
    return until(() => ev("__pt.subRows()"), `the flyout of port ${port} opens`, 5000);
  }
  async function clickSub(sub, label) {
    const row = sub.find(r => r.label === label);
    assert.ok(row, `the flyout has "${label}" (it has: ${sub.map(r => r.label).join(" | ")})`);
    await click(`__pt.row(__pt.sub(), ${row.i})`, `"${label}"`);
  }
  const forwards = () => ev("window.terminals.getForwards()");
  const openedUrl = what => until(async () => (await send("opened"))[0], `${what}: the browser is asked to open an address`, 20000);
  const shot = async (name, rect) => {
    await sleep(200);
    const file = path.join(shots, `${name}.png`);
    await send("capture", { file, rect });
    return file;
  };
  const toastOf = text => until(async () => (await ev("__pt.toasts()")).find(x => x.text === text), `the message "${text}"`, 8000);
  // The language as Settings sets it: every page loads again.
  async function language(lang) {
    const before = a.loads();
    await send("prefs", { patch: { language: lang } });
    await a.ready(before);
    await until(() => ev(`I18N.language() === ${JSON.stringify(lang)}`).catch(() => false), `the page is in "${lang}"`, 10000);
  }
  return { mouse, move, click, hover, t, escape, closeMenu, openPorts, portOfRow, rowOf, clickRow, flyout, clickSub, forwards, openedUrl, shot, toastOf, language };
};

// ======================================================= the run =======================================================
const stops = [], started = []; // what to undo at the end; every Electron this test started
let app = null;
async function main() {
  // ---------- H's services ----------
  const svcA = await serve("svc-A (127.0.0.1, 300 KB)", "127.0.0.1", true);
  const svcB = await serve("svc-B (::1 only)", "::1").catch(() => null); // a machine without IPv6 has none
  stops.push(() => { svcA.close(); svcB?.close(); });
  const portA = svcA.address().port, portB = svcB?.address().port || 0;
  // The terminal's own service: a program run in a terminal of H, which says its port in a file.
  const ownJs = path.join(root, "own-service.js"), ownPortFile = path.join(root, "own-port.txt");
  fs.writeFileSync(ownJs, `const http = require("node:http");
const s = http.createServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>own</title><h1>the terminal's own service</h1>"); });
s.listen(0, "127.0.0.1", () => { require("node:fs").writeFileSync(process.argv[2], String(s.address().port)); console.log("dev server on http://localhost:" + s.address().port); });
`);

  // ---------- the nodes ----------
  const host = makeHost();
  const served = createServed({ host });
  const r = node("R", { kind: "host", relayOnly: true });
  const h = node("H-DEV-01", { api: (m, p, peer) => served.api(m, p, peer) });
  const old = node("OLD-BOX", { api: oldApi });
  const seed = node("PORTS-APP", { dir: path.join(profile, "node") });
  stops.push(() => [r, h, old].forEach(l => l.stop()));
  const R = (await r.start()).id, H = (await h.start()).id, OLD = (await old.start()).id;
  served.attach(h);
  const SELF = (await seed.start()).id;
  const paired = (a, b) => until(() => a.online(b), "the nodes link", 15000);
  // One pairing a second from one address (pair-guard.js); R makes a new code after each.
  for (const l of [seed, h, old]) {
    await l.pair("127.0.0.1", r.self().port, r.self().code);
    await paired(l, R);
    await sleep(1100);
  }
  // The app's node pairs with H and OLD end to end, through R - it never learns an address of theirs.
  for (const [l, id] of [[h, H], [old, OLD]]) {
    await until(() => seed.discovered().some(n => n.id === id), "the relay's route to the node", 15000);
    await seed.pair(id, 0, l.self().code);
    await paired(seed, id);
    assert.ok(seed.nodes().find(n => n.id === id).via.length >= 1, "paired through the relay");
  }
  seed.stop();
  await sleep(300);
  const peersFile = JSON.parse(fs.readFileSync(path.join(profile, "node", "peers.json"), "utf8")).peers;
  assert.deepEqual(peersFile.map(p => p.id).sort(), [R, H, OLD].sort(), "the app's node folder has its three peers");
  assert.equal(peersFile.find(p => p.id === H).address, "", "H has no address there: only the relay leads to it");
  // The profile: English, no edge handle, no notifications, no update checks.
  fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ ui: { language: "en", autoUpdate: false }, edgeHandle: { show: false }, notify: { on: false } }));

  // ---------- a terminal of H with a service of its own ----------
  const ownCmd = [process.execPath, ownJs, ownPortFile];
  const tH = await host.terminals.open({ cwd: hProject, commandLine: ownCmd.map(x => `"${x}"`).join(" "), argv: ownCmd, title: "npm run dev", owner: "", env: process.env });
  stops.push(async () => { for (const x of host.terminals.getTabs()) try { await host.terminals.close(x.id); } catch {} });
  const portOwn = Number(await until(() => { try { return fs.readFileSync(ownPortFile, "utf8"); } catch { return ""; } }, "the terminal's service listens"));
  say(`services of H: own ${portOwn} (in its terminal), svc-A ${portA} (127.0.0.1), svc-B ${portB || "- (no IPv6)"} (::1); mesh ports: R ${r.self().port}, H ${h.self().port}`);

  // =================================================== the first run ===================================================
  app = await startApp();
  let u = tools(app);
  const info = await app.send("info");
  assert.equal(path.resolve(info.userData), path.resolve(profile), "the app runs on the throwaway profile");
  assert.equal(path.resolve(info.home), path.resolve(home), "and on the throwaway home");
  assert.equal(info.hooked, "AsyncFunction", "shell.openExternal is the hook's: no browser window opens");
  say(`the app runs: pid ${info.pid}, version ${info.version}, window ${info.bounds.width}x${info.bounds.height}, visible ${info.visible}, focused ${info.focused}`);

  // ---------- the computers: H through the relay ----------
  const nodesOf = () => app.ev("window.manager.getNodes()");
  const seen = await until(async () => {
    const nodes = await nodesOf(), x = nodes.find(n => n.id === H), o = nodes.find(n => n.id === OLD);
    return x?.status === "online" && x.info?.ports === 1 && o?.status === "online" && o.info ? nodes : null;
  }, "the app is linked with H and OLD and has read their host.info", 40000, 200);
  const nH = seen.find(n => n.id === H), nR = seen.find(n => n.id === R);
  assert.equal(nR.status, "online");
  assert.equal(nR.relayOnly, true, "R is a relay only");
  assert.deepEqual(nH.via, [R], "the app reaches H through R, not directly");
  assert.deepEqual(seen.find(n => n.id === OLD).via, [R]);
  assert.equal(nH.name, "H-DEV-01");
  assert.equal(seen.find(n => n.id === OLD).info.ports, undefined, "OLD says nothing of ports");

  // ---------- 1. the panes and their button ----------
  await app.ev(`window.manager.launchFolder(${JSON.stringify(localProject)})`);
  const wsOf = () => app.ev("window.terminals.getWorkspace()");
  const localKey = normPath(localProject);
  const tLocal = (await until(async () => (await wsOf()).terminals.find(x => x.node === "" && x.paned && normPath(x.cwd) === localKey), "a local terminal has a pane", 40000, 200)).id;
  const J = JSON.stringify;
  const en = {}; // the English texts, as the page's own t() gives them
  for (const key of ["title", "open", "openHttps", "copy", "stop", "other", "forget", "loading", "askTitle"]) en[key] = await u.t(`term.ports.${key}`);
  const paneThere = term => until(() => app.ev(`Boolean(__pt.portsBtn(${J(term)}))`), "the pane and its Ports button", 20000);
  await paneThere(tLocal);
  assert.deepEqual(await app.ev(`__pt.button(${J(tLocal)})`), { title: en.title, label: en.title, count: null, on: false, counted: false }, "a local terminal's pane has the Ports button, with no count");

  // H's terminal is listed under "Terminals" with no pane here; a click on its row brings it up in a tab of its project.
  const sideRow = term => `document.querySelector('#terms .agent.term[data-key="term:${term}"] .agent-title')`;
  await until(() => app.ev(`Boolean(${sideRow(tH)})`), "H's terminal is listed in the sidebar");
  assert.equal(await app.ev(`${sideRow(tH)}.textContent`), "npm run dev");
  await u.click(sideRow(tH), "H's terminal in the sidebar");
  await paneThere(tH);
  const panesOf = n => (!n ? [] : n.term ? [n.term] : [...panesOf(n.a), ...panesOf(n.b)]);
  const tabOf = async term => Object.values((await wsOf()).tabs).find(tab => panesOf(tab.root).includes(term));
  const hSpace = (await tabOf(tH)).space;
  assert.equal(hSpace, `node:${H}:${normPath(hProject)}`, "the pane is in the space of H's project");
  assert.deepEqual(await app.ev(`__pt.button(${J(tH)})`), { title: en.title, label: en.title, count: null, on: false, counted: false }, "the pane of H's terminal has the Ports button");
  await until(async () => (await app.ev(`__pt.pane(${J(tH)}).textContent`)).includes("dev server on http://localhost:"), "the terminal's output is drawn in its pane", 20000, 200);
  assert.deepEqual(await u.forwards(), [], "nothing is forwarded yet");

  // ---------- 2. the menu: "Loading…", then what listens on H ----------
  // The click and the look at the menu in one turn of the page: the list has not come yet.
  const first = await app.ev(`(() => { __pt.portsBtn(${J(tH)}).click(); return __pt.rows(); })()`);
  assert.deepEqual(first.map(x => [x.label, x.disabled]), [[en.loading, true]], 'the menu opens at once with "Loading…"');
  const filled = () => until(async () => { const rows = await app.ev("__pt.rows()"); return rows && rows[0]?.label !== en.loading ? rows : null; }, "the list comes");
  let rows = await filled();
  // The menu's groups, "Other port…" taken to the end for the checks below. On the screen it comes before the rest of
  // the computer's ports (dozens on a Windows machine): right after the terminal's own and the remembered ones.
  const groupsOf = list => {
    const g = list.reduce((all, x) => { if (x.sep) all.push([]); else all.at(-1).push(x); return all; }, [[]]);
    const i = g.findIndex(x => x.length === 1 && x[0].label === en.other);
    assert.ok(i < 0 || i < g.length - 1 || g.length === 1, '"Other port…" is above the rest of the ports');
    return i < 0 ? g : [...g.slice(0, i), ...g.slice(i + 1), g[i]];
  };
  let groups = groupsOf(rows);
  say(`the menu of H's terminal: ${rows.filter(x => !x.sep).length} rows in ${groups.length} groups; first rows: ${rows.slice(0, 6).map(x => (x.sep ? "---" : x.label)).join(" | ")}`);
  assert.equal(groups.length, 3, "the terminal's own ports, the others, Other port…");
  assert.equal(groups[0].length, 1, "one port is the terminal's own");
  assert.match(groups[0][0].label, new RegExp(`^${portOwn} · node(\\.exe)?$`, "i"), "the terminal's own port comes first, with its process");
  const restPorts = groups[1].map(u.portOfRow);
  assert.deepEqual(restPorts, [...restPorts].sort((x, y) => x - y), "the other ports by number");
  assert.match(u.rowOf(rows, portA).label, new RegExp(`^${portA} · node(\\.exe)?$`, "i"), "svc-A is listed with its process");
  if (portB) assert.match(u.rowOf(rows, portB).label, new RegExp(`^${portB} · node(\\.exe)?$`, "i"), "svc-B (on ::1 only) is listed");
  assert.ok(groups[1].includes(u.rowOf(rows, portA)), "svc-A is not the terminal's own");
  for (const x of [...groups[0], ...groups[1]]) assert.deepEqual([x.role, x.checked, x.flyout, x.disabled], ["menuitemcheckbox", false, true, false], `${x.label}: a row to tick, with a flyout`);
  assert.deepEqual(groups[2].map(x => [x.label, x.role, x.flyout]), [[en.other, "menuitem", false]]);
  assert.deepEqual(rows.filter(x => x.cut).map(x => x.label), [], "no row's text is cut off while nothing is forwarded");
  // Where the list lands: a long one does not fit under the button and is put over it (renderer.js placeGroupMenu).
  const geo = await app.ev(`(() => { const m = __pt.menu().getBoundingClientRect(), b = __pt.portsBtn(${J(tH)}).getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    const under = document.elementFromPoint(x, y)?.closest(".menu button[data-i]");
    return { menuTop: Math.round(m.top), menuHeight: Math.round(m.height), window: innerHeight, scrolls: __pt.menu().scrollHeight > __pt.menu().clientHeight, buttonY: Math.round(y), rowOverButton: under ? under.querySelector("span").textContent : "" }; })()`);
  if (geo.rowOverButton) note(`ODDITY: with ${rows.filter(x => !x.sep).length} rows the menu does not fit below the button: it is placed over it (top ${geo.menuTop}px, ${geo.menuHeight}px high in a ${geo.window}px window, scrolling: ${geo.scrolls}), so once the list replaces "Loading…" the row "${geo.rowOverButton}" lies under the pointer that clicked the button - its flyout opens by itself, and a second click there (a double click on the button) opens that port.`);
  const processes = [...new Set(groups[1].map(x => x.label.split(" · ")[1] || "(no name)"))];
  say(`process names in the list: ${processes.slice(0, 12).join(", ")}${processes.length > 12 ? ", …" : ""}`);
  if (u.rowOf(rows, h.self().port)) note(`ODDITY: H's own mesh port (${h.self().port}) is a row of its menu ("${u.rowOf(rows, h.self().port).label}"), though H refuses to forward it (port-streams.js notAllowed).`);
  await u.shot("menu-en");

  // ---------- 3. a row: forwarded, and opened in the browser ----------
  const urlPort = (url, scheme = "http") => { const m = new RegExp(`^${scheme}://localhost:(\\d+)$`).exec(url); assert.ok(m, `${url} is ${scheme}://localhost:<port>`); return Number(m[1]); };
  const page = { A: pageOf("svc-A (127.0.0.1, 300 KB)", true), B: pageOf("svc-B (::1 only)"), own: "<!doctype html><title>own</title><h1>the terminal's own service</h1>" };
  // GET through both of a forward's listeners: the service's page, whole.
  async function through(local, want, what) {
    for (const hostName of ["127.0.0.1", "::1"]) {
      const got = await get(hostName, local);
      assert.equal(got.error, undefined, `${what} through ${hostName}:${local}: ${got.error}`);
      assert.equal(got.status, 200);
      assert.equal(got.body.length, want.length, `${what} through ${hostName}: the whole page`);
      assert.equal(got.body, want, `${what} through ${hostName}: the service's page`);
    }
  }
  await u.clickRow(rows, portA);
  const LA = urlPort(await u.openedUrl("svc-A"));
  assert.equal(await app.ev("Boolean(__pt.menu())"), false, "the menu closed with the click");
  assert.notEqual(LA, portA, "svc-A answers on this machine too (H is this machine): the forward listens on another number");
  assert.deepEqual(await u.forwards(), [{ node: H, port: portA, localPort: LA }], "the forward is there");
  await until(async () => (await app.ev(`__pt.button(${J(tH)})`)).count === "1", "the button counts one forward");
  assert.deepEqual(await app.ev(`__pt.button(${J(tH)})`), { title: await u.t("term.ports.active", { n: 1 }), label: await u.t("term.ports.active", { n: 1 }), count: "1", on: true, counted: true });

  // ---------- 4. the pages through the forwards ----------
  await through(LA, page.A, "svc-A (300 KB)");
  rows = await u.openPorts(tH);
  await u.clickRow(rows, portOwn);
  const LO = urlPort(await u.openedUrl("the terminal's own service"));
  await through(LO, page.own, "the terminal's own service");
  let LB = 0;
  if (portB) {
    rows = await u.openPorts(tH);
    await u.clickRow(rows, portB);
    LB = urlPort(await u.openedUrl("svc-B"));
    await through(LB, page.B, "svc-B (::1 only on H)");
  }
  const count = portB ? 3 : 2;
  assert.equal((await u.forwards()).length, count);
  await until(async () => (await app.ev(`__pt.button(${J(tH)})`)).count === String(count), `the button counts ${count}`);
  say(`forwards: svc-A ${portA} -> localhost:${LA}, own ${portOwn} -> localhost:${LO}${portB ? `, svc-B ${portB} -> localhost:${LB}` : ""}; pages fetched through 127.0.0.1 and ::1`);

  // ---------- 5. ticks, the flyout: https, copy, open ----------
  rows = await u.openPorts(tH);
  let rowA = u.rowOf(rows, portA);
  assert.match(rowA.label, new RegExp(`^${portA} → localhost:${LA} · node(\\.exe)?$`, "i"), "a forward in use shows its address here");
  assert.equal(rowA.checked, true, "and is ticked");
  assert.equal(groupsOf(rows)[0][0].checked, true, "the terminal's own port is still first, ticked");
  const cutRows = rows.filter(x => x.cut).map(x => x.label);
  if (cutRows.length) bug("row-cut", `CUT OFF: a forwarded row whose local port differs does not fit the menu (styles.css .menu max-width 280px; the text is ellipsized): ${cutRows.map(x => `"${x}"`).join(", ")} - the process name, or part of it, is not readable.`);
  let sub = await u.flyout(rows, portA);
  assert.deepEqual(sub.map(x => x.label), [en.open, en.openHttps, en.copy, en.stop], "the flyout of a forwarded port");
  assert.equal(sub.at(-1).danger, true);
  await u.shot("menu-en-forwarded-flyout");
  await u.clickSub(sub, en.openHttps);
  assert.equal(await u.openedUrl("Open as https"), `https://localhost:${LA}`, '"Open as https" opens the same forward as https');
  assert.equal((await u.forwards()).length, count, "no second forward for it");
  // Copy address: on the clipboard, which gets back what it held.
  rows = await u.openPorts(tH);
  sub = await u.flyout(rows, portA);
  const had = await app.send("clipKeep");
  try {
    await u.clickSub(sub, en.copy);
    await until(async () => (await app.send("clipRead")) === `http://localhost:${LA}`, "the address is on the clipboard", 8000);
    assert.equal(await app.ev("window.manager.readClipboardText()"), `http://localhost:${LA}`, "as the app itself reads it");
    assert.equal((await u.toastOf(await u.t("term.ports.copied", { address: `http://localhost:${LA}` }))).error, false);
  } finally { assert.equal(await app.send("clipRestore"), true, "the clipboard has its text back"); }
  say(`Copy address put http://localhost:${LA} on the clipboard (formats there before: ${had.formats.join(", ") || "none"}; put back)`);
  rows = await u.openPorts(tH);
  sub = await u.flyout(rows, portOwn);
  await u.clickSub(sub, en.open);
  assert.equal(await u.openedUrl("Open in browser"), `http://localhost:${LO}`, "the flyout's Open in browser uses the forward that is there");

  // ---------- 5. "Other port…" ----------
  const dialog = 'document.querySelector("dialog.port-ask")';
  const askOpen = async () => {
    const list = await u.openPorts(tH);
    await u.click(`__pt.row(__pt.menu(), ${list.find(x => x.label === en.other).i})`, "Other port…");
    await until(() => app.ev(`Boolean(${dialog}?.open)`), "the dialog opens", 5000);
  };
  const field = () => app.ev(`(() => { const d = ${dialog}; return { value: d.querySelector("input").value, okDisabled: d.querySelector("button[value=ok]").disabled, focused: document.activeElement === d.querySelector("input") }; })()`);
  const clear = () => app.ev(`(() => { const f = ${dialog}.querySelector("input"); f.focus(); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  // Typed as a keyboard does it; when the keys do not arrive (the window is not in front), the field is filled in.
  let typedByKeys = true;
  const type = async text => {
    await clear();
    await app.send("keys", { text });
    await sleep(120);
    if ((await field()).value === text.slice(0, 5)) return;
    typedByKeys = false;
    await app.ev(`(() => { const f = ${dialog}.querySelector("input"); f.value = ${J(text.slice(0, 5))}; f.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  };
  await askOpen();
  assert.deepEqual(await app.ev(`(() => { const d = ${dialog}; return [d.querySelector("h2").textContent, d.querySelector("p").textContent, ...[...d.querySelectorAll("button")].map(b => b.textContent)]; })()`),
    [en.askTitle, await u.t("term.ports.askBody", { name: "H-DEV-01" }), await u.t("common.cancel"), en.open], "the dialog's texts");
  assert.deepEqual(await field(), { value: "", okDisabled: true, focused: true }, "empty: nothing to open; the field has the focus");
  for (const bad of ["0", "70000", "65536", "abc", "12a", "-5", " "]) {
    await type(bad);
    assert.equal((await field()).okDisabled, true, `"${bad}" is refused`);
    await app.send("keys", { key: "Enter" });
    await sleep(80);
    assert.equal(await app.ev(`Boolean(${dialog}?.open)`), true, `Enter with "${bad}" keeps the dialog`);
  }
  await type("123456");
  assert.equal((await field()).value, "12345", "no more than five characters go in");
  await type("65535");
  assert.equal((await field()).okDisabled, false, "65535 is a port");
  assert.deepEqual(await app.send("opened"), [], "nothing was opened by the refused ones");
  // Cancel: nothing happens.
  await u.click(`${dialog}.querySelector("[data-cancel]")`, "Cancel");
  await until(async () => !(await app.ev(`Boolean(${dialog})`)), "the dialog goes");
  await sleep(200);
  assert.deepEqual(await app.send("opened"), [], "Cancel opens nothing");
  assert.equal(fs.existsSync(path.join(profile, "ports.json")), false, "and remembers nothing");
  // A port nobody listens on, on H or here: H is asked before anything is made here (main.js portAddress), so the
  // window says so - and no browser opens, nothing is forwarded, nothing is remembered.
  const DEAD = await deadPort();
  const refusedText = await u.t("errors.refused");
  // The message "nothing listens there", an error one; closed with its X, so that the next one is a new message.
  const refused = async (what, shotName = "") => {
    const msg = await u.toastOf(refusedText);
    assert.equal(msg.error, true, `${what}: the message is an error`);
    if (msg.cut) bug("refused-cut", `CUT OFF: the message "${msg.text}" does not fit its toast.`);
    if (shotName) await u.shot(shotName);
    await sleep(300);
    assert.deepEqual(await app.send("opened"), [], `${what}: no browser opens`);
    await app.ev(`document.querySelector('#toasts .toast-item.error:not(.out) [data-toast="close"]').click()`);
    await until(async () => !(await app.ev("__pt.toasts()")).some(x => x.text === refusedText), "the message closes", 5000);
  };
  const savedFile = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, "ports.json"), "utf8")); } catch { return null; } };
  const savedIs = want => until(() => { const f = savedFile(); try { assert.deepEqual(f, want); return true; } catch { return false; } }, `ports.json becomes ${J(want)} (it is ${J(savedFile())})`, 8000);
  await askOpen();
  await type(String(DEAD));
  assert.equal((await field()).okDisabled, false);
  await u.shot("dialog-other-port-en");
  await u.click(`${dialog}.querySelector("button[value=ok]")`, "the dialog's Open in browser");
  await refused("a dead port typed by hand", "toast-dead-port-en");
  assert.equal((await u.forwards()).some(f => f.port === DEAD), false, "no forward is made for it");
  assert.deepEqual([await knock("127.0.0.1", DEAD), await knock("::1", DEAD)], ["ECONNREFUSED", "ECONNREFUSED"], "and nothing listens here for it");
  assert.equal(fs.existsSync(path.join(profile, "ports.json")), false, "it is not remembered");
  rows = await u.openPorts(tH);
  assert.equal(u.rowOf(rows, DEAD), undefined, "it has no row in the menu");
  // Copy address of it (the page's own call: the menu has no row for it): the same refusal, nothing forwarded.
  const copyDead = await app.ev(`window.terminals.copyPort(${J(tH)}, ${DEAD}).then(() => "", e => getErrorText(e.message))`);
  assert.equal(copyDead, refusedText, "Copy address of a dead port is refused with the same words");
  assert.equal((await u.forwards()).some(f => f.port === DEAD), false);
  note(`A port nobody listens on (${DEAD}), typed by hand: the window says "${refusedText}"; no browser opens, no forward or listener is made, ports.json is not written.`);
  // Two services of H that are in no hurry to be found: their ports are typed by hand. (H is this machine, so each
  // answers here too and its forward listens on another number.) They can go away and come back on the same number.
  const hand = { D: await serve("svc-D (typed by hand)", "127.0.0.1"), D2: await serve("svc-D2 (typed by hand)", "127.0.0.1") };
  stops.push(() => { for (const s of Object.values(hand)) { s.closeAllConnections?.(); s.close(); } });
  const D = hand.D.address().port, D2 = hand.D2.address().port;
  await askOpen();
  await type(String(D));
  await u.click(`${dialog}.querySelector("button[value=ok]")`, "the dialog's Open in browser");
  const LD = urlPort(await u.openedUrl("a port typed by hand"));
  assert.deepEqual((await u.forwards()).filter(f => f.port === D), [{ node: H, port: D, localPort: LD }], "the port typed by hand is forwarded");
  await through(LD, pageOf("svc-D (typed by hand)"), "the port typed by hand");
  await savedIs({ version: 1, spaces: { [hSpace]: [D] } });
  // Enter opens a valid one; the newest is first in the file.
  await askOpen();
  await type(String(D2));
  await app.send("keys", { key: "Enter" });
  let LD2 = 0;
  const byEnter = await until(async () => (await app.send("opened"))[0], "Enter opens a valid port", 3000).catch(() => null);
  if (!byEnter) {
    note("The Enter key did not reach the dialog (the window was not in front): the button was clicked instead.");
    await u.click(`${dialog}.querySelector("button[value=ok]")`, "the dialog's Open in browser");
    LD2 = urlPort(await u.openedUrl("the second port typed by hand"));
  } else LD2 = urlPort(byEnter);
  assert.ok((await u.forwards()).some(f => f.node === H && f.port === D2 && f.localPort === LD2), "the second port typed by hand is forwarded");
  await savedIs({ version: 1, spaces: { [hSpace]: [D2, D] } });
  if (!typedByKeys) note("The keys typed into the dialog did not all arrive (the window was not in front): the field was filled in by script.");
  // Shown again, ticked while forwarded, with Forget.
  rows = await u.openPorts(tH);
  for (const [p, local] of [[D, LD], [D2, LD2]]) assert.deepEqual([u.rowOf(rows, p)?.checked, u.rowOf(rows, p)?.label.split(" · ")[0]], [true, `${p} → localhost:${local}`], `the remembered port ${p} has its row, ticked, with its address here`);
  sub = await u.flyout(rows, D);
  assert.deepEqual(sub.map(x => x.label), [en.open, en.openHttps, en.copy, en.stop, en.forget]);
  await u.shot("menu-en-remembered-flyout");
  await u.clickSub(sub, en.forget);
  await savedIs({ version: 1, spaces: { [hSpace]: [D2] } });
  rows = await u.openPorts(tH);
  assert.equal(u.rowOf(rows, D)?.checked, true, "forgotten, but still forwarded: its row stays, to be stopped");
  sub = await u.flyout(rows, D);
  assert.deepEqual(sub.map(x => x.label), [en.open, en.openHttps, en.copy, en.stop], "no Forget any more");

  // ---------- 6. Stop forwarding ----------
  await u.clickSub(sub, en.stop);
  await u.toastOf(await u.t("term.ports.stopped", { port: D }));
  assert.equal((await u.forwards()).some(f => f.port === D), false);
  assert.deepEqual([await knock("127.0.0.1", LD), await knock("::1", LD)], ["ECONNREFUSED", "ECONNREFUSED"], "its listeners are closed");
  await unserve(hand.D);
  rows = await u.openPorts(tH);
  assert.equal(u.rowOf(rows, D), undefined, "stopped, forgotten and its service gone: no row");
  // Remembered but not forwarded (and nothing listening): a group of its own below the listening ports.
  await u.clickSub(await u.flyout(rows, D2), en.stop);
  await u.toastOf(await u.t("term.ports.stopped", { port: D2 }));
  await unserve(hand.D2);
  rows = await u.openPorts(tH);
  groups = groupsOf(rows);
  assert.equal(groups.length, 4, "own, the remembered, the others, Other port…");
  assert.deepEqual(groups[1].map(x => [x.label, x.checked, x.role]), [[String(D2), false, "menuitemcheckbox"]], "the remembered port, unticked, without a process");
  sub = await u.flyout(rows, D2);
  assert.deepEqual(sub.map(x => x.label), [en.open, en.openHttps, en.copy, en.forget]);
  await u.shot("menu-en-remembered-port");
  // Its row while its service is away: refused in words, nothing forwarded - and it stays remembered.
  await u.clickRow(rows, D2);
  await refused("the row of a remembered port nobody listens on");
  assert.equal((await u.forwards()).some(f => f.port === D2), false, "no forward for a remembered port that is dead");
  assert.deepEqual(savedFile(), { version: 1, spaces: { [hSpace]: [D2] } }, "it stays remembered");
  // The service is back on the same number: the same row forwards it again.
  hand.D2 = await serve("svc-D2 (typed by hand)", "127.0.0.1", false, D2);
  rows = await u.openPorts(tH);
  await u.clickRow(rows, D2);
  LD2 = urlPort(await u.openedUrl("the remembered port's row"));
  await through(LD2, pageOf("svc-D2 (typed by hand)"), "the remembered port, its service back");
  await savedIs({ version: 1, spaces: { [hSpace]: [D2] } });
  rows = await u.openPorts(tH);
  sub = await u.flyout(rows, portA);
  await u.clickSub(sub, en.stop);
  await u.toastOf(await u.t("term.ports.stopped", { port: portA }));
  assert.deepEqual((await u.forwards()).map(f => f.port).sort(), [portOwn, ...(portB ? [portB] : []), D2].sort(), "svc-A's forward is gone, the others stay");
  assert.deepEqual([await knock("127.0.0.1", LA), await knock("::1", LA)], ["ECONNREFUSED", "ECONNREFUSED"], "its listeners are closed");
  await until(async () => (await app.ev(`__pt.button(${J(tH)})`)).count === String(count), "the button counts one less (and the remembered one)");
  await through(LO, page.own, "the terminal's own service, after another forward stopped");
  rows = await u.openPorts(tH);
  assert.equal(u.rowOf(rows, portA).checked, false, "svc-A's row is unticked again");
  assert.match(u.rowOf(rows, portA).label, new RegExp(`^${portA} · node(\\.exe)?$`, "i"));
  await u.closeMenu();

  // H's own mesh port: listed (the oddity above) - what a click does.
  if (u.rowOf(rows, h.self().port)) {
    rows = await u.openPorts(tH);
    await u.clickRow(rows, h.self().port);
    assert.equal((await u.toastOf(await u.t("errors.notAllowed"))).error, true, "H does not forward its mesh port, and the window says so");
    assert.deepEqual(await app.send("opened"), [], "no browser opens for it");
    assert.equal((await u.forwards()).some(f => f.port === h.self().port), false, "and no forward is made");
  }

  // ---------- 6. when the count shows: two panes in one tab ----------
  // X hides H's pane (the terminal and the forwards go on); it then opens beside the local pane, as a row dropped there.
  await u.click(`__pt.pane(${J(tH)}).querySelector('[data-ws="close-pane"]')`, "the pane's X");
  await until(async () => !(await app.ev(`Boolean(__pt.pane(${J(tH)}))`)), "the pane is hidden");
  assert.equal((await u.forwards()).length, count, "hiding the pane stops no forward");
  await through(LO, page.own, "the terminal's own service, its pane hidden");
  await u.click(sideRow(tLocal), "the local terminal in the sidebar");
  await paneThere(tLocal);
  await app.ev(`window.terminals.command("open-term", { term: ${J(tH)}, place: "right", at: ${J(tLocal)} })`);
  await paneThere(tH);
  await sleep(400);
  const state = async () => ({ H: await app.ev(`__pt.tools(${J(tH)})`), local: await app.ev(`__pt.tools(${J(tLocal)})`) });
  // The pointer over H's pane, which has the focus.
  await u.hover(`__pt.pane(${J(tH)}).querySelector(".pane-head")`, "H's pane header");
  await sleep(400);
  const seenHover = await state();
  const head = await app.ev(`__pt.at(__pt.pane(${J(tH)}).querySelector(".pane-head"))`);
  const headRect = { x: head.left, y: head.top, width: head.width, height: head.height + 6 };
  await u.shot("pane-header-badge-hovered", headRect);
  // The focus and the pointer on the local pane: H's pane is neither focused nor pointed at.
  await u.click(`__pt.pane(${J(tLocal)}).querySelector(".pane-info")`, "the local pane's header");
  await until(async () => (await app.ev(`__pt.tools(${J(tLocal)})`)).focused, "the local pane has the focus");
  await sleep(500);
  const seenAway = await state();
  await u.shot("pane-header-badge-not-hovered-not-focused", headRect);
  const both = await app.ev(`__pt.at(document.querySelector("#panes"))`);
  await u.shot("panes-local-focused-H-not", { x: both.left, y: both.top, width: both.width, height: 60 });
  // The focus on H's pane, the pointer on the local one.
  await u.click(`__pt.pane(${J(tH)}).querySelector(".pane-info")`, "H's pane header");
  await until(async () => (await app.ev(`__pt.tools(${J(tH)})`)).focused, "H's pane has the focus");
  await u.hover(`__pt.pane(${J(tLocal)}).querySelector(".pane-info")`, "the local pane's header");
  await sleep(500);
  const seenFocus = await state();
  assert.deepEqual([(await app.ev(`__pt.button(${J(tH)})`)).count, (await app.ev(`__pt.button(${J(tLocal)})`)).count], [String(count), null], "H's button counts its forwards; a local pane's never has a count");
  note(`The count on the Ports button (opacity of .pane-tools; 1 = shown): pane hovered and focused ${seenHover.H.opacity}; neither hovered nor focused ${seenAway.H.opacity}; focused but not hovered ${seenFocus.H.opacity}. The local pane meanwhile: ${seenHover.local.opacity} / ${seenAway.local.opacity} / ${seenFocus.local.opacity}.`);
  assert.equal(seenHover.H.opacity, "1", "the buttons of a hovered pane show");
  assert.equal(seenFocus.H.opacity, "1", "the buttons of the focused pane show");

  // ---------- 1. a local terminal's menu: the same list, opened without a forward ----------
  rows = await u.openPorts(tLocal);
  groups = groupsOf(rows);
  const portRows = rows.filter(x => !x.sep && u.portOfRow(x));
  assert.ok(u.rowOf(rows, portA) && u.rowOf(rows, portOwn), "this computer's ports are listed for a local terminal");
  assert.deepEqual([...new Set(portRows.map(x => `${x.role}/${x.checked}`))], ["menuitem/false"], "no ticks on a local terminal's rows");
  assert.equal(groups.at(-1)[0].label, en.other);
  sub = await u.flyout(rows, portA);
  assert.deepEqual(sub.map(x => x.label), [en.open, en.openHttps, en.copy], "nothing to stop for a local port");
  await u.clickRow(rows, portA);
  assert.equal(await u.openedUrl("a local terminal's row"), `http://localhost:${portA}`, "a local terminal's port opens as it is");
  assert.equal((await u.forwards()).length, count, "with no forward");
  note(`A local terminal's pane: the same button; its menu lists this computer's ports (${portRows.length} rows, ${groups.length} groups, none marked as its own: ${groups.length === 2}), rows without ticks, the flyout without "Stop forwarding"; a click opens http://localhost:<the port itself>, nothing is forwarded and its button never shows a count.`);

  // ---------- 9. Bulgarian ----------
  const KEYS = { title: {}, active: { n: count }, open: {}, openHttps: {}, copy: {}, stop: {}, other: {}, forget: {}, loading: {}, empty: { name: "H-DEV-01" }, offline: { name: "H-DEV-01" },
    needsUpdate: { name: "OLD-BOX" }, failed: {}, copied: { address: `http://localhost:${LO}` }, stopped: { port: portOwn }, askTitle: {}, askBody: { name: "H-DEV-01" } };
  const dict = () => app.ev(`Object.fromEntries(${J(Object.entries(KEYS))}.map(([k, v]) => [k, t("term.ports." + k, v)]))`);
  const enDict = await dict();
  const bg = {}; // key -> { text, cut, how }
  const seenAs = (key, text, cut, how) => { bg[key] = { text, cut: Boolean(cut), how }; };
  await u.language("bg");
  const bgDict = await dict();
  await paneThere(tH);
  await sleep(500);
  let b = await app.ev(`__pt.button(${J(tH)})`);
  seenAs("active", b.label, false, "the button's tooltip, with forwards");
  seenAs("title", (await app.ev(`__pt.button(${J(tLocal)})`)).label, false, "the button's tooltip, without");
  const bgFirst = await app.ev(`(() => { __pt.portsBtn(${J(tH)}).click(); return __pt.rows(); })()`);
  seenAs("loading", bgFirst[0].label, bgFirst[0].cut, "the menu's first row");
  rows = await until(async () => { const list = await app.ev("__pt.rows()"); return list && list[0]?.label !== bgFirst[0].label ? list : null; }, "the list comes (bg)");
  const otherBg = rows.find(x => x.label === bgDict.other);
  assert.ok(otherBg, "Other port… is in the menu (bg)");
  seenAs("other", otherBg.label, otherBg.cut, "the menu's row for a port typed by hand");
  sub = await u.flyout(rows, D2);
  assert.equal(sub.length, 5, "the flyout of a remembered, forwarded port has all five rows");
  ["open", "openHttps", "copy", "stop", "forget"].forEach((key, i) => seenAs(key, sub[i].label, sub[i].cut, "the flyout"));
  await u.shot("menu-bg-flyout");
  // Copy, and its message.
  sub = await u.flyout(await u.openPorts(tH), portOwn);
  await app.send("clipKeep");
  try {
    await u.clickSub(sub, bg.copy.text);
    const msg = await until(async () => (await app.ev("__pt.toasts()")).find(x => x.text.includes(`localhost:${LO}`)), "the message after Copy (bg)", 8000);
    seenAs("copied", msg.text, msg.cut, "the message after Copy address");
    await u.shot("toast-copied-bg");
  } finally { await app.send("clipRestore"); }
  // The dialog.
  rows = await u.openPorts(tH);
  await u.click(`__pt.row(__pt.menu(), ${rows.find(x => x.label === bgDict.other).i})`, "Other port… (bg)");
  await until(() => app.ev(`Boolean(${dialog}?.open)`), "the dialog opens (bg)", 5000);
  const dlg = await app.ev(`(() => { const d = ${dialog}, cut = el => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1; const els = [d.querySelector("h2"), d.querySelector("p"), ...d.querySelectorAll("button")];
    return els.map(el => ({ text: el.textContent, cut: cut(el) })).concat({ text: "", cut: d.scrollWidth > d.clientWidth }); })()`);
  seenAs("askTitle", dlg[0].text, dlg[0].cut || dlg[4].cut, "the dialog's title");
  seenAs("askBody", dlg[1].text, dlg[1].cut, "the dialog's text");
  const dialogButtons = dlg.slice(2, 4).map(x => `${x.text}${x.cut ? " (CUT)" : ""}`);
  assert.equal(dlg[3].text, bg.open.text, "the dialog's button is the same text as the flyout's first row");
  await type("8080");
  await u.shot("dialog-other-port-bg");
  await u.click(`${dialog}.querySelector("[data-cancel]")`, "Cancel (bg)");
  await until(async () => !(await app.ev(`Boolean(${dialog})`)), "the dialog goes (bg)");
  // Stop forwarding, and its message.
  sub = await u.flyout(await u.openPorts(tH), portOwn);
  await u.clickSub(sub, bg.stop.text);
  const stoppedMsg = await until(async () => (await app.ev("__pt.toasts()")).find(x => x.text.includes(String(portOwn))), "the message after Stop forwarding (bg)", 8000);
  seenAs("stopped", stoppedMsg.text, stoppedMsg.cut, "the message after Stop forwarding");
  assert.deepEqual([await knock("127.0.0.1", LO), await knock("::1", LO)], ["ECONNREFUSED", "ECONNREFUSED"]);
  // The rows this machine cannot produce for real ("nothing listens", "could not be read"): the page's own
  // getPortsItems over an answer made up here, in the real menu.
  const made = async answer => {
    const list = await app.ev(`(() => { closeGroupMenu(); openMenu(__pt.portsBtn(${J(tH)}), "", getPortsItems(${J(tH)}, ${J(answer)}), "ports-menu"); return __pt.rows(); })()`);
    return list[0];
  };
  const base = { node: H, name: "H-DEV-01", ports: [], forwards: [], saved: [] };
  let x = await made(base);
  seenAs("empty", x.label, x.cut, "the menu, over a made-up empty answer");
  await u.shot("menu-bg-empty-made-up");
  x = await made({ ...base, error: "failed" });
  seenAs("failed", x.label, x.cut, "the menu, over a made-up failed answer");
  await u.closeMenu();
  await u.language("en");
  await paneThere(tH);

  // ---------- 8. quitting with forwards open ----------
  const atQuit = await u.forwards();
  assert.deepEqual(atQuit.map(f => f.port).sort(), [...(portB ? [portB] : []), D2].sort());
  if (LB) await through(LB, page.B, "svc-B, just before quitting");
  assert.deepEqual(app.pageErrors, [], "the page logged no error");
  const quitAt = Date.now();
  await app.send("quit");
  const code = await Promise.race([app.exited, sleep(20000).then(() => "still running")]);
  assert.equal(code, 0, "the app quits by itself");
  for (const f of atQuit) assert.deepEqual([await knock("127.0.0.1", f.localPort), await knock("::1", f.localPort)], ["ECONNREFUSED", "ECONNREFUSED"], `the listener of ${f.port} is closed`);
  let left = await until(async () => { const list = await ours(); return list.some(p => /electron/i.test(p.name)) ? null : list; }, "every Electron process of the app is gone", 15000, 500);
  say(`quit with ${atQuit.length} forward(s) open: exit code ${code} after ${Date.now() - quitAt} ms, the listeners refuse, no Electron process left; still running by design: ${left.map(p => p.name).join(", ") || "nothing"}`);
  await until(() => !h.online(SELF), "H sees the app's link go", 15000);
  // The remembered port's service goes away for the second run: the port is then listed as remembered only.
  await unserve(hand.D2);

  // ================================================== the second run ==================================================
  app = await startApp();
  u = tools(app);
  await until(async () => { const n = (await nodesOf()).find(y => y.id === H); return n?.status === "online" && n.info?.ports === 1; }, "the app is linked with H again", 40000, 200);
  // The layout came back with both panes; H's waits for its computer.
  await paneThere(tH);
  await paneThere(tLocal);
  assert.deepEqual(await u.forwards(), [], "a forward does not outlive the app");
  assert.equal((await app.ev(`__pt.button(${J(tH)})`)).count, null);
  // The port remembered before the restart: listed again, not forwarded.
  rows = await u.openPorts(tH);
  assert.deepEqual([u.rowOf(rows, D2)?.label, u.rowOf(rows, D2)?.checked], [String(D2), false], "the remembered port is listed after a restart, unticked");
  assert.equal(u.rowOf(rows, D), undefined, "the forgotten one is not");
  sub = await u.flyout(rows, D2);
  assert.deepEqual(sub.map(y => y.label), [en.open, en.openHttps, en.copy, en.forget]);
  await u.clickSub(sub, en.forget);
  await savedIs({ version: 1, spaces: {} });
  rows = await u.openPorts(tH);
  assert.equal(u.rowOf(rows, D2), undefined, "forgotten and not forwarded: gone from the menu");

  // ---------- 7. a computer too old to forward ----------
  await u.click(sideRow(OLD_TERM), "OLD-BOX's terminal in the sidebar");
  await paneThere(OLD_TERM);
  const oneRow = async term => {
    const list = await u.openPorts(term);
    assert.equal(list.length, 1, `one row: ${list.map(y => y.label).join(" | ")}`);
    assert.equal(list[0].disabled, true);
    return list[0];
  };
  x = await oneRow(OLD_TERM);
  assert.equal(x.label, enDict.needsUpdate, "a computer without `ports: 1` in its host.info: the menu says to update it");
  if (x.cut) bug("needsUpdate-cut-en", `CUT OFF (en): "${x.label}" does not fit the menu (max-width 280px) and ends in an ellipsis.`);
  await u.shot("menu-en-error-needs-update");
  await u.closeMenu();

  // ---------- 7. H goes away with a forward open ----------
  await u.click(sideRow(tH), "H's terminal in the sidebar");
  await paneThere(tH);
  rows = await u.openPorts(tH);
  await u.clickRow(rows, portA);
  const LA2 = urlPort(await u.openedUrl("svc-A again"));
  await through(LA2, page.A, "svc-A, in the second run");
  await until(async () => (await app.ev(`__pt.button(${J(tH)})`)).count === "1", "the button counts the forward");
  // A request under way when H stops: it ends, it does not hang.
  const slow = await new Promise((resolve, reject) => {
    const server = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.write("first part\n"); });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
  stops.push(() => { slow.closeAllConnections?.(); slow.close(); });
  await app.ev(`window.terminals.openPort(${J(tH)}, ${slow.address().port})`);
  const LS = urlPort(await u.openedUrl("a service that never finishes"));
  const hanging = get("127.0.0.1", LS);
  await sleep(500);
  h.stop();
  await until(async () => (await u.forwards()).length === 0, "the forwards go with H's link", 20000);
  const ended = await Promise.race([hanging, sleep(10000).then(() => ({ error: "STILL OPEN after 10 s" }))]);
  assert.ok(ended.error && !/STILL OPEN/.test(ended.error), `the request under way ended (${ended.error})`);
  assert.deepEqual([await knock("127.0.0.1", LA2), await knock("::1", LA2), await knock("127.0.0.1", LS)], ["ECONNREFUSED", "ECONNREFUSED", "ECONNREFUSED"], "the listeners are closed");
  await until(async () => (await app.ev(`__pt.button(${J(tH)})`)).count === null, "the count leaves the button");
  assert.equal((await nodesOf()).find(y => y.id === H).status, "offline");
  x = await oneRow(tH);
  assert.equal(x.label, enDict.offline, "H's menu says it is not connected - and offers nothing else");
  if (x.cut) bug("offline-cut-en", `CUT OFF (en): "${x.label}" does not fit the menu.`);
  await u.shot("menu-en-error-offline");
  await u.closeMenu();
  const paneNote = await app.ev(`__pt.pane(${J(tH)}).querySelector(".pane-note")?.textContent || ""`);
  note(`H stopped with two forwards open (one with a request under way): the forwards left the list and the button, the listeners refuse, the request ended with ${ended.error}; H's pane stays with the note "${paneNote}", its menu has the one row "${x.label}".`);
  // The same two rows in Bulgarian.
  await u.language("bg");
  await paneThere(tH);
  x = await oneRow(tH);
  seenAs("offline", x.label, x.cut, "the menu of H's terminal, H stopped");
  await u.shot("menu-bg-error-offline");
  await u.click(sideRow(OLD_TERM), "OLD-BOX's terminal in the sidebar (bg)");
  await paneThere(OLD_TERM);
  x = await oneRow(OLD_TERM);
  seenAs("needsUpdate", x.label, x.cut, "the menu of OLD-BOX's terminal");
  await u.shot("menu-bg-error-needs-update");
  await u.closeMenu();
  await u.language("en");

  // ---------- the Bulgarian texts, for proofreading ----------
  const problems = [];
  console.log("\n  term.ports.* as rendered in Bulgarian (key | text | where it was read | remarks):");
  for (const key of Object.keys(KEYS)) {
    const seenText = bg[key];
    assert.ok(seenText, `term.ports.${key} was rendered`);
    const remarks = [];
    if (seenText.text !== bgDict[key]) remarks.push(`differs from i18n.js: "${bgDict[key]}"`);
    if (seenText.text === enDict[key]) remarks.push("UNTRANSLATED (same as English)");
    if (seenText.text === `term.ports.${key}` || /\{\w+\}/.test(seenText.text)) remarks.push("NOT FILLED IN");
    if (seenText.cut) remarks.push("CUT OFF");
    if (remarks.length) problems.push(`term.ports.${key}: ${remarks.join("; ")}`);
    console.log(`    ${key.padEnd(12)}| ${seenText.text} | ${seenText.how}${remarks.length ? ` | ${remarks.join("; ")}` : ""}`);
  }
  console.log(`    (the dialog's buttons: ${dialogButtons.join(" / ")})`);
  for (const p of problems) bug(`bg:${p}`, `BULGARIAN: ${p}`);
  assert.deepEqual(problems.filter(p => /UNTRANSLATED|NOT FILLED IN|differs/.test(p)), [], "every text is translated and filled in");

  // ---------- 8. the end: nothing left behind ----------
  assert.deepEqual(app.pageErrors, [], "the page logged no error (second run)");
  // The app's own terminals outlive it by design (DockPty): stopped here, as "Stop" does.
  for (const term of (await wsOf()).terminals.filter(y => y.node === "" && !y.exited)) await app.ev(`window.terminals.stop(${J(term.id)})`);
  await until(async () => !(await wsOf()).terminals.some(y => y.node === ""), "the local terminals stopped", 15000, 200);
  await app.send("quit");
  assert.equal(await Promise.race([app.exited, sleep(20000).then(() => "still running")]), 0, "the app quits by itself (second run)");
  for (const y of host.terminals.getTabs()) await host.terminals.close(y.id);
  left = await until(async () => { const list = await ours(); return list.length ? null : list; }, "no process of this test is left", 20000, 500).catch(async () => ours());
  assert.deepEqual(left, [], "no process left behind");
  say("second quit: exit code 0; no process of the test is left (Electron, DockPty, shells, the terminal's service)");
}

async function cleanup() {
  if (app && app.child.exitCode === null && app.child.signalCode === null) { try { await app.send("quit"); } catch {} await Promise.race([app.exited, sleep(8000)]); }
  for (const child of started) if (child.exitCode === null && child.signalCode === null) await kill(child.pid);
  for (const stop of stops.reverse()) try { await stop(); } catch {}
  await sleep(300);
  // Whatever still names this test's folder is this test's (a terminal's DockPty outlives the app that opened it).
  for (const p of await ours()) await kill(p.pid);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch (e) { console.error(`could not remove ${root}: ${e.message}`); }
}
// The whole run has a limit: a step that hangs fails the test, and everything started is still taken down.
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
  if (notes.length) console.log(`\n  Seen on the way:\n${notes.map(n => `    - ${n}`).join("\n")}`);
  if (bugs.size) console.log(`\n  PRODUCT BUGS this run showed (${bugs.size}):\n${[...bugs.values()].map(n => `    - ${n}`).join("\n")}`);
  if (!error && bugs.size && process.env.PORTS_E2E_STRICT) { error = new Error(`${bugs.size} product bug(s) shown above (PORTS_E2E_STRICT)`); console.error(error.message); }
  if (!error) {
    console.log(`\n  screenshots: ${shots}`);
    console.log("ports in the real app: the button on local and remote panes, Loading… then H's ports (own first, through a relay), forward + browser address, pages through 127.0.0.1 and ::1, https, copy, Other port… (refusals, ports.json, forget), a dead port, Stop forwarding, the count, Bulgarian, quit, restart, a computer too old, H going away - passed" + (bugs.size ? `, with ${bugs.size} product bug(s) shown above (PORTS_E2E_STRICT=1 makes them fail the run)` : ""));
  }
  process.exit(error ? 1 : 0);
}
main().then(() => finish(), finish);
