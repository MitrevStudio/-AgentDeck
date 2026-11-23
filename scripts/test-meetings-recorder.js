// The meetings' recorder without Electron: the work files and what a kill loses of them, the states, recovery, the
// screenshots' names and failures, openAudio from the raw recording. The capture page, the screens, the key and the
// codec are fakes; the sound is numbers made here. The real pages: test-meetings-recorder-electron.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { fork } = require("node:child_process");

const SRC = path.join(__dirname, "..", "src");
const meetings = name => require(path.join(SRC, "meetings", name));
const files = meetings("capture/recording-file");
const RATE = 16000, CHUNK = 1600;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 100 ms of the two channels, every sample telling where it is.
function samples(from, frames = CHUNK) {
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE((from + i) % 30000 + 1, i * 4);
    pcm.writeInt16LE(-((from + i) % 30000) - 1, i * 4 + 2);
  }
  return pcm;
}

// The child that is killed: a recording that says how much it was given.
if (process.argv[2] === "writer") {
  files.createRecordingFile(process.argv[3], { project: process.argv[4], id: "x", startedAt: 1 }).then(file => {
    let given = 0;
    setInterval(() => {
      file.append(samples(given));
      given += CHUNK;
      process.send({ given });
    }, 100);
  });
  return;
}

const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-recorder-")));
process.env.GIT_CEILING_DIRECTORIES = path.dirname(temp);
const { createMeetingStore } = meetings("store");
const { createPipeline } = meetings("pipeline");
const { createMeetingRecorder, DEFAULT_SHORTCUT } = meetings("recorder");
const { createMeetingAudio } = meetings("audio");
const { createLive } = meetings("capture/live");
const { registerShortcut } = meetings("capture/shortcut");
const { matchDisplays, sourceOf, isBlank } = meetings("capture/displays");
const { screenName } = meetings("capture/screenshot");
const { encodePng } = meetings("capture/png");
const { excludeOwnPlayback } = meetings("capture/own-audio");
const { isScreen } = meetings("meeting");
const { MESSAGES } = meetings("errors");
const { workKey } = meetings("work");

async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await sleep(20);
  }
  assert.fail(`still not: ${what}`);
}
const rejects = (code, promise) => assert.rejects(promise, e => e.code === code && Boolean(e.message), code);

// ---------- the fakes ----------
const DISPLAYS = [
  { id: "11", monitor: 1, label: "Left", primary: true, width: 64, height: 40, bounds: { x: 0, y: 0, width: 64, height: 40 } },
  { id: "22", monitor: 2, label: "Right", primary: false, width: 32, height: 20, bounds: { x: 64, y: 0, width: 32, height: 20 } }
];
const picture = ({ width, height }) => Buffer.alloc(width * height * 4, 180);

let worlds = 0;
function world(options = {}) {
  const root = path.join(temp, `world-${++worlds}`), project = path.join(root, "sample-project"), workDir = path.join(root, "work");
  fs.mkdirSync(project, { recursive: true });
  const w = {
    project, workDir, pages: [], events: [], pressed: null, keys: { held: 0, refuse: false }, awake: 0, free: 50e9,
    trashFails: false, refuseMic: false, codecFails: false, codecWaits: false, capture: null
  };
  w.store = createMeetingStore({
    home: path.join(root, "home"),
    trash: async target => {
      if (w.trashFails) throw new Error("no bin");
      await fs.promises.rm(target, { recursive: true });
    }
  });
  const openPage = ({ on = {}, onGone } = {}) => {
    const page = { on, onGone, closed: false, calls: [], frames: 0 };
    page.send = (count = 10, peaks = [0.2, 0.2]) => {
      for (let i = 0; i < count; i++) {
        on.chunk({ pcm: samples(page.frames), peaks });
        page.frames += CHUNK;
      }
    };
    page.close = () => { page.closed = true; };
    page.call = async (cmd, args) => {
      if (page.closed) throw new Error("the page was closed");
      page.calls.push([cmd, args]);
      if (cmd === "list") return [{ deviceId: "default", label: "Synthetic", isDefault: true }];
      if (cmd === "open") return w.refuseMic ? { failed: { channel: "mic", detail: "NotAllowedError" } } : { microphone: { deviceId: "default", label: "Synthetic" }, lost: [] };
      return true;
    };
    w.pages.push(page);
    return page;
  };
  // Not Opus: each channel as it is, which is enough to see what audio.js does with it.
  const withCodec = async ({ files: named, signal, onProgress }, fn) => {
    signal?.throwIfAborted();
    const call = async (cmd, args) => {
      if (w.codecWaits) await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      if (w.codecFails) throw new Error("no encoder");
      if (cmd === "encode") {
        const all = fs.readFileSync(named[args.source].path);
        args.outputs.forEach((name, c) => {
          const mono = Buffer.alloc(args.frames * 2);
          for (let i = 0; i < args.frames; i++) all.copy(mono, i * 2, i * 4 + c * 2, i * 4 + c * 2 + 2);
          fs.writeFileSync(named[name].path, mono);
        });
        onProgress?.(args.frames);
      }
      if (cmd === "decode") {
        const bytes = fs.readFileSync(named[args.source].path);
        fs.writeFileSync(named[args.output].path, Buffer.concat([bytes, Buffer.alloc(572)])); // a decoder's padding
        return bytes.length / 2 + 286;
      }
      return true;
    };
    return fn(call);
  };
  const displays = {
    list: async () => DISPLAYS,
    capture: async ids => (w.capture ? w.capture(ids) : ids.map(id => {
      const { width, height } = DISPLAYS.find(d => d.id === id);
      return { id, width, height, bgra: picture({ width, height }) };
    }))
  };
  w.open = (extra = {}) => {
    const audio = createMeetingAudio({ store: w.store, workDir, withCodec });
    const recorder = createMeetingRecorder({
      store: w.store, workDir, audio, platform: "win32", excludeOwn: true, openPage, displays,
      shortcuts: (accelerator, press) => {
        if (w.keys.refuse) return { code: "meetingsShortcutTaken" };
        w.pressed = press;
        w.keys.held++;
        w.keys.accelerator = accelerator;
        return { close: () => { w.keys.held--; w.pressed = null; } };
      },
      awake: () => {
        w.awake++;
        return () => { w.awake--; };
      },
      free: async () => w.free,
      ...options, ...extra
    });
    for (const type of ["status", "levels", "warning", "screenshot", "ended"]) recorder.on(type, event => w.events.push({ type, ...event }));
    audio.on("compression", event => w.events.push({ event: "compression", ...event }));
    return { recorder, audio };
  };
  Object.assign(w, w.open());
  w.page = () => w.pages.at(-1);
  w.start = (more = {}) => w.recorder.start({ project, title: "Planning", monitors: ["11", "22"], ...more });
  w.read = id => w.store.read(project, id);
  w.dir = meeting => files.recordingDir(path.join(workDir, workKey(meeting)));
  w.index = () => fs.readFileSync(path.join(project, ".claude", "meetings", "INDEX.md"), "utf8");
  const ends = () => w.events.filter(e => e.event === "compression" && (e.type === "finished" || e.type === "failed")).length;
  let seen = 0;
  w.settled = async (count = 1) => {
    await until(() => ends() >= seen + count && !w.audio.active().length, "compressed", 15000);
    seen = ends();
  };
  return w;
}

