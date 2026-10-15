// Microphone capture. Port of VoiceTray's AudioRecorderService: 16 kHz mono 16-bit in 50 ms buffers, a byte cap
// that stops the recording by itself (what was captured is still transcribed), and the microphone resolved from
// the saved choice.
//
// Chromium captures in a hidden window (ui/recorder.html); this process receives Int16 chunks and writes the WAV,
// so a crashed capture page still leaves a properly closed file.
const { BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { createWavWriter, BYTES_PER_SECOND } = require("./wav");
const { toBuffer } = require("./util");
const { t } = require("../i18n");

// Anything shorter is a mis-tap, not speech (VoiceTray's MinimumRecordingSeconds). The caller drops those.
const MIN_DURATION_MS = 300;
// Own persistent session: the media permission stays off the app's other windows, and Chromium's device-id salt is
// kept on disk, so a saved deviceId still matches after a restart.
const PARTITION = "persist:voice-recorder";
const VIRTUAL_IDS = new Set(["default", "communications"]);
const CALL_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;
// Why a recording ended before the user stopped it; what was captured up to then is kept.
const ENDED = { device: "voice.errors.mic.disconnected", crash: "voice.errors.mic.pageCrashed", disk: "voice.errors.mic.diskFull" };

const norm = s => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

// Saved deviceId first; then the name, where VoiceTray's WinMM names were cut to 31 characters ("Microphone (Realtek
// High Defini"), hence prefix and then substring matches; else the system default.
function resolveDevice(devices, { deviceId, deviceName } = {}) {
  if (deviceId) {
    const byId = devices.find(d => d.deviceId === deviceId);
    if (byId) return { ...byId, matchedBy: "id" };
  }
  const name = norm(deviceName);
  if (name) {
    const real = devices.filter(d => !VIRTUAL_IDS.has(d.deviceId));
    const label = d => norm(d.label);
    const hit = real.find(d => label(d) === name) || real.find(d => label(d).startsWith(name)) || real.find(d => label(d).includes(name));
    if (hit) return { ...hit, matchedBy: "name" };
  }
  const fallback = devices.find(d => d.deviceId === "default") || devices[0];
  return { deviceId: fallback?.deviceId || "", label: fallback?.label || "", matchedBy: "default" };
}

function describeMediaError(e) {
  switch (e?.name) {
    case "NotAllowedError": return t("voice.errors.mic.denied");
    case "NotFoundError":
    case "OverconstrainedError": return t("voice.errors.mic.notFound");
    case "NotReadableError":
    case "AbortError": return t("voice.errors.mic.busy");
    default: return e?.message || t("voice.errors.mic.cannotOpen");
  }
}

function createRecorder({ preloadPath = path.join(__dirname, "ui", "recorder-preload.js") } = {}) {
  let win = null;
  let ready = null;
  let nextCall = 1;
  let nextSession = 1;
  let cur = null;
  let destroyed = false;
  const calls = new Map();

  const alive = () => Boolean(win && !win.isDestroyed());
  const isOurs = e => alive() && e.sender === win.webContents;

  function failCalls(error) {
    for (const [id, c] of calls) { clearTimeout(c.timer); c.reject(error); calls.delete(id); }
  }

  function ensureWindow() {
    if (alive()) return ready;
    if (destroyed) return Promise.reject(new Error("recorder destroyed")); // e.g. Settings listing microphones at quit
    const w = new BrowserWindow({
      show: false, width: 200, height: 100, skipTaskbar: true, focusable: false, title: "Voice recorder",
      webPreferences: { preload: preloadPath, partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    const ses = w.webContents.session;
    ses.setPermissionRequestHandler((_wc, permission, cb, details) =>
      cb(permission === "media" && (details?.mediaTypes || []).every(t => t === "audio")));
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => permission === "media" && details?.mediaType !== "video");
    const drop = () => {
      if (win === w) { win = null; ready = null; }
      if (!w.isDestroyed()) w.destroy();
    };
    w.webContents.on("render-process-gone", () => {
      drop();
      failCalls(new Error(t("voice.errors.mic.pageCrashed")));
      if (cur) endedEarly(cur, "crash");
    });
    win = w;
    // A page that did not load is thrown away, so the next recording gets a fresh one instead of this failure.
    ready = w.loadFile(path.join(__dirname, "ui", "recorder.html")).catch(e => { drop(); throw e; });
    return ready;
  }

  async function call(cmd, args, timeoutMs = CALL_TIMEOUT_MS) {
    await ensureWindow();
    const w = win;
    if (!w || w.isDestroyed()) throw new Error(t("voice.errors.mic.pageCrashed"));
    const id = nextCall++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(id); reject(new Error(`recorder ${cmd}: no answer`)); }, timeoutMs);
      calls.set(id, { resolve, reject, timer });
      w.webContents.send("voice:rec-cmd", { id, cmd, args });
    });
  }

  function onReply(e, id, ok, result) {
    if (!isOurs(e)) return;
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id);
    clearTimeout(c.timer);
    if (ok) c.resolve(result);
    else c.reject(Object.assign(new Error(result?.message || "recorder error"), { name: result?.name || "Error" }));
  }

  function onChunk(e, session, pcm, peak) {
    if (!isOurs(e)) return;
    const c = cur;
    if (!c || c.session !== session || c.finishing) return;
    let buf = toBuffer(pcm);
    let hit = false;
    // Cut at the cap exactly rather than a buffer past it; the provider limits already allow a second of slack.
    if (c.maxBytes > 0 && c.writer.bytes + buf.length >= c.maxBytes) {
      buf = buf.subarray(0, Math.max(0, c.maxBytes - c.writer.bytes));
      hit = true;
    }
    try { c.writer.write(buf); } catch { return endedEarly(c, "disk"); }
    try { c.onLevel?.(Math.min(1, Math.max(0, Number(peak) || 0)), c.writer.bytes / BYTES_PER_SECOND); } catch {}
    if (hit) {
      c.stoppedByLimit = true;
      settle(c, c.onLimit);
    }
  }

  // The recording ended by itself (device unplugged, capture page crashed, disk full): what was captured is kept and
  // transcribed - VoiceTray warned, then transcribed.
  function endedEarly(c, why) {
    if (c.finishing) return;
    c.endedBy = why;
    settle(c, c.onEnded);
  }

  // The caller hears about a recording that stopped by itself in every case, with null if nothing could be kept.
  function settle(c, callback) {
    finish(c).catch(() => null).then(r => callback?.(r)).catch(e => console.error("Recording callback failed:", e));
  }

  function onEvent(e, session, type) {
    if (!isOurs(e)) return;
    if (type === "ended" && cur && cur.session === session) endedEarly(cur, "device");
  }

  ipcMain.on("voice:rec-reply", onReply);
  ipcMain.on("voice:rec-chunk", onChunk);
  ipcMain.on("voice:rec-event", onEvent);

  // Never rejects: a WAV that cannot be closed comes back as {failed: true, error}.
  function finish(c) {
    c.finishing ??= (async () => {
      try {
        try { await c.started; } catch { return null; } // start() already cleaned up and threw
        // A dead capture page has nothing left to flush, and asking it would only start a new one.
        if (alive()) try { await call("stop", { session: c.session }, STOP_TIMEOUT_MS); } catch {}
        try {
          const { bytes, durationMs } = c.writer.close();
          return {
            wavPath: c.wavPath, bytes, durationMs, tooShort: durationMs < MIN_DURATION_MS,
            stoppedByLimit: c.stoppedByLimit, error: ENDED[c.endedBy] ? t(ENDED[c.endedBy]) : null
          };
        } catch (e) {
          c.writer.discard();
          return { wavPath: c.wavPath, bytes: 0, durationMs: 0, failed: true, error: t("voice.errors.mic.saveFailed", { error: e.message }) };
        }
      } finally {
        if (cur === c) cur = null;
      }
    })();
    return c.finishing;
  }

  async function listDevices() {
    return call("list");
  }

  // Resolves with the device actually opened once audio is flowing ({deviceId, label, matchedBy: "id" | "name" |
  // "default"}), or null if cancel() came first; rejects (file removed) if the microphone cannot be opened.
  // onLevel(peak 0..1, elapsedSeconds) ~20×/s; onLimit / onEnded get stop()'s result when the recording ended by
  // itself (the cap; a lost device, a crashed capture page or a full disk).
  async function start({ deviceId, deviceName, wavPath, maxBytes = 0, onLevel, onLimit, onEnded } = {}) {
    if (destroyed) throw new Error("recorder destroyed");
    // One being stopped or cancelled lets go of the microphone first: Esc and the hotkey again a moment later.
    while (cur?.finishing) await cur.finishing;
    if (cur) throw new Error(t("voice.errors.mic.alreadyRecording"));
    if (!wavPath) throw new Error("wavPath is required");
    const c = {
      session: nextSession++, wavPath, maxBytes: Math.max(0, Number(maxBytes) || 0), onLevel, onLimit, onEnded,
      writer: null, started: null, finishing: null, stoppedByLimit: false, endedBy: null, cancelled: false
    };
    cur = c;
    c.started = (async () => {
      const pick = resolveDevice(await listDevices(), { deviceId, deviceName });
      // Created before capture starts, like VoiceTray: the first chunk must have somewhere to go.
      c.writer = createWavWriter(wavPath);
      try {
        const info = await call("start", { session: c.session, deviceId: pick.deviceId });
        return { deviceId: info.deviceId || pick.deviceId, label: info.label || pick.label, matchedBy: pick.matchedBy };
      } catch (e) {
        // The device vanished between listing and opening: the default one is better than no recording.
        if (!["NotFoundError", "OverconstrainedError"].includes(e.name) || !pick.deviceId || pick.deviceId === "default") throw e;
        const info = await call("start", { session: c.session, deviceId: "" });
        return { deviceId: info.deviceId, label: info.label, matchedBy: "default" };
      }
    })();
    try {
      const info = await c.started;
      return c.cancelled ? null : info; // cancelled while the device was opening
    } catch (e) {
      if (cur === c) cur = null;
      c.writer?.discard();
      throw Object.assign(new Error(describeMediaError(e)), { name: e.name, cause: e });
    }
  }

  // → { wavPath, bytes, durationMs, tooShort, stoppedByLimit, error, failed? }, or null when nothing was recording.
  async function stop() {
    return cur ? finish(cur) : null;
  }

  // Stops and throws the audio away. A recording already stopping by itself (cap reached) is left to finish.
  async function cancel() {
    const c = cur;
    if (!c || c.finishing) return;
    c.cancelled = true;
    c.finishing = (async () => {
      try {
        try { await c.started; } catch {}
        if (alive()) try { await call("cancel", { session: c.session }, STOP_TIMEOUT_MS); } catch {}
        c.writer?.discard();
      } finally {
        if (cur === c) cur = null;
      }
      return null;
    })();
    await c.finishing;
  }

  // Immediate: a recording in progress is dropped without waiting for its microphone to finish opening.
  function destroy() {
    destroyed = true;
    ipcMain.removeListener("voice:rec-reply", onReply);
    ipcMain.removeListener("voice:rec-chunk", onChunk);
    ipcMain.removeListener("voice:rec-event", onEvent);
    failCalls(new Error("recorder destroyed"));
    if (cur?.writer && !cur.finishing) cur.writer.discard();
    cur = null;
    if (alive()) win.destroy();
    win = null;
    ready = null;
  }

  return {
    listDevices, start, stop, cancel, destroy,
    // Opens the hidden window ahead of the first recording, so the first press does not pay for it.
    warmUp: () => ensureWindow().then(() => true, () => false)
  };
}

module.exports = { createRecorder, resolveDevice, MIN_DURATION_MS };
