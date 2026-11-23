// Recording a meeting: the microphone and the system sound on one clock, screenshots on a key, recovery. One
// recording in the whole app, Windows only. The dictation has a window and a session of its own and is not touched.
//
//   createMeetingRecorder({ store, workDir, audio, getShortcut })   audio: audio.js; getShortcut() -> accelerator
//   capabilities() -> { supported, code, ownAudioExcluded, longRecordingMs }
//   devices({ thumbnails }) -> { microphones: [{ deviceId, label, isDefault }], displays: [{ id, monitor, label,
//     primary, width, height, bounds, thumbnail }] }: physical pixels, bounds in DIP.
//   start({ project, title, microphone, monitors }) -> { meeting, status }: microphone a deviceId, monitors display
//     ids. The meeting exists from here on, in the state "recording".
//   stop() -> the meeting, compressed afterwards by itself; discard() -> boolean; screenshot(); status();
//   shutdown(): for quitting.
//   recoverable(); recover(): at the app's start; recover(project): wherever pipeline.recover(project) is, for that
//     project's meetings left "recording" (compressions that failed are only tried again at the start and by hand);
//   discardRecoverable(key); release(project, id): before a meeting is deleted.
//   on("status" | "levels" | "warning" | "screenshot" | "ended"). ended.reason: stopped, discarded, shutdown, or
//     failed when the disk could not be written.
// Every function rejects with a HostError (errors.js).
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { isObj, normPath } = require("../shared/util");
const { fail } = require("./errors");
const { problem } = require("./problems");
const { workKey } = require("./work");
const { recordingDir, createRecordingFile, removeRecording } = require("./capture/recording-file");
const { createRecovery, saveRecorded } = require("./capture/recovery");
const { createLive } = require("./capture/live");
const { createDisplays } = require("./capture/displays");
const { takeScreenshot } = require("./capture/screenshot");
const { DEFAULT_SHORTCUT, registerShortcut } = require("./capture/shortcut");
const { canExclude } = require("./capture/own-audio");

const LONG_RECORDING_MS = 4 * 60 * 60 * 1000;
const DISK_CHECK_MS = 30_000;
const DISK_LOW_BYTES = 1024 ** 3;
const DISK_LEAST_BYTES = 100 * 1024 ** 2; // not started with less: half an hour
const SHOTS_WAITING_MAX = 3;
const SHOTS_WAIT_MS = 12_000; // then it is saved without them: a screen or a disk that hangs never holds the recording
const SHOTS_WAIT_AT_QUIT_MS = 500; // of the app's grace for quitting
const SCREEN_CODES = ["meetingsScreenBlank", "meetingsScreenMissing", "meetingsScreenFailed"];

// -> after the promise or ms, whichever is first.
function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}

async function freeBytes(folder) {
  await fs.promises.mkdir(folder, { recursive: true });
  const { bavail, bsize } = await fs.promises.statfs(folder);
  return bavail * bsize;
}
// The system is kept from sleeping, the screen may turn off.
function keepAwake() {
  const { powerSaveBlocker } = require("electron");
  const id = powerSaveBlocker.start("prevent-app-suspension");
  return () => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); };
}

