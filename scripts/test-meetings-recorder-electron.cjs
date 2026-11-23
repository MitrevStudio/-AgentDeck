// The meetings' recorder in real Electron: the hidden pages, the worklet, WebCodecs and Mediabunny, recovery after a
// kill, openAudio into the real pipeline. `node scripts/test-meetings-recorder-electron.cjs` (Windows).
//
// No microphone, no system sound and no screen is used. The capture page gets a preload of this test that replaces
// getUserMedia, getDisplayMedia and enumerateDevices with oscillators before the page runs, its session refuses every
// permission, and Chromium is told to use fake devices as well. The screens are only listed, their pictures are made
// here. The key is a fake, except for one registration of a key no keyboard has (Ctrl+Alt+Shift+F20), released at
// once. The network is a stub. Every process that is stopped is one this test started, by its PID.
//
// MEETINGS_LONG_MINUTES=120 also compresses and decodes a recording of that length.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, ".."), SRC = path.join(ROOT, "src");
const RATE = 16000;
const TONE = { mic: 1000, system: 500 }, AMPLITUDE = 0.25;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs in the page's own world, before its scripts.
function synthetic(tone, amplitude) {
  const asked = [], made = {};
  function source(channel, label) {
    const context = new AudioContext({ sampleRate: 48000, sinkId: { type: "none" } });
    const out = new MediaStreamAudioDestinationNode(context, { channelCount: 1 });
    const oscillator = new OscillatorNode(context, { frequency: tone[channel] });
    oscillator.connect(new GainNode(context, { gain: amplitude })).connect(out);
    oscillator.start();
    context.resume();
    const track = out.stream.getAudioTracks()[0], stop = track.stop.bind(track);
    Object.defineProperty(track, "label", { value: label });
    track.getSettings = () => ({ deviceId: "default" });
    track.stop = () => { stop(); context.close().catch(() => {}); };
    made[channel] = track;
    return out.stream;
  }
  const media = navigator.mediaDevices;
  media.getUserMedia = async constraints => { asked.push({ channel: "mic", constraints }); return source("mic", "Synthetic microphone"); };
  media.getDisplayMedia = async constraints => { asked.push({ channel: "system", constraints }); return source("system", "Synthetic system"); };
  media.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "default", label: "Default - Synthetic microphone" },
    { kind: "audiooutput", deviceId: "default", label: "Default - Synthetic output" }
  ];
  window.synthetic = {
    asked,
    lose(channel) {
      const track = made[channel];
      track.stop();
      track.dispatchEvent(new Event("ended"));
    }
  };
}

