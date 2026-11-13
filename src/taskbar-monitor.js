// The taskbar monitor: a strip on the Windows taskbar, left of the tray icons, showing the computer's network
// traffic, CPU and memory at a glance. Switched on in Settings (prefs.taskbarMonitor), which also picks what it shows;
// Windows only.
//
// Electron cannot put a window inside the taskbar, so this is a frameless window lying over it: never focused,
// re-raised every second (a click on the taskbar brings the taskbar to the front), letting every click through, and out of the way while a
// full-screen app has the screen (desktop.js). The page (taskbar.js) draws what it is sent and reports how wide that
// came out; this side places the window.
//
// The computer is measured every second by a sampler of its own, running only while the strip is on.
const { BrowserWindow, screen, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { t } = require("./i18n");
const desktop = require("./desktop");
const { createResources } = require("./host/resources");
const netCounters = require("./host/net-counters");

const TICK_MS = 1000;
const FALLBACK_HEIGHT = 48;     // the taskbar's height when Windows will not tell (auto-hidden, or no koffi)
const FALLBACK_TRAY = 330;      // room left for the tray icons and the clock then
const GAP = 6;
const MIN_WIDTH = 40;
const SAVE_MS = 60000;
const MODE_TICKS = 30;          // how often Windows is asked whether its taskbar is light

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Today's traffic of this computer, added up while the strip is on and kept across restarts (file).
function createDayTraffic(file) {
  let day = dayKey(), rx = 0, tx = 0, last = null, savedAt = 0, dirty = false;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved?.day === day && saved.rx >= 0 && saved.tx >= 0) { rx = saved.rx; tx = saved.tx; }
  } catch {}
  function save() {
    if (!dirty) return;
    dirty = false; savedAt = Date.now();
    // A few bytes once a minute, written in one go: two writes in flight could land in either order.
    try { fs.writeFileSync(file, JSON.stringify({ day, rx, tx })); } catch {}
  }
  return {
    // net: a resources sample's traffic ({ rxBytes, txBytes } since boot), or null.
    add(net) {
      if (dayKey() !== day) { day = dayKey(); rx = 0; tx = 0; }
      if (!net) { last = null; return; }
      if (last && net.rxBytes >= last.rxBytes && net.txBytes >= last.txBytes) {
        rx += net.rxBytes - last.rxBytes; tx += net.txBytes - last.txBytes; dirty = true;
      }
      last = net;
      if (Date.now() - savedAt >= SAVE_MS) save();
    },
    pause() { last = null; save(); },
    get: () => ({ rx, tx })
  };
}

// Whether Windows itself (the taskbar, Start) is in light mode - its own switch, apart from the apps' mode that
// Electron reports. cb(true|false); dark when the registry does not say.
function systemLight(cb) {
  execFile("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", "/v", "SystemUsesLightTheme"],
    { windowsHide: true, timeout: 5000 }, (err, out) => cb(!err && /REG_DWORD\s+0x0*1\b/.test(String(out))));
}

// What the page draws of a resources sample (host/resources.js); before the first one, nothing is known.
function device(r) {
  return {
    cpu: typeof r?.cpu === "number" ? r.cpu : null,
    memory: r?.memory?.total > 0 ? { used: r.memory.used, total: r.memory.total } : null,
    net: r?.net ? { rx: r.net.rx, tx: r.net.tx } : null
  };
}

