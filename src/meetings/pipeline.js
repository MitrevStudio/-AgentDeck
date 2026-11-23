// From a recorded meeting to transcript.md and summary.md: the jobs, their states in the store, cancel and resume.
// Nothing starts by itself and nothing goes to a provider other than the one chosen. What is chosen is fixed when a
// job starts; another model is a run of its own, the same one again only sends what has no answer yet.
//
//   createPipeline({ store, workDir, openAudio, getSettings, getApiKey, wait })
//     store: store.js; workDir: <userData>/meetings-work; getSettings, getApiKey: the voice settings' by default;
//     openAudio(project, meeting, { signal }) -> { mic, system, cleanup }: two files of mono PCM (pcm.js) on one
//     clock, either of them null; wait(ms, signal): for tests.
//   start(project, id, { transcription, summary, languages, again }): the transcript, then the summary.
//     transcription, summary: { provider, model }, either part left to the settings; languages: ["bg", "en"], []
//     (the default) detects; again: pay for a new run of the same models.
//   retry(project, id): start as it was chosen last - after a failure, a crash or a cancel. The same models, never
//     their successors: one past its stop date is refused (meetingsModelRetired), as another model is a new run.
//   summarize(project, id, { summary, again }): the summary alone.
//     All three resolve with the meeting once done, cancelled included (meeting.error may still warn:
//     meetingsPartsFailed, meetingsNoSpeech), and reject with a HostError (errors.js) once failed.
//     A meeting that is being recorded is refused (meetingsStillRecording) and recover() leaves it to the recorder.
//   removeScreen(project, id, file): the screenshot and its links in the documents; refused while a job runs.
//   cancel(project, id), active(), recover(project), forget(project, id), stop(), estimate(meeting, choices).
//   on("job", event): { type, project, id } and, by type:
//     started; progress { step: audio|transcription|summary, done, total }; retrying { step, waitMs, kind };
//     finished { meeting }; cancelled { meeting }; failed { meeting, code, step, detail }.
const path = require("node:path");
const { EventEmitter } = require("node:events");
const atomic = require("../shared/atomic-file");
const { isObj, normPath } = require("../shared/util");
const { HostError } = require("../host/errors");
const { resolveTask, currentModel } = require("../voice/catalog");
const { LANGUAGE_NAMES } = require("../voice/providers/gemini");
const i18n = require("../i18n");
const { fail } = require("./errors");
const { problem } = require("./problems");
const { digest, createWork } = require("./work");
const { createCaller, createTranscriber, suitable } = require("./providers");
const { transcribe } = require("./transcription");
const { renderTranscript, strikeScreenLink, heading } = require("./transcript");
const summaries = require("./summary");
const { estimateMeeting } = require("./estimate");

const RUN_VERSION = 1; // raised when parts would be cut or asked for differently
const STOP_WAIT_MS = 5000;
const LINKING = ["transcript.md", "summary.md"]; // the documents with links to screenshots

// Where a meeting rests when nothing runs, whatever just happened to it.
const restingState = (meeting, otherwise = "failed") => (meeting.summary ? "ready" : meeting.transcription ? "transcribed" : otherwise);

