// The durable home of every recording: the ones still on their way to text and the ones kept as history.
// Port of VoiceTray's JobStore + TranscriptionJob. One sidecar per record ({id}.json beside {id}.wav), in exactly
// the shape VoiceTray writes (PascalCase, enums as strings), so records imported from VoiceTray need no conversion.
// A torn write costs one record instead of the whole list. The in-memory map is the single source for the queue
// and the history page; every change is written through (asynchronously, in order - see atomic-file.js).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const atomic = require("./atomic-file");
const { SAFE_ID } = require("./util");
const { t } = require("../i18n");

const STATUSES = ["Pending", "Transcribing", "ReadyForDelivery", "Delivering", "Failed", "Done", "Abandoned"];
// Command: a voice command (command-runner.js), kept for History only - never transcribed again or delivered.
const KINDS = ["Dictation", "ReadAloud", "Command"];
const IN_FLIGHT = new Set(["Transcribing", "Delivering"]);

// Transcripts outlive their audio: they are kilobytes, audio is megabytes.
const LIMITS = Object.freeze({
  maxRecords: 500,
  recordTtlMs: 90 * 864e5,
  audioTtlMs: 14 * 864e5,
  maxAudioBytes: 1024 ** 3,
  // Failures are never pruned on a timer - the user decides. This only guards someone who never looks.
  maxFailed: 50
});

// Property order as VoiceTray serializes TranscriptionJob, then AgentDeck's own: the dictation mode, the transcript
// as recognised when the delivered text differs from it, why a rewrite fell back to that transcript, and for a voice
// command what it was taken to mean and how it ended ({action, summary, agent, project, path, session, prompt,
// rewriteError, outcome, note}).
const FIELDS = ["Id", "Kind", "AudioPath", "CreatedAt", "CompletedAt", "DurationSeconds", "Provider", "Model", "Language",
  "Voice", "Status", "AttemptCount", "LastError", "LastErrorShort", "LastStatusCode", "LastErrorTransient", "ResultText",
  "Mode", "RawText", "RewriteError", "Command", "EditSource"];

let root = null;
let jobs = null; // Map id -> record, loaded by recoverOnStartup()
// Size of each record's audio file. Known here instead of asked of the disk: the history list, its search and
// retention read it on every change. Set when audio is written (or found at startup), dropped when it is removed.
let audio = new Map();

function init(opts = {}) {
  root = opts.dir || null;
  jobs = null;
  audio = new Map();
}

const dir = () => root || path.join(require("electron").app.getPath("userData"), "voice", "records");
const wavPath = id => path.join(dir(), id + ".wav");
const sidecar = id => path.join(dir(), id + ".json");
const newId = () => crypto.randomUUID().replace(/-/g, "");
const time = s => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };
const sizeOf = p => { try { const s = fs.statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; } };
const tryDelete = p => { try { fs.unlinkSync(p); } catch {} }; // startup only; a locked file is swept next time
const hasText = job => Boolean(job && job.ResultText);
const hasAudio = job => Boolean(job && audio.get(job.Id) > 0);
const setAudio = (id, bytes) => { if (bytes > 0) audio.set(id, bytes); else audio.delete(id); };

