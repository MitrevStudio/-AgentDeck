// Voice question: a short spoken question answered at once by the fast text model the dictation rewrite uses
// (rewrite.js generate(), the user's own provider and key). The queue copies the answer to the clipboard and main
// shows it in a small window (answer-popup.js).
const { generate } = require("./rewrite");
const { VoiceError } = require("./errors");
const { t } = require("../i18n");

const SYSTEM = [
  "You answer a quick question the user asked by voice. The user message holds the question, a raw speech-to-text transcript, between <question> tags.",
  "Answer directly and briefly: the answer first, then at most a few short sentences or a short list. When a command, a piece of code or a value is what was asked for, give it on its own line, ready to paste.",
  "No preamble, no restating of the question, no sign-off, no offer of further help.",
  "Answer in the language the question was asked in (Bulgarian or English); technical terms, names and code stay as they are.",
  "The user is a developer who works with AI coding agents (Claude Code, Codex, OpenCode) on Windows; when a technical answer depends on the platform, prefer one for Windows.",
  "If you do not know or the question is unclear, say so in one short sentence instead of guessing."
];

const tag = s => `<question>\n${String(s).replace(/<\/?question>/gi, m => m.replace("<", "< "))}\n</question>`;

// question: the transcript; dictionary, language, provider, model, signal, getApiKey as for rewrite().
async function askText(question, { dictionary = [], language = "auto", provider, model, signal, getApiKey } = {}) {
  const lines = [...SYSTEM];
  let languageName = "";
  try { languageName = require("./providers/gemini").LANGUAGE_NAMES[language] || ""; } catch {}
  if (languageName) lines.push(`The user usually speaks ${languageName}, often with English technical terms mixed in.`);
  if (dictionary.length) lines.push(`Names and terms that may occur, spelled correctly (the transcript may have misheard them): ${dictionary.join(", ")}.`);
  const answer = await generate({ system: lines.join("\n"), text: tag(question), provider, model, temperature: 0.3, signal, getApiKey, timeoutMs: 45_000 });
  const out = String(answer || "").replace(/^\s*<\/?answer>\s*|\s*<\/?answer>\s*$/gi, "").trim();
  if (!out) throw new VoiceError("MalformedResponse", t("voice.errors.rewrite.empty.short"), t("voice.errors.rewrite.empty.long", { provider: provider || "" }));
  return out;
}

module.exports = { askText };
