const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const scan = require('../src/host/usage-scan');
const context = require('../src/host/session-context');
const { parseModels, createModelLimits } = require('../src/host/opencode-models');
const { launchSettings, readSnapshots, prune } = require('../src/host/claude-context');
const { collect } = require('../src/host/claude-context-collector');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-context-'));
const line = x => JSON.stringify(x) + '\n';
const stamp = n => new Date(1700000000000 + n).toISOString();
const claude = (n, usage, extra = {}) => ({ type: 'assistant', timestamp: stamp(n), message: { id: `m${n}`, model: 'claude-sonnet-4-6', usage }, ...extra });
const event = (n, total, last) => ({ type: 'event_msg', timestamp: stamp(n), payload: { type: 'token_count', info: {
  model_context_window: 100000, total_token_usage: { input_tokens: total, output_tokens: 0, cached_input_tokens: 0, total_tokens: total },
  last_token_usage: { input_tokens: last, output_tokens: 0, total_tokens: last }
} } });
const row = (id, input, extra = {}) => ({ id, type: 'assistant', time_created: 100, time_updated: 100,
  data: JSON.stringify({ model: { id: 'model', providerID: 'provider' }, time: { completed: 100 }, tokens: { input, output: 10 }, ...extra }) });

async function main() {
  const state = { msgs: new Map() };
  // Long prefixes and whitespace must not hide usage records.
  const first = claude(1, { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 });
  scan.readClaude(Buffer.from(line({ padding: 'x'.repeat(700), ...first })), state);
  assert.equal(state.context.tokens, 600);
  assert.equal(state.context.cache, null);
  scan.readClaude(Buffer.from(line(claude(2, { input_tokens: 10, output_tokens: 5 }, { isSidechain: true }))), state);
  assert.equal(state.context.tokens, 600);
  scan.readClaude(Buffer.from(line({ type: 'system', subtype: 'compact_boundary', timestamp: stamp(3) })), state);
  assert.equal(state.context.status, 'pending');
  scan.readClaude(Buffer.from(line(claude(4, { input_tokens: 50, output_tokens: 10 }))), state);
  assert.equal(state.context.tokens, 50, 'context can shrink without erasing usage');
  assert.equal(state.msgs.size, 3);
  assert.equal(context.claude(claude(5, { input_tokens: 0, output_tokens: 0 })), null);

  const cx = { msgs: new Map() };
  scan.readCodex(Buffer.from(line(event(1, 90000, 12000)) + line(event(2, 90000, 4000))), cx);
  assert.equal(cx.context.tokens, 4000, 'context updates without new billable tokens');
  assert.equal(cx.msgs.size, 1);
  scan.readCodex(Buffer.from(line({ type: 'compacted', timestamp: stamp(3), payload: {} })), cx);
  assert.equal(cx.context.tokens, null);
  scan.readCodex(Buffer.from(line(event(4, 92000, 2000))), cx);
  assert.equal(cx.context.tokens, 2000);
  cx.model = 'old';
  scan.readCodex(Buffer.from(line({ type: 'turn_context', timestamp: stamp(5), payload: { model: 'new' } })), cx);
  assert.equal(cx.context.status, 'pending');
  assert.equal(cx.context.model, 'new');

  const root = context.openCode(row('root', 50000));
  assert.equal(root.tokens, 50010);
  assert.equal(root.provider, 'provider');
  assert.equal(context.openCode({ ...row('summary', 50000, { status: 'completed' }), type: 'compaction' }).status, 'pending');
  assert.equal(context.openCode({ ...row('summary', 50000, { status: 'failed' }), type: 'compaction' }), null);
  assert.equal(context.openCode(row('error', 50000, { error: {} })), null);
  const accounting = scan.openCodeRecord(row('root', 50000));
  const child = scan.openCodeRecord(row('child', 1000));
  child[1] = 200;
  const summary = scan.aggregate([{ key: 'OpenCode:root', msgs: [accounting, child], context: root }]);
  assert.equal(summary.sessions[0].context.tokens, 50010);
  assert.equal(summary.rows[0][3], 51000, 'child cost still belongs to the root');
  const fork = scan.aggregate([{ key: 'Claude:a', msgs: [accounting], context: root },
    { key: 'Claude:b', msgs: [accounting], context: { ...root, tokens: 99 } }]);
  assert.equal(fork.sessions.length, 2, 'deduplicated usage must not remove fork context');
  assert.equal(fork.sessions[1].context.tokens, 99);

  const data = { session_id: 'fixture-session', model: { id: 'claude-test', display_name: 'Test' },
    context_window: { current_usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 40 },
      context_window_size: 1000, used_percentage: 10 }, prompt_cache: { warm: true, expires_at: 2000000000 } };
  assert.equal(context.statusLine(data).tokens, 100);
  assert.equal(context.statusLine(data).exact, true);
  assert.equal(context.statusLine({ ...data, context_window: { current_usage: null } }).status, 'pending');
  assert.equal(collect({ ...data, session_id: '../escape' }, dir), null);
  assert.equal(collect({ ...data, transcript_path: '/x/subagents/a.jsonl' }, dir), null);

  const configDir = path.join(dir, 'profile'), project = path.join(dir, 'project');
  fs.mkdirSync(configDir); fs.mkdirSync(project);
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const display = path.join(dir, 'display.js');
    fs.writeFileSync(display, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write('ORIGINAL:'+JSON.parse(s).session_id));");
    const original = { statusLine: { type: 'command', command: `node "${display.replace(/\\/g, '/')}"`, padding: 2 } };
    const settingsPath = path.join(configDir, 'settings.json');
    const text = JSON.stringify(original); fs.writeFileSync(settingsPath, text);
    const args = launchSettings(dir, project, dir);
    assert.equal(args[0], '--settings');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), text, 'user settings are unchanged');
    const settings = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    assert.equal(settings.statusLine.padding, 2);
    let output;
    if (process.platform === 'win32') {
      const encoded = settings.statusLine.command.split(' ').at(-1);
      output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { input: JSON.stringify(data), encoding: 'utf8', windowsHide: true });
    } else output = execFileSync('/bin/sh', ['-c', settings.statusLine.command], { input: JSON.stringify(data), encoding: 'utf8' });
    assert.equal(output, 'ORIGINAL:fixture-session');
    assert.equal(readSnapshots(dir).get('Claude:fixture-session').tokens, 100);
    // Old snapshots and launch files are pruned; recent ones (including the files of this launch) stay.
    const stale = path.join(dir, 'claude-context', 'sessions', 'stale-session.json');
    fs.writeFileSync(stale, JSON.stringify({ sessionId: 'stale-session', context: { source: 'claude-statusline', at: 1 } }));
    const old = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(stale, old, old);
    prune(dir);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(readSnapshots(dir).get('Claude:fixture-session').tokens, 100);
    assert.ok(fs.existsSync(args[1]), 'the settings file of this launch stays');
    // A newly cloned project's status line is discovered at invocation time.
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo PROJECT_DISPLAY' } }));
    const meta = fs.readdirSync(path.join(dir, 'claude-context')).find(n => n.startsWith('launch-'));
    const refreshed = execFileSync(process.execPath, [path.resolve('src/host/claude-context-collector.js'), path.join(dir, 'claude-context', meta)], { input: JSON.stringify(data), encoding: 'utf8', windowsHide: true });
    assert.equal(refreshed.trim(), 'PROJECT_DISPLAY');
    fs.unlinkSync(path.join(project, '.claude/settings.json'));
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: null }));
    assert.deepEqual(launchSettings(dir, project, dir), []);
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
  }

  const catalog = parseModels(JSON.stringify({ data: [{ providerID: 'provider', id: 'model', limit: { context: 500000 }, settings: { apiKey: 'secret' } }] }));
  assert.equal(catalog['provider/model'].context, 500000);
  assert.ok(!JSON.stringify(catalog).includes('secret'));
  let calls = 0, clock = 0;
  const limits = createModelLimits({ now: () => clock, read: async cwd => { calls++; return { 'provider/model': { context: cwd === 'a' ? 500000 : 100000 } }; } });
  const inputs = ['a', 'b'].map(cwd => ({ key: 'OpenCode:' + cwd, cwd, context: root }));
  assert.deepEqual((await limits.enrich(inputs)).map(s => s.context.window), [500000, 100000]);
  await limits.enrich(inputs); assert.equal(calls, 2);
  clock = 300001; await limits.enrich(inputs); assert.equal(calls, 4);
  const unavailable = createModelLimits({ read: async () => { throw Error('offline'); } });
  assert.equal((await unavailable.enrich(inputs))[0].context.window, 0);

  // Real worker + SQLite + persisted cache: no CLIs or real account data involved.
  const dbPath = path.join(dir, 'test.db'), db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session_v2(id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('root', null, project, 'Root', 1, 200);
  db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run('child', 'root', project, 'Child', 1, 200);
  for (const [sid, input, at] of [['root', 50000, 100], ['child', 1000, 200]]) {
    const r = row(sid, input); db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(sid, sid, 'assistant', at, at, at, r.data);
  }
  const worker = new Worker(path.resolve('src/host/usage-worker.js'), { env: { ...process.env, PATH: '' },
    workerData: { cacheFile: path.join(dir, 'worker-cache.json'), claudeDir: path.join(dir, 'none'), codexDir: path.join(dir, 'none2'), openCodeDb: dbPath } });
  const ask = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Worker timeout')), 10000);
    worker.once('message', m => { clearTimeout(timer); m.type === 'error' ? reject(Error(m.message)) : resolve(m); });
    worker.postMessage({ type });
  });
  try {
    const result = (await ask('scan')).summary;
    assert.equal(result.sessions[0].context.tokens, 50010);
    db.prepare("UPDATE session_message SET data=?,time_updated=250 WHERE id='root'").run(row('root', 50000, { content: [{ type: 'text', text: 'Visible answer' }, { type: 'reasoning', text: 'Hidden' }], finish: 'stop' }).data);
    db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run('user', 'root', 'user', 1, 1, 1, JSON.stringify({ text: 'First question', time: { created: 1 } }));
    const preview = await require('../src/host/session-preview').preview({ agent: 'OpenCode', id: 'root' }, { openCodeDb: dbPath });
    assert.ok(JSON.stringify(preview).includes('Visible answer'));
    assert.ok(JSON.stringify(preview).includes('First question'));
    assert.ok(!JSON.stringify(preview).includes('Hidden'));
    db.prepare("UPDATE session_message SET type='compaction',data=?,time_updated=300 WHERE id=?").run(JSON.stringify({ status: 'completed' }), 'root');
    assert.equal((await ask('scan')).summary.sessions[0].context.status, 'pending');
    db.prepare('DELETE FROM session_message WHERE id=?').run('root');
    assert.equal((await ask('scan')).summary.sessions[0].context, null, 'deleted root snapshot must not survive or use the child');
    await ask('flush');
  } finally { await worker.terminate(); db.close(); }

  const ui = vm.createContext({ setInterval() {}, t: (k, p) => k + JSON.stringify(p || {}),
    I18N: { formatNumber: (n, opts) => opts?.style === 'percent' ? Math.round(n * 100) + '%' : String(n), formatTime: String },
    esc: String, sessionKey: s => `${s.agent}:${s.id}` });
  vm.runInContext(fs.readFileSync('src/usage-ui.js', 'utf8'), ui);
  assert.equal(vm.runInContext('getContextState({tokens:1000,window:0,warmUntil:Date.now()+10000})', ui), 'neutral');
  assert.equal(vm.runInContext('getContextFill({tokens:null,window:1000,status:"pending"})', ui), null);
  assert.equal(vm.runInContext('getFillText({tokens:1200,window:1000,exact:true})', ui), '120%');
  vm.runInContext('setUsage({rows:[],sessions:[{key:"Claude:zero",context:{tokens:0,window:1000,exact:true,status:"reported"}}]})', ui);
  assert.ok(vm.runInContext('getContextChip({agent:"Claude",id:"zero"})', ui).includes('context.labelFill'));
  vm.runInContext('setUsage({rows:[],sessions:[{key:"Codex:pending",context:{tokens:null,status:"pending"}}]})', ui);
  assert.ok(vm.runInContext('getContextChip({agent:"Codex",id:"pending"})', ui).includes('context.pending'));
  console.log('Context: accounting isolation, compaction, model switches, statusLine preservation, limits, worker and UI OK');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  // Only the unique temporary fixture directory created by this test is removed.
  fs.rmSync(dir, { recursive: true, force: true });
});