// What a crash leaves: the meeting saying "recording" and its work.
async function crashed(w, { frames = RATE * 2, stopped = false, title = "Crashed", startedAt = Date.now() } = {}) {
  const meeting = await w.store.create(w.project, { title, startedAt, state: "recording" }), dir = w.dir(meeting);
  const file = await files.createRecordingFile(dir, { project: w.project, id: meeting.id, startedAt });
  if (frames) file.append(samples(0, frames));
  await file.close();
  if (!stopped) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ state: "recording" }));
  return { meeting, dir };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- the files ----------
test("a killed writer loses less than two seconds", async () => {
  const losses = [];
  for (const ms of [2300, 3750]) {
    const dir = path.join(temp, `killed-${ms}`);
    const child = fork(__filename, ["writer", dir, temp], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let given = 0;
    child.on("message", m => { given = m.given; });
    await sleep(ms);
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const read = await files.readRecording(dir);
    assert.equal(read.stopped, false);
    assert.ok(read.frames > 0, "something is on disk");
    assert.ok(given - read.frames <= RATE * 2, `${(given - read.frames) / RATE} s lost`);
    assert.deepEqual(fs.readFileSync(files.pcmPath(dir)).subarray(0, read.frames * 4), samples(0, read.frames), "and it is what was given");
    losses.push((given - read.frames) / 16);
  }
  return `lost ${losses.join(", ")} ms`;
});

test("a torn frame and a broken state are recovered", async () => {
  const dir = path.join(temp, "torn"), file = await files.createRecordingFile(dir, { project: temp, id: "x", startedAt: 5 });
  file.append(samples(0));
  await file.close();
  fs.appendFileSync(files.pcmPath(dir), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, "state.json"), '{"sta');
  const read = await files.readRecording(dir);
  assert.deepEqual([read.frames, read.stopped], [CHUNK, false]);
  await files.closeInterrupted(dir, read);
  assert.equal(fs.statSync(files.pcmPath(dir)).size, CHUNK * 4);
  assert.equal((await files.readRecording(dir)).stopped, true);
  fs.writeFileSync(path.join(dir, "recording.json"), "{");
  assert.equal(await files.readRecording(dir), null);
});

test("silence is written as zeros, however long", async () => {
  const dir = path.join(temp, "silence"), file = await files.createRecordingFile(dir, { project: temp, id: "x", startedAt: 5 });
  const long = 600000; // more than one buffer of zeros
  file.append(samples(0));
  file.silence(long);
  file.append(samples(CHUNK));
  assert.equal(await file.close(), 2 * CHUNK + long);
  const bytes = fs.readFileSync(files.pcmPath(dir));
  assert.equal(bytes.length, (2 * CHUNK + long) * 4);
  assert.ok(bytes.subarray(CHUNK * 4, (CHUNK + long) * 4).every(v => v === 0));
  assert.deepEqual(bytes.subarray(-CHUNK * 4), samples(CHUNK));
});

