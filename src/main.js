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
const { liveSessions, findTranscript } = require("./live");
const { focusSession, allowForeground, terminalWindows, raiseNewTerminal } = require("./terminal-focus");
const { createLog } = require("./voice/log-file");
const promptLaunch = require("./prompt-launch");
const { createEdgeBar } = require("./edge-bar");
const { makeIcon } = require("./app-icon");
const prefs = require("./prefs");
const network = require("./network");
const updater = require("./updater");
const usage = require("./usage");
const sessionPreview = require("./session-preview");
const gitStatus = require("./git-status");
const autostart = require("./autostart");
const { t, tn, LANGUAGES } = require("./i18n");
const { keyLabel } = require("./voice/util");
const execFileAsync = promisify(execFile);

const USER = os.homedir();
const DATA = path.join(app.getPath("userData"), "registry.json");
const CLAUDE_DIR = path.join(USER, ".claude", "projects");
const CODEX_DIR = path.join(USER, ".codex", "sessions");
const OPENCODE_DB = path.join(process.env.XDG_DATA_HOME || path.join(USER, ".local", "share"), "opencode", "opencode.db");

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
// Slash-command echoes, caveats and hook output are not something the user typed as a prompt (the previews skip
// them too).
const { NOISE_PROMPT, contentText } = sessionPreview;
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
// On Windows `opencode` is usually an npm .cmd shim, which execFile cannot start without going through cmd.exe. The
// scan runs it in project folders, and cmd.exe looks in the current folder before PATH - for `opencode` and for the
// `node` the shim calls - so it is found on PATH once, by its full path, and cmd.exe is told to skip the folder.
const openCodeExe = process.platform === "win32" ? findOnPath("opencode") : Promise.resolve("opencode");
async function runOpenCode(args, cwd, timeout) {
  const exe = await openCodeExe;
  if (!exe) throw new Error("opencode is not on PATH");
  const opts = { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } };
  if (!/\.(cmd|bat)$/i.test(exe)) return execFileAsync(exe, args, opts);
  // /s: the outer quotes go, the rest is taken as typed (args are fixed words).
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${exe}" ${args.join(" ")}"`], { ...opts, windowsVerbatimArguments: true });
}
// The first `name` + PATHEXT extension in a PATH folder (never the current folder), or "".
async function findOnPath(name) {
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir.replace(/"/g, ""))) continue;
    for (const ext of exts) {
      const file = path.join(dir.replace(/"/g, ""), name + ext.toLowerCase());
      try { if ((await fs.promises.stat(file)).isFile()) return file; } catch {}
    }
  }
  return "";
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
// userData/logs/launch.log: every terminal AgentDeck opens and how it went (folder and command, never a prompt's text).
const writeLaunchLog = createLog("launch.log");
const launchLog = (...parts) => writeLaunchLog([new Date().toISOString(), ...parts].join(" "));
function spawnDetached(file, args, opts) {
  const child = spawn(file, args, { detached: true, stdio: "ignore", ...opts });
  child.unref();
  return new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
}
async function launchTerminal(cwd, command = null) {
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(t("errors.folderMissing"));
  // Pass fixed argument arrays to wt.exe. No user-supplied shell command is evaluated. "-w new" gives the session a
  // window of its own (Settings -> General); "-w 0" adds a tab to the last used window.
  const newWindow = prefs.get().newWindow;
  const args = ["-w", newWindow ? "new" : "0", "new-tab", "-d", cwd];
  if (command) {
    args.push("powershell.exe", "-NoExit", "-Command", command);
  }
  // AgentDeck's proxy too, when the user asked for it in Settings -> Network; a terminal opens without it otherwise.
  const proxy = await network.terminalProxy().catch(e => { console.error("Could not resolve the proxy for the terminal:", e.message); return null; });
  const env = terminalEnv(process.env, proxy);
  const what = `cwd="${cwd}" cmd=${command ? `"${command.slice(0, 120)}"` : "-"}`;
  const before = newWindow ? terminalWindows() : null;
  allowForeground();
  try {
    // Never windowsHide: Windows Terminal applies the launcher's "start hidden" to the window it opens for "-w new",
    // which then stayed invisible ("nothing happens"). wt.exe has no console of its own to flash.
    await spawnDetached("wt.exe", args, { windowsHide: false, env });
  } catch (err) {
    launchLog(`wt failed (${err.code || err.message})`, what);
    if (err.code !== "ENOENT") throw err;
    // No Windows Terminal (older Windows 10): a console window of its own instead of nothing at all.
    await spawnDetached("powershell.exe", ["-NoExit", ...(command ? ["-Command", command] : [])], { cwd, env, windowsHide: false });
    launchLog("console", what);
    return;
  }
  launchLog(`wt ${newWindow ? "window" : "tab"}`, what);
  if (before) {
    raiseNewTerminal(before)
      .then(r => launchLog(`new window ${r.found ? (r.front ? "in front" : "found, not in front") : "not seen within 4 s"}`))
      .catch(e => launchLog(`raising the new window failed: ${e.message}`));
  }
}
function agentCommand(agent, id) {
  if (agent === "OpenCode") return ["opencode", "--session", id];
  if (agent === "Claude") return ["claude", "--resume", id];
  if (agent === "Codex") return ["codex", "resume", id];
  throw new Error(t("errors.unknownAgent"));
}
const { psQuote } = promptLaunch;
const NEW_SESSION = { Claude: "claude", OpenCode: "opencode", Codex: "codex" };
// Every launcher checks its own arguments, whoever calls it (IPC, voice commands): an inherited key such as
// "constructor" is no agent, and a ";" in a session id would split wt.exe's command line.
const isAgent = agent => typeof agent === "string" && Object.hasOwn(NEW_SESSION, agent);
function checkAgent(agent) { if (!isAgent(agent)) throw new Error(t("errors.unknownAgent")); }
function checkSessionId(id) { if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error(t("errors.invalidSession")); }
function launchAgent(agent, id, cwd) {
  checkAgent(agent);
  checkSessionId(id);
  if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
    throw new Error(t("errors.sessionFolderUnknown"));
  const cmd = agentCommand(agent, id).map(psQuote).join(" ");
  return launchTerminal(cwd, "& " + cmd);
}
function launchNew(agent, cwd) {
  checkAgent(agent);
  return launchTerminal(cwd, "& " + psQuote(NEW_SESSION[agent]));
}
// A new session that starts on a prompt (voice commands): the prompt travels in a file, never on a command line. The
// terminal deletes the file once read; one whose terminal never started goes at once.
const PROMPTS_DIR = path.join(app.getPath("userData"), "prompts");
async function launchNewWithPrompt(agent, cwd, prompt) {
  checkAgent(agent);
  const file = promptLaunch.writePrompt(PROMPTS_DIR, prompt);
  try {
    await launchTerminal(cwd, promptLaunch.command(agent, NEW_SESSION[agent], file, t("voice.command.error.noLauncher", { exe: NEW_SESSION[agent] })));
  } catch (e) {
    promptLaunch.remove(file);
    promptLaunch.sweep(PROMPTS_DIR);
    throw e;
  }
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
    // Transcripts may have grown too, and there may be new folders: their results are broadcast on their own.
    usage.refresh().catch(err => console.error("Usage scan failed:", err.message));
    gitStatus.refresh().catch(err => console.error("Git status failed:", err.message));
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
      const handle = prefs.get().edgeHandle;
      const body = hotkey ? (handle ? "bodyHotkeyHandle" : "bodyHotkey") : (handle ? "bodyHandle" : "body");
      balloon(t(`tray.background.${body}`, { hotkey: hotkeyLabel() }), { title: t("tray.background.title") });
    }
  });
}
// ---------- tray ----------
// Clicking a balloon acts on it: one about a failed recording retries it, one about an update downloads or installs
// it. Balloons can be swallowed by Focus Assist, so the tray menu offers the same.
let balloonClick = null, badged = null;
function balloon(content, { title = t("app.name"), iconType = "info", jobId = null, onClick = null } = {}) {
  if (!tray || tray.isDestroyed()) return;
  balloonClick = jobId ? () => voice?.retry(jobId) : onClick;
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
    { label: t("tray.edgeHandle"), type: "checkbox", checked: p.edgeHandle, click: item => prefs.set({ edgeHandle: item.checked }) },
    { label: t("tray.language"), submenu: radio("language", Object.keys(LANGUAGES), l => LANGUAGES[l]) },
    { label: t("tray.theme"), submenu: radio("theme", prefs.THEMES, th => t(`theme.${th}`)) },
    { label: t("tray.settings"), enabled: Boolean(voice), click: () => voice?.openSettings() },
    updateMenuItem(),
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() }
  ]));
}

// ---------- updates ----------
// One tray item that follows the updater: check, download (automatic updates off), progress, restart to install.
function updateMenuItem() {
  const u = updater.state();
  const version = u.next;
  switch (u.status) {
    case "checking": return { label: t("tray.update.checking"), enabled: false };
    case "available": return { label: t("tray.update.download", { version }), click: () => updater.download() };
    case "downloading": return { label: t("tray.update.downloading", { version }), enabled: false };
    case "ready": return { label: t("tray.update.restart", { version }), click: () => updater.install() };
    default: return { label: t("tray.update.check"), enabled: u.supported, click: checkFromTray };
  }
}
// A version is announced once when it is found (automatic updates off) and once when it is ready to install;
// clicking the balloon downloads or installs it.
const announced = new Set();
function announce(u) {
  announced.add(`${u.status} ${u.next}`);
  if (u.status === "ready")
    balloon(t("tray.update.readyBody", { version: u.next }), { title: t("tray.update.readyTitle"), onClick: () => updater.install() });
  else balloon(t("tray.update.availableBody", { version: u.next }), { title: t("tray.update.foundTitle"), onClick: () => updater.download() });
}
let trayCheck = false;
function onUpdateChanged(u, prev) {
  if (u.status !== prev.status || u.next !== prev.next) buildTrayMenu();
  if ((u.status === "ready" || (u.status === "available" && !trayCheck)) && !announced.has(`${u.status} ${u.next}`)) announce(u);
}
// Asked for from the tray, so the answer comes as a balloon there, whatever it is.
async function checkFromTray() {
  trayCheck = true;
  const u = await updater.check().finally(() => { trayCheck = false; });
  if (u.status === "available") announce(u);
  else if (u.status === "downloading") balloon(t("tray.update.downloadingBody", { version: u.next }), { title: t("tray.update.foundTitle") });
  else if (u.status === "none") balloon(t("tray.update.latest", { version: u.version }));
  else if (u.status === "error")
    balloon(t(`settings.updates.error.${u.error.reason}`, { message: u.error.message }), { title: t("tray.update.failedTitle"), iconType: "warning" });
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
  handle("launch:folder", async p => { await launchTerminal(text(p)); return true; });
  handle("launch:agent", async (agent, id, cwd) => { await launchAgent(text(agent), text(id), text(cwd)); return true; });
  handle("launch:new", async (agent, cwd) => { await launchNew(text(agent), text(cwd)); return true; });
  // Folders only: shell.openPath() on a file runs it.
  handle("open:path", p => (isDir(p) ? shell.openPath(p) : t("errors.folderMissing")));
  handle("clipboard:write", async value => { await clipboard.writeText(text(value, 1_000_000)); return true; });
  handle("live:get", () => liveSessions());
  // Tokens and API-equivalent cost (usage.js): the last result at once, or a fresh pass over the transcripts.
  handle("usage:get", () => usage.get());
  // The figures themselves come as "usage:changed" when they changed; the answer only says when they were checked.
  handle("usage:refresh", async () => { const u = await usage.refresh(); return u && { at: u.at, stats: u.stats, version: u.version }; });
  // A session's last messages and a few facts about it (session-preview.js). The transcript is the one the scan
  // found; one started since is looked up by its id.
  handle("session:preview", (agent, id) => {
    if (!SESSION_ID.test(text(id)) || !isAgent(agent)) throw new Error(t("errors.invalidSession"));
    const s = cache?.sessions.find(x => x.agent === agent && x.id === id)
      ?? { agent, id, file: agent === "Claude" ? findTranscript(id) : "" };
    return sessionPreview.preview(s, { openCodeDb: OPENCODE_DB });
  });
  // Deletes a session. A Claude or Codex transcript goes to the Recycle Bin (a Claude session's folder of subagent and
  // tool-result files with it), only from the agent's own folder; an OpenCode session is deleted by its CLI, for good.
  // A session open in a terminal is refused. A transcript already gone (Claude Code drops those older than
  // cleanupPeriodDays, possibly after the last scan) only leaves the list. The windows hear about it as "data:changed".
  handle("session:delete", async (agent, id) => {
    if (!SESSION_ID.test(text(id)) || !isAgent(agent)) throw new Error(t("errors.invalidSession"));
    if ((await liveSessions()).some(l => l.agent === agent && l.id === id)) throw new Error(t("errors.sessionRunning"));
    if (agent === "OpenCode") {
      if (!/^[\w-]+$/.test(id)) throw new Error(t("errors.invalidSession"));
      await runOpenCode(["session", "delete", id], USER, 15000);
    } else {
      const root = agent === "Claude" ? CLAUDE_DIR : CODEX_DIR;
      const s = cache?.sessions.find(x => x.agent === agent && x.id === id);
      const file = s?.file || (agent === "Claude" ? findTranscript(id) : "");
      const rel = file ? path.relative(root, file) : "";
      if (file && (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !file.endsWith(".jsonl"))) throw new Error(t("errors.sessionNoFile"));
      if (file && fs.existsSync(file)) await shell.trashItem(file);
      const extra = file ? file.slice(0, -".jsonl".length) : "";
      if (agent === "Claude" && isDir(extra)) await shell.trashItem(extra);
    }
    if (cache) { cache = { ...cache, sessions: cache.sessions.filter(x => !(x.agent === agent && x.id === id)) }; broadcast("data:changed", cache); }
    return true;
  });
  // Branch and changes of the projects' and sessions' folders (git-status.js); a refresh is answered by "git:changed".
  handle("git:get", () => gitStatus.get());
  handle("git:refresh", () => { gitStatus.refresh().catch(err => console.error("Git status failed:", err.message)); return true; });
  // Brings a running session's own terminal (tab) to the front; pid and folder come from the live registry.
  handle("terminal:focus", (agent, id) => {
    if (!SESSION_ID.test(text(id))) throw new Error(t("errors.invalidSession"));
    return focusSession({ agent: text(agent), id });
  });
  // A path typed into the menu's search: offer a new session there if it is an existing directory.
  handle("fs:is-dir", p => (isDir(p) ? path.resolve(p) : ""));
  handle("voice:open-history", () => { voice?.openHistory(); return Boolean(voice); });
  handle("voice:open-settings", () => { voice?.openSettings(); return Boolean(voice); });
  // The edge menu's microphone: a voice command by click; its state is also pushed as "voice:command-state".
  handle("voice:command", () => voice?.command.toggle() ?? { ok: false });
  handle("voice:command-state", () => voice?.command.state() ?? { enabled: false, state: "idle" });
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
    for (const w of [managerWin, bar?.win, bar?.handleWin]) if (w && !w.isDestroyed()) w.webContents.reload();
  }
  if (keys.includes("edgeHandle")) bar?.syncHandle();
  if (keys.includes("autoUpdate")) updater.setAuto(p.autoUpdate);
  buildTrayMenu();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showManager);
  app.whenReady().then(() => {
    prefs.load();
    prefs.on("changed", onPrefsChanged);
    // The proxy settings, before anything goes online (requests made meanwhile wait for them).
    network.start();
    registerIpc();

    bar = createEdgeBar({
      preload: PRELOAD, onOpenManager: showManager, hotkeyLabel,
      handle: { shown: () => prefs.get().edgeHandle, position: prefs.handlePosition, savePosition: prefs.setHandlePosition }
    });
    tray = new Tray(makeIcon(32, 2));
    // A press opens or closes the menu at once (here, where Windows lets it take the focus); held down after opening
    // it, the same hotkey speaks a voice command while the menu stays open (voice/controller.js edgeKey()).
    hotkey = HOTKEYS.find(k => globalShortcut.register(k, () => { if (!voice?.edgeKey(k, () => bar.toggle())) bar.toggle(); })) || "";
    if (!hotkey) console.error(`None of the hotkeys is free: ${HOTKEYS.join(", ")}`);
    // Double-click would also fire this click, so recording is offered in the menu instead (VoiceTray: double-click).
    tray.on("click", () => bar.show("hotkey"));
    // Not reset on "balloon-closed": replacing a balloon can report the old one closed after the new one is up.
    tray.on("balloon-click", () => { const click = balloonClick; balloonClick = null; click?.(); });
    updater.on("changed", onUpdateChanged);
    updater.start({ auto: prefs.get().autoUpdate });
    buildTrayMenu();

    // Started with Windows: the tray and the edge menu only, until the user asks for the window.
    if (!autostart.startedAtLogin()) showManager();
    autostart.applyDefault().catch(err => console.error("Could not set up starting with Windows:", err.message));
    promptLaunch.sweep(PROMPTS_DIR); // prompts of voice commands whose terminal never started
    usage.start({ claudeDir: CLAUDE_DIR, codexDir: CODEX_DIR, openCodeDb: OPENCODE_DB, userData: app.getPath("userData"), onChange: u => broadcast("usage:changed", u) })
      .catch(err => console.error("Usage scan failed:", err.message));
    // Git: refreshed after each scan, when the edge menu opens or the manager window gets the focus (the pages ask),
    // and every two minutes while either is in view.
    gitStatus.start({
      dirs: () => (cache ? [...cache.registry.projects.map(p => p.path), ...cache.sessions.map(s => s.cwd)] : []),
      onChange: g => broadcast("git:changed", g),
      active: () => Boolean(bar?.isVisible() || (managerWin && !managerWin.isDestroyed() && managerWin.isVisible() && !managerWin.isMinimized()))
    });
    scan().catch(err => console.error("Initial scan failed:", err.message));
    // Started once the windows are up: the first run copies VoiceTray's history first, and a voice part that cannot
    // start (native module, broken data) must not take the session manager down with it.
    voiceStarting = Promise.resolve()
      .then(() => require("./voice/controller").initVoice({
        balloon, onTrayChanged: buildTrayMenu, icon: makeIcon(64), prefs,
        // The dictionary may include the projects' names.
        projectNames: () => readRegistry().projects.map(p => p.name),
        general: { set: patch => prefs.set(patch), hotkey: () => ({ current: hotkeyLabel(), candidates: HOTKEYS.map(k => keyLabel(k, " + ")) }), updates: updater, network,
          autostart },
        // Voice commands open sessions with the menu's own launchers; a project is shown in the menu itself.
        commands: {
          data: async () => cache ?? await scan(), live: liveSessions, focus: focusSession, launchAgent,
          launchNew: (agent, cwd, prompt) => (prompt ? launchNewWithPrompt(agent, cwd, prompt) : launchNew(agent, cwd)),
          showProject: dir => { bar.show("hotkey"); bar.win.webContents.send("voice:command-state", { select: dir }); },
          // While a command is being spoken the menu stays, wherever the pointer or the focus goes (edge-bar.js).
          onState: s => {
            bar.keepOpen(s.state === "recording");
            if (!bar.win.isDestroyed()) bar.win.webContents.send("voice:command-state", s);
          }
        }
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
    const shutdown = Promise.all([(async () => { await voiceStarting; await voice?.dispose(); })(), usage.flush()]);
    Promise.race([shutdown, new Promise(r => setTimeout(r, QUIT_GRACE_MS))])
      .catch(err => console.error("Voice shutdown failed:", err))
      .finally(() => app.quit());
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  // The hidden edge menu keeps the app alive after the manager window is closed; quitting is done from the tray.
  app.on("window-all-closed", () => {});
}
