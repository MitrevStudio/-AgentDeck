// The capture page: the microphone and the system sound into one worklet. A source that ends is silence until it is
// open again; main hears of both.
const api = window.meetingsPage;

// Raw, like the dictation: the models do better without a voice call's processing. getDisplayMedia has to be told,
// `audio: true` turns all three on and makes the system sound mono.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const RETRY_MS = 3000;
const CHANNELS = ["mic", "system"];
const VIRTUAL_IDS = new Set(["default", "communications"]);

let cur = null;
let queue = Promise.resolve();

const devicesOf = async kind => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind);
// The label of a virtual entry names the device behind it, so it changes with the default.
async function labelOf(kind, id) {
  return (await devicesOf(kind)).find(d => d.deviceId === id)?.label || "";
}

async function openMicrophone(deviceId, fallback) {
  const audio = { ...RAW, channelCount: 1 };
  if (deviceId && deviceId !== "default") audio.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio });
  } catch (error) {
    if (!fallback || !audio.deviceId) throw error;
    delete audio.deviceId; // the chosen one is gone: the default is better than silence
    return navigator.mediaDevices.getUserMedia({ audio });
  }
}
// The default output's loopback. video: false: no screen is captured for the sound.
const openSystem = () => navigator.mediaDevices.getDisplayMedia({ video: false, audio: RAW });

const openChannel = (c, channel, fallback) => (channel === "mic" ? openMicrophone(c.deviceId, fallback) : openSystem());

function connect(c, channel) {
  if (!c.node || !c.streams[channel]) return;
  const source = c.context.createMediaStreamSource(c.streams[channel]);
  source.connect(c.node, 0, CHANNELS.indexOf(channel));
  c.sources[channel] = source;
}
function drop(c, channel) {
  c.sources[channel]?.disconnect();
  c.sources[channel] = null;
  c.streams[channel]?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  c.streams[channel] = null;
}

const microphoneOf = stream => {
  const track = stream?.getAudioTracks()[0];
  return track ? { deviceId: track.getSettings().deviceId || "default", label: track.label } : null;
};

function take(c, channel, stream) {
  drop(c, channel);
  c.streams[channel] = stream;
  // The only sure sign of a loss: a track without a source still delivers zeros.
  stream.getAudioTracks()[0].onended = () => {
    if (cur !== c) return;
    drop(c, channel);
    api.send("source", { channel, lost: true });
    mend(c, channel);
  };
  connect(c, channel);
}

async function mend(c, channel) {
  if (cur !== c || c.mending[channel]) return;
  c.mending[channel] = true;
  try {
    const stream = await openChannel(c, channel, true);
    if (cur !== c) return stream.getTracks().forEach(track => track.stop());
    take(c, channel, stream);
    api.send("source", { channel, lost: false, microphone: channel === "mic" ? microphoneOf(stream) : null });
  } catch {
    // tried again by the timer
  } finally {
    c.mending[channel] = false;
  }
}

async function followed(c) {
  return {
    // A chosen microphone stays; the default is followed, as a stream stays on the device it was opened on.
    mic: VIRTUAL_IDS.has(c.deviceId) ? await labelOf("audioinput", c.deviceId) : "",
    // The system sound is one output's, the default's of when it was opened.
    system: await labelOf("audiooutput", "default")
  };
}
async function devicesChanged() {
  const c = cur;
  if (!c) return;
  const now = await followed(c);
  for (const channel of CHANNELS) {
    if (!c.streams[channel] || now[channel] !== c.following[channel]) mend(c, channel);
  }
  c.following = now;
}

async function release() {
  const c = cur;
  cur = null;
  if (!c) return;
  clearInterval(c.retry);
  for (const channel of CHANNELS) drop(c, channel);
  await c.context?.close().catch(() => {});
}

// resume: in place of a page that died mid-recording, so one missing source does not hold back the other.
async function open({ deviceId, resume }) {
  await release();
  const c = { deviceId, context: null, node: null, streams: {}, sources: {}, mending: {}, following: {}, retry: null, stopped: null };
  const opened = await Promise.allSettled(CHANNELS.map(channel => openChannel(c, channel, Boolean(resume))));
  const refused = opened.findIndex(r => r.status === "rejected");
  if (refused >= 0 && !resume) {
    for (const r of opened) r.value?.getTracks().forEach(track => track.stop());
    const { name, message } = opened[refused].reason;
    return { failed: { channel: CHANNELS[refused], detail: `${name}: ${message}` } };
  }
  cur = c;
  opened.forEach((r, i) => { if (r.value) take(c, CHANNELS[i], r.value); });
  c.following = await followed(c);
  return { microphone: microphoneOf(c.streams.mic), lost: CHANNELS.filter(channel => !c.streams[channel]) };
}

async function begin() {
  const c = cur;
  if (!c) throw new Error("nothing is open");
  // On the default output's clock, which the sources' own clocks follow: a context without an output runs on a timer
  // that fell 1.3 s behind in two hours under load, and what it did not take in time was dropped. When the output
  // goes away this one suspends; it is resumed, and if no sound comes main starts the page anew.
  c.context = new AudioContext({ sampleRate: 16000 });
  c.context.onstatechange = () => {
    if (cur === c && c.context.state === "suspended") c.context.resume().catch(() => {});
  };
  await c.context.audioWorklet.addModule("capture-worklet.js");
  c.node = new AudioWorkletNode(c.context, "meeting-pcm", {
    numberOfInputs: CHANNELS.length, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers"
  });
  c.node.port.onmessage = e => {
    if (e.data === "stopped") c.stopped?.();
    else api.send("chunk", e.data);
  };
  for (const channel of CHANNELS) connect(c, channel);
  if (c.context.state !== "running") await c.context.resume();
  c.retry = setInterval(() => {
    for (const channel of CHANNELS) if (!c.streams[channel]) mend(c, channel);
  }, RETRY_MS);
  return true;
}

// IPC keeps order: the last chunk is in main before this answer.
async function stop() {
  const c = cur;
  if (c?.node) {
    await new Promise(resolve => {
      c.stopped = resolve;
      c.node.port.postMessage("stop");
      setTimeout(resolve, 500);
    });
  }
  await release();
  return true;
}

async function list() {
  const inputs = await devicesOf("audioinput");
  return inputs.map(({ deviceId, label }) => ({ deviceId, label, isDefault: deviceId === "default" }));
}

const handlers = { list, open, begin, stop };

navigator.mediaDevices.addEventListener("devicechange", () => devicesChanged().catch(error => console.error(error)));
api.onCommand(({ id, cmd, args }) => {
  queue = queue
    .then(() => handlers[cmd](args || {}))
    .then(value => api.reply(id, true, value), e => api.reply(id, false, { name: e?.name || "Error", message: e?.message || String(e) }));
});
