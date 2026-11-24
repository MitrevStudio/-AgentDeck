// The meetings' IPC, for the manager window's own page only. A project is one the registry lists, a file only what
// the store hands out. An answer is { ok: true, value } or { ok: false, code, message }: an Error loses its code on the
// way to the page, and the window has to know a missing key from the rest.
const fs = require("node:fs");
const path = require("node:path");
const { ipcMain, clipboard } = require("electron");
const { isObj } = require("../shared/util");
const { PROVIDERS, TASKS, modelInfo, choices, resolveTask } = require("../voice/catalog");
const { LANGUAGE_NAMES } = require("../voice/providers/gemini");
const { t } = require("../i18n");
const { fail } = require("./errors");
const { problem } = require("./problems");
const { isId, isScreen } = require("./meeting");
const { isWindowId } = require("./capture/windows");
const { AUDIO } = require("./media");
const { meetingRow, meetingDetails } = require("./shown");

const TITLE_MAX = 1000;
const DEVICE_MAX = 512;
const MONITORS_MAX = 16;
const WINDOWS_MAX = 8;
const DOCUMENT_MAX_BYTES = 3 * 1024 * 1024; // two hours of speech are about 0.2 MB
const SIZES_AT_A_TIME = 8;
const MODEL = /^[A-Za-z0-9][\w.:/-]{0,99}$/; // as Settings takes one

function text(value, max) {
  if (typeof value !== "string" || value.length > max) fail("invalidData");
  return value;
}
function meetingId(value) {
  if (!isId(value)) fail("invalidData", "id");
  return value;
}
function choice(value) {
  if (value === undefined) return undefined;
  if (!isObj(value) || !PROVIDERS.includes(value.provider) || typeof value.model !== "string" || !MODEL.test(value.model)) fail("invalidData", "choice");
  return { provider: value.provider, model: value.model };
}
// A meeting's languages: known codes, none to detect.
function languages(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > Object.keys(LANGUAGE_NAMES).length || !value.every(code => Object.hasOwn(LANGUAGE_NAMES, code))) fail("invalidData", "languages");
  return [...new Set(value)];
}
function processing(value) {
  const options = isObj(value) ? value : {};
  return { transcription: choice(options.transcription), summary: choice(options.summary), languages: languages(options.languages), again: options.again === true };
}
function recordingOptions(value) {
  if (!isObj(value)) fail("invalidData");
  const { title = "", microphone, monitors, windows = [] } = value;
  const isMonitor = id => typeof id === "string" && id.length > 0 && id.length <= 100;
  if (!Array.isArray(monitors) || monitors.length > MONITORS_MAX || !monitors.every(isMonitor)) fail("invalidData", "monitors");
  if (!Array.isArray(windows) || windows.length > WINDOWS_MAX || !windows.every(isWindowId)) fail("invalidData", "windows");
  if (!monitors.length && !windows.length) fail("invalidData", "monitors");
  return { title: text(title, TITLE_MAX), microphone: text(microphone, DEVICE_MAX) || "default", monitors: [...new Set(monitors)], windows: [...new Set(windows)] };
}

// What each of the two tasks can be done with, and what the settings say.
function taskOptions(settings, task) {
  const providers = Object.keys(TASKS[task].models).map(name => {
    const { model } = resolveTask(settings, task, { provider: name });
    const ids = [...new Set([...choices(task, name), model])];
    return { name, model, models: ids.map(id => ({ id, approximate: modelInfo(name, id).timestamps !== "word" })) };
  });
  return { ...resolveTask(settings, task), providers };
}

async function readDocument(store, project, id, name) {
  try {
    const file = await store.filePath(project, id, name);
    if ((await fs.promises.stat(file)).size > DOCUMENT_MAX_BYTES) return { tooLarge: true };
    return { text: await fs.promises.readFile(file, "utf8") };
  } catch (error) {
    return error.code === "meetingsNotFound" ? null : { code: problem(error).code };
  }
}

