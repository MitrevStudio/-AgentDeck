// Voice in the running app: hotkeys, recorder, floating panel, transcription queue and read-aloud wired together.
// Port of VoiceTray's App.xaml.cs state machine and HotkeyService. The tray itself belongs to main.js: it gets the
// menu items, the failure count and balloons from here.
const { BrowserWindow } = require("electron");
const fs = require("node:fs");
const settings = require("./settings");
const store = require("./job-store");
const win32 = require("./win32");
const selection = require("./selection");
const delivery = require("./delivery");
const { importIfNeeded } = require("./import-voicetray");
const { createQueue, jobSettings } = require("./queue");
const { createRecorder } = require("./recorder");
const { createOverlay } = require("./overlay");
const { createReadAloud, MAX_CHARACTERS } = require("./tts");
const { createVoiceWindows } = require("./windows");
const { maxRecordingBytes, maxRecordingMinutesFor } = require("./transcription");
const { HEADER_BYTES } = require("./wav");
const { hhmm, keyLabel } = require("./util");
const { t, tn, formatNumber, locale } = require("../i18n");

// Stands in for a job id while the panel belongs to a reading.
const READ_ALOUD = "read-aloud";
const VOICETRAY_MUTEX = "Local\\VoiceTray.SingleInstance";
// Text is looked up when it is shown, so it is always in the language of the moment.
const keepRecording = () => t("voice.notice.keepRecording");

const menuText = s => String(s).replace(/&/g, "&&"); // a single & is a mnemonic marker in Windows menus
const logError = what => e => console.error(`${what}:`, e);

