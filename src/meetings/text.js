// Text that comes from speech and models, and the times beside it, as the meetings' documents hold them. None of it is
// trusted: it stays one line, shows what it holds and cannot become a link, an image, HTML or a heading.
const { flat, pad } = require("../shared/util");

// Control characters, bidi overrides and what is invisible but read by a model (zero width, Unicode tags).
const HIDDEN = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
const INVISIBLE = /[\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/gu;
const clean = value => (typeof value === "string" ? flat(value.replace(INVISIBLE, "").replace(HIDDEN, " ")) : "");
const clip = (text, max) => Array.from(text).slice(0, max).join("");

// Inside a line of Markdown. unescapeText() takes it back out of a transcript.
const escapeText = text => clean(text).replace(/[\\`*[\]<>|~]|&(?=#|\w+;)/g, "\\$&");
const unescapeText = text => text.replace(/\\([\\`*[\]<>|~&])/g, "$1");
// Where the text opens a line of its own.
const escapeLine = text => escapeText(text).replace(/^[#+=_-]/, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2");

// "00:14:32", as the documents and the models write it; "1:12:40" for a length.
function clock(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
const length = ms => clock(ms).replace(/^0/, "");
function readClock(value) {
  const m = /^\[?(\d{1,3}):([0-5]\d):([0-5]\d)\]?$/.exec(clean(value));
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
}

// What is compared: the words without case and punctuation. In Chinese and Japanese each character is one.
const WORD = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{N}\p{M}])+/gu;
const words = text => String(text).normalize("NFKC").toLowerCase().match(WORD) || [];

module.exports = { clean, clip, escapeText, unescapeText, escapeLine, clock, length, readClock, words };
