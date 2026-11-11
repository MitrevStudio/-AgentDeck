// Replays the ten audit failure scenarios against the production modules, with isolated OS/transport faults.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
function load(file, mocks = {}, transform = s => s) {
  const filename = path.join(root, 'src', file), req = createRequire(filename), module = { exports: {} };
  const context = { module, exports: module.exports, require: id => Object.hasOwn(mocks, id) ? mocks[id] : req(id),
    process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, __dirname: path.dirname(filename) };
  vm.runInNewContext(transform(fs.readFileSync(filename, 'utf8')), context, { filename });
  return module.exports;
}
class Socket extends EventEmitter {
  OPEN = 1; readyState = 1; sent = []; pings = 0;
  send(data) { this.sent.push(JSON.parse(data)); }
  ping() { this.pings++; if (this.respond) this.emit('pong'); }
  close(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}
const cases = [];
const test = (name, fn) => cases.push([name, fn]);
let dir;

test('1 command centre: timeout, exit and exit between text and Enter never submit to a shell', async () => {
  // The pause between the text and Enter lives in host/send-text.js, which the orchestrator requires.
  const sendText = load('host/send-text.js', {}, s => s.replace('const ENTER_DELAY_MS = 400', 'const ENTER_DELAY_MS = 1'));
  const { createOrchestrator } = load('orchestrator.js', { './host/send-text': sendText }, s => s.replace('const POLL_MS = 1500', 'const POLL_MS = 1').replace('const READY_WAIT_MS = 45000', 'const READY_WAIT_MS = 5'));
  let tabs, live, written = [], exitOnText = false;
  const cwd = path.join(dir, 'orchestrator');
  const centre = createOrchestrator({ userData: dir, norm: s => s, t: s => s,
    terminals: { getTabs: () => tabs, type: (_id, text) => { written.push(text); if (exitOnText) live = []; } },
    liveSessions: async () => live, showTab() {}, workspace: { addTab() {} },
    openTerminal: async () => { tabs = [{ id: 'tab', cwd, sessionId: 'session', exited: false, agentOnly: true }]; return 'tab'; } });
  tabs = []; live = [];
  await assert.rejects(centre.send('Write-Output audit-marker'), /did not become ready/);
  assert.deepEqual(written, []);
  tabs[0].exited = true;
  await assert.rejects(centre.send('Write-Output audit-marker'));
  assert.deepEqual(written, []);
  live = [{ id: 'session', status: 'idle' }]; exitOnText = true;
  await assert.rejects(centre.send('hello'), /stopped/);
  assert.deepEqual(written, ['hello']);
  written = []; live = [{ id: 'session', status: 'busy' }];
  await assert.rejects(centre.send('hello'));
  assert.deepEqual(written, []);
  centre.stop();
});

test('2 remote ownership: requests and pushes expose only the publisher projects', async () => {
  const { createServed } = require('../src/mesh/serve');
  const snapshot = { registry: { projects: [{ path: '/local', name: 'Local' }, { node: 'A', path: '/foreign', name: 'Foreign' }], removed: ['private'] }, sessions: [] };
  const host = Object.assign(new EventEmitter(), { sessions: { data: async () => snapshot }, terminals: {}, launch: {}, git: {}, setup: {} });
  const served = createServed({ host });
  const data = await served.api('sessions.list');
  assert.deepEqual(data.registry.projects, [{ path: '/local', name: 'Local' }]);
  assert.equal(data.registry.removed, undefined);
  let pushed;
  served.attach({ on() {}, nodes: () => [], notifyAll: (_name, value) => { pushed = value; } });
  host.emit('data', snapshot);
  assert.deepEqual(pushed, data);
  const { mergeProjects } = require('../src/mesh/projects');
  const registry = { projects: [], removed: [], groups: [] };
  mergeProjects(registry, [{ id: 'B' }], new Map([['B', { data: snapshot }]]));
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].path, '/local');
});

