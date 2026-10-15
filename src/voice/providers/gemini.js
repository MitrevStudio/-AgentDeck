// Gemini: speech-to-text and streamed text-to-speech. Port of VoiceTray's GeminiTranscriptionProvider,
// GeminiInteractions and GeminiSpeechProvider. Throws VoiceError only.
//
// The key always travels in the x-goog-api-key header, never in the URL: URLs end up in error messages, and
// those are shown in the UI. Requests go through ../../network.js (Chromium's network stack and the proxy settings).
const fs = require("node:fs");
const network = require("../../network");
const { classify, fromResponse, tooLarge } = require("../errors");
const { t, formatNumber } = require("../../i18n");

const PROVIDER = "Gemini";
const GENERATE_URL = model => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
// Pins the Interactions request/response shape this was written and tested against.
const API_REVISION = "2026-05-20";

// Gemini caps a whole request at 20 MB and base64 inflates audio by 4/3: 14 MB of audio encodes to ~18.7 MB,
// which leaves room for the JSON envelope. Our ceiling, not the model's (the Files API takes far longer audio).
const MAX_INLINE_BYTES = 14_000_000;

// The dedicated speech-to-text model lives behind the Interactions API, not generateContent.
const TRANSCRIBE_MODEL_PREFIX = "gemini-3.5-transcribe";

// Streamed speech is headerless 16-bit little-endian PCM, 24 kHz mono.
const SPEECH_SAMPLE_RATE = 24000;

// Prompt wording for the general-purpose models, which are only told in prose.
const LANGUAGE_NAMES = {
  bg: "Bulgarian", en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", ru: "Russian", ja: "Japanese", zh: "Chinese", tr: "Turkish"
};

// BCP-47, which is what the transcription model's language_codes wants.
const LANGUAGE_TAGS = {
  bg: "bg-BG", en: "en-US", es: "es-ES", fr: "fr-FR", de: "de-DE", it: "it-IT",
  pt: "pt-PT", ru: "ru-RU", ja: "ja-JP", zh: "zh-CN", tr: "tr-TR"
};

const isTranscribeModel = model => String(model || "").toLowerCase().startsWith(TRANSCRIBE_MODEL_PREFIX);

const jsonHeaders = apiKey => ({ "content-type": "application/json; charset=utf-8", "x-goog-api-key": apiKey });
const interactionHeaders = apiKey => ({ ...jsonHeaders(apiKey), "Api-Revision": API_REVISION });

async function postJson(url, headers, body, signal) {
  const res = await network.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  const text = await res.text();
  // Status before parsing: a proxy 502 answers with HTML, not JSON.
  if (!res.ok) throw fromResponse(res, text, PROVIDER);
  return JSON.parse(text);
}

// Unary Interactions reply: steps[] -> content[] -> text, for "model_output" steps. The REST body has no
// "output_text" (the SDKs flatten it); honoured anyway in case a later revision adds it. Silence = no steps.
function readText(root) {
  if (typeof root?.output_text === "string") return root.output_text.trim();
  if (!Array.isArray(root?.steps)) return "";
  let out = "";
  for (const step of root.steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const item of step.content) if (item?.type === "text" && typeof item.text === "string") out += item.text;
  }
  return out.trim();
}

// No prompt: this model only transcribes. "smart" removes filler words and adds punctuation and capitalisation,
// which is what dictation wants; no language_codes means auto-detect.
async function viaInteractions(data, apiKey, model, language, signal) {
  const tag = language !== "auto" ? LANGUAGE_TAGS[language] : undefined;
  const body = {
    model,
    input: [{ type: "audio", data, mime_type: "audio/wav" }],
    generation_config: { transcription_config: tag ? { language_codes: [tag], mode: "smart" } : { mode: "smart" } }
  };
  return readText(await postJson(INTERACTIONS_URL, interactionHeaders(apiKey), body, signal));
}