// shown(): the user wants the strip; items(): which of { net, cpu, memory } it shows; trafficFile: where today's
// traffic is kept.
function createTaskbarMonitor({ shown, items = () => ({ net: true, cpu: true, memory: true }), trafficFile }) {
  if (process.platform !== "win32") return { win: null, sync() {}, dispose() {} };
  const win = new BrowserWindow({
    width: 200, height: FALLBACK_HEIGHT, show: false, frame: false, transparent: true, backgroundColor: "#00000000",
    hasShadow: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, type: "toolbar", title: t("app.name"),
    webPreferences: {
      preload: path.join(__dirname, "taskbar-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });
  win.setAlwaysOnTop(true, "pop-up-menu");
  // Clicks go through to the taskbar underneath; the pointer is still forwarded, so the tooltip shows.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "taskbar.html"));

  let width = 0, light = false, ticks = 0, fullScreen = false, dead = false, ready = false, timer = null, local = null;
  const today = createDayTraffic(trafficFile);
  const sampler = createResources({ interval: TICK_MS, network: netCounters.read, onChange: r => { local = r; today.add(r.net); } });

  // On the taskbar, ending where the tray icons begin; no wider than the content, nor than a third of the taskbar.
  function place() {
    const display = screen.getPrimaryDisplay(), b = display.bounds;
    const found = desktop.taskbar();
    const bar = found && screen.screenToDipRect(null, found.bar);
    const tray = found?.tray && screen.screenToDipRect(null, found.tray);
    // Only a taskbar along the bottom edge (Windows 11 has no other); otherwise the bottom strip of the display.
    const flat = bar && bar.width > bar.height * 4 && bar.y >= b.y + b.height / 2 && bar.y < b.y + b.height - 8;
    const strip = flat ? bar : { x: b.x, y: b.y + b.height - FALLBACK_HEIGHT, width: b.width, height: FALLBACK_HEIGHT };
    const right = flat && tray ? tray.x : strip.x + strip.width - FALLBACK_TRAY;
    const w = Math.max(MIN_WIDTH, Math.min(width || MIN_WIDTH, Math.round(strip.width / 3)));
    win.setBounds({ x: Math.round(right - GAP - w), y: strip.y, width: w, height: strip.height });
  }

  function send() {
    if (!ready || win.isDestroyed()) return;
    win.webContents.send("taskbar:data", { device: device(local), today: today.get(), light, items: items() });
  }

  function tick() {
    if (win.isDestroyed()) return;
    if (ticks++ % MODE_TICKS === 0) systemLight(v => { light = v; });
    const now = desktop.fullScreenApp();
    if (now !== fullScreen) { fullScreen = now; show(); }
    if (win.isVisible()) { place(); win.moveTop(); }
    send();
  }
  function show() {
    if (shown() && !fullScreen && !dead && width) {
      place();
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
    } else if (win.isVisible()) win.hide();
  }
  // Runs only while the user wants the strip: nothing is measured otherwise.
  function sync() {
    if (win.isDestroyed()) return;
    if (shown() && !dead) {
      if (!timer) { ticks = 0; sampler.start(); timer = setInterval(tick, TICK_MS); tick(); }
      else send(); // what it shows was changed: at once, not on the next round
    } else if (timer) {
      clearInterval(timer); timer = null;
      sampler.stop(); today.pause();
      fullScreen = false;
    }
    show();
  }

  const onIpc = (e, type, value) => {
    if (e.sender !== win.webContents) return;
    if (type === "width" && Number.isFinite(value)) { width = Math.max(0, Math.ceil(value)); show(); } // 0: nothing to show
  };
  ipcMain.on("taskbar:event", onIpc);
  win.webContents.on("did-finish-load", () => { ready = true; send(); });
  let reloads = 0;
  win.webContents.on("render-process-gone", () => {
    ready = false;
    if (win.isDestroyed()) return;
    if (reloads++ < 3) win.reload();
    else { dead = true; sync(); }
  });
  const onDisplays = () => { if (!win.isDestroyed()) show(); };
  for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(ev, onDisplays);
  sync();

  return {
    win, sync,
    dispose() {
      clearInterval(timer); timer = null;
      sampler.stop(); today.pause();
      ipcMain.removeListener("taskbar:event", onIpc);
      for (const ev of ["display-added", "display-removed", "display-metrics-changed"]) screen.removeListener(ev, onDisplays);
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

module.exports = { createTaskbarMonitor, createDayTraffic, device };
