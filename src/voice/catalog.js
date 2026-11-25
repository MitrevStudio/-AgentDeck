// Every model the app knows, described by what it can do, and the voices. The code asks here what a request may
// carry, what a task's default is and what replaces a model that stops; it never reads anything out of a model's name.
// Checked against the providers' documentation (models, parameters, prices, deprecations) on 2026-11-22, Soniox's on
// 2026-11-25.
//
// A model: tasks (what it is suitable for), api (the endpoint), thinking ({levels}, the least first, or {budget} for
// the models that take tokens instead), temperature (the request may carry one), language and vocabulary (the field
// they go in), timestamps ("word"; "prompted" and "none" are approximate), limits, price (USD per 1M tokens or per
// minute of audio, each from its date), shutdown (the date it stops or is re-routed), rerouted (it already is),
// successor, unlisted (known, not offered). A model with a successor is never offered.
const CHECKED = "2026-11-22";
// Raised whenever a model gets a successor: settings saved before that move to it, once (settings.js).
const REVISION = 1;

const TEXT = ["rewrite", "edit", "ask", "meetingSummary"];
const SPEECH = ["dictation", "commands", "meetingTranscription"];
const GENERAL = [...SPEECH, ...TEXT];

const UP_TO_HIGH = { levels: ["low", "medium", "high"] };
const UP_TO_XHIGH = { levels: ["low", "medium", "high", "xhigh"] };
const FROM_MINIMAL = { levels: ["minimal", "low", "medium", "high"] };
const FROM_NONE = { levels: ["none", "low", "medium", "high", "xhigh", "max"] };
const NO_BUDGET = { budget: 0 };

const tokens = (input, output, from = CHECKED) => ({ from, input, output });
const FLASH_PRICE = [tokens(0.75, 3.75), tokens(1.5, 7.5, "2027-01-01")];

const generate = {
  api: "generateContent", vocabulary: "prompt", timestamps: "prompted",
  limits: { inputTokens: 1_048_576, outputTokens: 65_536, audioSeconds: 34_200, audioTokensPerSecond: 32 }
};
const transcriptions = {
  api: "transcriptions", tasks: SPEECH, language: "language", vocabulary: "prompt", timestamps: "none",
  limits: { uploadBytes: 25_000_000 }
};
const chat = { api: "chat", tasks: TEXT, limits: { inputTokens: 922_000, outputTokens: 128_000 } };
const speech = { api: "interactions", tasks: ["readAloud"] };
// Soniox: a file is uploaded, transcribed as a job and fetched; a file may be 300 minutes long.
const SONIOX_CHECKED = "2026-11-25";
const fileJob = {
  api: "async", tasks: SPEECH, language: "language_hints", vocabulary: "context", timestamps: "word",
  limits: { audioSeconds: 18_000 }
};
// OpenAI's older models, with the day they stop.
const speechUntil = shutdown => ({ ...transcriptions, shutdown, successor: "gpt-transcribe" });
const chatUntil = shutdown => ({ api: "chat", tasks: TEXT, temperature: true, shutdown, successor: "gpt-6-luna" });

