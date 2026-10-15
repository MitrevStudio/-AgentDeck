const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu, globalShortcut } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
// Both have to be in place before anything below reads userData.
// Tests run a second, isolated instance against a throwaway profile (the single-instance lock is per profile too).
const testProfile = process.env.AGENTDECK_USER_DATA || process.env.ASM_USER_DATA;
// Kept from the app's former name: the saved API keys are encrypted with a key held in this profile's Local State,
// so the folder cannot move. Fresh installs get the default (%APPDATA%\AgentDeck).
const formerProfile = path.join(app.getPath("appData"), "ai-session-manager");
if (testProfile) app.setPath("userData", path.resolve(testProfile));
else if (fs.existsSync(formerProfile)) app.setPath("userData", formerProfile);
const { terminalEnv } = require("./terminal-env");
const { liveSessions } = require("./live");
const { createEdgeBar } = require("./edge-bar");
const { makeIcon } = require("./app-icon");
const prefs = require("./prefs");
const { t, tn, LANGUAGES } = require("./i18n");
const { keyLabel } = require("./voice/util");
const execFileAsync = promisify(execFile);

const USER = os.homedir();
const DATA = path.join(app.getPath("userData"), "registry.json");
const CLAUDE_DIR = path.join(USER, ".claude", "projects");
const CODEX_DIR = path.join(USER, ".codex", "sessions");

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
    return { projects: Array.isArray(data.projects) ? data.projects : [] };
  } catch { return { projects: [] }; }
}
function writeRegistry(data) {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2), "utf8");
}
function norm(p) { return path.resolve(p).replace(/\\/g, "/").toLowerCase(); }
function titleFromText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 110);
}
function walkFiles(dir, ext, out = [], depth = 0, skipDirs = []) {
  if (depth > 8 || out.length > 12000) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDirs.includes(e.name)) walkFiles(full, ext, out, depth + 1, skipDirs); }
    else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
  }
  return out;
}
function mtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return 0; } }
// Slash-command echoes, caveats and hook output are not something the user typed as a prompt.
const NOISE_PROMPT = /^\s*(<(local-command|command-|system-reminder|bash-|user-prompt-submit-hook)|Caveat:)/i;
function contentText(c) {
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter(v => v?.type === "text").map(v => v.text || "").join(" ") : "";
}
function parseClaude(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  const id = path.basename(file, ".jsonl");
  let cwd = "", prompt = "", aiTitle = "", customTitle = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    // Titles can be appended at any point (/rename, AI title refresh); everything else is only needed once.
    const titleLine = line.includes('"custom-title"') || line.includes('"ai-title"');
    if (!titleLine && cwd && prompt) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (x.type === "custom-title" && x.customTitle) customTitle = x.customTitle;
    if (x.type === "ai-title" && x.aiTitle) aiTitle = x.aiTitle;
    if (!cwd && typeof x.cwd === "string") cwd = x.cwd;
    if (!prompt && x.type === "user" && !x.isMeta && !x.isSidechain) {
      const text = contentText(x.message?.content);
      if (text.trim() && !NOISE_PROMPT.test(text)) prompt = titleFromText(text.replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, " "));
    }
  }
  const title = titleFromText(customTitle || aiTitle) || prompt || t("session.untitled", { agent: "Claude", id: id.slice(0, 8) });
  return { id, agent: "Claude", cwd, title, prompt: prompt !== title ? prompt : "", updatedAt: mtime(file), file };
}
function parseCodex(file) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch { return null; }
  let id = path.basename(file, ".jsonl"), cwd = "", title = "", updatedAt = 0;
  for (const line of lines.slice(0, 35)) {
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (x.type === "session_meta" && x.payload) {
      id = x.payload.id || id; cwd = x.payload.cwd || cwd;
    }
    const text = x.payload?.message || x.payload?.content?.map?.(c => c.text || "").join(" ") || "";
    if (!title && typeof text === "string" && text.trim() && !text.startsWith("#")) title = titleFromText(text);
    const at = x.timestamp || x.message?.timestamp;
    if (at) updatedAt = Math.max(updatedAt, new Date(at).getTime() || 0);
  }
  updatedAt = Math.max(updatedAt, mtime(file));
  return { id, agent: "Codex", cwd, title: title || t("session.untitled", { agent: "Codex", id: id.slice(0, 8) }), updatedAt, file };
}
// On Windows `opencode` is an npm .cmd shim, which execFile cannot start without going through cmd.exe.
function runOpenCode(args, cwd, timeout) {
  const opts = { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 };
  if (process.platform === "win32") return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "opencode", ...args], opts);
  return execFileAsync("opencode", args, opts);
}
function openCodeSession(s, cwd, projectName) {
  const id = s.id || s.sessionID;
  if (!id) return null;
  return {
    id, agent: "OpenCode", cwd, projectName,
    title: titleFromText(s.title || s.summary) || t("session.untitled", { agent: "OpenCode", id: id.slice(0, 8) }),
    updatedAt: Number(s.updated || s.time?.updated || s.updatedAt || 0)
  };
}
async function scanSessions() {
  const found = [];
  // OpenCode: query globally first, then use registered projects as a fallback.
  let registry = readRegistry();
  let openCodeFound = false, openCodeInstalled = false;
  try {
    const { stdout } = await runOpenCode(["session", "list", "--format", "json", "--max-count", "300"], USER, 12000);
    openCodeInstalled = true;
    let arr; try { arr = JSON.parse(stdout); } catch { arr = []; }
    if (!Array.isArray(arr)) arr = arr.sessions || arr.data || [];
    for (const raw of arr) {
      const s = openCodeSession(raw, raw.directory || raw.cwd || raw.path || "");
      if (s) { found.push(s); openCodeFound = true; }
    }
  } catch { /* CLI not installed, or CLI version differs */ }
  if (openCodeInstalled && !openCodeFound) {
    for (const project of registry.projects) {
      try {
        const { stdout } = await runOpenCode(["session", "list", "--format", "json", "--max-count", "200"], project.path, 10000);
        let arr; try { arr = JSON.parse(stdout); } catch { arr = []; }
        if (!Array.isArray(arr)) arr = arr.sessions || arr.data || [];
        for (const raw of arr) {
          const s = openCodeSession(raw, project.path, project.name);
          if (s) found.push(s);
        }
      } catch { /* project not available */ }
    }
  }
  // Claude Code transcripts. Subagent transcripts live in `subagents/` and cannot be resumed on their own.
  for (const f of walkFiles(CLAUDE_DIR, ".jsonl", [], 0, ["subagents"])) {
    const s = parseClaude(f);
    if (s) {
      const projectFolder = path.basename(path.dirname(f));
      const p = registry.projects.find(p => projectFolder === p.path.replace(/:/g, "-").replace(/\\/g, "-").replace(/\//g, "-") ||
        projectFolder.toLowerCase().includes(path.basename(p.path).toLowerCase()));
      if (!s.cwd && p) s.cwd = p.path;
      if (s.cwd || p) { s.cwd = s.cwd || p.path; s.projectName = p?.name; }
      found.push(s);
    }
  }
  // Codex transcripts.
  for (const f of walkFiles(CODEX_DIR, ".jsonl")) {
    const s = parseCodex(f);
    if (s) {
      const p = registry.projects.find(p => s.cwd && norm(p.path) === norm(s.cwd));
      if (p) s.projectName = p.name;
      found.push(s);
    }
  }
  // Auto-index projects that can be reliably resolved from local session metadata.
  registry = readRegistry();
  let changed = false;
  for (const s of found) {
    if (!s.cwd || !path.isAbsolute(s.cwd) || !fs.existsSync(s.cwd)) continue;
    try { if (!fs.statSync(s.cwd).isDirectory()) continue; } catch { continue; }
    let project = registry.projects.find(p => norm(p.path) === norm(s.cwd));
    if (!project) {
      project = { name: path.basename(s.cwd), path: path.resolve(s.cwd) };
      registry.projects.push(project); changed = true;
    }
    s.projectName = project.name;
  }
  if (changed) writeRegistry(registry);
  const seen = new Set();
  return found.filter(s => {
    const key = `${s.agent}:${s.id}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 1000);
}
function launchTerminal(cwd, command = null) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(t("errors.folderMissing"));
  // Pass fixed argument arrays to wt.exe. No user-supplied shell command is evaluated.
  const args = ["-w", "0", "new-tab", "-d", cwd];
  if (command) {
    args.push("powershell.exe", "-NoExit", "-Command", command);
  }
  const child = spawn("wt.exe", args, { detached: true, stdio: "ignore", windowsHide: true, env: terminalEnv() });
  child.on("error", err => console.error("Could not launch Windows Terminal:", err.message));
  child.unref();
}
function agentCommand(agent, id) {
  if (agent === "OpenCode") return ["opencode", "--session", id];
  if (agent === "Claude") return ["claude", "--resume", id];
  if (agent === "Codex") return ["codex", "resume", id];
  throw new Error(t("errors.unknownAgent"));
}
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function launchAgent(agent, id, cwd) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
    throw new Error(t("errors.sessionFolderUnknown"));
  const cmd = agentCommand(agent, id).map(psQuote).join(" ");
  launchTerminal(cwd, "& " + cmd);
}
const NEW_SESSION = { Claude: "claude", OpenCode: "opencode", Codex: "codex" };
function launchNew(agent, cwd) {
  if (!NEW_SESSION[agent]) throw new Error(t("errors.unknownAgent"));
  launchTerminal(cwd, "& " + psQuote(NEW_SESSION[agent]));
}
// Which agent CLIs are on PATH, so the menu only offers new sessions that can actually start.
const agentsReady = Promise.all(Object.entries(NEW_SESSION).map(([agent, exe]) => new Promise(resolve =>
  execFile("where.exe", [exe], { windowsHide: true, timeout: 5000 }, err => resolve(err ? null : agent))
))).then(list => list.filter(Boolean));

// ---------- shared data ----------
// The edge menu must open instantly, so the last scan is kept and pushed to the two windows that list sessions
// when it changes (the voice windows have no use for it).
let cache = null, scanning = null;
function broadcast(channel, payload) {
  for (const w of [managerWin, bar?.win]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}
function scan() {
  scanning ??= scanSessions().then(async sessions => {
    // Scan first: it auto-indexes projects into the registry, which must be read afterwards.
    cache = { registry: readRegistry(), sessions, agents: await agentsReady, at: Date.now() };
    broadcast("data:changed", cache);
    return cache;
  }).finally(() => { scanning = null; });
  return scanning;
}
function registryChanged(registry) {
  if (cache) { cache = { ...cache, registry }; broadcast("data:changed", cache); }
  return registry;
}

// ---------- windows ----------
const PRELOAD = path.join(__dirname, "preload.js");
// The first combination no other app has claimed wins (Ctrl+Alt+Space is often taken, e.g. by Claude Desktop).
// Nothing with Alt+Shift: that pair switches the keyboard layout on Windows.
const HOTKEYS = ["Alt+`", "Control+Alt+Space", "Control+Alt+Shift+Space"];
let hotkey = "";
const hotkeyLabel = () => keyLabel(hotkey, " + ");
let managerWin = null, bar = null, tray = null, trayHintShown = false, voice = null, voiceStarting = null;
// Quitting waits this long at most for voice to put an attempt in flight back to Pending and release its hotkeys.
const QUIT_GRACE_MS = 3000;
function showManager() {
  if (managerWin && !managerWin.isDestroyed()) {
    if (managerWin.isMinimized()) managerWin.restore();
    managerWin.show(); managerWin.focus();
    return;
  }
  managerWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 900, minHeight: 600,
    title: t("app.name"),
    backgroundColor: prefs.background(),
    autoHideMenuBar: true,
    icon: makeIcon(64),
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false }
  });
  managerWin.loadFile(path.join(__dirname, "index.html"));
  managerWin.on("closed", () => {
    managerWin = null;
    // The app keeps running for the edge menu; say so the first time the window goes away.
    if (!trayHintShown && tray) {
      trayHintShown = true;
      balloon(hotkey ? t("tray.background.bodyHotkey", { hotkey: hotkeyLabel() }) : t("tray.background.body"), { title: t("tray.background.title") });
    }
  });
}
// ---------- tray ----------
// Clicking a balloon about a failed recording retries it (balloons can be swallowed by Focus Assist, so the tray
// menu offers the same).
let balloonJobId = null, badged = null;
function balloon(content, { title = t("app.name"), iconType = "info", jobId = null } = {}) {
  if (!tray || tray.isDestroyed()) return;
  balloonJobId = jobId;
  const text = String(content);
  tray.displayBalloon({ title, iconType, content: text.length > 240 ? text.slice(0, 239) + "…" : text }); // Windows cuts it silently
}
function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const v = voice ? voice.trayMenu() : { failures: [], items: [], failureCount: 0 };
  const failed = v.failureCount;
  if (badged !== failed > 0) { badged = failed > 0; tray.setImage(makeIcon(32, 2, { badge: badged })); }
  tray.setToolTip(`${t("app.name")}${hotkey ? ` — ${hotkeyLabel()}` : ""}${failed ? ` · ${tn("tray.failed", failed)}` : ""}`);
  const sep = list => (list.length ? [...list, { type: "separator" }] : []);
  const p = prefs.get();
  const radio = (key, values, label) => values.map(value => ({
    label: label(value), type: "radio", checked: p[key] === value, click: () => prefs.set({ [key]: value })
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    ...sep(v.failures),
    { label: t("tray.openMenu"), accelerator: hotkey || undefined, click: () => bar.show("hotkey") },
    { label: t("common.openManager"), click: showManager },
    { type: "separator" },
    ...sep(v.items),
    { label: t("tray.hoverEdge"), type: "checkbox", checked: p.hoverEdge, click: item => prefs.set({ hoverEdge: item.checked }) },
    { label: t("tray.language"), submenu: radio("language", Object.keys(LANGUAGES), l => LANGUAGES[l]) },
    { label: t("tray.theme"), submenu: radio("theme", prefs.THEMES, th => t(`theme.${th}`)) },
    { label: t("tray.settings"), enabled: Boolean(voice), click: () => voice?.openSettings() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() }
  ]));
}

