// A channel of a meeting as the pipeline gets it: headerless PCM, mono, signed 16-bit little-endian, 16 kHz. Read a
// megabyte or one part at a time - two hours are 230 MB a channel and never in memory whole.
const fs = require("node:fs");
const { pcmToWav, SAMPLE_RATE, BYTES_PER_SECOND } = require("../voice/wav");
const { fail } = require("./errors");

const BYTES_PER_MS = BYTES_PER_SECOND / 1000;
const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;
const CHUNK_FRAMES = 1600; // a megabyte
const SILENCE_DB = -100;

// What it takes to read the file, failed as the meetings' own error.
async function withFile(file, fn) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    return await fn(handle);
  } catch (error) {
    if (error?.syscall) fail("meetingsAudioUnreadable", error.message);
    throw error;
  } finally {
    await handle?.close();
  }
}
// As many bytes as the buffer takes, or as the file still has.
async function fill(handle, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const { bytesRead } = await handle.read(buffer, done, buffer.length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return done;
}

const durationMs = file => withFile(file, async handle => Math.floor((await handle.stat()).size / BYTES_PER_MS));

// The level of every 20 ms in dBFS, without the DC offset cheap microphones add.
function readLevels(file, { signal } = {}) {
  return withFile(file, async handle => {
    const bytes = (await handle.stat()).size, levels = new Float32Array(Math.ceil(bytes / FRAME_BYTES)).fill(SILENCE_DB);
    const buffer = Buffer.alloc(CHUNK_FRAMES * FRAME_BYTES), samples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
    for (let frame = 0; frame < levels.length; frame += CHUNK_FRAMES) {
      signal?.throwIfAborted();
      const count = Math.floor(await fill(handle, buffer, frame * FRAME_BYTES) / 2);
      for (let from = 0, i = frame; from < count; from += FRAME_BYTES / 2, i++) {
        const to = Math.min(from + FRAME_BYTES / 2, count);
        let sum = 0, squares = 0;
        for (let s = from; s < to; s++) { sum += samples[s]; squares += samples[s] * samples[s]; }
        const power = squares / (to - from) - (sum / (to - from)) ** 2;
        if (power > 0) levels[i] = Math.max(SILENCE_DB, 10 * Math.log10(power / 32768 ** 2));
      }
    }
    return { levels, durationMs: Math.floor(bytes / BYTES_PER_MS) };
  });
}

// [start, end) in ms as a WAV; past the end of the file it is silence, so the times stay exact.
function readPart(file, { start, end }) {
  return withFile(file, async handle => {
    const pcm = Buffer.alloc((end - start) * BYTES_PER_MS);
    await fill(handle, pcm, start * BYTES_PER_MS);
    return pcmToWav(pcm, SAMPLE_RATE);
  });
}

module.exports = { FRAME_MS, SILENCE_DB, durationMs, readLevels, readPart };
