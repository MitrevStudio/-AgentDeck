// The voice History and Settings windows: ports of VoiceTray's HistoryWindow and SettingsWindow. Each page has its
// own small preload; the IPC handlers are registered once and answer only the window they belong to. Secrets never
// travel to a renderer: the Settings page learns only whether a key is saved, and sends a new key on save.
const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { maxRecordingMinutesFor } = require("./transcription");
const { TRANSCRIPTION_MODELS, SPEECH_MODELS, VOICES, VOICE_STYLES, DEFAULT_SPEECH_MODEL, DEFAULT_VOICE, defaultModelFor } = require("./catalog");
const { SAFE_ID, isObj, sleep } = require("./util");
const { t } = require("../i18n");

const UI = path.join(__dirname, "ui");
const MODEL_RE = /^[A-Za-z0-9][\w.:\/-]{0,99}$/;

// Dictation languages, each named in its own language (as the UI language switch does) so it can be found whatever
// the UI language; auto-detect is the one label that is translated.
const LANGUAGES = [["auto", null], ["bg", "Български"], ["en", "English"], ["es", "Español"],
  ["fr", "Français"], ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"], ["ru", "Русский"], ["ja", "日本語"],
  ["zh", "中文"], ["tr", "Türkçe"]];
const languageChoices = () => LANGUAGES.map(([code, name]) => [code, name ?? t("voice.catalog.language.auto")]);
const LENGTH_PRESETS = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
const voiceStyle = name => (VOICE_STYLES[name] ? t(`voice.catalog.style.${VOICE_STYLES[name]}`) : "");

// ---------- hotkeys ----------
const MOD_NAMES = { control: "Control", ctrl: "Control", commandorcontrol: "Control", cmdorctrl: "Control",
  alt: "Alt", option: "Alt", shift: "Shift", super: "Super", meta: "Super", win: "Super" };
const MOD_ORDER = ["Control", "Alt", "Shift", "Super"];
const NAMED_KEYS = ["Space", "Tab", "Enter", "Backspace", "Delete", "Insert", "Home", "End", "PageUp", "PageDown",
  "Up", "Down", "Left", "Right", "Escape", "PrintScreen", "Plus", "num0", "num1", "num2", "num3", "num4", "num5",
  "num6", "num7", "num8", "num9", "numdec", "numadd", "numsub", "nummult", "numdiv"];