// ===================================================== in Electron ====================================================
async function inElectron(role, temp) {
  const { app, BrowserWindow, ipcMain, nativeImage, screen } = require("electron");
  const profile = path.join(temp, "profile", role);
  for (const name of ["userData", "sessionData", "crashDumps", "logs"]) {
    fs.mkdirSync(path.join(profile, name), { recursive: true });
    app.setPath(name, path.join(profile, name));
  }
  app.commandLine.appendSwitch("use-fake-device-for-media-stream"); // a second lock on the real microphone
  require(path.join(SRC, "meetings", "capture", "own-audio")).excludeOwnPlayback(app);
  app.on("window-all-closed", () => {});

  // The pipeline's network: a provider that says one line for every part that has sound.
  const sent = [];
  async function fakeFetch(url, options = {}) {
    const address = String(url);
    if (address.endsWith("/audio/transcriptions")) {
      const wav = Buffer.from(await options.body.get("file").arrayBuffer());
      sent.push({ kind: "transcription", seconds: (wav.length - 44) / 2 / RATE });
      return new Response(JSON.stringify({ text: "The delivery check moves to the server next week.", languages: [{ code: "en" }] }));
    }
    if (address.endsWith("/chat/completions")) {
      sent.push({ kind: "summary" });
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ brief: "A short sync.", topics: [] }) } }] }));
    }
    throw new Error("the test reaches no network");
  }
  const Module = require("node:module");
  const network = require.resolve(path.join(SRC, "network"));
  require.cache[network] = Object.assign(new Module(network), { filename: network, loaded: true, exports: { fetch: fakeFetch } });

  const meetings = name => require(path.join(SRC, "meetings", name));
  const { createMeetingStore } = meetings("store");
  const { createMeetingRecorder } = meetings("recorder");
  const { createMeetingAudio } = meetings("audio");
  const { createPipeline } = meetings("pipeline");
  const { createDisplays } = meetings("capture/displays");
  const { openPage } = meetings("capture/hidden-page");
  const files = meetings("capture/recording-file");
  const { canExclude } = meetings("capture/own-audio");
  const { workKey } = meetings("work");
  const pcm = meetings("pcm");

  await app.whenReady();
  ipcMain.on("prefs:get", event => { event.returnValue = { language: "en", theme: "dark" }; }); // the dictation page's

  const withStubs = name => {
    const file = path.join(profile, `${path.basename(name, ".js")}-synthetic.js`);
    fs.writeFileSync(file, `${fs.readFileSync(name, "utf8")}
contextBridge.executeInMainWorld({ func: ${synthetic.toString()}, args: ${JSON.stringify([TONE, AMPLITUDE])} });
`);
    return file;
  };
  const preload = withStubs(path.join(SRC, "meetings", "capture", "preload.js"));
  const refuseAll = session => {
    session.setPermissionRequestHandler((_wc, _permission, answer) => answer(false));
    session.setPermissionCheckHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, answer) => answer(null));
  };
  const openCapture = options => openPage({ html: "capture.html", partition: "meetings-test", configure: refuseAll, preload, ...options });

  const real = createDisplays();
  const displays = {
    list: () => real.list({ thumbnails: false }),
    async capture(ids) {
      const list = await real.list({ thumbnails: false });
      return ids.map(id => {
        const { width, height } = list.find(d => d.id === id), bgra = Buffer.alloc(width * height * 4, 255);
        for (let i = 0; i < bgra.length; i += 4) bgra[i] = i % 251; // lines, not a screen
        return { id, width, height, bgra };
      });
    }
  };

  const project = path.join(temp, "sample-project"), workDir = path.join(temp, "work");
  fs.mkdirSync(project, { recursive: true });
  const store = createMeetingStore({ home: path.join(temp, "home"), trash: target => fs.promises.rm(target, { recursive: true }) });
  const audio = createMeetingAudio({ store, workDir });
  const events = [];
  audio.on("compression", event => events.push({ event: "compression", ...event }));
  const held = { keys: 0, awake: 0 };
  const recorder = createMeetingRecorder({
    store, workDir, audio, openPage: openCapture, displays,
    shortcuts: () => { held.keys++; return { close: () => { held.keys--; } }; },
    awake: () => { held.awake++; return () => { held.awake--; }; }
  });
  for (const type of ["status", "warning", "screenshot", "ended", "levels"]) recorder.on(type, event => events.push({ event: type, ...event }));

  const say = (name, value = "") => console.log(`${name} ${typeof value === "string" ? value : JSON.stringify(value)}`);
  async function until(check, what, ms = 15000) {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (await check()) return;
      await sleep(50);
    }
    assert.fail(`still not: ${what}`);
  }
  const capturePage = () => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith("capture.html"));
  const compressed = id => until(async () => Boolean((await store.read(project, id)).audio.mic), "compressed", 600000);

  // Each 100 ms: how much of which tone a channel holds.
  function tones(file) {
    const bytes = fs.readFileSync(file), size = RATE / 10, found = [];
    for (let from = 0; from + size <= bytes.length / 2; from += size) {
      const amps = Object.values(TONE).map(freq => {
        let re = 0, im = 0;
        for (let i = 0; i < size; i++) {
          const v = bytes.readInt16LE((from + i) * 2) / 32768;
          re += v * Math.cos((2 * Math.PI * freq * i) / RATE);
          im += v * Math.sin((2 * Math.PI * freq * i) / RATE);
        }
        return (2 * Math.hypot(re, im)) / size;
      });
      found.push({ mic: amps[0], system: amps[1] });
    }
    return found;
  }

  if (role === "crash") {
    const [display] = await displays.list();
    const { meeting } = await recorder.start({ project, title: "Crash", monitors: [display.id] });
    await until(() => events.some(e => e.event === "levels"), "sound");
    console.log(`@@recording ${meeting.id} ${Date.now() - events.find(e => e.event === "levels").elapsedMs}`);
    await sleep(120000); // killed by the test
    return;
  }

  if (role === "recover") {
    const [left] = await recorder.recoverable();
    assert.deepEqual([left.kind, left.code], ["interrupted", null]);
    assert.equal((await store.read(project, left.id)).state, "recording");
    await recorder.recover();
    await compressed(left.id);
    await until(() => !audio.active().length, "compression over");
    const meeting = await store.read(project, left.id);
    assert.deepEqual([meeting.state, meeting.error], ["recorded", { code: "meetingsRecordingInterrupted" }]);
    const opened = await audio.openAudio(project, meeting);
    assert.ok(tones(opened.mic).filter(t => Math.abs(t.mic - AMPLITUDE) < 0.05).length >= 10, "the recovered sound is the sound");
    await opened.cleanup();
    assert.deepEqual(await recorder.recoverable(), []);
    console.log(`@@recovered ${meeting.durationMs}`);
    return;
  }

  // ---------- role "main" ----------
  assert.match(app.commandLine.getSwitchValue("disable-features"), /RestrictOwnAudioAddChromiumBack/);
  const offered = await recorder.devices({ thumbnails: false });
  assert.deepEqual(offered.microphones, [{ deviceId: "default", label: "Default - Synthetic microphone", isDefault: true }]);
  assert.equal(offered.displays.length, screen.getAllDisplays().length);
  assert.ok(offered.displays.every((d, i) => d.monitor === i + 1 && d.width > 0 && d.height > 0));
  assert.equal(BrowserWindow.getAllWindows().length, 0, "the device list leaves no window");
  say("ok   devices", `${offered.displays.length} displays, ${offered.displays.map(d => `${d.width}x${d.height}`).join(", ")}`);

  const { meeting, status } = await recorder.start({ project, title: "Payments sync", monitors: offered.displays.map(d => d.id) });
  assert.deepEqual([status.phase, meeting.state, held.keys, held.awake], ["recording", "recording", 1, 1]);
  assert.equal(status.recording.microphone.label, "Synthetic microphone");
  const page = capturePage();
  assert.equal(page.isVisible(), false);
  const asked = await page.webContents.executeJavaScript("JSON.parse(JSON.stringify(window.synthetic.asked))");
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  assert.deepEqual(asked.find(a => a.channel === "mic").constraints.audio, { ...raw, channelCount: 1 });
  assert.deepEqual(asked.find(a => a.channel === "system").constraints, { video: false, audio: canExclude() ? { ...raw, restrictOwnAudio: true } : raw });
  assert.equal(await page.webContents.executeJavaScript("typeof require"), "undefined", "sandboxed");
  say("ok   start: hidden, sandboxed, raw sound, no screen for the sound");

  const levels = () => events.filter(e => e.event === "levels");
  await until(() => levels().length, "levels");
  const began = Date.now() - levels()[0].elapsedMs;
  await sleep(3000);
  assert.ok(levels().at(-1).mic > 0.2 && levels().at(-1).system > 0.2);

  // The dictation, with the switch and beside the recording.
  const dictation = require(path.join(SRC, "voice", "recorder")).createRecorder({ preloadPath: withStubs(path.join(SRC, "voice", "ui", "recorder-preload.js")) });
  const wav = path.join(temp, "dictation.wav");
  const before = levels().length;
  await dictation.start({ wavPath: wav });
  await sleep(2000);
  const dictated = await dictation.stop();
  dictation.destroy();
  assert.ok(dictated.durationMs > 1500 && !dictated.error, `dictated ${dictated.durationMs} ms`);
  const body = path.join(temp, "dictation.pcm");
  fs.writeFileSync(body, fs.readFileSync(wav).subarray(44));
  assert.ok(tones(body).slice(5, -2).every(t => Math.abs(t.mic - AMPLITUDE) < 0.05), "the dictation heard its microphone");
  assert.ok(levels().length - before >= 18, "and the recording went on");
  say("ok   dictation while recording", `${dictated.durationMs} ms`);

  // Read aloud plays through a 24 kHz context; here without any sound.
  const player = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition: "meetings-test-player" } });
  await player.loadFile(path.join(SRC, "meetings", "capture", "codec.html"));
  const played = await player.webContents.executeJavaScript(`(async () => {
    const context = new AudioContext({ sampleRate: 24000, latencyHint: "playback" });
    const source = new AudioBufferSourceNode(context, { buffer: context.createBuffer(1, 24000, 24000) });
    source.connect(context.destination); source.start();
    await context.resume();
    await new Promise(done => setTimeout(done, 1500));
    const at = context.currentTime; await context.close(); return at;
  })()`);
  player.destroy();
  assert.ok(played > 0.5, `playback ran ${played} s`);
  say("ok   read aloud's player runs with the switch", `${played.toFixed(2)} s`);

  const shot = await recorder.screenshot();
  assert.equal(shot.screens.length, offered.displays.length);
  for (const [i, taken] of shot.screens.entries()) {
    const size = nativeImage.createFromPath(await store.filePath(project, meeting.id, taken.file)).getSize();
    assert.deepEqual(size, { width: offered.displays[i].width, height: offered.displays[i].height }, "full resolution");
  }
  assert.ok(Math.abs(shot.atMs - (Date.now() - began)) < 5000);
  say("ok   screenshots in the meeting", shot.screens.map(s => s.file).join(", "));

  await page.webContents.executeJavaScript("window.synthetic.lose('system')");
  await until(() => events.some(e => e.code === "meetingsSystemLost" && !e.active), "the system sound back");
  assert.ok(events.some(e => e.code === "meetingsSystemLost" && e.active));
  say("ok   a lost source is said and opened again");

  const blockedAt = levels().at(-1).elapsedMs;
  const pageBefore = capturePage();
  for (const end = Date.now() + 4000; Date.now() < end;);
  await until(() => levels().at(-1).elapsedMs >= blockedAt + 3800, "nothing lost to a blocked main process", 3000);
  await sleep(1300);
  assert.equal(capturePage(), pageBefore, "and its page is not taken for dead");
  assert.ok(!events.some(e => e.code === "meetingsCaptureLost"));
  say("ok   a blocked main process loses nothing");

  // Chromium's audio service, this app's own, is what an output that goes away takes with it.
  await sleep(1000);
  const service = app.getAppMetrics().find(m => m.serviceName === "audio.mojom.AudioService");
  process.kill(service.pid);
  await until(() => levels().at(-1).elapsedMs > blockedAt + 9000 && levels().at(-1).mic > 0.2, "the sound back after the audio service", 20000);
  say("ok   the audio service killed: the sound comes back", events.some(e => e.code === "meetingsCaptureLost") ? "after a restart of the page" : "in the same page");

  await sleep(1000);
  const lostBefore = events.filter(e => e.code === "meetingsCaptureLost" && !e.active).length;
  process.kill(capturePage().webContents.getOSProcessId());
  await until(() => events.filter(e => e.code === "meetingsCaptureLost" && !e.active).length > lostBefore, "capture restarted");
  await sleep(2000);
  const stopAt = Date.now();
  const stopped = await recorder.stop();
  assert.deepEqual([stopped.state, stopped.error, held.keys, held.awake], ["recorded", null, 0, 0]);
  assert.ok(Math.abs(stopped.durationMs - (stopAt - began)) < 700, `${stopped.durationMs} ms of ${stopAt - began}`);
  say("ok   a killed capture page: the timeline holds", `${stopped.durationMs} ms recorded, ${stopAt - began} ms passed`);

  await compressed(meeting.id);
  await until(() => !audio.active().length && events.some(e => e.type === "finished"), "compression over");
  const recorded = await store.read(project, meeting.id);
  assert.equal(fs.existsSync(files.recordingDir(path.join(workDir, workKey(recorded)))), false, "the raw sound is gone");
  const opened = await audio.openAudio(project, recorded);
  for (const [channel, other] of [["mic", "system"], ["system", "mic"]]) {
    assert.equal(await pcm.durationMs(opened[channel]), recorded.durationMs, "exactly the recording's length");
    const found = tones(opened[channel]);
    const good = found.filter(t => Math.abs(t[channel] - AMPLITUDE) < 0.06).length;
    assert.ok(good >= found.length * 0.8, `${channel}: ${good} of ${found.length}`);
    assert.ok(found.every(t => t[other] < 0.08), `${other} does not leak into ${channel}`);
    assert.ok(found.slice(-5).some(t => t[channel] > 0.15), `${channel} goes on after the restart`);
  }
  await opened.cleanup();
  const bytes = await store.size(project, meeting.id);
  say("ok   WebM and back", `${recorded.durationMs} ms, ${bytes.audio} bytes of audio`);

  const choice = { transcription: { provider: "OpenAI", model: "gpt-transcribe" }, summary: { provider: "OpenAI", model: "gpt-6-luna" }, languages: ["en"] };
  const pipeline = createPipeline({ store, workDir, openAudio: audio.openAudio, getSettings: () => ({}), getApiKey: async () => "test-key" });
  for (const again of [false, true]) {
    sent.length = 0;
    const ready = await pipeline.start(project, meeting.id, { ...choice, again });
    assert.deepEqual([ready.state, ready.error], ["ready", null]);
    const parts = sent.filter(s => s.kind === "transcription");
    assert.ok(parts.length >= 2 && parts.every(p => p.seconds > 0 && p.seconds <= recorded.durationMs / 1000 + 0.1));
    assert.ok(!fs.existsSync(path.join(workDir, workKey(recorded), "decoded")), "the decoded sound is cleaned up");
  }
  await pipeline.stop();
  assert.match(fs.readFileSync(await store.filePath(project, meeting.id, "transcript.md"), "utf8"), /screens\//);
  say("ok   openAudio into the pipeline, and again from WebM");

  const abort = new AbortController();
  const reading = audio.openAudio(project, await store.read(project, meeting.id), { signal: abort.signal });
  setTimeout(() => abort.abort(), 60);
  await assert.rejects(reading, e => e.name === "AbortError");
  await until(() => !BrowserWindow.getAllWindows().length, "the codec's window closed");
  say("ok   cancel closes the codec");

  for (const frames of [1, 160, 1600, RATE * 11]) {
    const startedAt = Date.now() + frames;
    const short = await store.create(project, { title: `Short ${frames}`, startedAt, durationMs: Math.floor(frames / 16) });
    const dir = files.recordingDir(path.join(workDir, workKey(short)));
    const file = await files.createRecordingFile(dir, { project, id: short.id, startedAt });
    file.append(Buffer.alloc(frames * 4, 3));
    await file.close();
    const done = await audio.compress(project, short.id);
    const back = await audio.openAudio(project, done);
    assert.equal(await pcm.durationMs(back.mic), Math.floor(frames / 16));
    await back.cleanup();
  }
  say("ok   the shortest recordings compress");

  const broken = await store.create(project, { title: "Broken file", startedAt: Date.now(), durationMs: 5000, audio: { mic: "audio/mic.webm", system: null } });
  await store.write(project, broken.id, "audio/mic.webm", Buffer.alloc(5000, 7));
  await assert.rejects(audio.openAudio(project, broken), e => e.code === "meetingsAudioUnreadable");
  say("ok   a broken WebM is said, not guessed");

  const minutes = Number(process.env.MEETINGS_LONG_MINUTES || 0);
  if (minutes) {
    const startedAt = Date.now(), frames = minutes * 60 * RATE;
    const long = await store.create(project, { title: "Long", startedAt, durationMs: frames / 16 });
    const file = await files.createRecordingFile(files.recordingDir(path.join(workDir, workKey(long))), { project, id: long.id, startedAt });
    const second = Buffer.alloc(RATE * 4);
    for (let i = 0; i < RATE; i++) {
      const gate = 0.25 * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / RATE));
      second.writeInt16LE(Math.round(32767 * gate * Math.sin((2 * Math.PI * TONE.mic * i) / RATE)), i * 4);
      second.writeInt16LE(Math.round(32767 * gate * Math.sin((2 * Math.PI * TONE.system * i) / RATE)), i * 4 + 2);
    }
    for (let i = 0; i < frames / RATE; i++) file.append(second);
    await file.close();
    let most = 0;
    const measure = setInterval(() => { most = Math.max(most, app.getAppMetrics().reduce((sum, m) => sum + m.memory.privateBytes, 0)); }, 500);
    let at = Date.now();
    const done = await audio.compress(project, long.id);
    const encodeS = (Date.now() - at) / 1000;
    at = Date.now();
    const back = await audio.openAudio(project, done);
    const decodeS = (Date.now() - at) / 1000;
    clearInterval(measure);
    for (const channel of ["mic", "system"]) assert.equal(await pcm.durationMs(back[channel]), frames / 16);
    await back.cleanup();
    say("ok   long", { minutes, encodeS, decodeS, peakPrivateMB: Math.round(most / 1024), audioBytes: (await store.size(project, long.id)).audio });
  }

  const { registerShortcut } = meetings("capture/shortcut");
  const key = "Control+Alt+Shift+F20";
  const first = registerShortcut(key, () => {});
  if (first.code === "meetingsShortcutInvalid") say("skip the real key", "F20 is not a key here");
  else {
    try {
      assert.equal(first.code, undefined);
      assert.equal(registerShortcut(key, () => {}).code, "meetingsShortcutTaken", "a conflict is said");
    } finally {
      first.close?.();
    }
    const again = registerShortcut(key, () => {});
    assert.equal(again.code, undefined, "and it was released");
    again.close();
    say("ok   the key: conflict said, released");
  }

  await recorder.shutdown();
  assert.equal(BrowserWindow.getAllWindows().length, 0, "no window left");
  say("ok   no window, key or blocker left");
}

