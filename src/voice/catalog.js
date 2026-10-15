// Every model and voice the app offers (VoiceTray's SettingsWindow and SpeechService lists). The first entry of each
// list is what is used when nothing is chosen, so the fastest transcription model leads: Gemini 2.5-flash answered
// in about half the time of 3.5-transcribe and a third of 2.5-pro, with the same transcript.
const TRANSCRIPTION_MODELS = Object.freeze({
  OpenAI: Object.freeze(["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-4o-transcribe-diarize"]),
  Gemini: Object.freeze(["gemini-2.5-flash", "gemini-3.5-transcribe", "gemini-3.5-flash", "gemini-3.1-pro-preview",
    "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-pro"])
});

const SPEECH_MODELS = Object.freeze(["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"]);

// Gemini's prebuilt voices.
const VOICES = Object.freeze(["Kore", "Puck", "Charon", "Zephyr", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
  "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia",
  "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia",
  "Sadaltager", "Sulafat"]);

// The character Google gives each prebuilt voice; the Settings page shows it as t("voice.catalog.style.<id>").
const VOICE_STYLES = Object.freeze({
  Kore: "firm", Puck: "upbeat", Charon: "informative", Zephyr: "bright", Fenrir: "excitable", Leda: "youthful",
  Orus: "firm", Aoede: "breezy", Callirrhoe: "easyGoing", Autonoe: "bright", Enceladus: "breathy", Iapetus: "clear",
  Umbriel: "easyGoing", Algieba: "smooth", Despina: "smooth", Erinome: "clear", Algenib: "gravelly",
  Rasalgethi: "informative", Laomedeia: "upbeat", Achernar: "soft", Alnilam: "firm", Schedar: "even", Gacrux: "mature",
  Pulcherrima: "forward", Achird: "friendly", Zubenelgenubi: "casual", Vindemiatrix: "gentle",
  Sadachbia: "lively", Sadaltager: "knowledgeable", Sulafat: "warm"
});

const defaultModelFor = provider => (TRANSCRIPTION_MODELS[provider] || TRANSCRIPTION_MODELS.OpenAI)[0];

// The text model that rewrites a transcript (clean-up, prompt) on each provider: fast and cheap, since it runs after
// every such dictation, before anything is pasted.
const REWRITE_MODELS = Object.freeze({ Gemini: "gemini-3.1-flash-lite", OpenAI: "gpt-4.1-mini" });

module.exports = {
  TRANSCRIPTION_MODELS, SPEECH_MODELS, VOICES, VOICE_STYLES, REWRITE_MODELS, defaultModelFor,
  DEFAULT_SPEECH_MODEL: SPEECH_MODELS[0], DEFAULT_VOICE: VOICES[0]
};