const KEY_ALIASES = { return: "Enter", esc: "Escape", del: "Delete", ins: "Insert", pgup: "PageUp", pgdn: "PageDown",
  pageup: "PageUp", pagedown: "PageDown", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right" };
const PUNCT = "`-=[]\\;',./";

function canonicalKey(k) {
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if (k.length === 1 && PUNCT.includes(k)) return k;
  const low = k.toLowerCase();
  return KEY_ALIASES[low] || NAMED_KEYS.find(n => n.toLowerCase() === low) || "";
}

// An Electron accelerator string in canonical form ("Control+Shift+Space"), or an error in the UI language. Escape is
// taken (it cancels a recording), and a bare key would swallow ordinary typing, so a modifier is required except
// on F1-F24. Shift alone does not count: Shift+letter is how capitals are typed.
function normalizeAccelerator(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const fail = (key, vars) => ({ error: t(`voice.settings.hotkey.err.${key}`, vars) });
  if (!raw) return fail("empty");
  if (raw.length > 60) return fail("tooLong");
  const parts = raw.replace(/\+\+$/, "+Plus").split("+").map(s => s.trim());
  if (parts.some(p => !p)) return fail("format");
  const mods = new Set();
  let key = "";
  for (const [i, p] of parts.entries()) {
    const mod = MOD_NAMES[p.toLowerCase()];
    if (mod) {
      if (mods.has(mod) || key) return fail("modifiers");
      mods.add(mod);
      continue;
    }
    if (key || i !== parts.length - 1) return fail("oneKey");
    key = canonicalKey(p);
    if (!key) return fail("unknownKey", { key: p });
  }
  if (!key) return fail("noKey");
  if (key === "Escape") return fail("escape");
  if (!/^F\d+$/.test(key) && !mods.has("Control") && !mods.has("Alt") && !mods.has("Super")) return fail("needModifier");
  return { value: [...MOD_ORDER.filter(m => mods.has(m)), key].join("+") };
}

// ---------- windows ----------
// copyText(text) -> bool puts text on the clipboard; onHotkeyCapture(on) is told while the Settings page records a
// new combination (the current ones must not fire meanwhile). The Settings window is the app's: its General section
// goes to general.set(patch) / general.hotkey(); background() is the window colour of the current theme.
function createVoiceWindows({ settings, store, queue, listDevices, onReread, onSettingsChanged, onHotkeyCapture, copyText, icon,
  general, background = () => "#0d1015" } = {}) {
  if (!settings || !store || !queue) throw new Error("createVoiceWindows: settings, store and queue are required");
  let historyWin = null, settingsWin = null, changedTimer = null;
  const alive = w => Boolean(w && !w.isDestroyed());

  function makeWindow({ page, preload, ...opts }) {
    const win = new BrowserWindow({
      ...opts, show: false, backgroundColor: background(), icon: icon || undefined,
      webPreferences: { preload: path.join(UI, preload), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    win.removeMenu(); // Alt would otherwise pop up the default menu - in the middle of capturing a hotkey, too
    win.webContents.on("will-navigate", e => e.preventDefault()); // e.g. a file dropped onto the window
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.loadFile(path.join(UI, page));
    return win;
  }

  function focus(win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  // Only the window the channel belongs to may call it.
  function handle(channel, owner, fn) {
    ipcMain.handle(channel, (e, ...args) => {
      const win = owner();
      if (!alive(win) || e.sender !== win.webContents) throw new Error(t("errors.accessDenied"));
      return fn(...args);
    });
  }

  // ---------- History ----------
  function openHistory() {
    if (alive(historyWin)) return focus(historyWin);
    historyWin = makeWindow({
      page: "history.html", preload: "history-preload.js", title: t("voice.history.windowTitle"),
      width: 1040, height: 700, minWidth: 760, minHeight: 500, center: true
    });
    historyWin.once("ready-to-show", () => alive(historyWin) && historyWin.show());
    // Retention trims audio without an event; a glance back at the window should never show a dead Play button.
    historyWin.on("focus", historyChanged);
    historyWin.on("closed", () => { historyWin = null; });
    return historyWin;
  }

  function historyChanged() {
    clearTimeout(changedTimer);
    // Coalesced: a dictation emits several events in a few milliseconds.
    changedTimer = setTimeout(() => { if (alive(historyWin)) historyWin.webContents.send("voice:history:changed"); }, 60);
  }
  queue.on("job", historyChanged);

  const row = j => ({
    Id: j.Id, Kind: j.Kind, CreatedAt: j.CreatedAt, CompletedAt: j.CompletedAt, DurationSeconds: j.DurationSeconds,
    Provider: j.Provider, Model: j.Model, Language: j.Language, Voice: j.Voice, Status: j.Status,
    AttemptCount: j.AttemptCount, LastError: j.LastError, LastErrorShort: j.LastErrorShort,
    LastStatusCode: j.LastStatusCode, ResultText: j.ResultText, HasAudio: j.HasAudio, HasText: j.HasText,
    // Always the record's own file beside its sidecar, never the stored AudioPath.
    audioUrl: j.HasAudio ? pathToFileURL(store.wavPath(j.Id)).href : ""
  });
  const findJob = id => (typeof id === "string" && SAFE_ID.test(id) ? store.get(id) : null);
  const historyOwner = () => historyWin;

  handle("voice:history:list", historyOwner, query => {
    const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
    return { total: store.count(), items: store.list({ query: q }).map(row) };
  });

  handle("voice:history:copy", historyOwner, async id => {
    const text = findJob(id)?.ResultText;
    return Boolean(text && copyText && (await copyText(text)));
  });

  // One button, two meanings: a dictation is transcribed again from its audio under the current settings, a
  // reading is spoken again from its text (which outlives the audio).
  handle("voice:history:redo", historyOwner, async id => {
    const job = findJob(id);
    if (!job) return { ok: false, reason: "missing" };
    if (job.Kind === "ReadAloud") {
      if (!job.ResultText) return { ok: false, reason: "no-text" };
      if (typeof onReread !== "function") return { ok: false, reason: "unavailable" };
      try { await onReread(job.ResultText); } catch (e) { return { ok: false, reason: "error", message: String(e?.message || e) }; }
      return { ok: true, reread: true };
    }
    return queue.retranscribe(id) ? { ok: true } : { ok: false, reason: "no-audio" };
  });

  handle("voice:history:delete", historyOwner, id => Boolean(findJob(id)) && queue.discard(id));
  handle("voice:history:clear", historyOwner, () => queue.clearHistory());

  // ---------- Settings ----------
  function openSettings() {
    if (alive(settingsWin)) return focus(settingsWin);
    settingsWin = makeWindow({
      page: "settings.html", preload: "settings-preload.js", title: t("settings.title"),
      width: 620, height: 760, useContentSize: true, resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, center: true
    });
    // Sized to its content (VoiceTray: SizeToContent) once the page reports its height; shown regardless if it never does.
    const win = settingsWin;
    setTimeout(() => { if (alive(win) && !win.isVisible()) win.show(); }, 2500);
    settingsWin.on("closed", () => { settingsWin = null; onHotkeyCapture?.(false); });
    return settingsWin;
  }
  const settingsOwner = () => settingsWin;

  async function devices() {
    if (typeof listDevices !== "function") return [];
    try {
      const list = await Promise.race([Promise.resolve().then(listDevices), sleep(3000).then(() => [])]);
      return (Array.isArray(list) ? list : [])
        .filter(d => d && typeof d.deviceId === "string")
        .map((d, i) => ({ deviceId: d.deviceId.slice(0, 512), label: String(d.label || "").slice(0, 256) || t("voice.settings.micNumbered", { n: i + 1 }) }));
    } catch { return []; }
  }

  const keyState = () => Object.fromEntries(settings.PROVIDERS.map(p => [p, settings.hasApiKey(p)]));

  handle("voice:settings:get", settingsOwner, async () => ({
    settings: settings.load(),
    hasKey: keyState(),
    providers: [...settings.PROVIDERS],
    models: TRANSCRIPTION_MODELS,
    providerMinutes: Object.fromEntries(settings.PROVIDERS.map(p => [p, maxRecordingMinutesFor(p)])),
    languages: languageChoices(),
    lengths: LENGTH_PRESETS,
    readAloudModels: SPEECH_MODELS,
    voices: VOICES.map(name => [name, voiceStyle(name)]),
    defaultVoice: DEFAULT_VOICE,
    hotkeyDefaults: { ...settings.defaults.hotkeys },
    devices: await devices()
  }));

  handle("voice:settings:fit", settingsOwner, height => {
    const win = settingsWin;
    const h = Math.round(Number(height));
    if (Number.isFinite(h) && h > 0) {
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      win.setContentSize(win.getContentSize()[0], Math.min(h, area.height - 60));
      if (!win.isVisible()) win.center();
      else {
        // Grown by a message or by switching to the taller tab: keep the bottom (and the Save button) on screen.
        const b = win.getBounds();
        const over = b.y + b.height - (area.y + area.height);
        if (over > 0) win.setPosition(b.x, Math.max(area.y, b.y - over));
      }
    }
    if (!win.isVisible()) win.show();
    return true;
  });

  // General section: language, theme and the edge menu, applied at once.
  handle("prefs:set", settingsOwner, patch => general?.set(isObj(patch) ? patch : {}));
  handle("app:edge-hotkey", settingsOwner, () => general?.hotkey() ?? null);

  // The page is recording a new combination while one of its hotkey fields has the focus.
  handle("voice:settings:capture", settingsOwner, on => { onHotkeyCapture?.(on === true); return true; });

  handle("voice:settings:save", settingsOwner, async payload => {
    const { patch, keys, errors } = validateSettings(payload, settings.PROVIDERS);
    if (Object.keys(errors).length) return { ok: false, errors };
    // Keys first: if encryption is unavailable nothing is saved and the user is told why.
    try {
      for (const [provider, k] of Object.entries(keys)) await settings.setApiKey(provider, k.clear ? "" : k.value);
    } catch (e) {
      return { ok: false, errors: { apiKey: t("voice.settings.err.keyNotSaved", { error: e.message }) } };
    }
    // In effect at once; a file that could not be written is reported, not rolled back.
    let unsaved = null;
    const next = await settings.save(patch).catch(e => { unsaved = e; return settings.load(); });
    // The integrator re-registers the hotkeys; a {hotkeyErrors} answer keeps the window open with the reason.
    const warnings = {};
    try {
      const r = await onSettingsChanged?.(next);
      if (isObj(r?.hotkeyErrors)) {
        for (const k of ["dictate", "readAloud"]) if (r.hotkeyErrors[k]) warnings[`hotkeys.${k}`] = String(r.hotkeyErrors[k]);
      }
    } catch (e) { warnings.form = String(e?.message || e); }
    if (unsaved) warnings.form = t("voice.settings.err.notWritten", { error: unsaved.message });
    return { ok: true, settings: next, hasKey: keyState(), warnings };
  });

  // A new UI language: both pages are rebuilt. A new theme: only the window colour behind them changes.
  function onPrefsChanged(keys) {
    for (const win of [historyWin, settingsWin].filter(alive)) {
      if (keys.includes("language")) {
        if (win === settingsWin) onHotkeyCapture?.(false); // a focused hotkey field gets no blur on the way out
        win.webContents.reload();
      }
      if (keys.includes("theme")) win.setBackgroundColor(background());
    }
  }

  return { openHistory, openSettings, onPrefsChanged };
}

// Everything the Settings page sends is checked here; the page is not trusted to have offered only valid choices.
function validateSettings(p, providers) {
  const errors = {}, patch = {}, keys = {};
  if (!isObj(p)) return { patch, keys, errors: { form: t("errors.invalidData") } };
  const str = (v, max) => (typeof v === "string" && v.length <= max ? v.trim() : null);

  if (!providers.includes(p.provider)) errors.provider = t("voice.settings.err.provider");
  else patch.provider = p.provider;

  patch.models = {};
  for (const provider of providers) {
    const m = str(p.models?.[provider] ?? "", 100);
    if (m === null || (m && !MODEL_RE.test(m))) errors.model = t("voice.settings.err.model");
    else patch.models[provider] = m || defaultModelFor(provider);
  }

  const lang = str(p.language, 16);
  if (!lang || !/^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})?)$/.test(lang)) errors.language = t("voice.settings.err.language");
  else patch.language = lang;

  if (typeof p.useClipboardPaste !== "boolean") errors.useClipboardPaste = t("voice.settings.err.value");
  else patch.useClipboardPaste = p.useClipboardPaste;

  const micId = str(p.microphoneDeviceId ?? "", 512), micName = str(p.microphoneName ?? "", 256);
  if (micId === null || micName === null) errors.microphone = t("voice.settings.err.mic");
  else Object.assign(patch, { microphoneDeviceId: micId, microphoneName: micName });

  const minutes = Number(p.maxRecordingMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) errors.maxRecordingMinutes = t("voice.settings.err.minutes", { min: 1, max: 60 });
  else patch.maxRecordingMinutes = minutes;

  const ram = str(p.readAloudModel ?? "", 100);
  if (ram === null || (ram && !MODEL_RE.test(ram))) errors.readAloudModel = t("voice.settings.err.model");
  else patch.readAloudModel = ram || DEFAULT_SPEECH_MODEL;

  const voice = str(p.readAloudVoice ?? "", 40);
  if (voice === null || (voice && !/^[A-Za-z]+$/.test(voice))) errors.readAloudVoice = t("voice.settings.err.voice");
  else patch.readAloudVoice = voice || DEFAULT_VOICE;

  const dictate = normalizeAccelerator(p.hotkeys?.dictate), readAloud = normalizeAccelerator(p.hotkeys?.readAloud);
  if (dictate.error) errors["hotkeys.dictate"] = dictate.error;
  if (readAloud.error) errors["hotkeys.readAloud"] = readAloud.error;
  if (!dictate.error && !readAloud.error) {
    if (dictate.value === readAloud.value) errors["hotkeys.readAloud"] = t("voice.settings.err.sameHotkeys");
    else patch.hotkeys = { dictate: dictate.value, readAloud: readAloud.value };
  }

  // {set: "key"} replaces, {clear: true} removes; a provider that is absent keeps whatever is saved.
  for (const [provider, k] of Object.entries(isObj(p.apiKeys) ? p.apiKeys : {})) {
    if (!providers.includes(provider) || !isObj(k)) { errors.apiKey = t("voice.settings.err.keyData"); continue; }
    if (k.clear === true) { keys[provider] = { clear: true }; continue; }
    const value = str(k.set, 512);
    if (!value) continue;
    if (!/^[\x21-\x7e]+$/.test(value)) errors.apiKey = t("voice.settings.err.keyChars");
    else keys[provider] = { value };
  }
  return { patch, keys, errors };
}

module.exports = { createVoiceWindows, normalizeAccelerator, validateSettings };
