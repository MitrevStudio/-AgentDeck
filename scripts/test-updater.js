// The updater with a made-up electron and electron-updater: a version that waits to be installed gives way to a newer
// one, and "restart and update" lands on the newest version in one go.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const quitListeners = [];
const app = { isPackaged: true, getVersion: () => '1.20.0', getName: () => 'AgentDeck', quit() { app.quits++; quitListeners.splice(0).forEach(cb => cb()); }, once: (_name, cb) => quitListeners.push(cb), relaunch() {}, quits: 0 };
// feed.version: what GitHub has; feed.downloads: the versions fetched; feed.fail: the next download fails.
const feed = { version: '1.21.0', downloads: [], installed: 0, fail: false };
const autoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  download() { const v = feed.version; return feed.fail ? Promise.reject(new Error('net::ERR_CONNECTION_RESET')) : Promise.resolve().then(() => { if (feed.downloads.at(-1) !== v) feed.downloads.push(v); }); }, // a fetched installer is kept
  async checkForUpdates() {
    const isUpdateAvailable = feed.version !== app.getVersion();
    return { isUpdateAvailable, updateInfo: { version: feed.version }, downloadPromise: isUpdateAvailable && this.autoDownload ? this.download() : null };
  },
  downloadUpdate() { return this.download(); },
  install() { feed.installed++; return true; }
});
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app };
  if (request === 'electron-updater') return { autoUpdater };
  if (request === './network') return { loginHandler: () => () => {} };
  return load.call(this, request, ...rest);
};
const fs = require('node:fs'), exists = fs.existsSync;
fs.existsSync = p => (String(p).includes('Uninstall AgentDeck.exe') ? true : exists(p));
const updater = require(path.join(__dirname, '../src/updater.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const realNow = Date.now;

(async () => {
  updater.start({ auto: true });
  await updater.check(); await tick();
  assert.deepEqual([updater.state().status, updater.state().next], ['ready', '1.21.0']);

  // The same version again: it keeps waiting, nothing is fetched twice.
  await updater.check(); await tick();
  assert.deepEqual(feed.downloads, ['1.21.0']);
  assert.equal(updater.state().status, 'ready');

  // A newer version comes out while that one waits: it takes its place.
  feed.version = '1.22.0';
  await updater.check(); await tick();
  assert.deepEqual([updater.state().status, updater.state().next], ['ready', '1.22.0']);
  assert.deepEqual(feed.downloads, ['1.21.0', '1.22.0']);

  // Asked to install long after the last check, with a newer version out: that one is fetched and installed.
  feed.version = '1.23.0';
  Date.now = () => realNow() + 60 * 60 * 1000;
  assert.equal(updater.install(), true);
  await tick(); await tick(); await tick();
  assert.deepEqual(feed.downloads, ['1.21.0', '1.22.0', '1.23.0']);
  assert.deepEqual([app.quits, feed.installed], [1, 1], 'one restart, on the newest version');
  Date.now = realNow;
  console.log('Updater: a waiting version gives way to a newer one, and one restart lands on the newest OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
