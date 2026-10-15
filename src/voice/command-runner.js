// One voice command at a time, from the microphone to the session (commands.js has the reasoning): recording ->
// recognising -> understanding -> (writing the prompt) -> the card with its countdown, or choices -> running it ->
// a line in History. Esc, Cancel, the dictation key or a new hold stop it at any point before it runs (the dictation
// key and a click on the panel finish a recording that the menu's microphone started).
//
// The controller lends it the recorder, the voice panel (panel.*, so it knows who owns the panel) and the Esc
// hotkey; main lends it the launchers (app.*). Everything is injected, so tests can drive it without Electron.
const { t } = require("../i18n");
const cmd = require("./commands");
const { applyReplacements } = require("./dictionary");
const { defaultModelFor } = require("./catalog");
const { BYTES_PER_SECOND, HEADER_BYTES } = require("./wav");
const { maxRecordingBytes } = require("./transcription");

// deps: recorder, store (job-store), settings, transcribe(opts), generate(opts), rewrite(text, opts), vocabulary(),
// panel {fresh(state, data), show(state, data), update(data), close()}, escape {register(onPress), unregister()},
// busy() (a dictation is recording), stopReading(), addRecord(id), balloon(text, opts),
// app {data(), live(), launchNew(agent, cwd, prompt), launchAgent(agent, id, cwd), focus(opts), showProject(path),
// onState({enabled, state})}, holdLabel() (the edge hotkey as shown), now().
function createCommandRunner(deps) {
  const { recorder, store, settings, panel, app } = deps;
  const now = deps.now || Date.now;
  let cur = null; // {id, phase, source, ac, s, createdAt, transcript, plan, plans, timer, left, since, hovered, audio, stopping}
  let disposed = false;

  const enabled = () => settings.load().commands.enabled;
  const report = state => { try { app.onState?.({ enabled: enabled(), state }); } catch (e) { console.error("Command state:", e); } };
  const logError = what => e => console.error(`${what}:`, e?.message || e);

  // ---------- lifecycle ----------
  // Ends the command (it stays on screen as whatever the panel shows last). False when it was already over.
  function end(c) {
    if (cur !== c) return false;
    cur = null;
    clearTimeout(c.timer);
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
  // is being understood or waits on its card - the user is saying it again; one still recording keeps the microphone.
  function start(source) {
    if (disposed || !enabled()) return { ok: false };
    if (cur) {
      if (source !== "hold" || cur.phase === "running" || cur.phase === "recording") return { ok: false };
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
    panel.fresh("listening", { command: true, hint, cancelKey: "Esc", limitSeconds: cmd.LIMIT_SECONDS });
    recorder.start({
      deviceId: s.microphoneDeviceId, deviceName: s.microphoneName, wavPath: store.wavPath(c.id),
      maxBytes: Math.min(maxRecordingBytes(s), cmd.LIMIT_SECONDS * BYTES_PER_SECOND),
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

  // ---------- understanding ----------
  async function understand(c) {
    const s = c.s, signal = c.ac.signal;
    const terms = deps.vocabulary();
    const raw = await deps.transcribe({ wavPath: store.wavPath(c.id), provider: s.provider, model: s.models?.[s.provider] || defaultModelFor(s.provider),
      language: s.language, vocabulary: terms, getApiKey: settings.getApiKey, signal });
    if (cur !== c) return;
    const transcript = applyReplacements(String(raw ?? ""), s.dictionary?.replacements).trim();
    if (!transcript) {
      drop(c);
      return panel.fresh("notice", { title: t("voice.command.noSpeech"), detail: "" });
    }
    c.transcript = transcript;
    panel.update({ rewriting: "command" });
    const [data, live] = await Promise.all([app.data(), app.live().catch(() => [])]);
    if (cur !== c) return;
    c.agents = Array.isArray(data?.agents) ? data.agents : null;
    const candidates = cmd.buildCandidates({ ...data, live }, transcript);
    const answer = await deps.generate({ system: cmd.INSTRUCTIONS, text: cmd.intentInput(transcript, candidates, now()), provider: s.provider,
      model: cmd.COMMAND_MODELS[s.provider], temperature: 0, signal, timeoutMs: cmd.INTENT_TIMEOUT_MS });
    if (cur !== c) return;
    c.intent = cmd.parseIntent(answer);
    if (!c.intent) console.error("The command answer was not usable JSON; searching instead:", String(answer).slice(0, 200));
    const r = cmd.resolveIntent(c.intent, transcript, candidates, { defaultAgent: s.commands.agent });
    if (r.type === "unknown") return unclear(c);
    if (r.type === "choose") return offer(c, r.plans);
    await prepare(c, r.plan, true);
  }

  // A new session's prompt, written in the chosen mode; a rewrite that fails leaves the task as spoken.
  async function prepare(c, plan, countdown) {
    c.plan = plan;
    if (plan.action === "new_session") {
      if (c.agents && !c.agents.includes(plan.agent)) throw new Error(t("voice.command.error.agentMissing", { agent: plan.agent }));
      const mode = c.s.commands.promptMode;
      if (plan.task && mode !== "verbatim") {
        panel.update({ rewriting: mode });
        try {
          plan.prompt = await deps.rewrite(plan.task, { mode, dictionary: deps.vocabulary(), language: c.s.language, signal: c.ac.signal });
        } catch (e) {
          if (c.ac.signal.aborted) throw e;
          console.error(`Writing the command's prompt (${mode}) failed, using the task as spoken:`, e?.longMessage || e?.message);
          plan.rewriteError = e?.shortMessage || e?.message || String(e);
        }
      }
      plan.prompt ||= plan.task;
      if (cur !== c) return;
    }
    if (countdown) confirm(c);
    else run(c);
  }

  // ---------- the card ----------
  function confirm(c) {
    const seconds = c.s.commands.countdown;
    if (!seconds) return run(c);
    c.phase = "confirm";
    c.left = seconds * 1000;
    c.hovered = false;
    panel.show("confirm", { ...cmd.describe(c.plan), seconds });
    arm(c);
  }

  function arm(c) {
    clearTimeout(c.timer);
    c.since = now();
    c.timer = setTimeout(() => run(c), c.left);
  }

  // The pointer resting on the card stops the countdown, so a long prompt can be read to the end.
  function hold(on) {
    const c = cur;
    if (!c || c.phase !== "confirm" || on === c.hovered) return;
    c.hovered = on;
    if (on) { clearTimeout(c.timer); c.left = Math.max(0, c.left - (now() - c.since)); }
    else arm(c);
  }

  function offer(c, plans) {
    c.phase = "choices";
    c.plans = plans;
    panel.show("choices", {
      title: t("voice.command.choose.title"), detail: c.transcript,
      choices: plans.map(p => { const d = cmd.describe(p); return { label: d.title, sub: d.kind === "new" || d.kind === "project" ? d.sub : d.detail }; })
    });
    c.timer = setTimeout(cancel, cmd.CHOICE_TIMEOUT_MS);
  }

  // A choice clicked: it runs at once, except a new session whose prompt has not been seen yet.
  function choose(i) {
    const c = cur;
    const plan = c?.phase === "choices" ? c.plans?.[i] : null;
    if (!plan) return;
    clearTimeout(c.timer);
    const needsPrompt = plan.action === "new_session" && plan.task;
    if (needsPrompt) thinking(c);
    prepare(c, plan, needsPrompt).catch(e => fail(c, e));
  }

  function unclear(c) {
    record(c, "Done", { outcome: "unclear" });
    if (!end(c)) return;
    panel.show("notice", { title: t("voice.command.unclear"), detail: t("voice.command.quoted", { text: c.transcript }), durationMs: 5000 });
  }

  // ---------- running ----------
  async function run(c) {
    if (cur !== c || c.phase === "running") return;
    clearTimeout(c.timer);
    c.phase = "running";
    deps.escape.unregister();
    const d = cmd.describe(c.plan);
    let r;
    try { r = await cmd.execute(c.plan, app); } catch (e) { r = { ok: false, outcome: "failed", note: e?.message || String(e) }; }
    record(c, r.ok ? "Done" : "Failed", r);
    if (!end(c)) return;
    if (!r.ok) return panel.show("error", { title: t("voice.command.error.title"), detail: r.note, canRetry: false });
    if (r.note) return panel.show("notice", { title: d.title, detail: r.note, durationMs: 4500 });
    // A terminal coming up, or the menu, says enough; a new or resumed session gets a short "started".
    if (r.outcome === "launched" || r.outcome === "resumed") panel.show("success", { title: t(`voice.command.done.${r.outcome}`), detail: d.label });
    else panel.close();
  }

  // Esc, Cancel, the dictation key, a new hold, a reading started from History. Not once it runs.
  function cancel() {
    const c = cur;
    if (!c || c.phase === "running") return;
    c.ac.abort();
    if (c.phase === "recording") c.stopping = recorder.cancel().catch(logError("Cancelling the command recording failed"));
    if (c.transcript) {
      record(c, "Done", { outcome: "cancelled" });
      end(c);
      panel.close();
    } else drop(c);
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
    const s = c.s, p = c.plan;
    const d = p ? cmd.describe(p) : null;
    try {
      store.create("Command", {
        Id: c.id, CreatedAt: store.stamp(c.createdAt), CompletedAt: store.stamp(new Date(now())),
        DurationSeconds: c.audio?.seconds || 0, Provider: s.provider, Model: s.models?.[s.provider] || defaultModelFor(s.provider),
        Language: s.language || "auto", Status: status, AttemptCount: 1, ResultText: c.transcript, Mode: "verbatim",
        LastErrorShort: status === "Failed" ? short || t("voice.command.error.title") : null, LastError: status === "Failed" ? note : null,
        // kind: how History words it in the language of the moment (summary: as it was said then).
        Command: {
          action: p?.action || "unknown", kind: d?.kind || null, summary: d?.title || "", agent: p?.agent || null,
          project: p?.project?.name || null, path: p?.project?.path || null, session: p?.session ? d.detail : null,
          prompt: p?.prompt || null, rewriteError: p?.rewriteError || null, outcome, note: note || null
        }
      });
      if (c.audio?.bytes) store.setAudio(c.id, c.audio.bytes);
      deps.addRecord(c.id);
    } catch (e) { console.error("Could not save the command to History:", e); }
  }

  // ---------- panel buttons ----------
  function onAction(a) {
    if (!cur) return;
    if (a.type === "run" && cur.phase === "confirm") run(cur);
    else if (a.type === "finish") finish();
    else if (a.type === "cancel") cancel();
    else if (a.type === "choose") choose(Number(a.index));
    else if (a.type === "hold") hold(Boolean(a.on));
  }

  return {
    start, finish, cancel, onAction,
    // The menu's microphone: start, finish speaking, or stop a command that has not run.
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
      clearTimeout(c.timer);
      cur = null;
    }
  };
}

module.exports = { createCommandRunner };
