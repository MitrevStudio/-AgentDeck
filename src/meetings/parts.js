// The parts a channel is sent in: cut on pauses near the length that suits the model, without the long stretches
// where nobody speaks. Inside a part nothing is removed, so a time in it plus its start is the time in the meeting.
//   A part is { channel, start, end, middle, speech }: ms of the recording, middle being where it would be halved
//   for a retry (null: too short for that), speech the detector's stretches inside it.
const { FRAME_MS } = require("./pcm");

const HALVED_FROM_MS = 20_000;
const QUIET_FRAMES = 10; // a cut inside speech goes to the quietest 200 ms

function clipSpeech(speech, start, end) {
  return speech.filter(s => s.start < end && s.end > start).map(s => ({ start: Math.max(start, s.start), end: Math.min(end, s.end) }));
}

// The best pause to cut in between `from` and `to`, else the quietest place there.
// others: the other channel's speech. preferTurn: a pause that the other side fills wins (the models without times
// keep the order of what was said only that way), else one in which both are silent.
function chooseCut({ levels, speech, others, from, to, target, preferTurn }) {
  const range = Math.max(FRAME_MS, to - from);
  let best = null, most = -Infinity;
  for (let i = 1; i < speech.length; i++) {
    const quiet = { start: speech[i - 1].end, end: speech[i].start }, at = Math.floor((quiet.start + quiet.end) / 2 / FRAME_MS) * FRAME_MS;
    if (at < from || at > to) continue;
    const otherSpeaks = others.some(o => (preferTurn ? o.start < quiet.end && o.end > quiet.start : o.start <= at && o.end >= at));
    const score = Math.min(2000, quiet.end - quiet.start) / 1000 + (otherSpeaks === preferTurn ? 1 : 0) - 2 * Math.abs(at - target) / range;
    if (score > most) { most = score; best = at; }
  }
  if (best !== null) return best;

  let least = Infinity;
  best = target;
  for (let frame = Math.ceil(from / FRAME_MS); frame * FRAME_MS <= to && frame + QUIET_FRAMES <= levels.length; frame++) {
    let sum = 0;
    for (let i = frame; i < frame + QUIET_FRAMES; i++) sum += levels[i];
    const at = (frame + QUIET_FRAMES / 2) * FRAME_MS, score = sum / QUIET_FRAMES + 3 * Math.abs(at - target) / range;
    if (at <= to && score < least) { least = score; best = at; }
  }
  return best;
}

// limits: { min, target, max, gap } in ms; a silence of `gap` ends a part whatever its length.
function planChannel({ channel, levels, speech, others = [], limits, preferTurn = false }) {
  const parts = [];
  let from = 0, i = 0;
  while (i < speech.length) {
    const start = Math.max(from, speech[i].start);
    let last = i;
    while (last + 1 < speech.length && speech[last + 1].start - speech[last].end < limits.gap) last++;
    let end = speech[last].end, cut = end;
    if (end - start > limits.max) {
      const near = [];
      for (let j = i; j <= last && speech[j].start <= start + limits.max; j++) near.push(speech[j]);
      if (near.length + i <= last) near.push(speech[i + near.length]);
      cut = chooseCut({ levels, speech: near, others, from: start + limits.min, to: start + limits.max, target: start + limits.target, preferTurn });
      end = clipSpeech(near, start, cut).at(-1).end;
    }
    const inside = clipSpeech(speech.slice(i, last + 1), start, end), long = end - start;
    const middle = long < HALVED_FROM_MS ? null
      : chooseCut({ levels, speech: inside, others, from: start + long / 4, to: end - long / 4, target: start + long / 2, preferTurn });
    parts.push({ channel, start, end, middle, speech: inside });
    from = cut;
    while (i < speech.length && speech[i].end <= cut) i++;
  }
  return parts;
}

// The two halves of a part for its one retry, or none where that cannot help.
function halve({ channel, start, end, middle, speech }) {
  if (middle === null) return [];
  const halves = [clipSpeech(speech, start, middle), clipSpeech(speech, middle, end)];
  if (halves.some(half => !half.length)) return [];
  return halves.map(half => ({ channel, start: half[0].start, end: half.at(-1).end, middle: null, speech: half }));
}

module.exports = { planChannel, halve };
