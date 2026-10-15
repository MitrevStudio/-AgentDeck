// Read-aloud output. Port of VoiceTray's StreamingAudioSource -> SoundTouch -> meter chain:
// - speech is appended while it plays; until the start buffer has filled, and whenever playback catches up with
//   synthesis, it plays silence instead of ending, so a slow chunk is a pause rather than the end of the reading;
// - it ends only once the main process said no more audio is coming and everything has been played;
// - the tempo changes without moving the pitch (WSOLA time-stretch), live.
//
// soundtouchjs is LGPL-2.1 and loaded unmodified from node_modules as a separate module (no bundling).
import { Stretch } from "../../../node_modules/soundtouchjs/dist/soundtouch.js";

const FEED = 1024; // source frames handed to SoundTouch at a time
const METER_RATE = 20; // level updates per second, like the recorder's 50 ms buffers
const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;

const clampSpeed = x => Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(x) || 1));

class TtsPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.startFrames = Math.round(((o.startBufferMs ?? 750) / 1000) * sampleRate);
    this.queue = [];
    this.queueOffset = 0;
    this.received = 0; // frames that arrived
    this.consumed = 0; // frames handed to SoundTouch: the source position
    this.completed = false;
    this.padded = false;
    this.started = false;
    this.ended = false;
    this.starved = false;

    // Speech settings, as in VoiceTray: SoundTouch's defaults suit music; short sequences and overlap windows are
    // the published ones for speech and keep consonants clean when sped up. Stereo-interleaved API, mono content.
    this.st = new Stretch(true);
    this.st.setParameters(sampleRate, 40, 15, 8);
    this.st.tempo = clampSpeed(o.speed);
    this.st.inputBuffer.ensureCapacity(FEED * 8);
    this.st.outputBuffer.ensureCapacity(FEED * 8);
    this.feedBuf = new Float32Array(FEED * 2);
    this.outBuf = new Float32Array(256 * 2);

    this.meterEvery = Math.round(sampleRate / METER_RATE);
    this.meterCount = 0;
    this.meterPeak = 0;
    this.port.onmessage = e => this.command(e.data);
  }

  command(m) {
    if (m.cmd === "push") {
      const f = new Float32Array(m.pcm.length);
      for (let i = 0; i < f.length; i++) f[i] = m.pcm[i] / 32768;
      if (f.length && !this.completed) { this.queue.push(f); this.received += f.length; }
    } else if (m.cmd === "end") {
      this.completed = true;
    } else if (m.cmd === "speed") {
      this.st.tempo = clampSpeed(m.speed);
    }
  }

  // Position in source time, as VoiceTray showed it: what SoundTouch has taken, minus what it still holds.
  position() {
    const held = this.st.inputBuffer.frameCount + this.st.outputBuffer.frameCount * this.st.tempo;
    return Math.max(0, Math.round(this.consumed - held));
  }

  feed() {
    let frames = 0;
    while (frames < FEED && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(FEED - frames, head.length - this.queueOffset);
      for (let i = 0; i < take; i++) {
        const s = head[this.queueOffset + i];
        this.feedBuf[2 * (frames + i)] = s;
        this.feedBuf[2 * (frames + i) + 1] = s;
      }
      frames += take;
      this.queueOffset += take;
      if (this.queueOffset === head.length) { this.queue.shift(); this.queueOffset = 0; }
    }
    if (frames) {
      this.st.inputBuffer.putSamples(this.feedBuf, 0, frames);
      this.consumed += frames;
      this.st.process();
      return true;
    }
    // SoundTouch holds back up to a window of input; trailing silence pushes the last syllable out.
    if (this.completed && !this.padded) {
      this.padded = true;
      const pad = new Float32Array(this.st.sampleReq * 4);
      this.st.inputBuffer.putSamples(pad, 0, pad.length / 2);
      this.st.process();
      return true;
    }
    return false;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    if (this.ended) return true;
    if (!this.started) {
      // Enough in hand to absorb the jitter between streamed pieces; a passage shorter than that starts once complete.
      if (this.received < this.startFrames && !this.completed) return true;
      this.started = true;
      this.port.postMessage({ type: "started" });
    }

    while (this.st.outputBuffer.frameCount < n && this.feed()) { /* fill */ }
    const have = Math.min(n, this.st.outputBuffer.frameCount);
    if (have) {
      if (this.outBuf.length < have * 2) this.outBuf = new Float32Array(have * 2);
      this.st.outputBuffer.receiveSamples(this.outBuf, have);
      for (let i = 0; i < have; i++) {
        const s = this.outBuf[2 * i];
        out[i] = s;
        const a = s < 0 ? -s : s;
        if (a > this.meterPeak) this.meterPeak = a;
      }
    }
    if (have < n) {
      if (this.completed && this.padded && !this.queue.length) {
        this.ended = true;
        this.port.postMessage({ type: "ended" });
        return true;
      }
      // Caught up with synthesis: silence keeps the output running until more audio arrives.
      this.starved = true;
    } else {
      this.starved = false;
    }

    this.meterCount += n;
    if (this.meterCount >= this.meterEvery) {
      this.port.postMessage({
        type: "level", level: Math.min(1, this.meterPeak), position: this.position(), received: this.received,
        completed: this.completed, starved: this.starved, sampleRate
      });
      this.meterCount = 0;
      this.meterPeak = 0;
    }
    return true;
  }
}

registerProcessor("tts-player", TtsPlayer);