// The rest of the options: for tests.
function createMeetingRecorder({
  store, workDir, audio, getShortcut = () => DEFAULT_SHORTCUT,
  platform = process.platform, excludeOwn = canExclude(),
  openPage = options => require("./capture/capture-page").openCapturePage(options),
  displays = createDisplays(), shortcuts = registerShortcut, awake = keepAwake, free = freeBytes, shotsWaitMs = SHOTS_WAIT_MS
}) {
  const recorder = new EventEmitter();
  const supported = platform === "win32";
  let cur = null, closed = false;

  const isLive = ({ key, startedAt }) => Boolean(cur) && (key ? cur.key === key : cur.startedAt === startedAt);
  const recovery = createRecovery({ store, workDir, audio, isLive });

  function announce(type, event) {
    for (const fn of recorder.rawListeners(type)) {
      try { fn(event); } catch (error) { console.error("A recorder listener failed:", error); }
    }
  }
  // A call's failure as one of the meetings' errors.
  const api = fn => async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      throw problem(error);
    }
  };

  function capabilities() {
    return { supported, code: supported ? null : "meetingsWindowsOnly", ownAudioExcluded: supported && excludeOwn, longRecordingMs: LONG_RECORDING_MS };
  }

  function status() {
    const c = cur;
    if (!c) return { phase: "idle", recording: null };
    return {
      phase: c.phase,
      recording: {
        project: c.project, id: c.id, title: c.title, startedAt: c.startedAt, elapsedMs: c.endedMs ?? c.live?.elapsedMs() ?? 0,
        microphone: c.microphone, monitors: c.monitors.map(({ id, monitor, label }) => ({ id, monitor, label })),
        screens: c.screens, ownAudioExcluded: excludeOwn,
        shortcut: { accelerator: c.accelerator, registered: Boolean(c.shortcut) },
        warnings: [...c.warnings.values()]
      }
    };
  }
  const changed = () => announce("status", status());

  // about: { channel } or { monitor }.
  function warn(c, code, active, about = {}) {
    if (cur !== c || c.phase === "stopping") return;
    const key = `${code}:${about.channel ?? about.monitor ?? ""}`;
    if (c.warnings.has(key) === active) return;
    if (active) c.warnings.set(key, { code, ...about });
    else c.warnings.delete(key);
    announce("warning", { project: c.project, id: c.id, code, active, ...about });
    changed();
  }

  // ---------- start ----------
  async function setUp(c) {
    await store.prepare(c.project);
    if (await free(workDir) < DISK_LEAST_BYTES) fail("meetingsDiskFull", workDir);
    const connected = await displays.list();
    if (!c.chosen.every(id => connected.some(d => d.id === id))) fail("meetingsScreenMissing");
    c.monitors = connected.filter(d => c.chosen.includes(d.id));

    c.live = createLive({
      openPage, deviceId: c.deviceId, excludeOwn,
      warn: (code, active, channel) => warn(c, code, active, channel ? { channel } : {}),
      onMicrophone: microphone => {
        if (cur !== c || (c.microphone?.deviceId === microphone.deviceId && c.microphone.label === microphone.label)) return;
        c.microphone = microphone;
        changed();
      },
      onLevels: levels => {
        if (cur !== c || c.phase !== "recording") return;
        announce("levels", { project: c.project, id: c.id, ...levels });
        if (levels.elapsedMs >= LONG_RECORDING_MS) warn(c, "meetingsLongRecording", true);
      }
    });
    c.microphone = await c.live.open();

    c.startedAt = Date.now();
    c.meeting = await store.create(c.project, { title: c.title, startedAt: c.startedAt, state: "recording" });
    c.id = c.meeting.id;
    c.title = c.meeting.title;
    c.key = workKey(c.meeting);
    c.dir = recordingDir(path.join(workDir, c.key));
    c.file = await createRecordingFile(c.dir, { project: c.project, id: c.id, startedAt: c.startedAt }, {
      onFailed: error => {
        c.fileError = error.code === "ENOSPC" ? "meetingsDiskFull" : "meetingsFileFailed";
        console.error("The recording could not be written:", error.message);
        // Not waited for here: it is said from inside a write, and ending waits for the writes.
        setImmediate(() => finish(c, "failed").catch(e => console.error("A failed recording was not saved:", e.message)));
      }
    });
    await c.live.begin(c.file);
    c.phase = "recording";
  }

  // What only helps the recording: none of it can stop one that runs.
  function attend(c) {
    try {
      c.release = awake();
    } catch (error) {
      console.error("The computer may sleep while recording:", error);
    }
    try {
      c.accelerator = getShortcut() || DEFAULT_SHORTCUT;
      const held = shortcuts(c.accelerator, () => {
        if (cur === c) shoot(c).catch(error => console.error("A screenshot failed:", error));
      });
      if (held.code) warn(c, held.code, true);
      else c.shortcut = held;
    } catch (error) {
      console.error("The screenshot key could not be taken:", error);
      warn(c, "meetingsShortcutTaken", true);
    }
    const checkDisk = () => free(workDir).then(
      bytes => warn(c, "meetingsDiskLow", bytes < DISK_LOW_BYTES),
      error => console.error("The free space is not known:", error.message)
    );
    c.diskTimer = setInterval(checkDisk, DISK_CHECK_MS);
    checkDisk();
  }

  async function abandon(c) {
    c.live?.close();
    if (c.file) await c.file.close();
    if (c.dir) await removeRecording(c.dir).catch(error => console.error("A recording that did not start was left:", error.message));
    if (!c.meeting) return;
    try {
      await store.remove(c.project, c.id);
    } catch {
      await saveRecorded(store, { project: c.project, id: c.id, frames: 0 }).catch(error => console.error("A meeting that did not start was left:", error.message));
    }
  }

  async function start(options) {
    if (!supported) fail("meetingsWindowsOnly");
    if (closed) fail("meetingsInterrupted");
    const { project, title = "", microphone = "default", monitors } = isObj(options) ? options : {};
    if (typeof project !== "string" || typeof title !== "string" || typeof microphone !== "string") fail("invalidData");
    if (!Array.isArray(monitors) || !monitors.length || !monitors.every(id => typeof id === "string")) fail("invalidData", "monitors");
    while (cur?.ending) await cur.ending.catch(() => {});
    if (cur) fail("meetingsAlreadyRecording");
    if (closed) fail("meetingsInterrupted");
    const c = {
      phase: "starting", project, title, deviceId: microphone, chosen: [...monitors],
      id: null, key: null, dir: null, meeting: null, startedAt: null, live: null, file: null,
      microphone: null, monitors: [], warnings: new Map(), screens: 0, taken: new Set(),
      shots: Promise.resolve(), late: false, waiting: 0, accelerator: "", shortcut: null, release: null, diskTimer: null,
      fileError: null, endedMs: null, ending: null, started: null
    };
    cur = c;
    changed();
    c.started = setUp(c);
    try {
      await c.started;
    } catch (error) {
      await abandon(c);
      if (cur === c) cur = null;
      changed();
      throw error;
    }
    if (!c.ending) { // stop() may have come while it started
      attend(c);
      changed();
    }
    return { meeting: c.meeting, status: status() };
  }

  // ---------- screenshots ----------
  function shoot(c) {
    const atMs = c.live.elapsedMs(), { project, id } = c;
    if (c.waiting >= SHOTS_WAITING_MAX) {
      const event = { project, id, atMs, screens: [], failed: c.monitors.map(({ monitor }) => ({ monitor, code: "meetingsScreenFailed" })) };
      announce("screenshot", event);
      return Promise.resolve(event);
    }
    c.waiting++;
    const shot = c.shots.then(async () => {
      try {
        const { screens, failed } = await takeScreenshot({ store, displays, project, id, monitors: c.monitors, atMs, taken: c.taken, late: () => c.late });
        c.screens += screens.length;
        for (const { monitor } of c.monitors) {
          const code = failed.find(f => f.monitor === monitor)?.code;
          for (const one of SCREEN_CODES) warn(c, one, one === code, { monitor });
        }
        const event = { project, id, atMs, screens, failed };
        announce("screenshot", event);
        if (screens.length && cur === c) changed();
        return event;
      } finally {
        c.waiting--;
      }
    });
    c.shots = shot.then(() => {}, () => {});
    return shot;
  }

  async function screenshot() {
    if (cur?.phase !== "recording") fail("meetingsNotRecording");
    return shoot(cur);
  }

  // ---------- the end ----------
  // reason: stopped | discarded | shutdown | failed. One end however often it is asked for.
  function finish(c, reason) {
    c.ending ??= end(c, reason);
    return c.ending;
  }

  async function end(c, reason) {
    try {
      await c.started;
    } catch {
      return null; // start() cleaned up and said why
    }
    c.endedMs = c.live.elapsedMs();
    c.phase = "stopping";
    let meeting = null, code = null, ended = reason;
    try {
      changed();
      c.shortcut?.close();
      c.shortcut = null;
      clearInterval(c.diskTimer);
      await c.live.stop();
      const frames = await c.file.close();
      await waitAtMost(c.shots, reason === "shutdown" ? SHOTS_WAIT_AT_QUIT_MS : shotsWaitMs);
      c.late = true;

      if (reason === "discarded") {
        try {
          await store.remove(c.project, c.id);
          await removeRecording(c.dir);
          return null;
        } catch (error) {
          // Not deleted, so it is kept as a recording like any other.
          ended = "stopped";
          meeting = await saveRecorded(store, { project: c.project, id: c.id, frames });
          throw error;
        }
      }
      code = c.fileError;
      if (code) ended = "failed";
      meeting = await saveRecorded(store, { project: c.project, id: c.id, frames }, code);
      if (!frames) await removeRecording(c.dir);
      return meeting;
    } catch (error) {
      const known = problem(error);
      code = known.code;
      throw known;
    } finally {
      c.release?.();
      c.live.close();
      if (cur === c) cur = null;
      changed();
      announce("ended", { project: c.project, id: c.id, reason: ended, meeting, code });
      if (meeting?.durationMs && !closed) audio.compress(c.project, c.id).catch(error => console.error("The meeting was not compressed:", error.message));
    }
  }

  async function stop() {
    return cur ? finish(cur, "stopped") : null;
  }
  async function discard() {
    const c = cur;
    if (!c || c.ending) return false;
    await finish(c, "discarded");
    return Boolean(c.id);
  }

  async function shutdown() {
    closed = true;
    await Promise.all([
      cur && finish(cur, "shutdown").catch(error => console.error("The recording was not saved at quit:", error.message)),
      audio.stop()
    ]);
  }

  // ---------- the rest ----------
  async function devices({ thumbnails = true } = {}) {
    if (!supported) fail("meetingsWindowsOnly");
    const page = openPage({});
    try {
      const [microphones, screens] = await Promise.all([page.call("list"), displays.list({ thumbnails })]);
      return { microphones, displays: screens };
    } finally {
      page.close();
    }
  }

  async function release(project, id) {
    if (cur?.id === id && normPath(path.join((await store.resolve(project)).dir, id)) === normPath(cur.meeting.dir)) fail("meetingsStillRecording");
    let meeting;
    try {
      meeting = await store.read(project, id);
    } catch (error) {
      // Without its meeting.json its work cannot be told apart, and it can still be deleted (as pipeline.forget).
      if (error.code === "meetingsBroken" || error.code === "meetingsNotFound") return;
      throw error;
    }
    await audio.cancel(workKey(meeting));
  }

  return Object.assign(recorder, {
    capabilities, status,
    devices: api(devices), start: api(start), stop: api(stop), discard: api(discard), screenshot: api(screenshot),
    recoverable: api(recovery.list), recover: api(recovery.recover), discardRecoverable: api(recovery.discard),
    release: api(release), shutdown
  });
}

module.exports = { createMeetingRecorder, DEFAULT_SHORTCUT };
