// A meeting's audio after the recording: compressed into the project, and as PCM again for the pipeline.
//
//   createMeetingAudio({ store, workDir, withCodec })   withCodec: for tests
//   openAudio(project, meeting, { signal }) -> { mic, system, cleanup }: the pipeline's, from the raw recording while
//     it is there, else from the WebM files.
//   compress(project, id) -> the meeting. One at a time; safe to repeat. The raw recording goes only when both files
//     in the project are read back the same as those that were verified.
//   removeAudio(project, id): instead of the store's, which does not know of the raw recording.
//   active() -> [{ project, id, done, total }] in ms of audio.
//   cancel(key), stop(): the recorder's; what was not finished is compressed after the next start.
//   on("compression", { type, project, id, ... }): started; progress { done, total }; finished { meeting };
//     failed { code }.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline: pipe } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { EventEmitter } = require("node:events");
const { HostError } = require("../host/errors");
const { MESSAGES, fail } = require("./errors");
const { workKey } = require("./work");
const { CHANNELS, SAMPLE_RATE, FRAME_BYTES, FRAMES_PER_MS, msOf } = require("./capture/format");
const { recordingDir, pcmPath, readRecording, removeRecording } = require("./capture/recording-file");

const fsp = fs.promises;
const SAME_LENGTH_FRAMES = SAMPLE_RATE; // the pipeline's second
const READ_BYTES = 1024 * 1024;

// A compression's failure as one of the meetings' errors.
function known(error) {
  if (error instanceof HostError) return error;
  const code = error?.code === "ENOSPC" ? "meetingsDiskFull" : "meetingsCompressionFailed";
  return Object.assign(new HostError(code, MESSAGES[code]), { detail: String(error?.message || error) });
}

async function digestOf(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}
async function flushed(file) {
  const handle = await fsp.open(file, "r+");
  try { await handle.datasync(); } finally { await handle.close(); }
}

// Resolves when the promise has settled, or at once when the signal aborts.
function settledOrAborted(promise, signal) {
  return new Promise(resolve => {
    const done = () => {
      signal?.removeEventListener("abort", done);
      resolve();
    };
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", done);
    promise.then(done, done);
  });
}

// One channel of the interleaved recording as a file of its own.
async function splitChannel({ source, output, index, frames, signal }) {
  if (!frames) return fsp.writeFile(output, "");
  let rest = Buffer.alloc(0);
  const mono = new Transform({
    transform(data, _encoding, done) {
      const bytes = rest.length ? Buffer.concat([rest, data]) : data;
      const count = Math.floor(bytes.length / FRAME_BYTES);
      const out = Buffer.allocUnsafe(count * 2);
      for (let i = 0; i < count; i++) out.writeInt16LE(bytes.readInt16LE(i * FRAME_BYTES + index * 2), i * 2);
      rest = bytes.subarray(count * FRAME_BYTES);
      done(null, out);
    }
  });
  const input = fs.createReadStream(source, { end: frames * FRAME_BYTES - 1, highWaterMark: READ_BYTES });
  await pipe(input, mono, fs.createWriteStream(output), { signal });
}

