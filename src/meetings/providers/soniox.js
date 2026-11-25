// A meeting's part through Soniox: uploaded, transcribed as a job that is asked about until it is over, its transcript
// fetched (tokens with their times and languages), then both deleted there. The same shape as gemini.js.
//   ask(request) resolves with the transcript exactly as it came, after request.keep() has it on disk.
//   read(body, part) -> { readable, truncated, languages, spans: [{ start, end, text }] } in ms of the recording.
// The speakers of a meeting are its channels ("me", "others"), so nobody is asked to tell voices apart.
const { VoiceError } = require("../../voice/errors");
const soniox = require("../../voice/providers/soniox");
const { t } = require("../../i18n");

const PROVIDER = "Soniox";
// What the uploads list calls a file or a transcription of ours: "soniox/files/<id>". The list is the meeting's, and
// Gemini's files are in it under names of the same look.
const OURS = "soniox/";
const POLL_MS = 2000;
const POLLS = 300; // ten minutes for a part of fourteen at most
// A token of these scripts is a word of its own: they are written without spaces.
const UNSPACED = /^[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]/u;

const unfinished = () => new VoiceError("ServerError", t("voice.errors.malformed.short"),
  t("voice.errors.malformed.unreadable", { provider: PROVIDER }), { retryable: true });

async function whenFinished(id, apiKey, call) {
  for (let i = 0; i < POLLS; i++) {
    await call.wait(POLL_MS);
    if (await call(signal => soniox.finished(id, apiKey, signal), { free: true })) return;
  }
  throw unfinished();
}

// What is uploaded and started there is written down (uploads) before anything else is asked, for a crash to leave
// nothing behind; only starting the transcription is paid for. Whatever happens, both are deleted: the transcription
// first, a file under one that has not begun would fail it.
async function ask({ wav, model, languages, apiKey, call, keep, uploads }) {
  const made = [];
  const add = async name => { made.unshift(OURS + name); await uploads.add(OURS + name); };
  try {
    const file = await call(signal => soniox.upload(wav, "part.wav", apiKey, signal), { free: true });
    await add(`files/${file}`);
    const id = await call(signal => soniox.create({ model, file, languages, identify: true }, apiKey, signal));
    await add(`transcriptions/${id}`);
    await whenFinished(id, apiKey, call);
    const text = await call(signal => soniox.transcript(id, apiKey, signal), { free: true });
    await keep(text);
    return text;
  } finally {
    for (const name of made) if (await removeFile(name, apiKey)) await uploads.remove(name);
  }
}

// The tokens are pieces of words: one that starts with a space starts a word, one without continues it, punctuation
// included. A word is a span with the space before it, so that the spans joined are the text.
function read(body, { start }) {
  let root;
  try { root = JSON.parse(body); } catch { return { readable: false, spans: [] }; }
  if (typeof root?.text !== "string" || !Array.isArray(root.tokens)) return { readable: false, spans: [] };
  const spans = [], languages = new Set();
  let word = null;
  for (const token of root.tokens) {
    if (typeof token?.text !== "string" || !token.text || token.is_audio_event) continue;
    if (typeof token.language === "string") languages.add(token.language);
    const from = Number.isFinite(token.start_ms) ? start + token.start_ms : null;
    const to = Number.isFinite(token.end_ms) ? start + token.end_ms : null;
    if (word && !/^\s/.test(token.text) && !UNSPACED.test(token.text)) {
      word.text += token.text;
      word.end = to ?? word.end;
    } else {
      spans.push(word = { start: from, end: to, text: token.text });
    }
  }
  // Tokens that say nothing where the text does: the part's text is then one piece without times.
  if (!spans.length && root.text.trim()) spans.push({ start: null, end: null, text: root.text });
  return { readable: true, truncated: false, languages: [...languages], spans };
}

// -> whether it is gone; a name that is not ours is none of this provider's to keep.
const removeFile = async (name, apiKey) => !name.startsWith(OURS) || soniox.remove(name.slice(OURS.length), apiKey);

module.exports = { words: { ask, read }, removeFile };
