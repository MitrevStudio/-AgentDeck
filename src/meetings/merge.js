// The checked parts of both channels as one list by time: utterances of "me" (the microphone) and "others" (the
// system's sound), a gap where a part failed, a note where one is doubtful. What the microphone picked up from the
// loudspeakers is flagged as a likely echo, carefully, and stays: losing what somebody really said is worse than
// saying it twice.
const { clean, words } = require("./text");

const SPEAKERS = { mic: "me", system: "others" };
const PAUSE_MS = 1200;
const SENTENCE_PAUSE_MS = 600;
const SENTENCE_LINE_MS = 20_000; // a line this long ends with its sentence
const LINE_MS = 40_000; // and this long ends anyway
const SENTENCE_END = /[.!?…。！？]["»”)]?\s*$/u;
const ECHO = {
  words: { word: 6, segment: 6, part: 10 }, // shorter is what people do say in chorus: "yes, that is right"
  editsFrom: 8, editShare: 0.15 // two transcriptions of one sound differ in a word
};

// Words grouped into what is said in one breath; the other grains already are lines.
function toLines(spans, grain) {
  const groups = [];
  let group = [];
  for (const span of spans) {
    const before = group.at(-1);
    if (before) {
      const pause = span.start - before.end, long = before.end - group[0].start, sentence = SENTENCE_END.test(before.text);
      const ends = grain !== "word" || Boolean(span.doubt) !== Boolean(before.doubt) || pause >= PAUSE_MS || pause < -PAUSE_MS
        || (sentence && (pause >= SENTENCE_PAUSE_MS || long >= SENTENCE_LINE_MS)) || long >= LINE_MS;
      if (ends) { groups.push(group); group = []; }
    }
    group.push(span);
  }
  if (group.length) groups.push(group);
  return groups.map(list => ({
    start: list[0].start, end: Math.max(...list.map(s => s.end)), text: clean(list.map(s => s.text).join("")),
    ...(list.some(s => s.doubt) && { doubt: true })
  })).filter(line => line.text);
}

// The fewest edits that make `part` a run of `whole`.
function editsWithin(part, whole) {
  let before = new Array(whole.length + 1).fill(0); // it may start anywhere
  for (let i = 1; i <= part.length; i++) {
    const row = [i];
    for (let j = 1; j <= whole.length; j++) {
      row.push(Math.min(before[j - 1] + (part[i - 1] === whole[j - 1] ? 0 : 1), before[j] + 1, row[j - 1] + 1));
    }
    before = row;
  }
  return Math.min(...before); // and end anywhere
}

// The same words at the same time on the other channel, their times overlapping: at another time it is an answer or
// a confirmation.
function isEcho(line, others, grain) {
  const mine = words(line.text);
  if (mine.length < ECHO.words[grain]) return false;
  const theirs = words(others.filter(s => s.start < line.end && s.end > line.start).map(s => s.text).join(" "));
  const allowed = mine.length < ECHO.editsFrom ? 0 : Math.floor(mine.length * ECHO.editShare);
  return theirs.length >= mine.length - allowed && editsWithin(mine, theirs) <= allowed;
}

// results: [{ part, spans, reasons }] or [{ part, failed: <error code> }], screens: the meeting's.
// -> the entries of the transcript, echoes and all.
function merge(results, { grain, screens = [] }) {
  const others = results.filter(r => r.part.channel === "system" && !r.failed).flatMap(r => r.spans);
  const entries = [];
  for (const { part, spans, reasons = [], failed } of results) {
    const speaker = SPEAKERS[part.channel], { start, end } = part;
    if (failed) { entries.push({ type: "gap", speaker, start, end, reason: failed }); continue; }
    for (const reason of reasons) entries.push({ type: "note", speaker, start, end, reason });
    for (const line of toLines(spans, grain)) {
      entries.push({ type: "speech", speaker, ...line, ...(speaker === "me" && isEcho(line, others, grain) && { echo: true }) });
    }
  }
  for (const { file, atMs, monitor, window } of screens) entries.push({ type: "screen", start: atMs, file, ...(window ? { window } : { monitor }) });
  const order = { gap: 0, note: 1, speech: 2, screen: 3 };
  return entries.sort((a, b) => a.start - b.start || order[a.type] - order[b.type]);
}

module.exports = { merge };
