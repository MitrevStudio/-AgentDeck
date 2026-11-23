// AgentDeck's own playback (read aloud, the history's player) stays out of a meeting's system sound.
// On Windows 11 getDisplayMedia's restrictOwnAudio records every output except Chromium's audio service, but by
// default that service mixes the playback of our other windows back in; the feature below is that mixing. It only
// changes such a capture: playback and the microphone are as they were.
const os = require("node:os");

const FEATURE = "RestrictOwnAudioAddChromiumBack";
const WINDOWS_11_BUILD = 22000; // Chromium has no process loopback before it

// Before app ready. A list that is already there is kept.
function excludeOwnPlayback(app) {
  if (process.platform !== "win32") return;
  const set = app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean);
  if (!set.includes(FEATURE)) app.commandLine.appendSwitch("disable-features", [...set, FEATURE].join(","));
}

const canExclude = () => process.platform === "win32" && Number(os.release().split(".")[2]) >= WINDOWS_11_BUILD;

module.exports = { excludeOwnPlayback, canExclude };
