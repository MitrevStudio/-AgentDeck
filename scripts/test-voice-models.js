// The models (src/voice/catalog.js) and what hangs on them: the catalog's invariants, the resolver, the migration of
// older settings, the exact request each model family gets, and the queue's retries. Plain Node: electron and the
// network are stubs, the settings and records live in a temp folder, and no request leaves the machine.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-voice-models-"));
const VOICE = path.join(__dirname, "..", "src", "voice");

// What was sent, and what the next request is answered with.
const sent = [];
const ANSWERS = [
  [/audio\/transcriptions$/, { text: "hello world" }],
  [/chat\/completions$/, { choices: [{ message: { content: "answer" } }] }],
  [/:generateContent$/, { candidates: [{ content: { parts: [{ text: "answer" }] } }] }],
  [/\/interactions$/, { steps: [{ type: "model_output", content: [{ type: "text", text: "hello world" }] }] }]
];
let reply = null;
async function fakeFetch(url, options) {
  const body = options.body instanceof FormData
    ? [...options.body.entries()].filter(([name]) => name !== "file")
    : JSON.parse(options.body);
  sent.push({ url: String(url), headers: options.headers, body });
  const answer = reply?.(url, body) ?? ANSWERS.find(([re]) => re.test(url))?.[1];
  assert.ok(answer, `a stubbed answer for ${url}`);
  return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 200 });
}

const load = Module._load;
const NETWORK = path.join(VOICE, "..", "network");
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => { throw new Error("the test must not reach the real userData"); } } };
  }
  if (parent && request.startsWith(".") && path.resolve(path.dirname(parent.filename), request) === NETWORK) return { fetch: fakeFetch };
  return load.call(this, request, parent, isMain);
};

const voice = name => require(path.join(VOICE, name));
const catalog = voice("catalog"), settings = voice("settings"), store = voice("job-store");
const gemini = voice("providers/gemini"), openai = voice("providers/openai");
const { transcribeJob, transcribeFile, maxRecordingBytes } = voice("transcription");
const { createQueue, jobSettings } = voice("queue");
const rewrite = voice("rewrite");
const { validateSettings } = voice("windows");
const { TASKS, MODELS, PROVIDERS, LAST_DAY, resolveTask, choices, currentModel, modelInfo } = catalog;

// safeStorage, reversible and visibly not plain text.
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async text => Buffer.from([...text].reverse().join("")),
  decryptStringAsync: async buffer => ({ result: [...buffer.toString()].reverse().join(""), shouldReEncrypt: false })
};
const enc = text => Buffer.from([...text].reverse().join("")).toString("base64");

let folders = 0;
// Settings as a file of `voice` would load; undefined: no file at all.
function settingsFrom(voiceSection, other = {}) {
  const dir = path.join(temp, `profile-${++folders}`);
  fs.mkdirSync(dir, { recursive: true });
  if (voiceSection !== undefined) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ...other, voice: voiceSection }));
  settings.init({ userDataDir: dir, safeStorage });
  return { dir, loaded: settings.load() };
}
const reload = dir => { settings.init({ userDataDir: dir, safeStorage }); return settings.load(); };
const onDisk = dir => JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
const changed = s => s.modelChanges.map(c => `${c.from}>${c.to}`).sort();
const chosen = (s, task) => Object.values(resolveTask(s, task)).join(" ");

// Today as `day` while fn runs: what has stopped depends on the date.
async function onDay(day, fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [`${day}T12:00:00Z`])); }
  };
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

async function request(fn) {
  sent.length = 0;
  await fn();
  assert.equal(sent.length, 1, "one request");
  return sent[0];
}

const wav = path.join(temp, "speech.wav");
fs.writeFileSync(wav, Buffer.alloc(44 + 3200));
const AUDIO = fs.readFileSync(wav).toString("base64");
const getApiKey = async provider => `test-key-${provider}`;
const OPENAI_KEY = { OpenAI: enc("test-openai") }, GEMINI_KEY = { Gemini: enc("test-gemini") };

// What an installed version from before the tasks reads and writes in the same settings.json.
const OLD_KEYS = ["provider", "models", "readAloudModel"];
// That version's normalize() and save(): what it knows is repaired, every other key is spread through.
function oldVersionSaves(dir, patch) {
  const root = onDisk(dir);
  const v = { ...root.voice, ...patch };
  root.voice = {
    ...v,
    provider: PROVIDERS.includes(v.provider) ? v.provider : "OpenAI",
    models: { OpenAI: "", Gemini: "", ...v.models },
    readAloudModel: typeof v.readAloudModel === "string" ? v.readAloudModel : ""
  };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(root));
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------- catalog ----------
test("the defaults are the plan's", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TASKS).map(([id, spec]) => [id, [spec.provider, spec.models.Gemini, spec.models.OpenAI]])), {
    dictation: ["OpenAI", "gemini-3.5-flash-lite", "gpt-transcribe"],
    commands: ["", "gemini-3.5-flash-lite", "gpt-transcribe"],
    rewrite: ["", "gemini-3.5-flash-lite", "gpt-6-luna"],
    edit: ["", "gemini-3.5-flash-lite", "gpt-6-luna"],
    ask: ["", "gemini-3.5-flash-lite", "gpt-6-luna"],
    readAloud: ["Gemini", "gemini-3.8-flash-tts", undefined],
    meetingTranscription: ["Gemini", "gemini-3.5-transcribe", "gpt-transcribe"],
    meetingSummary: ["Gemini", "gemini-3.8-flash", "gpt-6-luna"]
  });
});

test("nothing offered, the defaults first of all, stops or is re-routed", () => {
  for (const [task, spec] of Object.entries(TASKS)) {
    for (const [provider, first] of Object.entries(spec.models)) {
      const offered = choices(task, provider);
      assert.equal(offered[0], first, `${task}/${provider}: the default leads`);
      assert.equal(new Set(offered).size, offered.length, `${task}/${provider}: no model twice`);
      for (const id of offered) {
        const m = MODELS[provider][id];
        assert.ok(m, `${id} is in the catalog`);
        assert.ok(m.tasks.includes(task), `${id} does ${task}`);
        assert.ok(!m.shutdown && !m.rerouted && !m.successor && !m.unlisted, `${id} is current`);
        assert.equal(currentModel(provider, id, LAST_DAY), id);
        assert.ok(m.price?.length && m.api, `${id}: price and endpoint`);
      }
    }
  }
  assert.deepEqual(choices("readAloud", "OpenAI"), []);
  assert.deepEqual(choices("dictation", "OpenAI"), ["gpt-transcribe"]);
  assert.ok(!choices("dictation", "Gemini").some(id => id.startsWith("gemini-4")), "no model that always thinks for dictation");
});