// The general-purpose models are chat models asked to transcribe, so the instruction is spelled out.
async function viaGenerateContent(data, apiKey, model, language, signal) {
  let prompt = "Transcribe this audio recording accurately. " +
    "Respond with ONLY the transcribed text, without any commentary, labels, or quotation marks.";
  if (language && language !== "auto" && LANGUAGE_NAMES[language]) prompt += ` The spoken language is ${LANGUAGE_NAMES[language]}.`;

  const body = {
    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "audio/wav", data } }] }],
    generationConfig: { temperature: 0.0 }
  };
  const root = await postJson(GENERATE_URL(model), jsonHeaders(apiKey), body, signal);
  // No candidates (blocked) or a safety-blocked candidate without content: nothing to type, not an error.
  const parts = root?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map(p => (typeof p?.text === "string" ? p.text : "")).join("").trim();
}

async function transcribe({ wavPath, model, language, apiKey, signal }) {
  try {
    const audio = await fs.promises.readFile(wavPath, { signal });
    if (audio.length > MAX_INLINE_BYTES) {
      throw tooLarge(t("voice.errors.tooLarge.gemini", { mb: formatNumber(Math.floor(audio.length / 1_000_000)) }));
    }
    const data = audio.toString("base64");
    return isTranscribeModel(model)
      ? await viaInteractions(data, apiKey, model, language, signal)
      : await viaGenerateContent(data, apiKey, model, language, signal);
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal });
  }
}

// A failure mid-stream arrives as an event after a 200 has been sent; reuse the one classifier on it.
function streamError(error) {
  const status = typeof error?.code === "number" ? error.code : 500;
  return classify({ status, body: JSON.stringify({ error }), provider: PROVIDER });
}

function audioDelta(event) {
  if (event?.event_type !== "step.delta") return null;
  const delta = event.delta;
  if (delta?.type !== "audio" || typeof delta.data !== "string") return null;
  return Buffer.from(delta.data, "base64");
}

// Server-sent events: each "data:" line is a JSON event with its own event_type; audio comes as step.delta events
// {type:"audio", data:base64, mime_type:"audio/l16"}; the stream ends with a literal "data: [DONE]".
async function* readAudioStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let carry = null; // keeps every yielded chunk whole samples even if an event splits one
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = done ? "" : lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (!payload) continue;
        const event = JSON.parse(payload);
        if (event?.error) throw streamError(event.error);
        let pcm = audioDelta(event);
        if (!pcm?.length) continue;
        if (carry) { pcm = Buffer.concat([carry, pcm]); carry = null; }
        if (pcm.length % 2) { carry = Buffer.from(pcm.subarray(pcm.length - 1)); pcm = pcm.subarray(0, pcm.length - 1); }
        if (pcm.length) yield pcm;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// A stalled stream must not hang the reader forever (VoiceTray's SpeechService budget: 60 s + 0.1 s per char, ≤ 5 min).
const speechTimeoutMs = text => Math.min(60_000 + String(text).length * 100, 300_000);

// Streams synthesised speech as Buffers of 24 kHz mono s16le PCM, so playback can start after the first chunk
// (~3.5 s) instead of after the whole passage. The request starts on the first next(). Abort with `signal`
// (throws a VoiceError of kind "Cancelled") or stop iterating (closes the connection). `timeoutMs: 0` disables
// the built-in budget.
async function* speak({ text, model, voice, apiKey, signal, timeoutMs }) {
  const budget = timeoutMs ?? speechTimeoutMs(text);
  const attempt = budget > 0 ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget)) : signal;
  const body = {
    model,
    stream: true,
    input: [{ type: "user_input", content: [{ type: "text", text }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] }
  };
  try {
    const res = await network.fetch(INTERACTIONS_URL, { method: "POST", headers: interactionHeaders(apiKey), body: JSON.stringify(body), signal: attempt });
    if (!res.ok) throw fromResponse(res, await res.text(), PROVIDER);
    yield* readAudioStream(res.body);
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal: attempt });
  }
}

module.exports = { transcribe, speak, isTranscribeModel, MAX_INLINE_BYTES, SPEECH_SAMPLE_RATE };
