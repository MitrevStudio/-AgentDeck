// The sound of the recording that runs: the capture page, kept alive, and the recording's clock - the samples.
// Whatever the page does not deliver while the computer is awake becomes silence, so the two channels and the
// screenshots stay on one time.
const { fail } = require("../errors");
const { CHANNELS, SAMPLE_RATE, FRAME_BYTES, FRAMES_PER_MS, msOf } = require("./format");

const TICK_MS = 1000;
const LATE_MS = 2000; // a tick this late says nothing about the page: main was held up, and its chunks wait
const SLEPT_MS = 5000; // one this late: the computer slept, and no sound is owed for that
const STALL_MS = 3000;
const STOP_TIMEOUT_MS = 1500;
// How long a channel may be without any sound, and what still counts as none (a peak).
const SILENT = {
  mic: { code: "meetingsMicSilent", frames: 20 * SAMPLE_RATE, peak: 0.0002 },
  system: { code: "meetingsSystemSilent", frames: 60 * SAMPLE_RATE, peak: 0.0001 } // nothing played is exact zeros
};
const LOST = { mic: "meetingsMicLost", system: "meetingsSystemLost" };
const REFUSED = { mic: "meetingsMicUnavailable", system: "meetingsSystemUnavailable" };

// openPage: capture-page.js's. warn(code, active, channel), onLevels({ elapsedMs, mic, system }), onMicrophone(device).
function createLive({ openPage, deviceId, warn, onLevels, onMicrophone, now = () => performance.now() }) {
  let page = null, sink = null, timer = null;
  let lastAt = 0, triedAt = 0, tickAt = 0;
  let gap = false, restarting = false, closed = false;
  const quiet = { mic: 0, system: 0 }, lost = { mic: false, system: false };

  // Asked also before the first tick after a sleep, so it takes the sleep out by itself.
  function owed() {
    if (!sink) return 0;
    const at = now(), late = at - tickAt;
    return Math.max(0, Math.round((at - lastAt - (late > SLEPT_MS ? late : 0)) * FRAMES_PER_MS));
  }
  const elapsedMs = () => (sink ? msOf(sink.frames + owed()) : 0);

  function setLost(channel, value) {
    lost[channel] = value;
    if (value) warn(SILENT[channel].code, false, channel); // that it is lost says more
    quiet[channel] = 0;
    warn(LOST[channel], value, channel);
  }

  function onChunk({ pcm, peaks }) {
    if (closed || !sink) return;
    const frames = pcm.byteLength / FRAME_BYTES;
    if (gap) {
      sink.silence(owed() - frames);
      gap = false;
      warn("meetingsCaptureLost", false);
    }
    sink.append(pcm);
    lastAt = now();
    const levels = { elapsedMs: msOf(sink.frames) };
    for (const [i, channel] of CHANNELS.entries()) {
      const { code, frames: limit, peak } = SILENT[channel];
      levels[channel] = peaks[i];
      quiet[channel] = peaks[i] > peak || lost[channel] ? 0 : quiet[channel] + frames;
      if (!lost[channel]) warn(code, quiet[channel] >= limit, channel);
    }
    onLevels(levels);
  }

  function openNext() {
    const own = openPage({
      on: {
        chunk: chunk => { if (page === own) onChunk(chunk); },
        source: ({ channel, lost: gone, microphone }) => {
          if (page !== own || closed || !Object.hasOwn(LOST, channel)) return;
          setLost(channel, Boolean(gone));
          if (microphone) onMicrophone(microphone);
        }
      },
      // One that dies again at once waits for the next tick.
      onGone: () => { if (page === own && sink && !gap) restart(); }
    });
    page = own;
    return own;
  }

  async function restart() {
    if (restarting || closed) return;
    restarting = true;
    gap = true;
    triedAt = now();
    warn("meetingsCaptureLost", true);
    try {
      page?.close();
      const next = openNext();
      const opened = await next.call("open", { deviceId, resume: true });
      if (closed) return;
      for (const channel of CHANNELS) setLost(channel, opened.lost.includes(channel));
      if (opened.microphone) onMicrophone(opened.microphone);
      await next.call("begin");
    } catch (error) {
      if (!closed) console.error("The meeting's capture did not restart:", error.message);
    } finally {
      restarting = false;
    }
  }

  function tick() {
    const at = now(), late = at - tickAt;
    tickAt = at;
    if (late > LATE_MS) {
      if (late > SLEPT_MS) lastAt = Math.min(at, lastAt + late);
      triedAt = at;
      return;
    }
    if (gap) onLevels({ elapsedMs: elapsedMs(), mic: 0, system: 0 });
    if (at - Math.max(lastAt, triedAt) > STALL_MS) restart();
  }

  // Both sources are opened before anything is created for the recording. -> the microphone.
  async function open() {
    let opened;
    try {
      opened = await openNext().call("open", { deviceId });
    } catch (error) {
      fail("meetingsCaptureFailed", error.message);
    }
    if (opened.failed) fail(REFUSED[opened.failed.channel] || "meetingsCaptureFailed", opened.failed.detail);
    return opened.microphone;
  }

  // file: recording-file.js's.
  async function begin(file) {
    sink = file;
    lastAt = triedAt = tickAt = now();
    try {
      await page.call("begin");
    } catch (error) {
      fail("meetingsCaptureFailed", error.message);
    }
    timer = setInterval(tick, TICK_MS);
  }

  // Everything that was heard is in the file when it resolves.
  async function stop() {
    clearInterval(timer);
    const flushed = !gap && await page.call("stop", {}, STOP_TIMEOUT_MS).then(() => true, () => false);
    if (!flushed && sink && !closed) sink.silence(owed());
    close();
  }

  function close() {
    closed = true;
    clearInterval(timer);
    page?.close();
  }

  return { open, begin, stop, close, elapsedMs };
}

module.exports = { createLive };
