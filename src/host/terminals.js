// AgentDeck's own terminal tabs: each runs a command in a pseudo console through DockPty (native/DockPty.cs, compiled
// once into userData with the C# compiler that ships with Windows). DockPty runs detached and serves its terminal on a
// named pipe only the current user can open, so the terminal outlives AgentDeck, as in Herdr: quitting only lets go of
// it (detachAll), and the next start attaches again (restore) and gets the output DockPty kept. Output chunks carry
// `end`, the output's length since attaching, so a page attaching midway skips what its scrollback already holds.
//
// Pipe frames both ways: [type:1][length:4 LE][payload]. To DockPty: 0 input, 1 resize (cols:2 LE, rows:2 LE), 2 kill.
// From it: 0 output, 1 exited (code:4 LE), 2 hello (JSON: v, id, pid, token). A frame longer than MAX_FRAME, or of a
// negative length, is not DockPty's: that pipe is dropped.
// While a terminal runs, userData/terminals/<id>.json says how to reach it again (id, pid, token, meta).
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const atomicFile = require("../shared/atomic-file");

const BRIDGE_SOURCE = path.join(__dirname, "..", "..", "native", "DockPty.cs");
const CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const SCROLLBACK_CHARS = 512 * 1024;
const DEFAULT_COLS = 120, DEFAULT_ROWS = 32, MAX_SIZE = 1000;
const PROTOCOL = 1;
const PIPE_PREFIX = "\\\\.\\pipe\\agentdeck-term-";
const FRAME_INPUT = 0, FRAME_RESIZE = 1, FRAME_KILL = 2;
const MAX_FRAME = 16 * 1024 * 1024; // DockPty's bound, both ways
const FRAME_OUTPUT = 0, FRAME_EXITED = 1, FRAME_HELLO = 2;
// A DockPty just started makes its pipe first thing; one that answers no hello within HELLO_MS is not taken. Starting
// it gets longer: a busy machine or an antivirus scan of the freshly compiled exe can hold it for seconds.
const START_WAIT_MS = 5000, HELLO_MS = 5000, LAUNCH_WAIT_MS = 20000;
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODE_SWITCH = /\x1b\[\?([\d;]+)([hl])/g;

// modes: DEC private mode -> "h" | "l", as the given output leaves them.
function applyModes(modes, text) {
  for (const [, list, set] of text.matchAll(MODE_SWITCH)) {
    list.split(";").filter(Boolean).forEach(mode => modes.set(mode, set));
  }
}
// Where output longer than the scrollback is cut: at the first escape sequence of the part that is kept.
function getCut(text) {
  if (text.length <= SCROLLBACK_CHARS) {
    return 0;
  }
  const from = text.length - SCROLLBACK_CHARS;
  const at = text.indexOf("\x1b", from);
  return at < 0 ? from : at;
}
function getFrame(type, payload = Buffer.alloc(0)) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
// Calls onFrame(type, payload) for each whole frame the socket brings.
function readFrames(socket, onFrame) {
  let pending = Buffer.alloc(0);
  socket.on("data", chunk => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 5) {
      const length = pending.readInt32LE(1);
      if (length < 0 || length > MAX_FRAME) {
        socket.destroy(Object.assign(new Error(`A frame of ${length} bytes`), { code: "EPROTO" }));
        return;
      }
      if (pending.length < 5 + length) {
        break;
      }
      const type = pending[0], payload = pending.subarray(5, 5 + length);
      pending = pending.subarray(5 + length);
      onFrame(type, payload);
    }
  });
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
const parseJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// onData(id, data, end), onChange(tabs): to the manager window. onExit(id, code, lost): the program ended (lost: its
// DockPty went away without saying so - killed, or Windows shutting down). onResize(id, cols, rows): its size changed.
function createTerminals({ userDataDir, onData, onExit, onChange, onResize = () => {} }) {
  const terminals = new Map();
  const registryDir = path.join(userDataDir, "terminals");
  // Terminals left running by an AgentDeck whose DockPty speaks another protocol: not attached, but stopped with the
  // rest (stopAll) and counted.
  const others = new Map(); // id -> pid
  let bridge = null, detaching = false;

  function compile(source, exe) {
    // csc reads a real file (the source may sit inside app.asar) and writes to a temporary name: an interrupted build
    // leaves no exe that would be trusted later.
    const copy = `${exe}.cs`, partial = `${exe}.partial`;
    fs.writeFileSync(copy, source);
    return new Promise((resolve, reject) => {
      execFile(CSC, ["/nologo", "/optimize", "/target:exe", "/r:System.Core.dll", `/out:${partial}`, copy], { windowsHide: true }, err => {
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

  // ---------- the registry: how to reach each running terminal again ----------
  const getEntryFile = id => path.join(registryDir, `${id}.json`);
  const getMeta = x => ({ cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, agentOnly: x.agentOnly, codexLog: x.codexLog, pid: x.pid, owner: x.owner });
  function saveEntry(terminal) {
    const entry = { id: terminal.id, pid: terminal.pid, token: terminal.token, createdAt: terminal.createdAt, meta: getMeta(terminal) };
    atomicFile.write(getEntryFile(terminal.id), JSON.stringify(entry)).catch(e => console.error("Saving a terminal failed:", e.message));
  }
  function removeEntry(id) {
    atomicFile.remove(getEntryFile(id)).catch(e => console.error("Removing a terminal failed:", e.message));
  }

  // ---------- output ----------
  // The scrollback is kept as chunks and trimmed once it holds twice its size, not copied on every chunk. What is cut
  // off starts at an escape sequence, never inside one, and the modes switched in the part that went (bracketed paste,
  // focus events, mouse, alternate screen...) are put back in front of what a page replays.
  function appendScrollback(terminal, data) {
    terminal.chunks.push(data);
    terminal.chunkChars += data.length;
    if (terminal.chunkChars > 2 * SCROLLBACK_CHARS) {
      const all = terminal.chunks.join("");
      const cut = getCut(all);
      applyModes(terminal.modes, all.slice(0, cut));
      const text = all.slice(cut);
      terminal.chunks = [text];
      terminal.chunkChars = text.length;
    }
  }
  function getScrollback(terminal) {
    const all = terminal.chunks.join("");
    const cut = getCut(all);
    const modes = new Map(terminal.modes);
    applyModes(modes, all.slice(0, cut));
    return [...modes].map(([mode, set]) => `\x1b[?${mode}${set}`).join("") + all.slice(cut);
  }
  function handleOutput(terminal, decoder, chunk) {
    const data = decoder.write(chunk);
    terminal.end += data.length;
    appendScrollback(terminal, data);
    onData(terminal.id, data, terminal.end);
  }
  function handleExit(terminal, code, lost = false) {
    if (terminal.exitCode !== null) {
      return;
    }
    terminal.exitCode = code;
    terminal.lost = lost;
    onExit(terminal.id, code, lost);
    onChange(getTabs());
  }

  // ---------- the pipe ----------
  function write(terminal, type, payload) {
    if (terminal.socket && !terminal.socket.destroyed && terminal.exitCode === null) {
      terminal.socket.write(getFrame(type, payload));
    }
  }
  // Attaches to the terminal's DockPty; settles once its hello checked out (DockPty's own id and token: a pipe made
  // under the same name by anything else is not talked to). waitMs: how long a pipe not there yet is waited for.
  // Rejects with code "PROTOCOL" for a DockPty of another version.
  function attachPipe(terminal, waitMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const fail = (socket, error) => {
        socket.destroy();
        reject(error);
      };
      const tryConnect = () => {
        const socket = net.connect(PIPE_PREFIX + terminal.id);
        const decoder = new StringDecoder("utf8");
        let greeted = false;
        const timer = setTimeout(() => fail(socket, Object.assign(new Error("DockPty did not answer"), { code: "ETIMEDOUT" })), HELLO_MS);
        socket.on("error", err => {
          clearTimeout(timer);
          if (greeted) {
            return; // "close" follows
          }
          socket.destroy();
          if (err.code === "ENOENT" && Date.now() - started < waitMs) {
            setTimeout(tryConnect, 50);
          } else {
            reject(err);
          }
        });
        socket.on("close", () => {
          if (greeted) {
            handleClose(terminal, socket);
          }
        });
        readFrames(socket, (type, payload) => {
          if (greeted) {
            if (type === FRAME_OUTPUT) {
              handleOutput(terminal, decoder, payload);
            } else if (type === FRAME_EXITED) {
              handleExit(terminal, payload.length >= 4 ? payload.readInt32LE(0) : -1);
            }
            return;
          }
          clearTimeout(timer);
          const hello = type === FRAME_HELLO ? parseJson(payload.toString("utf8")) : null;
          if (hello?.v !== PROTOCOL) {
            fail(socket, Object.assign(new Error(`DockPty speaks protocol ${hello?.v}`), { code: hello ? "PROTOCOL" : "EPROTO" }));
          } else if (hello.id !== terminal.id || hello.token !== terminal.token) {
            fail(socket, Object.assign(new Error("Not this terminal's DockPty"), { code: "EPROTO" }));
          } else {
            greeted = true;
            terminal.socket = socket;
            resolve(hello);
          }
        });
      };
      tryConnect();
    });
  }
  // The pipe closed without an exit frame: AgentDeck let go of it, or DockPty went away (killed, or Windows shutting
  // down) - then the terminal is lost, but its pane stays and opens anew on the next start.
  function handleClose(terminal, socket) {
    if (terminal.socket !== socket) {
      return;
    }
    terminal.socket = null;
    if (!detaching && !terminal.closed) {
      handleExit(terminal, -1, true);
    }
  }
  // owner: the id of the peer that opened it (mesh), "" for this computer's own. cols, rows: its size as last set here
  // (one attached again after a restart counts as the default until a pane sizes it).
  function createTerminal({ id, pid, token, cwd, title, agent = "", sessionId = "", agentOnly = false, codexLog = "", owner = "", createdAt = Date.now() }) {
    return {
      id, pid, token, cwd, title, agent, sessionId, agentOnly, codexLog, owner, createdAt, socket: null, chunks: [], chunkChars: 0, modes: new Map(), end: 0,
      exitCode: null, lost: false, closed: false, lastInputAt: 0, note: "", cols: DEFAULT_COLS, rows: DEFAULT_ROWS
    };
  }

  // commandLine: what runs in the pseudo console. env: already prepared by terminal-env.js.
  async function open({ cwd, commandLine, title, agent = "", sessionId = "", agentOnly = false, codexLog = "", owner = "", env = process.env }) {
    const exe = await getBridge();
    const id = crypto.randomUUID(), token = crypto.randomBytes(16).toString("hex");
    // This DockPty only starts the real one - detached, inheriting none of AgentDeck's handles - and prints its process
    // id. The token travels in the environment (not on a command line other processes can read); DockPty drops it
    // before the program starts.
    const pid = await new Promise((resolve, reject) => {
      execFile(exe, ["--pipe", id, String(DEFAULT_COLS), String(DEFAULT_ROWS), cwd, commandLine], {
        cwd, env: { ...env, AGENTDECK_TERMINAL: id, AGENTDECK_PIPE_TOKEN: token }, windowsHide: true, timeout: LAUNCH_WAIT_MS
      }, (err, stdout) => {
        const started = Number(String(stdout).trim());
        // The reason, not execFile's message (the whole command line): DockPty's exit code says which step failed.
        const why = !err ? "no process" : err.killed ? `no answer in ${LAUNCH_WAIT_MS / 1000} s` : `DockPty exit code ${err.code}`;
        if (err || !Number.isInteger(started) || started <= 0) reject(new Error(`The terminal could not start: ${why}`));
        else resolve(started);
      });
    });
    const terminal = createTerminal({ id, pid, token, cwd, title, agent, sessionId, agentOnly, codexLog, owner });
    // In the list before attaching: output can come right behind the hello.
    terminals.set(id, terminal);
    try {
      await attachPipe(terminal, START_WAIT_MS);
    } catch (e) {
      terminals.delete(id);
      try { process.kill(pid); } catch {}
      throw new Error(`The terminal could not start: ${e.message}`);
    }
    saveEntry(terminal);
    onChange(getTabs());
    return id;
  }
  // The terminals the last AgentDeck left running, attached again with the output their DockPty kept. An entry whose
  // DockPty is gone is dropped. Answers the ids attached, and as `kept` those whose DockPty still runs but could not be
  // attached this time (no hello in time, the pipe busy, another protocol): their entries stay for a later start, and
  // the caller must not open them anew.
  async function restore() {
    let names = [];
    const kept = [];
    try {
      names = fs.readdirSync(registryDir).filter(name => name.endsWith(".json"));
    } catch {}
    const attached = await Promise.all(names.map(async name => {
      const file = path.join(registryDir, name);
      const entry = parseJson(await atomicFile.readText(file).catch(() => null));
      const meta = entry?.meta && typeof entry.meta === "object" ? entry.meta : {};
      if (!entry || !TERMINAL_ID.test(entry.id) || name !== `${entry.id}.json` || terminals.has(entry.id) || !isAlive(entry.pid)
        || typeof entry.token !== "string" || typeof meta.cwd !== "string") {
        await atomicFile.remove(file).catch(() => {});
        return "";
      }
      const str = v => (typeof v === "string" ? v : "");
      const terminal = createTerminal({
        id: entry.id, pid: entry.pid, token: entry.token, cwd: meta.cwd, title: str(meta.title) || path.basename(meta.cwd),
        agent: str(meta.agent), sessionId: str(meta.sessionId), agentOnly: meta.agentOnly === true, codexLog: str(meta.codexLog), owner: str(meta.owner), createdAt: Number(entry.createdAt) || Date.now()
      });
      terminals.set(entry.id, terminal);
      try {
        await attachPipe(terminal, 0);
        return entry.id;
      } catch (e) {
        terminals.delete(entry.id);
        if (e.code === "ENOENT" || e.code === "EPROTO") {
          // No pipe (the pid belongs to another process now), or not this terminal's.
          await atomicFile.remove(file).catch(() => {});
        } else {
          if (e.code === "PROTOCOL") others.set(entry.id, entry.pid);
          kept.push(entry.id);
        }
        console.error(`Terminal ${entry.id} could not be attached:`, e.message);
        return "";
      }
    }));
    onChange(getTabs());
    return { attached: attached.filter(Boolean), kept };
  }

  // Typed by AgentDeck itself (autopilot.js): unlike input(), not counted as the user's typing.
  function type(id, data) {
    const terminal = terminals.get(id);
    if (terminal && typeof data === "string") {
      write(terminal, FRAME_INPUT, Buffer.from(data, "utf8"));
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
    if (!terminal || !(cols > 0) || !(rows > 0)) {
      return;
    }
    const c = Math.min(Math.floor(cols), MAX_SIZE), r = Math.min(Math.floor(rows), MAX_SIZE);
    const payload = Buffer.alloc(4);
    payload.writeInt16LE(c, 0);
    payload.writeInt16LE(r, 2);
    write(terminal, FRAME_RESIZE, payload);
    if (terminal.cols !== c || terminal.rows !== r) {
      terminal.cols = c;
      terminal.rows = r;
      onResize(id, c, r);
    }
  }
  function attach(id) {
    const terminal = terminals.get(id);
    return terminal ? { scrollback: getScrollback(terminal), end: terminal.end, exitCode: terminal.exitCode, cols: terminal.cols, rows: terminal.rows } : null;
  }
  // Ends the terminal (its program tree with it) and forgets it.
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) {
      return false;
    }
    terminals.delete(id);
    terminal.closed = true;
    if (terminal.exitCode === null) {
      if (terminal.socket && !terminal.socket.destroyed) {
        terminal.socket.end(getFrame(FRAME_KILL));
      } else {
        try { process.kill(terminal.pid); } catch {}
      }
    } else {
      terminal.socket?.destroy();
    }
    removeEntry(id);
    onChange(getTabs());
    return true;
  }
  // "Stop all terminals and quit": every terminal ends, those of another DockPty version too.
  function stopAll() {
    [...terminals.keys()].forEach(close);
    for (const [id, pid] of others) {
      try { process.kill(pid); } catch {}
      removeEntry(id);
    }
    others.clear();
  }
  // Quitting: the terminals keep running, and the next start attaches to them again.
  function detachAll() {
    detaching = true;
    terminals.forEach(terminal => terminal.socket?.destroy());
  }
  // A new session's id is known only once it runs (tab-links.js finds it); DockPty and the registry keep it, so the
  // terminal still knows its session after a restart.
  function link(id, agent, sessionId) {
    const terminal = terminals.get(id);
    if (terminal && !terminal.sessionId) {
      terminal.agent = agent;
      terminal.sessionId = sessionId;
      saveEntry(terminal);
      onChange(getTabs());
    }
  }
  function getTabs() {
    return [...terminals.values()].map(x => ({
      id: x.id, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, agentOnly: x.agentOnly, codexLog: x.codexLog, pid: x.pid, owner: x.owner, exited: x.exitCode !== null, lost: x.lost, createdAt: x.createdAt, note: x.note
    }));
  }
  // Running tabs not linked to a session yet, with their DockPty's process id.
  function getUnlinkedTabs() {
    return [...terminals.values()].filter(x => !x.sessionId && x.exitCode === null).map(x => ({ id: x.id, pid: x.pid }));
  }
  // How many terminals run: attached ones, and those of another DockPty version.
  const countRunning = () => [...terminals.values()].filter(x => x.exitCode === null).length + others.size;

  return {
    open, restore, input, type, getLastInputAt, setNote, resize, attach, close, stopAll, detachAll, link, getTabs,
    getUnlinkedTabs, countRunning
  };
}

module.exports = { createTerminals };
