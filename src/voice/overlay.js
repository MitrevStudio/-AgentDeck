// The floating voice panel (ui/overlay.html): a pill at the bottom centre of the display the cursor is on, 24 px
// above the work-area bottom (the taskbar). It never takes focus - the window the user is dictating into must stay
// the foreground window - and the window around the pill is click-through: the page gives the window its shape (the
// pill with room for its shadow, see setShape), and outside it Windows passes every click to what is below. Nothing
// tracks the cursor for that, so nothing can lose track of it.
//
// The window has a fixed size, large enough for the tallest state; the pill morphs inside it, so a state change
// never resizes the window mid-animation. It also hosts the read-aloud player (see `player`), since the panel is on
// screen for the whole reading anyway.
const { BrowserWindow, ipcMain, screen } = require("electron");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { t } = require("../i18n");
const { createLog } = require("./log-file");

// userData/logs/overlay.log: shows and where, the shapes reported, hover changes and button actions - to tell, when a
// button "does nothing", whether the window never got the pointer (hover is the page's own) or the click never arrived.
const writeLog = createLog("overlay.log");
const diag = (...parts) => writeLog([new Date().toISOString(), ...parts].join(" "));
const fmtBox = b => (b ? `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}` : "none");

const WIDTH = 380;          // transparent canvas around the pill: room for the error card and its shadow
const HEIGHT = 236;         // the card with its whole text (shown while the pointer rests on it), or the key hints
const PAD_BOTTOM = 26;      // transparent room below the pill for its shadow (matches --pad-bottom in overlay.css)
const BOTTOM_GAP = 24;      // the pill's bottom edge sits this far above the work-area bottom
const REVEAL_TIMEOUT_MS = 250; // show anyway if the page has not confirmed the new state by then
const EXIT_MS = 240;        // the page's exit animation; the window is hidden after it
const NOTICE_MS = 3500;
const SUCCESS_MS = 1200;
// confirm and choices: a voice command's card (command-runner.js), which goes away only when the command does.
const STATES = new Set(["listening", "transcribing", "success", "error", "preparing", "speaking", "notice", "confirm", "choices"]);
// States that go away by themselves unless something replaced them.
const AUTO_HIDE = { notice: NOTICE_MS, success: SUCCESS_MS };

