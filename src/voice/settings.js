// Voice settings: the `voice` key of the app's userData/settings.json. Port of VoiceTray's AppSettings and
// SettingsService. Other keys in that file (ui, edgeHandle) belong to main.js and are preserved on every write.
// API keys never touch the disk in plaintext: safeStorage (DPAPI) ciphertext, base64, in apiKeysEnc.
//
// The in-memory copy changes at once; the file follows asynchronously (atomic-file.js), and save()/setApiKey()
// resolve once it is on disk.
const fs = require("node:fs");
const { t } = require("../i18n");
const path = require("node:path");
const atomic = require("../shared/atomic-file");
const { isObj } = require("../shared/util");
const dictation = require("./dictation-options");
const commandOptions = require("./command-options");
const { PROVIDERS, TASKS, REVISION, LAST_DAY, providerName, currentModel } = require("./catalog");
const { DEFAULT_SHORTCUT } = require("../meetings/capture/shortcut");

const defaults = Object.freeze({
  // Each task's provider ("" = the dictation's) and its model on each provider, empty = the default (catalog.js).
  tasks: Object.freeze(Object.fromEntries(Object.entries(TASKS).map(([task, spec]) => [task, Object.freeze({
    provider: spec.provider, models: Object.freeze(Object.fromEntries(Object.keys(spec.models).map(p => [p, ""])))
  })]))),
  modelChanges: Object.freeze([]), // [{from, to}] replaced by migrate(), until the user has been told
  language: "auto",
  // Browser deviceId of the chosen microphone; the name is kept so a device whose id changed can be matched again.
  microphoneName: "",
  microphoneDeviceId: "",
  useClipboardPaste: true, // paste with Ctrl+V; false = type the text as Unicode keystrokes
  maxRecordingMinutes: 10, // safety net against a recording left running by accident
  readAloudVoice: "",
  readAloudSpeed: 1.0, // remembered from the last reading
  hotkeys: Object.freeze({ dictate: "Control+Space", readAloud: "Control+Shift+Space", editSelection: "Control+Alt+Space", ask: "Control+Shift+/", meetingScreenshot: DEFAULT_SHORTCUT }),
  importedFromVoiceTray: null,
  // dictationMode, promptLanguage, pushToTalk and the dictionary (dictation-options.js).
  ...dictation.DEFAULTS,
  // Voice commands (command-options.js).
  ...commandOptions.DEFAULTS
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

function normalizeTasks(value) {
  const out = {};
  for (const [task, spec] of Object.entries(TASKS)) {
    const own = isObj(value) && isObj(value[task]) ? value[task] : {};
    out[task] = {
      provider: Object.keys(spec.models).includes(own.provider) ? own.provider : spec.provider,
      models: Object.fromEntries(Object.keys(spec.models).map(p => [p, str(own.models?.[p], "").trim()]))
    };
  }
  return out;
}

// What the settings had before every task had a model of its own, and the models those versions used when none was
// saved. An older version may share the file (a run from source uses the installed app's profile), so these stay in it
// exactly as they are: read while there are no tasks, never after, never written.
const OLD_KEYS = ["provider", "models", "readAloudModel"];
const OLD_DEFAULTS = {
  dictation: { OpenAI: "whisper-1", Gemini: "gemini-2.5-flash" },
  rewrite: { OpenAI: "gpt-4.1-mini", Gemini: "gemini-3.1-flash-lite" }
};

// Without tasks the old keys become them; settings from before the catalog's revision move off the models that stop or
// are re-routed. Only then: such a model typed in afterwards stays until its day. The user is told (modelChanges) about
// what they use: a saved model of the provider in use or of one with a key, a default only of one with a key.
function migrate(v) {
  const tasks = normalizeTasks(v.tasks);
  const changes = (Array.isArray(v.modelChanges) ? v.modelChanges : [])
    .filter(c => typeof c?.from === "string" && typeof c?.to === "string").map(({ from, to }) => ({ from, to }));
  const tell = (from, to) => { if (!changes.some(c => c.from === from && c.to === to)) changes.push({ from, to }); };
  const hasKey = p => isObj(v.apiKeysEnc) && Boolean(v.apiKeysEnc[p]);
  const old = !isObj(v.tasks) && OLD_KEYS.some(k => Object.hasOwn(v, k));
  if (old) {
    const { dictation, readAloud } = tasks;
    dictation.provider = providerName(v.provider) || dictation.provider;
    for (const p of PROVIDERS) dictation.models[p] = str(v.models?.[p], "").trim() || dictation.models[p];
    readAloud.models.Gemini = str(v.readAloudModel, "").trim() || readAloud.models.Gemini;
    const p = dictation.provider;
    for (const [task, models] of Object.entries(OLD_DEFAULTS)) {
      if (hasKey(p) && !tasks[task].models[p]) tell(models[p], TASKS[task].models[p]);
    }
  }
  const outdated = old || !(v.modelsVersion >= REVISION);
  for (const [task, choice] of Object.entries(tasks)) {
    for (const [p, saved] of Object.entries(choice.models)) {
      const model = outdated ? currentModel(p, saved, LAST_DAY) : saved;
      if (model !== saved && (hasKey(p) || p === (choice.provider || tasks.dictation.provider))) tell(saved, model);
      // The default is not stored, so that it follows the catalog.
      choice.models[p] = model === TASKS[task].models[p] ? "" : model;
    }
  }
  return { tasks, modelChanges: changes, modelsVersion: Math.max(REVISION, Number(v.modelsVersion) || 0) };
}

function normalize(v) {
  v = isObj(v) ? v : {};
  const out = { ...clone(defaults), ...v, ...migrate(v) };
  out.hotkeys = { ...defaults.hotkeys, ...(isObj(v.hotkeys) ? v.hotkeys : {}) };
  out.language = str(v.language, "").trim() || defaults.language;
  for (const k of ["microphoneName", "microphoneDeviceId", "readAloudVoice"]) out[k] = str(v[k], defaults[k]);
  out.useClipboardPaste = typeof v.useClipboardPaste === "boolean" ? v.useClipboardPaste : defaults.useClipboardPaste;
  const minutes = Math.round(Number(v.maxRecordingMinutes));
  out.maxRecordingMinutes = Number.isFinite(minutes) ? Math.min(60, Math.max(1, minutes)) : defaults.maxRecordingMinutes;
  const speed = Number(v.readAloudSpeed);
  out.readAloudSpeed = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : defaults.readAloudSpeed;
  out.importedFromVoiceTray = str(v.importedFromVoiceTray, null);
  Object.assign(out, dictation.normalize(v), commandOptions.normalize(v));
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

// What is the file's alone: the ciphertext and the old keys. Neither handed out by load() nor taken by save().
function withoutPrivate(value) {
  const out = { ...value };
  for (const k of ["apiKeysEnc", ...OLD_KEYS]) delete out[k];
  return out;
}

// A copy without those: callers (and the settings page) never need them.
const load = () => withoutPrivate(clone(stored()));

// Whether settings.json already has a voice section (the VoiceTray import must not overwrite one).
const hasVoiceSection = async () => isObj(parseRoot(await atomic.readText(file())).voice);

// A task in a patch changes only what it names: its provider, or the models of some providers. A provider the task
// cannot have is refused, not turned into the default (normalizeTasks does that only to what the file holds).
function mergeTasks(current, patch) {
  const out = { ...current };
  for (const [task, p] of Object.entries(isObj(patch) ? patch : {})) {
    if (!isObj(p) || !Object.hasOwn(TASKS, task)) continue;
    const spec = TASKS[task];
    if (Object.hasOwn(p, "provider") && p.provider !== spec.provider && !Object.keys(spec.models).includes(p.provider)) {
      throw new Error(`Unknown provider for ${task}: ${p.provider}`);
    }
    out[task] = { ...out[task], ...p, models: { ...out[task].models, ...(isObj(p.models) ? p.models : {}) } };
  }
  return out;
}

// Shallow patch; `tasks` and `hotkeys` merge deeper so a partial object does not wipe the other entries.
async function save(patch = {}) {
  const cur = stored();
  const p = withoutPrivate(isObj(patch) ? patch : {});
  await persist(normalize({
    ...cur, ...p,
    tasks: mergeTasks(cur.tasks, p.tasks),
    hotkeys: { ...cur.hotkeys, ...(isObj(p.hotkeys) ? p.hotkeys : {}) },
    apiKeysEnc: cur.apiKeysEnc
  }));
  return load();
}

async function getApiKey(provider) {
  const enc = stored().apiKeysEnc[provider];
  if (!enc) return "";
  try {
    const { result, shouldReEncrypt } = await safeStorage().decryptStringAsync(Buffer.from(enc, "base64"));
    if (shouldReEncrypt) setApiKey(provider, result, enc).catch(() => {}); // the key store has rotated its key
    return result;
  } catch { return ""; }
}

// Empty key = remove. Rejects when encryption is unavailable rather than falling back to plaintext. With
// `replacing`, only if that ciphertext is still the saved one.
async function setApiKey(provider, key, replacing) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider: ${provider}`);
  key = String(key || "").trim();
  let enc = null;
  if (key) {
    const ss = safeStorage();
    if (!(await ss.isAsyncEncryptionAvailable())) throw new Error(t("voice.errors.encryptionUnavailable"));
    enc = (await ss.encryptStringAsync(key)).toString("base64");
  }
  // Read after encrypting: a save() meanwhile must not be written back over.
  const cur = stored();
  if (replacing && cur.apiKeysEnc[provider] !== replacing) return;
  const apiKeysEnc = { ...cur.apiKeysEnc };
  if (enc) apiKeysEnc[provider] = enc;
  else delete apiKeysEnc[provider];
  await persist({ ...cur, apiKeysEnc });
}

const hasApiKey = provider => Boolean(stored().apiKeysEnc[provider]);

module.exports = {
  init, ready, load, save, getApiKey, setApiKey, hasApiKey, hasVoiceSection, readRoot, writeRoot, file, defaults, PROVIDERS
};
