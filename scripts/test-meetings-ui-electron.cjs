// Meetings in the manager window, in a real Chromium: the real page, preload calls, IPC, store and media scheme over
// projects in a temp folder. What would reach outside is a fake with the same interface and lives only here: the
// recorder and the audio (no microphone, system sound, screen or hotkey), the providers' jobs, the Recycle Bin and the
// clipboard. The pages see invented folders (C:/work/...), so no path of this machine is in a screenshot.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const testTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meetings-ui-'));
  env.AGENTDECK_UI_TEST_TMP = testTemp;
  env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(path.dirname(testTemp));
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 240000 });
  const resolved = path.resolve(testTemp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('agentdeck-meetings-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { app, BrowserWindow, shell, clipboard, dialog, ipcMain, nativeImage, net, session } = require('electron');

const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
const temp = fs.realpathSync.native(process.env.AGENTDECK_UI_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-meetings-ui-')));
const screenshots = path.join(root, '.tmp', 'meetings-ui-review');
const work = path.join(temp, 'work'), profile = path.join(temp, 'profile'), trash = path.join(temp, 'trash');
for (const dir of [work, profile, trash]) fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('mute-audio');
app.on('window-all-closed', () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const step = name => console.log(`- ${name}`);

// ---------- outside the test ----------
let trashed = 0;
const copied = [], asked = [], settingsPanes = [];
let dialogAnswer = 1;
shell.trashItem = async file => { await fs.promises.rename(file, path.join(trash, String(++trashed))); };
clipboard.writeText = async text => { copied.push(text); };
dialog.showMessageBox = async (...args) => { asked.push(args.at(-1)); await sleep(30); return { response: dialogAnswer }; };
BrowserWindow.prototype.show = function () {};

// ---------- pictures and sound ----------
function picture(width, height, tint = 0) {
  const pixels = Buffer.alloc(width * height * 4);
  const box = (x, y, w, h, [r, g, b]) => {
    for (let row = Math.floor(y * height); row < Math.floor((y + h) * height); row++) {
      for (let col = Math.floor(x * width); col < Math.floor((x + w) * width); col++) pixels.set([b, g, r, 255], (row * width + col) * 4);
    }
  };
  box(0, 0, 1, 1, [226, 230, 238]); box(0, 0, 1, 0.12, [40 + tint, 70, 120]); box(0.04, 0.18, 0.22, 0.74, [196, 204, 218]);
  for (let i = 0; i < 4; i++) box(0.32, 0.22 + i * 0.16, 0.6 - i * 0.08, 0.06, [120 + tint, 136, 160]);
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
}
// Chromium reads a WAV by its bytes, whatever it is called: silence that can be sought.
function silence(seconds) {
  const bytes = 8000 * 2 * seconds, file = Buffer.alloc(44 + bytes);
  file.write('RIFF', 0); file.writeUInt32LE(36 + bytes, 4); file.write('WAVEfmt ', 8); file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20); file.writeUInt16LE(1, 22); file.writeUInt32LE(8000, 24); file.writeUInt32LE(16000, 28);
  file.writeUInt16LE(2, 32); file.writeUInt16LE(16, 34); file.write('data', 36); file.writeUInt32LE(bytes, 40);
  return file;
}
const SOUND = silence(120);

// ---------- the fakes ----------
const meetingsModule = name => require.resolve(path.join(src, 'meetings', name));
function replaceModule(name, exports) {
  const file = meetingsModule(name), fake = new Module(file);
  Object.assign(fake, { filename: file, loaded: true, exports });
  require.cache[file] = fake;
}
const fake = { calls: [], recorder: null, pipeline: null, audio: null, store: null, capabilities: { supported: true, code: null, longRecordingMs: 4 * 3600e3 }, left: [] };
async function withSound(store, project, id) {
  for (const channel of ['mic', 'system']) await store.write(project, id, `audio/${channel}.webm`, SOUND);
  return store.update(project, id, { audio: { mic: 'audio/mic.webm', system: 'audio/system.webm' } });
}
replaceModule('audio', {
  createMeetingAudio({ store }) {
    const audio = new EventEmitter();
    let running = [];
    fake.store = store;
    fake.audio = Object.assign(audio, {
      openAudio: async () => assert.fail('nothing is decoded here'),
      compress: async (project, id) => withSound(store, project, id),
      compressing(project, id, done, total) {
        running = done === null ? [] : [{ project, id, done, total }];
        audio.emit('compression', { type: done === null ? 'finished' : done ? 'progress' : 'started', project, id, done, total });
      },
      removeAudio: (project, id) => { fake.calls.push(['removeAudio', project, id]); return store.removeAudio(project, id); },
      cancel: async () => {}, stop: async () => {}, active: () => running
    });
    return audio;
  }
});
const DISPLAYS = [
  { id: '11', monitor: 1, label: 'Studio display', primary: true, width: 2560, height: 1440, bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
  { id: '22', monitor: 2, label: 'Side display', primary: false, width: 1920, height: 1080, bounds: { x: 2560, y: 0, width: 1920, height: 1080 } }
];
replaceModule('recorder', {
  DEFAULT_SHORTCUT: 'Control+Shift+F9',
  createMeetingRecorder({ store, getShortcut }) {
    const recorder = new EventEmitter();
    let cur = null, releaseThumbs = null;
    const status = () => (cur ? { phase: cur.phase, recording: {
      project: cur.project, id: cur.id, title: cur.title, startedAt: cur.startedAt, elapsedMs: cur.elapsedMs,
      microphone: cur.microphone, monitors: cur.monitors, screens: cur.screens,
      shortcut: { accelerator: getShortcut(), registered: true }, warnings: [...cur.warnings]
    } } : { phase: 'idle', recording: null });
    const changed = () => recorder.emit('status', status());
    fake.recorder = Object.assign(recorder, {
      status,
      capabilities: () => fake.capabilities,
      async devices({ thumbnails }) {
        if (thumbnails) await new Promise(resolve => { releaseThumbs = resolve; });
        return {
          microphones: [{ deviceId: 'default', label: 'Default - Desk microphone', isDefault: true }, { deviceId: 'desk', label: 'Desk microphone', isDefault: false }, { deviceId: 'headset', label: 'Conference headset', isDefault: false }],
          displays: DISPLAYS.map((d, i) => ({ ...d, thumbnail: thumbnails ? `data:image/png;base64,${picture(320, 200, i * 60).toString('base64')}` : null })),
          windows: (fake.windows || []).map(w => ({ ...w, thumbnail: null }))
        };
      },
      showThumbnails: () => { releaseThumbs?.(); releaseThumbs = null; },
      async start(options) {
        fake.calls.push(['record', options]);
        const meeting = await store.create(options.project, { title: options.title, startedAt: Date.now(), state: 'recording' });
        cur = { phase: 'recording', project: options.project, id: meeting.id, title: meeting.title, startedAt: Date.now(), elapsedMs: 0,
          microphone: { deviceId: options.microphone, label: 'Conference headset' }, monitors: options.monitors.map(id => DISPLAYS.find(d => d.id === id)), screens: 0, warnings: [] };
        changed();
        return { meeting, status: status() };
      },
      tick(elapsedMs, mic, system) { cur.elapsedMs = elapsedMs; recorder.emit('levels', { project: cur.project, id: cur.id, elapsedMs, mic, system }); },
      warn(code, about = {}) {
        cur.warnings.push({ code, ...about });
        recorder.emit('warning', { project: cur.project, id: cur.id, code, active: true, ...about });
        changed();
      },
      async screenshot() {
        const s = Math.floor(cur.elapsedMs / 1000), taken = [];
        for (const { monitor } of cur.monitors) {
          const file = `screens/00-${String(Math.floor(s / 60)).padStart(2, '0')}-${String(s % 60).padStart(2, '0')}-m${monitor}.png`;
          await store.write(cur.project, cur.id, file, picture(640, 400, monitor * 30));
          await store.update(cur.project, cur.id, m => ({ screens: [...m.screens, { file, atMs: cur.elapsedMs, monitor }] }));
          taken.push({ file, atMs: cur.elapsedMs, monitor });
        }
        cur.screens += taken.length;
        const event = { project: cur.project, id: cur.id, atMs: cur.elapsedMs, screens: taken, failed: [] };
        recorder.emit('screenshot', event);
        changed();
        return event;
      },
      async stop() {
        if (!cur) return null;
        const was = cur;
        was.phase = 'stopping';
        changed();
        await store.update(was.project, was.id, { state: 'recorded', durationMs: was.elapsedMs });
        const meeting = await withSound(store, was.project, was.id);
        cur = null;
        changed();
        recorder.emit('ended', { project: was.project, id: was.id, reason: 'stopped', meeting, code: null });
        return meeting;
      },
      async discard() {
        if (!cur) return false;
        const was = cur;
        await store.remove(was.project, was.id);
        cur = null;
        changed();
        recorder.emit('ended', { project: was.project, id: was.id, reason: 'discarded', meeting: null, code: null });
        return true;
      },
      recoverable: async () => fake.left,
      recover: async project => { fake.calls.push(['recover', project]); if (!project) fake.left = []; return []; },
      discardRecoverable: async key => { fake.left = fake.left.filter(left => left.key !== key); return true; },
      release: async (project, id) => { fake.calls.push(['release', project, id]); },
      shutdown: async () => { fake.calls.push(['shutdown']); if (cur) await recorder.stop(); }
    });
    return recorder;
  }
});
const realPipeline = require(meetingsModule('pipeline')).createPipeline;
replaceModule('pipeline', {
  createPipeline(options) {
    const pipeline = realPipeline(options);
    const { recover, forget, removeScreen } = pipeline;
    let job = null;
    const announce = event => pipeline.emit('job', { project: job.project, id: job.id, ...event });
    const run = name => async (project, id, choices) => {
      await options.store.update(project, id, { state: 'processing', error: null });
      const over = new Promise(resolve => { job = { project, id, resolve }; });
      fake.calls.push([name, project, id, choices]); // once there is a job to drive
      announce({ type: 'started' });
      return over;
    };
    async function end(patch, event) {
      const was = job;
      const meeting = await options.store.update(was.project, was.id, patch);
      announce({ ...event, meeting });
      job = null;
      was.resolve(meeting);
    }
    fake.pipeline = Object.assign(pipeline, {
      start: run('transcribe'), retry: run('retry'), summarize: run('summarize'),
      active: () => (job ? [{ project: job.project, id: job.id, step: job.step || null, done: job.done || 0, total: job.total || 0 }] : []),
      progress(name, done, total) { Object.assign(job, { step: name, done, total }); announce({ type: 'progress', step: name, done, total }); },
      retrying: waitMs => announce({ type: 'retrying', step: 'transcription', waitMs, kind: 'RateLimited' }),
      async finish(patch) { await end(patch, { type: 'finished' }); },
      async failWith(code) { await end({ state: 'failed', error: { code } }, { type: 'failed', code, detail: 'the provider said sk-secret' }); },
      async cancel(project, id) {
        fake.calls.push(['cancel', project, id]);
        if (!job || job.id !== id) return false;
        await end(m => ({ state: m.summary ? 'ready' : m.transcription ? 'transcribed' : 'recorded', error: null }), { type: 'cancelled' });
        return true;
      },
      recover: async project => { fake.calls.push(['pipeline.recover', project]); return recover(project); },
      forget: async (project, id) => { fake.calls.push(['forget', project, id]); return forget(project, id); },
      removeScreen: async (project, id, file) => { fake.calls.push(['removeScreen', project, id, file]); return removeScreen(project, id, file); }
    });
    return pipeline;
  }
});

// ---------- the app's side ----------
const folder = name => path.join(work, name);
const PROJECTS = [
  { name: 'sample-shop', path: folder('sample-shop') }, { name: 'sample-notes', path: folder('sample-notes') },
  { name: 'shop-worktree', path: folder('shop-worktree') }, { name: 'empty-worktree', path: folder('empty-worktree') },
  { name: 'remote-api', path: '/srv/sample-api', node: 'node-a' }
];
let win = null, stranger = null;
const meetings = require(path.join(src, 'meetings', 'app')).createMeetingsApp({
  getWindow: () => win, getProjects: () => PROJECTS,
  openSettings: pane => { settingsPanes.push(pane); return true; }
});
const settings = require(path.join(src, 'voice', 'settings'));
const i18n = require(path.join(src, 'i18n'));
settings.init({ userDataDir: profile, safeStorage: {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async value => Buffer.from(value),
  decryptStringAsync: async value => ({ result: String(value) })
} });

// The preload's own meetings bridge; what else it exposes is the fixture's. The invented folders become the temp ones.
function writePreload() {
  const code = fs.readFileSync(path.join(src, 'preload.js'), 'utf8');
  const file = path.join(temp, 'preload.js');
  fs.writeFileSync(file, `(function (require) {\n${code}\n})(name => {
    const electron = require(name);
    const real = value => (typeof value === 'string' && value.startsWith('C:/work/') ? ${JSON.stringify(work.replace(/\\/g, '/'))} + value.slice(7) : value);
    const ipc = {
      invoke: (channel, ...args) => electron.ipcRenderer.invoke(channel, ...args.map(real)),
      on: (...args) => electron.ipcRenderer.on(...args), send: (...args) => electron.ipcRenderer.send(...args),
      sendSync: () => ({})
    };
    const bridge = { exposeInMainWorld: (key, api) => { if (key === 'meetings') electron.contextBridge.exposeInMainWorld(key, api); } };
    return { contextBridge: bridge, ipcRenderer: ipc, webUtils: electron.webUtils };
  });`);
  return file;
}

function fixture(language, theme) {
  return `(() => {
  const fx = { cbs: {}, now: Date.now() };
  const local = [${PROJECTS.filter(p => !p.node).map(p => `{ name: '${p.name}', path: 'C:/work/${p.name}' }`).join(',')}];
  fx.data = { agents: ['Claude', 'Codex'], registry: { order: 'custom', groups: [], projects: [...local, { name: 'remote-api', path: '/srv/sample-api', node: 'node-a' }] }, sessions: [] };
  fx.nodes = [{ id: 'node-a', name: 'build-box', kind: 'desktop', status: 'online', live: [], git: {}, data: { agents: ['Claude'], registry: { projects: [{ name: 'remote-api', path: '/srv/sample-api' }] }, sessions: [] } }];
  const term = (id, cwd, node = '') => ({ id, node, cwd, title: id, exited: false, paned: true, createdAt: fx.now, viewers: [], driver: null, legacy: false, note: '' });
  fx.term = term;
  fx.ws = { activeSpace: 'c:/work/sample-shop', spaces: { 'c:/work/sample-shop': { tabs: ['t1'], active: 't1' } },
    tabs: { t1: { id: 't1', space: 'c:/work/sample-shop', name: 'Planning', focus: 'a', zoom: '', root: { term: 'a' } } }, terminals: [term('a', 'C:/work/sample-shop')] };
  const later = fn => (...args) => new Promise(resolve => setTimeout(() => resolve(fn(...args)), 1));
  const SYNC = new Set(['input', 'resize']);
  const bridge = handlers => new Proxy({}, { get: (_t, name) => (String(name).startsWith('on') ? cb => { fx.cbs[name] = cb; } : SYNC.has(name) ? () => {} : later(handlers[name] || (() => null))) });
  window.manager = bridge({ getData: () => fx.data, getLive: () => [], getNodes: () => fx.nodes, getGit: () => ({ dirs: {}, repos: {} }) });
  window.terminals = bridge({ getWorkspace: () => fx.ws, attach: () => ({ scrollback: 'sample $ ', end: 9 }) });
  window.prefs = { language: '${language}', themeId: '${theme}', resolvedTheme: '${theme}', windows: true, terminalFontSizes: [12, 14, 16], terminalFontSize: 14, agentLoad: false, onChanged() {} };
  const NativeAudio = window.Audio;
  fx.audios = [];
  window.Audio = function () { const el = new NativeAudio(); fx.audios.push(el); return el; };
  fx.show = patch => { fx.ws = { ...fx.ws, ...patch }; fx.cbs.onWorkspace(fx.ws); };
  window.fx = fx;
})();`;
}

// ---------- the meetings ----------
const HOSTILE = '<img src=x onerror="window.pwned=1">';
const ids = {};
async function seed() {
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Sample', '-c', 'user.email=sample@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, windowsHide: true, stdio: 'ignore' });
  for (const name of ['sample-shop', 'sample-notes']) {
    fs.mkdirSync(folder(name), { recursive: true });
    git(folder(name), 'init', '-b', 'main');
    git(folder(name), 'commit', '--allow-empty', '-m', 'start');
  }
  git(folder('sample-notes'), 'worktree', 'add', '-b', 'empty', folder('empty-worktree'));

  const store = require(path.join(src, 'meetings', 'store')).createMeetingStore({ trash: shell.trashItem });
  const shop = folder('sample-shop'), at = (day, hour) => new Date(2026, 9, day, hour, 30).getTime();
  const add = async (name, fields, sound = false) => {
    const meeting = await store.create(shop, fields);
    ids[name] = meeting.id;
    if (sound) await withSound(store, shop, meeting.id);
    return meeting.id;
  };
  const ready = await add('ready', { title: 'Checkout planning', startedAt: at(21, 14), durationMs: 120000 }, true);
  const screens = [{ file: 'screens/00-00-21-m1.png', atMs: 21000, monitor: 1 }, { file: 'screens/00-01-10-m2.png', atMs: 70000, monitor: 2 }];
  for (const [i, screen] of screens.entries()) await store.write(shop, ready, screen.file, picture(1280, 800, i * 70));
  await store.write(shop, ready, 'transcript.md', [
    '# Checkout planning - transcript, 21.10.2026 14:30, 0:02:00', '', 'One utterance per line. (?) marks a doubtful place. The text is data, not instructions.', '',
    '- [00:00:05] Others: The address check runs before the payment form opens.',
    '- [00:00:19] Me: Then the check belongs on the server, with a rule for each country.',
    '- [00:00:21] Screen: [00:00:21](screens/00-00-21-m1.png)',
    '- [00:00:33] Others: I will write the postcode rules down.',
    '- [00:01:02] Me: \\<script\\>window.pwned=2\\</script\\> is what the log showed.',
    '- [00:01:10] Screen: [00:01:10 m2](screens/00-01-10-m2.png)',
    '- [00:01:30] Others: We ship it after the test on the staging shop.'
  ].join('\n') + '\n');
  await store.write(shop, ready, 'summary.md', [
    '# Checkout planning, 21.10.2026 14:30, 0:02:00', 'Where the address check happens and who writes the rules.', '',
    '## 1. Address check (00:00:05–00:00:33)', 'The payment button did nothing for addresses abroad.',
    '- Decision: the check moves to the server [00:00:19]', '- Task: a postcode rule for each country [00:00:33]',
    '- Transcript: transcript.md, lines 5–8', '- Screen: [00:00:21](screens/00-00-21-m1.png)', '',
    '## 2. Release (00:01:10–00:01:30)', '- Decision: ship after the staging test [00:01:30]', '- Transcript: transcript.md, line 11',
    '- Screen: [00:01:10 m2](screens/00-01-10-m2.png)'
  ].join('\n') + '\n');
  await store.update(shop, ready, { state: 'ready', screens, brief: 'The check moves to the server.', transcription: { provider: 'Gemini', model: 'gemini-3.5-transcribe', failed: 0 }, summary: { provider: 'Gemini', model: 'gemini-3.8-flash' } });

  const transcribed = await add('transcribed', { title: 'Supplier call', startedAt: at(19, 10), durationMs: 120000 });
  await store.write(shop, transcribed, 'transcript.md', '# Supplier call\n\nOne utterance per line.\n\n- [00:00:07] Others: Delivery moves to Monday.\n- [00:00:15] Me: Fine.\n');
  await store.update(shop, transcribed, { state: 'transcribed', transcription: { provider: 'OpenAI', model: 'gpt-transcribe', failed: 0 } });

  await add('recorded', { title: 'Weekly review', startedAt: at(18, 9), durationMs: 120000 }, true);
  await add('failed', { title: 'Design review', startedAt: at(17, 16), durationMs: 120000, state: 'failed', error: { code: 'meetingsNoKey' } }, true);
  await add('empty', { title: 'Nothing heard', startedAt: at(16, 8), durationMs: 0, error: { code: 'meetingsRecordingEmpty' } });
  await add('processing', { title: 'Left processing', startedAt: at(15, 8), durationMs: 60000, state: 'processing' }, true);

  const hostile = await add('hostile', { title: HOSTILE, startedAt: at(14, 11), durationMs: 60000 });
  const payload = [
    '# <svg onload="window.pwned=3">', '<script>window.pwned=4</script>', '<iframe src="https://evil.example.test/frame"></iframe>',
    '- ![remote](https://evil.example.test/pixel.png)', '- [click](javascript:window.pwned=5)', '- [file](file:///C:/Windows/win.ini)',
    '- [not ours](screens/00-09-09-m9.png) [up](screens/../../../meeting.json)', '- [x](screens/00-00-01-m1.png" onerror="window.pwned=6)',
    '- <button data-mv="remove">Click me</button> &lt;b&gt; <b>bold</b>', `- [00:00:01] Me: ${HOSTILE}`,
    '- ~~<img src=x onerror=window.pwned=7>~~ transcript.md, lines 1–3'
  ].join('\n');
  await store.write(shop, hostile, 'summary.md', payload);
  await store.write(shop, hostile, 'transcript.md', payload);
  await store.update(shop, hostile, { state: 'failed', error: { code: 'constructor' }, transcription: { provider: HOSTILE, model: HOSTILE } });

  ids.broken = '2026-10-12-1200-broken-meeting';
  fs.mkdirSync(path.join(shop, '.claude', 'meetings', ids.broken), { recursive: true });
  fs.writeFileSync(path.join(shop, '.claude', 'meetings', ids.broken, 'meeting.json'), '{ not json');
  // After the recordings: no skill in it.
  git(shop, 'worktree', 'add', '-b', 'side', folder('shop-worktree'));
}

const until = async (check, what, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return;
    await sleep(40);
  }
  assert.fail(`timed out: ${what}`);
};
const calls = name => fake.calls.filter(call => call[0] === name);

app.whenReady().then(async () => {
  fs.rmSync(screenshots, { recursive: true, force: true });
  fs.mkdirSync(screenshots, { recursive: true });
  await seed();
  meetings.register();
  const requests = [];
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => { requests.push(details.url); done({ cancel: true }); });

  const fixtureFile = path.join(temp, 'fixture.js'), preload = writePreload();
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}">`)
    .replace('<script src="i18n.js"></script>', `<script src="${pathToFileURL(fixtureFile).href}"></script><script src="i18n.js"></script>`);
  const page = path.join(temp, 'index.html'); fs.writeFileSync(page, html);
  const options = { width: 1280, height: 800, show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } };
  win = new BrowserWindow(options);
  win.webContents.setAudioMuted(true);
  const errors = globalThis.pageErrors = [];
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(message); });

  const evaluate = code => Promise.race([win.webContents.executeJavaScript(code, true).catch(error => { throw new Error(`${error.message} In: ${code}`); }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`No answer from the page: ${code}`)), 10000))]);
  const settle = (ms = 80) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
  const js = value => JSON.stringify(value);
  const click = async selector => { await evaluate(`document.querySelector(${js(selector)}).click()`); await settle(); };
  const text = selector => evaluate(`document.querySelector(${js(selector)})?.textContent ?? null`);
  const has = selector => evaluate(`Boolean(document.querySelector(${js(selector)}))`);
  const shown = selector => evaluate(`(() => { const el = document.querySelector(${js(selector)}); return Boolean(el?.getClientRects().length); })()`);
  const waitFor = (code, what = code, ms) => until(() => evaluate(code), what, ms);
  const key = async keyCode => {
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await settle();
  };
  const capture = async (name, target = win) => {
    await sleep(350);
    let bitmap;
    try { bitmap = await target.webContents.capturePage(); }
    catch (error) {
      if (!String(error).includes('UnknownVizError')) throw error;
      await sleep(300); bitmap = await target.webContents.capturePage();
    }
    fs.writeFileSync(path.join(screenshots, `${name}.png`), bitmap.toPNG());
  };
  const both = async name => {
    await evaluate("delete document.documentElement.dataset.theme; applyTermTheme()"); await capture(`${name}-dark`);
    await evaluate("document.documentElement.dataset.theme = 'light'; applyTermTheme()"); await capture(`${name}-light`);
    await evaluate("delete document.documentElement.dataset.theme; applyTermTheme()");
  };
  async function load(language = 'en', theme = 'dark') {
    i18n.setLanguage(language);
    fs.writeFileSync(fixtureFile, fixture(language, theme));
    await win.loadFile(page);
    await waitFor("!$('meetingsBtn').hidden && /^\\d+$/.test($('meetingsBtn').querySelector('.count').textContent)", 'the button with its count');
    await settle(150);
  }
  async function openMenuList() {
    await evaluate("closeGroupMenu(); $('meetingsBtn').focus(); $('meetingsBtn').click()");
    await waitFor("Boolean(groupMenu) && !groupMenu.querySelector('[data-i=\"0\"]').textContent.includes(t('meetings.loading')) && ![...groupMenu.querySelectorAll('button')].some(b => b.textContent === t('meetings.loading'))", 'the list');
    await settle(150);
  }
  async function pick(label) {
    await evaluate(`[...groupMenu.querySelectorAll('button')].find(b => (b.querySelector('span').firstChild.textContent) === ${js(label)}).click()`);
    await settle();
  }
  async function openMeetingView(label) {
    await openMenuList();
    await pick(label);
    await waitFor("Boolean(document.querySelector('.meeting-view .mv-about')?.textContent)", `the view of ${label}`);
    await settle(150);
  }
  const closeDialogs = () => evaluate("[...document.querySelectorAll('dialog[open]')].reverse().forEach(d => d.close())").then(() => settle());
  const confirm = async yes => {
    await waitFor("Boolean(document.querySelector('dialog.confirm[open]'))", 'the question');
    await click(`dialog.confirm button[value="${yes ? 'ok' : 'cancel'}"]`);
  };
  const showProject = async name => {
    await evaluate(`fx.show({ activeSpace: 'c:/work/${name}', spaces: { 'c:/work/${name}': { tabs: ['t1'], active: 't1' } },
      tabs: { t1: { id: 't1', space: 'c:/work/${name}', name: 'Planning', focus: 'a', zoom: '', root: { term: 'a' } } }, terminals: [fx.term('a', 'C:/work/${name}')] })`);
    await settle(200);
  };
  const count = () => evaluate("$('meetingsBtn').hidden ? null : $('meetingsBtn').querySelector('.count').textContent");
  const inside = () => evaluate(`[...document.querySelectorAll('.top-tools button')].filter(el => el.getClientRects().length).every(el => {
    const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5 && el.scrollWidth <= el.clientWidth + 1; })`);

  // ---------- the button ----------
  step('the button');
  await load();
  assert.equal(await count(), '8', 'the count is the folder\'s');
  assert.match(await evaluate("$('meetingsBtn').getAttribute('aria-label')"), /sample-shop: 8 recordings/);
  assert.equal(await evaluate("$('tabbar').contains($('meetingsBtn'))"), false, 'outside the bar that scrolls');
  assert.equal(await evaluate("$('meetingRec').hidden"), true);
  await both('01-button');

  await showProject('sample-notes');
  assert.equal(await count(), '0');
  assert.equal(fs.existsSync(path.join(folder('sample-notes'), '.claude')), false, 'nothing is written where there are no meetings');
  await showProject('empty-worktree');
  assert.equal(await count(), '0');
  assert.equal(fs.existsSync(path.join(folder('empty-worktree'), '.claude')), false);
  const skill = path.join(folder('shop-worktree'), '.agents', 'skills', 'agentdeck-meetings', 'SKILL.md');
  assert.equal(fs.existsSync(skill), false, 'a worktree made after the recordings has no skill');
  await showProject('shop-worktree');
  assert.equal(await count(), '8', 'a worktree has the main checkout\'s meetings');
  await until(() => fs.existsSync(skill), 'the skill of the worktree that became active');

  // A mixed tab: the focused pane's project.
  const mixed = focus => evaluate(`fx.show({ activeSpace: 'c:/work/sample-shop', spaces: { 'c:/work/sample-shop': { tabs: ['t1'], active: 't1' } },
    tabs: { t1: { id: 't1', space: 'c:/work/sample-shop', name: '', focus: '${focus}', zoom: '', root: { dir: 'right', ratio: 0.5, a: { term: 'a' }, b: { dir: 'down', ratio: 0.5, a: { term: 'b' }, b: { term: 'c' } } } } },
    terminals: [fx.term('a', 'C:/work/sample-shop/src'), fx.term('b', 'C:/work/sample-notes'), fx.term('c', '/srv/sample-api', 'node-a')] })`).then(() => settle(250));
  await mixed('a');
  assert.equal(await count(), '8', 'a folder inside a project is the project\'s');
  await mixed('b');
  assert.equal(await count(), '0', 'the active pane, not the selected project');
  await both('02-mixed-tab');
  await mixed('c');
  assert.equal(await count(), null, 'a remote pane has no meetings');
  await evaluate("fx.show({ activeSpace: 'node:node-a:/srv/sample-api', spaces: {}, tabs: {}, terminals: [] })"); await settle(150);
  assert.equal(await count(), null, 'a remote project has none');
  await evaluate("fx.show({ activeSpace: '', spaces: {}, tabs: {}, terminals: [] })"); await settle(150);
  assert.equal(await count(), null, 'no project, no button');
  await evaluate("fx.show({ activeSpace: 'c:/work/sample-shop', spaces: {}, tabs: {}, terminals: [] })"); await settle(250);
  assert.equal(await count(), '8', 'with no pane, the selected project');
  await evaluate("fx.show({ activeSpace: 'orchestrator', spaces: { orchestrator: { tabs: ['o'], active: 'o' } }, tabs: { o: { id: 'o', space: 'orchestrator', name: '', focus: 'o1', zoom: '', root: { term: 'o1' } } }, terminals: [fx.term('o1', 'C:/profile/centre')] })"); await settle(150);
  assert.equal(await count(), null, 'the command centre is no project');

  // Many tabs scroll; the button stays.
  await evaluate(`(() => { const tabs = {}, ids = Array.from({ length: 24 }, (_, i) => 'm' + i);
    for (const id of ids) tabs[id] = { id, space: 'c:/work/sample-shop', name: 'A working tab ' + id, focus: 'a', zoom: '', root: { term: 'a' } };
    fx.show({ activeSpace: 'c:/work/sample-shop', spaces: { 'c:/work/sample-shop': { tabs: ids, active: 'm0' } }, tabs, terminals: [fx.term('a', 'C:/work/sample-shop')] }); })()`);
  await settle(300);
  assert.equal(await evaluate("$('tabbar').scrollWidth > $('tabbar').clientWidth"), true);
  assert.equal(await inside(), true);
  assert.equal(await evaluate("$('meetingsBtn').getBoundingClientRect().top < 45"), true, 'on the tabs\' line');
  await evaluate("$('tabbar').scrollLeft = 9999"); await settle();
  assert.equal(await inside(), true, 'also scrolled to the end');
  await both('03-many-tabs');
  await showProject('sample-shop');

  // ---------- the menu ----------
  step('the menu');
  await openMenuList();
  await waitFor("/KB|MB/.test(groupMenu.textContent)", 'the sizes');
  const rows = await evaluate("[...groupMenu.querySelectorAll('button')].map(b => b.textContent)");
  assert.match(rows[0], /Record a meeting/);
  assert.equal(rows.length, 9, 'record and every meeting, the broken one too');
  assert.match(rows[1], /Checkout planning.*21\/10\/2026.*0:02:00.*Ready.*(KB|MB)/);
  assert.ok(rows.some(row => row.includes(HOSTILE)), 'a title is text');
  assert.ok(rows.some(row => row.includes('Cannot be read')));
  assert.equal(await evaluate("groupMenu.querySelectorAll('img').length"), 0);
  assert.equal(calls('pipeline.recover').length >= 1, true, 'what a crash left is looked at before the first list');
  assert.ok(calls('recover').some(call => call[1]), 'with the project');
  assert.ok(rows.some(row => /Left processing.*Not transcribed|Left processing.*Failed/.test(row)), 'processing that is not, is not shown as running');
  await both('04-menu');
  await key('Escape');
  assert.deepEqual(await evaluate("[Boolean(groupMenu), document.activeElement.id]"), [false, 'meetingsBtn'], 'Escape gives the keyboard back');

  // The folder changed by hand: read again.
  const broken = path.join(folder('sample-shop'), '.claude', 'meetings', ids.broken), aside = path.join(temp, 'broken-aside');
  fs.renameSync(broken, aside);
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await until(async () => await count() === '7', 'the count read again');
  fs.renameSync(aside, broken);
  await openMenuList();
  assert.equal(await count(), '8', 'the menu\'s list is the count');
  await key('Escape');

  // ---------- before a recording ----------
  step('the start dialog');
  await openMenuList();
  await pick('Record a meeting');
  await waitFor("document.querySelectorAll('.meeting-start .mr-monitor').length === 2", 'the monitors before their pictures');
  assert.equal(await has('.meeting-start .mr-thumb img'), false);
  assert.equal(await evaluate("document.querySelector('.meeting-start [data-part=go]').disabled"), false, 'the choice does not wait for pixels');
  await capture('05-start-loading-dark');
  fake.recorder.showThumbnails();
  await waitFor("document.querySelectorAll('.meeting-start .mr-thumb img').length === 2", 'the pictures');
  assert.equal(await evaluate("[...document.querySelectorAll('.mr-monitor input:checked')].map(x => x.value).join()"), '11', 'the main one to begin with');
  assert.match(await text('.meeting-start [data-part=key]'), /Ctrl.*Shift.*F9/);
  assert.match(await text('.meeting-start [data-part=own]'), /default output.*AgentDeck's own sound/, 'what the sound of the computer is');
  assert.doesNotMatch(await text('.meeting-start'), /consent|participants|permission|notify/i, 'no reminder of any consent');
  await evaluate("document.querySelector('.meeting-start [data-part=title]').value = 'Roadmap sync'");
  await evaluate("(() => { const s = document.querySelector('.meeting-start [data-part=mic]'); s.value = 'headset'; })()");
  await click('.mr-monitor input[value="22"]');
  await both('05-start');
  await click('.meeting-start [data-part=go]');
  await waitFor("!$('meetingRec').hidden && !document.querySelector('.meeting-start')", 'recording');
  const [, recorded] = calls('record')[0];
  assert.deepEqual([recorded.title, recorded.microphone, recorded.monitors], ['Roadmap sync', 'headset', ['11', '22']]);
  await until(async () => await count() === '9', 'a recording is in the folder from its start');

  // ---------- while recording ----------
  step('recording');
  fake.recorder.tick(872000, 0.18, 0.05);
  await waitFor("document.querySelector('.rec-time').textContent === '00:14:32'", 'the timer');
  const levels = await evaluate("[...document.querySelectorAll('.rec-meter')].map(m => Number(m.getAttribute('aria-valuenow')))");
  assert.ok(levels[0] > levels[1] && levels[1] > 0 && levels[0] <= 100);
  assert.equal(await inside(), true);
  await click('[data-rec=shot]');
  await waitFor("document.querySelector('.rec-shot .rec-count').textContent === '2'", 'a screenshot a monitor');
  fake.recorder.warn('meetingsSystemSilent', { channel: 'system' });
  await waitFor("!document.querySelector('.rec-warn').hidden", 'the warning');
  await click('[data-rec=warnings]');
  assert.match(await text('.meetings-notes'), /No system sound/);
  await key('Escape');
  await showProject('sample-notes');
  assert.equal(await shown('#meetingRec'), true, 'whatever project is shown');
  assert.equal(await text('.rec-project'), 'sample-shop', 'and it says whose');
  await evaluate("fx.show({ activeSpace: 'node:node-a:/srv/sample-api', spaces: {}, tabs: {}, terminals: [] })"); await settle(150);
  assert.deepEqual([await count(), await shown('#meetingRec')], [null, true], 'also beside a remote project');
  await click('#usage');
  assert.equal(await shown('#meetingRec'), true, 'also in Usage');
  await capture('06-recording-usage-dark');
  await click('#usage');
  await showProject('sample-notes');
  await evaluate("document.querySelectorAll('.toast-item').forEach(x => x.remove())");
  await both('06-recording');
  await openMenuList();
  assert.equal(await evaluate("groupMenu.querySelector('button').disabled"), true, 'one recording in the whole app');
  assert.match(await evaluate("groupMenu.querySelector('button').textContent"), /being recorded: sample-shop/);
  await key('Escape');
  // A reload (a language switch) finds it again.
  await load();
  await waitFor("!$('meetingRec').hidden && document.querySelector('.rec-shot .rec-count').textContent === '2'", 'the recording after a reload');
  await openMeetingView('Roadmap sync');
  assert.deepEqual(await evaluate("['transcribe', 'remove', 'remove-audio'].map(name => Boolean(document.querySelector('[data-mv=\"' + name + '\"]')))"), [false, false, false], 'nothing of that for a meeting being recorded');
  await closeDialogs();

  // Narrow, long and scaled: nothing is cut off.
  step('narrow widths');
  win.setContentSize(900, 600); await settle(300);
  assert.equal(await inside(), true);
  await both('07-narrow');
  win.webContents.setZoomFactor(1.5); await settle(400);
  assert.equal(await inside(), true, 'at 150%');
  await capture('07-narrow-150-dark');
  win.webContents.setZoomFactor(1); win.setContentSize(1280, 800); await settle(300);

  step('quitting while it records');
  assert.equal(meetings.holdsQuit(), true);
  dialogAnswer = 1;
  assert.deepEqual(await Promise.all([meetings.confirmQuit(), meetings.confirmQuit()]), [false, false], 'cancelled; asked once');
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, /is kept/);

  // ---------- the end ----------
  step('stop');
  fake.recorder.tick(75000, 0.1, 0.1);
  await click('[data-rec=stop]');
  await waitFor("$('meetingRec').hidden && Boolean(document.querySelector('.meeting-view [data-mv=transcribe]'))", 'the view with the button');
  assert.equal(await text('.meeting-view h2'), 'Roadmap sync');
  assert.equal(calls('transcribe').length, 0, 'never by itself');
  assert.match(await text('.mv-status'), /Nothing is sent/);
  assert.equal(meetings.holdsQuit(), false);
  assert.equal(await evaluate("document.querySelector('.meeting-view').contains(document.activeElement)"), true, 'the keyboard is in it');
  await waitFor("[...document.querySelectorAll('.mv-shot img')].length === 2 && [...document.querySelectorAll('.mv-shot img')].every(img => img.complete && img.naturalWidth > 0)", 'the screenshots through the scheme');
  await evaluate("document.querySelectorAll('.toast-item').forEach(x => x.remove())");
  await both('08-after-stop');

  // ---------- transcribe ----------
  step('transcribing');
  await click('.meeting-view [data-mv=transcribe]');
  await waitFor("Boolean(document.querySelector('.meeting-process [data-part=total]')?.textContent)", 'the estimate');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.meeting-process select')].map(s => s.value)"), ['Gemini', 'gemini-3.5-transcribe', '', 'Gemini', 'gemini-3.8-flash'], 'the language detected unless chosen');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.meeting-process [data-part=languages] option')].slice(0, 3).map(o => o.textContent)"), ['Automatic', 'Bulgarian + English', 'Bulgarian']);
  assert.match(await text('.meeting-process [data-part=total]'), /≈ \$\d/);
  assert.equal(await evaluate("document.querySelector('.meeting-process [data-part=go]').disabled"), true, 'no key');
  assert.match(await text('.meeting-process [data-part=nokey]'), /No API key for Gemini/);
  await both('09-no-key');
  await click('.meeting-process [data-part=settings]');
  assert.equal(settingsPanes.at(-1), 'models', 'leads to Settings');
  await settings.setApiKey('Gemini', 'test-key-never-sent');
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor("!document.querySelector('.meeting-process [data-part=go]').disabled", 'the key is seen');
  const geminiCost = await text('.meeting-process [data-part=total]');
  await evaluate("(() => { const s = document.querySelector('[data-task=transcription] [data-part=provider]'); s.value = 'OpenAI'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor(`document.querySelector('.meeting-process [data-part=total]').textContent !== ${js(geminiCost)}`, 'the other provider\'s cost');
  assert.equal(await evaluate("document.querySelector('[data-task=transcription] [data-part=model]').value"), 'gpt-transcribe');
  assert.match(await text('[data-task=transcription] [data-part=note]'), /approximate/);
  assert.equal(await evaluate("document.querySelector('.meeting-process [data-part=go]').disabled"), true, 'that one has no key');
  await settings.setApiKey('OpenAI', 'test-key-never-sent');
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor("!document.querySelector('.meeting-process [data-part=go]').disabled", 'both keys');
  assert.match(await text('[data-task=transcription] [data-part=cost]'), / · Automatic$/);
  await evaluate("(() => { const s = document.querySelector('.meeting-process [data-part=languages]'); s.value = 'bg,en'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor("document.querySelector('[data-task=transcription] [data-part=cost]').textContent.endsWith(' · Bulgarian + English')", 'the language beside the cost');
  await both('09-cost');
  await click('.meeting-process [data-part=go]');
  await until(() => calls('transcribe').length === 1, 'the job');
  assert.deepEqual(calls('transcribe')[0][3], { transcription: { provider: 'OpenAI', model: 'gpt-transcribe' }, summary: { provider: 'Gemini', model: 'gemini-3.8-flash' }, languages: ['bg', 'en'], again: false }, 'this meeting\'s choice');
  assert.equal(settings.load().tasks.meetingTranscription.provider, 'Gemini', 'the setting stays');
  fake.pipeline.progress('transcription', 3, 10);
  await waitFor("/Transcribing 30%/.test(document.querySelector('.mv-status').textContent)", 'the progress');
  await both('10-progress');
  fake.pipeline.retrying(15000);
  await waitFor("/trying again in 15 s/.test(document.querySelector('.mv-status').textContent)", 'retrying');
  await capture('10-retrying-dark');
  await click('.meeting-view [data-mv=cancel]');
  await waitFor("Boolean(document.querySelector('.meeting-view [data-mv=transcribe]')) && !document.querySelector('.mv-progress')", 'cancelled');
  assert.equal(calls('cancel').length, 1);

  await click('.meeting-view [data-mv=transcribe]');
  await waitFor("!document.querySelector('.meeting-process [data-part=go]').disabled", 'again');
  assert.equal(await evaluate("document.querySelector('.meeting-process [data-part=languages]').value"), 'bg,en', 'the last language');
  await click('.meeting-process [data-part=go]');
  await until(() => calls('transcribe').length === 2, 'the second job');
  await fake.pipeline.failWith('meetingsNoKey');
  await waitFor("Boolean(document.querySelector('.mv-note.error'))", 'the failure');
  assert.match(await text('.mv-note.error'), /No API key is set/);
  assert.equal(await has('.mv-status [data-mv=settings]'), true, 'and Settings beside it');
  assert.doesNotMatch(await text('.meeting-view'), /sk-secret/, 'never the provider\'s own words');
  await both('11-failed');
  const { retry } = fake.pipeline, { HostError } = require(path.join(src, 'host', 'errors'));
  fake.pipeline.retry = async () => { throw new HostError('meetingsModelRetired', 'stopped'); };
  await click('.meeting-view [data-mv=retry]');
  await waitFor("Boolean(document.querySelector('.mv-status [data-mv=again]'))", 'a new run offered');
  assert.match(await text('.mv-note.error'), /has stopped/);
  await click('.mv-status [data-mv=again]');
  await waitFor("Boolean(document.querySelector('.meeting-process [data-part=total]')?.textContent)", 'the dialog of a new run');
  assert.match(await text('.meeting-process'), /paid again/);
  await click('.meeting-process [data-part=cancel]');
  fake.pipeline.retry = retry;
  await click('.meeting-view [data-mv=retry]');
  await until(() => calls('retry').length === 1, 'the retry');
  const running = calls('retry')[0];
  await fake.store.write(running[1], running[2], 'transcript.md', '# Roadmap sync\n\n\n\n- [00:00:04] Me: Two releases this quarter.\n');
  await fake.pipeline.finish({ state: 'transcribed', transcription: { provider: 'Gemini', model: 'gemini-3.5-transcribe', failed: 0 }, error: null });
  await waitFor("Boolean(document.querySelector('.meeting-view [data-mv=summarize]'))", 'transcribed');
  assert.equal(await evaluate("document.querySelector('[data-mv-tab=transcript]').getAttribute('aria-selected')"), 'true');
  await click('.meeting-view [data-mv=summarize]');
  await waitFor("Boolean(document.querySelector('.meeting-process [data-part=total]')?.textContent) && !document.querySelector('.meeting-process [data-part=go]').disabled", 'the summary alone');
  assert.equal(await evaluate("document.querySelectorAll('.meeting-process fieldset').length"), 1);
  await capture('12-summary-alone-dark');
  await click('.meeting-process [data-part=go]');
  await until(() => calls('summarize').length === 1, 'the summary job');
  assert.deepEqual(calls('summarize')[0][3], { summary: { provider: 'Gemini', model: 'gemini-3.8-flash' }, again: false });
  await closeDialogs();
  await fake.pipeline.finish({ state: 'ready', summary: { provider: 'Gemini', model: 'gemini-3.8-flash' }, error: null });
  await waitFor("/The meeting is processed/.test($('toasts').textContent)", 'said where the view is closed');

  // ---------- a meeting ----------
  step('the view');
  await evaluate("document.querySelectorAll('.toast-item').forEach(x => x.remove())");
  await openMeetingView('Checkout planning');
  assert.match(await text('.mv-about'), /21\/10\/2026.*0:02:00.*Ready.*MB/);
  await both('13-summary');
  await click('.mv-summary .md-lines');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.mt-line.hit')].map(row => row.dataset.line)"), ['5', '6', '7', '8'], 'the summary\'s lines are the file\'s');
  assert.equal(await evaluate("document.activeElement.dataset.line"), '5');
  assert.match(await text('.mt-line[data-line="5"]'), /address check runs/);
  await both('14-transcript');
  await waitFor("fx.audios.filter(a => a.currentSrc && a.readyState >= 1).length >= 2", 'both channels');
  await click('.mt-line[data-line="9"] .md-time');
  await waitFor("fx.audios.filter(a => a.currentSrc && !a.paused).length === 2 && fx.audios.filter(a => !a.paused).every(a => a.currentTime >= 61)", 'both play from the time');
  assert.equal(await evaluate("(() => { const [a, b] = fx.audios.filter(x => !x.paused); return Math.abs(a.currentTime - b.currentTime) < 0.6; })()"), true, 'together');
  await click('.mp-play');
  assert.equal(await evaluate("fx.audios.every(a => a.paused)"), true, 'paused together');
  await evaluate("(() => { const s = document.querySelector('.mp-seek'); s.value = '15'; s.dispatchEvent(new Event('input')); })()");
  await settle(150);
  assert.equal(await text('.mp-now'), '00:00:15');
  await evaluate("document.querySelector('[data-mv-tab=transcript]').focus()");
  await key('Right');
  assert.deepEqual(await evaluate("[document.activeElement.dataset.mvTab, document.querySelector('.mv-screens').hidden]"), ['screens', false], 'the tabs by the arrows');
  await waitFor("[...document.querySelectorAll('.mv-shot img')].every(img => img.complete && img.naturalWidth > 0)", 'the screenshots');
  await both('15-screens');
  await click('.mv-shot');
  await waitFor("document.querySelector('.meeting-screen img')?.naturalWidth === 1280", 'a screenshot opened');
  await capture('16-screenshot-dark');
  await key('Right');
  assert.match(await text('.meeting-screen h2'), /00:01:10, monitor 2/);
  await key('Escape');
  assert.deepEqual([await has('.meeting-screen'), await has('.meeting-view')], [false, true], 'Escape closes the top one only');

  await click('.meeting-view [data-mv=rename]');
  await evaluate("document.querySelector('.mv-rename').value = 'Never saved'");
  await key('Escape');
  assert.deepEqual([await has('.meeting-view'), await text('.meeting-view h2')], [true, 'Checkout planning'], 'Escape gives up the new name only');
  await click('.meeting-view [data-mv=rename]');
  await evaluate("document.querySelector('.mv-rename').value = 'Checkout and addresses'");
  await key('Return');
  await waitFor("document.querySelector('.meeting-view h2').textContent === 'Checkout and addresses'", 'renamed');
  assert.equal((await fake.store.read(folder('sample-shop'), ids.ready)).title, 'Checkout and addresses');

  await click('.meeting-view [data-mv=copy]');
  await until(() => copied.length === 1, 'the path');
  assert.ok(copied[0].endsWith(path.join(ids.ready, 'summary.md')), 'where an agent starts');

  await click('.meeting-view [data-mv=again]');
  await waitFor("Boolean(document.querySelector('.meeting-process [data-part=total]')?.textContent)", 'run again');
  assert.match(await text('.meeting-process'), /paid again/);
  await both('17-again');
  await click('.meeting-process [data-part=go]');
  await until(() => calls('transcribe').length === 3, 'a run again');
  assert.equal(calls('transcribe')[2][3].again, true);
  await fake.pipeline.finish({ state: 'ready', error: null });
  await waitFor("Boolean(document.querySelector('.meeting-view [data-mv=again]'))", 'done');

  step('deleting');
  await click('[data-mv-tab=screens]');
  await click('.mv-screens [data-mv=remove-screen]');
  await confirm(false);
  assert.equal(calls('removeScreen').length, 0, 'asked first');
  await click('.mv-screens [data-mv=remove-screen]');
  await confirm(true);
  await waitFor("document.querySelectorAll('.mv-shot').length === 1", 'one screenshot less');
  assert.match(fs.readFileSync(path.join(folder('sample-shop'), '.claude', 'meetings', ids.ready, 'summary.md'), 'utf8'), /~~00:00:21~~ \(deleted\)/);
  await click('.meeting-view [data-mv=remove-audio]');
  await capture('18-confirm-dark');
  await confirm(true);
  await waitFor("document.querySelector('.mv-player').hidden && !document.querySelector('.meeting-view [data-mv=again]')", 'no audio');
  assert.equal(calls('removeAudio').length, 1, 'through the audio, not the store');
  await click('[data-mv-tab=summary]');
  await click('.mv-summary .md-time');
  assert.equal(await evaluate("document.querySelector('.mt-line.hit').dataset.line"), '5', 'without sound a time is a line');
  await click('.meeting-view [data-mv=remove]');
  await confirm(true);
  await waitFor("!document.querySelector('.meeting-view')", 'deleted');
  const order = fake.calls.map(call => call[0]);
  assert.ok(order.lastIndexOf('release') >= 0 && order.lastIndexOf('release') < order.lastIndexOf('forget'), 'release, forget, remove');
  assert.equal(fs.existsSync(path.join(folder('sample-shop'), '.claude', 'meetings', ids.ready)), false);
  await until(async () => await count() === '8', 'one fewer');
  assert.doesNotMatch(await text('#toasts'), /not there/, 'no error of its own making');

  step('each state');
  await openMeetingView('Supplier call');
  assert.equal(await has('.meeting-view [data-mv=summarize]'), true);
  assert.equal(await has('.meeting-view [data-mv=again]'), false, 'no sound, nothing to transcribe again');
  await both('19-transcribed');
  await closeDialogs();
  await openMeetingView('Nothing heard');
  assert.match(await text('.mv-status'), /Nothing was recorded/);
  assert.equal(await has('.meeting-view [data-mv=transcribe]'), false);
  await capture('19-empty-dark');
  await closeDialogs();
  await openMeetingView('Design review');
  assert.equal(await has('.meeting-view [data-mv=retry]'), true);
  await closeDialogs();
  await openMeetingView('Left processing');
  assert.match(await text('.mv-status'), /interrupted/);
  assert.equal(await has('.meeting-view [data-mv=transcribe]'), true);
  await closeDialogs();
  await openMeetingView('Weekly review');
  fake.audio.compressing(folder('sample-shop'), ids.recorded, 30000, 120000);
  await waitFor("/Compressing the sound 25%/.test(document.querySelector('.mv-status').textContent)", 'compressing');
  await capture('19-compressing-dark');
  fake.audio.compressing(folder('sample-shop'), ids.recorded, null);
  await waitFor("!document.querySelector('.mv-progress')", 'compressed');
  await closeDialogs();
  await openMeetingView(ids.broken);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.mv-actions button')].map(b => b.dataset.mv)"), ['remove'], 'a broken one can be deleted');
  await both('20-broken');
  await click('.meeting-view [data-mv=remove]');
  await confirm(true);
  await waitFor("!document.querySelector('.meeting-view')", 'the broken one deleted');

  fake.left = [{ key: 'f'.repeat(32), project: folder('sample-shop'), id: ids.recorded, startedAt: Date.now() - 3600000, durationMs: 1000, kind: 'interrupted', code: null }];
  await openMenuList();
  await waitFor("/Unfinished recording/.test(groupMenu.textContent)", 'what a crash left');
  await capture('21-unfinished-dark');
  await pick('Unfinished recording');
  await evaluate("menuLayers.at(-1).querySelector('button.danger').click()");
  await waitFor("Boolean(document.querySelector('dialog.confirm[open]'))", 'the question');
  assert.match(await text('dialog.confirm[open]'), /will have no sound: its only recording/, 'its meeting is there: said plainly');
  await confirm(true);
  await until(() => fake.left.length === 0, 'discarded by its key');
  fake.left = [{ key: 'e'.repeat(32), project: folder('sample-shop'), id: 'gone', startedAt: Date.now() - 3600000, durationMs: 1000, kind: 'compression', code: 'meetingsNotFound' }];
  await openMenuList();
  await waitFor("/Unfinished recording/.test(groupMenu.textContent)", 'a recording whose meeting is gone');
  await pick('Unfinished recording');
  await evaluate("menuLayers.at(-1).querySelector('button.danger').click()");
  await waitFor("Boolean(document.querySelector('dialog.confirm[open]'))", 'the question');
  assert.match(await text('dialog.confirm[open]'), /What is already in the project stays/);
  await confirm(true);
  await until(() => fake.left.length === 0, 'discarded too');

  // ---------- untrusted text ----------
  step('untrusted text');
  await openMeetingView(HOSTILE);
  for (const tab of ['summary', 'transcript']) {
    await click(`[data-mv-tab=${tab}]`);
    await settle(150);
    assert.deepEqual(await evaluate(`(() => { const p = document.querySelector('.mv-${tab}');
      return [p.querySelectorAll('img, a, script, iframe, svg:not(.i), b:not(.mt-text > b), [onerror], [onload], [href], [src], [data-mv]').length, p.querySelectorAll('.md-screen').length, window.pwned ?? null]; })()`), [0, 0, null], `${tab}: text only`);
  }
  assert.equal(await text('.meeting-view h2'), HOSTILE);
  assert.match(await text('.mv-note.error'), /could not be processed/, 'an unknown code has no text of its own');
  assert.match(await text('.mv-summary'), /<script>window.pwned=4<\/script>/);
  assert.deepEqual(requests, [], 'nothing is loaded from the network');
  await both('22-untrusted');
  await closeDialogs();

  // ---------- discard ----------
  step('discard and remembered choices');
  await openMenuList();
  await pick('Record a meeting');
  await waitFor("document.querySelectorAll('.meeting-start .mr-monitor').length === 2", 'the dialog again');
  fake.recorder.showThumbnails();
  assert.deepEqual(await evaluate("[document.querySelector('.meeting-start [data-part=mic]').value, [...document.querySelectorAll('.mr-monitor input:checked')].map(x => x.value).join()]"), ['headset', '11,22'], 'the last choice');
  await click('.meeting-start [data-part=go]');
  await waitFor("!$('meetingRec').hidden", 'recording again');
  await click('[data-rec=discard]');
  await confirm(false);
  assert.equal(await evaluate("$('meetingRec').hidden"), false, 'kept');
  await click('[data-rec=discard]');
  await confirm(true);
  await waitFor("$('meetingRec').hidden", 'discarded');
  assert.equal(await has('.meeting-view'), false);

  // ---------- a window instead of a monitor ----------
  step('a window for the screenshots');
  const choiceBefore = await evaluate("localStorage.getItem('agentdeck.meetingRecording')");
  fake.windows = [{ id: 'window:4242:0', title: '<img src=x onerror=alert(1)> Weekly call' }];
  await openMenuList();
  await pick('Record a meeting');
  await waitFor("document.querySelectorAll('.meeting-start .mr-window').length === 1", 'the open windows');
  fake.recorder.showThumbnails();
  await waitFor("document.querySelectorAll('.meeting-start [data-part=monitors] .mr-thumb img').length === 2", 'the pictures, and the windows again');
  assert.equal(await has('.meeting-start .mr-window img'), false, 'a title is text, and no picture is one');
  assert.match(await text('.meeting-start .mr-window'), /<img src=x onerror=alert\(1\)> Weekly call/);
  await click('.meeting-start [data-part=monitors] input[value="11"]');
  await click('.meeting-start [data-part=monitors] input[value="22"]');
  assert.equal(await evaluate("document.querySelector('.meeting-start [data-part=go]').disabled"), true, 'nothing to take a picture of');
  await click('.meeting-start .mr-window input');
  assert.equal(await evaluate("document.querySelector('.meeting-start [data-part=go]').disabled"), false);
  await click('.meeting-start [data-part=go]');
  await waitFor("!$('meetingRec').hidden && !document.querySelector('.meeting-start')", 'recording a window');
  const windowAsked = fake.calls.filter(call => call[0] === 'record').at(-1)[1];
  assert.deepEqual([windowAsked.monitors, windowAsked.windows], [[], ['window:4242:0']]);
  assert.equal(JSON.parse(await evaluate("localStorage.getItem('agentdeck.meetingRecording')")).windowsOnly, true, 'no monitor is ticked for it the next time');
  await click('[data-rec=discard]');
  await confirm(true);
  await waitFor("$('meetingRec').hidden", 'discarded');
  fake.windows = null;
  await evaluate(`localStorage.setItem('agentdeck.meetingRecording', ${JSON.stringify(choiceBefore)})`);

  fake.capabilities = { supported: false, code: 'meetingsWindowsOnly' };
  await openMenuList();
  assert.deepEqual(await evaluate("[groupMenu.querySelector('button').disabled, groupMenu.querySelector('button').textContent.includes('Windows only')]"), [true, true], 'elsewhere only the recording is missing');
  await capture('24-not-windows-dark');
  await pick('Supplier call');
  await waitFor("Boolean(document.querySelector('.meeting-view .mt-line'))", 'reading works there');
  await closeDialogs();
  fake.capabilities = { supported: true, code: null, longRecordingMs: 4 * 3600e3 };

  // ---------- refusals ----------
  step('refusals');
  stranger = new BrowserWindow(options);
  await stranger.loadFile(page);
  const refused = await stranger.webContents.executeJavaScript("Promise.all([window.meetings.list('C:/work/sample-shop'), window.meetings.start('C:/work/sample-shop', { monitors: ['11'], microphone: 'default' }), window.meetings.state()])");
  assert.deepEqual(refused.map(answer => [answer.ok, answer.code]), [[false, 'accessDenied'], [false, 'accessDenied'], [false, 'accessDenied']], 'the manager window only');
  stranger.destroy();
  const answer = code => evaluate(`window.meetings.${code}.then(a => (a.ok ? 'ok' : a.code))`);
  const shop = "'C:/work/sample-shop'", id = js(ids.recorded);
  fs.mkdirSync(folder('not-listed'));
  for (const [code, expected] of [
    ["list('C:/work/not-listed')", 'meetingsNotLocal'],
    ["list('C:/work/sample-shop/..')", 'meetingsNotLocal'],
    ["list('//files.example.test/share/project')", 'meetingsNotLocal'],
    ["list('node:node-a:/srv/sample-api')", 'meetingsNotLocal'],
    ["list('/srv/sample-api')", 'meetingsNotLocal'],
    ['list(null)', 'invalidData'], ['count({})', 'invalidData'],
    [`open(${shop}, '../../..')`, 'invalidData'],
    [`remove(${shop}, '2026-10-21-1430-x/../..')`, 'invalidData'],
    [`removeScreen(${shop}, ${id}, 'screens/../meeting.json')`, 'invalidData'],
    [`removeScreen(${shop}, ${id}, 'audio/mic.webm')`, 'invalidData'],
    [`transcribe(${shop}, ${id}, { transcription: { provider: 'Elsewhere', model: 'x' } })`, 'invalidData'],
    [`transcribe(${shop}, ${id}, { languages: ['bg', 'xx'] })`, 'invalidData'],
    [`transcribe(${shop}, ${id}, { languages: 'bg' })`, 'invalidData'],
    [`transcribe(${shop}, ${id}, { summary: { provider: 'Gemini', model: '../../x y' } })`, 'invalidData'],
    [`estimate(${shop}, ${id}, { transcription: 'all' })`, 'invalidData'],
    [`rename(${shop}, ${id}, 5)`, 'invalidData'],
    [`start(${shop}, { monitors: [], microphone: 'default' })`, 'invalidData'],
    [`start(${shop}, { monitors: [], windows: ['screen:0:0'], microphone: 'default' })`, 'invalidData'],
    [`start(${shop}, { monitors: ['11'], windows: 'window:1:0', microphone: 'default' })`, 'invalidData'],
    [`start(${shop}, { monitors: [11], microphone: 'default' })`, 'invalidData'],
    ["discardRecoverable('../../../x')", 'meetingsNotFound']
  ]) assert.equal(await answer(code), expected, code);

  const opened = await evaluate(`window.meetings.open(${shop}, ${id}).then(a => a.value)`);
  assert.doesNotMatch(JSON.stringify(opened).replace(opened.place, ''), /"dir"|\.claude/, 'no path of the meeting\'s files');
  assert.match(opened.media, /^agentdeck-meeting:\/\/[0-9a-f]{48}\/$/, 'an address without a path');
  const get = (name, headers = {}, base = opened.media) => net.fetch(base + name, { headers });
  const part = await get('audio/mic.webm', { range: 'bytes=100-199' });
  assert.deepEqual([part.status, part.headers.get('content-range'), (await part.arrayBuffer()).byteLength], [206, `bytes 100-199/${SOUND.length}`, 100]);
  for (const name of ['meeting.json', 'summary.md', 'audio/other.webm', 'screens/../meeting.json', 'audio/%2e%2e/meeting.json', '../meeting.json']) assert.equal((await get(name)).status, 404, name);
  assert.equal((await get('audio/mic.webm', {}, `agentdeck-meeting://${'0'.repeat(48)}/`)).status, 404, 'no token, no file');
  assert.equal((await get('audio/mic.webm', { range: 'bytes=99999999-' })).status, 416);
  // Deleting a screenshot lets go of that file only: the sound being played goes on.
  await fake.store.write(folder('sample-shop'), ids.recorded, 'screens/00-00-01-m1.png', picture(64, 40));
  await fake.store.update(folder('sample-shop'), ids.recorded, { screens: [{ file: 'screens/00-00-01-m1.png', atMs: 1000, monitor: 1 }] });
  const playing = (await get('audio/mic.webm')).body.getReader();
  let heard = (await playing.read()).value.byteLength;
  assert.equal(await answer(`removeScreen(${shop}, ${id}, 'screens/00-00-01-m1.png')`), 'ok');
  for (let chunk; !(chunk = await playing.read()).done;) heard += chunk.value.byteLength;
  assert.equal(heard, SOUND.length, 'the whole sound, after the screenshot went');
  const listed = PROJECTS.shift();
  assert.equal((await get('audio/mic.webm')).status, 404, 'a project that left the list');
  PROJECTS.unshift(listed);
  for (const file of fs.readdirSync(path.join(src, 'mesh')).filter(name => name.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(src, 'mesh', file), 'utf8'), /meetings/i, `${file}: nothing for other computers or phones`);
  }
  for (const code of Object.keys(require(path.join(src, 'meetings', 'errors')).MESSAGES)) {
    for (const language of ['en', 'bg']) {
      assert.ok(fs.readFileSync(path.join(src, 'i18n.js'), 'utf8').split(`"errors.${code}":`).length === 3, `${code} in both languages`);
      i18n.setLanguage(language);
      assert.notEqual(i18n.t(`errors.${code}`), `errors.${code}`);
    }
  }
  i18n.setLanguage('en');

  // ---------- Bulgarian ----------
  step('Bulgarian');
  await load('bg');
  assert.match(await text('#meetingsBtn'), /Срещи/);
  await openMenuList();
  await waitFor("/KB|MB/.test(groupMenu.textContent)", 'the sizes');
  assert.match(await evaluate('groupMenu.textContent'), /Запиши среща/);
  await both('30-bg-menu');
  await pick('Запиши среща');
  await waitFor("document.querySelectorAll('.meeting-start .mr-monitor').length === 2", 'the dialog');
  fake.recorder.showThumbnails();
  await waitFor("document.querySelectorAll('.mr-thumb img').length === 2", 'the pictures');
  assert.doesNotMatch(await text('.meeting-start'), /съгласи|участници|уведоми/i);
  await both('31-bg-start');
  await evaluate("document.querySelector('.meeting-start [data-part=title]').value = 'Планиране на версията'");
  await click('.meeting-start [data-part=go]');
  await waitFor("!$('meetingRec').hidden", 'recording');
  fake.recorder.tick(4332000, 0.3, 0.02);
  fake.recorder.warn('meetingsMicSilent', { channel: 'mic' });
  await settle(200);
  await evaluate("document.querySelectorAll('.toast-item').forEach(x => x.remove())");
  assert.equal(await inside(), true);
  await both('32-bg-recording');
  win.setContentSize(900, 600); await settle(300);
  assert.equal(await inside(), true, 'Bulgarian, narrow');
  await both('32-bg-narrow');
  await click('[data-rec=stop]');
  await waitFor("Boolean(document.querySelector('.meeting-view [data-mv=transcribe]'))", 'stopped');
  assert.equal(await evaluate("[...document.querySelectorAll('.meeting-view .mv-actions button')].every(b => { const r = b.getBoundingClientRect(), d = b.closest('dialog').getBoundingClientRect(); return r.right <= d.right && r.left >= d.left; })"), true, 'the actions fit');
  await both('33-bg-view');
  await click('.meeting-view [data-mv=transcribe]');
  await waitFor("Boolean(document.querySelector('.meeting-process [data-part=total]')?.textContent)", 'the cost');
  await both('34-bg-cost');
  await closeDialogs();
  await openMeetingView('Supplier call');
  await both('35-bg-transcript');
  await closeDialogs();
  win.setContentSize(1280, 800);

  step('every theme');
  for (const { id: theme } of require(path.join(src, 'shared', 'themes')).LIST) {
    await evaluate(`document.documentElement.dataset.theme = ${js(theme)}`);
    await openMeetingView('Design review');
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.mv-note.error')).color !== getComputedStyle(document.querySelector('.meeting-view')).backgroundColor"), true, theme);
    await capture(`40-theme-${theme}`);
    await closeDialogs();
  }

  step('a launched session');
  fs.rmSync(path.join(folder('sample-shop'), '.agents'), { recursive: true, force: true });
  await meetings.sessionLaunched(folder('sample-notes'));
  assert.equal(fs.existsSync(path.join(folder('sample-notes'), '.claude')), false, 'no meetings, nothing written');

  // ---------- Settings ----------
  step('the key in Settings');
  assert.deepEqual(errors, [], 'no error in the page');
  ipcMain.on('prefs:get', event => {
    event.returnValue = { ...require(path.join(src, 'prefs')).get(), language: 'bg', themeId: 'dark', windows: true };
  });
  const voiceWindows = require(path.join(src, 'voice', 'windows')).createVoiceWindows({
    settings, store: {}, queue: { on() {} }, listDevices: async () => [], general: { hotkey: () => ({ current: 'Alt + `', candidates: [] }) }
  });
  i18n.setLanguage('bg');
  const settingsWin = voiceWindows.openSettings('meetings');
  const inSettings = code => settingsWin.webContents.executeJavaScript(code, true);
  settingsWin.webContents.on('console-message', ({ level, message }) => { if (level === 'error') errors.push(`settings: ${message}`); });
  await until(() => !settingsWin.webContents.isLoading() && inSettings("document.body?.dataset.pane === 'meetings' && Boolean(document.getElementById('hkMeetingShot')?.value)").catch(() => false), 'Settings at Meetings').catch(async error => { console.log(await inSettings("JSON.stringify([document.body.dataset.pane, document.getElementById('hkMeetingShot')?.value, document.body.innerText.slice(0, 300)])").catch(e => e.message), errors); throw error; });
  assert.equal(await inSettings("document.getElementById('hkMeetingShot').value"), 'Control+Shift+F9', 'the default');
  await inSettings(`(() => { const el = document.getElementById('hkMeetingShot');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true }));
    document.getElementById('save').click(); })()`);
  await until(() => inSettings("Boolean(document.querySelector('[data-err=\"hotkeys.meetingScreenshot\"]').textContent)"), 'the conflict');
  assert.match(await inSettings("document.querySelector('[data-err=\"hotkeys.meetingScreenshot\"]').textContent"), /вече се използва/);
  assert.equal(await inSettings('document.body.dataset.pane'), 'meetings');
  await capture('50-settings-conflict', settingsWin);
  await inSettings("document.querySelector('[data-reset=meetingScreenshot]').click()");
  await capture('50-settings', settingsWin);
  const { validateSettings } = require(path.join(src, 'voice', 'windows'));
  const base = { hotkeys: { dictate: 'Control+Space', readAloud: 'Control+Shift+Space' } };
  const inUse = { hotkeys: settings.load().hotkeys, edge: 'Alt + `' };
  const check = shot => validateSettings({ ...base, hotkeys: { ...base.hotkeys, meetingScreenshot: shot } }, settings.PROVIDERS, inUse);
  for (const taken of ['Control+Space', 'Control+Shift+Space', 'Control+Alt+Space', 'Control+Shift+/', 'Alt+`', 'shift+a', '']) assert.ok(check(taken).errors['hotkeys.meetingScreenshot'], `refused: ${taken}`);
  assert.equal(check('ctrl+shift+f8').patch.hotkeys.meetingScreenshot, 'Control+Shift+F8');
  await inSettings(`(() => { const el = document.getElementById('hkMeetingShot');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    document.getElementById('save').click(); })()`).catch(() => {});
  await until(() => settings.load().hotkeys.meetingScreenshot === 'Control+Shift+F8', 'the saved key');

  assert.deepEqual(errors, [], 'no error in Settings either');
  // ---------- leaving ----------
  step('Windows ending the session');
  const ended = (await fake.recorder.start({ project: folder('sample-notes'), title: 'Ended by Windows', microphone: 'default', monitors: ['11'] })).meeting;
  dialogAnswer = 0;
  assert.equal(await meetings.confirmQuit(), true, 'as for an update that then did not install');
  const askedBefore = asked.length;
  meetings.watchSessionEnd(win);
  win.emit('query-session-end', { preventDefault() {}, reasons: ['shutdown'] });
  await until(() => fake.recorder.status().phase === 'idle', 'saved as Windows ends the session');
  win.emit('session-end', { reasons: ['shutdown'] }); // once is enough
  assert.equal(asked.length, askedBefore, 'no dialog there');
  assert.equal((await fake.store.read(folder('sample-notes'), ended.id)).state, 'recorded');

  step('shutdown');
  i18n.setLanguage('en');
  await fake.recorder.start({ project: folder('sample-notes'), title: 'Last one', microphone: 'default', monitors: ['11'] });
  assert.equal(meetings.holdsQuit(), true, 'a quit allowed for the recording before is asked again');
  dialogAnswer = 0;
  assert.equal(await meetings.confirmQuit(), true);
  assert.equal(meetings.holdsQuit(), false, 'asked once');
  await meetings.shutdown();
  assert.equal(calls('shutdown').length, 1);
  console.log('Meetings UI: the button, the menu, recording, processing, the view, refusals, untrusted text, Settings, both languages and every theme passed');
  console.log(`Screenshots: ${screenshots}`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  console.error('page errors:', globalThis.pageErrors);
  app.exit(1);
});