// A notice: {title, detail, preview?, actions?: [{id, label, primary}], durationMs?}; preview is a line of quoted
// text, and each action is a button that reports {type: "notice-action", id}.
//
// events: "action" {type: "retry", jobId} | {type: "close"} | {type: "pause"} | {type: "stop"} | {type: "speed", speed}
//                   | {type: "mode", mode} (the mode chip while recording) | {type: "notice-action", id}
//                   | {type: "run"} | {type: "cancel"} | {type: "choose", index} | {type: "hold", on} (a command's card;
//                     hold: the pointer rests on it) | {type: "finish"} (a click on the pill while a command is spoken)
//         "player" {id, type: "started" | "ended" | "error", message?}
//         "hidden" - the panel went away: closed, timed out, or about to show something fresh
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
  let autoHide = null; // {left, since}: what the auto-hide has left; since is null while the pointer holds it
  let exitTimer = null;
  let playerId = null;
  let destroyed = false;

  const alive = () => Boolean(win && !win.isDestroyed());
  const isOurs = e => alive() && e.sender === win.webContents;

  // The window's shape: what the page last reported, in window coordinates. It is the window region, so it clips
  // both what is drawn and where the mouse reaches the window; Windows keeps it, and only a new DPI (another display,
  // a remote session at another scale) needs it set again, since it is scaled to device pixels when set. Until the
  // page has reported one the window has no area at all - never a transparent pane that swallows clicks.
  const NO_SHAPE = [{ x: 0, y: 0, width: 0, height: 0 }];
  let shape = null;
  let loggedState = null;
  const applyShape = () => { if (alive()) win.setShape(shape || NO_SHAPE); };

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
    w.setShape(NO_SHAPE);
    // A crashed page, or one that never loaded, takes its window along; the next show() or reading makes a new one.
    const lost = () => {
      if (win === w) { win = null; loaded = null; visible = false; shape = null; }
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
    applyShape(); // scaled for the display it is on now
  }

  function reveal() {
    clearTimeout(revealTimer);
    revealSeq = 0;
    if (!visible || !alive() || win.isVisible()) return;
    place();
    win.showInactive();
    // On top of the always-on-top band too: a window that turned topmost while the panel was away would cover it.
    win.moveTop();
    const b = win.getBounds();
    diag(`reveal win=${fmtBox(b)} scale=${screen.getDisplayMatching(b).scaleFactor}`);
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
      if (alive() && win.isVisible()) { place(); win.moveTop(); } // still playing the exit animation: re-enter where it belongs now
      else {
        revealSeq = id;
        clearTimeout(revealTimer);
        revealTimer = setTimeout(reveal, REVEAL_TIMEOUT_MS);
      }
    }
    send("voice:overlay-state", { seq: id, state: next, data });
    if (state !== loggedState) { loggedState = state; diag(`show ${next}`); }
    autoHide = null;
    if (AUTO_HIDE[next]) armAutoHide(Number(d.durationMs) > 0 ? Number(d.durationMs) : AUTO_HIDE[next]);
  }

  function armAutoHide(ms) {
    clearTimeout(autoHideTimer);
    autoHide = { left: ms, since: Date.now() };
    autoHideTimer = setTimeout(hide, ms);
  }
  // The pointer resting on the panel holds it (the page stops the notice's hairline too); it goes on from there.
  function holdAutoHide(on) {
    if (!autoHide || on === (autoHide.since == null)) return;
    if (!on) return armAutoHide(autoHide.left);
    clearTimeout(autoHideTimer);
    autoHide.left = Math.max(0, autoHide.left - (Date.now() - autoHide.since));
    autoHide.since = null;
  }

  // Partial update of the current state: {level, elapsed} / {mode} while listening; {rewriting: mode} while
  // transcribing; {paused} / {speed} / {title} while speaking.
  function update(d = {}) {
    if (!state) return;
    data = { ...data, ...d };
    send("voice:overlay-update", d);
  }

  function hide() {
    clearTimeout(autoHideTimer);
    autoHide = null;
    clearTimeout(revealTimer);
    revealSeq = 0;
    if (!visible && !state) return;
    visible = false;
    state = null;
    data = {};
    loggedState = null;
    diag("hide");
    send("voice:overlay-state", { seq: ++seq, state: null, data: {} });
    emitter.emit("hidden");
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
    diag(`action ${type}`);
    const ev = { type };
    if (type === "retry") ev.jobId = arg ?? data.jobId ?? null;
    if (type === "speed") { ev.speed = Number(arg); data.speed = ev.speed; }
    if (type === "mode") ev.mode = String(arg);
    if (type === "choose") ev.index = Number(arg);
    if (type === "hold") ev.on = Boolean(arg);
    if (type === "notice-action") ev.id = String(arg);
    if (type === "close") hide();
    emitter.emit("action", ev);
  }

  // The page reports the window's shape whenever the pill's size or the tip above it changes (rectangles in window
  // coordinates, at most a few), and before it confirms a state, so a hidden window is shown with its shape in place.
  function onShape(e, rects) {
    if (!isOurs(e) || !Array.isArray(rects)) return;
    const clamp = (v, max) => Math.min(max, Math.max(0, v));
    const next = [];
    for (const r of rects.slice(0, 4)) {
      if (!r || !["x", "y", "width", "height"].every(k => Number.isFinite(r[k]))) continue;
      const x = clamp(Math.floor(r.x), WIDTH), y = clamp(Math.floor(r.y), HEIGHT);
      const right = clamp(Math.ceil(r.x + r.width), WIDTH), bottom = clamp(Math.ceil(r.y + r.height), HEIGHT);
      if (right > x && bottom > y) next.push({ x, y, width: right - x, height: bottom - y });
    }
    shape = next.length ? next : null;
    applyShape();
    diag(`shape ${shape ? shape.map(fmtBox).join(" + ") : "none"} state=${state || "-"}`);
  }

  // The page tells when the pointer is over the panel - the window gets the mouse only inside its shape - and the
  // pointer resting on it holds a notice that would go away by itself.
  function onHover(e, on) {
    if (!isOurs(e)) return;
    on = Boolean(on) && visible;
    holdAutoHide(on);
    diag(`hover=${on}`);
  }

  // Another display, a new resolution or scale (a remote session reconnected from another computer): back to the
  // bottom centre where it belongs, with the shape scaled anew.
  function onDisplays() {
    if (!visible || !alive() || !win.isVisible()) return;
    place();
    diag(`displays changed win=${fmtBox(win.getBounds())}`);
  }

  function onPlayer(e, msg) {
    if (!isOurs(e) || !msg || msg.id !== playerId) return;
    if (msg.type === "ended" || msg.type === "error") playerId = null;
    emitter.emit("player", msg);
    if (stale && !visible) refresh();
  }

  ipcMain.on("voice:overlay-size", onSize);
  ipcMain.on("voice:overlay-action", onActionMsg);
  ipcMain.on("voice:overlay-shape", onShape);
  ipcMain.on("voice:overlay-hover", onHover);
  ipcMain.on("voice:overlay-player", onPlayer);
  screen.on("display-metrics-changed", onDisplays);
  screen.on("display-added", onDisplays);
  screen.on("display-removed", onDisplays);

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
    ipcMain.removeListener("voice:overlay-shape", onShape);
    ipcMain.removeListener("voice:overlay-hover", onHover);
    ipcMain.removeListener("voice:overlay-player", onPlayer);
    screen.removeListener("display-metrics-changed", onDisplays);
    screen.removeListener("display-added", onDisplays);
    screen.removeListener("display-removed", onDisplays);
    if (alive()) win.destroy();
    win = null;
  }

  ensureWindow();

  Object.assign(emitter, { show, update, hide, destroy, refresh, player, isVisible: () => visible });
  return Object.defineProperty(emitter, "state", { get: () => state });
}

module.exports = { createOverlay, NOTICE_MS, SUCCESS_MS };