test('3 offline startup and reconnect retain remote names, groups and pins', () => {
  const { mergeProjects } = require('../src/mesh/projects');
  const project = { node: 'B', name: 'Custom', path: '/Work', pin: 0, group: 'g' };
  const data = { projects: [project], removed: [], groups: [{ id: 'g', name: 'Group', pin: 1 }] };
  const nodes = [{ id: 'B' }], remote = new Map();
  assert.equal(mergeProjects(data, nodes, remote), false);
  remote.set('B', { data: { registry: { projects: [{ path: '/Work', name: 'Work' }] } } });
  assert.equal(mergeProjects(data, nodes, remote), false);
  assert.deepEqual(data.projects[0], project);
  assert.equal(data.groups[0].pin, 1);
  remote.set('B', { data: { registry: { projects: [] } } });
  assert.equal(mergeProjects(data, nodes, remote), true);
  assert.equal(data.projects.length, 0);
  data.projects.push(project);
  mergeProjects(data, [], remote);
  assert.equal(data.projects.length, 0, 'explicitly forgotten host is removed');
});

test('4 registry: EACCES/corruption cannot overwrite data; failed atomic rename preserves original', () => {
  const { createRegistry } = require('../src/host/registry');
  const file = path.join(dir, 'registry.json'), registry = createRegistry(file);
  assert.equal(registry.read().projects.length, 0);
  const data = { projects: [{ name: 'Keep', path: dir }], groups: [], removed: [] };
  registry.write(data);
  const previous = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); };
    assert.throws(() => registry.write({ projects: [] }), /locked/);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  const denied = load('host/registry.js', { 'node:fs': { ...fs, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } }).createRegistry(file);
  assert.throws(() => denied.read(), /denied/);
  assert.throws(() => denied.write({ projects: [] }), /denied/);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => registry.read());
  assert.throws(() => registry.write(data));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, previous);
  assert.equal(registry.read().projects[0].name, 'Keep');
  registry.write(data);
});