function createPipeline({
  store, workDir, openAudio, wait,
  getSettings = () => require("../voice/settings").load(),
  getApiKey = provider => require("../voice/settings").getApiKey(provider)
}) {
  const pipeline = new EventEmitter();
  const jobs = new Set();
  let closed = false;

  function announce(event) {
    for (const fn of pipeline.rawListeners("job")) {
      try { fn(event); } catch (error) { console.error("A meeting job listener failed:", error); }
    }
  }
  function report(job, event) {
    if (event.step) job.step = event.step;
    if (event.type === "progress") Object.assign(job, { done: event.done, total: event.total });
    announce({ project: job.project, id: job.id, ...event });
  }

  // ---------- choices ----------
  // Once a job: what it chose goes to the provider as it is.
  function choose(task, override, settings) {
    const choice = resolveTask(settings, task, isObj(override) ? override : {});
    const { provider } = suitable(task, choice);
    return { provider, model: choice.model };
  }
  // What a job chose, for its retry; the settings' only when it chose nothing (its work is gone).
  function chosen(task, saved, settings) {
    if (!isObj(saved)) return choose(task, undefined, settings);
    const { provider } = suitable(task, saved);
    if (currentModel(provider, saved.model) !== saved.model) fail("meetingsModelRetired", `${provider} ${saved.model}`);
    return { provider, model: saved.model };
  }
  // Chosen in the Transcribe dialog, detected when nothing is: the dictation's language says nothing of a meeting's.
  function chooseLanguages(languages = []) {
    if (!Array.isArray(languages) || !languages.every(code => Object.hasOwn(LANGUAGE_NAMES, code))) fail("invalidData", "languages");
    return [...new Set(languages)];
  }

  // ---------- the steps ----------
  // Its path, or null when the meeting has no such document.
  async function documentPath(project, id, name) {
    try {
      return await store.filePath(project, id, name);
    } catch (error) {
      if (error.code === "meetingsNotFound") return null;
      throw error;
    }
  }

  async function transcriptionStep(job, saved) {
    const { project, id, work, signal } = job;
    const { transcription: choice, languages } = saved;
    const transcriber = createTranscriber(choice);
    const name = digest(JSON.stringify([RUN_VERSION, choice, languages]));
    const meeting = await store.read(project, id);
    const result = await transcribe({
      work, run: `${name}-${saved.generations[name] || 0}`, transcriber, languages, screens: meeting.screens,
      openAudio: options => openAudio(project, meeting, options),
      getApiKey, signal, wait, report: event => report(job, event)
    });
    signal.throwIfAborted();

    // The same entries again are not written again: the summary's line numbers and answer stay good. The screenshots
    // are not part of that: a deleted one is struck out where it stands (removeScreen).
    const entriesDigest = digest(JSON.stringify([choice, result.entries.filter(e => e.type !== "screen")]));
    if (meeting.transcription?.digest === entriesDigest && await documentPath(project, id, "transcript.md")) return result;

    const durationMs = meeting.durationMs ?? result.durationMs, approximate = transcriber.grain !== "word";
    // By the file: a crash after it was written leaves meeting.json without its summary.
    if (await documentPath(project, id, "summary.md")) {
      // Its line numbers are about to be wrong, and the store keeps no way to take a document away.
      await store.write(project, id, "summary.md", `# ${heading(meeting).title}\n\n${i18n.t("meetings.doc.stale")}\n`);
    }
    if (meeting.transcription || meeting.summary) {
      // Before the file changes: after a crash in between no run may take it for its own.
      const before = meeting.transcription && { ...meeting.transcription, digest: null };
      await store.update(project, id, { transcription: before, summary: null, brief: "" });
    }
    await store.write(project, id, "transcript.md", renderTranscript({ ...meeting, durationMs }, result.entries, { approximate }));
    await store.update(project, id, {
      durationMs,
      transcription: {
        ...choice, languages, approximate, createdAt: new Date().toISOString(),
        parts: result.parts, failed: result.failed,
        marked: result.entries.filter(e => e.type === "note" || e.doubt).length,
        echoes: result.entries.filter(e => e.echo).length,
        digest: entriesDigest
      }
    });
    return result;
  }

  // -> a warning's code, or null.
  async function summaryStep(job, saved) {
    const { project, id, work, signal } = job, choice = saved.summary;
    const meeting = await store.read(project, id);
    const transcript = await atomic.readText(await store.filePath(project, id, "transcript.md"));
    if (transcript === null) fail("meetingsNotFound", "transcript.md");
    const language = i18n.language();
    const request = summaries.buildRequest({ meeting, transcript, language, ...choice });
    if (!request) return "meetingsNoSpeech";

    const requestDigest = digest(JSON.stringify([choice, saved.summaryGeneration, request.system, request.text]));
    // As with the transcript: the same is not written again, which would also undo what removeScreen struck out.
    if (meeting.summary?.request === requestDigest && await documentPath(project, id, "summary.md")) return null;
    report(job, { type: "progress", step: "summary", done: 0, total: 1 });
    const name = `summary/${requestDigest}.json`;
    let answer = await work.readText(name);
    if (answer === null) {
      const call = createCaller({
        provider: choice.provider, signal, wait, timeoutMs: summaries.TIMEOUT_MS,
        onRetry: info => report(job, { type: "retrying", step: "summary", ...info })
      });
      answer = await call(attempt => summaries.askSummary({ ...choice, ...request, getApiKey, signal: attempt }));
      await work.writeText(name, answer);
    }
    const data = summaries.parseAnswer(answer);
    if (!data) {
      await work.setAside(name);
      fail("meetingsSummaryInvalid");
    }
    signal.throwIfAborted();
    const { markdown, brief, unverified } = summaries.compose(meeting, data, request.lines);
    await store.write(project, id, "summary.md", markdown);
    await store.update(project, id, { brief, summary: { ...choice, language, unverified, request: requestDigest, createdAt: new Date().toISOString() } });
    report(job, { type: "progress", step: "summary", done: 1, total: 1 });
    return null;
  }

  // ---------- jobs ----------
  async function keyOf(project, id) {
    return normPath(path.join((await store.resolve(project)).dir, String(id)));
  }
  async function loadJob(work) {
    const job = await work.read("job.json");
    return { generations: {}, summaryGeneration: 0, ...(isObj(job) && job) };
  }

  // fn(job) as the only one at this meeting. editing: a short change of its files, which what comes after waits for;
  // while a job runs whatever else comes is refused.
  async function exclusive(project, id, fn, { editing = false } = {}) {
    if (closed) fail("meetingsInterrupted");
    const others = [...jobs], abort = new AbortController();
    let settle;
    const job = {
      project, id, editing, abort, signal: abort.signal, step: null, done: 0, total: 0, key: null,
      keyed: keyOf(project, id), finished: new Promise(resolve => { settle = resolve; })
    };
    jobs.add(job);
    try {
      job.key = await job.keyed;
      for (const other of others) {
        if (!jobs.has(other) || await other.keyed.catch(() => null) !== job.key) continue;
        if (other.editing) await other.finished;
        else fail("meetingsBusy");
      }
      return await fn(job);
    } finally {
      jobs.delete(job);
      settle();
    }
  }

  // plan(meeting, job) says what will run and may still refuse: until then nothing of the meeting has changed.
  const run = (project, id, plan) => exclusive(project, id, async job => {
    let begun = false;
    try {
      const meeting = await store.read(project, id);
      if (meeting.state === "recording") fail("meetingsStillRecording");
      job.work = createWork(workDir, meeting);
      const steps = await plan(meeting, job);
      job.signal.throwIfAborted();
      begun = true;
      await store.update(project, id, { state: "processing", error: null });
      report(job, { type: "started" });

      let warning = null;
      for (const step of steps) warning = (await step()) ?? warning;
      const done = await store.update(project, id, m => {
        const code = warning || (m.transcription?.failed ? "meetingsPartsFailed" : null);
        return { state: restingState(m), error: code && { code } };
      });
      report(job, { type: "finished", meeting: done });
      return done;
    } catch (error) {
      if (job.signal.aborted) {
        const interrupted = job.signal.reason instanceof HostError;
        const state = m => ({
          state: restingState(m, interrupted ? "failed" : "recorded"),
          error: interrupted ? { code: "meetingsInterrupted" } : null
        });
        const meeting = begun ? await store.update(project, id, state) : await store.read(project, id);
        report(job, { type: "cancelled", meeting });
        return meeting;
      }
      const known = problem(error), step = job.step;
      if (begun) {
        let meeting = null;
        try {
          meeting = await store.update(project, id, m => ({ state: restingState(m), error: { code: known.code, ...(step && { step }) } }));
        } catch (e) {
          console.error("A meeting's failure could not be saved:", e); // recover() finds it still "processing"
        }
        report(job, { type: "failed", meeting, code: known.code, step, detail: known.detail || "" });
      }
      throw known;
    }
  });

  async function start(project, id, options = {}) {
    return run(project, id, async (_meeting, job) => {
      const settings = getSettings(), saved = await loadJob(job.work);
      saved.transcription = choose("meetingTranscription", options.transcription, settings);
      saved.summary = choose("meetingSummary", options.summary, settings);
      saved.languages = chooseLanguages(options.languages);
      if (options.again) {
        const name = digest(JSON.stringify([RUN_VERSION, saved.transcription, saved.languages]));
        saved.generations[name] = (saved.generations[name] || 0) + 1;
        saved.summaryGeneration++;
      }
      await job.work.write("job.json", saved);
      return steps(job, saved);
    });
  }

  async function retry(project, id) {
    return run(project, id, async (meeting, job) => {
      const settings = getSettings(), saved = await loadJob(job.work);
      // Its work is gone (the project moved) and the transcript is whole: a summary does not pay for that again.
      const summaryOnly = !saved.transcription && meeting.transcription && !meeting.transcription.failed;
      if (!summaryOnly) saved.transcription = chosen("meetingTranscription", saved.transcription, settings);
      saved.summary = chosen("meetingSummary", saved.summary, settings);
      saved.languages = chooseLanguages(saved.languages);
      await job.work.write("job.json", saved);
      const all = steps(job, saved);
      return summaryOnly ? all.slice(1) : all;
    });
  }

  function steps(job, saved) {
    const transcript = async () => {
      job.step = "transcription";
      const { stopped } = await transcriptionStep(job, saved);
      // What stopped the parts would stop the summary too, and the transcript is not whole yet.
      if (stopped) throw stopped;
    };
    return [transcript, () => { job.step = "summary"; return summaryStep(job, saved); }];
  }

  async function summarize(project, id, options = {}) {
    return run(project, id, async (meeting, job) => {
      if (!meeting.transcription) fail("meetingsNoTranscript");
      const saved = await loadJob(job.work);
      saved.summary = choose("meetingSummary", options.summary, getSettings());
      if (options.again) saved.summaryGeneration++;
      await job.work.write("job.json", saved);
      return [() => { job.step = "summary"; return summaryStep(job, saved); }];
    });
  }

  // The screenshot goes, then its links: struck out in place, so every line keeps its number and a resume finds the
  // same documents and pays for nothing. Asked again after a failure, it finishes what is left.
  function removeScreen(project, id, file) {
    return exclusive(project, id, async () => {
      try {
        const meeting = await store.removeScreen(project, id, file);
        for (const name of LINKING) {
          const document = await documentPath(project, id, name);
          const text = document && await atomic.readText(document);
          if (!text) continue;
          const struck = strikeScreenLink(text, file);
          if (struck !== text) await store.write(project, id, name, struck);
        }
        return meeting;
      } catch (error) {
        throw problem(error);
      }
    }, { editing: true });
  }

  // Resolves once it has stopped; false when nothing ran. What was answered stays for retry().
  async function cancel(project, id) {
    const running = [...jobs], key = await keyOf(project, id);
    let found = false;
    for (const job of running) {
      if (await job.keyed.catch(() => null) !== key) continue;
      found ||= !job.editing;
      job.abort.abort();
      await job.finished;
    }
    return found;
  }

  // After a start of the app: what says "processing" and is not, waits for the user. -> the ids it found.
  async function recover(project) {
    const found = [];
    for (const meeting of await store.list(project)) {
      if (meeting.broken || meeting.state !== "processing") continue;
      const key = await keyOf(project, meeting.id);
      // Asked again inside the store's queue, where a job that has started meanwhile is known. No waiting there.
      await store.update(project, meeting.id, m => {
        const runs = [...jobs].some(job => !job.editing && job.id === meeting.id && (!job.key || job.key === key));
        if (runs || m.state !== "processing") return null;
        found.push(meeting.id);
        return { state: restingState(m), error: { code: "meetingsInterrupted" } };
      });
    }
    return found;
  }

  // Before the meeting is deleted: its work goes with it, the recorder's files there included.
  async function forget(project, id) {
    await cancel(project, id);
    let meeting;
    try {
      meeting = await store.read(project, id);
    } catch (error) {
      // Without its meeting.json a meeting's work cannot be told apart, and it can still be deleted.
      if (error.code === "meetingsBroken" || error.code === "meetingsNotFound") return;
      throw error;
    }
    await createWork(workDir, meeting).remove();
  }

  async function stop() {
    closed = true;
    const running = [...jobs];
    for (const job of running) job.abort.abort(new HostError("meetingsInterrupted"));
    let timer;
    await Promise.race([Promise.all(running.map(job => job.finished)), new Promise(resolve => { timer = setTimeout(resolve, STOP_WAIT_MS); })]);
    clearTimeout(timer);
  }

  function estimate(meeting, choices = {}) {
    const settings = getSettings();
    return estimateMeeting(meeting, {
      transcription: resolveTask(settings, "meetingTranscription", choices.transcription || {}),
      summary: resolveTask(settings, "meetingSummary", choices.summary || {})
    });
  }

  return Object.assign(pipeline, {
    start, retry, summarize, removeScreen, cancel, recover, forget, stop, estimate,
    active: () => [...jobs].filter(job => !job.editing).map(({ project, id, step, done, total }) => ({ project, id, step, done, total }))
  });
}

module.exports = { createPipeline };
