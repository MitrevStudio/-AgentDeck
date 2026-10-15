// The user's own words. Terms (names, project names, technical words) steer recognition and the rewrite; replacements
// fix what still comes out wrong ("сигноз" -> "SigNoz"), in one pass over the transcript, so a rule never rewrites
// what another rule wrote.

const { flat, fold } = require("./util");

// Gemini's transcription model takes up to 1,000 terms and does best with up to 100.
const MAX_VOCABULARY = 100;
// Letters and digits of any script: JavaScript's \b only knows ASCII, and the transcripts are mostly Cyrillic.
const WORD = "[\\p{L}\\p{N}_]";

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The terms a transcription and a rewrite are told about: the user's own first, then the project names (when they
// are wanted). Unique ignoring case, at most MAX_VOCABULARY.
function vocabulary(dict, projectNames = []) {
  const seen = new Set(), out = [];
  const add = s => {
    const term = flat(s);
    // A name without a single letter ("2024", "__") would only be noise.
    if (!term || !/\p{L}/u.test(term) || seen.has(fold(term))) return;
    seen.add(fold(term));
    out.push(term);
  };
  for (const term of dict?.terms || []) add(term);
  if (dict?.projectNames) for (const name of projectNames || []) add(name);
  return out.slice(0, MAX_VOCABULARY);
}

// One regular expression for all rules, longest spoken form first, whole words only; spaces inside a spoken form
// match any run of whitespace.
function compile(replacements) {
  const rules = (Array.isArray(replacements) ? replacements : [])
    .map(r => ({ from: flat(r?.from), to: flat(r?.to) }))
    .filter(r => r.from && r.to)
    .sort((a, b) => b.from.length - a.from.length);
  if (!rules.length) return null;
  const written = new Map();
  for (const r of rules) if (!written.has(fold(r.from))) written.set(fold(r.from), r.to);
  const alternatives = rules.map(r => r.from.split(" ").map(escape).join("\\s+")).join("|");
  return { re: new RegExp(`(?<!${WORD})(?:${alternatives})(?!${WORD})`, "giu"), written };
}

// The written form is kept exactly as typed ("SigNoz", "koffi"); only an all-lower-case one takes the capital the
// transcript gave the spoken word, which is how a sentence that starts with it stays capitalised.
function matchCase(spoken, written) {
  if (written !== written.toLocaleLowerCase()) return written;
  const first = spoken.charAt(0);
  return first !== first.toLocaleLowerCase() ? written.charAt(0).toLocaleUpperCase() + written.slice(1) : written;
}

function applyReplacements(text, replacements) {
  const s = String(text ?? "");
  const c = s && compile(replacements);
  if (!c) return s;
  return s.replace(c.re, m => {
    const to = c.written.get(fold(m));
    return to === undefined ? m : matchCase(m, to);
  });
}

module.exports = { vocabulary, applyReplacements, MAX_VOCABULARY };