test("a write that failed is written again in its place; a full disk is said once", async () => {
  let plan = ["EIO"], failed = [];
  const open = async (file, flags) => {
    const handle = await fs.promises.open(file, flags);
    return {
      write: async (buffer, offset, length, position) => {
        const code = plan.shift();
        if (!code) return handle.write(buffer, offset, length, position);
        await handle.write(buffer, offset, Math.floor(length / 3), position); // half written
        throw Object.assign(new Error(code), { code });
      },
      datasync: () => handle.datasync(), truncate: n => handle.truncate(n), close: () => handle.close()
    };
  };
  const make = name => files.createRecordingFile(path.join(temp, name), { project: temp, id: "x", startedAt: 5 }, { open, onFailed: e => failed.push(e.code) });
  let file = await make("retried");
  file.append(samples(0));
  await sleep(2300);
  await file.close();
  assert.deepEqual(failed, []);
  assert.deepEqual(fs.readFileSync(files.pcmPath(path.join(temp, "retried"))), samples(0));

  plan = ["ENOSPC"];
  file = await make("full");
  file.append(samples(0));
  await sleep(1200);
  file.append(samples(CHUNK));
  assert.equal(await file.close(), 0);
  assert.deepEqual(failed, ["ENOSPC"]);

  // At the last flush: tried again, then said, never dropped quietly.
  plan = ["EIO"];
  file = await make("closed-retried");
  file.append(samples(0));
  assert.equal(await file.close(), CHUNK);
  assert.deepEqual(failed, ["ENOSPC"]);
  plan = Array(10).fill("EIO");
  file = await make("closed-failing");
  file.append(samples(0));
  assert.equal(await file.close(), 0);
  assert.deepEqual(failed, ["ENOSPC", "EIO"]);
});

// ---------- a recording ----------
test("start, record, screenshots, stop, compressed, audio back", async () => {
  const w = world();
  assert.deepEqual(w.recorder.status(), { phase: "idle", recording: null });
  assert.equal(w.keys.held, 0, "no key before");
  const { meeting, status } = await w.start();
  assert.equal(meeting.state, "recording");
  assert.match(w.index(), /Being recorded now/);
  assert.equal(status.phase, "recording");
  assert.deepEqual(status.recording.monitors, [{ id: "11", monitor: 1, label: "Left" }, { id: "22", monitor: 2, label: "Right" }]);
  assert.deepEqual(status.recording.shortcut, { accelerator: DEFAULT_SHORTCUT, registered: true });
  assert.deepEqual(status.recording.warnings, []);
  assert.deepEqual([w.keys.held, w.awake], [1, 1]);
  await rejects("meetingsAlreadyRecording", w.start());
  await rejects("meetingsStillRecording", w.audio.openAudio(w.project, meeting));
  await rejects("meetingsStillRecording", w.audio.compress(w.project, meeting.id));
  await rejects("meetingsStillRecording", w.audio.removeAudio(w.project, meeting.id));
  await rejects("meetingsStillRecording", w.recorder.release(w.project, meeting.id));
  assert.deepEqual(await w.recorder.recoverable(), [], "the one that runs is not recovered");
  await w.recorder.recover(w.project);
  assert.equal((await w.read(meeting.id)).state, "recording");

  w.page().send(50);
  const levels = w.events.filter(e => e.type === "levels");
  assert.deepEqual([levels.length, levels.at(-1).elapsedMs, levels.at(-1).mic], [50, 5000, 0.2]);

  const shot = await w.recorder.screenshot();
  assert.deepEqual(shot.screens.map(s => s.file), ["screens/00-00-05-m1.png", "screens/00-00-05-m2.png"]);
  assert.ok(shot.atMs >= 5000 && shot.atMs < 5500, "by the recording's clock");
  w.pressed();
  await until(() => w.events.filter(e => e.type === "screenshot").length === 2, "the key's screenshot");
  const again = w.events.filter(e => e.type === "screenshot")[1];
  assert.deepEqual(again.screens.map(s => s.file), ["screens/00-00-05-m1-2.png", "screens/00-00-05-m2-2.png"], "twice in a second");
  const png = fs.readFileSync(await w.store.filePath(w.project, meeting.id, shot.screens[0].file));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 40]);
  assert.equal(w.recorder.status().recording.screens, 4);

  w.page().send(50);
  const stopped = await w.recorder.stop();
  assert.deepEqual([stopped.state, stopped.durationMs, stopped.error, stopped.screens.length], ["recorded", 10000, null, 4]);
  assert.deepEqual([w.keys.held, w.awake, w.page().closed], [0, 0, true]);
  assert.deepEqual(w.events.find(e => e.type === "ended")?.reason, "stopped");
  await rejects("meetingsNotRecording", w.recorder.screenshot());
  assert.equal(await w.recorder.stop(), null);

  await w.settled();
  const done = await w.read(meeting.id);
  assert.deepEqual(done.audio, { mic: "audio/mic.webm", system: "audio/system.webm" });
  assert.equal(fs.existsSync(w.dir(meeting)), false, "the raw recording is gone");
  const back = await w.audio.openAudio(w.project, done);
  for (const [c, channel] of ["mic", "system"].entries()) {
    const bytes = fs.readFileSync(back[channel]);
    assert.equal(bytes.length, 10 * RATE * 2, "trimmed to the recording");
    assert.equal(bytes.readInt16LE(2 * 1000), c ? -1001 : 1001);
  }
  await back.cleanup();
  assert.equal(fs.existsSync(back.mic), false);
});

