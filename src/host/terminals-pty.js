// The host's own terminals on Linux (and macOS): a pseudo terminal per program through node-pty, children of the
// host's process - they end with it, and the next start opens the panes anew (agents resume their sessions). The
// same interface as terminals.js (DockPty, Windows): open, restore, input, type, resize, attach, close, stopAll,
// detachAll, link, getTabs, getUnlinkedTabs, countRunning. The scrollback is kept here, as chunks, with `end` the
// output's length so far (what a window attaching midway skips).
const crypto = require("node:crypto");
const os = require("node:os");

const SCROLLBACK_CHARS = 512 * 1024;
const DEFAULT_COLS = 120, DEFAULT_ROWS = 32, MAX_SIZE = 1000;

function createTerminals({ onData, onExit, onChange }) {
  const terminals = new Map();
  let pty = null;
  const getPty = () => (pty ??= require("node-pty"));
  const shell = () => process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");

  function getTabs() {
    return [...terminals.values()].map(x => ({
      id: x.id, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, agentOnly: x.agentOnly, codexLog: x.codexLog, pid: x.pid, owner: x.owner, exited: x.exitCode !== null, lost: false, createdAt: x.createdAt, note: x.note
    }));
  }
  function appendScrollback(terminal, data) {
    terminal.chunks.push(data);
    terminal.chunkChars += data.length;
    if (terminal.chunkChars > 2 * SCROLLBACK_CHARS) {
      const text = terminal.chunks.join("").slice(-SCROLLBACK_CHARS);
      terminal.chunks = [text];
      terminal.chunkChars = text.length;
    }
  }
  // argv: the program and its arguments (null: a login shell). env: already prepared by terminal-env.js.
  async function open({ cwd, argv = null, title, agent = "", sessionId = "", agentOnly = false, codexLog = "", owner = "", env = process.env }) {
    const [file, ...args] = argv?.length ? argv : [shell(), "-l"];
    const id = crypto.randomUUID();
    const proc = getPty().spawn(file, args, { name: "xterm-256color", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, env: { ...env, AGENTDECK_TERMINAL: id } });
    const terminal = { id, proc, pid: proc.pid, cwd, title, agent, sessionId, agentOnly, codexLog, owner, createdAt: Date.now(), chunks: [], chunkChars: 0, end: 0, exitCode: null, closed: false, lastInputAt: 0, note: "" };
    terminals.set(id, terminal);
    proc.onData(data => {
      terminal.end += data.length;
      appendScrollback(terminal, data);
      onData(id, data, terminal.end);
    });
    proc.onExit(({ exitCode }) => {
      if (terminal.exitCode !== null) return;
      terminal.exitCode = exitCode;
      onExit(id, exitCode, false);
      onChange(getTabs());
    });
    onChange(getTabs());
    return id;
  }
  // Nothing outlives the host here.
  const restore = async () => ({ attached: [], kept: [] });
  function type(id, data) {
    const terminal = terminals.get(id);
    if (terminal && typeof data === "string" && terminal.exitCode === null) terminal.proc.write(data);
  }
  function input(id, data) {
    const terminal = terminals.get(id);
    if (terminal) terminal.lastInputAt = Date.now();
    type(id, data);
  }
  const getLastInputAt = id => terminals.get(id)?.lastInputAt || 0;
  function setNote(id, note) {
    const terminal = terminals.get(id);
    if (terminal && terminal.note !== note) {
      terminal.note = note;
      onChange(getTabs());
    }
  }
  function resize(id, cols, rows) {
    const terminal = terminals.get(id);
    if (!terminal || !(cols > 0) || !(rows > 0) || terminal.exitCode !== null) return;
    try { terminal.proc.resize(Math.min(Math.floor(cols), MAX_SIZE), Math.min(Math.floor(rows), MAX_SIZE)); } catch {}
  }
  function attach(id) {
    const terminal = terminals.get(id);
    return terminal ? { scrollback: terminal.chunks.join("").slice(-SCROLLBACK_CHARS), end: terminal.end, exitCode: terminal.exitCode } : null;
  }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    terminals.delete(id);
    terminal.closed = true;
    if (terminal.exitCode === null) {
      try { terminal.proc.kill("SIGHUP"); } catch {}
    }
    onChange(getTabs());
    return true;
  }
  const stopAll = () => [...terminals.keys()].forEach(close);
  const detachAll = () => {};
  function link(id, agent, sessionId) {
    const terminal = terminals.get(id);
    if (terminal && !terminal.sessionId) {
      terminal.agent = agent;
      terminal.sessionId = sessionId;
      onChange(getTabs());
    }
  }
  const getUnlinkedTabs = () => [...terminals.values()].filter(x => !x.sessionId && x.exitCode === null).map(x => ({ id: x.id, pid: x.pid }));
  const countRunning = () => [...terminals.values()].filter(x => x.exitCode === null).length;

  return { open, restore, input, type, getLastInputAt, setNote, resize, attach, close, stopAll, detachAll, link, getTabs, getUnlinkedTabs, countRunning };
}

module.exports = { createTerminals };
