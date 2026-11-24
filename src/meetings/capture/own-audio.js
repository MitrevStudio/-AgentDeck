// AgentDeck's own playback (read aloud, the history's player) and a meeting's system sound.
// On Windows 11 getDisplayMedia's restrictOwnAudio is meant to record every output except Chromium's audio service,
// and by default that service mixes the playback of our other windows back in; the feature below is that mixing. It
// only changes such a capture: playback and the microphone are as they were.
//
// restrictOwnAudio is not asked for. Measured 2026-11-24 (Electron 44.7.2, Windows 11 build 26200, Bluetooth
// headphones as the default and the communications output, a call playing): its capture ("loopbackWithoutChrome") was
// exact zeros for as long as it ran, with the feature below on and off, while the plain loopback beside it had the
// sound. A recording without the others is worse than one with our own sound in it.
const FEATURE = "RestrictOwnAudioAddChromiumBack";

// Before app ready. A list that is already there is kept.
function excludeOwnPlayback(app) {
  if (process.platform !== "win32") return;
  const set = app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean);
  if (!set.includes(FEATURE)) app.commandLine.appendSwitch("disable-features", [...set, FEATURE].join(","));
}

// Whether the system sound is recorded without our own: nowhere, until restrictOwnAudio is seen to deliver sound on
// real outputs.
const canExclude = () => false;

module.exports = { excludeOwnPlayback, canExclude };