test("a key that is taken, or a screen without pixels, never stops it", async () => {
  const w = world();
  w.keys.refuse = true;
  const { meeting, status } = await w.start();
  assert.deepEqual(status.recording.shortcut.registered, false);
  assert.deepEqual(status.recording.warnings, [{ code: "meetingsShortcutTaken" }]);
  w.capture = async ids => ids.map((id, i) => (i ? { id, code: "meetingsScreenBlank" } : { id, width: 64, height: 40, bgra: picture({ width: 64, height: 40 }) }));
  let shot = await w.recorder.screenshot();
  assert.deepEqual([shot.screens.length, shot.failed], [1, [{ monitor: 2, code: "meetingsScreenBlank" }]]);
  assert.ok(w.recorder.status().recording.warnings.some(x => x.code === "meetingsScreenBlank" && x.monitor === 2));
  w.capture = async () => { throw new Error("no capturer"); };
  shot = await w.recorder.screenshot();
  assert.deepEqual(shot.failed.map(f => f.code), ["meetingsScreenFailed", "meetingsScreenFailed"]);
  w.capture = null;
  await w.recorder.screenshot();
  assert.deepEqual(w.recorder.status().recording.warnings, [{ code: "meetingsShortcutTaken" }], "a screenshot that worked clears them");
  assert.equal(w.recorder.status().phase, "recording");
  w.page().send(5);
  await w.recorder.stop();
  assert.equal((await w.read(meeting.id)).screens.length, 3);
  await w.settled();
});

test("a screen that hangs never holds the end, whatever the reason", async () => {
  for (const reason of ["stopped", "discarded"]) {
    const w = world({ shotsWaitMs: 300 });
    const { meeting } = await w.start();
    w.page().send(20);
    let answer;
    w.capture = ids => new Promise(resolve => { answer = () => resolve(ids.map(id => ({ id, width: 32, height: 20, bgra: picture({ width: 32, height: 20 }) }))); });
    const shot = w.recorder.screenshot();
    const began = Date.now();
    if (reason === "stopped") await w.recorder.stop();
    else await w.recorder.discard();
    assert.ok(Date.now() - began < 3000, `${reason}: ended without the shot`);
    assert.equal(w.recorder.status().phase, "idle");
    answer();
    assert.deepEqual((await shot).failed.map(f => f.code), ["meetingsScreenFailed", "meetingsScreenFailed"], "late, so not written");
    if (reason === "stopped") {
      assert.deepEqual((await w.read(meeting.id)).screens, []);
      assert.equal(fs.existsSync(path.join(meeting.dir, "screens")), false);
      await w.settled();
    } else await rejects("meetingsNotFound", w.read(meeting.id));
    w.capture = null;
    await w.start(); // not held by the one before
    await w.recorder.discard();
  }
});

test("the real displays: a desktopCapturer that never answers fails the pictures, the window still closes", async () => {
  const Module = require("node:module"), load = Module._load, file = require.resolve(path.join(SRC, "meetings", "capture", "displays"));
  const electron = {
    screen: {
      getPrimaryDisplay: () => ({ id: 11 }), getAllDisplays: () => [{ id: 11, label: "Left", scaleFactor: 1, bounds: { x: 0, y: 0, width: 64, height: 40 } }],
      getDisplayNearestPoint: () => ({ id: 11 }), screenToDipPoint: p => p
    },
    desktopCapturer: { getSources: () => new Promise(() => {}) }
  };
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === file && request === "electron") return electron;
    if (parent?.filename === file && request === "./monitors") return { listMonitors: () => [{ sourceId: "screen:0:0", x: 0, y: 0, width: 64, height: 40 }] };
    return load.call(this, request, parent, isMain);
  };
  delete require.cache[file];
  let real;
  try {
    real = require(file).createDisplays({ sourcesMs: 200 });
  } finally {
    delete require.cache[file];
  }
  try {
    const listed = await real.list({ thumbnails: true });
    assert.deepEqual(listed.map(d => [d.id, d.thumbnail]), [["11", null]], "without pictures");
    await assert.rejects(real.capture(["11"]), /did not answer/);
    const w = world({ displays: real });
    const found = await w.recorder.devices();
    assert.deepEqual([found.displays.length, w.page().closed], [1, true]);
  } finally {
    Module._load = load;
  }
});

test("a dead channel, a lost device, little disk", async () => {
  const w = world();
  w.free = 500e6;
  await w.start();
  const active = () => w.recorder.status().recording.warnings.map(x => x.code).sort();
  await until(() => active().includes("meetingsDiskLow"), "the disk warning");
  const page = w.page();
  page.send(199, [0, 0]);
  assert.deepEqual(active(), ["meetingsDiskLow"]);
  page.send(1, [0, 0]);
  assert.deepEqual(active(), ["meetingsDiskLow", "meetingsMicSilent"]);
  page.send(400, [0, 0]);
  assert.deepEqual(active(), ["meetingsDiskLow", "meetingsMicSilent", "meetingsSystemSilent"]);
  page.send(1, [0.1, 0.1]);
  assert.deepEqual(active(), ["meetingsDiskLow"]);
  page.on.source({ channel: "mic", lost: true });
  page.send(300, [0, 0.1]);
  assert.deepEqual(active(), ["meetingsDiskLow", "meetingsMicLost"], "lost says more than silent");
  page.on.source({ channel: "mic", lost: false, microphone: { deviceId: "other", label: "Second" } });
  assert.deepEqual(active(), ["meetingsDiskLow"]);
  assert.equal(w.recorder.status().recording.microphone.label, "Second");
  await w.recorder.stop();
  await w.settled();
});

