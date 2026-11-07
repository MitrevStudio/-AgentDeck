const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createCodexLive } = require('../src/host/codex-live');

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
  } finally {
    await fs.unlink(file);
    await fs.rmdir(dir);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
