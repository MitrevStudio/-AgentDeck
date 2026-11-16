// The taskbar monitor: a strip on the Windows taskbar, left of the tray icons, showing the computer's network
// traffic, CPU and memory at a glance. Switched on in Settings (prefs.taskbarMonitor), which also picks what it shows;
// Windows only.
//
// Electron cannot put a window inside the taskbar, so this is a frameless window lying over it: never focused,
// letting every click through, and out of the way while a full-screen app has the screen (desktop.js). The page
// (taskbar.js) draws what it is sent and reports how wide that came out; this side places the window.
//
// The window, its page's process and the per-second sampler exist only while the strip is switched on: created when
// it is, destroyed when it is switched off.
//
// It lies on Windows' main taskbar, and only on one that stays along the bottom edge of its display. With none such
// - the taskbar set to hide itself, standing on another edge (Windows 10), Explorer not running - the strip is
// hidden, and shown again once there is one: over anything else it would float above whatever is on the screen.
//
// Staying in front: a click on the taskbar brings the taskbar in front of the strip, and an app going full screen
// must have the strip gone. Both are a change of the foreground window, which Windows reports (desktop.onForeground):
// the strip is raised, or hidden, at once. The round every second remains for what has no event - the taskbar moved
// or resized, Explorer restarted, auto-hide switched - and as the fallback should the event not come.
const { BrowserWindow, screen, ipcMain, nativeTheme } = require("electron");
const path = require("node:path");
const { t } = require("./i18n");
const desktop = require("./desktop");
const { createResources } = require("./host/resources");
const netCounters = require("./host/net-counters");

const TICK_MS = 1000;
const SETTLE_MS = 250;          // after the foreground changed: Windows reports a full-screen app a moment later
const FALLBACK_TRAY = 330;      // room left for the tray icons and the clock when Windows does not say where they begin
const GAP = 6;
const MIN_WIDTH = 40;

// What the page draws of a resources sample (host/resources.js); before the first one, nothing is known.
function device(r) {
  return {
    cpu: typeof r?.cpu === "number" ? r.cpu : null,
    memory: r?.memory?.total > 0 ? { used: r.memory.used, total: r.memory.total } : null,
    net: r?.net ? { rx: r.net.rx, tx: r.net.tx } : null
  };
}

// Where the strip goes: on the taskbar, ending where the tray icons begin; no wider than its content (width), nor
// than a third of the taskbar. found: desktop.taskbar() with its rectangles in DIPs; display: the bounds of the
// display the taskbar is on. null when there is no taskbar to lie on: none found, one that hides itself, or one that
// is not wholly along the bottom edge (on a side or at the top; slid out of the screen).
function place(found, display, width) {
  const bar = found?.bar;
  if (!bar || !display || found.autoHide) return null;
  const bottom = display.y + display.height;
  const flat = bar.width > bar.height * 4 && bar.y >= display.y + display.height / 2 && Math.abs(bar.y + bar.height - bottom) <= 2;
  if (!flat) return null;
  const right = found.tray ? found.tray.x : bar.x + bar.width - FALLBACK_TRAY;
  const w = Math.max(MIN_WIDTH, Math.min(width || MIN_WIDTH, Math.round(bar.width / 3)));
  return { x: Math.round(right - GAP - w), y: bar.y, width: w, height: bar.height };
}