test("four hours warn once and go on", async () => {
  const w = world();
  await w.start();
  const page = w.page();
  page.on.chunk({ pcm: Buffer.alloc(0), peaks: [1, 1] });
  assert.equal(w.recorder.capabilities().longRecordingMs, 4 * 3600 * 1000);
  // Four hours of chunks, without their 921 MB on the disk.
  const probe = await fs.promises.open(path.join(temp, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe), { write, truncate } = prototype;
  await probe.close();
  prototype.write = async (_buffer, _offset, length) => ({ bytesWritten: length });
  prototype.truncate = async () => {};
  try {
    const chunk = Buffer.alloc(CHUNK * 4);
    for (let i = 0; i < 144000; i++) page.on.chunk({ pcm: chunk, peaks: [1, 1] });
    assert.equal(w.events.filter(e => e.code === "meetingsLongRecording").length, 1);
    assert.equal(w.recorder.status().phase, "recording");
    assert.equal(await w.recorder.discard(), true);
  } finally {
    Object.assign(prototype, { write, truncate });
  }
});

test("a dead page is replaced and the hole is silence", async () => {
  const w = world();
  const { meeting } = await w.start();
  const first = w.page();
  first.send(10);
  await sleep(250);
  first.onGone();
  await until(() => w.pages.length === 2 && w.page().calls.some(([cmd]) => cmd === "begin"), "a second page");
  assert.equal(w.page().calls[0][1].resume, true);
  assert.ok(w.recorder.status().recording.warnings.some(x => x.code === "meetingsCaptureLost"));
  first.send(5); // a late one of the dead page
  await sleep(200);
  w.page().send(1);
  assert.deepEqual(w.recorder.status().recording.warnings, []);
  w.page().send(9);
  const { durationMs } = await w.recorder.stop();
  // 1 s, the hole of at least 450 ms up to the end of the new page's first chunk, 900 ms.
  assert.ok(durationMs >= 2300 && durationMs < 3600, `${durationMs} ms`);
  assert.ok(meeting.id);
  await w.settled();
});

test("a held up main process is no dead page", async () => {
  let time = 1000, opened = 0;
  const openPage = () => {
    opened++;
    return { call: async cmd => (cmd === "open" ? { microphone: null, lost: [] } : true), close() {} };
  };
  const live = createLive({ openPage, deviceId: "default", excludeOwn: true, warn() {}, onLevels() {}, onMicrophone() {}, now: () => time });
  await live.open();
  await live.begin({ frames: 0, silence() {}, append() {} });
  time += 4000; // what a blocked event loop looks like: the tick comes before the chunks that wait
  await sleep(1150);
  assert.equal(opened, 1);
  await live.stop();
});

test("a sleep owes no sound, a stalled page does", async () => {
  let time = 1000, opened = 0, silence = 0;
  const openPage = () => {
    opened++;
    return { call: async cmd => (cmd === "open" ? { microphone: null, lost: [] } : true), close() {} };
  };
  const live = createLive({ openPage, deviceId: "default", excludeOwn: true, warn() {}, onLevels() {}, onMicrophone() {}, now: () => time });
  await live.open();
  await live.begin({ frames: 0, silence: n => { silence += n; }, append() {} });
  time += 8 * 3600 * 1000;
  await sleep(1150);
  assert.ok(live.elapsedMs() < 1000, "eight hours of sleep are not eight hours of silence");
  assert.equal(opened, 1, "and no reason to restart");
  for (let i = 0; i < 4; i++) {
    time += 1200;
    await sleep(1100);
  }
  assert.equal(opened, 2, "no sound for more than 3 s while awake: restarted");
  await live.stop();
  assert.ok(Math.abs(silence - 4800 * 16) <= 16, `${silence} frames padded`);
});

test("what cannot start leaves nothing", async () => {
  let w = world();
  await rejects("invalidData", w.recorder.start({ project: w.project, monitors: [] }));
  await rejects("invalidData", w.recorder.start());
  await rejects("meetingsScreenMissing", w.start({ monitors: ["99"] }));
  w.refuseMic = true;
  await rejects("meetingsMicUnavailable", w.start());
  assert.equal(await w.store.count(w.project), 0, "no meeting");
  assert.equal(w.recorder.status().phase, "idle");
  assert.ok(w.pages.every(p => p.closed));
  assert.deepEqual([w.keys.held, w.awake], [0, 0]);

  w = world();
  w.free = 1e6;
  await rejects("meetingsDiskFull", w.start());

  w = world({ shortcuts: () => { throw new Error("no hotkeys here"); } });
  assert.equal((await w.start()).status.phase, "recording", "a key that throws does not stop a start");
  await w.recorder.discard();

  w = world({ platform: "linux" });
  assert.deepEqual([w.recorder.capabilities().supported, w.recorder.capabilities().code], [false, "meetingsWindowsOnly"]);
  await rejects("meetingsWindowsOnly", w.start());
  await rejects("meetingsWindowsOnly", w.recorder.devices());
  assert.deepEqual(await w.recorder.recover(w.project), [], "reading and recovery work everywhere");
});

test("stop during the start, discard, a bin that refuses", async () => {
  const w = world();
  const starting = w.start();
  const stopping = w.recorder.stop();
  const [{ meeting }, stopped] = await Promise.all([starting, stopping]);
  assert.deepEqual([stopped.state, stopped.durationMs, stopped.error], ["recorded", 0, { code: "meetingsRecordingEmpty" }]);
  assert.equal(fs.existsSync(w.dir(meeting)), false);
  assert.deepEqual([w.recorder.status().phase, w.keys.held, w.awake], ["idle", 0, 0]);

  const second = (await w.start({ title: "Throw away" })).meeting;
  w.page().send(10);
  assert.equal(await w.recorder.discard(), true);
  await rejects("meetingsNotFound", w.read(second.id));
  assert.equal(fs.existsSync(w.dir(second)), false);
  assert.equal(w.events.filter(e => e.type === "ended").at(-1).reason, "discarded");

  const third = (await w.start({ title: "Kept" })).meeting;
  w.page().send(10);
  w.trashFails = true;
  await rejects("meetingsTrashFailed", w.recorder.discard());
  assert.deepEqual([(await w.read(third.id)).state, w.recorder.status().phase], ["recorded", "idle"], "what cannot be thrown away is kept");
  await w.settled();
});

test("a disk that cannot be written ends it and keeps what is there", async () => {
  const w = world();
  const { meeting } = await w.start();
  w.page().send(20);
  await sleep(1200);
  const { open } = fs.promises, probe = await open(path.join(temp, "probe"), "w");
  const prototype = Object.getPrototypeOf(probe), { write } = prototype;
  await probe.close();
  prototype.write = async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); };
  try {
    w.page().send(5);
    await sleep(1300);
  } finally {
    prototype.write = write;
  }
  await until(() => w.recorder.status().phase === "idle", "ended by itself");
  const saved = await w.read(meeting.id);
  assert.deepEqual([saved.state, saved.durationMs, saved.error], ["recorded", 2000, { code: "meetingsDiskFull" }]);
  assert.equal(w.events.filter(e => e.type === "ended").at(-1).reason, "failed");
  await w.settled();
});

