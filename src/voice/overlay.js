// The floating voice panel (ui/overlay.html): a pill at the bottom centre of the display the cursor is on, 24 px
// above the work-area bottom (the taskbar). It never takes focus - the window the user is dictating into must stay
// the foreground window - and the window around the pill is click-through: only while the pointer is over the
// pill itself does the window take mouse input (the page reports that on "voice:overlay-interactive").
//
// The window has a fixed size, large enough for the tallest state; the pill morphs inside it, so a state change
// never resizes the window mid-animation. It also hosts the read-aloud player (see `player`), since the panel is on
// screen for the whole reading anyway.
const { BrowserWindow, ipcMain, screen } = require("electron");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { t } = require("../i18n");

const WIDTH = 380;          // transparent canvas around the pill: room for the error card and its shadow
const HEIGHT = 236;         // the card with its whole text (shown while the pointer rests on it), or the key hints
const PAD_BOTTOM = 26;      // transparent room below the pill for its shadow (matches --pad-bottom in overlay.css)
const BOTTOM_GAP = 24;      // the pill's bottom edge sits this far above the work-area bottom
const REVEAL_TIMEOUT_MS = 250; // show anyway if the page has not confirmed the new state by then
const EXIT_MS = 240;        // the page's exit animation; the window is hidden after it
const NOTICE_MS = 3500;
const SUCCESS_MS = 1200;
const STATES = new Set(["listening", "transcribing", "success", "error", "preparing", "speaking", "notice"]);
// States that go away by themselves unless something replaced them.
const AUTO_HIDE = { notice: NOTICE_MS, success: SUCCESS_MS };

