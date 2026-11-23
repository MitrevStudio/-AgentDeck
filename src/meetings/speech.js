// Where somebody speaks in a channel, by its levels (pcm.js) alone. It errs towards speech: what it takes for silence
// is never sent, what it takes for speech by mistake costs a little.
const { FRAME_MS, SILENCE_DB } = require("./pcm");

const BLOCK = 10_000 / FRAME_MS; // the noise floor is taken per 10 s ...
const AROUND = 3; // ... from three such blocks on each side as well
const NOISE_SHARE = 0.1; // the quietest tenth is the noise; with digital silence among it, any sound may be speech
const ABOVE_NOISE_DB = 8;
const THRESHOLD_DB = { min: -62, max: -38 };
const BRIDGE = 300 / FRAME_MS; // a shorter pause is inside what is said
const SHORTEST = 120 / FRAME_MS; // less sound is a click
const PAD = 200 / FRAME_MS;

function thresholds(levels) {
  const blocks = [];
  for (let from = 0; from < levels.length; from += BLOCK) {
    const histogram = new Uint32Array(-SILENCE_DB + 1);
    for (const db of levels.subarray(from, from + BLOCK)) histogram[Math.min(-SILENCE_DB, Math.max(0, Math.floor(db - SILENCE_DB)))]++;
    blocks.push(histogram);
  }
  return blocks.map((_, i) => {
    const near = blocks.slice(Math.max(0, i - AROUND), i + AROUND + 1);
    const wanted = near.reduce((sum, h) => h.reduce((n, v) => n + v, sum), 0) * NOISE_SHARE;
    let bin = 0;
    for (let seen = 0; bin < -SILENCE_DB; bin++) {
      for (const h of near) seen += h[bin];
      if (seen >= wanted) break;
    }
    return Math.min(THRESHOLD_DB.max, Math.max(THRESHOLD_DB.min, SILENCE_DB + bin + ABOVE_NOISE_DB));
  });
}

// -> [{ start, end }] in ms, in order and apart.
function findSpeech(levels) {
  const limit = thresholds(levels), runs = [];
  for (let i = 0; i < levels.length; i++) {
    if (levels[i] <= limit[Math.floor(i / BLOCK)]) continue;
    const last = runs.at(-1);
    if (last && i - last.to < BRIDGE) Object.assign(last, { to: i + 1, sound: last.sound + 1 });
    else runs.push({ from: i, to: i + 1, sound: 1 });
  }
  const speech = [];
  for (const run of runs) {
    if (run.sound < SHORTEST) continue;
    const start = Math.max(0, run.from - PAD) * FRAME_MS, end = Math.min(levels.length, run.to + PAD) * FRAME_MS;
    if (speech.length && start <= speech.at(-1).end) speech.at(-1).end = end;
    else speech.push({ start, end });
  }
  return speech;
}

module.exports = { findSpeech };