// shown(): the user wants the strip; items(): which of { net, cpu, memory } it shows. taskbar, fullScreenApp,
// taskbarLight, onForeground: desktop.js's (tests put their own in). -> { win (the strip's window while it is switched
// on, else null), sync() (the settings changed), dispose() }.
function createTaskbarMonitor({ shown, items = () => ({ net: true, cpu: true, memory: true }), taskbar = desktop.taskbar,
  fullScreenApp = desktop.fullScreenApp, taskbarLight = desktop.taskbarLight, onForeground = desktop.onForeground }) {
  if (process.platform !== "win32") return { win: null, sync() {}, dispose() {} };
  let win = null, sampler = null, timer = null, settle = null, stopForeground = null;
  let width = 0, light = false, fullScreen = false, ready = false, local = null, reloads = 0, dead = false;

  function send() {
    if (!ready || !win || win.isDestroyed()) return;
    win.webContents.send("taskbar:data", { device: device(local), light, items: items() });
  }
  // Shown in its place and in front, or hidden: nothing to show, a full-screen app, no taskbar to lie on.
  function update() {
    if (!win || win.isDestroyed()) return;
    let bounds = null;
    if (width && !fullScreen) {
      const found = taskbar();
      const bar = found && screen.screenToDipRect(null, found.bar);
      bounds = place(found && { ...found, bar, tray: found.tray && screen.screenToDipRect(null, found.tray) }, bar && screen.getDisplayMatching(bar).bounds, width);
    }
    if (!bounds) return void (win.isVisible() && win.hide());
    const now = win.getBounds();
    if (now.x !== bounds.x || now.y !== bounds.y || now.width !== bounds.width || now.height !== bounds.height) win.setBounds(bounds);
    if (!win.isVisible()) win.showInactive();
    win.moveTop();
  }
  function look() {
    fullScreen = fullScreenApp();
    const was = light;
    light = taskbarLight();
    update();
    if (was !== light) send();
  }
  function tick() {
    look();
    send();
  }
  // Another window came to the front: now, and once more when Windows has made up its mind about a full-screen app.
  function onFront() {
    if (!win) return;
    look();
    clearTimeout(settle);
    settle = setTimeout(look, SETTLE_MS);
  }
  const onIpc = (e, type, value) => {
    if (!win || e.sender !== win.webContents) return;
    if (type === "width" && Number.isFinite(value)) { width = Math.max(0, Math.ceil(value)); update(); } // 0: nothing to show
  };
  const onDisplays = () => update();
  const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"];

  function open() {
    win = new BrowserWindow({
      width: 200, height: 48, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
      hasShadow: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, type: "toolbar", title: t("app.name"),
      webPreferences: {
        preload: path.join(__dirname, "taskbar-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false
      }
    });
    win.setAlwaysOnTop(true, "pop-up-menu");
    // Clicks go through to the taskbar underneath. Not `forward: true`: for that Electron hooks every mouse move in
    // Windows (WH_MOUSE_LL) on this process's main thread, so the pointer of the whole computer would wait whenever
    // that thread is busy. The strip therefore knows nothing of the pointer: no hover, no tooltip.
    win.setIgnoreMouseEvents(true);
    const me = win;
    me.webContents.on("did-finish-load", () => { if (win === me) { ready = true; send(); } });
    me.webContents.on("render-process-gone", () => {
      if (win !== me || me.isDestroyed()) return;
      ready = false;
      if (reloads++ < 3) me.reload();
      else { dead = true; close(); }
    });
    me.loadFile(path.join(__dirname, "taskbar.html"));
    ipcMain.on("taskbar:event", onIpc);
    for (const ev of DISPLAY_EVENTS) screen.on(ev, onDisplays);
    // The apps' light or dark mode changed: Windows' own (the taskbar's) may have changed with it.
    nativeTheme.on("updated", look);
    stopForeground = onForeground(onFront);
    // The traffic counters are read only while traffic is shown.
    sampler = createResources({ interval: TICK_MS, network: () => (items().net ? netCounters.read() : null), onChange: r => { local = r; } });
    sampler.start();
    timer = setInterval(tick, TICK_MS);
    tick();
  }
  function close() {
    clearInterval(timer); timer = null;
    clearTimeout(settle); settle = null;
    sampler?.stop(); sampler = null;
    stopForeground?.(); stopForeground = null;
    ipcMain.removeListener("taskbar:event", onIpc);
    for (const ev of DISPLAY_EVENTS) screen.removeListener(ev, onDisplays);
    nativeTheme.removeListener("updated", look);
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
    width = 0; ready = false; local = null; fullScreen = false;
  }
  // The settings changed. On: the window and the sampler come to be, or take what is shown now; off: both go.
  function sync() {
    if (!shown()) {
      // Switching it off and on again tries a page that kept crashing once more.
      dead = false; reloads = 0;
      return close();
    }
    if (dead) return;
    if (!win) open();
    else send(); // what it shows was changed: at once, not on the next round
  }
  sync();

  return { get win() { return win; }, sync, dispose: close };
}

module.exports = { createTaskbarMonitor, device, place };
