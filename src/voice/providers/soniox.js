// Soniox: speech-to-text through its file API and streamed text-to-speech. It has no request that takes the audio and
// answers with the text: a recording is uploaded, transcribed as a job that is asked about until it is over, its
// transcript fetched, and both are deleted there (left alone they stay for 30 days). Throws VoiceError only.
//
// The key travels in the Authorization header. Requests go through ../../network.js (Chromium's network stack and the
// proxy settings).
const fs = require("node:fs");
const path = require("node:path");
const timers = require("node:timers/promises");
const network = require("../../network");
const { VoiceError, classify, fromResponse, tooLarge } = require("../errors");
const { t, formatNumber } = require("../../i18n");
const { BYTES_PER_SECOND, HEADER_BYTES } = require("../wav");

const PROVIDER = "Soniox";
const API = "https://api.soniox.com/v1";
const SPEECH_URL = "https://tts-rt.soniox.com/tts";

// "File duration: 300 minutes", fixed. The size a file may have is not published.
const MAX_AUDIO_MINUTES = 300;
const MAX_RECORDING_BYTES = HEADER_BYTES + MAX_AUDIO_MINUTES * 60 * BYTES_PER_SECOND;

// Asked for as headerless 16-bit little-endian PCM, 24 kHz, which is also what Gemini streams.
const SPEECH_SAMPLE_RATE = 24000;

// Ids come back from the service and go into the next request's path.
const ID = /^[A-Za-z0-9_-]{1,100}$/;
// A file or a transcription as it is deleted: "files/<id>", "transcriptions/<id>".
const NAME = /^(files|transcriptions)\/[A-Za-z0-9_-]{1,100}$/;
const DELETE_TIMEOUT_MS = 15_000;

// Soniox's own samples ask every second. A dictation is short and somebody is waiting for it, so the first questions
// come sooner.
const POLL_MS = [300, 300, 500, 700, 1000];

// "Maximum 8,000 tokens (about 10,000 characters)" for the whole context; Cyrillic takes more tokens a character.
const CONTEXT_CHARS = 5000;

const auth = apiKey => ({ Authorization: `Bearer ${apiKey}` });

// An answer that came with a 2xx and is not what the step answers with: said with the step, the status, the type and
// how it begins, because between here and Soniox there may be a proxy that answers in its place, and only this tells
// which request it was and what came instead. A page is named as one, like a page that comes with an error status.
const START_CHARS = 200;
function unexpected(step, res, text, retryable = false) {
  const status = res.status, start = String(text).replace(/\s+/g, " ").trim().slice(0, START_CHARS);
  const long = start.startsWith("<")
    ? t("voice.errors.malformed.html", { provider: PROVIDER, status })
    : t("voice.errors.malformed.unexpected", {
      provider: PROVIDER, step, status, type: res.headers?.get("content-type") || "-", start: start || "-"
    });
  return new VoiceError(retryable ? "ServerError" : "MalformedResponse", t("voice.errors.malformed.short"), long, { retryable, status });
}

// One request of the file API, answered with its body as text: a JSON object, or it is not an answer of the API's.
// `step` is the request's name in an error; `again`: asking once more is free, so such an answer may be asked again.
// `json` is sent as JSON, `body` as it is.
async function send(step, name, { apiKey, signal, method = "GET", json, body, again = false }) {
  const headers = json ? { ...auth(apiKey), "content-type": "application/json" } : auth(apiKey);
  const res = await network.fetch(`${API}/${name}`, { method, headers, body: json ? JSON.stringify(json) : body, signal });
  const text = await res.text();
  // Status before parsing: a proxy 502 answers with HTML, not JSON.
  if (!res.ok) throw fromResponse(res, text, PROVIDER);
  let root = null;
  try { root = JSON.parse(text); } catch {}
  if (!root || typeof root !== "object") throw unexpected(step, res, text, again);
  return { text, root, res };
}

function idOf(step, { text, root, res }) {
  if (typeof root.id !== "string" || !ID.test(root.id)) throw unexpected(step, res, text);
  return root.id;
}

