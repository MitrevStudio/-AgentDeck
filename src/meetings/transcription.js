// One run of a meeting through one model: the parts, their answers, the checks, the merged entries. Every answer is
// on disk before it is looked at, so a resume sends only what has none, and the same answers always give the same
// entries. A failed part does not fail the meeting: it is a gap, and the only thing a retry sends again.
const { HostError } = require("../host/errors");
const { VoiceError, configuration } = require("../voice/errors");
const { t } = require("../i18n");
const { fail, MESSAGES } = require("./errors");
const { problem } = require("./problems");
const pcm = require("./pcm");
const { findSpeech } = require("./speech");
const { planChannel, halve } = require("./parts");
const { checkAnswer } = require("./checks");
const { merge } = require("./merge");
const { createCaller } = require("./providers");

const CHANNELS = ["mic", "system"];
// Trying the next part would fail the same way.
const FATAL = new Set(["Auth", "Configuration", "QuotaExhausted", "ModelNotFound"]);
const FAILURES_IN_A_ROW = 3; // with their own retries: the provider or the connection is away
const SAME_LENGTH_MS = 1000; // a decoder's padding, not another recording
const timeoutFor = part => Math.min(10 * 60_000, Math.max(2 * 60_000, 60_000 + 2 * (part.end - part.start)));

