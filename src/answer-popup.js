// The small window a voice question's answer appears in: top right of the screen the pointer is on, above other
// windows, without taking the focus. The page (answer.html) closes it by itself after a while unless the pointer
// rests on it, and asks for the height its text needs.
const path = require("node:path");
const { BrowserWindow, ipcMain, screen } = require("electron");

const WIDTH = 460, MIN_H = 140, MAX_H = 560, MARGIN = 16;

// preload: the app's preload (the page uses its "manager.onAnswer"/"answerAction" and prefs); background() -> colour;
// copy(text) -> Promise; icon: the window icon.
function createAnswerPopup({ preload, background, copy, icon }) {
  let win = null, ready = null, last = null;

  function ensure() {
    if (win && !win.isDestroyed()) return;
    win = new BrowserWindow({
      width: WIDTH, height: 220, show: false, frame: false, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: true, backgroundColor: background(), icon,
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    ready = new Promise(r => win.webContents.once("did-finish-load", r));
    win.loadFile(path.join(__dirname, "answer.html"));
    win.on("closed", () => { win = null; ready = null; });
  }

  function place(height) {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const h = Math.max(MIN_H, Math.min(MAX_H, Math.round(height || 220)));
    win.setBounds({ x: wa.x + wa.width - WIDTH - MARGIN, y: wa.y + MARGIN, width: WIDTH, height: h });
  }

  ipcMain.on("answer:action", (e, a) => {
    if (!win || win.isDestroyed() || e.sender !== win.webContents || !a || typeof a !== "object") return;
    if (a.type === "close") win.hide();
    else if (a.type === "height" && win.isVisible()) place(Number(a.height));
    else if (a.type === "copy" && last) copy(last.answer).catch(() => {});
  });

  return {
    // {question, answer, copied}
    async show(a) {
      last = a;
      ensure();
      await ready;
      if (!win || win.isDestroyed()) return;
      place(220);
      win.webContents.send("answer:show", a);
      win.showInactive();
    },
    dispose() { if (win && !win.isDestroyed()) win.destroy(); }
  };
}

module.exports = { createAnswerPopup };
