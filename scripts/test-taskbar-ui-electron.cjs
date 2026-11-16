// The taskbar monitor in a real Chromium: what its page draws, what a switched-off measurement leaves, the width it
// reports - and, on Windows, the window itself: made only when the strip is switched on and destroyed when it is
// switched off, on the taskbar left of the tray, never focused, hidden with nothing to show, for a full-screen app
// and without a taskbar along the bottom edge to lie on.
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
const { app, BrowserWindow, screen } = require('electron');
const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
const temp = process.env.AGENTDECK_UI_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-taskbar-ui-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {}); // the page's window goes before the strip's own comes

const FIXTURE = `(() => {
  const fx = { sent: [], cb: null };
  window.taskbarMonitor = { send: (type, value) => fx.sent.push([type, value]), onData: cb => { fx.cb = cb; } };
  window.fx = fx;
})();`;
const GIB = 1024 ** 3;
const ALL = { net: true, cpu: true, memory: true };
const local = { cpu: 4.4, memory: { used: 10.4 * GIB, total: 16 * GIB }, net: { rx: 1208.3, tx: 727 } };
app.whenReady().then(async () => {
  const fixtureFile = path.join(temp, 'fixture.js');
  fs.writeFileSync(fixtureFile, FIXTURE);
  const html = fs.readFileSync(path.join(src, 'taskbar.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}">`)
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<script src="taskbar.js"></script>', `<script src="${pathToFileURL(fixtureFile).href}"></script><script src="taskbar.js"></script>`);
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

  await draw({ device: local, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑0.71 KB/s', '↓1.18 KB/s', 'CPU4 %', 'MEM65 %']);
  assert.equal(await evaluate("document.querySelectorAll('.device').length"), 1);
  assert.equal(await evaluate("document.querySelector('[title]')"), null, 'no tooltip: the strip never hears of the pointer');
  const full = await lastWidth();
  assert.ok(full > 120 && full < 260, `as wide as its text (${full}px)`);
  assert.equal(await evaluate("Math.ceil(document.getElementById('strip').getBoundingClientRect().width)"), full);
  assert.equal(await evaluate('document.documentElement.dataset.taskbar'), 'dark');
  assert.equal(await evaluate("getComputedStyle(document.body).color"), 'rgb(255, 255, 255)');
  assert.equal(await evaluate("getComputedStyle(document.body).backgroundColor"), 'rgba(0, 0, 0, 0)', 'the taskbar shows through');

  // A light taskbar takes dark text.
  await draw({ device: local, light: true, items: ALL });
  assert.equal(await evaluate("getComputedStyle(document.body).color"), 'rgb(17, 17, 17)');

  // Not measured yet (the first sample has no rate, no CPU): dashes, never zeros.
  await draw({ device: { ...local, cpu: null, net: { rx: null, tx: null } }, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑—', '↓—', 'CPU—', 'MEM65 %']);
  // No traffic source at all on this computer.
  await draw({ device: { ...local, net: null }, light: false, items: ALL });
  assert.deepEqual((await text('.device .cell')).slice(0, 2), ['↑—', '↓—']);

  // Big numbers, and running out: 90% and up stands out.
  await draw({ device: { ...local, cpu: 97.6, memory: { used: 15 * GIB, total: 16 * GIB }, net: { rx: 12.5 * 1024 ** 2, tx: 3 * 1024 ** 3 } }, light: false, items: ALL });
  assert.deepEqual(await text('.device .cell'), ['↑3.00 GB/s', '↓12.50 MB/s', 'CPU98 %', 'MEM94 %']);
  assert.deepEqual(await text('.cell.hot'), ['CPU98 %', 'MEM94 %']);
  await draw({ device: local, light: false, items: ALL });
  assert.deepEqual(await text('.cell.hot'), []);

  // ---------- choosing what it shows ----------
  await draw({ device: local, light: false, items: { net: false, cpu: true, memory: true } });
  assert.deepEqual(await text('.device .cell'), ['CPU4 %', 'MEM65 %']);
  const noNet = await lastWidth();
  assert.ok(noNet < full, 'narrower without the traffic');
  await draw({ device: local, light: false, items: { net: true, cpu: false, memory: false } });
  assert.deepEqual(await text('.device .cell'), ['↑0.71 KB/s', '↓1.18 KB/s']);
  await draw({ device: local, light: false, items: { net: false, cpu: false, memory: true } });
  assert.deepEqual(await text('.device .cell'), ['MEM65 %']);
  assert.equal(await evaluate("document.querySelector('.col.use').classList.contains('one')"), true, 'one measurement takes one line');
  await draw({ device: local, light: false, items: { net: false, cpu: true, memory: false } });
  assert.deepEqual(await text('.device .cell'), ['CPU4 %']);
  // Nothing chosen: nothing drawn, and main is told there is no width to show.
  await draw({ device: local, light: false, items: { net: false, cpu: false, memory: false } });
  assert.equal(await evaluate("document.querySelectorAll('.device').length"), 0);
  assert.equal(await lastWidth(), 0);
  await draw({ device: local, light: false });
  assert.equal(await lastWidth(), 0, 'nothing chosen, nothing shown');
  await draw({ light: false, items: ALL });
  assert.equal(await lastWidth(), 0);
  await draw({ device: local, light: false, items: ALL });
  assert.equal(await lastWidth(), full);
  // The same width twice is reported once.
  const before = await evaluate("fx.sent.length");
  await draw({ device: { ...local, cpu: 5 }, light: false, items: ALL });
  assert.equal(await evaluate("fx.sent.length"), before);
  assert.ok(await evaluate("Math.max(...[...document.querySelectorAll('.col')].map(el => el.getBoundingClientRect().height))") <= 30, 'never more than two lines of text');

  assert.deepEqual(errors, []);
  win.destroy();

  // ---------- the window itself (Windows only) ----------
  let where = 'no taskbar here';
  if (process.platform === 'win32') {
    const { createTaskbarMonitor, place } = require('../src/taskbar-monitor');
    const desktop = require('../src/desktop');
    const wait = (ok, what, ms = 15000) => new Promise((resolve, reject) => {
      const from = Date.now();
      const timer = setInterval(() => {
        if (ok()) { clearInterval(timer); resolve(); }
        else if (Date.now() - from > ms) { clearInterval(timer); reject(new Error('Timed out: ' + what)); }
      }, 50);
    });
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const windows = () => BrowserWindow.getAllWindows().length;

    // The lookups are the real ones - a koffi that does not load must fail here, not pass as "no taskbar".
    require('koffi');
    const real = desktop.taskbar();
    assert.equal(typeof desktop.taskbarLight(), 'boolean');
    const stop = desktop.onForeground(() => {});
    assert.equal(typeof stop, 'function', 'Windows takes the foreground listener');
    stop();
    const dip = r => r && screen.screenToDipRect(null, r);
    const realSpot = real && place({ ...real, bar: dip(real.bar), tray: dip(real.tray) }, screen.getDisplayMatching(dip(real.bar)).bounds, 200);
    if (real) {
      assert.ok(real.bar.width > 0 && real.bar.height > 0 && typeof real.autoHide === 'boolean');
      if (real.tray) assert.ok(real.tray.x >= real.bar.x && real.tray.x + real.tray.width <= real.bar.x + real.bar.width + 1 && real.tray.width < real.bar.width, 'the tray is a part of the taskbar');
    }
    // What the strip is told of the desktop: the real taskbar when this computer has one to lie on, else a stand-in
    // (a session without Explorer, a taskbar that hides itself) - and whatever the cases below put in its place.
    const display = screen.getPrimaryDisplay(), d = display.bounds, scale = display.scaleFactor;
    const px = r => ({ x: Math.round(r.x * scale), y: Math.round(r.y * scale), width: Math.round(r.width * scale), height: Math.round(r.height * scale) });
    const standIn = { bar: px({ x: d.x, y: d.y + d.height - 48, width: d.width, height: 48 }), tray: px({ x: d.x + d.width - 300, y: d.y + d.height - 48, width: 300, height: 48 }), autoHide: false };
    where = realSpot ? 'on the real taskbar' : 'no taskbar to lie on here: a stand-in';
    let found = realSpot ? real : standIn, fullScreen = false, lightBar = false, front = null, fronts = 0;
    let on = false, items = { ...ALL };
    const before = windows();
    const monitor = createTaskbarMonitor({
      shown: () => on, items: () => items, taskbar: () => found, fullScreenApp: () => fullScreen, taskbarLight: () => lightBar,
      onForeground: cb => { front = cb; fronts++; return () => { front = null; }; }
    });
    // Switched off: no window, no page, no listener - nothing exists for a user who never asked for the strip.
    assert.equal(monitor.win, null);
    assert.equal(windows(), before, 'no window while the strip is off');
    assert.equal(front, null);
    monitor.sync();
    assert.equal(windows(), before);

    on = true; monitor.sync();
    const w = monitor.win;
    assert.ok(w && windows() === before + 1, 'switching it on makes the window');
    monitor.sync();
    assert.equal(monitor.win, w, 'one window, however often the settings change');
    assert.equal(fronts, 1);
    const seen = [];
    w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) seen.push(message); });
    await wait(() => w.isVisible(), 'the strip shows once its page has measured itself');
    assert.equal(w.isFocused(), false);
    assert.equal(w.isFocusable(), false);
    assert.equal(w.isAlwaysOnTop(), true);
    const b = w.getBounds();
    const bar = dip(found.bar), tray = dip(found.tray);
    assert.ok(b.width >= 120 && b.width <= Math.round(bar.width / 3), `as wide as its text, no wider than a third of the taskbar (${b.width})`);
    assert.ok(Math.abs(b.y - bar.y) <= 1 && Math.abs(b.height - bar.height) <= 1, 'as tall as the taskbar, on it');
    assert.ok(b.x + b.width <= tray.x, 'ends where the tray begins');
    assert.ok(tray.x - (b.x + b.width) <= 12, 'right beside it');
    const page = code => w.webContents.executeJavaScript(code);
    const cells = () => page("[...document.querySelectorAll('.device .cell')].map(el => el.textContent)");
    // The real measurements arrive: a percent for memory at once, a rate from the second sample on.
    await pause(2500);
    const drawn = await cells();
    assert.equal(drawn.length, 4, 'switched on, it shows all it can');
    assert.match(drawn[3], /^MEM\d+ %$/);
    assert.match(drawn[2], /^CPU\d+ %$/);
    assert.ok(require('../src/host/net-counters').read(), 'Windows gives its traffic counters');
    assert.match(drawn[0], /^↑\d+\.\d\d [KMG]B\/s$/);

    // What it shows changes at once, and the window follows the text.
    items = { net: false, cpu: true, memory: true }; monitor.sync();
    await wait(() => w.getBounds().width < b.width, 'narrower without the traffic');
    assert.equal((await cells()).length, 2);
    const narrow = w.getBounds();
    assert.ok(narrow.x + narrow.width <= tray.x, 'still ends where the tray begins');
    // Nothing to show: no window on the screen.
    items = { net: false, cpu: false, memory: false }; monitor.sync();
    await wait(() => !w.isVisible(), 'hidden with nothing to show');
    items = { ...ALL }; monitor.sync();
    await wait(() => w.isVisible(), 'back with something to show');

    // No taskbar along the bottom to lie on: hidden - never left floating over the bottom of the screen - and back
    // when there is one again (Explorer restarted, auto-hide switched off, the taskbar moved back).
    const hiddenWith = async (what, value) => {
      found = value;
      await wait(() => !w.isVisible(), `hidden ${what}`, 3000);
      found = realSpot ? real : standIn;
      await wait(() => w.isVisible(), `back after ${what}`, 3000);
    };
    await hiddenWith('without a taskbar', null);
    await hiddenWith('with a taskbar that hides itself', { ...standIn, autoHide: true });
    await hiddenWith('with a hidden taskbar (two pixels on the screen)', { ...standIn, bar: { ...standIn.bar, y: standIn.bar.y + standIn.bar.height - 2 } });
    await hiddenWith('with the taskbar on the left', { bar: px({ x: d.x, y: d.y, width: 62, height: d.height }), tray: null, autoHide: false });
    await hiddenWith('with the taskbar at the top', { bar: px({ x: d.x, y: d.y, width: d.width, height: 48 }), tray: null, autoHide: false });
    assert.deepEqual(w.getBounds(), b, 'in its place again');

    // A full-screen app: gone the moment Windows says another window came to the front, not a round later; back
    // the same way. The taskbar turning light is seen then too.
    fullScreen = true; front();
    assert.equal(w.isVisible(), false, 'hidden at once for a full-screen app');
    fullScreen = false; lightBar = true; front();
    assert.equal(w.isVisible(), true, 'back at once');
    await wait(() => false, '', 200).catch(() => {});
    assert.equal(await page('document.documentElement.dataset.taskbar'), 'light');
    lightBar = false;
    await wait(() => false, '', 1300).catch(() => {});
    assert.equal(await page('document.documentElement.dataset.taskbar'), 'dark', 'the round every second sees it as well');

    // Switched off: the window is gone, not hidden, and nothing listens or measures; switched on again: a new one.
    on = false; monitor.sync();
    assert.equal(w.isDestroyed(), true, 'switching it off destroys the window');
    assert.equal(monitor.win, null);
    assert.equal(windows(), before);
    assert.equal(front, null, 'the foreground listener goes with it');
    on = true; monitor.sync();
    const again = monitor.win;
    assert.ok(again && again !== w);
    await wait(() => again.isVisible(), 'back when switched on');
    monitor.dispose();
    assert.equal(again.isDestroyed(), true);
    assert.equal(windows(), before);
    assert.deepEqual(seen, []);
  } else {
    // Elsewhere there is no taskbar to lie on: nothing is created, and the calls are harmless.
    const monitor = require('../src/taskbar-monitor').createTaskbarMonitor({ shown: () => true });
    assert.equal(monitor.win, null);
    monitor.sync(); monitor.dispose();
  }
  console.log(`Electron taskbar monitor: chosen measurements, width and the window's life and place passed (${where})`);
  app.exit(0);
}).catch(error => { console.error(error); console.error('page errors:', globalThis.pageErrors); app.exit(1); });