test("every model that stops has a living successor for the same tasks", () => {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  for (const provider of PROVIDERS) {
    for (const [id, m] of Object.entries(MODELS[provider])) {
      assert.equal(id, id.toLowerCase(), `${id}: ids are looked up in lower case`);
      if (m.shutdown) assert.match(m.shutdown, DAY, id);
      if (m.shutdown || m.rerouted) assert.ok(m.successor, `${id} has a successor`);
      for (const p of m.price || []) assert.match(p.from, DAY, `${id}: a price has its date`);
      if (!m.successor) continue;
      const seen = new Set([id]);
      let next = m.successor;
      for (;;) {
        assert.ok(!seen.has(next), `${id}: no circle of successors`);
        seen.add(next);
        const to = MODELS[provider][next];
        assert.ok(to, `${id}: ${next} is known`);
        if (!to.successor) {
          assert.ok(to.tasks.some(task => m.tasks.includes(task)), `${id}: ${next} does its work`);
          break;
        }
        next = to.successor;
      }
    }
  }
});

test("a model gives way on its day, an alias at once", () => {
  assert.equal(currentModel("OpenAI", "whisper-1", "2027-02-25"), "whisper-1");
  assert.equal(currentModel("OpenAI", "whisper-1", "2027-02-26"), "gpt-transcribe");
  assert.equal(currentModel("OpenAI", "gpt-4o-mini-transcribe-2025-03-20", "2027-01-20"), "gpt-transcribe");
  assert.equal(currentModel("OpenAI", "gpt-4o-mini-transcribe-2025-12-15", "2027-01-20"), "gpt-4o-mini-transcribe-2025-12-15");
  assert.equal(currentModel("OpenAI", "gpt-4.1-mini-2025-04-14", "2027-01-14"), "gpt-6-luna");
  assert.equal(currentModel("Gemini", "gemini-2.5-flash", "2026-12-01"), "gemini-3.5-flash-lite");
  assert.equal(currentModel("Gemini", "gemini-2.5-pro", "2026-11-30"), "gemini-2.5-pro");
  assert.equal(currentModel("Gemini", "gemini-3.5-flash", "2026-11-22"), "gemini-3.6-flash");
  assert.equal(currentModel("Gemini", "gemini-2.0-flash-lite", "2026-11-22"), "gemini-3.1-flash-lite");
  assert.equal(currentModel("Gemini", "gemini-2.0-flash-lite", "2027-05-07"), "gemini-3.5-flash-lite", "a successor that stopped too");
  assert.equal(currentModel("Gemini", "gemini-3-flash-preview", LAST_DAY), "gemini-3-flash-preview", "a successor without a date moves nobody");
  assert.equal(currentModel("OpenAI", "my-own-model", LAST_DAY), "my-own-model");
});

test("an unknown id gets only what is safe", () => {
  assert.deepEqual(modelInfo("OpenAI", "my-own-model"), { language: "language", vocabulary: "prompt", timestamps: "none" });
  assert.deepEqual(modelInfo("Gemini", "constructor"), { api: "generateContent", vocabulary: "prompt", timestamps: "prompted" });
  assert.equal(modelInfo("Gemini", "GEMINI-3.5-Transcribe").api, "interactions", "whatever its case");
  assert.equal(modelInfo("OpenAI", "gpt-6-luna-2099-01-01").thinking, undefined, "nothing is read out of a name");
});

// ---------- resolver ----------
test("with nothing saved every task has the plan's default", () => {
  assert.equal(chosen({}, "dictation"), "OpenAI gpt-transcribe");
  assert.equal(chosen({}, "commands"), "OpenAI gpt-transcribe");
  for (const task of ["rewrite", "edit", "ask"]) assert.equal(chosen({}, task), "OpenAI gpt-6-luna");
  assert.equal(chosen({}, "readAloud"), "Gemini gemini-3.8-flash-tts");
  assert.equal(chosen({}, "meetingTranscription"), "Gemini gemini-3.5-transcribe");
  assert.equal(chosen(undefined, "meetingSummary"), "Gemini gemini-3.8-flash");
  assert.throws(() => resolveTask({}, "translate"), /unknown task/);
});

test("tasks follow the dictation, meetings do not", () => {
  const s = { tasks: { dictation: { provider: "Gemini", models: { Gemini: "gemini-3.5-transcribe", OpenAI: "" } } } };
  assert.equal(chosen(s, "commands"), "Gemini gemini-3.5-transcribe", "commands: the dictation's model too");
  assert.equal(chosen(s, "rewrite"), "Gemini gemini-3.5-flash-lite", "text: only its provider");
  const openAi = { tasks: { dictation: { provider: "OpenAI" } } };
  assert.equal(chosen(openAi, "meetingTranscription"), "Gemini gemini-3.5-transcribe");
  assert.equal(chosen(openAi, "meetingSummary"), "Gemini gemini-3.8-flash");
  s.tasks.commands = { provider: "OpenAI", models: { OpenAI: "my-speech" } };
  assert.equal(chosen(s, "commands"), "OpenAI my-speech");
});

test("an override changes one run, never the provider behind one's back", () => {
  const s = { tasks: { meetingSummary: { provider: "Gemini", models: { OpenAI: "gpt-6.2-sol", Gemini: "gemini-4-neon" } } } };
  assert.deepEqual(resolveTask(s, "meetingSummary", { provider: "openai" }), { provider: "OpenAI", model: "gpt-6.2-sol" });
  assert.deepEqual(resolveTask(s, "meetingSummary", { model: "my-model" }), { provider: "Gemini", model: "my-model" });
  assert.deepEqual(resolveTask({}, "meetingTranscription", { provider: "Elsewhere" }), { provider: "Elsewhere", model: "" });
  assert.deepEqual(resolveTask({}, "readAloud", { provider: "OpenAI" }), { provider: "OpenAI", model: "" });
});

// ---------- settings ----------
test("no settings at all: the defaults, and nothing to tell", () => {
  const { loaded } = settingsFrom(undefined);
  assert.equal(chosen(loaded, "dictation"), "OpenAI gpt-transcribe");
  assert.deepEqual(loaded.modelChanges, []);
  for (const key of ["provider", "models", "readAloudModel", "apiKeysEnc"]) assert.ok(!(key in loaded), key);
});