// DateTimeOffset.Now as .NET writes it: local time with its offset.
function stamp(d = new Date()) {
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  const local = new Date(d.getTime() + off * 6e4).toISOString().slice(0, -1);
  return `${local}${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

const blank = () => ({
  Id: "", Kind: "Dictation", AudioPath: "", CreatedAt: stamp(), CompletedAt: null, DurationSeconds: 0,
  Provider: "", Model: "", Language: "auto", Voice: "", Status: "Pending", AttemptCount: 0,
  LastError: null, LastErrorShort: null, LastStatusCode: null, LastErrorTransient: false, ResultText: null,
  Mode: "verbatim", RawText: null, RewriteError: null
});

function pick(obj) {
  const out = {};
  for (const k of FIELDS) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

// Like System.Text.Json: unknown properties ignored, a missing Kind is Dictation, enums may also be numbers.
function parse(text) {
  const raw = JSON.parse(text.replace(/^﻿/, ""));
  if (!raw || typeof raw !== "object") return null;
  const job = { ...blank(), ...pick(raw) };
  if (typeof job.Status === "number") job.Status = STATUSES[job.Status];
  if (typeof job.Kind === "number") job.Kind = KINDS[job.Kind];
  if (job.Kind == null) job.Kind = "Dictation";
  if (!STATUSES.includes(job.Status) || !KINDS.includes(job.Kind)) return null;
  return job;
}

// Best effort, like VoiceTray: the record stays right in memory either way.
function write(job) {
  atomic.write(sidecar(job.Id), JSON.stringify(pick(job), null, 2))
    .catch(e => console.error(`Could not save voice record ${job.Id}:`, e.message));
}

function filesEnding(ext) {
  try { return fs.readdirSync(dir()).filter(f => f.toLowerCase().endsWith(ext)); } catch { return []; }
}

// Loads everything on disk with crash recovery applied, then settles whatever was unfinished into Failed. Nothing
// is retried automatically: the user may be on another network hours later, and a surprise burst of API calls is
// worse than a badge. Call once at startup (after the import), before the queue gets work.
function recoverOnStartup() {
  try { fs.mkdirSync(dir(), { recursive: true }); } catch {}
  jobs = new Map();
  audio = new Map();
  let waiting = 0;
  for (const name of filesEnding(".json")) {
    const file = path.join(dir(), name);
    let job = null;
    try { job = parse(fs.readFileSync(file, "utf8")); } catch {}
    if (!job || !SAFE_ID.test(String(job.Id)) || job.Id + ".json" !== name) { tryDelete(file); continue; }

    let dirty = false;
    // The audio always lives beside the sidecar under the record's id. Trusting the stored absolute path would
    // lose the audio of anything written before the directory moved - or imported from VoiceTray.
    if (job.AudioPath !== wavPath(job.Id)) { job.AudioPath = wavPath(job.Id); dirty = true; }
    setAudio(job.Id, sizeOf(wavPath(job.Id)));
    if (IN_FLIGHT.has(job.Status)) {
      // Nothing is in flight at startup, whatever the file says.
      Object.assign(job, { Status: "Failed", LastErrorShort: t("voice.errors.interrupted.short"),
        LastError: t("voice.errors.interrupted.long"), LastErrorTransient: true });
      dirty = true;
    }
    // No audio and no text: nothing to show and nothing to retry.
    if (!hasText(job) && !hasAudio(job)) { tryDelete(file); continue; }
    if (job.Status !== "Done" && job.Status !== "Failed") {
      job.Status = "Failed";
      job.LastErrorShort ??= t("voice.errors.previousSession.short");
      job.LastError ??= t("voice.errors.previousSession.long");
      job.LastErrorTransient = true;
      dirty = true;
      waiting++;
    }
    if (dirty) write(job);
    jobs.set(job.Id, job);
  }
  // A WAV with no sidecar means the process died mid-recording: its RIFF header was never closed.
  for (const name of filesEnding(".wav")) if (!jobs.has(name.slice(0, -4))) tryDelete(path.join(dir(), name));
  // Leftovers from an interrupted atomic write or copy.
  for (const name of filesEnding(".tmp")) tryDelete(path.join(dir(), name));
  return { waiting };
}

const map = () => { if (!jobs) recoverOnStartup(); return jobs; };
const copy = job => (job ? { ...job } : null);

function get(id) { return copy(map().get(id)); }
const count = () => map().size;

// Upsert. `meta` uses the record's own PascalCase names; Id may be given (the recorder needs it before the record).
function create(kind = "Dictation", meta = {}) {
  const id = meta.Id || newId();
  if (!SAFE_ID.test(id)) throw new Error(`Invalid record id: ${id}`);
  const existing = map().get(id);
  const job = { ...(existing || blank()), ...pick(meta), Id: id, Kind: KINDS.includes(kind) ? kind : "Dictation", AudioPath: wavPath(id) };
  map().set(id, job);
  write(job);
  return copy(job);
}

function update(id, patch = {}) {
  const job = map().get(id);
  if (!job) return null;
  const { Id, AudioPath, ...p } = pick(patch);
  Object.assign(job, p);
  write(job);
  return copy(job);
}

const quietly = p => p.catch(e => console.error("Could not delete a voice file:", e.message));

function removeAudio(id) {
  audio.delete(id);
  quietly(atomic.remove(wavPath(id)));
}

function remove(id) {
  const had = map().delete(id);
  quietly(atomic.remove(sidecar(id)));
  removeAudio(id);
  return had;
}

// Newest first, decorated with HasAudio/HasText (never persisted). `query` matches like VoiceTray's history search.
function list({ query = "", status, kind } = {}) {
  const q = String(query || "").trim().toLocaleLowerCase();
  const has = s => typeof s === "string" && s.toLocaleLowerCase().includes(q);
  return [...map().values()]
    .filter(j => (!status || j.Status === status) && (!kind || j.Kind === kind))
    .filter(j => !q || has(j.ResultText) || has(j.RawText) || has(j.LastErrorShort) || has(j.Provider) || has(j.Model)
      || has(j.Command?.summary) || has(j.Command?.prompt))
    .sort((a, b) => time(b.CreatedAt) - time(a.CreatedAt))
    .map(j => ({ ...j, HasAudio: hasAudio(j), HasText: hasText(j) }));
}

// Completed records lose their audio first (14 days, or 1 GB in total, oldest first) and the transcript much later
// (90 days, or 500 records). Failures are left alone apart from the runaway guard - they wait on the user.
function applyRetention() {
  const all = [...map().values()];
  const removed = [];
  let trimmed = 0;
  const now = Date.now();
  const byAge = (a, b) => time(a.CreatedAt) - time(b.CreatedAt);
  const completed = all.filter(j => j.Status === "Done").sort(byAge);
  const drop = job => {
    remove(job.Id);
    all.splice(all.indexOf(job), 1);
    const i = completed.indexOf(job);
    if (i >= 0) completed.splice(i, 1);
    removed.push(job.Id);
  };

  for (const job of [...completed]) if (time(job.CreatedAt) <= now - LIMITS.recordTtlMs) drop(job);
  while (all.length > LIMITS.maxRecords && completed.length) drop(completed[0]);

  for (const job of completed) {
    if (time(job.CreatedAt) <= now - LIMITS.audioTtlMs && hasAudio(job)) { removeAudio(job.Id); trimmed++; }
  }
  let bytes = completed.reduce((n, j) => n + (audio.get(j.Id) || 0), 0);
  for (let i = 0; bytes > LIMITS.maxAudioBytes && i < completed.length; i++) {
    const job = completed[i];
    if (!hasAudio(job)) continue;
    bytes -= audio.get(job.Id);
    removeAudio(job.Id);
    trimmed++;
  }

  const failed = all.filter(j => j.Status === "Failed").sort(byAge);
  while (failed.length > LIMITS.maxFailed) drop(failed.shift());

  return { removed, trimmed };
}

module.exports = {
  init, dir, newId, wavPath, stamp, create, update, get, count, list, remove, removeAudio, setAudio, hasAudio,
  recoverOnStartup, applyRetention, flush: atomic.flush, LIMITS, FIELDS
};