// -> the file's id. No Content-Type of ours: the form sets it, with its boundary.
async function upload(audio, name, apiKey, signal) {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), name);
  return idOf("upload", await send("upload", "files", { method: "POST", body: form, apiKey, signal }));
}

// The dictionary's terms, as many as fit: the context has a size, and a request over it is refused whole.
function contextTerms(vocabulary) {
  const terms = [];
  let chars = 0;
  for (const term of vocabulary) {
    if ((chars += term.length + 1) > CONTEXT_CHARS) break;
    terms.push(term);
  }
  return terms;
}

// Starts the transcription of an uploaded file -> its id. languages: the codes expected ("bg", "en"), none to detect;
// they are hints, the model still writes down another language it hears. identify: every token comes with its
// language. This is the request that is paid for.
async function create({ model, file, languages = [], terms = [], identify = false }, apiKey, signal) {
  const json = { model, file_id: file };
  if (languages.length) json.language_hints = languages;
  if (terms.length) json.context = { terms };
  if (identify) json.enable_language_identification = true;
  return idOf("start", await send("start", "transcriptions", { method: "POST", json, apiKey, signal }));
}

// A job that failed says so in its own fields, with a 200: read as the status that kind of failure comes with
// elsewhere, so that it is described, and repeated or not, like any other.
function jobError(job) {
  const type = typeof job.error_type === "string" ? job.error_type : "";
  const status = type.endsWith("_exhausted") ? 402 : type === "internal_error" || !type ? 500 : 400;
  return classify({ status, body: JSON.stringify({ error_type: type || "internal_error", message: job.error_message }), provider: PROVIDER });
}

// Whether a transcription is over: true, false while it is queued or worked on, a throw when it failed. The
// reference names the failure "error", the errors page "failed"; any other word is a job still on its way.
async function finished(id, apiKey, signal) {
  const job = (await send("status", `transcriptions/${id}`, { apiKey, signal, again: true })).root;
  if (job.status === "error" || job.status === "failed") throw jobError(job);
  return job.status === "completed";
}

// The transcript exactly as it came: {text, tokens: [{text, start_ms, end_ms, confidence, language?}]}.
async function transcript(id, apiKey, signal) {
  const answer = await send("transcript", `transcriptions/${id}/transcript`, { apiKey, signal });
  if (typeof answer.root.text !== "string") throw unexpected("transcript", answer.res, answer.text);
  return answer.text;
}

// Deletes a file or a transcription there, with a budget of its own: what it follows may have been cancelled.
// -> whether it is gone; never throws. A transcription still being worked on is refused (409) and stays.
async function remove(name, apiKey, timeoutMs = DELETE_TIMEOUT_MS) {
  if (!NAME.test(name)) return true;
  try {
    const res = await network.fetch(`${API}/${name}`, { method: "DELETE", headers: auth(apiKey), signal: AbortSignal.timeout(timeoutMs) });
    await res.text();
    return res.ok || res.status === 404;
  } catch (error) {
    console.error(`${name} was not deleted at Soniox (it is, after 30 days):`, classify({ error, provider: PROVIDER }).longMessage);
    return false;
  }
}

