// Read-aloud: text -> Gemini speech, streamed into the panel's player (overlay.player). Port of VoiceTray's
// ReadAloudService and SpeechService; capturing the selection is the caller's job (selection.js).
//
// One reading at a time: a new one replaces the last. Streaming synthesis runs at ~1.6x real time, which keeps up
// with 1x playback but not 2x, so the next chunk is always requested while the current one plays (two in flight).
//
// events: "state" {phase: "preparing" | "playing" | "paused" | "idle", title, speed, truncated}
//         "done"  {id, createdAt, completedAt, text, provider, model, voice, wavBuffer, durationMs, completed}
//                 - once per heard reading, for history: with the audio when synthesis finished (playback may still
//                 be running), text only (wavBuffer null) when it was stopped or cut off before that
//         "error" (VoiceError, text) - synthesis or audio output failed; `text` is what Retry should read again
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const gemini = require("./providers/gemini");
const { VoiceError, classify, configuration } = require("./errors");
const { pcmToWav } = require("./wav");
const { DEFAULT_SPEECH_MODEL, DEFAULT_VOICE } = require("./catalog");
const { t } = require("../i18n");

const PROVIDER = "Gemini";

// A cost guard: Ctrl+A on a long page would otherwise send the whole thing to a paid API. About ten minutes of speech.
const MAX_CHARACTERS = 10_000;
// About a minute and a half of speech - small enough to retry cheaply.
const CHUNK_CHARACTERS = 1_500;
const LOOKAHEAD = 1; // chunks requested beyond the one being delivered
const SAMPLE_RATE = gemini.SPEECH_SAMPLE_RATE;
// Enough audio in hand to absorb the jitter between streamed pieces; starting on the first piece tends to stutter.
const START_BUFFER_MS = 750;
const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;

const clampSpeed = x => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(x) || 1));

