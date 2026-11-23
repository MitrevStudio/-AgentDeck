// What the window is told of meetings, jobs and recordings. meeting.json lies in the project, so anybody can have
// written it: only the fields the window shows go on, each as the type it shows. No path of a meeting's folder goes.
const { isObj } = require("../shared/util");

const MODEL_MAX = 100;
const CODE = /^[A-Za-z]{1,60}$/;

const str = (value, max = MODEL_MAX) => (typeof value === "string" ? value.slice(0, max) : "");
const codeOf = value => (typeof value === "string" && CODE.test(value) ? value : "meetingsUnexpected");
const madeBy = step => (isObj(step) ? { provider: str(step.provider), model: str(step.model) } : null);

function meetingRow(meeting) {
  const { id, broken } = meeting;
  if (broken) return { id, broken: true };
  const { title, startedAt, durationMs, state, error } = meeting;
  return { id, broken: false, title, startedAt: Date.parse(startedAt), durationMs, state, error: error && { code: codeOf(error.code) } };
}

function meetingDetails(meeting) {
  const { audio, screens, transcription, summary } = meeting;
  return {
    ...meetingRow(meeting),
    audio: { mic: Boolean(audio.mic), system: Boolean(audio.system) },
    screens: [...screens].sort((a, b) => a.atMs - b.atMs || a.monitor - b.monitor),
    transcription: transcription && {
      ...madeBy(transcription),
      failed: Number(transcription.failed) > 0 || (Array.isArray(transcription.failed) && transcription.failed.length > 0)
    },
    summary: madeBy(summary)
  };
}

// place: which folder of meetings it is (app.js), the same for a worktree and its main checkout.
function recordingStatus({ phase, recording }, { place = "", name = "" } = {}) {
  if (!recording) return { phase, recording: null };
  const { project, id, title, elapsedMs, microphone, monitors, screens, shortcut, warnings } = recording;
  return {
    phase,
    recording: {
      project, place, name, id, title, elapsedMs, screens,
      microphone: microphone?.label || "",
      monitors: (monitors || []).map(m => m.monitor),
      shortcut: { accelerator: shortcut?.accelerator || "", registered: shortcut?.registered === true },
      warnings: (warnings || []).map(({ code, channel, monitor }) => ({ code: codeOf(code), channel, monitor }))
    }
  };
}

// The events of the recorder, the audio and the pipeline, without meetings, paths and providers' own words.
function jobEvent({ type, project, id, step, done, total, waitMs, code }, place) {
  return { type, project, place, id, step, done, total, waitMs, code: code && codeOf(code) };
}

module.exports = { meetingRow, meetingDetails, recordingStatus, jobEvent };
