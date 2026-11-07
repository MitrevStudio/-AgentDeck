// The host's sessions: the Claude Code and Codex transcripts and OpenCode's sessions on this computer, read into
// one list (newest first) with the project each belongs to, and the registry of projects (registry.js) that the
// scan fills in by itself from the folders sessions ran in. Kept as `cache` and pushed through onChange when it
// changed; a full scan (start, Refresh, every FULL_SCAN_MS) asks OpenCode's CLI too, a light rescan (transcripts
// changed) reads only the lines appended since the last one.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createRegistry, norm } = require("./registry");
const { NOISE_PROMPT, contentText } = require("./session-preview");

const execFileAsync = promisify(execFile);
const RECAP_CHARS = 220;
const CODEX_HEAD_BYTES = 256 * 1024;
const RESCAN_MS = 5000;
const FULL_SCAN_MS = 5 * 60 * 1000;
const AGENT_EXES = { Claude: "claude", OpenCode: "opencode", Codex: "codex" };

function titleFromText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 110);
}
// The gist of where a session ended: its last answer without markdown, cut at a sentence end where one is near.
function getRecap(text) {
  const plain = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[-=*_:]{3,}/g, " ")
    .replace(/[#*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= RECAP_CHARS) {
    return plain;
  }
  const cut = plain.slice(0, RECAP_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > RECAP_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
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
function getStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}
// The folder the session works in now (it moves into a worktree, for one): the last message's own cwd. Tool data
// inside a message can carry other cwd fields, so the line is parsed rather than searched.
function getLastCwd(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"cwd":"')) continue;
    try {
      const x = JSON.parse(lines[i]);
      if (typeof x.cwd === "string") return x.cwd;
    } catch {}
  }
  return "";
}
// Claude Code's own recap of a session ("away_summary"), without its "(disable recaps in /config)" hint.
function getAwaySummary(line) {
  let x;
  try {
    x = JSON.parse(line);
  } catch {
    return "";
  }
  return x?.isSidechain || typeof x?.content !== "string" ? "" : x.content.replace(/\s*\(disable recaps[^)]*\)\s*$/i, "").replace(/\s+/g, " ").trim();
}
function getAnswerRecap(line) {
  let x;
  try {
    x = JSON.parse(line);
  } catch {
    return "";
  }
  return x?.isSidechain ? "" : getRecap(contentText(x?.message?.content));
}
function readHead(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, read);
  } finally {
    fs.closeSync(fd);
  }
}
// The first `name` + PATHEXT extension in a PATH folder (never the current folder), or "". On Linux the name itself.
async function findOnPath(name) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir.replace(/"/g, ""))) continue;
    for (const ext of exts) {
      const file = path.join(dir.replace(/"/g, ""), name + ext.toLowerCase());
      try { if ((await fs.promises.stat(file)).isFile()) return file; } catch {}
    }
  }
  return "";
}
function openCodeSession(s, cwd, projectName, untitled) {
  const id = s.id || s.sessionID;
  if (!id) return null;
  return {
    id, agent: "OpenCode", cwd, projectName,
    title: titleFromText(s.title || s.summary) || untitled("OpenCode", id.slice(0, 8)),
    updatedAt: Number(s.updated || s.time?.updated || s.updatedAt || 0)
  };
}
// Files gone since the last scan leave the read caches.
function forgetMissing(reads, files) {
  const present = new Set(files);
  for (const f of reads.keys()) {
    if (!present.has(f)) reads.delete(f);
  }
}

// dataDir: registry.json and the caches; home: the user's home (the agents' folders are under it);
// isExcluded(cwd): folders whose sessions are not the user's work (the command centre's);
// untitled(agent, shortId): the title of a session with no prompt yet, in the user's language;
// onChange(cache): the list or the registry changed; onScanned(sessions, full): after every scan, for the index, the
// usage figures and the git status.
function createSessions({ dataDir, home, isExcluded = () => false, untitled = (agent, id) => `${agent} ${id}`, onChange = () => {}, onScanned = () => {} }) {
  const registry = createRegistry(path.join(dataDir, "registry.json"));
  const CLAUDE_DIR = path.join(home, ".claude", "projects");
  const CODEX_DIR = path.join(home, ".codex", "sessions");
  const OPENCODE_DB = path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "opencode", "opencode.db");

  // ---------- Claude Code ----------
  // Transcripts only ever grow, so each is read once and then only from where the last scan stopped (a file that
  // shrank is read again from the start). What was gathered so far stays here, per file.
  const claudeReads = new Map(); // file -> { offset, cwd, prompt, aiTitle, customTitle, answerLine, recap }
  function readClaudeLine(st, line) {
    // Only the last answer and the last recap are parsed (once per read): most lines are tool output never decoded.
    if (line.includes('"type":"assistant"') && line.includes('"type":"text"')) st.answerLine = line;
    if (line.includes('"subtype":"away_summary"')) st.summaryLine = line;
    // Titles can be appended at any point (/rename, AI title refresh); everything else is only needed once.
    const titleLine = line.includes('"custom-title"') || line.includes('"ai-title"');
    if (!titleLine && st.cwd && st.prompt) return;
    let x; try { x = JSON.parse(line); } catch { return; }
    if (x.type === "custom-title" && x.customTitle) st.customTitle = x.customTitle;
    if (x.type === "ai-title" && x.aiTitle) st.aiTitle = x.aiTitle;
    if (!st.cwd && typeof x.cwd === "string") st.cwd = x.cwd;
    if (!st.prompt && x.type === "user" && !x.isMeta && !x.isSidechain) {
      const text = contentText(x.message?.content);
      if (text.trim() && !NOISE_PROMPT.test(text)) st.prompt = titleFromText(text.replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, " "));
    }
  }
  // Reads the complete lines added since the last read; a line still being written waits for the next scan.
  function readClaudeAppended(file, st, size) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - st.offset);
      const read = fs.readSync(fd, buf, 0, buf.length, st.offset);
      const end = buf.lastIndexOf(10, read - 1) + 1;
      const lines = buf.toString("utf8", 0, end).split(/\r?\n/);
      for (const line of lines) {
        if (line) readClaudeLine(st, line);
      }
      const last = getLastCwd(lines);
      if (last) st.workDir = last === st.cwd ? "" : last;
      st.offset += end;
      if (st.answerLine) {
        st.recap = getAnswerRecap(st.answerLine);
        st.answerLine = "";
      }
      if (st.summaryLine) {
        st.summary = getAwaySummary(st.summaryLine);
        st.summaryLine = "";
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  function parseClaude(file) {
    const stat = getStat(file);
    if (!stat) {
      claudeReads.delete(file);
      return null;
    }
    let st = claudeReads.get(file);
    if (!st || stat.size < st.offset) {
      st = { offset: 0, cwd: "", prompt: "", aiTitle: "", customTitle: "", answerLine: "", recap: "" };
      claudeReads.set(file, st);
    }
    if (stat.size > st.offset) {
      try {
        readClaudeAppended(file, st, stat.size);
      } catch {
        return null;
      }
    }
    const id = path.basename(file, ".jsonl");
    const title = titleFromText(st.customTitle || st.aiTitle) || st.prompt || untitled("Claude", id.slice(0, 8));
    return { id, agent: "Claude", cwd: st.cwd, workDir: st.workDir || undefined, title, prompt: st.prompt !== title ? st.prompt : "", recap: st.summary || st.recap, updatedAt: stat.mtimeMs, file };
  }

  // ---------- Codex ----------
  // Only the head of a Codex transcript is read: the first lines hold everything the list needs. Kept while the
  // file's size and time stay the same, so a rescan reads only transcripts that changed.
  const codexReads = new Map(); // file -> { mtime, size, session }
  function parseCodexCached(file) {
    const stat = getStat(file);
    if (!stat) {
      codexReads.delete(file);
      return null;
    }
    let known = codexReads.get(file);
    if (!known || known.mtime !== stat.mtimeMs || known.size !== stat.size) {
      known = { mtime: stat.mtimeMs, size: stat.size, session: parseCodex(file) };
      codexReads.set(file, known);
    }
    return known.session ? { ...known.session } : null;
  }
  function parseCodex(file) {
    let lines;
    try { lines = readHead(file, CODEX_HEAD_BYTES).split(/\r?\n/).filter(Boolean); } catch { return null; }
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
    return { id, agent: "Codex", cwd, title: title || untitled("Codex", id.slice(0, 8)), updatedAt, file };
  }

  // ---------- OpenCode ----------
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
  // OpenCode's sessions come from its CLI, which takes seconds: a rescan started by a changed transcript keeps the
  // last answer, the Refresh button and the first scan ask it again.
  let lastOpenCode = [];
  async function scanOpenCode(reg) {
    const found = [];
    // Query globally first, then use registered projects as a fallback.
    let openCodeFound = false, openCodeInstalled = false;
    try {
      const { stdout } = await runOpenCode(["session", "list", "--format", "json", "--max-count", "300"], home, 12000);
      openCodeInstalled = true;
      let arr; try { arr = JSON.parse(stdout); } catch { arr = []; }
      if (!Array.isArray(arr)) arr = arr.sessions || arr.data || [];
      for (const raw of arr) {
        const s = openCodeSession(raw, raw.directory || raw.cwd || raw.path || "", undefined, untitled);
        if (s) { found.push(s); openCodeFound = true; }
      }
    } catch { /* CLI not installed, or CLI version differs */ }
    if (openCodeInstalled && !openCodeFound) {
      for (const project of reg.projects) {
        try {
          const { stdout } = await runOpenCode(["session", "list", "--format", "json", "--max-count", "200"], project.path, 10000);
          let arr; try { arr = JSON.parse(stdout); } catch { arr = []; }
          if (!Array.isArray(arr)) arr = arr.sessions || arr.data || [];
          for (const raw of arr) {
            const s = openCodeSession(raw, project.path, project.name, untitled);
            if (s) found.push(s);
          }
        } catch { /* project not available */ }
      }
    }
    return found;
  }

  // ---------- the scan ----------
  function scanTranscripts(reg, found) {
    // Claude Code transcripts. Subagent transcripts live in `subagents/` and cannot be resumed on their own.
    const claudeFiles = walkFiles(CLAUDE_DIR, ".jsonl", [], 0, ["subagents"]);
    forgetMissing(claudeReads, claudeFiles);
    for (const f of claudeFiles) {
      const s = parseClaude(f);
      if (s) {
        const projectFolder = path.basename(path.dirname(f));
        const p = reg.projects.find(p => projectFolder === p.path.replace(/:/g, "-").replace(/\\/g, "-").replace(/\//g, "-") ||
          projectFolder.toLowerCase().includes(path.basename(p.path).toLowerCase()));
        if (!s.cwd && p) s.cwd = p.path;
        if (s.cwd || p) { s.cwd = s.cwd || p.path; s.projectName = p?.name; }
        found.push(s);
      }
    }
    // Codex transcripts.
    const codexFiles = walkFiles(CODEX_DIR, ".jsonl");
    forgetMissing(codexReads, codexFiles);
    for (const f of codexFiles) {
      const s = parseCodexCached(f);
      if (s) {
        const p = reg.projects.find(p => s.cwd && norm(p.path) === norm(s.cwd));
        if (p) s.projectName = p.name;
        found.push(s);
      }
    }
  }
  // Auto-index projects that can be reliably resolved from local session metadata.
  function indexProjects(found) {
    const reg = registry.read();
    // Folders the user removed from the list stay out until added again.
    const removed = new Set(reg.removed);
    let changed = false;
    for (const s of found) {
      if (!s.cwd || !path.isAbsolute(s.cwd) || removed.has(norm(s.cwd)) || isExcluded(s.cwd) || !fs.existsSync(s.cwd)) continue;
      try { if (!fs.statSync(s.cwd).isDirectory()) continue; } catch { continue; }
      let project = reg.projects.find(p => norm(p.path) === norm(s.cwd));
      if (!project) {
        project = { name: path.basename(s.cwd), path: path.resolve(s.cwd) };
        reg.projects.push(project); changed = true;
      }
      s.projectName = project.name;
    }
    if (changed) registry.write(reg);
    const seen = new Set();
    // The command centre's own sessions are not the user's work: its card shows its state.
    return found.filter(s => {
      const key = `${s.agent}:${s.id}`;
      if (seen.has(key) || isExcluded(s.cwd)) return false;
      seen.add(key); return true;
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 1000);
  }
  async function scanSessions({ openCode = true } = {}) {
    const reg = registry.read();
    if (openCode) lastOpenCode = await scanOpenCode(reg);
    const found = lastOpenCode.map(s => ({ ...s }));
    scanTranscripts(reg, found);
    return indexProjects(found);
  }

  // ---------- the cache ----------
  // Which agent CLIs are on PATH, so the menus only offer new sessions that can actually start.
  const agents = Promise.all(Object.entries(AGENT_EXES).map(([agent, exe]) => findOnPath(exe).then(found => (found ? agent : null))))
    .then(list => list.filter(Boolean));
  let cache = null, scanning = null, scanningFull = false;
  let lastSessionsSig = "";
  function updateCache(sessions, reg, ready, full) {
    const sig = JSON.stringify(sessions);
    const changed = sig !== lastSessionsSig;
    lastSessionsSig = sig;
    if (!changed && !full && cache) return;
    cache = { registry: reg, sessions, agents: ready, at: Date.now() };
    onChange(cache);
  }
  // full: OpenCode's CLI and the git status are asked too (first scan, Refresh); a rescan after changed transcripts
  // skips both. A full scan asked for while a lighter one runs follows it.
  function scan({ full = true } = {}) {
    if (scanning && full && !scanningFull) return scanning.catch(() => {}).then(() => scan({ full }));
    if (scanning) return scanning;
    if (full) watchTranscripts();
    scanningFull = full;
    scanning = scanSessions({ openCode: full }).then(async sessions => {
      // Scan first: it auto-indexes projects into the registry, which must be read afterwards.
      updateCache(sessions, registry.read(), await agents, full);
      onScanned(sessions, full);
      return cache;
    }).finally(() => {
      scanning = null;
    });
    return scanning;
  }
  // Sessions that go on, start or end change their transcripts: the list, the search index and the figures follow
  // by themselves - at most every RESCAN_MS while transcripts keep changing, so a working session costs one light
  // rescan (only the lines it added are read) every few seconds.
  let rescanTimer = null;
  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scan({ full: false }).catch(err => console.error("Rescan failed:", err.message));
    }, RESCAN_MS);
  }
  // Every full scan watches what is not watched yet: a folder an agent creates later (installed or first run after
  // the host started), or one whose watch failed.
  const watchers = new Map(); // folder -> fs.FSWatcher
  function watchTranscripts() {
    for (const dir of [CLAUDE_DIR, CODEX_DIR]) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { recursive: true }, (_event, name) => {
          if (name && String(name).endsWith(".jsonl")) scheduleRescan();
        });
        watcher.on("error", err => {
          console.error(`Watching ${dir} failed:`, err.message);
          watcher.close();
          watchers.delete(dir);
        });
        watchers.set(dir, watcher);
      } catch (err) {
        if (err.code !== "ENOENT") console.error(`Could not watch ${dir}:`, err.message);
      }
    }
  }
  // OpenCode sessions and git branches are not watched.
  let periodic = null;
  function scanPeriodically() {
    periodic ||= setInterval(() => scan().catch(err => console.error("Full scan failed:", err.message)), FULL_SCAN_MS);
  }
  function stop() {
    clearInterval(periodic);
    clearTimeout(rescanTimer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
  }

  // The registry after an edit: written, and the cache told of it.
  function saveRegistry(reg) {
    registry.write(reg);
    return registryChanged(reg);
  }
  function registryChanged(reg) {
    if (cache) { cache = { ...cache, registry: reg }; onChange(cache); }
    return reg;
  }
  // The list with a session taken out (deleted elsewhere).
  function forget(agent, id) {
    if (cache) { cache = { ...cache, sessions: cache.sessions.filter(x => !(x.agent === agent && x.id === id)) }; onChange(cache); }
  }
  // The cache in the new language: the fallback titles are built anew by the next scan.
  function invalidate() {
    cache = null;
  }

  return {
    CLAUDE_DIR, CODEX_DIR, OPENCODE_DB, AGENT_EXES, norm, findOnPath, runOpenCode, agents,
    registry: { read: () => registry.read(), save: saveRegistry, write: reg => registry.write(reg) },
    scan, scheduleRescan, watchTranscripts, scanPeriodically, stop,
    get: () => cache, data: async () => cache ?? await scan(), registryChanged, forget, invalidate
  };
}

module.exports = { createSessions, titleFromText, getRecap, findOnPath };