const MODELS = Object.freeze({
  OpenAI: Object.freeze({
    "gpt-transcribe": { ...transcriptions, language: "languages", vocabulary: "keywords", price: [{ from: CHECKED, perMinute: 0.0045 }] },
    "gpt-6-luna": { ...chat, thinking: FROM_NONE, temperature: true, price: [tokens(0.1, 0.5)] },
    "gpt-6.1-terra": { ...chat, thinking: FROM_NONE, temperature: true, price: [tokens(1, 5)] },
    // Its levels are not listed: "none" is refused, "low" and "medium" are the ones its guide names.
    "gpt-6.2-sol": { ...chat, thinking: { levels: ["low", "medium"] }, price: [tokens(2, 10)] },

    "whisper-1": { ...speechUntil("2027-02-26"), timestamps: "word" },
    "gpt-4o-transcribe": speechUntil("2027-02-26"),
    "gpt-4o-mini-transcribe": speechUntil("2027-02-26"),
    "gpt-4o-mini-transcribe-2025-03-20": speechUntil("2027-01-20"),
    "gpt-4o-mini-transcribe-2025-12-15": speechUntil("2027-02-26"),
    "gpt-4o-transcribe-diarize": { ...speechUntil("2027-02-26"), vocabulary: null }, // takes no prompt
    "gpt-4.1": chatUntil("2027-01-14"),
    "gpt-4.1-2025-04-14": chatUntil("2027-01-14"),
    "gpt-4.1-mini": chatUntil("2027-01-14"),
    "gpt-4.1-mini-2025-04-14": chatUntil("2027-01-14"),
    "gpt-4o-mini": chatUntil("2027-01-14"),
    "gpt-4o-mini-2024-07-18": chatUntil("2027-01-14")
  }),
  Gemini: Object.freeze({
    "gemini-3.5-transcribe": {
      api: "interactions", tasks: SPEECH, language: "language_codes", vocabulary: "custom_vocabulary", timestamps: "word",
      limits: { audioSeconds: 3600, timedAudioSeconds: 1800, vocabularyTerms: 1000, audioTokensPerSecond: 25 },
      price: [tokens(2, 12)]
    },
    "gemini-3.5-flash-lite": { ...generate, tasks: GENERAL, thinking: FROM_MINIMAL, price: [tokens(0.3, 2.5)] },
    "gemini-3.8-flash": { ...generate, tasks: GENERAL, thinking: UP_TO_HIGH, price: FLASH_PRICE },
    "gemini-3.6-flash": { ...generate, tasks: GENERAL, thinking: FROM_MINIMAL, price: FLASH_PRICE },
    "gemini-4-hydrogen": { ...generate, tasks: TEXT, thinking: UP_TO_XHIGH, price: [tokens(1.5, 7.5)] },
    "gemini-4-neon": { ...generate, tasks: TEXT, thinking: UP_TO_XHIGH, price: [tokens(3, 15)] },
    "gemini-4-carbon": { ...generate, tasks: TEXT, thinking: UP_TO_HIGH, price: [tokens(2, 10), tokens(4, 20, "2026-12-01")] },
    "gemini-3.8-flash-tts": { ...speech, price: [tokens(0.5, 9), tokens(1, 18, "2027-01-01")] },
    "gemini-3.8-flash-lite-tts": { ...speech, price: [tokens(0.5, 6), tokens(1, 12, "2027-01-01")] },

    "gemini-3.5-flash": { ...generate, tasks: GENERAL, thinking: FROM_MINIMAL, rerouted: true, successor: "gemini-3.6-flash" },
    "gemini-3.7-flash": { ...generate, tasks: GENERAL, thinking: UP_TO_HIGH, rerouted: true, successor: "gemini-3.8-flash" },
    "gemini-3.1-pro-preview": { ...generate, tasks: GENERAL, thinking: UP_TO_HIGH, temperature: true, unlisted: true },
    // Deprecated with no shutdown date announced and not re-routed: it still answers, so what is saved stays on it; it
    // is only no longer offered.
    "gemini-3-flash-preview": { ...generate, tasks: GENERAL, thinking: FROM_MINIMAL, temperature: true, successor: "gemini-3.6-flash" },
    "gemini-3.1-flash-lite": { ...generate, tasks: GENERAL, thinking: FROM_MINIMAL, temperature: true, shutdown: "2027-05-07", successor: "gemini-3.5-flash-lite" },
    "gemini-3.1-flash-lite-preview": { ...generate, tasks: GENERAL, shutdown: "2026-05-25", successor: "gemini-3.1-flash-lite" },
    "gemini-2.5-flash": { ...generate, tasks: GENERAL, thinking: NO_BUDGET, temperature: true, shutdown: "2026-12-01", successor: "gemini-3.5-flash-lite" },
    "gemini-2.5-flash-lite": { ...generate, tasks: GENERAL, thinking: NO_BUDGET, temperature: true, unlisted: true },
    "gemini-2.5-pro": { ...generate, tasks: GENERAL, temperature: true, shutdown: "2026-12-01", successor: "gemini-3.8-flash" },
    "gemini-2.0-flash": { ...generate, tasks: GENERAL, shutdown: "2026-06-01", successor: "gemini-3.6-flash" },
    "gemini-2.0-flash-lite": { ...generate, tasks: GENERAL, shutdown: "2026-06-01", successor: "gemini-3.1-flash-lite" },
    "gemini-3.1-flash-tts-preview": { ...speech, shutdown: "2026-12-18", successor: "gemini-3.8-flash-tts" },
    "gemini-2.5-flash-preview-tts": { ...speech, shutdown: "2026-12-18", successor: "gemini-3.8-flash-tts" },
    "gemini-2.5-pro-preview-tts": { ...speech, shutdown: "2026-12-18", successor: "gemini-3.8-flash-tts" }
  }),
  // Only hears and speaks: it has no text models.
  Soniox: Object.freeze({
    "stt-async-v6": { ...fileJob, price: [{ from: SONIOX_CHECKED, perMinute: 0.1 / 60 }] },
    "tts-rt-v2": { api: "tts", tasks: ["readAloud"], price: [tokens(4, 21.5, SONIOX_CHECKED)] },

    "stt-async-v5": { ...fileJob, shutdown: "2026-12-15", successor: "stt-async-v6" }
  })
});
const PROVIDERS = Object.freeze(Object.keys(MODELS));