test("an OpenAI user of the old default", () => {
  const { loaded } = settingsFrom({ provider: "OpenAI", models: { OpenAI: "whisper-1", Gemini: "gemini-2.5-flash" }, readAloudModel: "gemini-3.8-flash-tts", apiKeysEnc: OPENAI_KEY });
  assert.equal(chosen(loaded, "dictation"), "OpenAI gpt-transcribe");
  assert.equal(chosen(loaded, "rewrite"), "OpenAI gpt-6-luna");
  assert.equal(chosen(loaded, "meetingTranscription"), "Gemini gemini-3.5-transcribe");
  assert.equal(loaded.tasks.dictation.models.Gemini, "", "the other provider's choice moved too");
  assert.deepEqual(changed(loaded), ["gpt-4.1-mini>gpt-6-luna", "whisper-1>gpt-transcribe"], "told about what is in use");
});

test("a Gemini user keeps the provider, the key and everything else", async () => {
  const before = {
    provider: "Gemini", models: { OpenAI: "gpt-4o-transcribe", Gemini: "gemini-3.5-transcribe" },
    readAloudModel: "gemini-3.8-flash-lite-tts", readAloudVoice: "Puck", readAloudSpeed: 1.5, language: "bg",
    microphoneName: "Desk microphone", microphoneDeviceId: "mic-1", maxRecordingMinutes: 5, useClipboardPaste: false,
    hotkeys: { dictate: "Control+F8", readAloud: "Control+F9", editSelection: "Control+F10", ask: "Control+F11" },
    dictationMode: "clean", promptLanguage: "en", pushToTalk: "hold",
    dictionary: { terms: ["Acme"], replacements: [{ from: "acme", to: "ACME" }], projectNames: false },
    commands: { enabled: false, trigger: "off" }, importedFromVoiceTray: "2026-10-01T00:00:00.000Z",
    fromAnotherVersion: { kept: true }, apiKeysEnc: { ...GEMINI_KEY, ...OPENAI_KEY }
  };
  const { dir, loaded } = settingsFrom(before, { ui: { theme: "nord" } });
  assert.equal(chosen(loaded, "dictation"), "Gemini gemini-3.5-transcribe");
  assert.equal(chosen(loaded, "readAloud"), "Gemini gemini-3.8-flash-lite-tts");
  assert.deepEqual(changed(loaded), ["gemini-3.1-flash-lite>gemini-3.5-flash-lite", "gpt-4o-transcribe>gpt-transcribe"]);
  assert.equal(await settings.getApiKey("Gemini"), "test-gemini");
  const { provider, models, readAloudModel, apiKeysEnc, ...rest } = before;
  for (const [key, value] of Object.entries(rest)) {
    // A shortcut that came after that version (the meeting screenshot) has its default.
    assert.deepEqual(loaded[key], key === "hotkeys" ? { ...settings.defaults.hotkeys, ...value } : value, key);
  }

  await settings.save({});
  const root = onDisk(dir);
  assert.deepEqual(root.ui, { theme: "nord" }, "the other keys of the file");
  assert.deepEqual(root.voice.apiKeysEnc, apiKeysEnc, "the keys, untouched");
  assert.deepEqual(root.voice.fromAnotherVersion, { kept: true });
  assert.deepEqual(OLD_KEYS.map(key => root.voice[key]), [provider, models, readAloudModel], "the old keys, as they were");
});

test("settings that never named a model are told of the changed defaults, with a key only", () => {
  const { loaded } = settingsFrom({ provider: "Gemini", models: { OpenAI: "", Gemini: "" }, apiKeysEnc: GEMINI_KEY });
  assert.equal(chosen(loaded, "dictation"), "Gemini gemini-3.5-flash-lite");
  assert.deepEqual(changed(loaded), ["gemini-2.5-flash>gemini-3.5-flash-lite", "gemini-3.1-flash-lite>gemini-3.5-flash-lite"]);
  const keyless = settingsFrom({ provider: "OpenAI", models: { OpenAI: "", Gemini: "" }, readAloudModel: "" }).loaded;
  assert.deepEqual(keyless.modelChanges, [], "voice was never in use");
});

test("each model the old lists offered", () => {
  const moved = {
    OpenAI: { "whisper-1": "", "gpt-4o-mini-transcribe": "", "gpt-4o-transcribe": "", "gpt-4o-transcribe-diarize": "" },
    Gemini: {
      "gemini-2.5-flash": "", "gemini-3.1-flash-lite": "", "gemini-2.5-pro": "gemini-3.8-flash", "gemini-3.5-flash": "gemini-3.6-flash",
      "gemini-3.5-transcribe": "gemini-3.5-transcribe", "gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
      "gemini-3-flash-preview": "gemini-3-flash-preview", "gemini-2.5-flash-lite": "gemini-2.5-flash-lite"
    }
  };
  for (const [provider, list] of Object.entries(moved)) {
    for (const [from, to] of Object.entries(list)) {
      const { loaded } = settingsFrom({ provider, models: { [provider]: from } });
      assert.equal(loaded.tasks.dictation.provider, provider);
      assert.equal(loaded.tasks.dictation.models[provider], to, from);
      assert.equal(loaded.modelChanges.length, to === from ? 0 : 1, `${from}: told when it moved`);
    }
  }
});

test("custom ids stay, a read-aloud preview moves", () => {
  const custom = settingsFrom({ provider: "openai", models: { OpenAI: "acme/speech-v2", Gemini: "tuned-flash" }, readAloudModel: "my-voice" }).loaded;
  assert.equal(chosen(custom, "dictation"), "OpenAI acme/speech-v2");
  assert.equal(custom.tasks.dictation.models.Gemini, "tuned-flash");
  assert.equal(chosen(custom, "readAloud"), "Gemini my-voice");
  assert.deepEqual(custom.modelChanges, []);
  const old = settingsFrom({ provider: "Gemini", models: {}, readAloudModel: "gemini-2.5-flash-preview-tts" }).loaded;
  assert.equal(chosen(old, "readAloud"), "Gemini gemini-3.8-flash-tts");
  assert.deepEqual(changed(old), ["gemini-2.5-flash-preview-tts>gemini-3.8-flash-tts"]);
});