// openAudio({ signal }) -> { mic, system, cleanup }; report({ type, ... }): progress for the window.
// -> { entries, parts, failed, durationMs, stopped }: stopped is the error that stopped the asking, if one did.
async function transcribe({ work, run, transcriber, languages, screens, openAudio, getApiKey, signal, wait, report }) {
  const { provider, model, grain } = transcriber;
  let keyPromise = null, audioPromise = null, plan = null;
  let stopped = null, inARow = 0, answered = 0;

  // ---------- what is fetched only when something has to be sent ----------
  let uploaded = new Set();
  const saveUploads = () => work.write("uploads.json", [...uploaded]);
  const uploads = {
    add: name => { uploaded.add(name); return saveUploads(); },
    remove: name => { uploaded.delete(name); return saveUploads(); }
  };
  async function readKey() {
    const apiKey = String((await getApiKey(provider)) || "").trim();
    if (!apiKey) throw configuration(t("voice.errors.noApiKey", { provider }));
    // What a crash left uploaded.
    const left = transcriber.removeFile ? await work.read("uploads.json") : null;
    if (Array.isArray(left) && left.length) {
      uploaded = new Set(left);
      for (const name of left) if (await transcriber.removeFile(String(name), apiKey)) await uploads.remove(name);
    }
    return apiKey;
  }
  const key = () => (keyPromise ??= readKey());

  async function readAudio() {
    let opened;
    try {
      opened = await openAudio({ signal });
    } catch (error) {
      if (error instanceof HostError || signal.aborted) throw error;
      fail("meetingsAudioUnreadable", error?.message);
    }
    return opened || {};
  }
  const audio = () => (audioPromise ??= readAudio());
  const lengths = new Map();
  async function sameAudio(channel) {
    const file = (await audio())[channel];
    if (!file) fail("meetingsNoAudio", channel);
    if (!lengths.has(channel)) lengths.set(channel, await pcm.durationMs(file));
    if (Math.abs(lengths.get(channel) - plan.durations[channel]) > SAME_LENGTH_MS) fail("meetingsAudioChanged", channel);
    return file;
  }

  async function makePlan() {
    await key(); // no point in reading two hours without one
    const opened = await audio(), channels = CHANNELS.filter(channel => opened[channel]);
    if (!channels.length) fail("meetingsNoAudio");
    const heard = {}, durations = {};
    for (const [i, channel] of channels.entries()) {
      report({ type: "progress", step: "audio", done: i, total: channels.length });
      const { levels, durationMs } = await pcm.readLevels(opened[channel], { signal });
      durations[channel] = durationMs;
      lengths.set(channel, durationMs);
      heard[channel] = { levels, speech: findSpeech(levels) };
    }
    const parts = channels.flatMap(channel => planChannel({
      channel, ...heard[channel], others: heard[CHANNELS.find(c => c !== channel)]?.speech,
      limits: transcriber.limits, preferTurn: grain === "part"
    }));
    const made = { durations, parts };
    await work.write(`runs/${run}/plan.json`, made);
    return made;
  }

  // ---------- a part ----------
  const nameOf = part => `runs/${run}/parts/${part.channel}-${part.start}-${part.end}.json`;

  // -> { body } or { failed }; throws only what no other part would survive either: cancel, disk, recording.
  async function answerFor(part) {
    const saved = await work.readText(nameOf(part));
    if (saved !== null) { answered++; return { body: saved }; }
    signal.throwIfAborted();
    if (stopped) return { failed: stopped };
    try {
      const apiKey = await key();
      const wav = await pcm.readPart(await sameAudio(part.channel), part);
      const call = createCaller({
        provider, signal, wait, timeoutMs: timeoutFor(part),
        onRetry: info => report({ type: "retrying", step: "transcription", ...info })
      });
      const keep = text => work.writeText(nameOf(part), text);
      const body = await transcriber.ask({ wav, model, languages, apiKey, call, keep, uploads });
      answered++;
      inARow = 0;
      return { body };
    } catch (error) {
      if (signal.aborted || !(error instanceof VoiceError)) throw error;
      inARow++;
      if (FATAL.has(error.kind) || (error.kind === "BadRequest" && !answered) || inARow >= FAILURES_IN_A_ROW) stopped ??= error;
      return { failed: error };
    }
  }

  // An answer as checked, or why there is none.
  async function examine(part) {
    const { body, failed } = await answerFor(part);
    if (failed) return { part, failed };
    const answer = transcriber.read(body, part);
    return { part, readable: answer.readable, ...checkAnswer(answer, part, { grain, languages }) };
  }
  async function unusable(result) {
    if (result.failed) return { part: result.part, failed: result.failed };
    if (result.readable) return result;
    await work.setAside(nameOf(result.part)); // so that a retry asks for it again
    return { part: result.part, failed: new HostError("meetingsBadAnswer", MESSAGES.meetingsBadAnswer) };
  }

  // A doubtful answer that halves can mend is asked again in two halves, once, whatever they bring; then the better is
  // kept, marked. Any other doubt is kept as it came, marked.
  async function settlePart(part) {
    const whole = await examine(part);
    const halves = whole.failed || !whole.halve ? [] : halve(part);
    if (!halves.length) return [await unusable(whole)];
    const second = [];
    for (const half of halves) second.push(await unusable(await examine(half)));
    if (whole.readable) {
      const worse = second.some(r => r.failed) || (whole.spans.length && second.every(r => !r.spans.length));
      if (worse) return [whole];
    }
    return second;
  }

  try {
    plan = await work.read(`runs/${run}/plan.json`);
    if (!Array.isArray(plan?.parts)) plan = await makePlan();

    const { parts } = plan, results = new Array(parts.length);
    let next = 0, done = 0, broken = null;
    report({ type: "progress", step: "transcription", done, total: parts.length });
    await Promise.all(Array.from({ length: Math.min(transcriber.parallel, parts.length) }, async () => {
      while (!broken && next < parts.length) {
        const i = next++;
        try {
          results[i] = await settlePart(parts[i]);
          report({ type: "progress", step: "transcription", done: ++done, total: parts.length });
        } catch (error) {
          broken ??= error; // the others finish what they sent: that is being paid for
        }
      }
    }));
    if (broken) throw broken;

    const all = results.flat(), failures = all.filter(r => r.failed);
    if (all.length && failures.length === all.length) throw stopped || failures[0].failed;
    const entries = merge(all.map(r => (r.failed ? { part: r.part, failed: problem(r.failed).code } : r)), { grain, screens });
    await work.write(`runs/${run}/merged.json`, entries);
    return { entries, parts: all.length, failed: failures.length, durationMs: Math.max(0, ...Object.values(plan.durations)), stopped };
  } finally {
    if (audioPromise) {
      const opened = await audioPromise.catch(() => null);
      try { await opened?.cleanup?.(); } catch (error) { console.error("A meeting's decoded audio was not cleaned up:", error); }
    }
  }
}

module.exports = { transcribe };
