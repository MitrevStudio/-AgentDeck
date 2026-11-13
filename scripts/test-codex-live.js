const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCodexLive } = require('../src/host/codex-live');
const { equipTerminals } = require('../src/host');
const { createLaunch } = require('../src/host/launch');
const { createTabLinks } = require('../src/host/tab-links');

// #31: a terminal started as Codex is an agent for as long as it runs - before its session is known, before the
// first turn (no rollout yet), long after a turn - as one row, which becomes the session's; a shell never is.
async function agentTerminals(dir) {
  const event = (type, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type } });
  const thread = '33333333-3333-4333-8333-333333333333';
  const log = path.join(dir, 'codex-tui.log'), rollout = path.join(dir, 'rollout-thread.jsonl');
  let clock = Date.now(), sessions = [];
  const tab = (id, more = {}) => ({ id, cwd: dir, title: id, agent: '', sessionId: '', agentOnly: false, codexLog: '', pid: 500, exited: false, createdAt: clock - 1000, ...more });
  let tabs = [tab('codex', { agent: 'Codex', agentOnly: true, codexLog: log }), tab('shell'),
    // A shell `claude` was typed into and has left: linked once (tab-links.js), never an agent terminal.
    tab('typed', { agent: 'Claude', sessionId: 'gone' })];
  const terminals = { getTabs: () => tabs.map(x => ({ ...x })), resize() {}, size: () => null,
    link: (id, agent, sessionId) => { tabs = tabs.map(x => (x.id === id ? { ...x, agent, sessionId } : x)); } };
  const codexLive = createCodexLive({ sessions: () => sessions, tabs: terminals.getTabs, link: terminals.link, now: () => clock });
  const host = equipTerminals(new EventEmitter(), { terminals, launch: {}, liveSessions: codexLive });
  const rows = async () => (await host.liveAgents()).map(l => `${l.agent}:${l.id}:${l.status}:${l.term}${l.unlinked ? ':unlinked' : ''}`);

  assert.deepEqual(await rows(), ['Codex:codex:running:codex:unlinked'], 'an agent from its launch, by its terminal while it has no session; no shell is');
  assert.deepEqual(await host.liveSessions(), [], 'a stand-in is no session: nothing acts on it');
  await fs.writeFile(log, `INFO session_loop{thread_id=${thread}}\n`);
  assert.deepEqual(await rows(), [`Codex:${thread}:running:codex`], 'its session known, no rollout before the first turn: the same row, by the session');
  assert.equal(tabs[0].sessionId, thread, 'linked by its log');
  await fs.writeFile(rollout, JSON.stringify({ timestamp: new Date(clock).toISOString(), type: 'session_meta', payload: { id: thread } }) + '\n');
  sessions = [{ agent: 'Codex', id: thread, cwd: dir, file: rollout }];
  assert.deepEqual(await rows(), [`Codex:${thread}:running:codex`], 'a rollout with no turn in it tells no state');
  await fs.appendFile(rollout, event('task_started', clock) + '\n');
  assert.deepEqual(await rows(), [`Codex:${thread}:busy:codex`], 'the first turn: the session itself, one row');
  await fs.appendFile(rollout, event('task_complete', clock + 1000) + '\n');
  clock += 3 * 60 * 60 * 1000;
  assert.deepEqual(await rows(), [`Codex:${thread}:idle:codex`], 'hours after its last turn it is live while its terminal runs');
  // After a restart the terminal is attached again with what its registry kept, before the first scan has the rollout.
  sessions = [];
  assert.deepEqual(await rows(), [`Codex:${thread}:running:codex`], 'known by its terminal alone until the scan is in');
  sessions = [{ agent: 'Codex', id: thread, cwd: dir, file: rollout }];
  tabs.push(tab('again', { agent: 'Codex', agentOnly: true, sessionId: thread }));
  assert.equal((await rows()).length, 1, 'a second terminal on the same session adds no second row');
  tabs.pop();
  tabs[0].exited = true;
  assert.deepEqual(await rows(), [], 'its terminal ended: no agent');
  await fs.unlink(log); await fs.unlink(rollout);
}

// A new Claude session registers a moment after its terminal started: it is linked before the list goes out, so it
// never stands beside the stand-in of its own terminal (and one outside AgentDeck is looked at once, not every time).
async function claudeRegisters(dir) {
  let tabs = [{ id: 'claude', cwd: dir, title: 'Claude', agent: 'Claude', sessionId: '', agentOnly: true, pid: 800, exited: false, createdAt: Date.now() }];
  let live = [{ agent: 'Claude', id: 'outside', pid: 300, cwd: dir, status: 'busy' }], snapshots = 0;
  const terminals = { getTabs: () => tabs.map(x => ({ ...x })), resize() {}, size: () => null,
    link: (id, agent, sessionId) => { tabs = tabs.map(x => (x.id === id ? { ...x, agent, sessionId } : x)); } };
  const liveSessions = async () => live.map(l => ({ ...l }));
  const links = createTabLinks({ terminals, liveSessions, parentMap: async () => { snapshots++; return new Map([[801, 800], [300, 1]]); } });
  const host = equipTerminals(new EventEmitter(), { terminals, launch: {}, liveSessions, linkTabs: links.linkTabs });
  const rows = async () => (await host.liveAgents()).map(l => `${l.id}:${l.status}:${l.term}`);
  assert.deepEqual(await rows(), ['outside:busy:', 'claude:running:claude'], 'starting: its terminal stands in');
  await rows();
  assert.equal(snapshots, 1, 'a session elsewhere is looked at once');
  live.push({ agent: 'Claude', id: 'c1', pid: 801, cwd: dir, status: 'idle' });
  assert.deepEqual(await rows(), ['outside:busy:', 'c1:idle:claude'], 'registered: linked at once, one row');
  assert.equal(snapshots, 2);
  // /clear: a new session in the same process takes the terminal over.
  live = [live[0], { agent: 'Claude', id: 'c2', pid: 801, cwd: dir, status: 'idle' }];
  assert.deepEqual(await rows(), ['outside:busy:', 'c2:idle:claude']);
}