test("damaged settings", () => {
  const { loaded } = settingsFrom({ provider: 7, models: "x", readAloudModel: [], modelChanges: [null, { from: 1 }], tasks: { rewrite: { provider: "Elsewhere", models: [] }, ask: "x", readAloud: { provider: "OpenAI" }, edit: { provider: ["OpenAI"] } } });
  assert.equal(chosen(loaded, "dictation"), "OpenAI gpt-transcribe");
  assert.equal(loaded.tasks.rewrite.provider, "");
  assert.equal(loaded.tasks.edit.provider, "");
  assert.equal(loaded.tasks.readAloud.provider, "Gemini");
  assert.deepEqual(loaded.modelChanges, []);
});

test("the migration is idempotent and tells once", async () => {
  const { dir, loaded } = settingsFrom({ provider: "OpenAI", models: { OpenAI: "whisper-1" }, apiKeysEnc: OPENAI_KEY });
  assert.deepEqual(reload(dir), loaded, "unsaved: the same again");
  await settings.save({});
  const first = onDisk(dir);
  assert.deepEqual(reload(dir), loaded, "saved: the same again");
  await settings.save({});
  assert.deepEqual(onDisk(dir), first, "a second save writes the same");
  await settings.save({ modelChanges: [] }); // what the controller does once it has said it
  assert.deepEqual(reload(dir).modelChanges, []);
});

test("a retiring id typed afterwards stays until its day", async () => {
  const { dir } = settingsFrom({});
  await settings.save({ tasks: { dictation: { models: { OpenAI: "whisper-1" } } } });
  const loaded = reload(dir);
  assert.equal(loaded.tasks.dictation.models.OpenAI, "whisper-1");
  assert.deepEqual(loaded.modelChanges, []);
  await onDay("2027-02-25", () => assert.equal(chosen(loaded, "dictation"), "OpenAI whisper-1"));
  await onDay("2027-02-26", () => assert.equal(chosen(loaded, "dictation"), "OpenAI gpt-transcribe"));
});

test("task settings from before the catalog's revision move too", () => {
  const tasks = { rewrite: { provider: "OpenAI", models: { OpenAI: "gpt-4.1-mini" } }, meetingSummary: { provider: "Gemini", models: { Gemini: "gemini-3.7-flash" } } };
  const { loaded } = settingsFrom({ tasks, modelsVersion: 0 });
  assert.equal(chosen(loaded, "rewrite"), "OpenAI gpt-6-luna");
  assert.equal(chosen(loaded, "meetingSummary"), "Gemini gemini-3.8-flash");
  assert.equal(loaded.modelChanges.length, 2);
});

test("a partial save changes only what it names", async () => {
  settingsFrom({});
  await settings.save({ tasks: { dictation: { models: { Gemini: "gemini-3.5-transcribe" } }, ask: { provider: "Gemini" } } });
  await settings.save({ tasks: { dictation: { provider: "Gemini" } } });
  const s = settings.load();
  assert.equal(chosen(s, "dictation"), "Gemini gemini-3.5-transcribe");
  assert.equal(chosen(s, "ask"), "Gemini gemini-3.5-flash-lite");
  assert.deepEqual(Object.keys(s.tasks), Object.keys(TASKS));
});

test("a provider a task cannot have is refused, not reset", async () => {
  settingsFrom({});
  await settings.save({ tasks: { ask: { provider: "Gemini" } } });
  await assert.rejects(settings.save({ tasks: { ask: { provider: "Elsewhere" } } }), /Unknown provider for ask: Elsewhere/);
  await assert.rejects(settings.save({ tasks: { readAloud: { provider: "OpenAI" } } }), /Unknown provider/, "one without that task");
  assert.equal(chosen(settings.load(), "ask"), "Gemini gemini-3.5-flash-lite", "nothing saved");
  await settings.save({ tasks: { ask: { provider: "" } } }); // the dictation's again
  assert.equal(settings.load().tasks.ask.provider, "");
});

test("a dated id typed by hand works like its model; a preview without a date stays", () => {
  const dated = catalog.modelInfo("Gemini", "gemini-3.5-transcribe-2026-08-01");
  assert.deepEqual([dated.api, dated.timestamps, dated.tasks.includes("meetingTranscription")], ["interactions", "word", true]);
  const old = catalog.modelInfo("OpenAI", "gpt-4.1-2099-01-01");
  assert.deepEqual([old.api, old.successor, old.shutdown], ["chat", undefined, undefined], "not its base's dates");
  assert.equal(catalog.modelInfo("Gemini", "my-model-2026-08-01").api, "generateContent", "unknown base: what every model takes");
  assert.equal(catalog.modelInfo("OpenAI", "gpt-4o-mini-transcribe-2025-03-20").shutdown, "2027-01-20", "a listed dated id is its own");
  assert.equal(catalog.currentModel("Gemini", "gemini-3-flash-preview", catalog.LAST_DAY), "gemini-3-flash-preview", "no date announced, not re-routed");
  assert.equal(catalog.choices("meetingSummary", "Gemini").includes("gemini-3-flash-preview"), false, "and not offered");
});

test("the old keys stay in the file as they were", async () => {
  // Unrepaired on purpose: an odd case, a blank, a key of its own.
  const old = { provider: "gemini", models: { OpenAI: " whisper-1 ", Gemini: "gemini-2.5-flash", Other: "kept" }, readAloudModel: "" };
  const { dir, loaded } = settingsFrom({ ...old, apiKeysEnc: { ...GEMINI_KEY, ...OPENAI_KEY } });
  assert.equal(chosen(loaded, "dictation"), "Gemini gemini-3.5-flash-lite");
  assert.ok(loaded.modelChanges.length, "told");
  for (const key of OLD_KEYS) assert.ok(!(key in loaded), `${key} is not handed out`);

  await settings.save({ modelChanges: [] }); // said
  await settings.save({ tasks: { dictation: { models: { Gemini: "gemini-3.5-transcribe" } } } });
  await settings.setApiKey("OpenAI", "test-new");
  await settings.save({ provider: "OpenAI", models: { Gemini: "x" }, readAloudModel: "x" }); // never ours to write
  const again = reload(dir);
  assert.equal(chosen(again, "dictation"), "Gemini gemini-3.5-transcribe", "the changed task holds");
  assert.deepEqual(again.modelChanges, [], "no second notice");
  const { provider, models, readAloudModel } = onDisk(dir).voice;
  assert.deepEqual({ provider, models, readAloudModel }, old, "unchanged in the file");
});

