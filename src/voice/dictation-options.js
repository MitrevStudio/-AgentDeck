// The dictation options on top of VoiceTray's settings: the default mode, the language of a prompt, how the dictation
// key behaves, and the dictionary. normalize() repairs whatever settings.json holds; validate() checks what the
// Settings page sends (it is not trusted to have offered only valid choices).
const { isObj, flat, fold } = require("./util");
const { t } = require("../i18n");

const MODES = Object.freeze(["verbatim", "clean", "prompt"]);
const PROMPT_LANGUAGES = Object.freeze(["spoken", "en"]); // "spoken": the prompt stays in the language it was dictated in
const TALK_MODES = Object.freeze(["hybrid", "toggle", "hold"]);
const LIMITS = Object.freeze({ terms: 300, termChars: 80, replacements: 200, replacementChars: 200 });

const DEFAULTS = Object.freeze({
  dictationMode: "verbatim",
  promptLanguage: "spoken",
  pushToTalk: "hybrid",
  // projectNames: AgentDeck's project names count as terms too.
  dictionary: Object.freeze({ terms: Object.freeze([]), replacements: Object.freeze([]), projectNames: true })
});

const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);

// Unique (ignoring case), trimmed, within the limits; the first spelling wins.
function cleanTerms(list) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const term = flat(raw);
    if (!term || term.length > LIMITS.termChars || seen.has(fold(term))) continue;
    seen.add(fold(term));
    out.push(term);
    if (out.length >= LIMITS.terms) break;
  }
  return out;
}

// {from, to} pairs with both sides filled; one rule per spoken form.
function cleanReplacements(list) {
  const seen = new Set(), out = [];
  for (const r of Array.isArray(list) ? list : []) {
    const from = flat(r?.from), to = flat(r?.to);
    if (!from || !to || from.length > LIMITS.replacementChars || to.length > LIMITS.replacementChars || seen.has(fold(from))) continue;
    seen.add(fold(from));
    out.push({ from, to });
    if (out.length >= LIMITS.replacements) break;
  }
  return out;
}

function normalizeDictionary(d) {
  d = isObj(d) ? d : {};
  return {
    terms: cleanTerms(d.terms),
    replacements: cleanReplacements(d.replacements),
    projectNames: typeof d.projectNames === "boolean" ? d.projectNames : DEFAULTS.dictionary.projectNames
  };
}

function normalize(v) {
  v = isObj(v) ? v : {};
  return {
    dictationMode: oneOf(MODES, v.dictationMode, DEFAULTS.dictationMode),
    promptLanguage: oneOf(PROMPT_LANGUAGES, v.promptLanguage, DEFAULTS.promptLanguage),
    pushToTalk: oneOf(TALK_MODES, v.pushToTalk, DEFAULTS.pushToTalk),
    dictionary: normalizeDictionary(v.dictionary)
  };
}

// The Settings page's payload -> {patch, errors}. Error keys match the page's error slots.
function validate(p) {
  const patch = {}, errors = {};
  if (!isObj(p)) return { patch, errors };
  if (!MODES.includes(p.dictationMode)) errors.dictationMode = t("voice.settings.err.value");
  else patch.dictationMode = p.dictationMode;
  if (!PROMPT_LANGUAGES.includes(p.promptLanguage)) errors.promptLanguage = t("voice.settings.err.value");
  else patch.promptLanguage = p.promptLanguage;
  if (!TALK_MODES.includes(p.pushToTalk)) errors.pushToTalk = t("voice.settings.err.value");
  else patch.pushToTalk = p.pushToTalk;

  const d = p.dictionary;
  if (!isObj(d) || !Array.isArray(d.terms) || !Array.isArray(d.replacements) || typeof d.projectNames !== "boolean") {
    errors["dictionary.terms"] = t("voice.settings.err.value");
    return { patch, errors };
  }
  const long = (s, max) => typeof s !== "string" || flat(s).length > max;
  if (d.terms.length > LIMITS.terms || d.terms.some(s => long(s, LIMITS.termChars))) {
    errors["dictionary.terms"] = t("voice.settings.dict.err.terms", { n: LIMITS.terms, chars: LIMITS.termChars });
  }
  if (d.replacements.length > LIMITS.replacements || d.replacements.some(r => !isObj(r) || long(r.from, LIMITS.replacementChars) || long(r.to, LIMITS.replacementChars))) {
    errors["dictionary.replacements"] = t("voice.settings.dict.err.replacements", { n: LIMITS.replacements, chars: LIMITS.replacementChars });
  } else if (d.replacements.some(r => !flat(r.from) !== !flat(r.to))) {
    errors["dictionary.replacements"] = t("voice.settings.dict.err.half");
  }
  if (!errors["dictionary.terms"] && !errors["dictionary.replacements"]) patch.dictionary = normalizeDictionary(d);
  return { patch, errors };
}

module.exports = { MODES, PROMPT_LANGUAGES, TALK_MODES, LIMITS, DEFAULTS, normalize, normalizeDictionary, validate };
