// Owns every dictation from the moment its recording stops: the attempt, the delivery, and afterwards its place in
// history. Port of VoiceTray's TranscriptionQueue. A single worker on purpose: exactly one transcription and one
// delivery in flight, in order. Nothing retries on its own - a failure parks and waits for the user.
//
// Every change is announced as a "job" event: {type, id, job, outcome?}, `job` being the record as stored now (null
// once removed). Types: queued, started, ready, delivering, completed (outcome Injected|ClipboardOnly), empty,
// failed, requeued (cancelled attempt put back), retry, removed, added, pruned.
const { EventEmitter } = require("node:events");
const { classify } = require("./errors");
const { defaultModelFor } = require("./catalog");
const { sleep, hhmm } = require("./util");
const { t } = require("../i18n");

const IN_FLIGHT = new Set(["Transcribing", "Delivering"]);

// What a recording is transcribed with: the settings in force when it was made.
const jobSettings = s => ({ Provider: s.provider, Model: s.models?.[s.provider] || defaultModelFor(s.provider), Language: s.language || "auto" });

function createQueue(deps = {}) {
  const store = deps.store || require("./job-store");
  const transcribe = deps.transcribe || ((...a) => require("./transcription").transcribeJob(...a));
  const deliver = deps.deliver || ((...a) => require("./delivery").deliver(...a));
  // Through delivery's lock, never straight to the clipboard: a selection being copied for read-aloud borrows it too.
  const toClipboard = deps.toClipboard || (async text => (await require("./delivery").deliverToClipboard(text)).outcome !== "Failed");
  const getSettings = deps.getSettings || (() => require("./settings").load());
  const notify = deps.notify || (() => {});

  const q = new EventEmitter();
  // Where each job's first delivery goes. In memory only, and dropped the moment a job fails or is retried: a retry
  // minutes later must never type into a stale window.
  const targets = new Map();
  const waiting = [];
  let worker = null;
  let stopped = false;
  let attempt = null; // AbortController of the running transcription
  let recording = false;
  let gate = []; // resolvers waiting for the recording to end

  // Each listener on its own: one that throws must not skip the others, fail a healthy job or stop the worker.
  function announce(ev) {
    for (const fn of q.rawListeners("job")) {
      try { fn(ev); } catch (e) { console.error("A voice job listener failed:", e); }
    }
  }
  const emit = (type, id, extra) => announce({ type, id, job: store.get(id), ...extra });
  const safeNotify = n => { try { notify(n); } catch (e) { console.error("Voice notification failed:", e); } };

  function push(id) {
    if (stopped) return;
    if (!waiting.includes(id)) waiting.push(id);
    // Started on a microtask so the caller's own event (queued/retry) is announced before "started".
    if (!worker) worker = Promise.resolve().then(run).finally(() => { worker = null; });
  }

  async function run() {
    while (!stopped && waiting.length) {
      const id = waiting.shift();
      try { await processJob(id); } catch (e) {
        // A bug or a disk error must not leave the record stuck "in flight" or kill the worker.
        const job = store.get(id);
        if (job && IN_FLIGHT.has(job.Status)) fail(id, t("voice.errors.unexpected.short"), String(e?.message || e), null, true);
      }
    }
  }

  async function processJob(id) {
    const job = store.get(id);
    // A read-aloud record already has its text and would fall straight through to delivery, typing it into the
    // focused window. It can only get here through a bug, and this is where it must stop.
    if (!job || job.Kind === "ReadAloud" || job.Status === "Abandoned" || job.Status === "Done" || job.Status === "Failed") return;
    if (!job.ResultText && !(await transcribeStep(id))) return;
    const ready = store.get(id);
    if (!ready) return;
    if (!ready.ResultText) {
      // Silence, or a safety-blocked reply. Nothing to deliver.
      complete(id);
      emit("empty", id);
      safeNotify({ type: "empty", job: store.get(id), message: t("voice.notice.noSpeech") });
      return;
    }
    await deliverStep(id);
  }

  async function transcribeStep(id) {
    const before = store.get(id);
    const job = store.update(id, { Status: "Transcribing", AttemptCount: (before.AttemptCount || 0) + 1 });
    emit("started", id);
    const ac = attempt = new AbortController();
    try {
      const text = await transcribe(job, getSettings(), { signal: ac.signal });
      store.update(id, { ResultText: String(text ?? "").trim(), LastError: null, LastErrorShort: null,
        LastStatusCode: null, LastErrorTransient: false, Status: "ReadyForDelivery" });
      emit("ready", id);
      return true;
    } catch (error) {
      let e = error;
      if (!e?.shortMessage) { try { e = classify({ error, provider: job.Provider, signal: ac.signal }); } catch {} }
      if (ac.signal.aborted || e?.kind === "Cancelled") {
        // Not a failure - we asked it to stop. Put it back untouched so the next launch offers it.
        const cur = store.get(id);
        if (cur) store.update(id, { Status: "Pending", AttemptCount: Math.max(0, (cur.AttemptCount || 1) - 1) });
        emit("requeued", id);
        return false;
      }
      fail(id, e?.shortMessage || t("voice.errors.failed"), e?.longMessage || e?.message || String(e), e?.status ?? null, Boolean(e?.retryable));
      return false;
    } finally {
      if (attempt === ac) attempt = null;
    }
  }

  // Never type into a window that is being dictated into: delivery waits for the recording to end.
  const gateOpen = () => (recording && !stopped ? new Promise(r => gate.push(r)) : Promise.resolve(!stopped));

  async function deliverStep(id) {
    const open = await gateOpen();
    const job = store.get(id);
    // Discarded (or re-transcribed) while it waited.
    if (!job || job.Status !== "ReadyForDelivery") return;
    if (!open) return; // shutting down: the text stays, the next launch offers it again
    const target = targets.get(id);
    store.update(id, { Status: "Delivering" });
    emit("delivering", id);
    let outcome;
    try {
      // A retry (no target) is only ever offered through the clipboard, never typed.
      outcome = target
        ? (await deliver(job.ResultText, target, { useClipboard: getSettings().useClipboardPaste !== false }))?.outcome ?? "Failed"
        : (await toClipboard(job.ResultText)) ? "ClipboardOnly" : "Failed";
    } catch (e) {
      fail(id, t("voice.errors.paste.short"), String(e?.message || e), null, true);
      return;
    }
    if (outcome === "Failed") {
      fail(id, t("voice.errors.clipboardBusy.short"), t("voice.errors.clipboardBusy.long"), null, true);
      return;
    }
    complete(id);
    emit("completed", id, { outcome });
    if (outcome === "ClipboardOnly") {
      safeNotify({ type: "clipboard", job: store.get(id),
        message: t("voice.balloon.clipboardReady", { time: hhmm(job.CreatedAt) }) });
    }
  }

  // Finishes a record and keeps it: the transcript, and until retention trims it the audio, stay in history.
  function complete(id) {
    targets.delete(id);
    store.update(id, { Status: "Done", CompletedAt: store.stamp(), LastError: null, LastErrorShort: null });
    prune();
  }

  function fail(id, shortMessage, message, status, transient) {
    // The window it came from is no longer a safe destination.
    targets.delete(id);
    store.update(id, { Status: "Failed", LastErrorShort: shortMessage, LastError: message,
      LastStatusCode: status, LastErrorTransient: transient });
    emit("failed", id);
    prune(); // the runaway guard on failures
  }

  // Once per record that settles (completed, failed, or a reading filed).
  function prune() {
    const { removed } = store.applyRetention();
    for (const id of removed) {
      targets.delete(id);
      const i = waiting.indexOf(id);
      if (i >= 0) waiting.splice(i, 1);
    }
    if (removed.length) announce({ type: "pruned", id: null, job: null, removed });
  }

  // A freshly recorded dictation. `recordedWith` (jobSettings() taken when the recording started) fixes provider,
  // model and language, so neither a switch mid-recording nor a retry hours later changes them; the API key is not
  // part of it - it is read at attempt time, so a corrected key is picked up. `audioBytes`: the WAV's size.
  q.enqueue = (id, { deliverTo = null, durationSeconds, audioBytes, recordedWith = jobSettings(getSettings()) } = {}) => {
    const meta = { ...recordedWith, Status: "Pending" };
    if (Number.isFinite(durationSeconds)) meta.DurationSeconds = durationSeconds;
    if (audioBytes > 0) store.setAudio(id, audioBytes);
    const job = store.get(id) ? store.update(id, meta) : store.create("Dictation", { Id: id, ...meta });
    if (deliverTo) targets.set(id, deliverTo);
    push(id);
    emit("queued", id);
    return job;
  };

  // A finished record that did not come through the queue (a read-aloud, created with store.create("ReadAloud")):
  // announced and pruned like the rest, deliberately never queued - see processJob().
  q.addRecord = id => {
    prune();
    emit("added", id);
  };

  // Tries a failed recording again exactly as recorded - same provider and model.
  q.retry = id => {
    const job = store.get(id);
    if (!job || job.Status !== "Failed" || job.Kind === "ReadAloud") return false;
    targets.delete(id);
    store.update(id, { Status: job.ResultText ? "ReadyForDelivery" : "Pending" });
    push(id);
    emit("retry", id);
    return true;
  };

  q.failures = () => store.list({ status: "Failed", kind: "Dictation" });
  q.retryAll = () => q.failures().filter(j => q.retry(j.Id)).length;

  // Transcribes an existing recording again under the settings in force now. Needs the audio.
  q.retranscribe = id => {
    const job = store.get(id);
    if (!job || job.Kind === "ReadAloud" || IN_FLIGHT.has(job.Status) || !store.hasAudio(job)) return false;
    targets.delete(id);
    store.update(id, { ...jobSettings(getSettings()), ResultText: null, CompletedAt: null, Status: "Pending" });
    push(id);
    emit("retry", id);
    return true;
  };

  // Deletes one record outright - transcript and audio. Not while it is being worked on.
  q.discard = id => {
    const job = store.get(id);
    if (!job || IN_FLIGHT.has(job.Status)) return false;
    targets.delete(id);
    const i = waiting.indexOf(id);
    if (i >= 0) waiting.splice(i, 1);
    store.remove(id);
    announce({ type: "removed", id, job: null });
    return true;
  };

  q.discardAll = () => q.failures().filter(j => q.discard(j.Id)).length;
  q.clearHistory = () => store.list().filter(j => q.discard(j.Id)).length;

  // true while a recording is in progress: finished transcripts wait instead of being typed into that window.
  q.setRecording = on => {
    recording = Boolean(on);
    if (!recording) { const g = gate; gate = []; for (const r of g) r(true); }
  };

  // Shutdown: abandons the current attempt (it goes back to Pending) and waits up to 2 s for the worker.
  q.stop = async () => {
    stopped = true;
    attempt?.abort();
    const g = gate; gate = [];
    for (const r of g) r(false);
    if (worker) await Promise.race([worker, sleep(2000)]);
  };

  return q;
}

module.exports = { createQueue, jobSettings };