// ====================================================== the test ======================================================
async function driver() {
  if (process.platform !== "win32") return console.log("skip: meetings are recorded on Windows only");
  const { spawn, execFileSync } = require("node:child_process");
  const electron = require("electron");
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-recorder-e2e-")));
  const children = new Set();
  const env = { ...process.env, MEETINGS_E2E_TEMP: temp, GIT_CEILING_DIRECTORIES: path.dirname(temp) };
  for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|AGENTDECK_)|(API_KEY|TOKEN|SECRET)/i.test(key)) delete env[key];

  // The tree of a child whose handle is still ours, so its PID is still its own.
  const stopTree = child => {
    if (child.exitCode !== null || child.signalCode) return;
    try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
  };
  function launch(role, onLine = () => {}) {
    const child = spawn(electron, [__filename], { env: { ...env, MEETINGS_E2E_ROLE: role }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let buffer = "", errors = "";
    child.stdout.on("data", data => {
      buffer += data;
      for (let at; (at = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(at + 1)) {
        const line = buffer.slice(0, at).trimEnd();
        if (line.startsWith("@@")) onLine(line);
        else if (line) console.log(line);
      }
    });
    child.stderr.on("data", data => { errors = (errors + data).slice(-8000); });
    const limit = setTimeout(() => stopTree(child), role === "main" ? 1500_000 : 120_000);
    const ended = new Promise(resolve => child.once("close", code => {
      clearTimeout(limit);
      children.delete(child);
      resolve({ code, errors });
    }));
    return { child, ended };
  }

  try {
    const main = await launch("main").ended;
    assert.equal(main.code, 0, main.errors);

    let recordingSince = 0;
    const crashing = launch("crash", line => { recordingSince = Number(line.split(" ")[2]); });
    for (const end = Date.now() + 30000; !recordingSince && Date.now() < end;) await sleep(50);
    assert.ok(recordingSince, "the recording to be killed began");
    await sleep(5000);
    const killedAt = Date.now();
    crashing.child.kill("SIGKILL"); // that process alone, as a crash would
    await crashing.ended;
    await sleep(1000);
    let kept = 0;
    const recovering = await launch("recover", line => { kept = Number(line.split(" ")[1]); }).ended;
    assert.equal(recovering.code, 0, recovering.errors);
    const lost = killedAt - recordingSince - kept;
    assert.ok(kept > 0 && lost < 5000, `${lost} ms lost`);
    console.log(`ok   killed while recording: ${lost} ms lost, recovered and compressed`);
    console.log("meetings recorder (Electron): all passed");
  } finally {
    for (const child of children) stopTree(child);
    await sleep(500);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

if (process.versions.electron) {
  inElectron(process.env.MEETINGS_E2E_ROLE, process.env.MEETINGS_E2E_TEMP).then(
    () => require("electron").app.exit(0),
    error => {
      console.error(error?.stack || error);
      require("electron").app.exit(1);
    }
  );
} else {
  driver().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
