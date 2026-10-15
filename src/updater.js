// Automatic updates from GitHub Releases: electron-updater with the NSIS installer. Main process only.
//
// Only the installed app updates itself. `npm start` and an unpacked build (dist/win-unpacked, no uninstaller beside
// the exe) report "unsupported" and never check: an unpacked build would otherwise install a release over this
// machine when it quits.
//
// Checks a little after start and then every 4 hours. With auto on (ui.autoUpdate, the default) a new version is
// downloaded in the background and installed silently when AgentDeck quits, or at once with install(), which also
// starts it again. With auto off a new version is only announced; download() fetches it, and it then installs the
// same way. Nothing here shows a dialog: being offline, a GitHub rate limit or a failed download end up in the state
// and the next check tries again; a release whose installer is not uploaded yet counts as no update.
//
// AGENTDECK_UPDATE_URL (tests only): a generic feed - a folder with latest.yml and the installer - instead of GitHub.
//
// events: "changed" (state, previous) - state() as below, whenever any part of it changes.
const { app } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const OFFLINE_RETRY_MS = 30 * 60 * 1000;

const updater = new EventEmitter();
let au = null; // electron-updater's autoUpdater; loaded only where updates are supported
let timer = null, checking = null, installing = false;
const s = {
  supported: false, auto: true,
  checking: false, downloading: false,
  available: null,  // the newer version the last check found
  downloaded: null, // the version downloaded and waiting to be installed
  percent: 0, checkedAt: 0,
  error: null       // { during: "check" | "download", reason: "offline" | "limited" | "pending" | "corrupt" | "other", message }
};

function status() {
  if (!s.supported) return "unsupported";
  if (s.downloading) return "downloading";
  if (s.downloaded) return "ready";
  if (s.checking) return "checking";
  if (s.error) return "error";
  if (s.available) return "available";
  return s.checkedAt ? "none" : "idle";
}
// next: the version that is being downloaded, is ready, or is available.
const state = () => ({
  supported: s.supported, version: app.getVersion(), auto: s.auto, status: status(),
  next: (s.downloading ? s.available : s.downloaded || s.available) || null,
  percent: s.percent, checkedAt: s.checkedAt, error: s.error
});

function set(patch) {
  const prev = state();
  Object.assign(s, patch);
  const next = state();
  if (JSON.stringify(next) !== JSON.stringify(prev)) updater.emit("changed", next, prev);
}

// What went wrong, in terms the UI can explain. electron-updater wraps the request that failed into its own error,
// so the HTTP status is read back from the text where it is not a property.
function classify(e) {
  const text = String(e?.stack || e?.message || e);
  const code = e?.statusCode ?? Number(/HttpError: (\d{3})/.exec(text)?.[1]);
  if (/net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|NETWORK_|CONNECTION_|ADDRESS_UNREACHABLE|TIMED_OUT|PROXY_|TUNNEL_)|\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/.test(text)) return "offline";
  if (code === 403 || code === 429) return "limited";
  if (code === 404 || ["ERR_UPDATER_CHANNEL_FILE_NOT_FOUND", "ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_UPDATER_ASSET_NOT_FOUND"].includes(e?.code)) return "pending";
  if (e?.code === "ERR_CHECKSUM_MISMATCH") return "corrupt";
  return "other";
}
const firstLine = e => String(e?.message || e).split("\n")[0].trim().slice(0, 200);

function schedule(ms) {
  clearTimeout(timer);
  // Once an update is downloaded there is nothing more to look for: it goes in when AgentDeck quits.
  timer = setTimeout(() => { if (!s.downloaded) check(); }, ms);
}

function start({ auto = true } = {}) {
  s.auto = auto !== false;
  const installed = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
  if (!installed || au) return;
  au = require("electron-updater").autoUpdater;
  au.autoDownload = s.auto;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false; // published releases only (a local x.y.z-tag build would otherwise follow prereleases)
  au.allowDowngrade = false;
  au.disableWebInstaller = true;
  if (process.env.AGENTDECK_UPDATE_URL) au.setFeedURL({ provider: "generic", url: process.env.AGENTDECK_UPDATE_URL });
  au.on("download-progress", p => set({ percent: Math.floor(p.percent) }));
  s.supported = true;
  schedule(FIRST_CHECK_MS);
}

// Resolves with the state once the check is over (a download it starts goes on in the background).
function check() {
  if (!s.supported || s.downloaded) return Promise.resolve(state());
  checking ??= runCheck().finally(() => { checking = null; });
  return checking;
}

async function runCheck() {
  clearTimeout(timer);
  set({ checking: true, error: null });
  let again = CHECK_EVERY_MS;
  try {
    const r = await au.checkForUpdates();
    const found = r?.isUpdateAvailable ? r.updateInfo.version : null;
    const done = { checking: false, checkedAt: Date.now(), available: found };
    if (found && r.downloadPromise && !s.downloading) {
      set({ ...done, downloading: true, percent: 0 });
      follow(r.downloadPromise);
    } else set(done);
  } catch (e) {
    const reason = classify(e);
    console.error(`Update check failed (${reason}): ${firstLine(e)}`);
    // The newest release without its installer yet (or no release at all): no update for now.
    if (reason === "pending") set({ checking: false, checkedAt: Date.now(), available: null });
    else set({ checking: false, error: { during: "check", reason, message: firstLine(e) } });
    if (reason === "offline") again = OFFLINE_RETRY_MS;
  }
  schedule(again);
  return state();
}

function follow(download) {
  download.then(
    () => set({ downloading: false, downloaded: s.available, percent: 100, error: null }),
    e => {
      const reason = classify(e);
      console.error(`Update download failed (${reason}): ${firstLine(e)}`);
      set({ downloading: false, percent: 0, error: { during: "download", reason, message: firstLine(e) } });
    });
}

function download() {
  if (s.supported && s.available && !s.downloading && !s.downloaded) {
    set({ downloading: true, percent: 0, error: null });
    follow(au.downloadUpdate());
  }
  return state();
}

function setAuto(on) {
  set({ auto: on !== false });
  if (!au) return;
  au.autoDownload = s.auto;
  if (s.auto) download(); // one found while it was off
}

// The update goes in on the way out, after AgentDeck has shut down as on any quit: silently, and it starts again
// afterwards. electron-updater's own install-on-quit would not start it again, so it stands aside. Should the
// installer not start, AgentDeck comes back as it was and tries again the next time it quits.
function install() {
  if (!s.downloaded || installing) return false;
  installing = true;
  au.autoInstallOnAppQuit = false;
  app.once("quit", () => { if (!au.install(true, true)) app.relaunch(); });
  app.quit();
  return true;
}

module.exports = Object.assign(updater, { start, state, check, download, install, setAuto });