// ---------- IPC ----------
// Only the manager window and the edge menu may call these (not the voice windows, nor any other), and every
// argument is checked: they reach a shell, a terminal and the file system.
const trusted = e => [managerWin, bar?.win].some(w => w && !w.isDestroyed() && e.sender === w.webContents);
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error(t("errors.accessDenied"));
    return fn(...args);
  });
}
function text(v, max = 4096) {
  if (typeof v !== "string" || !v || v.length > max) throw new Error(t("errors.invalidData"));
  return v;
}
const isDir = p => { try { return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };
const SESSION_ID = /^[\w.:-]{1,200}$/;

function registerIpc() {
  handle("app:get-data", opts => (opts?.cached === true && cache ? cache : scan()));
  // A picker without defaultPath opens in Downloads (Electron 43+; the last folder is no longer remembered), so it
  // starts where the last project was picked, or else beside the most recently registered one.
  let pickedFrom = null;
  handle("project:add", async () => {
    const last = readRegistry().projects.at(-1)?.path;
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: pickedFrom ?? (last && path.dirname(last)) });
    if (result.canceled || !result.filePaths[0]) return readRegistry();
    const p = path.resolve(result.filePaths[0]);
    pickedFrom = path.dirname(p);
    const data = readRegistry();
    if (!data.projects.some(x => norm(x.path) === norm(p))) data.projects.push({ name: path.basename(p), path: p });
    writeRegistry(data); return registryChanged(data);
  });
  handle("project:remove", p => {
    text(p);
    const data = readRegistry(); data.projects = data.projects.filter(x => norm(x.path) !== norm(p)); writeRegistry(data); return registryChanged(data);
  });
  handle("project:rename", (p, name) => {
    text(p); text(name, 1000);
    const data = readRegistry(); const item = data.projects.find(x => norm(x.path) === norm(p));
    if (item && name.trim()) item.name = name.trim().slice(0, 80);
    writeRegistry(data); return registryChanged(data);
  });
  handle("launch:folder", p => { launchTerminal(text(p)); return true; });
  handle("launch:agent", (agent, id, cwd) => {
    if (!SESSION_ID.test(text(id))) throw new Error(t("errors.invalidSession"));
    launchAgent(text(agent), id, text(cwd));
    return true;
  });
  handle("launch:new", (agent, cwd) => { launchNew(text(agent), text(cwd)); return true; });
  // Folders only: shell.openPath() on a file runs it.
  handle("open:path", p => (isDir(p) ? shell.openPath(p) : t("errors.folderMissing")));
  handle("clipboard:write", async value => { await clipboard.writeText(text(value, 1_000_000)); return true; });
  handle("live:get", () => liveSessions());
  // A path typed into the menu's search: offer a new session there if it is an existing directory.
  handle("fs:is-dir", p => (isDir(p) ? path.resolve(p) : ""));
  handle("voice:open-history", () => { voice?.openHistory(); return Boolean(voice); });
  handle("voice:open-settings", () => { voice?.openSettings(); return Boolean(voice); });
  // Every page, voice ones included, reads the language and theme from its preload before it renders.
  ipcMain.on("prefs:get", e => { e.returnValue = prefs.get(); });
}