test("a failed compression keeps the raw sound, which still transcribes", async () => {
  const w = world();
  w.codecFails = true;
  const { meeting } = await w.start();
  w.page().send(30);
  await w.recorder.stop();
  await w.settled();
  const failed = await w.read(meeting.id);
  assert.deepEqual([failed.error, failed.audio.mic], [{ code: "meetingsCompressionFailed" }, null]);
  const raw = await w.audio.openAudio(w.project, failed);
  assert.deepEqual(fs.readFileSync(raw.system).subarray(0, 4), Buffer.from(new Int16Array([-1, -2]).buffer));
  assert.equal(fs.statSync(raw.mic).size, 3 * RATE * 2);
  await raw.cleanup();
  assert.deepEqual((await w.recorder.recoverable()).map(r => [r.kind, r.durationMs, r.code]), [["compression", 3000, null]]);

  w.codecFails = false;
  const write = w.store.write;
  w.store.write = async (...args) => {
    const file = await write(...args);
    fs.appendFileSync(file, "x"); // not what was verified
    return file;
  };
  await rejects("meetingsCompressionFailed", w.audio.compress(w.project, meeting.id));
  assert.ok(fs.existsSync(files.pcmPath(w.dir(meeting))), "nothing is deleted that was not verified");
  w.store.write = write;
  const done = await w.audio.compress(w.project, meeting.id);
  assert.deepEqual([done.error, done.audio.mic], [null, "audio/mic.webm"]);
  await w.audio.compress(w.project, meeting.id); // again is harmless
});

test("the raw sound is not deleted while it is read", async () => {
  const w = world();
  const { meeting } = await w.start();
  for (let i = 0; i < 12; i++) w.page().send(50); // a minute
  const stopped = await w.recorder.stop();
  const opened = await w.audio.openAudio(w.project, stopped); // as the compression starts
  for (const channel of ["mic", "system"]) assert.equal(fs.statSync(opened[channel]).size, 60 * RATE * 2);
  await w.settled();
  await opened.cleanup();
  assert.equal(fs.existsSync(w.dir(meeting)), false);
});

test("deleting the audio or the meeting stops its compression", async () => {
  const w = world();
  w.codecWaits = true;
  const { meeting } = await w.start();
  w.page().send(30);
  await w.recorder.stop();
  await until(() => w.audio.active().length === 1, "compressing");
  await w.recorder.release(w.project, meeting.id);
  assert.deepEqual(w.audio.active(), []);
  assert.ok(fs.existsSync(w.dir(meeting)), "released is not deleted yet");
  const bare = await w.audio.removeAudio(w.project, meeting.id);
  assert.deepEqual(bare.audio, { mic: null, system: null });
  assert.equal(fs.existsSync(w.dir(meeting)), false, "no sound is left anywhere");
  const none = await w.audio.openAudio(w.project, bare);
  assert.deepEqual([none.mic, none.system], [null, null]);
});

test("quitting saves; the next start compresses", async () => {
  const w = world();
  const { meeting } = await w.start();
  w.page().send(20);
  await w.recorder.shutdown();
  const saved = await w.read(meeting.id);
  assert.deepEqual([saved.state, saved.durationMs, saved.error, saved.audio.mic], ["recorded", 2000, null, null]);
  assert.deepEqual([w.keys.held, w.awake], [0, 0]);
  await rejects("meetingsInterrupted", w.start());

  const next = w.open();
  assert.deepEqual((await next.recorder.recover()).map(r => r.kind), ["compression"]);
  await until(async () => (await w.read(meeting.id)).audio.mic, "compressed at the next start");
});

test("listing a project does not retry a failed compression, the start does", async () => {
  const w = world();
  w.codecFails = true;
  await w.start();
  w.page().send(10);
  await w.recorder.stop();
  await w.settled();
  const failures = () => w.events.filter(e => e.event === "compression" && e.type === "failed").length;
  await w.recorder.recover(w.project);
  await sleep(300);
  assert.equal(failures(), 1, "or a window that lists after each event would go round for ever");
  await w.recorder.recover();
  await w.settled();
  assert.equal(failures(), 2);
});

