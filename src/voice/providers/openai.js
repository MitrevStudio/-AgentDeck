// OpenAI speech-to-text and text; what each model takes is the catalog's to say (../catalog.js). Port of VoiceTray's
// OpenAITranscriptionProvider. Throws VoiceError only. Requests go through ../../network.js (Chromium's network stack and the proxy settings).
const fs = require("node:fs");
const path = require("node:path");
const network = require("../../network");
const { VoiceError, classify, fromResponse, tooLarge } = require("../errors");
const { t, formatNumber } = require("../../i18n");
const { modelInfo } = require("../catalog");

const PROVIDER = "OpenAI";
const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";

// "Files can be up to 25 MB." Decimal, not MiB: read as MiB we would send 26.2 MB and take a 413 at the boundary.
const MAX_UPLOAD_BYTES = 25_000_000;

// gpt-transcribe takes the terms as `keywords`, one field each, and refuses the whole request over one with < > or a
// line break: such a term is left out, the dictionary must never cost a dictation.
const keywordTerms = vocabulary => vocabulary.filter(term => !/[<>\r\n]/.test(term));

// The older models read them as `prompt`, their preceding text: a list of correctly spelled words is what steers
// them. Whisper reads only its last 224 tokens.
const PROMPT_CHARS = 800;
function vocabularyPrompt(vocabulary) {
  if (!vocabulary.length) return "";
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
    const info = modelInfo(PROVIDER, model);
    // `languages` replaces `language`: never both.
    if (language && language !== "auto") form.append(info.language === "languages" ? "languages[]" : "language", language);
    if (info.vocabulary === "keywords") {
      for (const term of keywordTerms(vocabulary)) form.append("keywords[]", term);
    } else if (info.vocabulary === "prompt") {
      const prompt = vocabularyPrompt(vocabulary);
      if (prompt) form.append("prompt", prompt);
    }

    const res = await network.fetch(TRANSCRIPTIONS_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal });
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

// One answer from a chat model: `system` holds the instructions, `text` the material; with a `schema` (JSON Schema,
// strict: every property required, no others) the answer is JSON that follows it. Empty when the model gave no text;
// the caller decides what that means. It gets the least effort the model takes, as with Gemini, unless `effort` names
// another that it takes; GPT-6 takes a temperature only without reasoning, and GPT-6.2, which always reasons, none.
async function generateText({ model, system, text, temperature = 0.2, effort, schema, apiKey, signal }) {
  try {
    const info = modelInfo(PROVIDER, model);
    const levels = info.thinking?.levels;
    const reasoning = levels?.includes(effort) ? effort : levels?.[0];
    const body = JSON.stringify({
      model, messages: [{ role: "system", content: system }, { role: "user", content: text }],
      ...(info.temperature && (!reasoning || reasoning === "none") && { temperature }),
      ...(reasoning && { reasoning_effort: reasoning }),
      ...(schema && { response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } } })
    });
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

module.exports = { transcribe, generateText, MAX_UPLOAD_BYTES, MAX_RECORDING_BYTES: MAX_UPLOAD_BYTES, TRANSCRIPTIONS_URL };
