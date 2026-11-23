// What the meetings answer with when they cannot do what they were asked: a HostError, so a code that the window
// shows as `errors.<code>` in the user's language, with the English text here for logs. `detail` is the path (or what
// git, the file system or the provider said) behind it.
const { HostError } = require("../host/errors");

const MESSAGES = {
  meetingsNotLocal: "Meetings are only for a project in a folder of this computer.",
  meetingsHomeFolder: "The home folder cannot be a project with meetings: its skills are the user's own.",
  meetingsNoMainCheckout: "The main checkout of this worktree was not found, and meetings cannot be kept in a worktree.",
  meetingsLinkedPath: "A link or junction is in the way of the meetings' folder.",
  meetingsForeignFiles: "Files that AgentDeck did not write are where the meetings or their skill go.",
  meetingsTracked: "Git tracks files where the meetings or their skill go.",
  meetingsNotIgnored: "Git would not ignore the meetings or their skill.",
  meetingsGitFailed: "Git could not say whether the meetings stay out of the repository.",
  meetingsNotFound: "The meeting or its file is not there.",
  meetingsBroken: "The meeting's meeting.json cannot be read.",
  meetingsTrashFailed: "It could not be moved to the Recycle Bin.",
  meetingsDiskFull: "The disk is full.",
  meetingsFileFailed: "The meetings' files could not be read or written.",
  // Processing (pipeline.js): why it did not run or stopped, why a part is a gap, what a finished one warns of.
  meetingsBusy: "The meeting is being processed already.",
  meetingsInterrupted: "Processing was interrupted; a retry pays for no answer twice.",
  meetingsModelUnsuitable: "The chosen model cannot do this.",
  meetingsModelRetired: "The model this was begun with has stopped; another model is a new run, paid again.",
  meetingsNoAudio: "The meeting has no audio to transcribe.",
  meetingsAudioUnreadable: "The meeting's audio could not be read.",
  meetingsAudioChanged: "The meeting's audio is not the one its transcription began with; process it again.",
  meetingsNoKey: "No API key is set for the chosen provider.",
  meetingsKeyRefused: "The provider refused the API key.",
  meetingsQuota: "The provider's quota is used up.",
  meetingsRateLimited: "The provider limits the requests.",
  meetingsNetwork: "The provider could not be reached.",
  meetingsProviderDown: "The provider failed.",
  meetingsModelMissing: "The provider does not offer the chosen model to this key.",
  meetingsRequestRefused: "The provider refused the request.",
  meetingsBadAnswer: "The provider's answer could not be used.",
  meetingsPartsFailed: "Parts of the meeting are not transcribed.",
  meetingsNoSpeech: "No speech was found in the recording.",
  meetingsNoTranscript: "The meeting has no transcript to summarise.",
  meetingsTooLong: "The transcript is longer than the model takes.",
  meetingsNotText: "The transcript holds something that is not text.",
  meetingsSummaryInvalid: "The summary the model returned could not be used.",
  meetingsUnexpected: "The meeting could not be processed.",
  // Recording (recorder.js, audio.js): why it did not start, what it warns of while it runs, what is left to say after.
  meetingsWindowsOnly: "Meetings can be recorded on Windows only.",
  meetingsAlreadyRecording: "A meeting is being recorded already.",
  meetingsNotRecording: "No meeting is being recorded.",
  meetingsStillRecording: "The meeting is still being recorded.",
  meetingsMicUnavailable: "The microphone could not be opened.",
  meetingsSystemUnavailable: "The system sound could not be captured.",
  meetingsCaptureFailed: "The recording could not start.",
  meetingsMicLost: "The microphone is gone; silence is recorded until it is back.",
  meetingsSystemLost: "The system sound is gone; silence is recorded until it is back.",
  meetingsMicSilent: "The microphone records only silence.",
  meetingsSystemSilent: "No system sound has been heard for a minute.",
  meetingsCaptureLost: "The recording stopped getting sound and is being restarted.",
  meetingsDiskLow: "Less than 1 GB is free for the recording.",
  meetingsLongRecording: "The recording is longer than four hours.",
  meetingsShortcutTaken: "The screenshot key is taken; screenshots need the button.",
  meetingsShortcutInvalid: "The screenshot key is not a valid one; screenshots need the button.",
  meetingsScreenMissing: "The chosen screen is not connected.",
  meetingsScreenBlank: "The screen gives no picture: it is locked or not shown.",
  meetingsScreenFailed: "The screenshot could not be saved.",
  meetingsRecordingInterrupted: "The recording was interrupted; what was recorded until then is kept.",
  meetingsRecordingEmpty: "Nothing was recorded.",
  meetingsCompressionFailed: "The audio could not be compressed; it is kept as recorded."
};

function fail(code, detail = "") {
  throw Object.assign(new HostError(code, MESSAGES[code]), { detail: String(detail) });
}
// A failed file system call as one of the codes; anything else is a bug and stays what it is.
function fromFs(e) {
  if (!e?.syscall) throw e;
  fail(e.code === "ENOSPC" ? "meetingsDiskFull" : "meetingsFileFailed", e.message);
}

module.exports = { MESSAGES, fail, fromFs };
