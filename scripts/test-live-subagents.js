// Whether a subagent still works (host/live.js isSubagentWorking): told by the mark Claude Code leaves in its
// .meta.json when it ends and by how its transcript ends, not by its last write alone - one that waits for a long
// tool call writes nothing for minutes, one that just answered wrote a moment ago. Over a home of its own, with
// transcripts made up here in the shapes Claude Code writes; and what all this costs a poll.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-live-subagents-'));
process.env.HOME = process.env.USERPROFILE = home; // host/live.js reads ~/.claude
const live = require('../src/host/live');
const { subagentEndOf, SUBAGENT_ACTIVE_MS, SUBAGENT_STALL_MS, SUBAGENT_TAIL_BYTES } = live;

// ---------- the lines a transcript can end in ----------
const line = (type, message, extra = {}) => ({ type, isSidechain: true, agentId: 'a1', uuid: 'u1', timestamp: '2026-01-01T10:00:00.000Z', message, ...extra });
const asks = line('assistant', { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] });
const thinks = line('assistant', { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'the tests first' }] });
const streams = line('assistant', { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'So far' }] });
const answers = line('assistant', { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All 12 tests pass.' }] });
const stops = line('assistant', { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Report: done.' }] });
const result = line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] });
const handsBack = line('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'delivered' }] }, { toolEndsTurn: true });
const prompt = line('user', { role: 'user', content: 'Run the tests and say what fails.' });
const interrupted = line('user', { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] });
const requestLog = { type: 'api-request', id: 'r1', requestId: 'req_1' };

assert.equal(subagentEndOf(asks), 'open', 'a tool was asked for: its result is awaited');
assert.equal(subagentEndOf(thinks), 'open');
assert.equal(subagentEndOf(streams), 'open', 'an answer still coming');
assert.equal(subagentEndOf(result), 'open', "a tool's result: the model's answer is awaited");
assert.equal(subagentEndOf(prompt), 'open', 'just started');
assert.equal(subagentEndOf(requestLog), 'open', 'a line of the request log is no end');
assert.equal(subagentEndOf(answers), 'ended');
assert.equal(subagentEndOf(stops), 'ended');
assert.equal(subagentEndOf(handsBack), 'ended', 'the result of a tool that ends the turn');
assert.equal(subagentEndOf(interrupted), 'ended', 'interrupted by the user');
assert.equal(subagentEndOf(line('user', { role: 'user', content: '[Request interrupted by user for tool use]' })), 'ended');
assert.equal(subagentEndOf({ ...answers, message: { ...answers.message, content: [...answers.message.content, ...asks.message.content] } }), 'open', 'an answer that asks for a tool is not the last');
assert.equal(subagentEndOf(null), 'unknown');
assert.equal(subagentEndOf('text'), 'unknown');

// ---------- the sessions ----------
const claude = path.join(home, '.claude'), registry = path.join(claude, 'sessions'), projects = path.join(claude, 'projects');
const cwd = path.join(home, 'work', 'app'), folder = cwd.replace(/[^a-z0-9]/gi, '-');
const now = Date.now(), SEC = 1000, MIN = 60 * SEC;
const touch = (file, at) => fs.utimesSync(file, new Date(at), new Date(at));
fs.mkdirSync(registry, { recursive: true });
fs.mkdirSync(path.join(projects, folder), { recursive: true });
// Both sessions are this process, so they count as running; "s-main" started hours ago, "s-resumed" five minutes ago.
for (const [name, sessionId, startedAt] of [['101.json', 's-main', now - 300 * MIN], ['102.json', 's-resumed', now - 5 * MIN]]) {
  fs.writeFileSync(path.join(registry, name), JSON.stringify({ pid: process.pid, cwd, startedAt, updatedAt: startedAt, sessionId, status: 'idle' }));
  touch(path.join(registry, name), now - MIN);
  fs.writeFileSync(path.join(projects, folder, `${sessionId}.jsonl`), '{}\n');
  fs.mkdirSync(path.join(projects, folder, sessionId, 'subagents'), { recursive: true });
}
// A subagent: its transcript (the lines given, or the text as it is), last written `ago` ms ago, and its .meta.json
// with `mark` in it, written `metaAgo` ms ago (as it is when the subagent starts: before the transcript's first line).
function subagent(id, lines, ago, { session = 's-main', mark = {}, metaAgo = ago + 10 * MIN } = {}) {
  const dir = path.join(projects, folder, session, 'subagents');
  const file = path.join(dir, `${id}.jsonl`), meta = path.join(dir, `${id}.meta.json`);
  fs.writeFileSync(file, typeof lines === 'string' ? lines : lines.map(l => JSON.stringify(l) + '\n').join(''));
  fs.writeFileSync(meta, JSON.stringify({ agentType: 'builder', description: `Task of ${id}`, toolUseId: 't0', ...mark }));
  touch(file, now - ago);
  touch(meta, now - metaAgo);
  return { file, meta };
}
const text = lines => lines.map(l => JSON.stringify(l) + '\n').join('');
const big = { ...asks, message: { ...asks.message, content: [{ type: 'tool_use', id: 't9', name: 'Write', input: { content: 'x'.repeat(SUBAGENT_TAIL_BYTES + 1000) } }] } };

const cases = {
  // A long tool call, a slow answer: nothing written for minutes, and still working.
  'long-tool': [subagent('long-tool', [prompt, asks], 5 * MIN), true],
  'awaits-answer': [subagent('awaits-answer', [prompt, asks, result], 2 * MIN), true],
  'request-log': [subagent('request-log', [prompt, asks, result, requestLog], 90 * SEC), true],
  'just-started': [subagent('just-started', [prompt], 2 * SEC, { metaAgo: 2 * SEC }), true],
  // Finished: not working although written to a moment ago - by the transcript's end, by the mark, by both.
  'answered': [subagent('answered', [prompt, asks, result, answers], 2 * SEC), false],
  'handed-back': [subagent('handed-back', [prompt, asks, handsBack], 2 * SEC, { mark: { finished: true }, metaAgo: 1 * SEC }), false],
  'marked': [subagent('marked', [prompt, asks, result], 3 * SEC, { mark: { finished: true }, metaAgo: 2 * SEC }), false],
  'marked-early': [subagent('marked-early', [prompt, asks, result], 3 * SEC, { mark: { finished: true }, metaAgo: 3 * SEC + 100 }), false],
  'interrupted': [subagent('interrupted', [prompt, asks, interrupted], 5 * SEC), false],
  'stopped': [subagent('stopped', [prompt, asks], 5 * SEC, { mark: { stoppedByUser: true }, metaAgo: 4 * SEC }), false],
  // Continued after it had finished: the old mark is older than what was written since, and does not count.
  'continued': [subagent('continued', [prompt, answers, prompt, asks], 20 * SEC, { mark: { finished: true }, metaAgo: 4 * MIN }), true],
  // Crashed, or never marked: it ends by itself at the limit.
  'stalled-nearly': [subagent('stalled-nearly', [prompt, asks], SUBAGENT_STALL_MS - MIN), true],
  'stalled': [subagent('stalled', [prompt, asks], SUBAGENT_STALL_MS + SEC), false],
  // The end cannot be read: by the last write, as before.
  'half-line': [subagent('half-line', text([prompt, asks]) + '{"type":"assistant","message":{"role":"assi', 5 * SEC), true],
  'half-line-old': [subagent('half-line-old', text([prompt, asks]) + '{"type":"assistant","message":{"role":"assi', SUBAGENT_ACTIVE_MS + 10 * SEC), false],
  'not-json': [subagent('not-json', text([prompt]) + 'not a line of JSON\n', 5 * SEC), true],
  'not-json-old': [subagent('not-json-old', text([prompt]) + 'not a line of JSON\n', SUBAGENT_ACTIVE_MS + 10 * SEC), false],
  'long-line': [subagent('long-line', [prompt, big], 5 * SEC), true],
  'long-line-old': [subagent('long-line-old', [prompt, big], SUBAGENT_ACTIVE_MS + 10 * SEC), false],
  'empty': [subagent('empty', '', 5 * SEC), true],
  // Of a process that is gone: the session was started again after this one last wrote.
  'before-restart': [subagent('before-restart', [prompt, asks], 8 * MIN, { session: 's-resumed' }), false],
  'after-restart': [subagent('after-restart', [prompt, asks], 3 * MIN, { session: 's-resumed' }), true]
};

(async () => {
  // Every file operation under the home is counted.
  const ops = [];
  const rel = p => path.relative(claude, p).replace(/\\/g, '/');
  for (const name of ['readdir', 'readFile', 'stat', 'open']) {
    const real = fs.promises[name];
    fs.promises[name] = function (p, ...rest) { if (typeof p === 'string' && p.startsWith(home)) ops.push(`${name} ${rel(p)}`); return real.call(this, p, ...rest); };
  }
  const count = start => ops.filter(o => o.startsWith(start)).length;
  const round = async () => { ops.length = 0; return live.liveSessions({ fresh: true }); };
  const subagentsOf = list => new Map(list.flatMap(l => l.subagents).map(a => [a.id, a]));

  const first = subagentsOf(await round());
  assert.equal(first.size, Object.keys(cases).length);
  for (const [id, [, working]] of Object.entries(cases)) assert.equal(first.get(id).working, working, `${id}: ${working ? 'working' : 'not working'}`);
  assert.deepEqual([first.get('marked').type, first.get('marked').description], ['builder', 'Task of marked'], 'the description as before');
  assert.equal(first.get('long-tool').at, fs.statSync(cases['long-tool'][0].file).mtimeMs);
  // Only an end is read, never a whole transcript; and nothing of one past the limit or of a process that is gone.
  assert.equal(count('open '), ops.filter(o => o.startsWith('open ') && o.endsWith('.jsonl')).length);
  assert.equal(count('readFile') - count('readFile sessions/') - ops.filter(o => o.startsWith('readFile') && o.endsWith('.meta.json')).length, 0, 'no transcript is read whole');
  for (const id of ['stalled', 'before-restart']) assert.equal(ops.filter(o => o.startsWith('open ') && o.includes(`/${id}.jsonl`)).length, 0, `${id}: its transcript is not opened`);

  // ---------- what a poll costs ----------
  // Nothing changed: no transcript is opened and no .meta.json read again. One that may still work costs a look at
  // its .meta.json's time besides its transcript's; one that ended, or is past the limit, only its transcript's.
  const second = subagentsOf(await round());
  for (const [id, [, working]] of Object.entries(cases)) assert.equal(second.get(id).working, working, `${id}: the same on the next poll`);
  assert.equal(count('open '), 0, 'an unchanged transcript is not read again');
  assert.equal(count('readFile'), 0, 'nor an unchanged .meta.json, nor the registry');
  const stats = id => ops.filter(o => o.startsWith('stat ') && o.includes(`/subagents/${id}.`)).length;
  assert.equal(stats('long-tool'), 2);
  for (const id of ['answered', 'marked', 'interrupted', 'stalled', 'before-restart']) assert.equal(stats(id), 1, `${id}: one stat`);

  // It goes on: a result came. Only that transcript's end is read again.
  fs.appendFileSync(cases['long-tool'][0].file, JSON.stringify(result) + '\n');
  assert.equal(subagentsOf(await round()).get('long-tool').working, true);
  assert.deepEqual(ops.filter(o => o.startsWith('open ')), [`open projects/${folder}/s-main/subagents/long-tool.jsonl`], 'the changed transcript, and no other');
  // It ends: Claude Code writes the mark. Seen by the .meta.json alone - the transcript, unchanged, is not opened.
  fs.writeFileSync(cases['long-tool'][0].meta, JSON.stringify({ agentType: 'builder', description: 'Task of long-tool', toolUseId: 't0', finished: true }));
  assert.equal(subagentsOf(await round()).get('long-tool').working, false, 'the mark ends it');
  assert.equal(count('open '), 0);
  assert.deepEqual(ops.filter(o => o.startsWith('readFile')), [`readFile projects/${folder}/s-main/subagents/long-tool.meta.json`]);
  await round();
  assert.equal(stats('long-tool'), 1, 'ended: its .meta.json is not looked at any more');
  assert.equal(count('readFile') + count('open '), 0);

  // A subagent whose files went is forgotten, and one that comes is read.
  fs.rmSync(cases['answered'][0].file); fs.rmSync(cases['answered'][0].meta);
  subagent('newcomer', [prompt, asks], 45 * SEC);
  const last = subagentsOf(await round());
  assert.equal(last.has('answered'), false);
  assert.equal(last.get('newcomer').working, true);

  fs.rmSync(home, { recursive: true, force: true });
  console.log(`Live subagents: ${Object.keys(cases).length} transcripts - long tool calls, ends by mark and by transcript, the limit, unreadable ends, and the cost of a poll OK`);
})().catch(e => { console.error(e); process.exit(1); });
