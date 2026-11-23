// A meeting's part through OpenAI's transcriptions: text and the languages heard, no times - a part's time is as
// exact as the part is short. The same shape as gemini.js; nothing stays uploaded there.
const network = require("../../network");
const { fromResponse, tooLarge } = require("../../voice/errors");
const { TRANSCRIPTIONS_URL, MAX_UPLOAD_BYTES } = require("../../voice/providers/openai");
const { modelInfo } = require("../../voice/catalog");
const { t, formatNumber } = require("../../i18n");

const PROVIDER = "OpenAI";

async function ask({ wav, model, languages, apiKey, call, keep }) {
  if (wav.length > MAX_UPLOAD_BYTES) throw tooLarge(t("voice.errors.tooLarge.openai", { mb: formatNumber(Math.floor(wav.length / 1_000_000)) }));
  const several = modelInfo(PROVIDER, model).language === "languages";
  const text = await call(async signal => {
    const body = new FormData();
    body.append("file", new Blob([wav], { type: "audio/wav" }), "part.wav");
    body.append("model", model);
    // `languages` replaces `language`, which can name only one: a mixed meeting is then left to be detected.
    if (several) for (const code of languages) body.append("languages[]", code);
    else if (languages.length === 1) body.append("language", languages[0]);
    const res = await network.fetch(TRANSCRIPTIONS_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body, signal });
    const reply = await res.text();
    if (!res.ok) throw fromResponse(res, reply, PROVIDER);
    return reply;
  });
  await keep(text);
  return text;
}

function read(body) {
  let root;
  try { root = JSON.parse(body); } catch { return { readable: false, spans: [] }; }
  if (typeof root?.text !== "string") return { readable: false, spans: [] };
  return {
    readable: true, truncated: false,
    languages: Array.isArray(root.languages) ? root.languages.map(l => l?.code).filter(code => typeof code === "string") : [],
    spans: root.text.trim() ? [{ start: null, end: null, text: root.text }] : []
  };
}

module.exports = { text: { ask, read } };
