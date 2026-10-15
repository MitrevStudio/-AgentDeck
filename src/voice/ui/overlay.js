// The floating voice panel: a slim pill that morphs between listening, transcribing, success, preparing and
// speaking, and opens up into a small card for errors and notices. It also plays the read-aloud audio
// (player-worklet.js), since it is on screen for the whole reading anyway. Uses $, esc, icon, ICONS and t from
// common.js.
Object.assign(ICONS, {
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.6" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6h.01"/>'
});

const api = window.voiceOverlay;
const body = document.body, stage = $("stage"), pill = $("pill"), row = $("row"), msg = $("msg"), tip = $("tip");
const parts = [...row.querySelectorAll(".part")];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

const MAX_WARN_SECONDS = 30; // never start the countdown earlier than this, however long the cap is
const WARN_FRACTION = 0.25; // on a short cap, 30 s of warning would be most of the recording
const URGENT_SECONDS = 10;
const SPEEDS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const EXIT_MS = 240; // matches overlay.js (main): the window is hidden after this

let seq = 0;
let state = null;
let data = {};
let speed = 1.0;
let limitSeconds = 0;
let warnAt = 0;
let shownSecond = -1;
let shownWarn = null;
let hidden = true;
let resetTimer = null;

const fmtTime = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const fmtSpeed = x => `${I18N.formatNumber(x, { minimumFractionDigits: 1, maximumFractionDigits: 2 })}×`;
const setText = (id, text) => { const el = $(id); if (el.textContent !== text) el.textContent = text; };

