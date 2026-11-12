// The taskbar monitor in a real Chromium: what its page draws, what a switched-off measurement leaves, the tooltips and the width it reports - and, on Windows, the window itself: on the taskbar,
// left of the tray, never focused, gone when switched off or when there is nothing to show.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const testTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-taskbar-ui-'));
  env.AGENTDECK_UI_TEST_TMP = testTemp;
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  const resolved = path.resolve(testTemp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('agentdeck-taskbar-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
const temp = process.env.AGENTDECK_UI_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-taskbar-ui-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {}); // the page's window goes before the strip's own comes

const FIXTURE = `(() => {
  const fx = { sent: [], cb: null };
  window.taskbarMonitor = { send: (type, value) => fx.sent.push([type, value]), onData: cb => { fx.cb = cb; } };
  window.prefs = { language: 'en', themeId: 'dark', resolvedTheme: 'dark', onChanged() {} };
  window.fx = fx;
})();`;
const GIB = 1024 ** 3;
const ALL = { net: true, cpu: true, memory: true };
const local = { cpu: 4.4, memory: { used: 10.4 * GIB, total: 16 * GIB }, net: { rx: 1208.3, tx: 727 } };
const today = { rx: 970.59 * 1024 ** 2, tx: 364.78 * 1024 ** 2 };

app.whenReady().then(async () => {
  const fixtureFile = path.join(temp, 'fixture.js');
  fs.writeFileSync(fixtureFile, FIXTURE);
  const html = fs.readFileSync(path.join(src, 'taskbar.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}">`)
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<script src="i18n.js"></script>', `<script src="${pathToFileURL(fixtureFile).href}"></script><script src="i18n.js"></script>`);
  const file = path.join(temp, 'taskbar.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 900, height: 48, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = globalThis.pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const evaluate = code => Promise.race([win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + ' In: ' + code); }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('No answer from the page: ' + code)), 10000))]);
  const draw = data => evaluate(`fx.cb(${JSON.stringify(data)}); 0`);
  const text = sel => evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(el => el.textContent)`);
  const lastWidth = () => evaluate("fx.sent.filter(m => m[0] === 'width').at(-1)?.[1]");
  await win.loadFile(file);

  await draw({ device: local, today, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑0.71 KB/s', '↓1.18 KB/s', 'CPU4 %', 'MEM65 %']);
  assert.equal(await evaluate("document.querySelectorAll('.device').length"), 1);
  const tip = await evaluate("document.querySelector('.device').title");
  assert.equal(tip, 'This computer\nTraffic today: 1.30 GB (up 364.78 MB / down 970.59 MB)\nNow: up 0.71 KB/s · down 1.18 KB/s\nCPU: 4 %\nMemory: 10.40 GB / 16.00 GB');
  const full = await lastWidth();
  assert.ok(full > 120 && full < 260, `as wide as its text (${full}px)`);
  assert.equal(await evaluate("Math.ceil(document.getElementById('strip').getBoundingClientRect().width)"), full);
  assert.equal(await evaluate('document.documentElement.dataset.taskbar'), 'dark');
  assert.equal(await evaluate("getComputedStyle(document.body).color"), 'rgb(255, 255, 255)');
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgba(0, 0, 0, 0)', 'the taskbar shows through');

  // A light taskbar takes dark text.
  await draw({ device: local, today, light: true, items: ALL });
  assert.equal(await evaluate("getComputedStyle(document.body).color"), 'rgb(17, 17, 17)');

  // Not measured yet (the first sample has no rate, no CPU): dashes, never zeros.
  await draw({ device: { ...local, cpu: null, net: { rx: null, tx: null } }, today, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑—', '↓—', 'CPU—', 'MEM65 %']);
  // No traffic source at all on this computer.
  await draw({ device: { ...local, net: null }, today, light: false, items: ALL });
  assert.deepEqual((await text('.device .cell')).slice(0, 2), ['↑—', '↓—']);

  // Big numbers, and running out: 90% and up stands out.
  await draw({ device: { ...local, cpu: 97.6, memory: { used: 15 * GIB, total: 16 * GIB }, net: { rx: 12.5 * 1024 ** 2, tx: 3 * 1024 ** 3 } }, today, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑3.00 GB/s', '↓12.50 MB/s', 'CPU98 %', 'MEM94 %']);
  assert.deepEqual(await text('.cell.hot'), ['CPU98 %', 'MEM94 %']);
  await draw({ device: local, today, light: false, items: ALL });
  assert.deepEqual(await text('.cell.hot'), []);

  // ---------- choosing what it shows ----------
  await draw({ device: local, today, light: false, items: { net: false, cpu: true, memory: true } });
  assert.deepEqual(await text('.device .cell'), ['CPU4 %', 'MEM65 %']);
  const noNet = await lastWidth();
  assert.ok(noNet < full, 'narrower without the traffic');
  assert.match(await evaluate("document.querySelector('.device').title"), /Traffic today/, 'the tooltip still tells everything');
  await draw({ device: local, today, light: false, items: { net: true, cpu: false, memory: false } });
  assert.deepEqual(await text('.device .cell'), ['↑0.71 KB/s', '↓1.18 KB/s']);
  await draw({ device: local, today, light: false, items: { net: false, cpu: false, memory: true } });
  assert.deepEqual(await text('.device .cell'), ['MEM65 %']);
  assert.equal(await evaluate("document.querySelector('.col.use').classList.contains('one')"), true, 'one measurement takes one line');
  await draw({ device: local, today, light: false, items: { net: false, cpu: true, memory: false } });
  assert.deepEqual(await text('.device .cell'), ['CPU4 %']);
  // Nothing chosen: nothing drawn, and main is told there is no width to show.
  await draw({ device: local, today, light: false, items: { net: false, cpu: false, memory: false } });
  assert.equal(await evaluate("document.querySelectorAll('.device').length"), 0);
  assert.equal(await lastWidth(), 0);
  await draw({ device: local, today, light: false });
  assert.equal(await lastWidth(), 0, 'nothing chosen, nothing shown');
  await draw({ today, light: false, items: ALL });
  assert.equal(await lastWidth(), 0);
  await draw({ device: local, today, light: false, items: ALL });
  assert.equal(await lastWidth(), full);
  // The same width twice is reported once.
  const before = await evaluate("fx.sent.length");
  await draw({ device: { ...local, cpu: 5 }, today, light: false, items: ALL });
  assert.equal(await evaluate("fx.sent.length"), before);
  assert.ok(await evaluate("Math.max(...[...document.querySelectorAll('.col')].map(el => el.getBoundingClientRect().height))") <= 30, 'never more than two lines of text');

  assert.deepEqual(errors, []);
  win.destroy();

  // ---------- the window itself (Windows only) ----------
  if (process.platform === 'win32') {
    ipcMain.on('prefs:get', e => { e.returnValue = { language: 'bg', themeId: 'dark', resolvedTheme: 'dark' }; });
    const { createTaskbarMonitor } = require('../src/taskbar-monitor');
    const desktop = require('../src/desktop');
    const wait = (ok, what, ms = 15000) => new Promise((resolve, reject) => {
      const from = Date.now();
      const timer = setInterval(() => {
        if (ok()) { clearInterval(timer); resolve(); }
        else if (Date.now() - from > ms) { clearInterval(timer); reject(new Error('Timed out: ' + what)); }
      }, 100);
    });
    let on = true, items = { ...ALL };
    const trafficFile = path.join(temp, 'traffic.json');
    const monitor = createTaskbarMonitor({
      shown: () => on, items: () => items, trafficFile
    });
    const w = monitor.win;
    const seen = [];
    w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) seen.push(message); });
    await wait(() => w.isVisible(), 'the strip shows once its page has measured itself');
    assert.equal(w.isFocused(), false);
    assert.equal(w.isFocusable(), false);
    assert.equal(w.isAlwaysOnTop(), true);
    const display = screen.getPrimaryDisplay().bounds;
    const b = w.getBounds();
    assert.ok(b.width >= 120 && b.width <= Math.round(display.width / 3), `no wider than a third of the taskbar (${b.width})`);
    assert.ok(b.y + b.height <= display.y + display.height + 1 && b.y >= display.y + display.height / 2, 'on the bottom edge');
    const found = desktop.taskbar();
    if (found?.tray) {
      const bar = screen.screenToDipRect(null, found.bar), tray = screen.screenToDipRect(null, found.tray);
      if (bar.width > bar.height * 4) {
        assert.ok(Math.abs(b.y - bar.y) <= 1 && Math.abs(b.height - bar.height) <= 1, 'as tall as the taskbar');
        assert.ok(b.x + b.width <= tray.x, 'ends where the tray begins');
        assert.ok(tray.x - (b.x + b.width) <= 12, 'right beside it');
      }
    }
    const cells = () => w.webContents.executeJavaScript("[...document.querySelectorAll('.device .cell')].map(el => el.textContent)");
    // The real measurements arrive: a percent for memory at once, a rate from the second sample on.
    await wait(() => false, '', 2500).catch(() => {});
    const drawn = await cells();
    assert.equal(drawn.length, 4);
    assert.match(drawn[3], /^MEM\d+ %$/);
    assert.match(drawn[2], /^CPU\d+ %$/);
    if (require('../src/host/net-counters').read()) assert.match(drawn[0], /^↑\d+\.\d\d [KMG]B\/s$/);
    assert.match(await w.webContents.executeJavaScript("document.querySelector('.device').title"), /^Този компютър\nТрафик днес: /);

    // What it shows changes at once, and the window follows the text.
    items = { net: false, cpu: true, memory: true }; monitor.sync();
    await wait(() => w.getBounds().width < b.width, 'narrower without the traffic');
    assert.equal((await cells()).length, 2);
    const narrow = w.getBounds();
    if (found?.tray) assert.ok(narrow.x + narrow.width <= screen.screenToDipRect(null, found.tray).x, 'still ends where the tray begins');
    // Nothing to show: no window.
    items = { net: false, cpu: false, memory: false }; monitor.sync();
    await wait(() => !w.isVisible(), 'hidden with nothing to show');
    items = { ...ALL }; monitor.sync();
    await wait(() => w.isVisible(), 'back with something to show');
    // Switched off: gone, and nothing is measured; switched on again: back.
    on = false; monitor.sync();
    assert.equal(w.isVisible(), false);
    on = true; monitor.sync();
    await wait(() => w.isVisible(), 'back when switched on');
    // Today's traffic is kept when the strip goes.
    monitor.dispose();
    assert.equal(w.isDestroyed(), true);
    const saved = JSON.parse(fs.readFileSync(trafficFile, 'utf8'));
    assert.match(saved.day, /^\d{4}-\d\d-\d\d$/);
    assert.ok(saved.rx >= 0 && saved.tx >= 0);
    assert.deepEqual(seen, []);
  } else {
    // Elsewhere there is no taskbar to lie on: nothing is created, and the calls are harmless.
    const monitor = require('../src/taskbar-monitor').createTaskbarMonitor({ shown: () => true, trafficFile: path.join(temp, 'traffic.json') });
    assert.equal(monitor.win, null);
    monitor.sync(); monitor.dispose();
  }
  console.log("Electron taskbar monitor: chosen measurements, tooltips, width and the window's place passed");
  app.exit(0);
}).catch(error => { console.error(error); console.error('page errors:', globalThis.pageErrors); app.exit(1); });