// ---------- preferences ----------
// A new language reloads every page (main's own strings follow at once); a new theme only swaps the page's tokens.
function onPrefsChanged(p, keys) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("prefs:changed", p);
  if (keys.includes("theme") && managerWin && !managerWin.isDestroyed()) managerWin.setBackgroundColor(prefs.background());
  if (keys.includes("language")) {
    cache = null; // fallback session titles are in the old language
    for (const w of [managerWin, bar?.win]) if (w && !w.isDestroyed()) w.webContents.reload();
  }
  buildTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showManager);
  app.whenReady().then(() => {
    prefs.load();
    prefs.on("changed", onPrefsChanged);
    registerIpc();

    bar = createEdgeBar({ preload: PRELOAD, hoverEnabled: () => prefs.get().hoverEdge, onOpenManager: showManager, hotkeyLabel });
    tray = new Tray(makeIcon(32, 2));
    hotkey = HOTKEYS.find(k => globalShortcut.register(k, () => bar.toggle())) || "";
    if (!hotkey) console.error(`None of the hotkeys is free: ${HOTKEYS.join(", ")}`);
    // Double-click would also fire this click, so recording is offered in the menu instead (VoiceTray: double-click).
    tray.on("click", () => bar.show("hotkey"));
    // Not reset on "balloon-closed": replacing a balloon can report the old one closed after the new one is up.
    tray.on("balloon-click", () => { const id = balloonJobId; balloonJobId = null; if (id) voice?.retry(id); });
    buildTrayMenu();

    showManager();
    scan().catch(err => console.error("Initial scan failed:", err.message));
    // Started once the windows are up: the first run copies VoiceTray's history first, and a voice part that cannot
    // start (native module, broken data) must not take the session manager down with it.
    voiceStarting = Promise.resolve()
      .then(() => require("./voice/controller").initVoice({
        balloon, onTrayChanged: buildTrayMenu, icon: makeIcon(64), prefs,
        general: { set: patch => prefs.set(patch), hotkey: () => ({ current: hotkeyLabel(), candidates: HOTKEYS.map(k => keyLabel(k, " + ")) }) }
      }))
      .then(v => { voice = v; buildTrayMenu(); }, e => console.error("Voice features could not start:", e));
  });
  // Gives an in-flight transcription a moment to settle back to Pending and frees the voice hotkeys first - briefly:
  // quitting must never hang on it.
  let quitting = false;
  app.on("before-quit", e => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    const shutdown = (async () => { await voiceStarting; await voice?.dispose(); })();
    Promise.race([shutdown, new Promise(r => setTimeout(r, QUIT_GRACE_MS))])
      .catch(err => console.error("Voice shutdown failed:", err))
      .finally(() => app.quit());
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  // The hidden edge menu keeps the app alive after the manager window is closed; quitting is done from the tray.
  app.on("window-all-closed", () => {});
}
