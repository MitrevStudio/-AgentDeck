// OpenAI speech-to-text (whisper-1, gpt-4o-transcribe, ...). Port of VoiceTray's OpenAITranscriptionProvider.
// Throws VoiceError only. Requests go through ../../network.js (Chromium's network stack and the proxy settings).
const fs = require("node:fs");
const path = require("node:path");
const network = require("../../network");
const { VoiceError, classify, fromResponse, tooLarge } = require("../errors");
const { t, formatNumber } = require("../../i18n");

const PROVIDER = "OpenAI";
const URL = "https://api.openai.com/v1/audio/transcriptions";

// "Files can be up to 25 MB." Decimal, not MiB: read as MiB we would send 26.2 MB and take a 413 at the boundary.
const MAX_UPLOAD_BYTES = 25_000_000;

async function transcribe({ wavPath, model, language, apiKey, signal }) {
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

module.exports = { transcribe, MAX_UPLOAD_BYTES };