function createMeetingAudio({ store, workDir, withCodec = (...args) => require("./capture/codec-page").withCodec(...args) }) {
  const audio = new EventEmitter();
  const jobs = new Map(); // work key -> { project, id, done, total, abort, promise }
  const reading = new Map(); // work key -> openAudio() at the raw recording, which is not deleted under it
  let tail = Promise.resolve(), stopped = false;

  function announce(event) {
    for (const fn of audio.rawListeners("compression")) {
      try { fn(event); } catch (error) { console.error("A compression listener failed:", error); }
    }
  }

  async function compressNow(job, meeting, key) {
    const { project, id } = job, signal = job.abort.signal;
    signal.throwIfAborted();
    const dir = recordingDir(path.join(workDir, key));
    const info = await readRecording(dir);
    if (!info) return store.read(project, id); // done already
    if (!info.stopped) fail("meetingsStillRecording");
    if (!info.frames) {
      await removeRecording(dir);
      return store.read(project, id);
    }
    job.total = msOf(info.frames);
    announce({ type: "started", project, id, done: 0, total: job.total });

    const files = { source: { path: pcmPath(dir) } };
    for (const channel of CHANNELS) files[channel] = { path: path.join(dir, `${channel}.webm`), write: true };
    const onProgress = frames => {
      job.done = msOf(frames);
      announce({ type: "progress", project, id, done: job.done, total: job.total });
    };
    await withCodec({ files, signal, onProgress }, async call => {
      await call("encode", { source: "source", outputs: CHANNELS, frames: info.frames });
      await call("verify", { names: CHANNELS, frames: info.frames });
    });

    const saved = {};
    for (const channel of CHANNELS) {
      signal.throwIfAborted();
      const name = `audio/${channel}.webm`;
      // The store takes bytes: one channel of two hours is 30 MB, for the length of one write.
      const written = await store.write(project, id, name, await fsp.readFile(files[channel].path));
      await flushed(written);
      if (await digestOf(written) !== await digestOf(files[channel].path)) fail("meetingsCompressionFailed", name);
      saved[channel] = name;
    }
    signal.throwIfAborted();
    const done = await store.update(project, id, m => ({
      audio: saved,
      durationMs: msOf(info.frames),
      ...(m.error?.code === "meetingsCompressionFailed" && { error: null })
    }));
    await reading.get(key);
    await removeRecording(dir);
    announce({ type: "finished", project, id, meeting: done });
    return done;
  }

  async function compress(project, id) {
    const meeting = await store.read(project, id);
    if (stopped) fail("meetingsInterrupted");
    if (meeting.state === "recording") fail("meetingsStillRecording");
    const key = workKey(meeting);
    if (jobs.has(key)) return jobs.get(key).promise;
    const job = { project, id, done: 0, total: meeting.durationMs || 0, abort: new AbortController(), promise: null };
    jobs.set(key, job);
    const before = tail;
    const run = (async () => {
      try {
        await settledOrAborted(before, job.abort.signal); // one at a time, and a cancelled one does not wait its turn
        return await compressNow(job, meeting, key);
      } catch (error) {
        if (job.abort.signal.aborted) {
          announce({ type: "failed", project, id, code: "meetingsInterrupted" });
          fail("meetingsInterrupted");
        }
        const why = known(error);
        // The meeting's own error, or the pipeline's, says more.
        await store.update(project, id, m => (m.error || m.state !== "recorded" ? null : { error: { code: "meetingsCompressionFailed" } }))
          .catch(e => console.error("A failed compression could not be noted:", e.message));
        announce({ type: "failed", project, id, code: why.code });
        throw why;
      } finally {
        jobs.delete(key);
      }
    })();
    tail = before.then(() => run).then(() => {}, () => {});
    job.promise = run;
    return run;
  }

  async function openAudio(project, meeting, { signal } = {}) {
    if (meeting.state === "recording") fail("meetingsStillRecording");
    const key = workKey(meeting), folder = path.join(workDir, key), dir = recordingDir(folder);
    const running = jobs.get(key)?.promise;
    // Its files are about to be the audio; if it fails the raw recording still is.
    if (running) await settledOrAborted(running, signal);
    signal?.throwIfAborted();
    let readDone;
    reading.set(key, new Promise(resolve => { readDone = resolve; }));
    try {
      return await openNow({ project, meeting, folder, dir, signal });
    } finally {
      reading.delete(key);
      readDone();
    }
  }

  async function openNow({ project, meeting, folder, dir, signal }) {
    const raw = await readRecording(dir);
    if (raw && !raw.stopped) fail("meetingsStillRecording");
    // Read again: compression may just have put it there.
    const current = await store.read(project, meeting.id);
    const channels = raw?.frames ? CHANNELS : CHANNELS.filter(channel => current.audio[channel]);
    if (!channels.length) return { mic: null, system: null, cleanup: async () => {} };

    const out = path.join(folder, "decoded"); // one job at a meeting at a time, so one folder
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    const cleanup = () => fsp.rm(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const paths = { mic: null, system: null };
    for (const channel of channels) paths[channel] = path.join(out, `${channel}.pcm`);
    try {
      if (raw?.frames) {
        for (const [index, channel] of CHANNELS.entries()) {
          await splitChannel({ source: pcmPath(dir), output: paths[channel], index, frames: raw.frames, signal });
        }
      } else {
        await decodeFiles({ project, meeting: current, channels, paths, signal });
      }
      return { ...paths, cleanup };
    } catch (error) {
      await cleanup().catch(() => {});
      signal?.throwIfAborted();
      if (error instanceof HostError) throw error;
      fail(error?.code === "ENOSPC" ? "meetingsDiskFull" : "meetingsAudioUnreadable", error?.message);
    }
  }

  async function decodeFiles({ project, meeting, channels, paths, signal }) {
    const files = {};
    for (const channel of channels) {
      files[channel] = { path: await store.filePath(project, meeting.id, meeting.audio[channel]) };
      files[`${channel}Pcm`] = { path: paths[channel], write: true };
    }
    const decoded = await withCodec({ files, signal }, call =>
      Promise.all(channels.map(channel => call("decode", { source: channel, output: `${channel}Pcm` }))));
    if (meeting.durationMs === null) return;
    const frames = Math.round(meeting.durationMs * FRAMES_PER_MS);
    for (const [i, channel] of channels.entries()) {
      if (Math.abs(decoded[i] - frames) > SAME_LENGTH_FRAMES) fail("meetingsAudioUnreadable", meeting.audio[channel]);
      await fsp.truncate(paths[channel], frames * 2); // the codec's padding off, or silence for what it left out
    }
  }

  async function cancel(key) {
    const job = jobs.get(key);
    if (!job) return;
    job.abort.abort();
    await job.promise.catch(() => {});
  }

  async function removeAudio(project, id) {
    const meeting = await store.read(project, id);
    if (meeting.state === "recording") fail("meetingsStillRecording");
    const key = workKey(meeting);
    await cancel(key);
    const done = await store.removeAudio(project, id);
    await reading.get(key);
    await removeRecording(recordingDir(path.join(workDir, key)));
    return done;
  }

  async function stop() {
    stopped = true;
    await Promise.all([...jobs.keys()].map(cancel));
  }

  return Object.assign(audio, {
    openAudio, compress, removeAudio, cancel, stop,
    active: () => [...jobs.values()].map(({ project, id, done, total }) => ({ project, id, done, total }))
  });
}

module.exports = { createMeetingAudio };
