// Hidden capture page: microphone -> 16 kHz Int16 chunks for the main process, which writes the WAV.
// Commands run one at a time, so a stop that arrives while the device is still opening waits for it.
const api = window.voiceRec;
// Raw signal, like WinMM in VoiceTray: the providers do better with it than with the browser's voice-call processing.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

let cur = null;
let queue = Promise.resolve();

async function teardown() {
  const c = cur;
  cur = null;
  if (!c) return;
  try { c.source.disconnect(); } catch {}
  c.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  try { await c.ctx.close(); } catch {}
}

async function list() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === "audioinput").map(d => ({ deviceId: d.deviceId, label: d.label }));
}

async function start({ session, deviceId }) {
  await teardown();
  const audio = { ...RAW };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const ctx = new AudioContext({ sampleRate: 16000 });
  // The worklet loads while the device warms up; whatever is said before both are ready is lost (~100 ms).
  const [media, mod] = await Promise.allSettled([
    navigator.mediaDevices.getUserMedia({ audio }),
    ctx.audioWorklet.addModule("recorder-worklet.js")
  ]);
  if (media.status === "rejected" || mod.status === "rejected") {
    if (media.status === "fulfilled") media.value.getTracks().forEach(t => t.stop());
    ctx.close().catch(() => {});
    throw media.status === "rejected" ? media.reason : mod.reason;
  }
  const stream = media.value;
  const node = new AudioWorkletNode(ctx, "pcm16-capture", {
    numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers"
  });
  const source = ctx.createMediaStreamSource(stream);
  const c = { session, ctx, stream, node, source, flushed: null };
  node.port.onmessage = e => {
    if (e.data === "flushed") c.flushed?.();
    else if (e.data?.pcm) api.chunk(session, e.data.pcm.buffer, e.data.peak);
  };
  source.connect(node);
  if (ctx.state !== "running") await ctx.resume();
  const track = stream.getAudioTracks()[0];
  // An unplugged device ends the track; main keeps what was captured, as VoiceTray did.
  track.onended = () => { if (cur === c) api.event(session, "ended"); };
  cur = c;
  return { label: track.label, deviceId: track.getSettings().deviceId || deviceId || "" };
}

// The last partial chunk goes out before the reply, and IPC keeps order, so main has all audio when stop resolves.
async function stop({ session }) {
  const c = cur;
  if (!c || c.session !== session) return false;
  try { c.source.disconnect(); } catch {}
  await new Promise(resolve => {
    c.flushed = resolve;
    c.node.port.postMessage("flush");
    setTimeout(resolve, 500);
  });
  await teardown();
  return true;
}

async function cancel({ session }) {
  if (cur && cur.session === session) await teardown();
  return true;
}

const handlers = { list, start, stop, cancel };

api.onCommand(({ id, cmd, args }) => {
  queue = queue
    .then(() => handlers[cmd](args || {}))
    .then(result => api.reply(id, true, result), e => api.reply(id, false, { name: e?.name || "Error", message: e?.message || String(e) }));
});