// An id the catalog does not know gets only what every model of that provider takes: no thinking, no temperature.
const CUSTOM = Object.freeze({
  OpenAI: { language: "language", vocabulary: "prompt", timestamps: "none" },
  Gemini: { api: "generateContent", vocabulary: "prompt", timestamps: "prompted" },
  Soniox: { api: "async", language: "language_hints", vocabulary: "context", timestamps: "word" }
});

// provider: the task's default, "" = the dictation's (sameModel: with the dictation's model as well). models: each
// provider's default; a provider without one cannot do the task.
const SPEECH_DEFAULTS = Object.freeze({ OpenAI: "gpt-transcribe", Gemini: "gemini-3.5-flash-lite", Soniox: "stt-async-v6" });
const TEXT_DEFAULTS = Object.freeze({ OpenAI: "gpt-6-luna", Gemini: "gemini-3.5-flash-lite" });
const TASKS = Object.freeze({
  dictation: { provider: "OpenAI", models: SPEECH_DEFAULTS },
  commands: { provider: "", sameModel: true, models: SPEECH_DEFAULTS },
  rewrite: { provider: "", models: TEXT_DEFAULTS },
  edit: { provider: "", models: TEXT_DEFAULTS },
  ask: { provider: "", models: TEXT_DEFAULTS },
  readAloud: { provider: "Gemini", models: { Gemini: "gemini-3.8-flash-tts", Soniox: "tts-rt-v2" } },
  meetingTranscription: { provider: "Gemini", models: { OpenAI: "gpt-transcribe", Gemini: "gemini-3.5-transcribe", Soniox: "stt-async-v6" } },
  meetingSummary: { provider: "Gemini", models: { OpenAI: "gpt-6-luna", Gemini: "gemini-3.8-flash" } }
});

const providerName = value => PROVIDERS.find(p => p.toLowerCase() === String(value || "").toLowerCase());

// By the exact id, whatever its case: a dated id has an entry of its own.
function find(provider, id) {
  const models = MODELS[providerName(provider)], key = String(id || "").trim().toLowerCase();
  return models && Object.hasOwn(models, key) ? models[key] : null;
}
// What a model can do. A dated id the catalog does not list ("gemini-3.5-transcribe-2026-08-01", typed as another id)
// goes where its base id goes and is asked the same way; what a snapshot may not take (thinking, temperature), its
// price and its dates are not assumed.
const DATED = /-\d{4}-\d{2}-\d{2}$/;
const SHAPE = ["api", "tasks", "language", "vocabulary", "timestamps", "limits"];
function traits(provider, id) {
  const own = find(provider, id);
  if (own || !DATED.test(String(id || "").trim())) return own;
  const base = find(provider, String(id).trim().replace(DATED, ""));
  return base && Object.fromEntries(SHAPE.filter(key => Object.hasOwn(base, key)).map(key => [key, base[key]]));
}
const modelInfo = (provider, id) => ({ ...CUSTOM[providerName(provider)], ...traits(provider, id) });

// What answers for `id` on `day` ("2027-01-14"): itself until it stops or is re-routed, then its successor. LAST_DAY
// asks what it ends up as, which is where saved settings move.
const LAST_DAY = "9999-12-31";
function currentModel(provider, id, day = new Date().toISOString().slice(0, 10)) {
  let model = String(id || "").trim(), m;
  while ((m = find(provider, model))?.successor && (m.rerouted || m.shutdown <= day)) model = m.successor;
  return model;
}

// The models offered for a task on a provider, its default first.
function choices(task, provider) {
  const first = TASKS[task].models[provider];
  if (!first) return [];
  const offered = ([id, m]) => id !== first && m.tasks.includes(task) && !m.successor && !m.unlisted;
  return [first, ...Object.entries(MODELS[provider]).filter(offered).map(([id]) => id)];
}