// Collapses the whitespace copied web pages and PDFs are full of, but keeps line breaks: a heading has no full stop,
// and without its line break it would run on into the paragraph below as one endless sentence.
function normalise(text) {
  return String(text ?? "")
    .replace(/\r\n|[\r\n\f\u0085\u{2028}\u{2029}]/gu, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function lastSentenceEnd(text) {
  for (let i = text.length - 1; i > 0; i--) {
    if (".!?…".includes(text[i]) && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i + 1;
  }
  return -1;
}

// Trims a passage to MAX_CHARACTERS, cutting at a sentence end where one is close enough. Only a generous prefix is
// normalised: a huge selection (Ctrl+A in a big document) would otherwise spend seconds in the regexes first.
function limitText(text, max = MAX_CHARACTERS) {
  const raw = String(text ?? "");
  const long = raw.length > 2 * max;
  const clean = normalise(long ? raw.slice(0, 2 * max) : raw);
  if (clean.length <= max) return { text: clean, truncated: long };
  const window = clean.slice(0, max);
  const cut = lastSentenceEnd(window);
  return { text: (cut > max / 2 ? window.slice(0, cut) : window).trimEnd(), truncated: true };
}

function* splitAtWhitespace(text, maxChars) {
  let start = 0;
  while (start < text.length) {
    let length = Math.min(maxChars, text.length - start);
    if (start + length < text.length) {
      const space = text.lastIndexOf(" ", start + length - 1);
      if (space > start) length = space - start;
    }
    const part = text.substr(start, length).trim();
    if (part) yield part;
    start += Math.max(1, length);
  }
}

// Packs whole sentences into chunks of at most maxChars; a longer "sentence" (a list with no full stops) is split
// at whitespace. Splits after sentence punctuation (kept with its sentence) or at a line break.
function splitIntoChunks(text, maxChars = CHUNK_CHARACTERS) {
  const chunks = [];
  let current = "";
  const flush = () => { if (current) { chunks.push(current); current = ""; } };
  for (const sentence of normalise(text).split(/(?<=[.!?…])\s+|\n/)) {
    const piece = sentence.trim();
    if (!piece) continue;
    if (piece.length > maxChars) {
      flush();
      for (const part of splitAtWhitespace(piece, maxChars)) chunks.push(part);
      continue;
    }
    if (current.length + piece.length + 1 > maxChars) flush();
    current = current ? `${current} ${piece}` : piece;
  }
  flush();
  return chunks;
}

// Starts consuming a chunk's stream at once, so it downloads while the previous chunk plays; errors are kept and
// rethrown when the reader gets there, exactly where they would have surfaced without the lookahead.
function pump(iterable) {
  const items = [];
  let done = false;
  let error = null;
  let wake = null;
  (async () => {
    try { for await (const pcm of iterable) { items.push(pcm); wake?.(); } } catch (e) { error = e; }
    done = true;
    wake?.();
  })();
  return (async function* () {
    for (;;) {
      if (items.length) { yield items.shift(); continue; }
      if (error) throw error;
      if (done) return;
      await new Promise(r => { wake = r; });
      wake = null;
    }
  })();
}

// The passage as one continuous PCM stream, in order, with LOOKAHEAD chunks requested ahead of the one being read.
async function* streamSpeech({ text, model, voice, apiKey, signal, chunkChars, speak }) {
  const chunks = splitIntoChunks(text, chunkChars);
  const pumps = [];
  const startNext = () => {
    if (pumps.length < chunks.length) pumps.push(pump(speak({ text: chunks[pumps.length], model, voice, apiKey, signal })));
  };
  for (let i = 0; i <= LOOKAHEAD; i++) startNext();
  for (let i = 0; i < chunks.length; i++) {
    yield* pumps[i];
    startNext();
  }
}

const titleOf = text => (text.length <= 60 ? text : `${text.slice(0, 60).trimEnd()}…`);

// overlay: createOverlay() result (its `player` plays the audio). getSettings() -> voice settings (readAloudModel,
// readAloudVoice, readAloudSpeed). getApiKey(provider) -> key (may be async). saveSettings(patch), optional, remembers
// the speed. `speak` and `chunkChars` are there for tests.
function createReadAloud({ overlay, getSettings = () => ({}), getApiKey, saveSettings, speak = gemini.speak, chunkChars = CHUNK_CHARACTERS } = {}) {
  const emitter = new EventEmitter();
  let session = null;
  let phase = "idle";
  let speed = clampSpeed(getSettings()?.readAloudSpeed ?? 1);

  const info = () => ({ phase, title: session?.title ?? null, speed, truncated: Boolean(session?.truncated) });
  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    emitter.emit("state", info());
  }

  // Files the reading once: with its audio if synthesis finished, otherwise the text alone (Re-read can redo it).
  function saveRecord(s) {
    if (s.saved) return;
    s.saved = true;
    const wavBuffer = s.synthesisCompleted ? pcmToWav(s.chunks, SAMPLE_RATE) : null;
    emitter.emit("done", {
      id: s.id, createdAt: s.createdAt, completedAt: new Date(), text: s.text, provider: PROVIDER, model: s.model, voice: s.voice,
      wavBuffer, durationMs: wavBuffer ? Math.round((s.bytes / 2 / SAMPLE_RATE) * 1000) : 0, completed: s.synthesisCompleted
    });
  }

  async function synthesise(s) {
    try {
      const apiKey = String((await getApiKey(PROVIDER)) || "").trim();
      if (!apiKey) throw configuration(t("voice.errors.noApiKey", { provider: PROVIDER }));
      if (s.ac.signal.aborted) return;
      for await (const pcm of streamSpeech({ text: s.text, model: s.model, voice: s.voice, apiKey, signal: s.ac.signal, chunkChars, speak })) {
        if (session !== s) return;
        s.chunks.push(pcm);
        s.bytes += pcm.length;
        overlay.player.push(s.id, pcm);
      }
      if (session !== s) return;
      overlay.player.end(s.id); // a passage shorter than the start buffer starts playing now
      s.synthesisCompleted = true;
      saveRecord(s);
    } catch (e) {
      // Stopped by the user or replaced by a new reading: not a failure.
      if (s.ac.signal.aborted || session !== s) return;
      fail(s, classify({ error: e, provider: PROVIDER, signal: s.ac.signal }));
    }
  }

  function fail(s, error) {
    if (session !== s) return;
    session = null;
    s.ac.abort();
    overlay.player.stop(s.id);
    setPhase("idle");
    emitter.emit("error", error, s.text);
  }

  overlay.on("player", ev => {
    const s = session;
    if (!s || ev.id !== s.id) return;
    if (ev.type === "started") {
      s.playbackStarted = true;
      setPhase("playing");
    } else if (ev.type === "ended") {
      // The player pads with silence until told the audio is complete, so this is the real end.
      session = null;
      overlay.player.stop(s.id);
      setPhase("idle");
    } else if (ev.type === "error") {
      if (!s.playbackStarted) {
        fail(s, new VoiceError("Unknown", t("voice.errors.audioOutput.short"),
          t("voice.errors.audioOutput.long", { error: ev.message || t("voice.errors.unknownReason") }), { retryable: true }));
        return;
      }
      // Ended while still loading: the output went away, not the reading finishing. What was heard is kept.
      session = null;
      s.ac.abort();
      saveRecord(s);
      setPhase("idle");
    }
  });

  // Reads `raw` (selection, Re-read from history, Retry). Replaces any reading in progress. false = nothing to read.
  function start(raw) {
    stop();
    const { text, truncated } = limitText(raw);
    if (!text) return false;
    const settings = getSettings() || {};
    speed = clampSpeed(settings.readAloudSpeed ?? speed);
    const s = {
      id: crypto.randomUUID().replace(/-/g, ""), createdAt: new Date(), text, truncated, title: titleOf(text),
      model: String(settings.readAloudModel || "").trim() || DEFAULT_SPEECH_MODEL,
      voice: String(settings.readAloudVoice || "").trim() || DEFAULT_VOICE,
      ac: new AbortController(), chunks: [], bytes: 0, playbackStarted: false, synthesisCompleted: false, saved: false
    };
    session = s;
    setPhase("preparing");
    overlay.player.begin({ id: s.id, sampleRate: SAMPLE_RATE, speed, startBufferMs: START_BUFFER_MS });
    synthesise(s);
    return true;
  }

  // Stops everything now; safe in any phase. Something was heard, so it belongs in history even if unfinished.
  function stop() {
    const s = session;
    session = null;
    if (s) {
      s.ac.abort();
      if (s.playbackStarted) saveRecord(s);
      overlay.player.stop(s.id);
    }
    setPhase("idle");
  }

  function pause() {
    if (phase !== "playing" || !session) return;
    overlay.player.pause(session.id);
    setPhase("paused");
  }

  function resume() {
    if (phase !== "paused" || !session) return;
    overlay.player.resume(session.id);
    setPhase("playing");
  }

  // Live, without moving the pitch; remembered for the next reading.
  function setSpeed(x) {
    speed = clampSpeed(x);
    if (session) overlay.player.setSpeed(session.id, speed);
    if (Math.abs((Number(getSettings()?.readAloudSpeed) || 1) - speed) >= 0.001) saveSettings?.({ readAloudSpeed: speed });
  }

  return Object.assign(emitter, {
    start, stop, pause, resume, setSpeed,
    togglePause: () => (phase === "playing" ? pause() : resume()),
    isActive: () => phase !== "idle"
  });
}

module.exports = { createReadAloud, limitText, splitIntoChunks, normalise, MAX_CHARACTERS, CHUNK_CHARACTERS };