// A session outside AgentDeck's terminals: recent by what is seen written, not by the file's time alone (Codex on
// Windows leaves it at the first write), and its activity is the newest line's.
async function staleFileTime(dir) {
  const file = path.join(dir, 'rollout-outside.jsonl');
  const line = (type, at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type } }) + '\n';
  let clock = Date.now();
  const old = new Date(clock - 60 * 60 * 1000);
  const keepOld = () => fs.utimes(file, old, old);
  const poll = createCodexLive({ sessions: () => [{ agent: 'Codex', id: 'outside', cwd: dir, file }], now: () => clock });
  await fs.writeFile(file, line('task_started', clock - 60 * 60 * 1000)); await keepOld();
  assert.equal((await poll()).length, 0, 'an old rollout nothing was seen written to is left alone');
  await fs.appendFile(file, line('token_count', clock)); await keepOld();
  const [live] = await poll();
  assert.equal(live?.status, 'busy', 'seen to grow: working, whatever the file time says');
  assert.ok(Math.abs(live.activityAt - clock) < 5000, 'the activity is the newest line, not the stale file time');
  clock += 11 * 60 * 1000;
  assert.equal((await poll()).length, 0, 'and it expires once nothing more is written');
  await fs.unlink(file);
}

// A Codex terminal the restart took before its session was linked resumes the session its log names.
async function reopened(dir) {
  const thread = '44444444-4444-4444-8444-444444444444', log = path.join(dir, 'reopen-tui.log');
  await fs.writeFile(log, `INFO session_loop{thread_id=${thread}}\n`);
  const id = n => `00000000-0000-4000-8000-00000000000${n}`;
  const dead = [{ id: id(1), createdAt: 1, meta: { cwd: dir, title: 'Codex', agent: 'Codex', sessionId: '', agentOnly: true, codexLog: log, owner: '' } },
    { id: id(2), createdAt: 2, meta: { cwd: dir, title: 'Codex', agent: 'Codex', sessionId: '', agentOnly: true, codexLog: path.join(dir, 'none.log'), owner: '' } }];
  const opened = [];
  const terminals = { restore: async () => ({ attached: [], kept: [], dead }), countRunning: () => opened.length, open: async o => { opened.push(o); return o.id; },
    forgetEntry() {}, getTabs: () => [], resize() {}, size: () => null };
  const launch = createLaunch({ dataDir: dir, terminals, sessions: { get: () => ({ sessions: [] }) }, liveSessions: async () => [], findTranscript: () => '' });
  await equipTerminals(new EventEmitter(), { terminals, launch, liveSessions: async () => [] }).restoreTerminals({ env: {} });
  const by = n => opened.find(o => o.id === id(n));
  assert.deepEqual([by(1).agent, by(1).sessionId, by(1).agentOnly], ['Codex', thread, true], 'resumed by the session in its log');
  assert.deepEqual([by(2).agent || '', by(2).sessionId || '', by(2).agentOnly], ['', '', false], 'no session to be found: a shell, which no list takes for an agent');
  await fs.unlink(log);
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdeck-codex-live-'));
  const file = path.join(dir, 'rollout.jsonl');
  const session = { agent: 'Codex', id: 'test', cwd: dir, file };
  const event = type => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type } });
  let clock = Date.now(), tabs = [];
  const poll = createCodexLive({ sessions: () => [session], tabs: () => tabs, now: () => clock });
  try {
    await fs.writeFile(file, event('task_started') + '\n');
    assert.equal((await poll())[0].status, 'busy');
    await fs.appendFile(file, JSON.stringify({ type: 'response_item', payload: { type: 'message' } }) + '\n');
    assert.equal((await poll())[0].status, 'busy', 'intermediate output does not end work');
    const end = event('task_complete');
    await fs.appendFile(file, end.slice(0, -3));
    assert.equal((await poll())[0].status, 'busy', 'partial writes are retried');
    await fs.appendFile(file, end.slice(-3) + '\n');
    assert.equal((await poll()).length, 0, 'completed external sessions stop spinning');
    tabs = [{ agent: 'Codex', sessionId: 'test', pid: 123 }];
    assert.equal((await poll())[0].status, 'idle', 'open terminal remains idle after completion');
    await fs.appendFile(file, event('task_started') + '\n');
    assert.equal((await poll())[0].status, 'busy');
    await fs.appendFile(file, event('turn_aborted') + '\n');
    assert.equal((await poll())[0].status, 'idle');
    await fs.writeFile(file, event('task_started') + '\n');
    assert.equal((await poll())[0].status, 'busy', 'truncated rollout is reread');
    clock += 11 * 60 * 1000;
    assert.equal((await poll())[0].status, 'busy', 'owned terminal survives a quiet reasoning period');
    tabs = [];
    assert.equal((await poll()).length, 0, 'old unowned tasks do not spin forever after a crash');
    console.log('Codex start, completion, interruption, partial writes, truncation and orphan expiry OK');
    await fs.unlink(file);
    await agentTerminals(dir);
    await claudeRegisters(dir);
    await staleFileTime(dir);
    await reopened(dir);
    console.log('Codex terminals as agents from launch to end, stale file times and reopening by the log OK');
  } finally {
    // dir is the unique temporary fixture directory created above.
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
