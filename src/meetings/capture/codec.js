// The codec page: PCM to Opus in WebM and back, a block at a time. Files are only names here, main reads and writes
// them; nothing is held whole.
const api = window.meetingsPage;
const M = window.Mediabunny;

const RATE = 16000;
const DECODED_RATE = 48000; // what an Opus decoder gives
const DECIMATION = DECODED_RATE / RATE;
const BITRATE = 32000;
const BLOCK_SECONDS = 10;
const WRITE_CHUNK = 1024 * 1024;
const LENGTH_SLACK_S = 0.25; // the encoder's padding
const GAP_S = 0.05;

const read = (name, position, length) => api.request("read", { name, position, length });
const write = (name, position, data) => api.request("write", { name, position, data });

function target(name) {
  const sink = new WritableStream({ write: ({ data, position }) => write(name, position, data) });
  return new M.StreamTarget(sink, { chunked: true, chunkSize: WRITE_CHUNK });
}

async function open(name) {
  const input = new M.Input({
    formats: [M.WEBM],
    source: new M.CustomSource({
      getSize: () => api.request("size", { name }),
      read: async (start, end) => {
        const bytes = await read(name, start, end - start);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      maxCacheSize: 4 * 1024 * 1024
    })
  });
  const track = await input.getPrimaryAudioTrack();
  if (!track) {
    input.dispose();
    throw new Error(`${name} has no sound`);
  }
  return { input, track };
}

// The interleaved recording as one mono file a channel.
async function encode({ source, outputs, frames }) {
  const channels = outputs.length, tracks = [];
  for (const name of outputs) {
    const output = new M.Output({ format: new M.WebMOutputFormat(), target: target(name) });
    const sound = new M.AudioSampleSource({ codec: "opus", quality: new M.Quality({ bitrate: BITRATE, bitrateMode: "variable" }) });
    output.addAudioTrack(sound);
    await output.start();
    tracks.push({ output, sound });
  }
  const block = RATE * BLOCK_SECONDS;
  for (let at = 0; at < frames; at += block) {
    const count = Math.min(block, frames - at);
    const bytes = await read(source, at * channels * 2, count * channels * 2);
    const all = new Int16Array(bytes.buffer, bytes.byteOffset, count * channels);
    await Promise.all(tracks.map(async ({ sound }, channel) => {
      const mono = new Int16Array(count);
      for (let i = 0; i < count; i++) mono[i] = all[i * channels + channel];
      const sample = new M.AudioSample({ format: "s16", sampleRate: RATE, numberOfChannels: 1, timestamp: at / RATE, data: mono });
      try {
        await sound.add(sample); // resolves with the encoder's back pressure
      } finally {
        sample.close();
      }
    }));
    api.send("progress", { frames: at + count });
  }
  for (const { output, sound } of tracks) {
    sound.close();
    await output.finalize();
  }
  return true;
}

// Before the PCM goes: the length, every packet in a row up to the end, and that the end decodes.
async function verify({ names, frames }) {
  const expected = frames / RATE;
  for (const name of names) {
    const { input, track } = await open(name);
    try {
      const duration = await input.computeDuration();
      if (Math.abs(duration - expected) > LENGTH_SLACK_S) throw new Error(`${name} is ${duration} s, not ${expected} s`);
      let end = null;
      for await (const packet of new M.EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
        if (end !== null && packet.timestamp - end > GAP_S) throw new Error(`${name} has a gap at ${end} s`);
        end = Math.max(end ?? -Infinity, packet.timestamp + packet.duration);
      }
      if (end === null || Math.abs(end - expected) > LENGTH_SLACK_S) throw new Error(`${name} ends at ${end} s, not ${expected} s`);
      let decoded = 0;
      for await (const sample of new M.AudioSampleSink(track).samples(Math.max(0, duration - 1))) {
        decoded += sample.numberOfFrames;
        sample.close();
      }
      if (!decoded) throw new Error(`${name} does not decode`);
    } finally {
      input.dispose();
    }
  }
  return true;
}

// 48 -> 16 kHz through a low-pass of our own: Mediabunny's resampler interpolates without one, and what is above
// 8 kHz would come back as speech-band noise.
const FILTER = (() => {
  const taps = 121, middle = (taps - 1) / 2, cutoff = 7400 / DECODED_RATE, h = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - middle;
    const sinc = x ? Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x) : 2 * cutoff;
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1))); // Hamming
    sum += h[i];
  }
  return h.map(v => v / sum);
})();

function createDownsampler(output) {
  const taps = FILTER.length, middle = (taps - 1) / 2;
  const buffer = new Float32Array(DECODED_RATE * BLOCK_SECONDS + taps);
  const room = buffer.length - middle; // kept free for what closes the last sample
  let fill = middle, written = 0; // begins with silence, so output sample k is centred on input sample 3k

  async function drain(last) {
    let end = fill;
    if (last) {
      buffer.fill(0, fill, fill + middle);
      end += middle;
    }
    const count = Math.floor((end - taps + DECIMATION) / DECIMATION);
    if (count <= 0) return;
    const pcm = new Int16Array(count);
    for (let k = 0; k < count; k++) {
      let sum = 0;
      for (let j = 0, at = k * DECIMATION; j < taps; j++, at++) sum += FILTER[j] * buffer[at];
      pcm[k] = Math.max(-32768, Math.min(32767, Math.round(sum * 32768)));
    }
    await write(output, written * 2, new Uint8Array(pcm.buffer));
    written += count;
    const used = count * DECIMATION;
    buffer.copyWithin(0, used, fill);
    fill = Math.max(0, fill - used);
  }

  return {
    async add(data) {
      for (let at = 0; at < data.length;) {
        if (fill === room) await drain(false);
        const count = Math.min(data.length - at, room - fill);
        buffer.set(data.subarray(at, at + count), fill);
        fill += count;
        at += count;
      }
    },
    async end() {
      await drain(true);
      return written;
    }
  };
}

async function decode({ source, output }) {
  const { input, track } = await open(source);
  try {
    const sound = createDownsampler(output);
    for await (const sample of new M.AudioSampleSink(track).samples()) {
      try {
        if (sample.sampleRate !== DECODED_RATE) throw new Error(`${source} decodes at ${sample.sampleRate} Hz`);
        const data = new Float32Array(sample.numberOfFrames);
        sample.copyTo(data, { planeIndex: 0, format: "f32-planar" });
        await sound.add(data);
      } finally {
        sample.close();
      }
    }
    return await sound.end();
  } finally {
    input.dispose();
  }
}

const handlers = { encode, verify, decode };

api.onCommand(async ({ id, cmd, args }) => {
  try {
    api.reply(id, true, await handlers[cmd](args || {}));
  } catch (e) {
    api.reply(id, false, { name: e?.name || "Error", message: e?.message || String(e) });
  }
});
