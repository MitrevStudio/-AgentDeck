// Voice in the running app: hotkeys, recorder, floating panel, transcription queue and read-aloud wired together.
// Port of VoiceTray's App.xaml.cs state machine and HotkeyService. The tray itself belongs to main.js: it gets the
// menu items, the failure count and balloons from here.
const { BrowserWindow, powerMonitor } = require("electron");
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
const { createTalkKey, createEdgeHold } = require("./talk-key");
const { vocabulary } = require("./dictionary");
const { MODES } = require("./dictation-options");
const { maxRecordingBytes, maxRecordingMinutesFor, transcribeFile } = require("./transcription");
const { createCommandRunner } = require("./command-runner");
const commandOptions = require("./command-options");
const { HEADER_BYTES } = require("./wav");
const { hhmm, keyLabel } = require("./util");
const { t, tn, formatNumber, locale } = require("../i18n");

// Stand in for a job id while the panel belongs to a reading, or to a voice command.
const READ_ALOUD = "read-aloud";
const COMMAND = "command";
const VOICETRAY_MUTEX = "Local\\VoiceTray.SingleInstance";
// Text is looked up when it is shown, so it is always in the language of the moment.
const keepRecording = () => t("voice.notice.keepRecording");

const menuText = s => String(s).replace(/&/g, "&&"); // a single & is a mnemonic marker in Windows menus
const logError = what => e => console.error(`${what}:`, e);