test("with tasks the old keys are not read, not even at a new revision", () => {
  const old = { provider: "Gemini", models: { Gemini: "gemini-2.5-pro" }, readAloudModel: "gemini-3.8-flash-lite-tts" };
  for (const modelsVersion of [0, catalog.REVISION]) {
    const { loaded } = settingsFrom({ ...old, tasks: {}, modelsVersion, apiKeysEnc: GEMINI_KEY });
    assert.equal(chosen(loaded, "dictation"), "OpenAI gpt-transcribe");
    assert.equal(chosen(loaded, "readAloud"), "Gemini gemini-3.8-flash-tts");
    assert.deepEqual(loaded.modelChanges, []);
  }
});

test("an old version saving over the file does not lose the tasks", async () => {
  for (const start of [{ provider: "Gemini", models: { Gemini: "gemini-2.5-flash" }, apiKeysEnc: GEMINI_KEY }, {}]) {
    const { dir } = settingsFrom(start);
    await settings.save({ modelChanges: [], tasks: { dictation: { provider: "Gemini", models: { Gemini: "gemini-3.5-transcribe" } }, rewrite: { provider: "OpenAI" } } });
    const { tasks, modelsVersion } = onDisk(dir).voice;
    oldVersionSaves(dir, { provider: "OpenAI", models: { OpenAI: "whisper-1" }, readAloudSpeed: 2 });
    assert.deepEqual(onDisk(dir).voice.tasks, tasks, "still in the file");
    const back = reload(dir);
    assert.deepEqual(back.tasks, tasks);
    assert.equal(back.modelsVersion, modelsVersion);
    assert.deepEqual(back.modelChanges, [], "no second notice");
    assert.equal(back.readAloudSpeed, 2);
    await settings.save({ language: "bg" });
    const now = onDisk(dir).voice;
    assert.equal(now.provider, "OpenAI", "what the old version wrote stays its own");
    assert.equal(now.models.OpenAI, "whisper-1");
  }
});

test("the VoiceTray import", async () => {
  const { dir } = settingsFrom(undefined);
  const source = path.join(temp, "voicetray");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "settings.json"), JSON.stringify({
    Provider: "Gemini", Models: { OpenAI: "my-speech", Gemini: "gemini-2.5-pro" }, Language: "bg",
    ReadAloudModel: "gemini-3.8-flash-lite-tts", ApiKeys: { Gemini: "test-imported" }
  }));
  const r = await voice("import-voicetray").importIfNeeded({ sourceDir: source, recordsDir: path.join(dir, "records") });
  assert.equal(r.settings, true);
  assert.equal(r.apiKeys, 1);
  const s = reload(dir);
  assert.equal(chosen(s, "dictation"), "Gemini gemini-3.8-flash");
  assert.equal(chosen(s, "readAloud"), "Gemini gemini-3.8-flash-lite-tts");
  assert.equal(s.tasks.dictation.models.OpenAI, "my-speech");
  assert.equal(s.language, "bg");
  assert.deepEqual(changed(s), ["gemini-2.5-pro>gemini-3.8-flash"]);
  assert.equal(await settings.getApiKey("Gemini"), "test-imported");
  const written = onDisk(dir).voice;
  assert.equal(written.tasks.dictation.provider, "Gemini", "it lands in the tasks");
  for (const key of OLD_KEYS) assert.ok(!(key in written), `${key} is not written`);
});

// What the Settings page sends.
const pagePayload = () => ({
  tasks: structuredClone(settings.defaults.tasks), language: "auto", useClipboardPaste: true, microphoneDeviceId: "",
  microphoneName: "", maxRecordingMinutes: 10, readAloudVoice: "Kore", hotkeys: { dictate: "Control+Space", readAloud: "Control+Shift+Space" },
  dictationMode: "verbatim", promptLanguage: "spoken", pushToTalk: "hybrid", dictionary: { terms: [], replacements: [], projectNames: true }, apiKeys: {}
});

test("what the Settings page sends is checked", () => {
  const ok = pagePayload();
  ok.tasks.rewrite = { provider: "Gemini", models: { OpenAI: "", Gemini: "tuned/flash:2" } };
  ok.apiKeys = { OpenAI: { set: "test-key" }, Gemini: { clear: true } };
  const good = validateSettings(ok, PROVIDERS);
  assert.deepEqual(good.errors, {});
  assert.deepEqual(good.patch.tasks.rewrite, ok.tasks.rewrite);
  assert.deepEqual(good.keys, { OpenAI: { value: "test-key" }, Gemini: { clear: true } });

  const bad = pagePayload();
  bad.tasks.dictation.provider = "";
  bad.tasks.readAloud.provider = "OpenAI";
  bad.tasks.edit.provider = ["OpenAI"];
  bad.tasks.ask.models.Gemini = "two words";
  delete bad.tasks.meetingSummary;
  bad.apiKeys = { OpenAI: { set: "has space" } };
  assert.deepEqual(Object.keys(validateSettings(bad, PROVIDERS).errors).sort(),
    ["apiKey.OpenAI", "tasks.ask", "tasks.dictation", "tasks.edit", "tasks.meetingSummary", "tasks.readAloud"]);
});

// ---------- requests ----------
test("gpt-transcribe: languages and keywords", async () => {
  const r = await request(() => openai.transcribe({ wavPath: wav, model: "gpt-transcribe", language: "bg", vocabulary: ["Acme", "List<T>", "Widget CLI", "two\nlines"], apiKey: "test-key" }));
  assert.equal(r.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.deepEqual(r.headers, { Authorization: "Bearer test-key" });
  assert.deepEqual(r.body, [["model", "gpt-transcribe"], ["languages[]", "bg"], ["keywords[]", "Acme"], ["keywords[]", "Widget CLI"]]);
  const auto = await request(() => openai.transcribe({ wavPath: wav, model: "gpt-transcribe", language: "auto", apiKey: "k" }));
  assert.deepEqual(auto.body, [["model", "gpt-transcribe"]]);
});

test("the older and unknown OpenAI speech models: language and prompt", async () => {
  for (const model of ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "acme-speech"]) {
    const r = await request(() => openai.transcribe({ wavPath: wav, model, language: "bg", vocabulary: ["Acme", "Widget"], apiKey: "k" }));
    assert.deepEqual(r.body, [["model", model], ["language", "bg"], ["prompt", "Acme, Widget."]]);
  }
  const r = await request(() => openai.transcribe({ wavPath: wav, model: "gpt-4o-transcribe-diarize", language: "en", vocabulary: ["Acme"], apiKey: "k" }));
  assert.deepEqual(r.body, [["model", "gpt-4o-transcribe-diarize"], ["language", "en"]]);
});