test("a cancelled compression does not wait for the one before it", async () => {
  const w = world();
  w.codecWaits = true;
  const meetingsMade = [];
  for (const title of ["First", "Second"]) {
    meetingsMade.push((await w.start({ title })).meeting);
    w.page().send(10);
    await w.recorder.stop();
  }
  await until(() => w.audio.active().length === 2, "both queued");
  await w.recorder.release(w.project, meetingsMade[1].id);
  assert.deepEqual(w.audio.active().map(j => j.id), [meetingsMade[0].id]);
  await w.audio.stop();
});

test("after a crash: recovered, once", async () => {
  const w = world();
  const half = await crashed(w, { title: "Half" });
  const closed = await crashed(w, { title: "Closed", stopped: true, startedAt: Date.now() + 1000 });
  const empty = await crashed(w, { title: "Empty", frames: 0, startedAt: Date.now() + 2000 });
  const listed = await w.recorder.recoverable();
  assert.equal(listed.length, 3);
  assert.ok(listed.every(r => r.code === null && r.project === w.project));
  assert.equal(listed.find(r => r.id === half.meeting.id).kind, "interrupted");

  await w.recorder.recover();
  await w.settled(2);
  const after = async one => {
    const m = await w.read(one.meeting.id);
    return [m.state, m.durationMs, m.error?.code ?? null];
  };
  assert.deepEqual(await after(half), ["recorded", 2000, "meetingsRecordingInterrupted"], "and compression keeps saying it");
  assert.deepEqual(await after(closed), ["recorded", 2000, null], "closed before the crash is not interrupted");
  assert.deepEqual(await after(empty), ["recorded", 0, "meetingsRecordingEmpty"]);
  assert.deepEqual(await w.recorder.recover(), [], "nothing is left");
});

test("a meeting whose work is gone does not stay 'recording'", async () => {
  const w = world();
  const noFolder = await crashed(w, { title: "No folder" });
  fs.rmSync(path.dirname(noFolder.dir), { recursive: true });
  const noSidecar = await crashed(w, { title: "No sidecar", startedAt: Date.now() + 1000 });
  fs.rmSync(path.join(noSidecar.dir, "recording.json"));
  await w.recorder.recover();
  assert.equal((await w.read(noFolder.meeting.id)).state, "recording", "the start cannot know of it");
  await w.recorder.recover(w.project);
  for (const { meeting } of [noFolder, noSidecar]) {
    const m = await w.read(meeting.id);
    assert.deepEqual([m.state, m.error.code, m.durationMs], ["recorded", "meetingsRecordingInterrupted", null]);
  }
});

test("a recording whose meeting is gone is kept until discarded", async () => {
  const w = world();
  const lost = await crashed(w);
  fs.rmSync(lost.meeting.dir, { recursive: true });
  const [left] = await w.recorder.recover();
  assert.equal(left.code, "meetingsNotFound");
  assert.ok(fs.existsSync(lost.dir));
  assert.equal(await w.recorder.discardRecoverable("../../x"), false);
  assert.equal(await w.recorder.discardRecoverable(left.key), true);
  assert.equal(fs.existsSync(lost.dir), false);
});

test("the pipeline recovers its own and leaves the recorder's", async () => {
  const w = world();
  const { meeting } = await w.start();
  const pipeline = createPipeline({ store: w.store, workDir: w.workDir, openAudio: w.audio.openAudio, getSettings: () => ({}), getApiKey: async () => "" });
  assert.deepEqual(await pipeline.recover(w.project), []);
  await rejects("meetingsStillRecording", pipeline.start(w.project, meeting.id));
  await w.recorder.discard();
});

// ---------- the small parts ----------
test("displays: numbered, matched without display_id, exact sizes", () => {
  const monitors = [{ sourceId: "screen:0:0", x: 3840, y: 494, width: 1920, height: 1200 }, { sourceId: "screen:1:0", x: 0, y: 0, width: 3840, height: 2160 }];
  const electron = [
    { id: 7, label: "", scaleFactor: 1.25, bounds: { x: 2560, y: 329, width: 1536, height: 961 } },
    { id: 9, label: "Main", scaleFactor: 1.5, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }
  ];
  const displays = matchDisplays(monitors, electron, m => (m.x ? electron[0] : electron[1]));
  assert.deepEqual(displays.map(d => [d.id, d.monitor, d.width, d.height]), [["9", 1, 3840, 2160], ["7", 2, 1920, 1200]]);
  const gdi = [{ id: "screen:0:0", display_id: "" }, { id: "screen:1:0", display_id: "" }];
  assert.equal(sourceOf(gdi, displays[0]).id, "screen:1:0");
  const directx = [{ id: "screen:0:0", display_id: "9" }, { id: "screen:1:0", display_id: "7" }];
  assert.equal(sourceOf(directx, displays[0]).id, "screen:0:0");
  assert.equal(isBlank(Buffer.alloc(64 * 40 * 4)), true);
  assert.equal(isBlank(picture({ width: 64, height: 40 })), false);
});

test("a screenshot's name is the store's", () => {
  const taken = new Set();
  for (const name of [screenName(872000, 1, taken), screenName(872500, 1, taken), screenName(5 * 3600e3, 12, taken), screenName(120 * 3600e3, 2, taken)]) {
    assert.ok(isScreen(name), name);
  }
  assert.equal(screenName(872000, 2, taken), "screens/00-14-32-m2.png");
});