// balloon(text, {iconType, jobId}) shows a tray balloon; clicking one that carries a jobId should call retry(jobId).
// onTrayChanged() asks main to rebuild the tray menu and badge. prefs (../prefs.js) and general (the Settings
// window's General section) come from main; projectNames() lists AgentDeck's projects, which the dictionary may
// include. commands: what voice commands need of main (command-runner.js, `app`). Resolves once voice is ready: on
// the first run that includes copying VoiceTray's history, which the rest of the app does not wait for.
async function initVoice({ balloon = () => {}, onTrayChanged = () => {}, icon, prefs, general, projectNames = () => [], commands: app = null } = {}) {
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

  let rec = null;         // the recording in progress: {id, target, recordedWith, mode, capMinutes, capIsProvider, stopping}
  let held = null;        // the recording the dictation key started and may end by being let go (push-to-talk)
  let heldReader = null;  // whether the dictation hotkey is still held down (win32.keyHeld)
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
  const projects = () => { try { return projectNames() || []; } catch { return []; } };
  const terms = () => vocabulary(settings.load().dictionary, projects());
  const q = createQueue({ notify, vocabulary: terms });
  const recorder = createRecorder();
  const overlay = createOverlay({ onAction });
  const saveSettings = patch => settings.save(patch).catch(logError("Could not save the voice settings"));
  const tts = createReadAloud({ overlay, getSettings: settings.load, getApiKey: settings.getApiKey, saveSettings });
  const windows = createVoiceWindows({
    settings, store, queue: q, icon, onSettingsChanged, onHotkeyCapture: pauseHotkeys, onReread: readText,
    general, background: prefs?.background, projectNames: projects, commandSettings: { get: commandSettings, set: setCommandSettings },
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
  const busy = () => Boolean(rec || capturing) || tts.isActive() || commands.active;
  function panel(state, data, who) { owner = who; overlay.show(state, data); }
  // A fresh panel at the cursor (VoiceTray closed and re-created its window).
  function freshPanel(state, data, who) { overlay.hide(); panel(state, data, who); }
  function closePanel() { overlay.hide(); owner = null; }

  function onAction(a) {
    if (["run", "finish", "cancel", "choose", "hold"].includes(a.type)) return commands.onAction(a);
    if (a.type === "retry") {
      closePanel();
      // A failed reading has no record to retry - it is read again from its text.
      if (a.jobId === READ_ALOUD) { try { if (retryText) readText(retryText); } catch (e) { balloon(e.message); } }
      else if (a.jobId) q.retry(a.jobId);
    } else if (a.type === "close") owner = null; // the panel has hidden itself
    else if (a.type === "pause") tts.togglePause();
    else if (a.type === "stop") tts.stop();
    else if (a.type === "speed") tts.setSpeed(a.speed);
    else if (a.type === "mode") setMode(a.mode);
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
    heldReader = registered.dictate ? win32.keyHeld(registered.dictate) : null;
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

  // Hotkey handlers run inside WM_HOTKEY: the foreground window is read there, while it still is the user's - and
  // the key is still down, which is where watching for its release (push-to-talk) starts.
  function onDictateKey() {
    if (disposed) return;
    // One recording at a time: during a voice command the dictation key ends it (and does only that) - a command
    // spoken after a click on the menu's microphone is finished, anything else cancelled.
    if (commands.active && !rec) return commands.dictateKey();
    const recording = Boolean(rec);
    talk.press({ recording, mode: settings.load().pushToTalk });
    toggleRecording(win32.foreground());
    held = recording ? null : rec; // startRecording() sets rec before its first await
  }

  const talk = createTalkKey({
    isHeld: () => Boolean(heldReader?.()),
    onRelease: () => {
      const r = held;
      held = null;
      if (r && rec === r && !r.stopping) toggleRecording();
    }
  });
  // A locked session swallows the key-up; the hold is over either way.
  const onLock = () => { talk.release(); edge?.keys.release(); };
  powerMonitor.on("lock-screen", onLock);

  // The mode chip on the panel: this recording only.
  function setMode(mode) {
    const r = rec;
    if (!r || r.stopping || !MODES.includes(mode)) return;
    r.mode = mode;
    overlay.update({ mode });
  }

  // ---------- dictation ----------
  // target: the window to type into afterwards; null (started from the tray) means "offer it on the clipboard".
  function toggleRecording(target = null) {
    if (disposed) return;
    if (!rec && commands.active) return commands.cancel(); // the tray's Record during a voice command
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
      id: store.newId(), target, recordedWith: jobSettings(s), mode: s.dictationMode, stopping: false,
      capMinutes: Math.min(s.maxRecordingMinutes, providerCap), capIsProvider: providerCap < s.maxRecordingMinutes
    };
    // Nothing may be typed into the window the user is about to dictate into.
    q.setRecording(true);
    hotkeys.register("cancel", "Escape", cancelRecording);
    freshPanel("listening", {
      hotkey: keyLabel(registered.dictate), cancelKey: "Esc", limitSeconds: r.capMinutes * 60, mode: r.mode,
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
    if (owner === r.id) overlay.show("transcribing", { provider: r.recordedWith.Provider, mode: r.mode });
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
    if (held === r) { held = null; talk.cancel(); }
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
    if (owner === r.id && overlay.state === "listening") overlay.show("transcribing", { provider: r.recordedWith.Provider, mode: r.mode });
    q.enqueue(r.id, {
      deliverTo: r.target, durationSeconds: result.durationMs / 1000, audioBytes: result.bytes + HEADER_BYTES,
      recordedWith: { ...r.recordedWith, Mode: r.mode }
    });
  }

  // ---------- queue ----------
  q.on("job", ({ type, id, job, outcome }) => {
    trayChanged();
    if (type === "started") {
      // Never take the panel away from someone who is mid-sentence - speaking or being spoken to.
      if (!busy() && !(owner === id && overlay.state === "transcribing")) panel("transcribing", { provider: job.Provider, mode: job.Mode }, id);
    } else if (type === "rewriting") {
      if (owner === id && overlay.state === "transcribing") overlay.update({ rewriting: job?.Mode });
    } else if (type === "completed" && owner === id && overlay.state === "transcribing") {
      // A brief "done" on the panel that was waiting for this dictation; it goes away by itself. A rewrite that
      // failed says so quietly here (and in History): the transcript went in as it was.
      toldOnPanel = id;
      panel("success", outcome === "ClipboardOnly"
        ? { title: t("voice.overlay.copied"), detail: t("voice.overlay.pressPaste"), durationMs: 2600 }
        : job?.RewriteError ? { title: t("voice.overlay.pastedRaw"), detail: job.RewriteError, durationMs: 3200 }
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
    if (commands.active) return commands.cancel(); // the reading would take the panel from the command's card
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
    if (commands.active) commands.cancel(); // the reading takes the panel, and a card nobody sees must not keep Esc
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

  // ---------- voice commands ----------
  // command-runner.js does the work; here it gets the recorder, the panel, Esc and History. Project names always
  // help the recognition of a command, whatever the dictionary says about dictations.
  const commands = createCommandRunner({
    recorder, store, settings, balloon,
    transcribe: opts => transcribeFile(opts),
    generate: opts => require("./rewrite").generate(opts),
    rewrite: (text, opts) => require("./rewrite").rewrite(text, opts),
    vocabulary: () => vocabulary({ ...settings.load().dictionary, projectNames: true }, projects()),
    panel: {
      fresh: (state, data) => freshPanel(state, data, COMMAND),
      show: (state, data) => panel(state, data, COMMAND),
      update: data => { if (owner === COMMAND) overlay.update(data); },
      close: () => { if (owner === COMMAND) closePanel(); }
    },
    escape: { register: onPress => hotkeys.register("cancel", "Escape", onPress), unregister: () => hotkeys.unregister("cancel") },
    busy: () => Boolean(rec),
    stopReading: () => { capturing = null; if (tts.isActive()) tts.stop(); },
    addRecord: id => q.addRecord(id),
    holdLabel: () => general?.hotkey?.()?.current || "",
    app: {
      data: async () => ({ registry: { projects: [] }, sessions: [] }), live: async () => [],
      ...app,
      onState: s => { try { app?.onState?.(s); } catch (e) { console.error("Command state:", e); } }
    }
  });

  // The edge menu's hotkey (main asks first, and toggles the menu itself when the answer is false). The menu opens or
  // closes at once, right here inside the hotkey's callback, where Windows lets it take the keyboard focus; a press
  // that opened it and is still held a moment later speaks a voice command while the menu stays open (talk-key.js).
  let edge = null; // {accel, keys}
  function edgeKey(accel, toggleMenu) {
    if (disposed) return false;
    if (edge?.accel !== accel) {
      const isHeld = win32.keyHeld(accel);
      if (!isHeld) return false;
      edge = { accel, keys: createEdgeHold({ isHeld, onHold: holdCommand, onRelease: () => commands.released() }) };
    }
    if (edge.keys.watching) return true; // the key repeating while it is held
    const opened = toggleMenu();
    const c = settings.load().commands;
    edge.keys.press(Boolean(opened) && c.enabled && c.trigger === "hold");
    return true;
  }
  // Held down while a dictation records: the open menu says why nothing happens.
  function holdCommand() {
    const r = commands.start("hold");
    if (r?.error) app?.onState?.({ ...commands.state(), error: r.error });
  }

  // Settings -> Commands, applied at once.
  function commandSettings() {
    return { commands: settings.load().commands, agents: [...commandOptions.AGENTS], hotkey: general?.hotkey?.()?.current || "" };
  }
  async function setCommandSettings(patch) {
    const r = commandOptions.validate(patch, settings.load().commands);
    if (r.error) return { ok: false, error: r.error };
    try { await settings.save({ commands: r.value }); } catch (e) { return { ok: false, error: "form", message: e.message }; }
    if (!r.value.enabled) commands.cancel();
    commands.settingsChanged();
    return { ok: true, commands: settings.load().commands };
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
    powerMonitor.off("lock-screen", onLock);
    talk.cancel();
    commands.dispose();
    edge?.keys.release();
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
  commands.settingsChanged(); // the edge menu learns whether to offer its microphone

  return {
    trayMenu, dispose, edgeKey,
    retry: id => q.retry(id),
    openHistory: () => windows.openHistory(),
    openSettings: () => windows.openSettings(),
    // The edge menu's microphone: start / finish / stop a command, and what its button shows.
    command: { toggle: () => commands.toggle(), state: () => commands.state() }
  };
}

module.exports = { initVoice };
