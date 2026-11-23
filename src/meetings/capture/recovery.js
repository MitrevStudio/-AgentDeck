// Recordings that a crash or a quit left in the work folders, and meetings left saying "recording".
const fs = require("node:fs");
const path = require("node:path");
const { HostError } = require("../../host/errors");
const { workKey } = require("../work");
const { msOf } = require("./format");
const { recordingDir, readRecording, closeInterrupted, removeRecording } = require("./recording-file");

const KEY = /^[0-9a-f]{32}$/;

const codeOf = error => (error instanceof HostError ? error.code : "meetingsFileFailed");

// A recording's end in its meeting, whoever finds it: once, as only a meeting that says "recording" is changed.
function saveRecorded(store, { project, id, frames }, code = null) {
  return store.update(project, id, m => (m.state !== "recording" ? null : {
    state: "recorded",
    durationMs: frames === null ? null : msOf(frames),
    error: frames === 0 ? { code: code || "meetingsRecordingEmpty" } : code && { code }
  }));
}

// isLive({ key }) or isLive({ startedAt }): the recording that runs now, which nobody here touches.
function createRecovery({ store, workDir, audio, isLive }) {
  const dirOf = key => recordingDir(path.join(workDir, key));
  let tail = Promise.resolve();
  const serial = fn => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };

  async function scan() {
    const entries = await fs.promises.readdir(workDir, { withFileTypes: true })
      .catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const found = [];
    for (const entry of entries) {
      const key = entry.name;
      if (!entry.isDirectory() || !KEY.test(key) || isLive({ key })) continue;
      let info;
      try {
        info = await readRecording(dirOf(key));
      } catch (error) {
        console.error("A recording could not be read:", error.message);
        continue;
      }
      if (!info) continue;
      let code = null;
      try {
        // Of another meeting, when the project or the meeting is not where it was.
        if (workKey(await store.read(info.project, info.id)) !== key) code = "meetingsNotFound";
      } catch (error) {
        code = codeOf(error);
      }
      found.push({ key, info, code });
    }
    return found;
  }

  const shown = ({ key, info, code }) => ({
    key, project: info.project, id: info.id, startedAt: info.startedAt, durationMs: msOf(info.frames),
    kind: info.stopped ? "compression" : "interrupted", code
  });

  // atStart: with a project it is asked whenever that is listed, and a compression that failed is not tried then.
  async function finish({ key, info }, atStart) {
    const { project, id, frames, stopped } = info, dir = dirOf(key);
    await saveRecorded(store, { project, id, frames }, !stopped && frames ? "meetingsRecordingInterrupted" : null);
    if (!stopped) await closeInterrupted(dir, info); // after the meeting: a crash in between still says it was interrupted
    if (!frames) return removeRecording(dir);
    if (!atStart && stopped) return;
    audio.compress(project, id).catch(error => console.error("A recovered meeting was not compressed:", error.message));
  }

  // What a work folder cannot tell of: its recording.json is gone, or the whole folder.
  async function resolveAbandoned(project) {
    for (const meeting of await store.list(project)) {
      if (meeting.broken || meeting.state !== "recording") continue;
      const startedAt = Date.parse(meeting.startedAt);
      if (isLive({ startedAt }) || await readRecording(dirOf(workKey(meeting)))) continue;
      await store.update(project, meeting.id, m => (m.state !== "recording" || isLive({ startedAt }) ? null : {
        state: "recorded", durationMs: null, error: { code: "meetingsRecordingInterrupted" }
      }));
    }
  }

  const recover = project => serial(async () => {
    const found = await scan();
    for (const one of found) {
      if (one.code || isLive({ key: one.key })) continue;
      try {
        await finish(one, !project);
      } catch (error) {
        console.error("A recording could not be finished:", error.message);
        one.code = codeOf(error);
      }
    }
    if (project) await resolveAbandoned(project);
    return found.map(shown);
  });

  const discard = key => serial(async () => {
    if (typeof key !== "string" || !KEY.test(key) || isLive({ key })) return false;
    const dir = dirOf(key), info = await readRecording(dir);
    if (!info) return false;
    await audio.cancel(key);
    try {
      const meeting = await store.read(info.project, info.id);
      if (workKey(meeting) === key) await saveRecorded(store, { ...info, frames: null }, "meetingsRecordingInterrupted");
    } catch (error) {
      if (!(error instanceof HostError)) throw error; // gone or unreadable: only the sound is left to delete
    }
    await removeRecording(dir);
    return true;
  });

  return { list: () => serial(async () => (await scan()).map(shown)), recover, discard };
}

module.exports = { createRecovery, saveRecorded };