test("OpenAI text: effort and temperature by model", async () => {
  const families = {
    "gpt-6-luna": { temperature: 0.2, reasoning_effort: "none" },
    "gpt-6.1-terra": { temperature: 0.2, reasoning_effort: "none" },
    "gpt-6.2-sol": { reasoning_effort: "low" },
    "gpt-4.1-mini": { temperature: 0.2 },
    "acme-text": {}
  };
  const messages = [{ role: "system", content: "S" }, { role: "user", content: "U" }];
  for (const [model, extra] of Object.entries(families)) {
    const r = await request(() => openai.generateText({ model, system: "S", text: "U", apiKey: "k" }));
    assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
    assert.deepEqual(r.body, { model, messages, ...extra }, model);
  }
  const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
  const r = await request(() => openai.generateText({ model: "gpt-6-luna", system: "S", text: "U", schema, apiKey: "k" }));
  assert.deepEqual(r.body.response_format, { type: "json_schema", json_schema: { name: "answer", strict: true, schema } });
});

// What generationConfig holds for each Gemini family: text at temperature 0.2, speech at 0.
const GEMINI_FAMILIES = {
  "gemini-3.5-flash-lite": { thinkingConfig: { thinkingLevel: "minimal" } },
  "gemini-3.6-flash": { thinkingConfig: { thinkingLevel: "minimal" } },
  "gemini-3.8-flash": { thinkingConfig: { thinkingLevel: "low" } },
  "gemini-4-hydrogen": { thinkingConfig: { thinkingLevel: "low" } },
  "gemini-4-neon": { thinkingConfig: { thinkingLevel: "low" } },
  "gemini-4-carbon": { thinkingConfig: { thinkingLevel: "low" } },
  "gemini-3.1-flash-lite": { temperature: true, thinkingConfig: { thinkingLevel: "minimal" } },
  "gemini-3.1-pro-preview": { temperature: true, thinkingConfig: { thinkingLevel: "low" } },
  "gemini-2.5-flash": { temperature: true, thinkingConfig: { thinkingBudget: 0 } },
  "gemini-2.5-flash-lite": { temperature: true, thinkingConfig: { thinkingBudget: 0 } },
  "gemini-2.5-pro": { temperature: true },
  "tuned-flash": {}
};

test("Gemini text: thinking and temperature by model", async () => {
  for (const [model, { temperature, ...extra }] of Object.entries(GEMINI_FAMILIES)) {
    const r = await request(() => gemini.generateText({ model, system: "S", text: "U", apiKey: "test-key" }));
    assert.equal(r.url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
    assert.equal(r.headers["x-goog-api-key"], "test-key");
    assert.deepEqual(r.body, {
      systemInstruction: { parts: [{ text: "S" }] },
      contents: [{ role: "user", parts: [{ text: "U" }] }],
      generationConfig: { ...(temperature && { temperature: 0.2 }), ...extra }
    }, model);
  }
  const schema = { type: "object" };
  const r = await request(() => gemini.generateText({ model: "gemini-3.8-flash", system: "S", text: "U", schema, apiKey: "k" }));
  assert.deepEqual(r.body.generationConfig, { thinkingConfig: { thinkingLevel: "low" }, responseMimeType: "application/json", responseJsonSchema: schema });
});

test("Gemini speech on the general models", async () => {
  const prompt = "Transcribe this audio recording accurately. Respond with ONLY the transcribed text, without any commentary, labels, or quotation marks." +
    " The spoken language is Bulgarian. These names and terms may occur; when they do, spell them exactly like this: Acme.";
  for (const [model, { temperature, ...extra }] of Object.entries(GEMINI_FAMILIES)) {
    const r = await request(() => gemini.transcribe({ wavPath: wav, model, language: "bg", vocabulary: ["Acme"], apiKey: "k" }));
    assert.deepEqual(r.body, {
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "audio/wav", data: AUDIO } }] }],
      generationConfig: { ...(temperature && { temperature: 0 }), ...extra }
    }, model);
  }
});

test("Gemini Transcribe: Interactions, the documented language codes", async () => {
  const r = await request(() => gemini.transcribe({ wavPath: wav, model: "gemini-3.5-transcribe", language: "bg", vocabulary: ["Acme"], apiKey: "k" }));
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.deepEqual(r.body, {
    model: "gemini-3.5-transcribe", store: false, // nothing kept for later retrieval
    input: [{ type: "audio", data: AUDIO, mime_type: "audio/wav" }],
    // word for word: "smart" would carry out spoken editing instructions instead of writing them down
    generation_config: { transcription_config: { mode: { type: "verbatim" }, language_codes: ["bg-BG"], custom_vocabulary: ["Acme"] } }
  });
  const zh = await request(() => gemini.transcribe({ wavPath: wav, model: "gemini-3.5-transcribe", language: "zh", apiKey: "k" }));
  assert.deepEqual(zh.body.generation_config.transcription_config, { mode: { type: "verbatim" }, language_codes: ["cmn-Hans-CN"] });
});

test("read aloud asks for the task's model", async () => {
  const overlay = new EventEmitter();
  overlay.player = { begin() {}, push() {}, end() {}, stop() {} };
  const models = [];
  const { loaded } = settingsFrom({ provider: "OpenAI", readAloudModel: "gemini-3.8-flash-lite-tts" });
  const reader = voice("tts").createReadAloud({
    overlay, getApiKey, getSettings: () => loaded,
    speak: async function* ({ model }) { models.push(model); yield Buffer.alloc(4); }
  });
  const done = new Promise(resolve => reader.once("done", resolve));
  reader.start("Hello.");
  assert.equal((await done).model, "gemini-3.8-flash-lite-tts");
  assert.deepEqual(models, ["gemini-3.8-flash-lite-tts"]);
  reader.stop();

  reply = () => new Response("data: [DONE]\n\n", { status: 200 });
  const r = await request(async () => { for await (const _ of gemini.speak({ text: "Hello.", model: "gemini-3.8-flash-tts", voice: "Kore", apiKey: "k" })); });
  assert.deepEqual(r.body, {
    model: "gemini-3.8-flash-tts", stream: true,
    input: [{ type: "user_input", content: [{ type: "text", text: "Hello." }] }],
    response_format: { type: "audio" }, generation_config: { speech_config: [{ voice: "Kore" }] }
  });
});

