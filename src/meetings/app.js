// The meetings in the running app (main.js): the store, the audio, the pipeline and the recorder put together, their
// events to the manager window, and their IPC for that window alone (ipc.js). The other computers and the phones get
// none of it. The parts are made when first needed. Everywhere but Windows only the recording is missing.
//
//   createMeetingsApp({ getWindow, getProjects, openSettings })   before app ready (the scheme of media.js)
//     getWindow(): the manager window; getProjects(): the registry's; openSettings(pane) -> boolean.
//   register()               the IPC and the scheme, once ready
//   start()                  what a crash left is taken up shortly after the start, unless there is nothing
//   sessionLaunched(cwd)     an agent is about to look for the skill there
//   confirmQuit() -> Promise<boolean>, holdsQuit(): asked before quitting while a meeting is recorded, once a recording
//   watchSessionEnd(win)     the manager window: Windows logging off, shutting down or restarting saves the recording
//   shutdown()
const fs = require("node:fs");
const path = require("node:path");
const { app, dialog, shell } = require("electron");
const { normPath, sleep } = require("../shared/util");
const { norm, getProject } = require("../host/registry");
const { t } = require("../i18n");
const { fail } = require("./errors");
const { registerScheme, createMedia } = require("./media");
const { registerIpc } = require("./ipc");
const { recordingStatus, jobEvent } = require("./shown");

const RECOVER_DELAY_MS = 5000;
const SHUTDOWN_MS = 10_000; // the recording is closed and what runs is stopped; quitting never hangs on it
const PATH_MAX = 4096;

