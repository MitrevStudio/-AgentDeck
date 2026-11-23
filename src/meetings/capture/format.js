// The raw recording: mic and system interleaved on one clock, signed 16-bit little-endian at 16 kHz.
const { SAMPLE_RATE } = require("../../voice/wav");

const CHANNELS = ["mic", "system"];
const FRAME_BYTES = CHANNELS.length * 2;
const FRAMES_PER_MS = SAMPLE_RATE / 1000;
const msOf = frames => Math.floor(frames / FRAMES_PER_MS);

module.exports = { CHANNELS, SAMPLE_RATE, FRAME_BYTES, FRAMES_PER_MS, msOf };
