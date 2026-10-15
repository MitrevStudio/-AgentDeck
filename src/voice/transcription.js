// Runs one transcription attempt for a recorded job. Port of VoiceTray's TranscriptionService.
//
// The job keeps the provider/model/language it was recorded under, so a retry hours later does not silently switch
// provider. The API key is deliberately not part of that snapshot: `getApiKey(provider)` is called at every attempt,
// so retrying after a 401 picks up the key the user just corrected.
const fs = require("node:fs");
const { classify, configuration } = require("./errors");
const { wavDurationMs, BYTES_PER_SECOND, HEADER_BYTES } = require("./wav");
const { defaultModelFor } = require("./catalog");
const { t } = require("../i18n");

const PROVIDERS = { OpenAI: require("./providers/openai"), Gemini: require("./providers/gemini") };

const BASE_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const providerName = p => Object.keys(PROVIDERS).find(k => k.toLowerCase() === String(p || "").toLowerCase());
const isGemini = p => providerName(p) === "Gemini";

const providerByteCap = provider =>
  isGemini(provider) ? PROVIDERS.Gemini.MAX_INLINE_BYTES : PROVIDERS.OpenAI.MAX_UPLOAD_BYTES;

// Whole minutes that fit inside the provider's limit, with a second of slack: recording stops on a chunk
// boundary and the WAV carries a header, so landing exactly on the limit would still be rejected.
const maxRecordingMinutesFor = provider =>
  Math.max(1, Math.floor((providerByteCap(provider) - HEADER_BYTES - BYTES_PER_SECOND) / BYTES_PER_SECOND / 60));

// PCM bytes (header excluded) the recorder may write: the lower of the user's limit and what the provider accepts,
// so a recording can never grow past what will be accepted.
function maxRecordingBytes(settings = {}) {
  const user = Math.min(60, Math.max(1, Math.floor(Number(settings.maxRecordingMinutes) || 10)));
  return Math.min(user, maxRecordingMinutesFor(settings.provider)) * 60 * BYTES_PER_SECOND;
}

// A fixed budget drops long recordings on ordinary uplinks: a 10 minute WAV is 19 MB, and a third more once
// Gemini base64-encodes it inline.
function attemptTimeoutMs(wavPath) {
  let ms = wavDurationMs(wavPath);
  if (!ms) try { ms = Math.max(0, fs.statSync(wavPath).size - HEADER_BYTES) / BYTES_PER_SECOND * 1000; } catch {}
  return Math.min(BASE_TIMEOUT_MS + 2 * ms, MAX_TIMEOUT_MS);
}

async function transcribeFile({ wavPath, provider, model, language, getApiKey, signal }) {
  const name = providerName(provider);
  if (!name) throw configuration(t("voice.errors.unknownProvider", { provider }));
  const apiKey = String((await getApiKey(name)) || "").trim();
  if (!apiKey) throw configuration(t("voice.errors.noApiKey", { provider: name }));
  if (!model || !String(model).trim()) model = defaultModelFor(name);

  const timeout = AbortSignal.timeout(attemptTimeoutMs(wavPath));
  const attempt = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const text = await PROVIDERS[name].transcribe({ wavPath, model, language: language || "auto", apiKey, signal: attempt });
    return String(text || "").trim();
  } catch (error) {
    throw classify({ error, provider: name, signal });
  }
}

// `job` uses VoiceTray's record shape (AudioPath, Provider, Model, Language) and carries everything an attempt needs;
// `_settings` only keeps the spec'd signature. `getApiKey` defaults to the stored (encrypted) keys.
const transcribeJob = (job, _settings, { getApiKey = p => require("./settings").getApiKey(p), signal, wavPath } = {}) =>
  transcribeFile({ wavPath: wavPath || job.AudioPath, provider: job.Provider, model: job.Model, language: job.Language, getApiKey, signal });

module.exports = { transcribeJob, transcribeFile, providerByteCap, maxRecordingMinutesFor, maxRecordingBytes };
