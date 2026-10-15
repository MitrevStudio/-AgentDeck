// OpenAI speech-to-text (whisper-1, gpt-4o-transcribe, ...). Port of VoiceTray's OpenAITranscriptionProvider.
// Throws VoiceError only. Requests go through ../../network.js (Chromium's network stack and the proxy settings).
const fs = require("node:fs");
const path = require("node:path");
const network = require("../../network");
const { VoiceError, classify, fromResponse, tooLarge } = require("../errors");
const { t, formatNumber } = require("../../i18n");

const PROVIDER = "OpenAI";
const URL = "https://api.openai.com/v1/audio/transcriptions";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";

// "Files can be up to 25 MB." Decimal, not MiB: read as MiB we would send 26.2 MB and take a 413 at the boundary.
const MAX_UPLOAD_BYTES = 25_000_000;

// The terms go in as `prompt`, which the transcription models read as preceding text: a list of correctly spelled
// words is what steers them. Whisper reads only its last 224 tokens; the diarizing model takes no prompt at all.
const PROMPT_CHARS = 800;
function vocabularyPrompt(model, vocabulary) {
  if (!vocabulary.length || /diarize/i.test(model)) return "";
  let out = "";
  for (const term of vocabulary) {
    const next = out ? `${out}, ${term}` : term;
    if (next.length > PROMPT_CHARS) break;
    out = next;
  }
  return out ? `${out}.` : "";
}

// vocabulary: terms the user wants recognised and spelled their way (dictionary.js).
async function transcribe({ wavPath, model, language, vocabulary = [], apiKey, signal }) {
  try {
    const audio = await fs.promises.readFile(wavPath, { signal });
    // Fail locally rather than spending minutes uploading something that gets rejected.
    if (audio.length > MAX_UPLOAD_BYTES) {
      throw tooLarge(t("voice.errors.tooLarge.openai", { mb: formatNumber(Math.floor(audio.length / 1_000_000)) }));
    }

    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), path.basename(wavPath));
    form.append("model", model);
    if (language && language !== "auto") form.append("language", language);
    const prompt = vocabularyPrompt(model, vocabulary);
    if (prompt) form.append("prompt", prompt);

    const res = await network.fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
    const body = await res.text();
    if (!res.ok) throw fromResponse(res, body, PROVIDER);

    const text = JSON.parse(body)?.text;
    if (typeof text !== "string") {
      throw new VoiceError("MalformedResponse", t("voice.errors.malformed.short"), t("voice.errors.malformed.noTranscript", { model }));
    }
    return text;
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal });
  }
}

// One answer from a chat model: `system` holds the instructions, `text` the material. Empty when the model gave no
// text; the caller decides what that means.
async function generateText({ model, system, text, temperature = 0.2, apiKey, signal }) {
  try {
    const body = JSON.stringify({ model, temperature, messages: [{ role: "system", content: system }, { role: "user", content: text }] });
    const res = await network.fetch(CHAT_URL, {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body, signal
    });
    const reply = await res.text();
    if (!res.ok) throw fromResponse(res, reply, PROVIDER);
    const content = JSON.parse(reply)?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content.trim() : "";
  } catch (error) {
    throw classify({ error, provider: PROVIDER, signal });
  }
}

module.exports = { transcribe, generateText, vocabularyPrompt, MAX_UPLOAD_BYTES };
