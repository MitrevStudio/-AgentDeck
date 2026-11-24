// What a meeting is on disk: its folder's name, the names of the files in it and meeting.json, the source of truth.
// All of it is checked the same way when it comes from a caller and when it is read back: the folder lies in a
// project, where anybody can have written it.
const { isObj, flat, pad } = require("../shared/util");
const { fail } = require("./errors");
const { HIDDEN } = require("./text");

const SCHEMA = 1;
const STATES = ["recording", "recorded", "processing", "transcribed", "ready", "failed"];
// The folder: local date and time, then the title. It never changes, also when the title does. No dot, slash, colon
// or space can be in it, and it starts with a year, so it cannot be a name Windows reserves.
const ID = /^\d{4}-\d{2}-\d{2}-\d{4}-[\p{L}\p{N}\p{M}-]{1,64}$/u;
const SLUG_MAX = 40; // characters: agents open these paths, and not every tool takes more than 260 in all
const TITLE_MAX = 200;
const BRIEF_MAX = 500;
const SCREEN = /^screens\/\d{2,4}-\d{2}-\d{2}-[mw]\d{1,2}(-\d{1,3})?\.png$/; // m: a monitor's, w: a window's
const AUDIO = { mic: "audio/mic.webm", system: "audio/system.webm" };
const DOCUMENTS = ["summary.md", "transcript.md"];

const clip = (text, max) => Array.from(text).slice(0, max).join("");
const line = (v, max) => (typeof v === "string" ? clip(flat(v.replace(HIDDEN, " ")), max) : undefined);
const amount = v => Number.isFinite(v) && v >= 0;
const orNull = check => v => (v === null ? null : check(v));

// A screenshot is a monitor's ({ monitor }) or a chosen window's ({ window, title }: its number among the chosen and
// what it was called when it was chosen).
const number = v => Number.isInteger(v) && v >= 1;
function checkScreen(s) {
  if (!isObj(s) || !SCREEN.test(s.file) || !amount(s.atMs)) return undefined;
  const { file, atMs } = s;
  if (s.window === undefined) return number(s.monitor) ? { file, atMs, monitor: s.monitor } : undefined;
  return number(s.window) && s.monitor === undefined ? { file, atMs, window: s.window, title: line(s.title ?? "", TITLE_MAX) ?? "" } : undefined;
}
function checkScreens(list) {
  if (!Array.isArray(list)) return undefined;
  const screens = list.map(checkScreen);
  return screens.includes(undefined) ? undefined : screens;
}
function checkAudio(v) {
  if (!isObj(v)) return undefined;
  const audio = { mic: v.mic ?? null, system: v.system ?? null };
  return Object.keys(AUDIO).every(k => audio[k] === null || audio[k] === AUDIO[k]) ? audio : undefined;
}
// Each field a caller may set: its value as it is kept, undefined when it is not valid.
const FIELDS = {
  title: v => line(v, TITLE_MAX),
  state: v => (STATES.includes(v) ? v : undefined),
  durationMs: orNull(v => (amount(v) ? v : undefined)),
  brief: v => line(v, BRIEF_MAX),
  audio: checkAudio,
  screens: checkScreens,
  transcription: orNull(v => (isObj(v) ? v : undefined)),
  summary: orNull(v => (isObj(v) ? v : undefined)),
  error: orNull(v => (isObj(v) && typeof v.code === "string" ? v : undefined))
};

function checkPatch(patch) {
  if (!isObj(patch)) fail("invalidData");
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    const kept = Object.hasOwn(FIELDS, key) ? FIELDS[key](value) : undefined;
    if (kept === undefined) fail("invalidData", key);
    out[key] = kept;
  }
  return out;
}

function newMeeting(input) {
  if (!isObj(input)) fail("invalidData");
  const { startedAt = Date.now(), ...fields } = input;
  const at = new Date(startedAt ?? NaN);
  if (!Number.isFinite(at.getTime()) || at.getFullYear() < 1000 || at.getFullYear() > 9999) fail("invalidData", "startedAt");
  return {
    schema: SCHEMA, title: "", startedAt: at.toISOString(), updatedAt: new Date().toISOString(),
    state: "recorded", durationMs: null, brief: "",
    audio: { mic: null, system: null }, screens: [],
    transcription: null, summary: null, error: null,
    ...checkPatch(fields)
  };
}
// meeting.json's text as a meeting; null for what is not one of this schema.
function parse(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isObj(data) || data.schema !== SCHEMA || typeof data.startedAt !== "string" || !Number.isFinite(Date.parse(data.startedAt))) return null;
  const out = { ...data };
  for (const [key, check] of Object.entries(FIELDS)) {
    out[key] = check(data[key]);
    if (out[key] === undefined) return null;
  }
  return out;
}

// n: the how-manyth folder of that name.
function folderName({ title, startedAt }, n = 1) {
  const d = new Date(startedAt);
  const slug = clip(title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+/, ""), SLUG_MAX).replace(/-+$/, "");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${slug || "meeting"}${n > 1 ? `-${n}` : ""}`;
}
const isId = v => typeof v === "string" && ID.test(v);
const isScreen = v => typeof v === "string" && SCREEN.test(v);
const isFileName = v => DOCUMENTS.includes(v) || Object.values(AUDIO).includes(v) || isScreen(v);

module.exports = { STATES, checkPatch, newMeeting, parse, folderName, isId, isScreen, isFileName };
