// The host's own terminals on Linux (and macOS): a pseudo terminal per program through node-pty, children of the
// host's process - they end with it. The same interface as terminals.js (DockPty, Windows): open, restore,
// forgetEntry, input, type, resize, size, attach, close, stopAll, detachAll, link, getTabs, getUnlinkedTabs,
// countRunning; onResize(id, cols, rows) when a size changed. The scrollback is kept here, as chunks, with `end` the
// output's length so far (what a window attaching midway skips), and the size as last set (attach answers both).
//
// A registry as DockPty's (userData/terminals/<id>.json: { id, createdAt, meta }), written on open and link, removed on
// close and stopAll, says what ran: a host that stops (detachAll: SIGHUP to the programs, the entries kept, no exit
// reported) or dies opens them anew on its next start under the same ids (host/index.js restoreTerminals), so the
// panes of every device find them again (docs/SHARED-SESSIONS.md 4.6). Nothing outlives the host itself.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const atomicFile = require("../shared/atomic-file");

const SCROLLBACK_CHARS = 512 * 1024;
const DEFAULT_COLS = 120, DEFAULT_ROWS = 32, MAX_SIZE = 1000;
const TERMINAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// What a closing terminal sends its program. node-pty on Windows (tests only) takes no signal: one given there throws
// later, out of reach of a try, when the console was not ready yet.
const HANG_UP = process.platform === "win32" ? undefined : "SIGHUP";

const parseJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// userDataDir: where the registry is kept (none without it: tests that need no restart).
function createTerminals({ userDataDir = "", onData, onExit, onChange, onResize = () => {} }) {
  const terminals = new Map();
  const registryDir = userDataDir ? path.join(userDataDir, "terminals") : "";
  let pty = null, detaching = false;
  const getPty = () => (pty ??= require("node-pty"));
  const shell = () => process.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash");

  // ---------- the registry ----------
  const getEntryFile = id => path.join(registryDir, `${id}.json`);
  const getMeta = x => ({ cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, agentOnly: x.agentOnly, codexLog: x.codexLog, owner: x.owner });
  function saveEntry(terminal) {
    if (!registryDir) return;
    atomicFile.write(getEntryFile(terminal.id), JSON.stringify({ id: terminal.id, createdAt: terminal.createdAt, meta: getMeta(terminal) }))
      .catch(e => console.error("Saving a terminal failed:", e.message));
  }
  // Gone at once as well as in turn (terminals.js removeEntry): a stopped terminal is not opened anew on the next start.
  function removeEntry(id) {
    if (!registryDir) return;
    try { fs.rmSync(getEntryFile(id), { force: true }); } catch {}
    atomicFile.remove(getEntryFile(id)).catch(e => console.error("Removing a terminal failed:", e.message));
  }

  function getTabs() {
    return [...terminals.values()].map(x => ({
      id: x.id, cwd: x.cwd, title: x.title, agent: x.agent, sessionId: x.sessionId, agentOnly: x.agentOnly, codexLog: x.codexLog, pid: x.pid, owner: x.owner, exited: x.exitCode !== null, lost: false, createdAt: x.createdAt, note: x.note, reopened: x.reopened
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
  // argv: the program and its arguments (null: a login shell). env: already prepared by terminal-env.js. id: given only
  // to open a terminal anew under the id it had (restoreTerminals), with its createdAt and reopened.
  async function open({ cwd, argv = null, title, agent = "", sessionId = "", agentOnly = false, codexLog = "", owner = "", env = process.env, id: wanted = "", createdAt, reopened = false }) {
    if (wanted && (!TERMINAL_ID.test(wanted) || terminals.has(wanted))) throw new Error("The terminal could not start: that id is taken");
    const [file, ...args] = argv?.length ? argv : [shell(), "-l"];
    const id = wanted || crypto.randomUUID();
    const proc = getPty().spawn(file, args, { name: "xterm-256color", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd, env: { ...env, AGENTDECK_TERMINAL: id } });
    const terminal = {
      id, proc, pid: proc.pid, cwd, title, agent, sessionId, agentOnly, codexLog, owner, createdAt: createdAt || Date.now(), reopened, chunks: [], chunkChars: 0, end: 0,
      exitCode: null, closed: false, lastInputAt: 0, note: "", cols: DEFAULT_COLS, rows: DEFAULT_ROWS
    };
    terminals.set(id, terminal);
    proc.onData(data => {
      terminal.end += data.length;
      appendScrollback(terminal, data);
      onData(id, data, terminal.end);
    });
    proc.onExit(({ exitCode }) => {
      // Let go of on purpose (detachAll): the entry stays, and nobody hears of an exit.
      if (terminal.exitCode !== null || detaching) return;
      terminal.exitCode = exitCode;
      onExit(id, exitCode, false);
      onChange(getTabs());
    });
    saveEntry(terminal);
    onChange(getTabs());
    return id;
  }
  // Nothing outlives the host here: every entry is of a terminal gone with the last one. They are answered in `dead`
  // ({ id, createdAt, meta }) for the host to open anew under the same ids (host/index.js restoreTerminals), which then
  // rewrites or drops each (forgetEntry); an entry that cannot be read is dropped.
  async function restore() {
    const dead = [];
    let names = [];
    try {
      names = registryDir ? fs.readdirSync(registryDir).filter(name => name.endsWith(".json")) : [];
    } catch {}
    const str = v => (typeof v === "string" ? v : "");
    for (const name of names) {
      const file = path.join(registryDir, name);
      const entry = parseJson(await atomicFile.readText(file).catch(() => null));
      const meta = entry?.meta && typeof entry.meta === "object" ? entry.meta : {};
      if (!entry || !TERMINAL_ID.test(entry.id) || name !== `${entry.id}.json` || terminals.has(entry.id) || typeof meta.cwd !== "string") {
        if (!terminals.has(entry?.id)) await atomicFile.remove(file).catch(() => {});
        continue;
      }
      dead.push({ id: entry.id, createdAt: Number(entry.createdAt) || Date.now(), meta: {
        cwd: meta.cwd, title: str(meta.title), agent: str(meta.agent), sessionId: str(meta.sessionId), agentOnly: meta.agentOnly === true, codexLog: str(meta.codexLog), owner: str(meta.owner)
      } });
    }
    return { attached: [], kept: [], dead };
  }
  function forgetEntry(id) {
    if (TERMINAL_ID.test(id) && !terminals.has(id)) removeEntry(id);
  }
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
    const c = Math.min(Math.floor(cols), MAX_SIZE), r = Math.min(Math.floor(rows), MAX_SIZE);
    try { terminal.proc.resize(c, r); } catch { return; }
    if (terminal.cols !== c || terminal.rows !== r) {
      terminal.cols = c;
      terminal.rows = r;
      onResize(id, c, r);
    }
  }
  function size(id) {
    const terminal = terminals.get(id);
    return terminal ? { cols: terminal.cols, rows: terminal.rows } : null;
  }
  function attach(id) {
    const terminal = terminals.get(id);
    return terminal ? { scrollback: terminal.chunks.join("").slice(-SCROLLBACK_CHARS), end: terminal.end, exitCode: terminal.exitCode, cols: terminal.cols, rows: terminal.rows } : null;
  }
  function close(id) {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    terminals.delete(id);
    terminal.closed = true;
    if (terminal.exitCode === null) {
      try { terminal.proc.kill(HANG_UP); } catch {}
    }
    removeEntry(id);
    onChange(getTabs());
    return true;
  }
  const stopAll = () => [...terminals.keys()].forEach(close);
  // The host stops (a service restart, an update): the programs get SIGHUP as a closing terminal would send, their
  // entries stay, and no exit is reported - the next start opens them anew.
  function detachAll() {
    detaching = true;
    for (const terminal of terminals.values()) {
      if (terminal.exitCode === null) try { terminal.proc.kill(HANG_UP); } catch {}
    }
  }
  function link(id, agent, sessionId, { replace = false } = {}) {
    const terminal = terminals.get(id);
    if (terminal && (!terminal.sessionId || (replace && terminal.sessionId !== sessionId))) {
      terminal.agent = agent;
      terminal.sessionId = sessionId;
      saveEntry(terminal);
      onChange(getTabs());
    }
  }
  const getUnlinkedTabs = () => [...terminals.values()].filter(x => !x.sessionId && x.exitCode === null).map(x => ({ id: x.id, pid: x.pid }));
  const countRunning = () => [...terminals.values()].filter(x => x.exitCode === null).length;

  return { open, restore, forgetEntry, input, type, getLastInputAt, setNote, resize, size, attach, close, stopAll, detachAll, link, getTabs, getUnlinkedTabs, countRunning };
}

module.exports = { createTerminals };