// events: "action" {type: "retry", jobId} | {type: "close"} | {type: "pause"} | {type: "stop"} | {type: "speed", speed}
//         "player" {id, type: "started" | "ended" | "error", message?}
function createOverlay({ preloadPath = path.join(__dirname, "ui", "overlay-preload.js"), onAction } = {}) {
  const emitter = new EventEmitter();
  if (onAction) emitter.on("action", onAction);

  let win = null;
  let loaded = null;
  let visible = false;
  let anchor = null;
  let state = null;
  let data = {};
  let seq = 0;
  let revealSeq = 0;
  let revealTimer = null;
  let autoHideTimer = null;
  let exitTimer = null;
  let playerId = null;
  let destroyed = false;

  const alive = () => Boolean(win && !win.isDestroyed());
  const isOurs = e => alive() && e.sender === win.webContents;
  const clickThrough = () => { if (alive()) win.setIgnoreMouseEvents(true, { forward: true }); };

  // Only show() and a new reading bring the window (back): after a renderer crash, or once destroyed at quit, nothing
  // else may conjure one up.
  function ensureWindow() {
    if (alive() || destroyed) return;
    const w = new BrowserWindow({
      width: WIDTH, height: HEIGHT,
      show: false, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, thickFrame: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true, type: "toolbar", title: "AgentDeck",
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    w.setAlwaysOnTop(true, "screen-saver");
    w.setIgnoreMouseEvents(true, { forward: true });
    // A crashed page, or one that never loaded, takes its window along; the next show() or reading makes a new one.
    const lost = () => {
      if (win === w) { win = null; loaded = null; visible = false; }
      if (playerId != null) emitter.emit("player", { id: playerId, type: "error", message: t("voice.errors.panelCrashed") });
      playerId = null;
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.on("render-process-gone", lost);
    win = w;
    loaded = w.loadFile(path.join(__dirname, "ui", "overlay.html")).catch(lost);
  }

  // Everything goes through the one load promise, so messages keep their order. No window, nothing to tell.
  function send(channel, msg) {
    if (!alive()) return;
    const w = win;
    loaded.then(() => { if (!w.isDestroyed()) w.webContents.send(channel, msg); });
  }

  // Bottom centre of the display the cursor was on when the panel opened. The transparent margin under the pill may
  // reach over the taskbar; it is click-through, and never past the bottom of the display.
  function place() {
    if (!alive() || !anchor) return;
    const display = screen.getDisplayNearestPoint(anchor);
    const wa = display.workArea, b = display.bounds;
    const bottom = Math.min(wa.y + wa.height - BOTTOM_GAP + PAD_BOTTOM, b.y + b.height);
    const x = Math.round(wa.x + (wa.width - WIDTH) / 2);
    const y = Math.max(wa.y, Math.round(bottom - HEIGHT));
    win.setBounds({ x, y, width: WIDTH, height: HEIGHT });
  }

  function reveal() {
    clearTimeout(revealTimer);
    revealSeq = 0;
    if (!visible || !alive()) return;
    if (!win.isVisible()) { place(); win.showInactive(); }
  }

  // A hidden panel opens at the bottom of the cursor's display; a visible one morphs into the new state in place.
  // hide() and then show() gives a fresh panel (it re-enters, on whichever display the cursor is on now).
  function show(next, d = {}) {
    if (!STATES.has(next)) throw new Error(`unknown overlay state: ${next}`);
    ensureWindow();
    clearTimeout(autoHideTimer);
    state = next;
    data = { ...d };
    const id = ++seq;
    if (!visible) {
      visible = true;
      anchor = screen.getCursorScreenPoint();
      clearTimeout(exitTimer);
      if (alive() && win.isVisible()) place(); // still playing the exit animation: re-enter where it belongs now
      else {
        revealSeq = id;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(reveal, REVEAL_TIMEOUT_MS);
      }
    }
    send("voice:overlay-state", { seq: id, state: next, data });
    if (AUTO_HIDE[next]) {
      const ms = Number(d.durationMs) > 0 ? Number(d.durationMs) : AUTO_HIDE[next];
      autoHideTimer = setTimeout(() => { if (state === next) hide(); }, ms);
    }
  }

  // Partial update of the current state: {level, elapsed} while listening; {paused} / {speed} / {title} while speaking.
  function update(d = {}) {
    if (!state) return;
    data = { ...data, ...d };
    send("voice:overlay-update", d);
  }

  function hide() {
    clearTimeout(autoHideTimer);
    clearTimeout(revealTimer);
    revealSeq = 0;
    if (!visible && !state) return;
    visible = false;
    state = null;
    data = {};
    clickThrough();
    send("voice:overlay-state", { seq: ++seq, state: null, data: {} });
    // The page plays its exit animation first; a show() in the meantime keeps the window.
    clearTimeout(exitTimer);
    exitTimer = setTimeout(() => {
      if (!visible && alive()) win.hide();
      if (stale) refresh();
    }, EXIT_MS);
  }

  // A new UI language: the page is rebuilt, but never under a panel that is on screen or playing a reading - then
  // as soon as it is gone.
  let stale = false;
  function refresh() {
    if (destroyed) return;
    if (visible || playerId != null) { stale = true; return; }
    stale = false;
    const w = win;
    win = null; loaded = null;
    if (w && !w.isDestroyed()) w.destroy();
    ensureWindow();
  }

  // The page confirms each state once it has rendered it; a hidden window is shown only then, so it never flashes
  // the previous content.
  function onSize(e, s) {
    if (!isOurs(e)) return;
    if (revealSeq && s >= revealSeq) reveal();
  }

  function onActionMsg(e, type, arg) {
    if (!isOurs(e)) return;
    const ev = { type };
    if (type === "retry") ev.jobId = arg ?? data.jobId ?? null;
    if (type === "speed") { ev.speed = Number(arg); data.speed = ev.speed; }
    if (type === "close") hide();
    emitter.emit("action", ev);
  }

  // Only while the pointer is over the pill does the window take mouse input; everywhere else clicks fall through.
  function onInteractive(e, on) {
    if (!isOurs(e)) return;
    win.setIgnoreMouseEvents(!(on && visible), { forward: true });
  }

  function onPlayer(e, msg) {
    if (!isOurs(e) || !msg || msg.id !== playerId) return;
    if (msg.type === "ended" || msg.type === "error") playerId = null;
    emitter.emit("player", msg);
    if (stale && !visible) refresh();
  }

  ipcMain.on("voice:overlay-size", onSize);
  ipcMain.on("voice:overlay-action", onActionMsg);
  ipcMain.on("voice:overlay-interactive", onInteractive);
  ipcMain.on("voice:overlay-player", onPlayer);

  // Read-aloud audio, played by the panel page. `id` ties every call and event to one reading.
  const audio = msg => send("voice:overlay-audio", msg);
  const player = {
    begin({ id, sampleRate = 24000, speed = 1, startBufferMs = 750 }) {
      ensureWindow();
      playerId = id;
      audio({ cmd: "begin", id, sampleRate, speed, startBufferMs });
    },
    push: (id, pcm) => audio({ cmd: "push", id, pcm }),
    end: id => audio({ cmd: "end", id }), // no more audio is coming: play out what is buffered, then "ended"
    pause: id => audio({ cmd: "pause", id }),
    resume: id => audio({ cmd: "resume", id }),
    setSpeed: (id, speed) => audio({ cmd: "speed", id, speed }),
    stop(id) {
      if (playerId === id) playerId = null;
      audio({ cmd: "stop", id });
    }
  };

  function destroy() {
    destroyed = true;
    hide();
    clearTimeout(exitTimer);
    ipcMain.removeListener("voice:overlay-size", onSize);
    ipcMain.removeListener("voice:overlay-action", onActionMsg);
    ipcMain.removeListener("voice:overlay-interactive", onInteractive);
    ipcMain.removeListener("voice:overlay-player", onPlayer);
    if (alive()) win.destroy();
    win = null;
  }

  ensureWindow();

  Object.assign(emitter, { show, update, hide, destroy, refresh, player, isVisible: () => visible });
  return Object.defineProperty(emitter, "state", { get: () => state });
}

module.exports = { createOverlay, NOTICE_MS, SUCCESS_MS };
