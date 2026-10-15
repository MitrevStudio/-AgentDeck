// The edge handle: a small frosted tab hugging the top edge of the primary display, where the edge menu comes out
// (like the Remote Desktop connection bar). Pointing at it for a moment or clicking it opens the menu; dragging it
// moves it left or right, and the spot is kept as a fraction of the display width.
//
// Only the tab takes clicks, so nothing around it is ever blocked: Windows will not make a window this short (it
// keeps about 39 px), and setShape() cuts it down to the tab. It never takes focus either, and it steps aside while
// a full-screen app or a presentation has the screen. The page (handle.js) reports the pointer; this side decides
// what that means.
const { BrowserWindow, screen, ipcMain } = require("electron");
const path = require("node:path");
const { t } = require("./i18n");
const desktop = require("./desktop");

const WIDTH = 160;
const HEIGHT = 14;              // the tab's height in handle.css (--hd-h)
const INTENT_MS = 120;          // the pointer must rest this long, so passing over the handle opens nothing
const FULL_SCREEN_POLL_MS = 1000;

// shown(): the user wants the handle; position() / savePosition(x): its centre, 0..1 across the display.
// onIntent / onClick open the menu, onDragStart closes it.
function createEdgeHandle({ shown, position, savePosition, onIntent, onClick, onDragStart }) {
  const win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    hasShadow: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, type: "toolbar", title: t("app.name"),
    webPreferences: {
      preload: path.join(__dirname, "handle-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  // The menu's level: it stays reachable over other always-on-top windows, and above the open menu (raise()).
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.loadFile(path.join(__dirname, "handle.html"));

  // open: the menu is out; drag: {offset} while the handle is being dragged; intent: the pending hover open.
  let open = false, drag = null, intent = null, fullScreen = false, dead = false;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send("handle:state", { open, drag: Boolean(drag), motion: desktop.motionAllowed() });
  };
  const cancelIntent = () => { clearTimeout(intent); intent = null; };

  const area = () => screen.getPrimaryDisplay().bounds;
  const clampX = (x, b) => Math.round(Math.min(Math.max(x, b.x), b.x + b.width - WIDTH));
  function place() {
    const b = area();
    win.setBounds({ x: clampX(b.x + position() * b.width - WIDTH / 2, b), y: b.y, width: WIDTH, height: HEIGHT });
    win.setShape([{ x: 0, y: 0, width: WIDTH, height: HEIGHT }]);
  }

  // Shown while the user wants it and no full-screen app is up; placed again on every display change.
  function sync() {
    if (win.isDestroyed() || drag) return;
    if (shown() && !fullScreen && !dead) {
      place();
      if (!win.isVisible()) win.showInactive();
    } else if (win.isVisible()) {
      cancelIntent();
      win.hide();
    }
  }

  ipcMain.on("handle:event", (e, type, x) => {
    if (e.sender !== win.webContents) return;
    if (type === "over") {
      // Only the moment the pointer arrives counts: resting on the handle after a drag or after the menu closed
      // does not open it again.
      cancelIntent();
      if (x === true && !open && !drag) intent = setTimeout(() => { intent = null; onIntent(); }, INTENT_MS);
    } else if (type === "press") cancelIntent();
    else if (type === "click") onClick();
    else if (type === "drag-start" && Number.isFinite(x)) {
      cancelIntent();
      drag = { offset: x - win.getBounds().x };
      onDragStart();
      send();
    } else if (type === "drag" && drag && Number.isFinite(x)) {
      const b = area();
      win.setPosition(clampX(x - drag.offset, b), b.y);
    } else if (type === "drag-end" && drag) {
      drag = null;
      const b = area(), r = win.getBounds();
      savePosition((r.x + WIDTH / 2 - b.x) / b.width);
      send();
    }
  });
  win.webContents.on("did-finish-load", send);
  // A crashed page would leave an invisible tab that still takes clicks.
  let reloads = 0;
  win.webContents.on("render-process-gone", () => {
    drag = null;
    if (win.isDestroyed()) return;
    if (reloads++ < 3) win.reload();
    else { dead = true; sync(); }
  });

  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, sync);
  const poll = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(poll);
    if (!shown()) { fullScreen = false; return; } // switched back on, it shows at once; the next round checks again
    const now = desktop.fullScreenApp();
    if (now !== fullScreen) { fullScreen = now; sync(); }
  }, FULL_SCREEN_POLL_MS);
  sync();

  return {
    win, sync, WIDTH, HEIGHT,
    // The tab on screen (not the taller window around it), or null while it is hidden.
    bounds() {
      if (win.isDestroyed() || !win.isVisible()) return null;
      const { x, y } = win.getBounds();
      return { x, y, width: WIDTH, height: HEIGHT };
    },
    // The open menu shows the handle on top of it, as its grip.
    setOpen(on) {
      open = on;
      if (on) cancelIntent();
      if (on && win.isVisible()) win.moveTop();
      send();
    },
    raise: () => { if (open && win.isVisible()) win.moveTop(); }
  };
}

module.exports = { createEdgeHandle };