function createMeetingsApp({ getWindow, getProjects, openSettings }) {
  registerScheme();
  let parts = null, closed = false, recoverTimer = null;

  function shortcut() {
    const { DEFAULT_SHORTCUT } = require("./capture/shortcut");
    try {
      return require("../voice/settings").load().hotkeys.meetingScreenshot || DEFAULT_SHORTCUT;
    } catch (error) {
      console.error("The screenshot key could not be read:", error.message);
      return DEFAULT_SHORTCUT;
    }
  }

  function use() {
    if (closed) fail("meetingsInterrupted");
    if (parts) return parts;
    const workDir = path.join(app.getPath("userData"), "meetings-work");
    const store = require("./store").createMeetingStore({ trash: file => shell.trashItem(file) });
    const audio = require("./audio").createMeetingAudio({ store, workDir });
    const pipeline = require("./pipeline").createPipeline({ store, workDir, openAudio: audio.openAudio });
    const recorder = require("./recorder").createMeetingRecorder({ store, workDir, audio, getShortcut: shortcut });
    parts = { store, audio, pipeline, recorder };
    listen(parts);
    return parts;
  }

  // ---------- projects ----------
  // A listed project of this computer, as the registry has it: whatever the window names is only looked up.
  function project(value) {
    if (typeof value !== "string" || !value || value.length > PATH_MAX) fail("invalidData");
    if (value.startsWith("node:")) fail("meetingsNotLocal");
    const found = getProject({ projects: getProjects().filter(p => !p.node) }, value);
    if (!found) fail("meetingsNotLocal", value);
    return found.path;
  }
  function projectName(dir) {
    const found = getProjects().find(p => !p.node && norm(p.path) === norm(dir));
    return found?.name || path.basename(dir) || dir;
  }
  // Which folder of meetings a project has: a worktree and its main checkout show the same meetings and jobs.
  const places = new Map();
  async function placeOf(dir) {
    if (places.has(dir)) return places.get(dir);
    try {
      const place = normPath((await use().store.resolve(dir)).dir);
      places.set(dir, place);
      return place;
    } catch {
      return normPath(dir);
    }
  }

  // ---------- the skill and what a crash left ----------
  // A worktree made after the recordings has no skill. Only where there are meetings, and only once a run: preparing
  // asks git.
  const prepared = new Set();
  async function prepareOnce(dir, count) {
    const key = norm(dir);
    if (!count || prepared.has(key)) return;
    prepared.add(key);
    try {
      await use().store.prepare(dir);
    } catch (error) {
      console.error("The meetings' skill could not be prepared:", error.message);
    }
  }
  async function sessionLaunched(cwd) {
    try {
      const here = `${norm(cwd)}/`;
      const owner = getProjects().filter(p => !p.node && here.startsWith(`${norm(p.path).replace(/\/$/, "")}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      // The folder itself too: a worktree inside its project's folder is a repository of its own.
      for (const dir of new Set([owner?.path, cwd].filter(Boolean))) {
        if (!prepared.has(norm(dir))) await prepareOnce(dir, await use().store.count(dir));
      }
    } catch (error) {
      console.error("The meetings of a launched session could not be looked at:", error.message);
    }
  }
  // Before a project's meetings are first listed: what says "processing" or "recording" there and is not.
  const looked = new Map();
  function firstLook(dir) {
    const key = norm(dir);
    if (looked.has(key)) return looked.get(key);
    const { pipeline, recorder } = use();
    const look = (async () => {
      await recorder.recover(dir);
      await pipeline.recover(dir);
    })().catch(error => {
      looked.delete(key);
      console.error("A project's meetings could not be recovered:", error.message);
    });
    looked.set(key, look);
    return look;
  }
  async function recoverAll() {
    recoverTimer = null;
    try {
      await fs.promises.access(path.join(app.getPath("userData"), "meetings-work"));
    } catch {
      return; // nothing was ever recorded or processed
    }
    if (closed) return;
    try {
      await use().recorder.recover();
      send("changed", {});
    } catch (error) {
      console.error("Meetings could not be recovered:", error);
    }
  }

  // ---------- to the window ----------
  function send(name, data) {
    const win = getWindow();
    if (!closed && win && !win.isDestroyed()) win.webContents.send("meetings:event", name, data);
  }
  // In the order they happened, though finding a project's place takes a moment.
  let sending = Promise.resolve();
  function queue(name, build) {
    sending = sending.then(async () => send(name, await build()))
      .catch(error => console.error("A meetings event could not be sent:", error));
  }
  async function status(value) {
    const dir = value.recording?.project;
    return recordingStatus(value, dir ? { place: await placeOf(dir), name: projectName(dir) } : {});
  }
  function listen({ audio, pipeline, recorder }) {
    recorder.on("status", value => queue("status", () => status(value)));
    recorder.on("ended", () => { quitAllowed = false; }); // the next recording is asked about again
    recorder.on("levels", ({ elapsedMs, mic, system }) => send("levels", { elapsedMs, mic, system }));
    recorder.on("warning", event => queue("warning", () => ({ code: event.code, active: event.active, channel: event.channel, monitor: event.monitor, window: event.window })));
    recorder.on("screenshot", event => queue("screenshot", async () => ({
      place: await placeOf(event.project), id: event.id, taken: event.screens.length,
      failed: event.failed.map(({ monitor, window, code }) => ({ monitor, window, code }))
    })));
    recorder.on("ended", event => queue("ended", async () => ({
      project: event.project, place: await placeOf(event.project), id: event.id,
      reason: event.reason, saved: Boolean(event.meeting), code: event.code
    })));
    pipeline.on("job", event => queue("job", async () => jobEvent(event, await placeOf(event.project))));
    audio.on("compression", event => queue("compression", async () => jobEvent(event, await placeOf(event.project))));
  }
  async function state() {
    const { audio, pipeline, recorder } = use();
    const placed = list => Promise.all(list.map(async item => ({ ...item, place: await placeOf(item.project) })));
    const [current, jobs, compressions, left] = await Promise.all([
      status(recorder.status()), placed(pipeline.active()), placed(audio.active()), Promise.resolve(recorder.recoverable()).then(placed)
    ]);
    return {
      capabilities: recorder.capabilities(), status: current, jobs, compressions, shortcut: shortcut(),
      recoverable: left.map(({ key, place, id, project: dir, startedAt, durationMs, kind, code }) =>
        ({ key, place, id, name: projectName(dir), startedAt, durationMs, kind, code }))
    };
  }

  const media = createMedia({ file: (dir, id, name) => use().store.filePath(project(dir), id, name) });
  function register() {
    media.serve();
    registerIpc({ getWindow, use, project, placeOf, firstLook, prepareOnce, state, media, openSettings, send });
  }
  function start() {
    recoverTimer = setTimeout(recoverAll, RECOVER_DELAY_MS);
  }

  // ---------- quitting ----------
  let quitAllowed = false, asking = false;
  const holdsQuit = () => !quitAllowed && !closed && ["starting", "recording"].includes(parts?.recorder.status().phase);
  // Not the dialog's Sync form: the main thread has the sound to write while the question waits for its answer.
  async function confirmQuit() {
    if (!holdsQuit()) return true;
    // Whoever asked first goes on with the answer: two of them would quit twice.
    if (asking) return false;
    asking = true;
    try {
      const options = {
        type: "warning", buttons: [t("meetings.quit.confirm"), t("common.cancel")], defaultId: 1, cancelId: 1, noLink: true,
        title: t("app.name"), message: t("meetings.quit.message"), detail: t("meetings.quit.detail")
      };
      const win = getWindow();
      const owner = win && !win.isDestroyed() && win.isVisible() ? [win] : [];
      quitAllowed = (await dialog.showMessageBox(...owner, options)).response === 0;
      return quitAllowed;
    } finally {
      asking = false;
    }
  }
  // Windows ending the session quits without before-quit and with no time for a dialog: the recording is stopped and
  // saved at the first word of it. Not shut down: the end can still be called off by another program.
  function watchSessionEnd(win) {
    const end = () => {
      if (!parts || closed || parts.recorder.status().phase === "idle") return;
      parts.recorder.stop().catch(error => console.error("The recording was not saved as the session ended:", error.message));
    };
    win.on("query-session-end", end);
    win.on("session-end", end);
  }
  async function shutdown() {
    clearTimeout(recoverTimer);
    closed = true;
    if (!parts) return;
    const { audio, pipeline, recorder } = parts;
    const done = Promise.all([recorder.shutdown(), pipeline.stop()]).then(() => audio.stop());
    await Promise.race([done, sleep(SHUTDOWN_MS)]).catch(error => console.error("The meetings could not shut down:", error));
  }

  return { register, start, sessionLaunched, holdsQuit, confirmQuit, watchSessionEnd, shutdown };
}

module.exports = { createMeetingsApp };
