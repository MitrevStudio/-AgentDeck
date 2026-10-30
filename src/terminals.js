// AgentDeck's own terminal tabs: each runs a command in a pseudo console through DockPty (native/DockPty.cs, compiled
// once into userData with the C# compiler that ships with Windows). Output chunks carry `end`, the output's length so
// far, so a page attaching midway skips what its scrollback already holds.
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

// onData(id, data, end), onExit(id, code), onChange(tabs): to the manager window.
function createTerminals({ userDataDir, onData, onExit, onChange }) {
  const terminals = new Map();
  let bridge = null;

  function compile(source, exe) {
    // csc reads a real file (the source may sit inside app.asar) and writes to a temporary name: an interrupted build
    // leaves no exe that would be trusted later.
    const copy = `${exe}.cs`, partial = `${exe}.partial`;
    fs.writeFileSync(copy, source);
    return new Promise((resolve, reject) => {
      execFile(CSC, ["/nologo", "/optimize", "/target:exe", `/out:${partial}`, copy], { windowsHide: true }, err => {
        fs.rm(copy, { force: true }, () => {});
        if (err) {
          reject(new Error(`DockPty could not be compiled: ${err.message}`));
          return;
        }
        fs.renameSync(partial, exe);
        resolve(exe);
      });
    });
  }
  function buildBridge() {
    const source = fs.readFileSync(BRIDGE_SOURCE, "utf8");
    const hash = crypto.createHash("sha1").update(source).digest("hex").slice(0, 10);
    const exe = path.join(userDataDir, `DockPty-${hash}.exe`);
    fs.mkdirSync(userDataDir, { recursive: true });
    return fs.existsSync(exe) ? Promise.resolve(exe) : compile(source, exe);
  }
  function getBridge() {
    bridge ||= buildBridge().catch(e => {
      bridge = null;
      throw e;
    });
    return bridge;
  }

  function getFrame(type, payload) {
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  // The scrollback is kept as chunks and trimmed once it holds twice its size, not copied on every chunk.
  function appendScrollback(terminal, data) {
    terminal.chunks.push(data);
    terminal.chunkChars += data.length;
    if (terminal.chunkChars > 2 * SCROLLBACK_CHARS) {
      const text = terminal.chunks.join("").slice(-SCROLLBACK_CHARS);
      terminal.chunks = [text];
      terminal.chunkChars = text.length;
    }
  }
  function getScrollback(terminal) {
    return terminal.chunks.join("").slice(-SCROLLBACK_CHARS);
  }
  function handleOutput(terminal, decoder, chunk) {
    const data = decoder.write(chunk);
    terminal.end += data.length;
    appendScrollback(terminal, data);
    onData(terminal.id, data, terminal.end);
  }
  function handleExit(terminal, code) {
    if (terminal.exitCode !== null) {
      return;
    }
    terminal.exitCode = code ?? -1;
    onExit(terminal.id, terminal.exitCode);
    onChange(getTabs());
  }

  // commandLine: what runs in the pseudo console. env: already prepared by terminal-env.js.
  async function open({ cwd, commandLine, title, agent = "", sessionId = "", env = process.env }) {
    const exe = await getBridge();
    const id = crypto.randomUUID();
    const child = spawn(exe, [String(DEFAULT_COLS), String(DEFAULT_ROWS), cwd, commandLine], {
      cwd, env: { ...env, AGENTDECK_TERMINAL: id }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true
    });
    const terminal = {
      id, cwd, title, agent, sessionId, child, chunks: [], chunkChars: 0, end: 0, exitCode: null, createdAt: Date.now(), lastInputAt: 0, note: ""
    };
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", chunk => handleOutput(terminal, decoder, chunk));
    child.on("exit", code => handleExit(terminal, code));
    child.on("error", () => handleExit(terminal, -1));
    child.stdin.on("error", () => {});
    terminals.set(id, terminal);
    onChange(getTabs());
    return id;
  }

  // Typed by AgentDeck itself (autopilot.js): unlike input(), not counted as the user's typing.
  function type(id, data) {
    const terminal = terminals.get(id);
    if (terminal && terminal.exitCode === null && typeof data === "string") {
      terminal.child.stdin.write(getFrame(FRAME_INPUT, Buffer.from(data, "utf8")));
    }
  }
  function input(id, data) {
    const terminal = terminals.get(id);
    if (terminal) {
      terminal.lastInputAt = Date.now();
    }
    type(id, data);
  }
  function getLastInputAt(id) {
    return terminals.get(id)?.lastInputAt || 0;
  }
  // A short status beside the tab's title ("Compacting…"); "" clears it.
  function setNote(id, note) {
    const terminal = terminals.get(id);
    if (terminal && terminal.note !== note) {
      terminal.note = note;
      onChange(getTabs());
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
    return terminal ? { scrollback: getScrollback(terminal), end: terminal.end, exitCode: terminal.exitCode } : null;
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
    onChange(getTabs());
    return true;
  }
  function closeAll() {
    [...terminals.keys()].forEach(close);
  }
  // A new session's id is known only once it runs (tab-links.js finds it).
  function link(id, agent, sessionId) {
    const terminal = terminals.get(id);
    if (terminal && !terminal.sessionId) {
      terminal.agent = agent;
      terminal.sessionId = sessionId;
      onChange(getTabs());
    }
  }
  function getTabs() {
    return [...terminals.values()].map(x => ({
      id: x.id, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, exited: x.exitCode !== null, createdAt: x.createdAt, note: x.note
    }));
  }
  // Running tabs not linked to a session yet, with their DockPty's process id.
  function getUnlinkedTabs() {
    return [...terminals.values()].filter(x => !x.sessionId && x.exitCode === null).map(x => ({ id: x.id, pid: x.child.pid }));
  }

  return { open, input, type, getLastInputAt, setNote, resize, attach, close, closeAll, link, getTabs, getUnlinkedTabs };
}

module.exports = { createTerminals };