// balloon(text, {iconType, jobId}) shows a tray balloon; clicking one that carries a jobId should call retry(jobId).
// onTrayChanged() asks main to rebuild the tray menu and badge. prefs (../prefs.js) and general (the Settings
// window's General section) come from main. Resolves once voice is ready: on the first run that includes copying
// VoiceTray's history, which the rest of the app does not wait for.
async function initVoice({ balloon = () => {}, onTrayChanged = () => {}, icon, prefs, general } = {}) {
  // Startup order matters: the import copies VoiceTray's records before recovery re-points their audio paths.
  settings.init();
  store.init();
  await settings.ready();
  try {
    const r = await importIfNeeded();
    if (r.settings || r.records) console.log(`Imported from VoiceTray: settings ${r.settings}, ${r.apiKeys} API keys, ${r.records} records`);
  } catch (e) { console.error("VoiceTray import failed:", e.message); }
  const { waiting } = store.recoverOnStartup();
  store.applyRetention();

  let rec = null;         // the recording in progress: {id, target, recordedWith, capMinutes, capIsProvider, stopping}
  let capturing = null;   // token of a selection being copied for read-aloud, before its text is in hand
  let owner = null;       // what the panel is reporting on: a job id, READ_ALOUD or null
  let toldOnPanel = null; // the dictation whose "copied - press Ctrl+V" the panel showed
  let retryText = null;   // what Retry on a failed reading reads again
  let registered = {};    // hotkey id -> accelerator held
  let editingHotkeys = false; // the Settings page is recording a new combination
  let trayTimer = null;
  let disposed = false;

  // "Copied, press Ctrl+V" goes on the panel when it was watching that dictation, otherwise into a balloon - the
  // choice VoiceTray made between its card and a balloon.
  const notify = n => { if (!(n.type === "clipboard" && n.job?.Id === toldOnPanel)) balloon(n.message, { iconType: "info" }); };
  const q = createQueue({ notify });
  const recorder = createRecorder();
  const overlay = createOverlay({ onAction });
  const saveSettings = patch => settings.save(patch).catch(logError("Could not save the voice settings"));
  const tts = createReadAloud({ overlay, getSettings: settings.load, getApiKey: settings.getApiKey, saveSettings });
  const windows = createVoiceWindows({
    settings, store, queue: q, icon, onSettingsChanged, onHotkeyCapture: pauseHotkeys, onReread: readText,
    general, background: prefs?.background,
    copyText: async text => (await delivery.deliverToClipboard(text)).outcome !== "Failed",
    listDevices: () => recorder.listDevices()
  });
  // RegisterHotKey needs a window that lives as long as the hotkeys; a hidden one is enough.
  const hotkeyWin = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, title: "AgentDeck hotkeys" });
  const hotkeys = win32.createHotkeys(hotkeyWin);

  // A dictation emits several events within milliseconds; the menu is rebuilt once.
  function trayChanged() {
    if (!trayTimer) trayTimer = setTimeout(() => { trayTimer = null; if (!disposed) onTrayChanged(); }, 30);
  }

  // ---------- panel ----------
  const busy = () => Boolean(rec || capturing) || tts.isActive();
  function panel(state, data, who) { owner = who; overlay.show(state, data); }
  // A fresh panel at the cursor (VoiceTray closed and re-created its window).
  function freshPanel(state, data, who) { overlay.hide(); panel(state, data, who); }
  function closePanel() { overlay.hide(); owner = null; }

  function onAction(a) {
    if (a.type === "retry") {
      closePanel();
      // A failed reading has no record to retry - it is read again from its text.
      if (a.jobId === READ_ALOUD) { try { if (retryText) readText(retryText); } catch (e) { balloon(e.message); } }
      else if (a.jobId) q.retry(a.jobId);
    } else if (a.type === "close") owner = null; // the panel has hidden itself
    else if (a.type === "pause") tts.togglePause();
    else if (a.type === "stop") tts.stop();
    else if (a.type === "speed") tts.setSpeed(a.speed);
  }

  // ---------- hotkeys ----------
  const releaseHotkeys = () => { hotkeys.unregister("dictate"); hotkeys.unregister("readAloud"); };

  function registerHotkeys(s = settings.load()) {
    // Both released first, so swapping the two combinations does not collide with ourselves.
    releaseHotkeys();
    registered = {};
    const errors = {};
    for (const [id, onPress] of [["dictate", onDictateKey], ["readAloud", onReadAloudKey]]) {
      const accel = s.hotkeys[id];
      if (hotkeys.register(id, accel, onPress)) registered[id] = accel;
      else errors[id] = win32.parseAccelerator(accel) ? t("voice.errors.hotkeyTaken", { key: keyLabel(accel) }) : t("voice.errors.hotkeyInvalid", { key: accel });
    }
    // Checked, and let go again while the Settings page is still recording keys.
    if (editingHotkeys) releaseHotkeys();
    trayChanged();
    return errors;
  }

  // While a hotkey field in Settings has the focus, pressing the current combination must reach the field instead
  // of starting a dictation or a reading.
  function pauseHotkeys(on) {
    if (disposed || on === editingHotkeys) return;
    editingHotkeys = on;
    if (on) releaseHotkeys();
    else registerHotkeys();
  }

  function hotkeyWarning(ids) {
    const s = settings.load();
    const keys = new Intl.ListFormat(locale(), { type: "conjunction" }).format(ids.map(id => keyLabel(s.hotkeys[id])));
    const n = ids.length;
    const taken = win32.mutexExists(VOICETRAY_MUTEX) ? tn("voice.balloon.hotkeysTakenVoiceTray", n, { keys }) : tn("voice.balloon.hotkeysTaken", n, { keys });
    const fix = ids.includes("dictate") ? tn("voice.balloon.hotkeysFixDictate", n) : t("voice.balloon.hotkeysFixRead");
    return `${taken} ${fix}`;
  }

  function onSettingsChanged(s) {
    const errors = registerHotkeys(s);
    return Object.keys(errors).length ? { hotkeyErrors: errors } : undefined;
  }

  // Hotkey handlers run inside WM_HOTKEY: the foreground window is read there, while it still is the user's.
  function onDictateKey() { toggleRecording(win32.foreground()); }

  // ---------- dictation ----------
  // target: the window to type into afterwards; null (started from the tray) means "offer it on the clipboard".
  function toggleRecording(target = null) {
    if (disposed) return;
    const stopping = rec;
    const run = stopping ? stopRecording() : startRecording(target);
    const r = stopping || rec; // startRecording sets rec before its first await
    run.catch(e => {
      console.error("Recording failed:", e);
      if (r && endRecording(r) && owner === r.id) closePanel();
    });
  }

  async function startRecording(target) {
    // Recording wins: left playing, the microphone would pick up the reading and put it into the transcript.
    capturing = null;
    if (tts.isActive()) tts.stop();
    const s = settings.load();
    const providerCap = maxRecordingMinutesFor(s.provider);
    const r = rec = {
      // Transcribed with what is set now: the length cap below is this provider's, whatever is chosen meanwhile.
      id: store.newId(), target, recordedWith: jobSettings(s), stopping: false,
      capMinutes: Math.min(s.maxRecordingMinutes, providerCap), capIsProvider: providerCap < s.maxRecordingMinutes
    };
    // Nothing may be typed into the window the user is about to dictate into.
    q.setRecording(true);
    hotkeys.register("cancel", "Escape", cancelRecording);
    freshPanel("listening", {
      hotkey: keyLabel(registered.dictate), cancelKey: "Esc", limitSeconds: r.capMinutes * 60,
      hint: registered.dictate ? undefined : t("voice.overlay.hintNoHotkey")
    }, r.id);
    trayChanged();
    try {
      const info = await recorder.start({
        deviceId: s.microphoneDeviceId, deviceName: s.microphoneName, wavPath: store.wavPath(r.id), maxBytes: maxRecordingBytes(s),
        onLevel: (level, elapsed) => { if (rec === r) overlay.update({ level, elapsed }); },
        onLimit: result => recordingStopped(r, result, true),
        onEnded: result => recordingStopped(r, result)
      });
      // Found by its old name (imported from VoiceTray, or the id changed): the id matches next time.
      if (info?.matchedBy === "name" && info.deviceId !== s.microphoneDeviceId) saveSettings({ microphoneDeviceId: info.deviceId });
    } catch (e) {
      // Stopped while the microphone was still opening: recordingStopped() has ended it without saying why.
      if (!endRecording(r) && (disposed || !r.stopping)) return;
      if (owner === r.id) closePanel();
      balloon(t("voice.balloon.recordStartFailed", { error: e.message }), { iconType: "error" });
    }
  }

  async function stopRecording() {
    const r = rec;
    if (!r || r.stopping) return;
    r.stopping = true;
    if (owner === r.id) overlay.show("transcribing", { provider: r.recordedWith.Provider });
    let result = null;
    try { result = await recorder.stop(); } catch (e) { console.error("Stopping the recording failed:", e.message); }
    recordingStopped(r, result);
  }

  function cancelRecording() {
    const r = rec;
    if (!r || r.stopping || !endRecording(r)) return;
    if (owner === r.id) closePanel();
    recorder.cancel().catch(logError("Cancelling the recording failed"));
  }

  // Delivery must be resumed before the job is queued, or it would wait for a recording that is over.
  function endRecording(r) {
    if (!r || rec !== r) return false;
    rec = null;
    hotkeys.unregister("cancel");
    q.setRecording(false);
    trayChanged();
    return true;
  }

  function recordingStopped(r, result, byLimit = false) {
    if (!endRecording(r)) return;
    // Nothing to transcribe: the microphone never opened (start() reports why), or the file could not be written.
    if (!result || result.failed) {
      if (owner === r.id) closePanel();
      if (result) { store.removeAudio(r.id); balloon(result.error, { iconType: "error" }); }
      return;
    }
    // The WAV is closed properly even when the device vanished, so what was captured is still transcribed.
    if (result.error) balloon(t("voice.balloon.recordEndedEarly", { error: result.error }), { iconType: "warning" });
    if (byLimit) {
      const minutes = formatNumber(r.capMinutes);
      balloon(r.capIsProvider ? t("voice.balloon.limitProvider", { minutes, provider: r.recordedWith.Provider })
        : t("voice.balloon.limitUser", { minutes }), { iconType: "warning" });
    }
    if (result.tooShort) { // a mis-tap, not speech
      if (owner === r.id) closePanel();
      store.removeAudio(r.id);
      return;
    }
    // The panel stays up, now showing progress, until the job finishes or fails.
    if (owner === r.id && overlay.state === "listening") overlay.show("transcribing", { provider: r.recordedWith.Provider });
    q.enqueue(r.id, {
      deliverTo: r.target, durationSeconds: result.durationMs / 1000, audioBytes: result.bytes + HEADER_BYTES, recordedWith: r.recordedWith
    });
  }

  // ---------- queue ----------
  q.on("job", ({ type, id, job, outcome }) => {
    trayChanged();
    if (type === "started") {
      // Never take the panel away from someone who is mid-sentence - speaking or being spoken to.
      if (!busy() && !(owner === id && overlay.state === "transcribing")) panel("transcribing", { provider: job.Provider }, id);
    } else if (type === "completed" && owner === id && overlay.state === "transcribing") {
      // A brief "done" on the panel that was waiting for this dictation; it goes away by itself.
      toldOnPanel = id;
      panel("success", outcome === "ClipboardOnly"
        ? { title: t("voice.overlay.copied"), detail: t("voice.overlay.pressPaste"), durationMs: 2600 }
        : { title: t("voice.overlay.pasted") }, id);
    } else if (type === "completed" || type === "empty" || type === "removed") {
      if (type === "completed") toldOnPanel = null;
      if (owner === id && overlay.state !== "listening") closePanel();
    } else if (type === "failed" && job) {
      const title = job.LastErrorShort || t("voice.errors.transcriptionFailed");
      const detail = job.LastError || t("voice.errors.recordingKept");
      // The panel is the place for it; a balloon only when the panel is busy with a recording or a reading.
      if (busy()) balloon(t("voice.balloon.clickToRetry", { detail }), { iconType: "error", jobId: id });
      else panel("error", { jobId: id, title, detail, canRetry: true }, id);
    }
  });

  // ---------- read-aloud ----------
  function onReadAloudKey() {
    if (rec) return balloon(keepRecording());
    // Pressed during a reading it stops: the selection is usually still highlighted, and reading it would restart
    // the same passage instead of silencing it.
    if (capturing || tts.isActive()) { capturing = null; tts.stop(); return; }
    readSelection(win32.foreground()).catch(e => {
      console.error("Reading the selection failed:", e);
      capturing = null;
    });
  }

  // Nothing is shown while the selection is copied: in VS Code it vanished the moment a panel appeared.
  async function readSelection(target) {
    const token = capturing = {};
    let sel;
    try { sel = await selection.capture(target); } catch (e) { sel = { text: "", failure: "Error", message: e.message }; }
    if (capturing !== token) return; // stopped, or a recording started, while copying
    capturing = null;
    if (sel.failure !== "None" || !sel.text.trim()) return readAloudNotice(...selectionProblem(sel));
    tts.start(sel.text);
    if (!sel.clipboardRestored) readAloudNotice(t("voice.notice.clipboardNotRestored.title"), t("voice.notice.clipboardNotRestored.detail"));
  }

  function selectionProblem(sel) {
    switch (sel.failure) {
      case "NothingSelected": return [t("voice.notice.nothingSelected.title"),
        t("voice.notice.nothingSelected.detail", { key: keyLabel(registered.readAloud) || t("voice.notice.readHotkey") })];
      case "KeysHeld": return [t("voice.notice.keysHeld.title"), t("voice.notice.keysHeld.detail")];
      case "FocusChanged": return [t("voice.notice.focusChanged.title"), t("voice.notice.focusChanged.detail")];
      default: return [t("voice.notice.copyFailed.title"),
        sel.message ? t("voice.notice.copyFailed.reason", { error: sel.message }) : t("voice.notice.copyFailed.detail")];
    }
  }

  function readAloudNotice(title, detail) {
    // Mid-reading it must not replace the panel that is playing.
    if (tts.isActive()) return balloon(t("voice.balloon.notice", { title, detail }), { iconType: "warning" });
    freshPanel("notice", { title, detail }, READ_ALOUD);
  }

  // Re-read from History, Retry after a failure.
  function readText(text) {
    if (rec) throw new Error(keepRecording());
    capturing = null;
    if (!tts.start(text)) throw new Error(t("voice.errors.nothingToRead"));
  }

  tts.on("state", ({ phase, title, speed, truncated }) => {
    if (phase === "preparing") freshPanel("preparing", { detail: "Gemini" }, READ_ALOUD);
    else if (phase === "playing") {
      if (overlay.state === "speaking") { owner = READ_ALOUD; overlay.update({ paused: false }); return; }
      panel("speaking", { title, speed, paused: false }, READ_ALOUD);
      if (truncated) balloon(t("voice.balloon.truncated", { n: formatNumber(MAX_CHARACTERS) }));
    } else if (phase === "paused") overlay.update({ paused: true });
    // Idle: only what the reading itself put up is closed; a notice or an error stays until it has been seen.
    else if (owner === READ_ALOUD && ["preparing", "speaking"].includes(overlay.state)) closePanel();
  });

  tts.on("error", (err, text) => {
    retryText = text;
    const detail = err.longMessage || err.message;
    if (rec) return balloon(t("voice.balloon.readFailed", { error: detail }), { iconType: "error" });
    panel("error", { jobId: READ_ALOUD, title: err.shortMessage || t("voice.errors.readFailed"), detail, canRetry: true }, READ_ALOUD);
  });

  tts.on("done", d => saveReading(d).catch(logError("Could not save the reading")));
  async function saveReading(d) {
    // Audio before the sidecar: a WAV without one is swept at the next launch, a sidecar without audio is text-only.
    let seconds = 0;
    if (d.wavBuffer) {
      try {
        await fs.promises.writeFile(store.wavPath(d.id), d.wavBuffer);
        store.setAudio(d.id, d.wavBuffer.length);
        seconds = d.durationMs / 1000;
      } catch {}
    }
    store.create("ReadAloud", {
      Id: d.id, CreatedAt: store.stamp(d.createdAt), CompletedAt: store.stamp(d.completedAt), DurationSeconds: seconds,
      Provider: d.provider, Model: d.model, Voice: d.voice, Language: "auto", Status: "Done", AttemptCount: 1, ResultText: d.text
    });
    q.addRecord(d.id);
  }

  // ---------- tray ----------
  function describe(j) {
    return menuText(t("voice.tray.failure", {
      action: t(j.ResultText ? "voice.tray.pasteAgain" : "voice.tray.tryAgain"), time: hhmm(j.CreatedAt),
      seconds: formatNumber(Math.max(1, Math.round(j.DurationSeconds || 0))), error: j.LastErrorShort || t("voice.tray.failed")
    }));
  }
  function trayMenu() {
    const list = q.failures();
    const item = j => ({ label: describe(j), click: () => q.retry(j.Id) });
    return {
      failureCount: list.length,
      failures: list.length <= 1 ? list.map(item) : [{ label: t("voice.tray.failures", { n: formatNumber(list.length) }), submenu: [
        ...list.map(item),
        { type: "separator" },
        { label: t("voice.tray.retryAll"), click: () => q.retryAll() },
        { label: t("voice.tray.discardAll"), click: () => q.discardAll() }
      ] }],
      items: [
        { label: t(rec ? "voice.tray.stopRecording" : "voice.tray.record"), accelerator: registered.dictate, registerAccelerator: false, click: () => toggleRecording() },
        { label: t("voice.tray.history"), click: () => windows.openHistory() }
      ]
    };
  }

  // ---------- shutdown ----------
  // A recording in progress is dropped; an attempt in flight goes back to Pending and is offered at the next launch.
  async function dispose() {
    if (disposed) return;
    disposed = true;
    prefs?.off("changed", onPrefsChanged);
    clearTimeout(trayTimer);
    hotkeys.unregisterAll();
    capturing = null;
    tts.stop();
    rec = null;
    recorder.destroy(); // at once: a microphone still opening is not waited for
    selection.dispose();
    await q.stop();
    overlay.destroy();
    if (!hotkeyWin.isDestroyed()) hotkeyWin.destroy();
    await store.flush(); // the attempt put back to Pending reaches the disk before the process ends
  }

  // ---------- preferences ----------
  // Main reloads its own windows and broadcasts the theme; these are voice's.
  function onPrefsChanged(_p, keys) {
    windows.onPrefsChanged(keys);
    if (keys.includes("language")) overlay.refresh();
  }
  prefs?.on("changed", onPrefsChanged);

  // ---------- start ----------
  const taken = Object.keys(registerHotkeys());
  if (taken.length) balloon(hotkeyWarning(taken), { iconType: "warning" });
  else if (waiting) balloon(tn("voice.balloon.waiting", waiting), { iconType: "warning" });
  // The first press then pays neither for loading the capture page nor for starting the selection thread.
  recorder.warmUp();
  selection.warmUp();

  return {
    trayMenu, dispose,
    retry: id => q.retry(id),
    openHistory: () => windows.openHistory(),
    openSettings: () => windows.openSettings()
  };
}

module.exports = { initVoice };