test("a PNG keeps every pixel", async () => {
  const width = 7, height = 5, bgra = Buffer.alloc(width * height * 4);
  for (let i = 0; i < bgra.length; i++) bgra[i] = (i * 37) % 256;
  const png = await encodePng({ width, height, bgra });
  assert.equal(png.readUInt32BE(8 + 8), width);
  const rows = zlib.inflateSync(png.subarray(8 + 25 + 8, png.length - 12 - 4)), stride = width * 3 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) {
      if (rows[y * stride] === 2) rows[y * stride + 1 + x] += rows[(y - 1) * stride + 1 + x];
      const pixel = (y * width + Math.floor(x / 3)) * 4;
      assert.equal(rows[y * stride + 1 + x], bgra[pixel + 2 - (x % 3)]);
    }
  }
});

test("the key: never a bare one, never quietly over another's", () => {
  let destroyed = 0, taken = false, released = 0;
  const native = {
    parseAccelerator: a => ({ "Control+Shift+F9": { mods: 6, vk: 0x78 }, "Shift+A": { mods: 4, vk: 0x41 }, F9: { mods: 0, vk: 0x78 }, A: { mods: 0, vk: 0x41 } })[a] || null,
    createHotkeys: () => ({ register: () => !taken, unregisterAll: () => { released++; } })
  };
  class BrowserWindow {
    isDestroyed() { return false; }
    destroy() { destroyed++; }
  }
  const register = key => registerShortcut(key, () => {}, { native, BrowserWindow });
  for (const bad of ["nonsense", "Shift+A", "A"]) assert.equal(register(bad).code, "meetingsShortcutInvalid", bad);
  register("F9").close();
  register(DEFAULT_SHORTCUT).close();
  assert.deepEqual([destroyed, released], [2, 2]);
  taken = true;
  assert.equal(register(DEFAULT_SHORTCUT).code, "meetingsShortcutTaken");
  assert.equal(destroyed, 3);
  native.createHotkeys = () => { throw new Error("no hotkeys here"); };
  assert.throws(() => register(DEFAULT_SHORTCUT), /no hotkeys here/);
  assert.equal(destroyed, 4, "the hidden window does not stay");
});

test("the capture session gives only sound, only to its pages", () => {
  const Module = require("node:module"), load = Module._load;
  const hooks = {}, session = {};
  for (const name of ["setPermissionRequestHandler", "setPermissionCheckHandler", "setDisplayMediaRequestHandler"]) session[name] = fn => { hooks[name] = fn; };
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false, once() {} };
  Module._load = function (request, parent, isMain) {
    if (request === "./hidden-page" && parent?.filename.endsWith("capture-page.js")) return { openPage: options => options.configure(session, contents) };
    return load.call(this, request, parent, isMain);
  };
  try {
    meetings("capture/capture-page").openCapturePage({});
  } finally {
    Module._load = load;
  }
  const asks = (wc, permission, mediaTypes) => {
    let answer;
    hooks.setPermissionRequestHandler(wc, permission, v => { answer = v; }, { mediaTypes });
    return answer;
  };
  assert.equal(asks(contents, "media", []), true, "getDisplayMedia's");
  assert.equal(asks(contents, "media", ["audio"]), true, "the microphone's");
  assert.equal(asks(contents, "media", ["audio", "video"]), false, "no camera");
  assert.equal(asks({}, "media", ["audio"]), false, "no other page");
  assert.equal(asks(contents, "notifications", []), false);
  assert.equal(hooks.setPermissionCheckHandler(contents, "media", "", { mediaType: "video" }), false);
  const shows = request => {
    let answer;
    hooks.setDisplayMediaRequestHandler({ frame, audioRequested: true, videoRequested: false, ...request }, v => { answer = v; });
    return answer;
  };
  assert.deepEqual(shows({}), { audio: "loopback" });
  assert.equal(shows({ videoRequested: true }), null, "no screen is captured");
  assert.equal(shows({ frame: {} }), null);
});

test("the switch keeps what is already switched off", () => {
  let value = "SomeFeature,Other";
  const app = { commandLine: { getSwitchValue: () => value, appendSwitch: (_name, v) => { value = v; } } };
  excludeOwnPlayback(app);
  excludeOwnPlayback(app);
  assert.equal(value, process.platform === "win32" ? "SomeFeature,Other,RestrictOwnAudioAddChromiumBack" : "SomeFeature,Other");
});

test("every code has its texts in both languages", () => {
  const dir = path.join(SRC, "meetings");
  const own = ["recorder.js", "audio.js", ...fs.readdirSync(path.join(dir, "capture")).filter(f => f.endsWith(".js")).map(f => `capture/${f}`)];
  const text = own.map(f => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const codes = new Set([...text.matchAll(/"(meetings[A-Z]\w+)"/g)].map(m => m[1]).filter(code => code !== "meetingsPage")); // the preload's bridge
  const i18n = fs.readFileSync(path.join(SRC, "i18n.js"), "utf8");
  for (const code of codes) {
    assert.ok(code in MESSAGES, code);
    assert.equal(i18n.split(`"errors.${code}":`).length, 3, `${code} in EN and BG`);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      const note = await fn();
      console.log(`ok   ${name}${note ? ` (${note})` : ""}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n${error.stack}`);
    }
  }
  console.log(`meetings recorder: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})().finally(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
