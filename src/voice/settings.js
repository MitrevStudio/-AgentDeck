// Voice settings: the `voice` key of the app's userData/settings.json. Port of VoiceTray's AppSettings and
// SettingsService. Other keys in that file (hoverEdge, ...) belong to main.js and are preserved on every write.
// API keys never touch the disk in plaintext: safeStorage (DPAPI) ciphertext, base64, in apiKeysEnc.
//
// The in-memory copy changes at once; the file follows asynchronously (atomic-file.js), and save()/setApiKey()
// resolve once it is on disk.
const fs = require("node:fs");
const { t } = require("../i18n");
const path = require("node:path");
const atomic = require("./atomic-file");
const { isObj } = require("./util");

const PROVIDERS = ["OpenAI", "Gemini"];

const defaults = Object.freeze({
  provider: "OpenAI",
  models: Object.freeze({ OpenAI: "", Gemini: "" }), // empty = the provider's default model
  language: "auto",
  // Browser deviceId of the chosen microphone; the name is kept so a device whose id changed can be matched again.
  microphoneName: "",
  microphoneDeviceId: "",
  useClipboardPaste: true, // paste with Ctrl+V; false = type the text as Unicode keystrokes
  maxRecordingMinutes: 10, // safety net against a recording left running by accident
  readAloudModel: "", // empty = default
  readAloudVoice: "",
  readAloudSpeed: 1.0, // remembered from the last reading
  hotkeys: Object.freeze({ dictate: "Control+Space", readAloud: "Control+Shift+Space" }),
  importedFromVoiceTray: null
});

let userDataDir = null;
let safe = null;
let cache = null;

function init(opts = {}) {
  userDataDir = opts.userDataDir || null;
  safe = opts.safeStorage || null;
  cache = null;
}

const baseDir = () => userDataDir || require("electron").app.getPath("userData");
const file = () => path.join(baseDir(), "settings.json");
const safeStorage = () => safe || require("electron").safeStorage;
const clone = v => JSON.parse(JSON.stringify(v));
const str = (v, d) => (typeof v === "string" ? v : d);

// null (no file yet) -> {}. Unparsable -> {} too, after keeping a copy: it may be the only place the API keys still
// exist, and the next write replaces it.
function parseRoot(text) {
  if (text == null) return {};
  try {
    const root = JSON.parse(text);
    if (isObj(root)) return root;
  } catch {}
  try { fs.copyFileSync(file(), file() + ".corrupt"); } catch {}
  return {};
}

// Any read error other than "no file yet" is thrown: answering {} for a file that is only locked for a moment
// (antivirus, OneDrive) would make the next write replace it - API keys included.
function readRoot() {
  let text = null;
  try { text = fs.readFileSync(file(), "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return parseRoot(text);
}

// Read-modify-write of top-level keys, for every writer of settings.json (main.js uses it too, so neither side can
// write back a stale copy of the other's keys).
const writeRoot = patch => atomic.update(file(), text => JSON.stringify({ ...parseRoot(text), ...patch }, null, 2));

function normalize(v) {
  v = isObj(v) ? v : {};
  const out = { ...clone(defaults), ...v };
  out.provider = PROVIDERS.includes(v.provider) ? v.provider : defaults.provider;
  out.models = { ...defaults.models, ...(isObj(v.models) ? v.models : {}) };
  out.hotkeys = { ...defaults.hotkeys, ...(isObj(v.hotkeys) ? v.hotkeys : {}) };
  out.language = str(v.language, "").trim() || defaults.language;
  for (const k of ["microphoneName", "microphoneDeviceId", "readAloudModel", "readAloudVoice"]) out[k] = str(v[k], defaults[k]);
  out.useClipboardPaste = typeof v.useClipboardPaste === "boolean" ? v.useClipboardPaste : defaults.useClipboardPaste;
  const minutes = Math.round(Number(v.maxRecordingMinutes));
  out.maxRecordingMinutes = Number.isFinite(minutes) ? Math.min(60, Math.max(1, minutes)) : defaults.maxRecordingMinutes;
  const speed = Number(v.readAloudSpeed);
  out.readAloudSpeed = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : defaults.readAloudSpeed;
  out.importedFromVoiceTray = str(v.importedFromVoiceTray, null);
  out.apiKeysEnc = isObj(v.apiKeysEnc) ? { ...v.apiKeysEnc } : {};
  return out;
}

function stored() {
  if (!cache) cache = normalize(readRoot().voice);
  return cache;
}

// Loads the file without blocking, waiting out a short lock; for startup, before the first load().
async function ready() {
  if (!cache) cache = normalize(parseRoot(await atomic.readText(file())).voice);
}

function persist(next) {
  cache = next;
  return writeRoot({ voice: next });
}

// A copy without the ciphertext: callers (and the settings page) never need it.
function load() {
  const { apiKeysEnc, ...rest } = clone(stored());
  return rest;
}

// Whether settings.json already has a voice section (the VoiceTray import must not overwrite one).
const hasVoiceSection = async () => isObj(parseRoot(await atomic.readText(file())).voice);

// Shallow patch; `models` and `hotkeys` merge one level deep so a partial object does not wipe the other entries.
async function save(patch = {}) {
  const cur = stored();
  const { apiKeysEnc, ...p } = isObj(patch) ? patch : {};
  await persist(normalize({
    ...cur, ...p,
    models: { ...cur.models, ...(isObj(p.models) ? p.models : {}) },
    hotkeys: { ...cur.hotkeys, ...(isObj(p.hotkeys) ? p.hotkeys : {}) },
    apiKeysEnc: cur.apiKeysEnc
  }));
  return load();
}

function getApiKey(provider) {
  const enc = stored().apiKeysEnc[provider];
  if (!enc) return "";
  try { return safeStorage().decryptString(Buffer.from(enc, "base64")); } catch { return ""; }
}

// Empty key = remove. Rejects when encryption is unavailable rather than falling back to plaintext.
async function setApiKey(provider, key) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  const cur = stored();
  const apiKeysEnc = { ...cur.apiKeysEnc };
  key = String(key || "").trim();
  if (key) {
    const ss = safeStorage();
    if (!ss.isEncryptionAvailable()) throw new Error(t("voice.errors.encryptionUnavailable"));
    apiKeysEnc[provider] = ss.encryptString(key).toString("base64");
  } else delete apiKeysEnc[provider];
  await persist({ ...cur, apiKeysEnc });
}

const hasApiKey = provider => Boolean(stored().apiKeysEnc[provider]);

module.exports = {
  init, ready, load, save, getApiKey, setApiKey, hasApiKey, hasVoiceSection, readRoot, writeRoot, file, defaults, PROVIDERS
};