test("text tasks take their own settings when the caller names none", async () => {
  settingsFrom({});
  await settings.save({ tasks: { rewrite: { provider: "Gemini" }, ask: { provider: "OpenAI", models: { OpenAI: "gpt-6.1-terra" } }, edit: { models: { OpenAI: "gpt-6.2-sol" } } } });
  const modelOf = r => r.body.model || /models\/([^:]+):/.exec(r.url)[1];
  assert.equal(modelOf(await request(() => rewrite.rewrite("hello", { mode: "clean", getApiKey }))), "gemini-3.5-flash-lite");
  assert.equal(modelOf(await request(() => voice("ask").askText("why?", { getApiKey }))), "gpt-6.1-terra");
  assert.equal(modelOf(await request(() => voice("edit").editText("text", "shorter", { getApiKey }))), "gpt-6.2-sol");
});

test("a failed summary request stays with its provider", async () => {
  settingsFrom({ tasks: { dictation: { provider: "OpenAI" } }, modelsVersion: 1, apiKeysEnc: OPENAI_KEY });
  reply = () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 503 });
  sent.length = 0;
  await assert.rejects(rewrite.generate({ task: "meetingSummary", system: "S", text: "U", getApiKey }), error => error.kind === "ServerError");
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /generativelanguage.*gemini-3\.8-flash:/);
  sent.length = 0;
  await assert.rejects(rewrite.generate({ task: "meetingSummary", system: "S", text: "U" }), error => error.kind === "Configuration");
  assert.equal(sent.length, 0, "no Gemini key: not OpenAI instead");
});

// ---------- queue ----------
function queueWith(s, deps = {}) {
  const dir = path.join(temp, `records-${++folders}`);
  fs.mkdirSync(dir, { recursive: true });
  store.init({ dir });
  store.recoverOnStartup();
  return createQueue({
    store, getSettings: () => s, toClipboard: async () => true,
    transcribe: (job, _s, opts) => transcribeJob(job, _s, { ...opts, getApiKey }),
    ...deps
  });
}
function recording(meta) {
  const id = store.newId();
  fs.copyFileSync(wav, store.wavPath(id));
  store.create("Dictation", { Id: id, ...meta });
  store.setAudio(id, fs.statSync(wav).size);
  return id;
}
async function settled(q, id, run) {
  const end = new Promise(resolve => {
    const on = e => { if (e.id === id && ["completed", "failed", "empty"].includes(e.type)) { q.off("job", on); resolve(); } };
    q.on("job", on);
  });
  await run();
  await end;
  return store.get(id);
}

test("a failed job with a dead model id works on retry", async () => {
  await onDay("2027-03-01", async () => {
    const q = queueWith(settingsFrom({ provider: "Gemini" }).loaded);
    const id = recording({ Provider: "OpenAI", Model: "whisper-1", Language: "bg", Status: "Failed", LastError: "gone" });
    sent.length = 0;
    const job = await settled(q, id, () => assert.ok(q.retry(id)));
    assert.equal(job.Status, "Done");
    assert.equal(job.Provider, "OpenAI", "on the provider it was recorded with");
    assert.equal(job.Model, "gpt-transcribe", "History says what did it");
    assert.deepEqual(sent[0].body, [["model", "gpt-transcribe"], ["languages[]", "bg"]]);
  });
});

test("an old job's rewrite stays with its provider and drops the dead model", async () => {
  await onDay("2027-03-01", async () => {
    const q = queueWith(settingsFrom({ provider: "OpenAI" }).loaded, {
      rewrite: (text, options) => rewrite.rewrite(text, { ...options, getApiKey, promptLanguage: "spoken" })
    });
    const id = recording({ Provider: "Gemini", Model: "gemini-2.5-flash", Status: "Failed", Mode: "clean" });
    sent.length = 0;
    assert.equal((await settled(q, id, () => q.retry(id))).Status, "Done");
    assert.deepEqual(sent.map(r => /models\/([^:]+):/.exec(r.url)?.[1]), ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"]);
  });
});

test("what a recording was made with survives a change of the settings", async () => {
  const before = { tasks: { rewrite: { provider: "OpenAI", models: { OpenAI: "gpt-6.2-sol" } } } };
  const recordedWith = jobSettings(before);
  assert.deepEqual(recordedWith, { Provider: "OpenAI", Model: "gpt-transcribe", Language: "auto", TextProvider: "OpenAI", TextModel: "gpt-6.2-sol" });
  const calls = [];
  const after = { tasks: { dictation: { provider: "Gemini" }, rewrite: { provider: "Gemini" } } };
  const q = queueWith(after, { rewrite: async (text, options) => { calls.push([options.provider, options.model]); return text; } });
  const id = recording({});
  assert.equal((await settled(q, id, () => q.enqueue(id, { recordedWith: { ...recordedWith, Mode: "prompt" } }))).Status, "Done");
  assert.deepEqual(calls, [["OpenAI", "gpt-6.2-sol"]]);

  await store.flush();
  store.init({ dir: store.dir() });
  store.recoverOnStartup();
  assert.equal(store.get(id).TextModel, "gpt-6.2-sol", "and a restart");

  calls.length = 0;
  const again = await settled(q, id, () => q.retranscribe(id));
  assert.deepEqual([again.Provider, again.Model, again.TextProvider, again.TextModel],
    ["Gemini", "gemini-3.5-flash-lite", "Gemini", "gemini-3.5-flash-lite"], "transcribed again: the settings of now");
});

test("a record without a provider follows the settings of now", async () => {
  settingsFrom({});
  await settings.save({ tasks: {
    dictation: { provider: "Gemini", models: { Gemini: "gemini-3.5-transcribe" } },
    rewrite: { provider: "OpenAI", models: { OpenAI: "gpt-6.1-terra" } },
    ask: { provider: "OpenAI", models: { OpenAI: "gpt-6.2-sol" } }
  } });
  const s = settings.load();
  for (const [meta, written] of [[{ Mode: "clean" }, "gpt-6.1-terra"], [{ Ask: true }, "gpt-6.2-sol"]]) {
    for (const Model of ["", "whisper-1"]) { // a model without its provider says nothing
      const calls = [];
      const q = queueWith(s, {
        transcribe: async job => { calls.push([job.Provider, job.Model, job.Language]); return "hello"; },
        rewrite: async (text, options) => { calls.push([options.provider, options.model]); return text; }
      });
      const id = recording({ Provider: "", Model, Language: "de", Status: "Failed", ...meta });
      await settings.setApiKey("OpenAI", "test-openai");
      sent.length = 0;
      const job = await settled(q, id, () => q.retry(id));
      assert.equal(job.Status, "Done");
      assert.deepEqual(calls[0], ["Gemini", "gemini-3.5-transcribe", "de"], "the user's provider, the record's language");
      assert.deepEqual([job.Provider, job.Model], ["Gemini", "gemini-3.5-transcribe"], "History says what did it");
      if (meta.Ask) assert.equal(sent[0].body.model, written);
      else assert.deepEqual(calls[1], ["OpenAI", written]);
    }
  }
});

test("a record without a provider is transcribed, not refused", async () => {
  const q = queueWith({ tasks: { dictation: { provider: "Gemini", models: { Gemini: "gemini-3.5-transcribe" } } } });
  const id = recording({ Provider: "", Model: "", Status: "Failed" });
  sent.length = 0;
  assert.equal((await settled(q, id, () => q.retry(id))).Status, "Done");
  assert.equal(sent[0].body.model, "gemini-3.5-transcribe");
});

test("a record with a provider but no model takes that provider's model of now", async () => {
  const s = { tasks: { dictation: { provider: "OpenAI", models: { OpenAI: "", Gemini: "gemini-3.5-transcribe" } } } };
  const q = queueWith(s);
  const id = recording({ Provider: "Gemini", Model: "", Status: "Failed" });
  sent.length = 0;
  const job = await settled(q, id, () => q.retry(id));
  assert.deepEqual([job.Status, job.Provider, job.Model], ["Done", "Gemini", "gemini-3.5-transcribe"]);
});

test("a question and an edit pin their own model", () => {
  const s = { tasks: { ask: { provider: "Gemini" }, edit: { provider: "", models: { OpenAI: "gpt-6.1-terra" } } } };
  assert.equal(jobSettings(s, { Ask: true }).TextProvider, "Gemini");
  assert.equal(jobSettings(s, { EditSource: "text" }).TextModel, "gpt-6.1-terra");
  assert.equal(jobSettings(s, {}).TextModel, "gpt-6-luna");
});

test("a question and an edit are written by the pinned model", async () => {
  settingsFrom({ apiKeysEnc: OPENAI_KEY });
  const q = queueWith(settings.load());
  for (const extra of [{ Ask: true }, { EditSource: "some text" }]) {
    const id = recording({});
    sent.length = 0;
    await settled(q, id, () => q.enqueue(id, { recordedWith: { Provider: "OpenAI", Model: "gpt-transcribe", TextProvider: "OpenAI", TextModel: "gpt-6.2-sol", ...extra } }));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.model, "gpt-6.2-sol");
  }
});

