// The edge menu: a frameless, always-on-top strip that appears at the top edge of the screen when the cursor
// rests against the middle of that edge (or on a global hotkey) and hides again once the cursor leaves.
// It shows and hides instantly; the user wants no animations or delays inside it.
//
// Hover detection polls the cursor position instead of placing an invisible window on the edge, so nothing ever
// sits on top of other applications' title bars or browser tabs while the menu is closed.
const { BrowserWindow, screen, ipcMain } = require("electron");
const path = require("node:path");
const { t } = require("./i18n");

const HEIGHT = 580;          // includes the transparent margin that carries the drop shadow
const MAX_WIDTH = 1480;
const DWELL_MS = 300;        // the cursor must rest on the edge this long, so a quick flick to a tab does nothing
const LEAVE_MS = 450;        // grace period after the cursor leaves the menu
const POLL_MS = 80;
const ZONE = [0.3, 0.7];     // only the middle of the top edge; corners keep window buttons and tabs reachable

function atTopEdge(p) {
  const d = screen.getDisplayNearestPoint(p).bounds;
  if (p.y > d.y + 1) return false;
  const rel = (p.x - d.x) / d.width;
  if (rel < ZONE[0] || rel > ZONE[1]) return false;
  // Not an edge when another monitor continues above this one.
  return !screen.getAllDisplays().some(o => o.bounds.y + o.bounds.height === d.y && p.x >= o.bounds.x && p.x < o.bounds.x + o.bounds.width);
}

function createEdgeBar({ preload, hoverEnabled, onOpenManager, hotkeyLabel }) {
  const win = new BrowserWindow({
    width: 1200, height: HEIGHT, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: t("app.name"),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  win.loadFile(path.join(__dirname, "bar.html"));

  // mode: "hover" closes when the cursor leaves; "hotkey" stays until Esc, a click elsewhere or an action.
  let visible = false, mode = "", pinned = false, focused = false, edgeSince = 0, leftAt = 0;
  const send = ev => { if (!win.isDestroyed()) win.webContents.send("bar:event", ev); };

  function show(how) {
    if (visible) {
      if (how === "hotkey") { mode = how; win.focus(); send({ type: "focus" }); }
      return;
    }
    const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
    const width = Math.min(MAX_WIDTH, Math.round(b.width * 0.9));
    win.setBounds({ x: Math.round(b.x + (b.width - width) / 2), y: b.y, width, height: HEIGHT });
    visible = true; mode = how; pinned = false; focused = false; leftAt = 0;
    // Tell the page first so it starts rendering while the window is being shown.
    send({ type: "show", mode: how, hotkey: hotkeyLabel() });
    // On hover the menu must not steal keyboard focus from what the user was doing; a click inside activates it.
    if (how === "hotkey") { win.show(); win.focus(); } else win.showInactive();
  }
  function hide() {
    if (!visible) return;
    visible = false; focused = false;
    win.hide();
    send({ type: "hide" });
  }

  win.on("focus", () => { focused = true; });
  win.on("blur", () => { if (focused && visible) hide(); });

  ipcMain.on("bar:command", (e, cmd, arg) => {
    if (e.sender !== win.webContents) return;
    if (cmd === "hide") hide();
    if (cmd === "pin") pinned = Boolean(arg);
    if (cmd === "open-manager") { hide(); onOpenManager(); }
  });

  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);
    const p = screen.getCursorScreenPoint();
    if (!visible) {
      if (!hoverEnabled() || !atTopEdge(p)) { edgeSince = 0; return; }
      if (!edgeSince) edgeSince = Date.now();
      else if (Date.now() - edgeSince >= DWELL_MS) { edgeSince = 0; show("hover"); }
      return;
    }
    // While something is typed into the search, leaving with the mouse must not throw it away.
    if (mode !== "hover" || pinned) return;
    const r = win.getBounds();
    const inside = p.x >= r.x - 12 && p.x <= r.x + r.width + 12 && p.y >= r.y && p.y <= r.y + r.height + 12;
    if (inside) leftAt = 0;
    else if (!leftAt) leftAt = Date.now();
    else if (Date.now() - leftAt >= LEAVE_MS) hide();
  }, POLL_MS);

  return { win, show, hide, toggle: () => (visible ? hide() : show("hotkey")), isVisible: () => visible };
}

module.exports = { createEdgeBar };