// ---- waveform -------------------------------------------------------------------------------------------------
// Fine bars scroll right-to-left at a calm, steady pace driven by animation frames (not by the ~20 updates a
// second); the leading bar follows the voice continuously, and a mode change eases every bar to its new height - so
// the voice trace settles into the row of waiting dots instead of jumping.
const wave = (() => {
  const cv = $("wave"), ctx = cv.getContext("2d");
  const PITCH = 3, BW = 1.5, STEP = 70; // css px between bars, bar width, ms per bar
  let w = 0, h = 0, dpr = 1, n = 0;
  let mode = "flat"; // live: voice level; think: waiting dots with a light passing over them; flat: resting dots
  let disp = [], hist = [];
  let target = 0, cur = 0, lastLevelAt = 0, acc = 0, frac = 0, clock = 0;

  function resize() {
    const cs = getComputedStyle(cv);
    const cw = parseFloat(cs.width) || 0, ch = parseFloat(cs.height) || 0;
    if (!cw || !ch) return;
    dpr = window.devicePixelRatio || 1;
    if (cw === w && ch === h && cv.width === Math.round(cw * dpr)) return;
    w = cw; h = ch;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const m = Math.ceil(w / PITCH) + 2;
    while (disp.length < m) { disp.push(0); hist.push(0); }
    n = m;
  }

  // Peak 0..1 from the recorder or the player, shaped so normal speech fills the bars without clipping.
  const shape = l => Math.min(1, Math.pow(Math.max(0, (Number(l) || 0) - 0.003) * 3.2, 0.7));
  // Where the light passing over the waiting dots is, as a share of the width from the left (it leaves and comes
  // back in).
  const sweepAt = () => ((clock / 1600) % 1) * 1.6 - 0.3;

  function frame(dt, now) {
    clock += dt;
    // No level for a while (e.g. a slow IPC): let it settle rather than freeze mid-bar.
    if (now - lastLevelAt > 180) target = 0;
    const rate = target > cur ? 50 : 180; // quick attack, slow release: calm rather than twitchy
    cur += (target - cur) * (1 - Math.exp(-dt / rate));
    if (mode === "live") {
      acc += dt;
      while (acc >= STEP) {
        acc -= STEP;
        hist.unshift(cur); hist.length = n;
        disp.unshift(disp[0]); disp.length = n;
      }
      frac = acc / STEP;
    }
    const tau = mode === "live" ? 45 : 200;
    const k = 1 - Math.exp(-dt / tau);
    const visible = Math.max(1, Math.min(n, Math.ceil(w / PITCH)));
    const sweep = sweepAt();
    for (let i = 0; i < n; i++) {
      let goal = 0;
      if (mode === "live") goal = i === 0 ? cur : hist[i];
      // Waiting: dots, a touch taller where the light passes (bar i sits at 1 - i/visible from the left).
      else if (mode === "think" && !reduced.matches) goal = 0.12 * Math.exp(-(((1 - (i + 0.5) / visible - sweep) / 0.16) ** 2));
      disp[i] += (goal - disp[i]) * k;
    }
    draw();
    return cur;
  }

  function draw() {
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = getComputedStyle(cv).color; // follows the theme and fades with it
    const mid = h / 2, minH = BW, maxH = h * 0.86;
    const fadeW = w > 60 ? w * 0.3 : 0; // the long trace fades out to the left; the short one does not
    const sweep = sweepAt() * w;
    const breathe = 0.5 + 0.5 * Math.sin(clock / 700);
    for (let i = 0; i < n; i++) {
      const x = w - PITCH / 2 - (i + frac) * PITCH;
      if (x < -BW) break;
      const v = Math.max(0, disp[i]);
      const bh = minH + v * (maxH - minH);
      const fade = fadeW ? Math.min(1, Math.max(0, x / fadeW)) : 1;
      let a;
      if (mode === "live") a = 0.4 + 0.6 * Math.min(1, v * 1.7);
      else if (mode === "think") a = reduced.matches ? 0.25 + 0.25 * breathe : 0.22 + 0.62 * Math.exp(-(((x - sweep) / (w * 0.16)) ** 2));
      else a = 0.3;
      ctx.globalAlpha = Math.min(1, a) * (0.12 + 0.88 * fade);
      ctx.beginPath();
      ctx.roundRect(x - BW / 2, mid - bh / 2, BW, bh, BW / 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  return {
    resize, frame,
    setMode(m) { mode = m; }, // leaving "live" freezes the scroll where it is; the bars ease to the new shape
    setLevel(l) { target = shape(l); lastLevelAt = performance.now(); },
    reset() { disp.fill(0); hist.fill(0); target = cur = acc = frac = 0; draw(); },
    get mode() { return mode; }
  };
})();

// One loop for the waveform and the recording dot's ring; it runs only while the panel is on screen.
let raf = 0, lastFrame = 0;
function loop(now) {
  const dt = Math.min(64, now - (lastFrame || now));
  lastFrame = now;
  const lvl = wave.frame(dt, now);
  stage.style.setProperty("--lvl", (state === "listening" ? lvl : 0).toFixed(3));
  raf = requestAnimationFrame(loop);
}
function startLoop() { if (!raf) { lastFrame = 0; raf = requestAnimationFrame(loop); } }
function stopLoop() { cancelAnimationFrame(raf); raf = 0; }

// ---- morphing -----------------------------------------------------------------------------------------------------
// The pill takes the size of the layer in use; its width/height transition does the morph. The row is anchored at
// the pill's top-left and the card at its bottom-left, so the card grows upwards from where the pill was.
function fit(animate = true) {
  const el = stage.dataset.layer === "msg" ? msg : row;
  const w = Math.ceil(el.offsetWidth), h = Math.ceil(el.offsetHeight);
  if (!w || !h) return;
  const ws = `${w}px`, hs = `${h}px`;
  if (pill.style.width === ws && pill.style.height === hs) return;
  if (!animate) pill.classList.add("snap");
  pill.style.width = ws; pill.style.height = hs;
  if (!animate) { void pill.offsetWidth; pill.classList.remove("snap"); }
}
new ResizeObserver(() => { if (state) fit(!hidden); }).observe(row);
new ResizeObserver(() => { if (state) fit(!hidden); }).observe(msg);

// Parts of the row that belong to the new state come in with a short fade; the ones that do not fade out where
// they stand (taken out of the flow, so the pill can already shrink around the rest).
function showParts(next, animate) {
  const plan = parts.map(p => {
    const on = p.dataset.in.split(" ").includes(next);
    const shown = !p.classList.contains("off") && !p.classList.contains("leaving");
    return { p, on, shown, left: p.offsetLeft, top: p.offsetTop };
  });
  for (const { p, on, shown, left, top } of plan) {
    if (on && !shown) {
      p.classList.remove("off", "leaving", "entering");
      p.style.left = p.style.top = "";
      if (animate) { void p.offsetWidth; p.classList.add("entering"); }
    } else if (!on && shown) {
      p.classList.remove("entering");
      if (animate) {
        p.style.left = `${left}px`; p.style.top = `${top}px`;
        p.classList.add("leaving");
        setTimeout(() => { if (p.classList.contains("leaving")) { p.classList.replace("leaving", "off"); p.style.left = p.style.top = ""; } }, 160);
      } else p.classList.add("off");
    }
  }
}

// ---- states -------------------------------------------------------------------------------------------------------
function setTone(tone) { if (tone) body.dataset.tone = tone; else delete body.dataset.tone; }
function setTip(html) {
  if (tip.innerHTML !== html) tip.innerHTML = html;
  tip.classList.toggle("on", Boolean(html));
}

// The keys, shown only while the pointer rests on the pill. Without a dictation hotkey (it is taken) the controller
// says in words how to stop.
function keyHints() {
  const key = (k, word) => `<span class="h"><kbd>${esc(k)}</kbd>${esc(word)}</span>`;
  const cancel = key(data.cancelKey || "Esc", t("voice.overlay.keys.cancel"));
  if (data.hotkey) return key(data.hotkey, t("voice.overlay.keys.finish")) + cancel;
  return data.hint ? `<span class="h">${esc(data.hint)}</span>` : cancel;
}

// Quiet for most of a recording; amber once the end is close, red for the last seconds.
function updateRecording(elapsed) {
  const remaining = limitSeconds > 0 ? limitSeconds - elapsed : Infinity;
  const warn = remaining <= warnAt;
  const shown = Math.max(0, Math.floor(warn ? Math.ceil(remaining) : elapsed));
  setTone(!warn ? "" : remaining <= URGENT_SECONDS ? "urgent" : "warn");
  $("track").classList.toggle("on", warn);
  if (warn) $("trackFill").style.width = `${Math.min(100, Math.max(0, (elapsed / limitSeconds) * 100))}%`;
  if (shown === shownSecond && warn === shownWarn) return;
  shownSecond = shown; shownWarn = warn;
  const time = esc(fmtTime(shown));
  // "0:25 left" / "остават 0:25": the words around the time are quieter than the time itself.
  $("timer").innerHTML = warn
    ? t("voice.overlay.timeLeft").split("{time}").map(s => (s ? `<span class="w">${esc(s)}</span>` : "")).join(time)
    : time;
}

function setSpeed(x) {
  speed = Number(x) || 1;
  setText("speed", fmtSpeed(speed));
}

function setPaused(paused) {
  data.paused = paused;
  if (paused) body.dataset.paused = ""; else delete body.dataset.paused;
  const b = $("pause");
  b.innerHTML = icon(paused ? "play" : "pause");
  b.title = t(paused ? "voice.overlay.resume" : "voice.overlay.pause");
  b.setAttribute("aria-label", b.title);
  if (state === "speaking") wave.setMode(paused ? "flat" : "live");
  refreshPlayback();
}

function refreshPlayback() {
  if (state !== "speaking") return;
  const s = player?.status;
  let text = "0:00";
  if (s) {
    const pos = s.position / s.sampleRate, dur = s.received / s.sampleRate;
    text = s.starved ? t("voice.overlay.loading") : s.completed ? `${fmtTime(pos)} / ${fmtTime(dur)}` : fmtTime(pos);
    // Shown once the whole reading has loaded, so it never jumps backwards as more audio arrives.
    if (s.completed && dur > 0) {
      $("track").classList.add("on");
      $("trackFill").style.width = `${Math.min(100, Math.max(0, (pos / dur) * 100))}%`;
    }
    if (!data.paused) wave.setMode(s.starved ? "think" : "live");
  }
  setText("ptime", text);
}

const textTip = text => (text ? `<span class="t">${esc(text)}</span>` : "");

function showMsg({ tone, ico, title, detail, actions, retry, autoHideMs }) {
  setTone(tone);
  $("msgIco").innerHTML = icon(ico);
  setText("msgTitle", title || "");
  setText("msgDetail", detail || "");
  $("msgActions").hidden = !actions;
  $("retry").hidden = !retry;
  $("retry").innerHTML = `${icon("refresh")}<span>${esc(t("voice.overlay.retry"))}</span>`;
  if (autoHideMs) msg.style.setProperty("--notice-ms", `${autoHideMs}ms`);
}

let playbackTimer = null;
function render(next, d, animate) {
  const prev = state;
  state = next;
  data = { ...(d || {}) };
  body.dataset.state = next;
  delete body.dataset.paused;
  clearInterval(playbackTimer);
  playbackTimer = null;
  $("track").classList.remove("on");
  $("trackFill").style.width = "0";
  limitSeconds = 0;
  shownSecond = -1;
  shownWarn = null;
  setTone("");
  setTip("");

  const layer = next === "error" || next === "notice" ? "msg" : "row";
  stage.dataset.layer = layer;
  if (layer === "row") showParts(next, animate && prev !== null);

  switch (next) {
    case "listening":
      limitSeconds = Number(data.limitSeconds) || 0;
      warnAt = Math.min(MAX_WARN_SECONDS, limitSeconds * WARN_FRACTION);
      setTip(keyHints());
      updateRecording(Number(data.elapsed) || 0);
      if (prev !== "listening") wave.reset();
      wave.setMode("live");
      break;
    case "transcribing":
      setText("title", t("voice.overlay.recognizing"));
      setText("sub", "");
      setTip(data.provider ? textTip(t("voice.overlay.provider", { provider: data.provider })) : "");
      wave.setMode("think");
      break;
    case "preparing":
      setText("title", t("voice.overlay.preparing"));
      setText("sub", "");
      if (prev !== "preparing") wave.reset();
      wave.setMode("think");
      break;
    case "speaking":
      $("stop").innerHTML = icon("stop");
      setTip(textTip(data.title));
      setSpeed(data.speed ?? speed);
      if (prev !== "preparing" && prev !== "speaking") wave.reset();
      setPaused(Boolean(data.paused));
      playbackTimer = setInterval(refreshPlayback, 200);
      break;
    case "success":
      setTone("ok");
      setText("title", data.title || t("voice.overlay.done"));
      setText("sub", data.detail || "");
      wave.setMode("flat");
      break;
    case "error":
      showMsg({ tone: "danger", ico: "alert", title: data.title || t("voice.overlay.error"), detail: data.detail, actions: true, retry: data.canRetry !== false });
      break;
    case "notice":
      showMsg({ tone: "", ico: "info", title: data.title, detail: data.detail, actions: false, autoHideMs: Number(data.durationMs) || 3500 });
      // Restart the countdown for a notice that replaces another one.
      $("countdown").style.animation = "none"; void msg.offsetWidth; $("countdown").style.animation = "";
      break;
  }
  if (layer === "row") wave.resize();
}

function show(next, d) {
  clearTimeout(resetTimer);
  const entering = hidden || state === null;
  if (entering) {
    // A fresh panel: lay it out at its final size (no cross-fade from whatever it showed last time), then let the
    // stage come in.
    stage.classList.add("out", "snap");
    render(next, d, false);
    fit(false);
    void stage.offsetWidth;
    stage.classList.remove("out", "snap");
    hidden = false;
  } else {
    render(next, d, true);
    fit(true);
  }
  startLoop();
  setInteractive(false);
  requestAnimationFrame(recheckPointer);
}

function hide() {
  state = null;
  hidden = true;
  setInteractive(false);
  stage.classList.add("out");
  clearInterval(playbackTimer);
  playbackTimer = null;
  clearTimeout(resetTimer);
  // After the exit animation, back to a clean slate for the next show.
  resetTimer = setTimeout(() => {
    stopLoop();
    delete body.dataset.state;
    delete body.dataset.paused;
    setTone("");
    setTip("");
    wave.reset();
    for (const p of parts) { p.classList.remove("entering", "leaving"); p.classList.add("off"); p.style.left = p.style.top = ""; }
  }, EXIT_MS + 40);
}

// Synchronous: the window may be hidden, where animation frames do not run. Main shows a hidden window only after
// this, so it never flashes what was there before.
function confirmRendered() {
  api.size(seq, Math.ceil(pill.getBoundingClientRect().height));
}

api.onState(m => {
  seq = m.seq;
  if (m.state) show(m.state, m.data); else hide();
  confirmRendered();
});

api.onUpdate(d => {
  if (!state) return;
  Object.assign(data, d);
  if (state === "listening" && ("level" in d || "elapsed" in d)) {
    if ("level" in d) wave.setLevel(d.level);
    updateRecording(Number(d.elapsed) || 0);
  }
  if (state === "speaking") {
    if ("speed" in d) setSpeed(d.speed);
    if ("paused" in d) setPaused(Boolean(d.paused));
    if ("title" in d) setTip(textTip(d.title));
  }
});

// ---- buttons ----------------------------------------------------------------------------------------------------
$("retry").addEventListener("click", () => api.action("retry", data.jobId ?? null));
$("dismiss").addEventListener("click", () => api.action("close"));
$("pause").addEventListener("click", () => api.action("pause"));
$("stop").addEventListener("click", () => api.action("stop"));
$("speed").addEventListener("click", () => {
  // The next speed above the current one, wrapping to the slowest.
  const next = SPEEDS.find(s => s > speed + 0.001) ?? SPEEDS[0];
  setSpeed(next);
  api.action("speed", next);
});

// ---- click-through ----------------------------------------------------------------------------------------------
// The window takes the mouse only while the pointer is over the pill; everywhere else clicks fall through to
// whatever is below. Pointer moves arrive even while click-through (main forwards them). The same moment reveals
// the quiet extras: the key hints, the whole text of an error.
let interactive = null, pointer = null;
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  body.classList.toggle("hover", on);
  api.interactive(on);
}
const overPill = el => Boolean(state) && !hidden && Boolean(el) && pill.contains(el);
function recheckPointer() {
  setInteractive(pointer ? overPill(document.elementFromPoint(pointer[0], pointer[1])) : false);
}
document.addEventListener("mousemove", e => { pointer = [e.clientX, e.clientY]; setInteractive(overPill(e.target)); });
document.addEventListener("mouseleave", () => { pointer = null; setInteractive(false); });
// The pill changed size under a resting pointer: it may no longer be over it (or now is).
pill.addEventListener("transitionend", e => { if (e.target === pill) recheckPointer(); });

// ---- read-aloud player ------------------------------------------------------------------------------------------
let player = null;

function report(p, type, extra) {
  api.player({ id: p.id, type, ...extra });
}

function toWorklet(p, m, transfer = []) {
  if (p.node) p.node.port.postMessage(m, transfer);
  else p.pending.push([m, transfer]);
}

function stopPlayer() {
  const p = player;
  player = null;
  if (!p) return;
  try { p.node?.disconnect(); } catch {}
  p.ctx?.close().catch(() => {});
}

async function begin({ id, sampleRate = 24000, speed: rate = 1, startBufferMs = 750 }) {
  stopPlayer();
  const p = { id, ctx: null, node: null, pending: [], paused: false, status: null };
  player = p;
  try {
    p.ctx = new AudioContext({ sampleRate, latencyHint: "playback" });
    await p.ctx.audioWorklet.addModule("player-worklet.js");
    if (player !== p) { p.ctx.close().catch(() => {}); return; }
    p.node = new AudioWorkletNode(p.ctx, "tts-player", {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { speed: rate, startBufferMs }
    });
    p.node.port.onmessage = e => onPlayerMessage(p, e.data);
    p.node.connect(p.ctx.destination);
    for (const [m, transfer] of p.pending) p.node.port.postMessage(m, transfer);
    p.pending = [];
    if (p.paused) await p.ctx.suspend(); else await p.ctx.resume();
  } catch (e) {
    if (player === p) { report(p, "error", { message: e?.message || String(e) }); stopPlayer(); }
  }
}

function onPlayerMessage(p, m) {
  if (player !== p) return;
  if (m.type === "level") {
    p.status = m;
    if (state === "speaking" && !p.paused) wave.setLevel(m.level);
  } else if (m.type === "started") {
    report(p, "started");
  } else if (m.type === "ended") {
    report(p, "ended");
  }
}

api.onAudio(m => {
  if (m.cmd === "begin") { begin(m); return; }
  const p = player;
  if (!p || p.id !== m.id) return;
  switch (m.cmd) {
    case "push": {
      const bytes = m.pcm instanceof Uint8Array ? m.pcm : new Uint8Array(m.pcm);
      const pcm = new Int16Array(bytes.byteLength >> 1);
      new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.length * 2));
      toWorklet(p, { cmd: "push", pcm }, [pcm.buffer]);
      break;
    }
    case "end": toWorklet(p, { cmd: "end" }); break;
    case "speed": toWorklet(p, { cmd: "speed", speed: m.speed }); break;
    case "pause": p.paused = true; p.ctx?.suspend().catch(() => {}); break;
    case "resume": p.paused = false; p.ctx?.resume().catch(() => {}); break;
    case "stop": stopPlayer(); break;
  }
});
