// Two inputs (microphone, system sound) -> interleaved Int16 in chunks of 100 ms, on the context's clock. An input
// that is not there is zeros, and the count goes on.
const CHANNELS = 2;
const CHUNK = 1600;
const QUANTUM = 128;

class MeetingPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.first = -1; // currentFrame of the first sample
    this.frames = 0;
    this.stopped = false;
    this.reset();
    this.port.onmessage = e => {
      if (e.data !== "stop") return;
      this.stopped = true;
      this.flush();
      this.port.postMessage("stopped");
    };
  }

  reset() {
    this.pcm = new Int16Array(CHUNK * CHANNELS);
    this.n = 0;
    this.peaks = [0, 0];
  }

  flush() {
    if (!this.n) return;
    const pcm = this.pcm.slice(0, this.n * CHANNELS);
    this.port.postMessage({ pcm: pcm.buffer, peaks: this.peaks }, [pcm.buffer]);
    this.reset();
  }

  next() {
    this.n++;
    this.frames++;
    if (this.n === CHUNK) this.flush();
  }

  process(inputs) {
    if (this.stopped) return false;
    if (this.first < 0) this.first = currentFrame;
    while (this.first + this.frames < currentFrame) this.next(); // skipped by the audio thread: already zero
    const mic = inputs[0]?.[0], system = inputs[1]?.[0];
    const length = (mic || system)?.length || QUANTUM;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < CHANNELS; c++) {
        const input = c ? system : mic;
        if (!input) continue;
        const sample = Math.max(-1, Math.min(1, input[i]));
        this.pcm[this.n * CHANNELS + c] = Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff));
        const level = Math.abs(sample);
        if (level > this.peaks[c]) this.peaks[c] = level;
      }
      this.next();
    }
    return true;
  }
}

registerProcessor("meeting-pcm", MeetingPcm);