test("a rewrite without a key goes to the provider chosen now", async () => {
  const calls = [];
  const q = queueWith({ tasks: { rewrite: { provider: "Gemini", models: { Gemini: "gemini-3.8-flash" } } } }, {
    rewrite: async (text, options) => {
      calls.push([options.provider, options.model]);
      if (options.provider === "OpenAI") throw voice("errors").configuration("no key");
      return text;
    }
  });
  const id = recording({});
  await settled(q, id, () => q.enqueue(id, { recordedWith: { Provider: "OpenAI", Model: "gpt-transcribe", TextProvider: "OpenAI", TextModel: "gpt-6-luna", Mode: "clean" } }));
  assert.deepEqual(calls, [["OpenAI", "gpt-6-luna"], ["Gemini", "gemini-3.8-flash"]]);
});

test("voice commands are heard by their own choice", async () => {
  const s = settingsFrom({}).loaded;
  s.tasks.commands = { provider: "Gemini", models: { OpenAI: "", Gemini: "gemini-3.5-transcribe" } };
  let stop, made;
  const heard = new Promise(resolve => { made = resolve; });
  const records = [];
  const runner = voice("command-runner").createCommandRunner({
    settings: { load: () => s, getApiKey }, transcribe: transcribeFile, vocabulary: () => [], now: () => 0,
    store: { newId: () => "c1", wavPath: () => wav, stamp: () => "", create: (_kind, meta) => { records.push(meta); made(); }, setAudio() {}, removeAudio() {} },
    recorder: { start: options => { stop = options.onEnded; return Promise.resolve(); }, stop: async () => null, cancel: async () => {} },
    panel: { fresh() {}, show() {}, update() {}, close() {} }, escape: { register() {}, unregister() {} },
    busy: () => false, stopReading() {}, addRecord() {}, balloon() {}, holdLabel: () => "",
    app: { orchestrate: async () => ({ ok: true }), onState() {} }
  });
  sent.length = 0;
  runner.start("menu");
  stop({ durationMs: 1000, bytes: 3200 });
  await heard;
  assert.equal(sent[0].body.model, "gemini-3.5-transcribe");
  assert.deepEqual([records[0].Provider, records[0].Model], ["Gemini", "gemini-3.5-transcribe"]);
});

test("the recording limit is the provider's", () => {
  const gemini7 = maxRecordingBytes({ maxRecordingMinutes: 60, tasks: { dictation: { provider: "Gemini" } } });
  const openAi = maxRecordingBytes({ maxRecordingMinutes: 60 });
  assert.equal(gemini7 / 32000 / 60, 7);
  assert.equal(openAi / 32000 / 60, 13);
});

// ---------- texts ----------
test("every task and text in both languages", () => {
  const i18n = require("../src/i18n");
  const page = fs.readFileSync(path.join(VOICE, "ui", "settings-models.js"), "utf8");
  const keys = [
    "settings.models", "voice.balloon.modelsReplaced", "voice.settings.models.keys", "voice.settings.models.tasks",
    ...Object.keys(TASKS).map(task => `voice.task.${task}`),
    ...[...page.matchAll(/"(voice\.settings\.[\w.]+)"/g)].map(m => m[1])
  ];
  const texts = {};
  for (const language of ["en", "bg"]) {
    i18n.setLanguage(language);
    texts[language] = keys.map(key => i18n.t(key));
    texts[language].forEach((text, i) => assert.notEqual(text, keys[i], `${language}: ${keys[i]}`));
  }
  const untranslated = keys.filter((key, i) => key.startsWith("voice.task.") && texts.en[i] === texts.bg[i]);
  assert.deepEqual(untranslated, []);
});

(async () => {
  let failed = 0;
  try {
    for (const [name, fn] of cases) {
      sent.length = 0;
      reply = null;
      try {
        await fn();
        console.log(`ok   ${name}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${name}\n${error.stack}`);
      }
    }
  } finally {
    await store.flush();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`voice models: ${cases.length - failed}/${cases.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
