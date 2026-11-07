// One voice command at a time, from the microphone to the command centre (orchestrator.js): recording -> recognising
// -> the transcript typed into the command centre's terminal, which does what it says -> a line in History. Esc,
// Cancel, the dictation key or a new hold stop it before it is sent (the dictation key and a click on the panel
// finish a recording that the menu's microphone started).
//
// The controller lends it the recorder, the voice panel (panel.*, so it knows who owns the panel) and the Esc
// hotkey; main lends it the command centre (app.orchestrate). Everything is injected, so tests can drive it without
// Electron.
const { t } = require("../i18n");
const { applyReplacements } = require("./dictionary");
const { defaultModelFor } = require("./catalog");
const { BYTES_PER_SECOND, HEADER_BYTES } = require("./wav");
const { maxRecordingBytes } = require("./transcription");

const LIMIT_SECONDS = 60; // a command is a sentence or two

// deps: recorder, store (job-store), settings, transcribe(opts), vocabulary(), panel {fresh(state, data),
// show(state, data), update(data), close()}, escape {register(onPress), unregister()}, busy() (a dictation is
// recording), stopReading(), addRecord(id), balloon(text, opts), app {orchestrate(text) -> {ok, started},
// onState({enabled, state})}, holdLabel() (the edge hotkey as shown), now().
function createCommandRunner(deps) {
  const { recorder, store, settings, panel, app } = deps;
  const now = deps.now || Date.now;
  let cur = null; // {id, phase, source, ac, s, createdAt, transcript, audio, stopping}
  let disposed = false;

  const enabled = () => settings.load().commands.enabled;
  const report = state => { try { app.onState?.({ enabled: enabled(), state }); } catch (e) { console.error("Command state:", e); } };
  const logError = what => e => console.error(`${what}:`, e?.message || e);

  // ---------- lifecycle ----------
  // Ends the command (it stays on screen as whatever the panel shows last). False when it was already over.
  function end(c) {
    if (cur !== c) return false;
    cur = null;
    deps.escape.unregister();
    report("idle");
    return true;
  }

  // The recording goes too - once the recorder has closed its file, or the file would come back.
  function drop(c) {
    if (!end(c)) return;
    Promise.resolve(c.stopping).finally(() => store.removeAudio(c.id));
    panel.close();
  }

  // source: "hold" (the edge menu's hotkey held down) or "menu" (its microphone). A new hold replaces a command that
  // is being recognised - the user is saying it again; one still recording keeps the microphone.
  function start(source) {
    if (disposed || !enabled()) return { ok: false };
    if (cur) {
      if (source !== "hold" || cur.phase !== "thinking") return { ok: false };
      cancel();
    }
    if (deps.busy()) return { ok: false, error: t("voice.command.busy") };
    deps.stopReading();
    const s = settings.load();
    const c = cur = { id: store.newId(), phase: "recording", source, ac: new AbortController(), s, createdAt: new Date(now()) };
    deps.escape.register(cancel);
    report("recording");
    // Started from the menu, it is finished by the microphone, the dictation key or a click on the panel: the menu
    // may have gone meanwhile.
    const hint = source === "hold" ? t("voice.command.hint.release", { key: deps.holdLabel() || "" }) : t("voice.command.hint.click");
    panel.fresh("listening", { command: true, hint, cancelKey: "Esc", limitSeconds: LIMIT_SECONDS });
    recorder.start({
      deviceId: s.microphoneDeviceId, deviceName: s.microphoneName, wavPath: store.wavPath(c.id),
      maxBytes: Math.min(maxRecordingBytes(s), LIMIT_SECONDS * BYTES_PER_SECOND),
      onLevel: (level, elapsed) => { if (cur === c && c.phase === "recording") panel.update({ level, elapsed }); },
      onLimit: result => stopped(c, result),
      onEnded: result => stopped(c, result)
    }).catch(e => {
      // Stopped while the microphone was still opening: stopped() has dealt with it.
      if (cur !== c || c.phase !== "recording") return;
      drop(c);
      deps.balloon(t("voice.balloon.recordStartFailed", { error: e.message }), { iconType: "error" });
    });
    return { ok: true };
  }

  // The key let go, the microphone clicked again, a click on the panel.
  function finish() {
    const c = cur;
    if (!c || c.phase !== "recording") return;
    thinking(c);
    c.stopping = recorder.stop().then(r => stopped(c, r), e => { console.error("Stopping the command recording failed:", e.message); stopped(c, null); });
  }

  function thinking(c) {
    c.phase = "thinking";
    report("working");
    panel.show("transcribing", { provider: c.s.provider, mode: "verbatim", command: true });
  }

  function stopped(c, result) {
    if (cur !== c || c.audio !== undefined) return;
    c.audio = null;
    if (c.phase === "recording") thinking(c); // the length limit, or the device went away
    if (!result || result.failed) {
      if (result?.error) deps.balloon(result.error, { iconType: "error" });
      return drop(c);
    }
    if (result.tooShort) return drop(c); // held a moment too long for a tap, nothing said
    c.audio = { seconds: result.durationMs / 1000, bytes: result.bytes + HEADER_BYTES };
    understand(c).catch(e => fail(c, e));
  }

  // ---------- recognising, then off to the command centre ----------
  async function understand(c) {
    const s = c.s;
    const raw = await deps.transcribe({ wavPath: store.wavPath(c.id), provider: s.provider, model: s.models?.[s.provider] || defaultModelFor(s.provider),
      language: s.language, vocabulary: deps.vocabulary(), getApiKey: settings.getApiKey, signal: c.ac.signal });
    if (cur !== c) return;
    const transcript = applyReplacements(String(raw ?? ""), s.dictionary?.replacements).trim();
    if (!transcript) {
      drop(c);
      return panel.fresh("notice", { title: t("voice.command.noSpeech"), detail: "" });
    }
    c.transcript = transcript;
    // From here it is the command centre's: Esc no longer takes it back.
    c.phase = "sending";
    deps.escape.unregister();
    panel.show("notice", { title: t("voice.command.sending"), detail: t("voice.command.quoted", { text: transcript }) });
    const r = await app.orchestrate(transcript);
    record(c, r?.ok ? "Done" : "Failed", { outcome: r?.ok ? "sent" : "failed", note: r?.ok ? "" : t("voice.command.error.title") });
    if (!end(c)) return;
    if (!r?.ok) return panel.show("error", { title: t("voice.command.error.title"), detail: transcript, canRetry: false });
    panel.show("success", { title: t(r.started ? "voice.command.sentStarted" : "voice.command.sent"), detail: transcript });
  }

  // Esc, Cancel, the dictation key, a new hold, a reading started from History. Not once it is being sent.
  function cancel() {
    const c = cur;
    if (!c || c.phase === "sending") return;
    c.ac.abort();
    if (c.phase === "recording") c.stopping = recorder.cancel().catch(logError("Cancelling the command recording failed"));
    drop(c);
  }

  function fail(c, e) {
    if (cur !== c) return;
    if (c.ac.signal.aborted) return drop(c);
    const short = e?.shortMessage || t("voice.command.error.title");
    const detail = e?.longMessage || e?.message || String(e);
    console.error("Voice command failed:", detail);
    if (c.transcript) record(c, "Failed", { outcome: "failed", note: detail, short });
    else Promise.resolve(c.stopping).finally(() => store.removeAudio(c.id));
    if (!end(c)) return;
    panel.show("error", { title: short, detail, canRetry: false });
  }

  // ---------- History ----------
  function record(c, status, { outcome, note = "", short } = {}) {
    const s = c.s;
    try {
      store.create("Command", {
        Id: c.id, CreatedAt: store.stamp(c.createdAt), CompletedAt: store.stamp(new Date(now())),
        DurationSeconds: c.audio?.seconds || 0, Provider: s.provider, Model: s.models?.[s.provider] || defaultModelFor(s.provider),
        Language: s.language || "auto", Status: status, AttemptCount: 1, ResultText: c.transcript, Mode: "verbatim",
        LastErrorShort: status === "Failed" ? short || t("voice.command.error.title") : null, LastError: status === "Failed" ? note : null,
        Command: { action: "orchestrate", kind: "sent", summary: t("voice.command.sent"), outcome, note: note || null }
      });
      if (c.audio?.bytes) store.setAudio(c.id, c.audio.bytes);
      deps.addRecord(c.id);
    } catch (e) { console.error("Could not save the command to History:", e); }
  }

  // ---------- panel buttons ----------
  function onAction(a) {
    if (!cur) return;
    if (a.type === "finish") finish();
    else if (a.type === "cancel") cancel();
  }

  return {
    start, finish, cancel, onAction,
    // The menu's microphone: start, finish speaking, or stop a command not sent yet.
    toggle() {
      if (!cur) return start("menu");
      if (cur.phase === "recording") finish();
      else cancel();
      return { ok: true };
    },
    // The edge hotkey let go: only a command it started (one cancelled meanwhile, or started by click, stays as is).
    released() { if (cur?.source === "hold") finish(); },
    // The dictation key: finishes what the menu's microphone started, stops anything else.
    dictateKey() { if (cur?.source === "menu" && cur.phase === "recording") finish(); else cancel(); },
    state: () => ({ enabled: enabled(), state: !cur ? "idle" : cur.phase === "recording" ? "recording" : "working" }),
    settingsChanged: () => report(cur ? (cur.phase === "recording" ? "recording" : "working") : "idle"),
    get active() { return Boolean(cur); },
    dispose() {
      disposed = true;
      const c = cur;
      if (!c) return;
      c.ac.abort();
      cur = null;
    }
  };
}

module.exports = { createCommandRunner, LIMIT_SECONDS };