test('5 Clone to: branch failure prevents the agent; successful branch starts it; agent shell exits', async () => {
  const { createLaunch } = require('../src/host/launch');
  let opened;
  const launch = createLaunch({ dataDir: dir, terminals: { open: async args => { opened = args; return 'tab'; } } });
  const spec = launch.cloneCommand({ url: 'https://example.invalid/repo.git', dir, branch: 'audit', base: 'missing', agent: 'Claude' });
  if (process.platform === 'win32') {
    for (const fail of [true, false]) {
      const prelude = `function git { if ($args[0] -eq 'clone') { $global:LASTEXITCODE = 0 } elseif ($args[0] -eq 'branch') { $global:LASTEXITCODE = 0; 'audit' } elseif (${fail ? '$true' : '$false'}) { $global:LASTEXITCODE = 1; Write-Error 'missing branch' } else { $global:LASTEXITCODE = 0 } }; function claude { 'AGENT_STARTED' }; `;
      let output = '';
      try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prelude + spec.command, 'utf16le').toString('base64')], { env: { ...process.env, ...spec.env }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { output = String(e.stdout); assert.equal(e.status, 1); }
      assert.equal(output.includes('AGENT_STARTED'), !fail);
    }
  }
  assert.match(spec.argv[2], /cd -- .*\|\| exit 1/);
  assert.match(spec.argv[2], /actual_branch=.*\|\| exit 1/);
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (fs.existsSync(bash)) {
    for (const fail of [true, false]) {
      const prelude = `git() { case "$1" in clone) return 0;; branch) printf 'audit\\n';; *) return ${fail ? 1 : 0};; esac; }; exec() { printf 'AGENT_STARTED\\n'; }; `
        + (process.platform === 'win32' ? 'AGENTDECK_DIR=$(cygpath -u "$AGENTDECK_DIR"); ' : '');
      let output = '';
      try { output = execFileSync(bash, ['--noprofile', '--norc', '-c', prelude + spec.argv[2]], { env: { ...process.env, ...spec.env }, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { output = String(e.stdout); assert.equal(e.status, 1); }
      assert.equal(output.includes('AGENT_STARTED'), !fail);
    }
  }
  await launch.openTerminal(dir, "& 'claude'", { agent: 'Claude' }, {}, 'test');
  assert.doesNotMatch(opened.commandLine, /-NoExit/);
  await launch.openTerminal(dir, 'echo hello', {}, {}, 'test');
  assert.match(opened.commandLine, /-NoExit/);
});

test('6 dictation: modifier timeout and late focus change fall back to clipboard', async () => {
  let pasted = 0, typed = 0, focused = true, released = false, stolen = false;
  const w = { exclusive: fn => fn(), focus: async () => true, waitModifiersUp: async () => released,
    writeClipboardText: async () => true, sendCtrlV: () => { pasted++; return true; }, typeUnicode: () => { typed++; return true; },
    isAlive: () => focused, foregroundHwnd: () => stolen ? 2n : 1n, anyModifierDown: () => false };
  const { deliver } = load('voice/delivery.js', { './native': w, '../shared/util': { sleep: async () => { stolen = true; } } });
  const target = { hwnd: 1n };
  assert.equal((await deliver('text', target)).outcome, 'ClipboardOnly');
  released = true;
  assert.equal((await deliver('text', target)).outcome, 'ClipboardOnly');
  assert.equal((await deliver('text', target, { useClipboard: false })).outcome, 'ClipboardOnly');
  assert.equal(pasted + typed, 0);
  stolen = false;
  assert.equal((await deliver('text', target, { useClipboard: false })).outcome, 'Injected');
});

test('7 new Codex sessions link by launch identity, including two sessions in one cwd; Linux PID matches itself', async () => {
  const { createCodexLive } = require('../src/host/codex-live');
  const { findTabPid } = require('../src/host/tab-links');
  const { launchIdentity, readIdentity } = require('../src/host/codex-link');
  const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
  const sessions = [], tabs = [], linked = [];
  for (let i = 0; i < 2; i++) {
    const identity = launchIdentity(dir);
    fs.mkdirSync(path.dirname(identity.codexLog), { recursive: true });
    fs.writeFileSync(identity.codexLog, `INFO session_init{thread_id=${ids[i]}}: new session\n`);
    const file = path.join(dir, `rollout-${i}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_started' } }) + '\n');
    sessions.push({ agent: 'Codex', id: ids[i], cwd: dir, file });
    tabs.push({ id: `tab${i}`, agent: 'Codex', sessionId: '', codexLog: identity.codexLog, cwd: dir, pid: 123 + i });
  }
  const poll = createCodexLive({ sessions: () => sessions, tabs: () => tabs, link: (...args) => linked.push(args) });
  const live = await poll();
  assert.deepEqual(live.map(l => l.pid), [123, 124]);
  assert.deepEqual(linked.map(l => l[2]), ids);
  assert.equal(findTabPid(123, new Map([[123, 1]]), new Set([123])), 123);
  assert.equal(findTabPid(9, new Map([[9, 123]]), new Set([123])), 123);
  assert.equal(findTabPid(9, new Map([[9, 9]]), new Set([123])), 0);
  const unknown = path.join(dir, 'unknown.log');
  fs.writeFileSync(unknown, `user message thread_id=${ids[0]}`);
  assert.equal(await readIdentity(unknown), '');
});

test('8 Linux path case stays distinct in registry, renderer and migrated workspaces', () => {
  const { normPath } = require('../src/shared/util');
  const { keyOf } = require('../src/host/registry');
  const { migrateLayout } = require('../src/shared/path-keys');
  assert.notEqual(normPath('/home/dev/App'), normPath('/home/dev/app'));
  assert.equal(normPath('C:\\Work\\App\\'), normPath('c:/work/app'));
  assert.notEqual(keyOf({ node: 'linux', path: '/App' }), keyOf({ node: 'linux', path: '/app' }));
  const common = fs.readFileSync(path.join(root, 'src/common.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(common.match(/const normPath = p => \{[\s\S]*?\n\};/)[0] + '\nglobalThis.result = [normPath("/App"), normPath("/app")];', ctx);
  assert.notEqual(...ctx.result);
  const layout = { spaces: { 'node:linux:/app': { tabs: ['t'] } }, activeSpace: 'node:linux:/app' };
  const migrated = migrateLayout(layout, [{ node: 'linux', path: '/App' }], keyOf);
  assert.ok(migrated.spaces['node:linux:/App']);
  const ambiguous = migrateLayout(layout, [{ node: 'linux', path: '/App' }, { node: 'linux', path: '/app' }], keyOf);
  assert.ok(ambiguous.spaces['node:linux:/app']);
  const data = { removed: ['node:linux:/app'], legacyRemoved: ['node:linux:/app'] };
  require('../src/shared/path-keys').migrateRemoved(data, [{ node: 'linux', path: '/App' }], keyOf);
  assert.deepEqual(data.removed, ['node:linux:/App']);
  assert.deepEqual(data.legacyRemoved, []);
});

test('9 silent socket dies on heartbeat, pending requests reject, healthy slow calls keep the link', async () => {
  const { createLink } = require('../src/mesh/protocol');
  const ws = new Socket(); let closes = 0;
  const link = createLink(ws, { heartbeatMs: 5, onClose: () => closes++ });
  const pending = assert.rejects(link.call('stuck'), e => e.code === 'closed');
  await delay(35); await pending;
  assert.equal(link.isOpen(), false); assert.equal(closes, 1);
  const healthy = new Socket(); healthy.respond = true;
  const alive = createLink(healthy, { heartbeatMs: 5 });
  await assert.rejects(alive.call('slow', {}, { timeout: 15 }), e => e.code === 'timeout');
  assert.equal(alive.isOpen(), true);
  alive.close();
});

test('10 incompatible hello is rejected before online or serving application requests', async () => {
  let accept, calls = 0;
  // As peers.js keeps one: control is always set (a request from a peer without control === true is refused).
  const peer = { id: 'peer', name: 'Peer', control: true };
  const peers = { get: id => id === 'peer' ? peer : null, list: () => [peer], code: () => '123456', update() {} };
  const { createLinks } = load('mesh/links.js', {
    './identity': { loadIdentity: async () => ({ id: 'self', settings: { name: 'Self', port: 0 } }) },
    './peers': { createPeers: () => peers },
    './server': { createServer: options => { accept = options.onConnection; return { start: async () => {}, port: () => 1, stop() {} }; } },
  });
  const links = createLinks({ dir, defaultName: 'test', discover: false, api: () => { calls++; return true; } });
  await links.start();
  const ws = new Socket();
  accept(ws, { id: 'peer', address: 'localhost' });
  ws.message({ id: 1, method: 'sessions.list' });
  ws.message({ event: 'hello', data: { id: 'peer', protocol: 999 } });
  await delay(5);
  assert.equal(links.online('peer'), false); assert.equal(calls, 0);
  assert.match(links.nodes()[0].error, /Update AgentDeck/);
  const good = new Socket();
  accept(good, { id: 'peer', address: 'localhost' });
  good.message({ event: 'hello', data: { id: 'peer', protocol: 1 } });
  await delay(5);
  assert.equal(links.online('peer'), true);
  good.message({ id: 2, method: 'sessions.list' });
  await delay(1); assert.equal(calls, 1);
  links.stop();
});

(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-audit-'));
  try {
    for (const [name, run] of cases) { await run(); console.log(`PASS ${name}`); }
    console.log(`${cases.length}/${cases.length} audit regressions passed`);
  } finally {
    // Only the unique directory this test created, never the real app profile.
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('agentdeck-audit-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
