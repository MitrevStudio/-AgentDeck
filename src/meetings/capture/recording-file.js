// A recording's raw audio in its work folder (work.js), <work>/recording/:
//   recording.json   whose it is: written once, before the first sound
//   audio.pcm        format.js, appended once a second. Its size is the truth: a crash loses what the last second held
//   state.json       "recording" until the recording was closed, then "stopped"
// All of it stays until audio.js has the compressed files verified in the project.
const fs = require("node:fs");
const path = require("node:path");
const atomic = require("../../shared/atomic-file");
const { isObj, toBuffer, sleep } = require("../../shared/util");
const { FRAME_BYTES } = require("./format");

const fsp = fs.promises;
const FLUSH_MS = 1000;
const FAILURES_MAX = 5; // seconds in a row that could not be written; a full disk is not tried again
const CLOSE_TRIES = 3, CLOSE_WAIT_MS = 200; // the last second's, before what is still queued is said to be lost
const ZEROS = Buffer.alloc(1024 * 1024);

const recordingDir = workFolder => path.join(workFolder, "recording");
const pcmPath = dir => path.join(dir, "audio.pcm");
const writeState = (dir, state) => atomic.write(path.join(dir, "state.json"), JSON.stringify({ state }));

async function readJson(file) {
  const text = await atomic.readText(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; } // torn by a crash of the machine
}

async function writeAll(handle, buffer, position) {
  for (let done = 0; done < buffer.length;) done += (await handle.write(buffer, done, buffer.length - done, position + done)).bytesWritten;
}

// info: { project, id, startedAt }. onFailed(error) once, when the file cannot be written any more.
async function createRecordingFile(dir, info, { onFailed, open = fsp.open } = {}) {
  await fsp.mkdir(dir, { recursive: true });
  const meta = await fsp.open(path.join(dir, "recording.json"), "w");
  try {
    await writeAll(meta, Buffer.from(JSON.stringify(info)), 0);
    await meta.datasync();
  } finally {
    await meta.close();
  }
  await writeState(dir, "recording");
  const handle = await open(pcmPath(dir), "w");

  // Buffers, and numbers of frames of silence: hours of a sleep or a lost capture are not held as zeros.
  const queue = [];
  let frames = 0, written = 0, failures = 0, failed = null, lastError = null, chain = Promise.resolve();

  function giveUp(error) {
    failed = error;
    queue.length = 0;
    onFailed?.(error);
  }

  async function writeQueued() {
    if (failed || !queue.length) return;
    try {
      while (queue.length) {
        const next = queue[0];
        if (typeof next === "number") {
          const bytes = ZEROS.subarray(0, Math.min(ZEROS.length, next * FRAME_BYTES));
          await writeAll(handle, bytes, written);
          written += bytes.length;
          const left = next - bytes.length / FRAME_BYTES;
          if (left) queue[0] = left;
          else queue.shift();
        } else {
          // At its position, so what a failed try left half written is written over.
          await writeAll(handle, next, written);
          written += next.length;
          queue.shift();
        }
      }
      await handle.datasync();
      failures = 0;
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOSPC" && ++failures < FAILURES_MAX) return;
      giveUp(error);
    }
  }
  const flush = () => (chain = chain.then(writeQueued));
  const timer = setInterval(flush, FLUSH_MS);

  return {
    get frames() { return frames; },
    append(pcm) {
      if (failed) return;
      const bytes = toBuffer(pcm);
      queue.push(bytes);
      frames += bytes.length / FRAME_BYTES;
    },
    silence(count) {
      if (failed || count <= 0) return;
      queue.push(count);
      frames += count;
    },
    // -> the frames that are on disk. Never rejects: what is on disk is used either way, and sound that could not be
    // written is said through onFailed, never lost quietly.
    async close() {
      clearInterval(timer);
      await flush();
      for (let i = 1; i < CLOSE_TRIES && queue.length && !failed; i++) {
        await sleep(CLOSE_WAIT_MS);
        await flush();
      }
      if (queue.length && !failed) giveUp(lastError);
      const whole = written - (written % FRAME_BYTES);
      try {
        await handle.truncate(whole);
        await handle.datasync();
      } catch (error) {
        console.error("A recording could not be flushed:", error.message);
      } finally {
        await handle.close().catch(() => {});
      }
      await writeState(dir, "stopped").catch(error => console.error("A recording's state could not be saved:", error.message));
      return whole / FRAME_BYTES;
    }
  };
}

// -> { project, id, startedAt, frames, stopped }, null when there is no recording. A state that cannot be read is
// one of a recording that was interrupted.
async function readRecording(dir) {
  const info = await readJson(path.join(dir, "recording.json"));
  if (!isObj(info) || typeof info.project !== "string" || typeof info.id !== "string" || !Number.isFinite(info.startedAt)) return null;
  const size = await fsp.stat(pcmPath(dir)).then(st => st.size, error => { if (error.code === "ENOENT") return 0; throw error; });
  const state = await readJson(path.join(dir, "state.json"));
  return { project: info.project, id: info.id, startedAt: info.startedAt, frames: Math.floor(size / FRAME_BYTES), stopped: state?.state === "stopped" };
}

// After a crash: a torn last frame goes, and it is a recording like one that was stopped.
async function closeInterrupted(dir, { frames }) {
  await fsp.truncate(pcmPath(dir), frames * FRAME_BYTES).catch(error => { if (error.code !== "ENOENT") throw error; });
  await writeState(dir, "stopped");
}

const removeRecording = dir => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

module.exports = { recordingDir, pcmPath, createRecordingFile, readRecording, closeInterrupted, removeRecording };
