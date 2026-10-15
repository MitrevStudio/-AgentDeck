// The edge menu: a frameless, always-on-top panel at the top edge of the screen. It comes out of the edge handle
// (edge-handle.js) - when the pointer rests on it, or at once on a click - or opens on a global hotkey or from the
// tray. Opened by pointing, it hides again once the cursor has left both the menu and the handle.
// Opening reveals it out of the handle in about 140 ms (bar.js); closing is instant, and nothing inside the menu
// animates: the user wants it to react at once.
const { BrowserWindow, screen, ipcMain } = require("electron");
const path = require("node:path");
const { t } = require("./i18n");
const { createEdgeHandle } = require("./edge-handle");
const desktop = require("./desktop");

const HEIGHT = 580;          // includes the transparent margin that carries the drop shadow
const MAX_WIDTH = 1480;
const LEAVE_MS = 450;        // grace period after the cursor leaves the menu
const POLL_MS = 80;

const within = (p, r, pad = 0) => Boolean(r) && p.x >= r.x - pad && p.x <= r.x + r.width + pad && p.y >= r.y && p.y <= r.y + r.height + pad;

// handle: { shown(), position(), savePosition(x) } - see edge-handle.js.
function createEdgeBar({ preload, handle: handlePrefs, onOpenManager, hotkeyLabel }) {
  const win = new BrowserWindow({
    width: 1200, height: HEIGHT, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: t("app.name"),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.loadFile(path.join(__dirname, "bar.html"));

  // mode: "hover" closes when the cursor leaves; "hotkey" (the hotkey, the tray, a click on the handle) stays until
  // Esc, a click elsewhere or an action.
  // held: a terminal is being brought up from the menu; it takes the focus, which must not close the menu yet.
  // kept: a voice command is being spoken; neither the pointer leaving nor a click elsewhere closes the menu then, and
  // once it is over, a menu that lost the focus meanwhile goes.
  let visible = false, mode = "", pinned = false, held = false, kept = false, blurred = false, focused = false, leftAt = 0, watch = null;
  const send = ev => { if (!win.isDestroyed()) win.webContents.send("bar:event", ev); };

  const handle = createEdgeHandle({
    ...handlePrefs,
    onIntent: () => show("hover"),
    onClick: () => show("hotkey"),
    onDragStart: () => hide()
  });

  // Under the handle when it is on the cursor's display (or the handle brought the menu out); otherwise centred on
  // the display the cursor is on. origin: the handle's place in the window, where the reveal starts.
  function place(how) {
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const tab = handle.bounds();
    const anchored = tab && (how === "hover" || screen.getDisplayMatching(tab).id === cursor.id);
    const b = anchored ? screen.getDisplayMatching(tab).bounds : cursor.bounds;
    const width = Math.min(MAX_WIDTH, Math.round(b.width * 0.9));
    const centre = anchored ? tab.x + tab.width / 2 : b.x + b.width / 2;
    const x = Math.round(Math.min(Math.max(centre - width / 2, b.x), b.x + b.width - width));
    win.setBounds({ x, y: b.y, width, height: HEIGHT });
    return { x: Math.round(centre - handle.WIDTH / 2 - x), width: handle.WIDTH, height: handle.HEIGHT };
  }

  function show(how) {
    if (visible) {
      // The hotkey or a click on the handle keeps a menu that came out on hover, and gives it the keyboard.
      if (how === "hotkey") { mode = how; win.focus(); send({ type: "focus" }); }
      return;
    }
    const origin = place(how);
    visible = true; mode = how; pinned = false; held = false; blurred = false; focused = false; leftAt = 0;
    // Tell the page first so it starts rendering while the window is being shown.
    send({ type: "show", mode: how, hotkey: hotkeyLabel(), handle: handlePrefs.shown(), origin, motion: desktop.motionAllowed() });
    // On hover the menu must not steal keyboard focus from what the user was doing; a click inside activates it.
    if (how === "hotkey") { win.show(); win.focus(); } else win.showInactive();
    handle.setOpen(true);
    clearInterval(watch);
    watch = setInterval(watchPointer, POLL_MS);
  }
  function hide() {
    if (!visible) return;
    visible = false; focused = false;
    clearInterval(watch);
    win.hide();
    send({ type: "hide" });
    handle.setOpen(false);
  }

  // Hover mode: the menu goes once the cursor has been off it and off the handle for a moment. While something is
  // typed into the search, leaving with the mouse must not throw it away.
  function watchPointer() {
    if (win.isDestroyed() || mode !== "hover" || pinned || kept) return;
    const p = screen.getCursorScreenPoint();
    if (within(p, win.getBounds(), 12) || within(p, handle.bounds())) leftAt = 0;
    else if (!leftAt) leftAt = Date.now();
    else if (Date.now() - leftAt >= LEAVE_MS) hide();
  }

  // Activating the menu brings it to the front; the handle stays on top of it as its grip.
  win.on("focus", () => { focused = true; handle.raise(); });
  win.on("blur", () => {
    if (!focused || !visible) return;
    if (held || kept) blurred = true;
    else hide();
  });
  function keepOpen(on) {
    if (kept === Boolean(on)) return;
    kept = Boolean(on);
    if (!kept && visible && blurred && !win.isFocused()) hide();
    if (kept) blurred = false;
  }

  ipcMain.on("bar:command", (e, cmd, arg) => {
    if (e.sender !== win.webContents) return;
    if (cmd === "hide") hide();
    if (cmd === "pin") pinned = Boolean(arg);
    if (cmd === "hold") held = Boolean(arg);
    if (cmd === "open-manager") { hide(); onOpenManager(); }
  });

  return {
    win, handleWin: handle.win, show, hide, keepOpen, syncHandle: handle.sync,
    // -> whether the menu is open now.
    toggle: () => { if (visible) hide(); else show("hotkey"); return visible; },
    isVisible: () => visible
  };
}

module.exports = { createEdgeBar };