// What does a task: settings.load() and, for one run, an override of either part -> { provider, model }. A provider
// named without a model gets the task's model on that provider. A named provider is never swapped for another one: a
// name nobody knows comes back as given, for the request to refuse. Only the dictation's provider, followed by a
// task it has no model for (Soniox writes no text), gives way to the task's first.
function resolveTask(settings, task, override = {}) {
  const spec = TASKS[task];
  if (!spec) throw new Error(`unknown task "${task}"`);
  const own = settings?.tasks?.[task] || {};
  const named = override.provider || own.provider || spec.provider;
  const chosen = named || resolveTask(settings, "dictation").provider;
  let provider = providerName(chosen) || chosen;
  if (!named && !spec.models[provider]) provider = Object.keys(spec.models)[0];
  const saved = (spec.sameModel && !own.provider ? settings?.tasks?.dictation : own)?.models;
  const model = String(override.model || "").trim() || saved?.[provider] || spec.models[provider];
  return { provider, model: currentModel(provider, model) };
}

// The voices of each provider that reads aloud, its default first: Gemini's prebuilt ones, Soniox's built-in ones
// (every one of them speaks every language).
const GEMINI_VOICES = Object.freeze(["Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
  "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia",
  "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia",
  "Sadaltager", "Sulafat"]);
const SONIOX_VOICES = Object.freeze(["Maya", "Daniel", "Noah", "Nina", "Emma", "Jack", "Adrian", "Claire", "Grace",
  "Owen", "Mina", "Kenji", "Rafael", "Mateo", "Lucia", "Sofia", "Oliver", "Arthur", "Isla", "Victoria", "Cooper",
  "Mason", "Ruby", "Elise", "Arjun", "Rohan", "Priya", "Meera"]);
const VOICES = Object.freeze({ Gemini: GEMINI_VOICES, Soniox: SONIOX_VOICES });

// What tells the voices apart, shown by the Settings page as t("voice.catalog.style.<id>"), several joined: the
// character Google gives each prebuilt voice; of Soniox's, whose voice it is and its accent in English.
const VOICE_STYLES = Object.freeze({
  Kore: "firm", Puck: "upbeat", Charon: "informative", Zephyr: "bright", Fenrir: "excitable", Leda: "youthful",
  Orus: "firm", Aoede: "breezy", Callirrhoe: "easyGoing", Autonoe: "bright", Enceladus: "breathy", Iapetus: "clear",
  Umbriel: "easyGoing", Algieba: "smooth", Despina: "smooth", Erinome: "clear", Algenib: "gravelly",
  Rasalgethi: "informative", Laomedeia: "upbeat", Achernar: "soft", Alnilam: "firm", Schedar: "even", Gacrux: "mature",
  Pulcherrima: "forward", Achird: "friendly", Zubenelgenubi: "casual", Vindemiatrix: "gentle",
  Sadachbia: "lively", Sadaltager: "knowledgeable", Sulafat: "warm",
  ...Object.fromEntries([
    ["female", "Maya Nina Emma Claire Grace Mina"], ["male", "Daniel Noah Jack Adrian Owen Kenji"],
    ["female spanish", "Lucia Sofia"], ["male spanish", "Rafael Mateo"],
    ["female british", "Isla Victoria"], ["male british", "Oliver Arthur"],
    ["female australian", "Ruby Elise"], ["male australian", "Cooper Mason"],
    ["female indian", "Priya Meera"], ["male indian", "Arjun Rohan"]
  ].flatMap(([styles, names]) => names.split(" ").map(name => [name, styles.split(" ")])))
});

// The voice a reading on `provider` uses: the saved one, else the provider's first. Gemini's is `readAloudVoice`, the
// name it had while only Gemini read: a version from then that shares the settings keeps sending it to Gemini, so no
// other provider's voice may ever be in it. The others' are in `readAloudVoices`.
const savedVoice = (settings, provider) =>
  String((provider === "Gemini" ? settings?.readAloudVoice : settings?.readAloudVoices?.[provider]) || "").trim();
const voiceFor = (settings, provider) => savedVoice(settings, provider) || VOICES[provider]?.[0] || "";

module.exports = {
  MODELS, PROVIDERS, TASKS, REVISION, LAST_DAY, providerName, modelInfo, currentModel, choices, resolveTask,
  VOICES, VOICE_STYLES, voiceFor
};
