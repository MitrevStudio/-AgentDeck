// What can be wrong with an answer that looks like a success, and is seen without a model: cut off, times that
// cannot be, text where nobody speaks, repetition, another language, nearly nothing for a lot of speech.
// The thresholds are starting values from the research, to be corrected by real meetings.
const { words } = require("./text");

const TIME_TOLERANCE_MS = { word: 1000, segment: 5000 };
const NEAR_SPEECH_MS = { word: 1500, segment: 5000 };
const CUT_OFF_MS = { word: 10_000, segment: 15_000 }; // of detected speech after the last word: a cough is none
const SILENT_SHARE = 0.25; // this much text in silence: the times have drifted
const MISSING = { emptyMs: 5000, speechMs: 30_000, perMinute: 20 };
const TOO_MANY = { speechMs: 10_000, words: 50, perMinute: 330 };
const PHRASE_MAX = 10; // words
const REPEATS = { word: 8, phrase: 5 };
const FOREIGN_SHARE = 0.3;
const CJK = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/u;
const SCRIPTS = { bg: "Cyrillic", ru: "Cyrillic", ja: "Japanese", zh: "Han" };
const NOT_BULGARIAN = /[ыэёјљњћђїєі]/gi;

function repeats(list) {
  for (let size = 1; size <= PHRASE_MAX; size++) {
    const needed = ((size === 1 ? REPEATS.word : REPEATS.phrase) - 1) * size;
    let same = 0;
    for (let i = size; i < list.length; i++) {
      same = list[i] === list[i - size] ? same + 1 : 0;
      if (same >= needed) return true;
    }
  }
  return false;
}

function wrongLanguage(text, expected, heard = []) {
  if (!expected.length) return false;
  if (heard.length && !heard.some(code => expected.includes(code.slice(0, 2).toLowerCase()))) return true;
  const letters = text.match(/\p{L}/gu) || [];
  if (letters.length < 40) return false;
  const scripts = new Set(expected.map(code => SCRIPTS[code] || "Latin"));
  const belongs = [...scripts].map(script =>
    (script === "Japanese" ? CJK : new RegExp(`\\p{sc=${script}}`, "u")));
  if (letters.filter(l => !belongs.some(re => re.test(l))).length > letters.length * FOREIGN_SHARE) return true;
  if (!expected.includes("bg") || expected.includes("ru")) return false;
  const others = text.match(NOT_BULGARIAN)?.length || 0;
  return others >= 3 && others > (text.match(/\p{sc=Cyrillic}/gu)?.length || 0) * 0.005;
}

// answer: what providers/*.read() gave. -> { spans, reasons, halve }: every span with a time inside the part, `doubt`
// on those whose time or place is suspect; reasons is why the part is doubtful, halve whether asking for its halves
// can mend that: a cut-off, a loop, words left out. Another language, missing or drifting times and text in silence
// come back the same from halves, and are only marked.
function checkAnswer(answer, part, { grain, languages = [] }) {
  const reasons = new Set();
  if (answer.truncated) reasons.add("truncated");
  if (!answer.readable) return { spans: [], reasons: [...reasons, "unreadable"], halve: true };

  const said = answer.spans.filter(s => s.text.trim());
  const { speech } = part, first = speech[0]?.start ?? part.start, last = speech.at(-1)?.end ?? part.end;
  let silent = 0;
  const spans = said.map(span => {
    // Without times a span is as exact as the part: from its first speech to its last.
    if (grain === "part") return { ...span, start: first, end: last };
    if (span.start === null || span.end === null) {
      reasons.add("timing");
      const start = span.start === null ? first : Math.min(part.end, Math.max(part.start, span.start));
      return { ...span, start, end: Math.max(start, last), doubt: true };
    }
    const tolerance = TIME_TOLERANCE_MS[grain];
    const outside = span.start < part.start - tolerance || span.end > part.end + tolerance || span.end < span.start;
    if (outside) reasons.add("timing");
    const start = Math.min(part.end, Math.max(part.start, span.start));
    const end = Math.max(start, Math.min(part.end, span.end));
    const near = NEAR_SPEECH_MS[grain];
    const inSilence = !outside && !speech.some(s => s.start - near <= end && s.end + near >= start);
    if (inSilence) silent++;
    return { ...span, start, end, ...((outside || inSilence) && { doubt: true }) };
  });

  const text = said.map(s => s.text).join(" "), list = words(text);
  const speechMs = speech.reduce((sum, s) => sum + s.end - s.start, 0), perMinute = list.length / (speechMs / 60_000);
  if (silent && silent >= spans.length * SILENT_SHARE) reasons.add("silence");
  let untoldCut = false; // speech after the last word, which drifting times also give
  if (grain !== "part" && list.length) {
    const told = Math.max(...spans.map(s => s.end));
    const untold = speech.reduce((sum, s) => sum + Math.max(0, s.end - Math.max(s.start, told)), 0);
    untoldCut = untold > CUT_OFF_MS[grain];
    if (untoldCut) reasons.add("truncated");
  }
  if ((!list.length && speechMs > MISSING.emptyMs) || (speechMs >= MISSING.speechMs && perMinute < MISSING.perMinute)) reasons.add("missing");
  if (repeats(list)) reasons.add("repetition");
  // A character is no word where they are written without spaces.
  if (speechMs >= TOO_MANY.speechMs && list.length > TOO_MANY.words && perMinute > TOO_MANY.perMinute && !CJK.test(text)) reasons.add("repetition");
  if (wrongLanguage(text, languages, answer.languages)) reasons.add("language");
  const drifted = reasons.has("timing") || reasons.has("silence");
  const halve = Boolean(answer.truncated) || reasons.has("repetition") || reasons.has("missing") || (untoldCut && !drifted);
  return { spans, reasons: [...reasons], halve };
}

module.exports = { checkAnswer };
