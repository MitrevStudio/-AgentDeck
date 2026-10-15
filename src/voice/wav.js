// WAV files: the streaming writer the recorder feeds (16 kHz mono 16-bit, like VoiceTray's AudioRecorderService),
// reading a file's duration, and wrapping synthesised PCM for history.
const fs = require("node:fs");
const path = require("node:path");
const { toBuffer } = require("./util");

const SAMPLE_RATE = 16000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const HEADER_BYTES = 44;

function header(dataBytes, sampleRate) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

// The header carries zero sizes until close(); a file left like that means the process died mid-recording,
// and JobStore discards WAVs without a sidecar anyway.
function createWavWriter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, header(0, SAMPLE_RATE));
  let bytes = 0;
  let carry = null; // a chunk split mid-sample must not shift every sample after it
  let closed = false;

  const stats = () => ({ bytes, durationMs: Math.round(bytes / BYTES_PER_SECOND * 1000) });

  return {
    get bytes() { return bytes; },
    get durationMs() { return stats().durationMs; },
    write(chunk) {
      if (closed) return;
      let buf = toBuffer(chunk);
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      if (buf.length % 2) { carry = Buffer.from(buf.subarray(buf.length - 1)); buf = buf.subarray(0, buf.length - 1); }
      if (!buf.length) return;
      fs.writeSync(fd, buf);
      bytes += buf.length;
    },
    close() {
      if (closed) return stats();
      closed = true;
      try {
        const h = header(bytes, SAMPLE_RATE);
        fs.writeSync(fd, h, 4, 4, 4);
        fs.writeSync(fd, h, 40, 4, 40);
      } finally {
        fs.closeSync(fd);
      }
      return stats();
    },
    // Cancelled recording: nothing is kept.
    discard() {
      if (!closed) { closed = true; try { fs.closeSync(fd); } catch {} }
      try { fs.unlinkSync(file); } catch {}
    }
  };
}

// Walks the chunks instead of assuming 44 bytes: NAudio (VoiceTray's records) writes an 18-byte fmt chunk.
// A data size of 0 or past the end (header never fixed up) falls back to what the file actually holds.
function wavDurationMs(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.length < 12 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return 0;
    let byteRate = 0;
    for (let pos = 12; pos + 8 <= head.length;) {
      const id = head.toString("ascii", pos, pos + 4);
      const len = head.readUInt32LE(pos + 4);
      if (id === "fmt " && pos + 16 <= head.length) byteRate = head.readUInt32LE(pos + 16);
      if (id === "data") {
        if (!byteRate) return 0;
        const available = size - (pos + 8);
        const data = len > 0 && len <= available ? len : available;
        return Math.round(Math.max(0, data) / byteRate * 1000);
      }
      pos += 8 + len + (len % 2);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

// Synthesised speech (24 kHz mono s16le) as a WAV, for history. Accepts one Buffer or the list of chunks.
function pcmToWav(pcm, sampleRate = 24000) {
  const data = Array.isArray(pcm) ? Buffer.concat(pcm.map(toBuffer)) : toBuffer(pcm);
  const even = data.subarray(0, data.length - (data.length % 2));
  return Buffer.concat([header(even.length, sampleRate), even]);
}

module.exports = { createWavWriter, wavDurationMs, pcmToWav, SAMPLE_RATE, BYTES_PER_SECOND, HEADER_BYTES };