async function readSizes(store, project, ids) {
  const sizes = {};
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(SIZES_AT_A_TIME, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { sizes[id] = (await store.size(project, id)).bytes; } catch { /* deleted meanwhile, or out of reach: no size */ }
    }
  }));
  return sizes;
}

function registerIpc({ getWindow, use, project, placeOf, firstLook, prepareOnce, state, media, openSettings, send }) {
  function handle(channel, fn) {
    ipcMain.handle(`meetings:${channel}`, async (event, ...args) => {
      const win = getWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
        return { ok: false, code: "accessDenied", message: t("errors.accessDenied") };
      }
      try {
        return { ok: true, value: await fn(...args) };
      } catch (error) {
        const { code } = problem(error), key = `errors.${code}`;
        return { ok: false, code, message: t(key) === key ? t("errors.meetingsUnexpected") : t(key) };
      }
    });
  }
  // Both of them checked, then fn(project, id).
  const ofMeeting = fn => (dir, id, ...rest) => fn(project(dir), meetingId(id), ...rest);
  const keyOf = async (dir, id) => `${await placeOf(dir)}|${id}`;
  const changed = async dir => send("changed", { place: await placeOf(dir) });

  async function isRecording(dir, id) {
    const { recording } = use().recorder.status();
    return recording?.id === id && await placeOf(recording.project) === await placeOf(dir);
  }
  // The uncompressed recording is still there to listen to a provider with.
  async function hasRawAudio(dir, id) {
    const place = await placeOf(dir);
    for (const left of await use().recorder.recoverable()) {
      if (left.kind === "compression" && left.id === id && await placeOf(left.project) === place) return true;
    }
    return false;
  }

  handle("state", () => state());

  // ---------- a project's meetings ----------
  handle("count", async value => {
    const dir = project(value), count = await use().store.count(dir);
    prepareOnce(dir, count);
    return { place: await placeOf(dir), count };
  });
  handle("list", async value => {
    const dir = project(value);
    await firstLook(dir);
    const list = await use().store.list(dir);
    prepareOnce(dir, list.length);
    return { place: await placeOf(dir), meetings: list.map(meetingRow), state: await state() };
  });
  handle("sizes", async value => {
    const dir = project(value), { store } = use();
    return readSizes(store, dir, (await store.list(dir)).map(m => m.id));
  });

  // ---------- recording ----------
  handle("devices", async options => {
    const { recorder } = use();
    return recorder.devices({ thumbnails: options?.thumbnails === true });
  });
  handle("start", async (value, options) => {
    await use().recorder.start({ project: project(value), ...recordingOptions(options) });
    return true;
  });
  handle("stop", async () => Boolean(await use().recorder.stop()));
  handle("discard", () => use().recorder.discard());
  handle("screenshot", async () => {
    await use().recorder.screenshot();
    return true;
  });
  handle("recover", async () => {
    await use().recorder.recover();
    send("changed", {});
    return true;
  });
  handle("discard-recoverable", async value => {
    const { recorder } = use(), key = text(value, 200);
    if (!(await recorder.recoverable()).some(left => left.key === key)) fail("meetingsNotFound");
    await recorder.discardRecoverable(key);
    send("changed", {});
    return true;
  });

  // ---------- one meeting ----------
  handle("open", ofMeeting(async (dir, id) => {
    await firstLook(dir);
    const { store } = use(), place = await placeOf(dir);
    const [size, summary, transcript, raw] = await Promise.all([
      store.size(dir, id), readDocument(store, dir, id, "summary.md"), readDocument(store, dir, id, "transcript.md"), hasRawAudio(dir, id)
    ]);
    let meeting;
    try {
      meeting = meetingDetails(await store.read(dir, id));
    } catch (error) {
      if (error.code !== "meetingsBroken") throw error;
      meeting = { id, broken: true };
    }
    return { place, meeting, size, summary, transcript, raw, media: media.baseUrl(await keyOf(dir, id), dir, id) };
  }));
  handle("options", () => {
    const settings = require("../voice/settings"), current = settings.load();
    return {
      transcription: taskOptions(current, "meetingTranscription"),
      summary: taskOptions(current, "meetingSummary"),
      languages: Object.keys(LANGUAGE_NAMES),
      keys: Object.fromEntries(PROVIDERS.map(name => [name, settings.hasApiKey(name)]))
    };
  });
  handle("estimate", ofMeeting(async (dir, id, options) => {
    const { store, pipeline } = use(), meeting = await store.read(dir, id), { transcription, summary } = processing(options);
    // The estimate counts channels: the raw recording has both, and a summary alone needs none of them.
    const audio = meeting.audio.mic || meeting.audio.system ? meeting.audio : { mic: true, system: true };
    return pipeline.estimate({ ...meeting, audio }, { transcription, summary });
  }));
  // These three resolve when the job is over; what it does meanwhile comes as events.
  handle("transcribe", ofMeeting(async (dir, id, options) => {
    await use().pipeline.start(dir, id, processing(options));
    return true;
  }));
  handle("retry", ofMeeting(async (dir, id) => {
    await use().pipeline.retry(dir, id);
    return true;
  }));
  handle("summarize", ofMeeting(async (dir, id, options) => {
    const { summary, again } = processing(options);
    await use().pipeline.summarize(dir, id, { summary, again });
    return true;
  }));
  handle("cancel", ofMeeting((dir, id) => use().pipeline.cancel(dir, id)));
  handle("compress", ofMeeting(async (dir, id) => {
    await use().audio.compress(dir, id);
    await changed(dir);
    return true;
  }));
  handle("rename", ofMeeting(async (dir, id, title) => {
    await use().store.rename(dir, id, text(title, TITLE_MAX));
    await changed(dir);
    return true;
  }));
  handle("remove", ofMeeting(async (dir, id) => {
    const { store, pipeline, recorder } = use();
    let recorded = "";
    try {
      recorded = (await store.read(dir, id)).state;
    } catch (error) {
      if (error.code !== "meetingsBroken") throw error; // that one can still be deleted
    }
    if (recorded === "recording" || await isRecording(dir, id)) fail("meetingsStillRecording");
    await media.release(await keyOf(dir, id));
    await recorder.release(dir, id);
    await pipeline.forget(dir, id);
    await store.remove(dir, id);
    await changed(dir);
    return true;
  }));
  handle("remove-audio", ofMeeting(async (dir, id) => {
    const { audio, pipeline } = use(), place = await placeOf(dir);
    for (const job of pipeline.active()) {
      if (job.id === id && await placeOf(job.project) === place) fail("meetingsBusy");
    }
    await media.release(await keyOf(dir, id), AUDIO);
    await audio.removeAudio(dir, id);
    await changed(dir);
    return true;
  }));
  handle("remove-screen", ofMeeting(async (dir, id, file) => {
    if (!isScreen(file)) fail("invalidData", "file");
    await media.release(await keyOf(dir, id), [file]);
    await use().pipeline.removeScreen(dir, id, file);
    await changed(dir);
    return true;
  }));
  // The file an agent starts from; the folder while the meeting has neither.
  handle("copy-path", ofMeeting(async (dir, id) => {
    const { store } = use();
    let target = "";
    for (const name of ["summary.md", "transcript.md"]) {
      try {
        target = await store.filePath(dir, id, name);
        break;
      } catch (error) {
        if (error.code !== "meetingsNotFound") throw error;
      }
    }
    target ||= path.join((await store.resolve(dir)).dir, (await store.read(dir, id)).id);
    await clipboard.writeText(target);
    return target;
  }));
  handle("settings", pane => openSettings(pane === "meetings" ? "meetings" : "models"));
}

module.exports = { registerIpc };