// vocabulary: terms the user wants recognised and spelled their way (dictionary.js). Should the service refuse the
// context (a 400 that names it), the recording is transcribed without it: the dictionary must never cost a dictation.
async function transcribe({ wavPath, model, language, vocabulary = [], apiKey, signal }) {
  let file = "", job = "";
  try {
    const audio = await fs.promises.readFile(wavPath, { signal });
    if (audio.length > MAX_RECORDING_BYTES) {
      throw tooLarge(t("voice.errors.tooLarge.soniox", {
        minutes: formatNumber(Math.floor((audio.length - HEADER_BYTES) / BYTES_PER_SECOND / 60)), max: formatNumber(MAX_AUDIO_MINUTES)
      }));
    }
    file = await upload(audio, path.basename(wavPath), apiKey, signal);
    const request = { model, file, languages: language && language !== "auto" ? [language] : [], terms: contextTerms(vocabulary) };
    try {
      job = await create(request, apiKey, signal);
    } catch (error) {
      if (!request.terms.length || error?.status !== 400 || !/context/i.test(error.longMessage || "")) throw error;
      console.error("Soniox refused the context; transcribing without it:", error.longMessage);
      job = await create({ ...request, terms: [] }, apiKey, signal);
    }
    for (let asked = 0; ; asked++) {
      await timers.setTimeout(POLL_MS[Math.min(asked, POLL_MS.length - 1)], undefined, { signal });
      if (await finished(job, apiKey, signal)) break;
    }
    return JSON.parse(await transcript(job, apiKey, signal)).text;
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal });
  } finally {
    // Whatever happened: the transcription holds the text, the file the voice. Waited for briefly, so that a quit right
    // after the paste does not leave them there.
    await Promise.all([job && `transcriptions/${job}`, file && `files/${file}`].filter(Boolean).map(name => remove(name, apiKey, 5000)));
  }
}

// ---------- speech ----------
// Soniox has to be told the language of the text. The dictation's, when one is set; otherwise by the script: Cyrillic
// is taken for Bulgarian, anything else for English. A quarter of the letters is enough: a Bulgarian sentence about
// code is half file names and identifiers, an English one has no Cyrillic to speak of. It is the accent the voice
// leans to, not a filter: the other languages in a mixed text are still read.
function speechLanguage(text, language) {
  const set = String(language || "").trim().toLowerCase();
  if (set && set !== "auto") return set.split("-")[0]; // "pt-br": Soniox knows languages, not regions
  const letters = text.match(/\p{L}/gu)?.length || 0, cyrillic = text.match(/\p{sc=Cyrillic}/gu)?.length || 0;
  return cyrillic * 4 >= letters && cyrillic ? "bg" : "en";
}

// The body in pieces of whole samples, however the network cut it.
async function* wholeSamples(body) {
  const reader = body.getReader();
  let carry = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      let pcm = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (carry) { pcm = Buffer.concat([carry, pcm]); carry = null; }
      if (pcm.length % 2) { carry = Buffer.from(pcm.subarray(pcm.length - 1)); pcm = pcm.subarray(0, pcm.length - 1); }
      if (pcm.length) yield pcm;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// A stalled stream must not hang the reader forever; the budget Gemini's speech has.
const speechTimeoutMs = text => Math.min(60_000 + String(text).length * 100, 300_000);

// Streams synthesised speech as Buffers of 24 kHz mono s16le PCM, like Gemini's speak(): the request starts on the
// first next(), `signal` aborts it, `timeoutMs: 0` disables the built-in budget. One request speaks for two minutes at
// most and ends there without a word about it, so the caller keeps the text of each well under that (tts.js). An
// answer with no audio at all is a failure: a failure after the 200 is only the connection closing.
async function* speak({ text, model, voice, language, apiKey, signal, timeoutMs }) {
  const budget = timeoutMs ?? speechTimeoutMs(text);
  const attempt = budget > 0 ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget)) : signal;
  const body = { model, language: speechLanguage(text, language), voice, audio_format: "pcm_s16le", sample_rate: SPEECH_SAMPLE_RATE, text };
  try {
    const res = await network.fetch(SPEECH_URL, {
      method: "POST", headers: { ...auth(apiKey), "content-type": "application/json" }, body: JSON.stringify(body), signal: attempt
    });
    if (!res.ok) throw fromResponse(res, await res.text(), PROVIDER);
    let bytes = 0;
    for await (const pcm of wholeSamples(res.body)) {
      bytes += pcm.length;
      yield pcm;
    }
    if (!bytes) throw unexpected("speech", res, "", true);
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal: attempt });
  }
}

module.exports = {
  transcribe, speak, MAX_RECORDING_BYTES, SPEECH_SAMPLE_RATE,
  // For the meetings' requests (../../meetings/providers/soniox.js).
  upload, create, finished, transcript, remove
};
