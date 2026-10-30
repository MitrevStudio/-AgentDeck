// Terminals hosted in AgentDeck's own window (Settings: "Open sessions in: AgentDeck tabs"). Each runs a command in a
// Windows pseudo console through DockPty (native/DockPty.cs), compiled once into userData with the C# compiler that
// ships with Windows - nothing is downloaded. Output is kept (the last SCROLLBACK_CHARS) and streamed to the manager
// window; every chunk carries `end`, the output's length so far, so a page attaching midway skips what the scrollback
// it got already holds. The terminals live as long as AgentDeck runs.
//
// DockPty's stdin frames: [type:1][length:4 LE][payload]; type 0 = input, type 1 = resize (cols:2 LE, rows:2 LE).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const BRIDGE_SOURCE = path.join(__dirname, "..", "native", "DockPty.cs");
const CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const SCROLLBACK_CHARS = 512 * 1024;
const DEFAULT_COLS = 120, DEFAULT_ROWS = 32, MAX_SIZE = 1000;
const FRAME_INPUT = 0, FRAME_RESIZE = 1;
// Variables of a Claude Code session AgentDeck itself may have been started from: a nested `claude` would take them
// for its own and act as a child session.
const INHERITED_CLAUDE_VARS = /^CLAUDE(_?CODE|_PID$)/i;

// onData(id, data, end), onExit(id, code), onChange(list): to the manager window.
function createTerminals({ userDataDir, onData, onExit, onChange }) {
  const terminals = new Map();
  let bridge = null;

  function buildBridge() {
    const source = fs.readFileSync(BRIDGE_SOURCE, "utf8");
    const hash = crypto.createHash("sha1").update(source).digest("hex").slice(0, 10);
    const exe = path.join(userDataDir, `DockPty-${hash}.exe`);
    if (fs.existsSync(exe)) {
      return Promise.resolve(exe);
    }
    // csc reads a real file: the source may sit inside app.asar.
    const copy = path.join(userDataDir, `DockPty-${hash}.cs`);
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(copy, source);
    return new Promise((resolve, reject) => {
      execFile(CSC, ["/nologo", "/optimize", "/target:exe", `/out:${exe}`, copy], { windowsHide: true }, err => {
        fs.rm(copy, { force: true }, () => {});
        if (err) {
          reject(new Error(`DockPty could not be compiled: ${err.message}`));
        } else {
          resolve(exe);
        }
      });
    });
  }
  function getBridge() {
    bridge ||= buildBridge().catch(e => { bridge = null; throw e; });
    return bridge;
  }

  function getFrame(type, payload) {
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }
  function getChildEnv(id, env) {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED_CLAUDE_VARS.test(name)));
    return { ...clean, AGENTDECK_TERMINAL: id };
  }

  function handleOutput(terminal, decoder, chunk) {
    const data = decoder.write(chunk);
    terminal.end += data.length;
    terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_CHARS);
    onData(terminal.id, data, terminal.end);
  }
  function handleExit(terminal, code) {
    if (terminal.exitCode !== null) {
      return;
    }
    terminal.exitCode = code ?? -1;
    onExit(terminal.id, terminal.exitCode);
    onChange(list());
  }

  // commandLine: what runs in the pseudo console, e.g. `powershell.exe -NoLogo -NoExit -EncodedCommand ...`.
  async function open({ cwd, commandLine, title, agent = "", sessionId = "", env = process.env }) {
    const exe = await getBridge();
    const id = crypto.randomUUID();
    const child = spawn(exe, [String(DEFAULT_COLS), String(DEFAULT_ROWS), cwd, commandLine], {
      cwd, env: getChildEnv(id, env), stdio: ["pipe", "pipe", "ignore"], windowsHide: true
    });
    const terminal = { id, cwd, title, agent, sessionId, child, scrollback: "", end: 0, exitCode: null, createdAt: Date.now() };
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", chunk => handleOutput(terminal, decoder, chunk));
    child.on("exit", code => handleExit(terminal, code));
    child.on("error", () => handleExit(terminal, -1));
    child.stdin.on("error", () => {});
    terminals.set(id, terminal);
    onChange(list());
    return id;
  }

  function input(id, data) {
    const terminal = terminals.get(id);
    if (terminal && terminal.exitCode === null && typeof data === "string") {
      terminal.child.stdin.write(getFrame(FRAME_INPUT, Buffer.from(data, "utf8")));
    }
  }
  function resize(id, cols, rows) {
    const terminal = terminals.get(id);
    if (!terminal || terminal.exitCode !== null || !(cols > 0) || !(rows > 0)) {
      return;
    }
    const payload = Buffer.alloc(4);
    payload.writeInt16LE(Math.min(Math.floor(cols), MAX_SIZE), 0);
    payload.writeInt16LE(Math.min(Math.floor(rows), MAX_SIZE), 2);
    terminal.child.stdin.write(getFrame(FRAME_RESIZE, payload));
  }
  function attach(id) {
    const terminal = terminals.get(id);
    return terminal ? { scrollback: terminal.scrollback, end: terminal.end, exitCode: terminal.exitCode } : null;
  }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) {
      return false;
    }
    terminals.delete(id);
    if (terminal.exitCode === null) {
      terminal.child.kill();
    }
    onChange(list());
    return true;
  }
  function closeAll() {
    [...terminals.keys()].forEach(close);
  }
  // A new session's id is known only once it runs: the page links the tab to it.
  function link(id, agent, sessionId) {
    const terminal = terminals.get(id);
    if (terminal && !terminal.sessionId) {
      terminal.agent = agent;
      terminal.sessionId = sessionId;
      onChange(list());
    }
  }
  function list() {
    return [...terminals.values()].map(x => ({
      id: x.id, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, exited: x.exitCode !== null, createdAt: x.createdAt
    }));
  }
  function findBySession(agent, sessionId) {
    return [...terminals.values()].find(x => x.agent === agent && x.sessionId === sessionId && x.exitCode === null) || null;
  }

  return { open, input, resize, attach, close, closeAll, link, list, findBySession };
}

module.exports = { createTerminals };
