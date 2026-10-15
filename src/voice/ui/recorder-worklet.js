// Float32 mono at the context rate (16 kHz) -> Int16 chunks of 50 ms with their peak, which is what VoiceTray's
// WaveInEvent delivered (BufferMilliseconds = 50) and what drove its level meter.
const CHUNK = 800;

class Pcm16Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(CHUNK);
    this.n = 0;
    this.peak = 0;
    this.port.onmessage = e => {
      if (e.data === "flush") { this.flush(); this.port.postMessage("flushed"); }
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i] < -1 ? -1 : ch[i] > 1 ? 1 : ch[i];
      const v = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.buf[this.n++] = v;
      const a = (v < 0 ? -v : v) / 32768;
      if (a > this.peak) this.peak = a;
      if (this.n === CHUNK) this.flush();
    }
    return true;
  }

  flush() {
    if (!this.n) return;
    const pcm = this.buf.slice(0, this.n);
    this.port.postMessage({ pcm, peak: this.peak }, [pcm.buffer]);
    this.n = 0;
    this.peak = 0;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
