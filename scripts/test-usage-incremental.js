// The usage worker (src/host/usage-worker.js) against folders of its own: a pass looks only at the transcripts that
// changed, a pass with nothing new reads and writes nothing, and the cache on disk (usage-cache.js: a base and a
// journal) gives the same figures back after a restart - also with a journal cut short, one left over from an
// older base, a base of the previous format and one that cannot be read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-usage-'));
const claudeDir = path.join(dir, 'claude', 'projects'), codexDir = path.join(dir, 'codex', 'sessions');
const dataDir = path.join(dir, 'data'), snapshotDir = path.join(dataDir, 'claude-context', 'sessions');
const cacheFile = path.join(dataDir, 'usage-cache.json'), journalFile = path.join(dataDir, 'usage-cache.journal');
const stamp = n => new Date(1700000000000 + n * 1000).toISOString();
let serial = 0;
// One reply of a Claude Code session; every one is a message of its own.
const reply = (input, output, extra = {}) => JSON.stringify({ type: 'assistant', timestamp: stamp(++serial), requestId: `r${serial}`, cwd: '/work/project',
  message: { id: `m${serial}`, model: 'claude-sonnet-4-6', usage: { input_tokens: input, output_tokens: output } }, ...extra }) + '\n';
// Codex reports running totals.
const codexHead = id => JSON.stringify({ type: 'session_meta', timestamp: stamp(++serial), payload: { id, cwd: '/work/project' } }) + '\n'
  + JSON.stringify({ type: 'turn_context', timestamp: stamp(++serial), payload: { model: 'gpt-5' } }) + '\n';
const codexTotal = (input, output) => JSON.stringify({ type: 'event_msg', timestamp: stamp(++serial), payload: { type: 'token_count',
  info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } } }) + '\n';
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const snapshot = (id, tokens, at) => put(path.join(snapshotDir, `${id}.json`),
  JSON.stringify({ sessionId: id, context: { source: 'claude-statusline', at, tokens, window: 200000 } }));
const totals = s => s.rows.reduce((sum, r) => ({ input: sum.input + r[3], output: sum.output + r[4], replies: sum.replies + r[8] }), { input: 0, output: 0, replies: 0 });
const figures = s => ({ models: s.models, sessions: s.sessions, rows: s.rows, version: s.version });
const fileState = file => { try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}:${fs.readFileSync(file, 'utf8')}`; } catch { return null; } };
const journalLines = () => fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const base = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A worker and the figures it last sent (recentMs 0: unless a test says otherwise, only the watchers name files): a pass that found nothing new answers without them, as usage.js expects.
function start(tuning = {}) {
  const worker = new Worker(path.resolve(__dirname, '../src/host/usage-worker.js'), { env: { ...process.env, PATH: '' },
    workerData: { cacheFile, claudeDir, codexDir, openCodeDb: path.join(dir, 'none.db'), tuning: { saveAfterMs: 3600000, recentMs: 0, ...tuning } } });
  let last = null;
  const ask = msg => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Worker timeout')), 20000);
    worker.once('message', m => { clearTimeout(timer); m.type === 'error' ? reject(Error(m.message)) : resolve(m); });
    worker.postMessage(msg);
  });
  async function scan(extra = {}) {
    const m = await ask({ type: 'scan', ...extra });
    if (m.summary) last = m.summary;
    else assert.equal(m.same.version, last.version, 'an answer without figures names the ones sent before');
    return { summary: last, stats: (m.summary || m.same).stats, same: !m.summary };
  }
  // The watchers tell of a change a moment after it: passes are asked for until one shows it. Returns that pass and
  // the stats of all of them.
  async function until(what, done) {
    const passes = [];
    for (const deadline = Date.now() + 15000; ;) {
      const r = await scan();
      passes.push(r.stats);
      if (done(r)) return { ...r, passes };
      assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
      await pause(40);
    }
  }
  const quiet = () => until('the watchers to have nothing left', r => r.stats.files === 0);
  const flush = () => ask({ type: 'flush' });
  const stop = async () => { await flush(); await worker.terminate(); };
  return { scan, until, quiet, flush, stop };
}
// A restart: a first pass that must give the figures the last one had, from the cache alone.
async function restarted(expected, what, tuning) {
  const w = start(tuning);
  const r = await w.scan();
  assert.deepEqual(figures(r.summary), expected, what);
  assert.equal(r.stats.read, 0, `${what}: no transcript is read again`);
  assert.equal(r.stats.full, false);
  return w;
}

async function main() {
  const s1 = path.join(claudeDir, 'project-a', 's1.jsonl'), s2 = path.join(claudeDir, 'project-b', 's2.jsonl');
  const sub = path.join(claudeDir, 'project-a', 's1', 'subagents', 'agent-1.jsonl');
  const rollout = path.join(codexDir, '2026', '01', '02', 'rollout-c1.jsonl');
  put(s1, reply(100, 10) + reply(200, 20));
  put(sub, reply(5, 1, { isSidechain: true }));
  put(s2, reply(1000, 100));
  put(rollout, codexHead('c1') + codexTotal(50, 5));
  // Not transcripts: nothing of theirs is counted, whatever the watchers say about them.
  put(path.join(claudeDir, 'project-a', 's1', 'tool-results', 'one.txt'), 'output');
  snapshot('s1', 1234, 1800000000000);

  // ---- first pass: everything is read, and kept as a base ----
  let w = start();
  let r = await w.scan();
  assert.deepEqual(totals(r.summary), { input: 1355, output: 136, replies: 5 });
  assert.deepEqual(r.summary.sessions.map(s => s.key).sort(), ['Claude:s1', 'Claude:s2', 'Codex:c1']);
  assert.equal(r.summary.sessions.find(s => s.key === 'Claude:s1').context.tokens, 1234);
  assert.deepEqual({ files: r.stats.files, read: r.stats.read, walked: r.stats.walked, full: r.stats.full, saved: r.stats.saved },
    { files: 4, read: 4, walked: true, full: true, saved: 'base' });
  assert.ok(base().gen >= 1 && Object.keys(base().files).length === 4);
  assert.equal(fs.existsSync(journalFile), false, 'a first scan leaves no journal');

  // ---- nothing new: no transcript is looked at, the figures are not sent again, nothing is written ----
  const before = fileState(cacheFile);
  r = (await w.quiet());
  r = await w.scan();
  assert.equal(r.same, true);
  assert.deepEqual({ files: r.stats.files, read: r.stats.read, bytes: r.stats.bytes, walked: r.stats.walked, saved: r.stats.saved },
    { files: 0, read: 0, bytes: 0, walked: false, saved: undefined });
  await w.flush();
  assert.equal(fileState(cacheFile), before, 'the base is not rewritten');
  assert.equal(fs.existsSync(journalFile), false);

  // ---- one transcript grows: that file alone is read, and it alone goes to the journal ----
  const more = reply(7, 3);
  fs.appendFileSync(s2, more);
  r = await w.until('the appended reply', x => !x.same);
  assert.deepEqual(totals(r.summary), { input: 1362, output: 139, replies: 6 });
  assert.deepEqual({ files: r.stats.files, read: r.stats.read, bytes: r.stats.bytes, walked: r.stats.walked },
    { files: 1, read: 1, bytes: Buffer.byteLength(more), walked: false });
  assert.ok(r.passes.every(p => p.read === (p === r.stats ? 1 : 0) && !p.walked), 'no other pass read anything');
  await w.flush();
  assert.equal(fileState(cacheFile), before, 'an append leaves the base alone');
  let lines = journalLines();
  assert.deepEqual(lines[0], { v: base().v, gen: base().gen });
  assert.deepEqual(lines.slice(1).map(l => l.f), [s2]);
  assert.equal(lines[1].e.msgs.length, 2);
  const journal = fileState(journalFile);
  await w.quiet();
  await w.flush();
  assert.equal(fileState(journalFile), journal, 'nothing new, nothing appended');

  // ---- context snapshots: only the named ones are read again ----
  snapshot('s1', 4321, 1800000001000);
  r = await w.scan({ snapshots: ['s1.json'] });
  assert.equal(r.summary.sessions.find(s => s.key === 'Claude:s1').context.tokens, 4321);
  assert.equal(r.stats.read, 0);
  snapshot('s1', 5555, 1800000002000);
  r = await w.scan({ snapshots: [] });
  assert.equal(r.summary.sessions.find(s => s.key === 'Claude:s1').context.tokens, 4321, 'a snapshot nobody named is not read');
  // A refresh asked for by hand looks at everything.
  r = await w.scan({ full: true });
  assert.equal(r.summary.sessions.find(s => s.key === 'Claude:s1').context.tokens, 5555);
  assert.deepEqual({ files: r.stats.files, read: r.stats.read, walked: r.stats.walked }, { files: 4, read: 0, walked: true });
  fs.rmSync(path.join(snapshotDir, 's1.json'));
  r = await w.scan({ snapshots: ['s1.json'] });
  assert.equal(r.summary.sessions.find(s => s.key === 'Claude:s1').context.source, 'claude-transcript', 'a removed snapshot is forgotten');

  // ---- new files in new folders ----
  const s3 = path.join(claudeDir, 'project-c', 's3.jsonl'), sub2 = path.join(claudeDir, 'project-b', 's2', 'subagents', 'agent-2.jsonl');
  put(s3, reply(30, 3));
  put(sub2, reply(40, 4, { isSidechain: true }));
  r = await w.until('the new session and the new subagent', x => totals(x.summary).replies === 8);
  assert.deepEqual(totals(r.summary), { input: 1432, output: 146, replies: 8 });
  assert.ok(r.summary.sessions.some(s => s.key === 'Claude:s3'));
  assert.ok(r.passes.every(p => !p.walked), 'found by the watchers, not by a walk');
  fs.appendFileSync(rollout, codexTotal(80, 9));
  r = await w.until('the Codex reply', x => totals(x.summary).replies === 9);
  assert.deepEqual(totals(r.summary), { input: 1462, output: 150, replies: 9 });

  // ---- files that go: one deleted, one folder moved away ----
  fs.rmSync(s3);
  r = await w.until('the deleted session to leave', x => totals(x.summary).replies === 8);
  assert.ok(!r.summary.sessions.some(s => s.key === 'Claude:s3'));
  fs.renameSync(path.join(claudeDir, 'project-a', 's1'), path.join(dir, 'moved-away'));
  r = await w.until('the moved folder to leave', x => totals(x.summary).replies === 7);
  assert.deepEqual(totals(r.summary), { input: 1427, output: 146, replies: 7 });
  assert.ok(r.passes.every(p => !p.walked));
  // A transcript replaced by a shorter one is read from its start.
  fs.writeFileSync(s1, reply(1, 1));
  r = await w.until('the replaced transcript', x => totals(x.summary).replies === 6);
  assert.deepEqual(totals(r.summary), { input: 1128, output: 117, replies: 6 });

  // ---- restart: the base and the journal together give the same figures ----
  await w.quiet();
  let expected = figures(r.summary);
  await w.stop();
  lines = journalLines();
  assert.ok(lines.some(l => l.f === s3 && l.e === null) && lines.some(l => l.f === sub && l.e === null), 'removals are journal lines too');
  assert.equal(fileState(cacheFile), before, 'all of it went to the journal');
  w = await restarted(expected, 'base + journal');
  await w.stop();

  // ---- a journal cut short by a crash: the whole lines count, the next save starts over with a new base ----
  fs.appendFileSync(journalFile, '{"f":"' + JSON.stringify(s2).slice(1, -1) + '","e":{"agent":"Cl');
  w = await restarted(expected, 'a torn journal');
  fs.appendFileSync(s2, reply(2, 2));
  r = await w.until('a reply after the torn journal', x => totals(x.summary).replies === 7);
  expected = figures(r.summary);
  const gen = base().gen;
  await w.stop();
  assert.equal(base().gen, gen + 1, 'the torn journal was folded into a new base');
  assert.equal(fs.existsSync(journalFile), false);
  w = await restarted(expected, 'the base after a torn journal');
  await w.stop();

  // ---- a journal left over from before the base (a crash between the two steps of a compaction) is not applied ----
  fs.writeFileSync(journalFile, JSON.stringify({ v: base().v, gen: base().gen - 1 }) + '\n' + JSON.stringify({ f: s2, e: null }) + '\n');
  w = await restarted(expected, 'an older journal');
  fs.appendFileSync(s2, reply(3, 3));
  r = await w.until('a reply after the older journal', x => totals(x.summary).replies === 8);
  expected = figures(r.summary);
  await w.stop();
  assert.deepEqual(journalLines()[0], { v: base().v, gen: base().gen }, 'the next save replaced it');
  assert.equal(journalLines().length, 2);

  // ---- compaction: a journal past its limit is folded into the base, with the same result ----
  w = await restarted(expected, 'before the compaction', { journalMax: 1 });
  fs.appendFileSync(s2, reply(4, 4));
  r = await w.until('a reply before the compaction', x => totals(x.summary).replies === 9);
  expected = figures(r.summary);
  const compacted = base().gen + 1;
  await w.stop();
  assert.equal(base().gen, compacted);
  assert.equal(fs.existsSync(journalFile), false);
  assert.equal(base().files[s2].msgs.length, 5);
  w = await restarted(expected, 'after the compaction', { flushMax: 0 });
  // Quitting folds a journal that is not small.
  fs.appendFileSync(s2, reply(5, 5));
  r = await w.until('a reply before quitting', x => totals(x.summary).replies === 10);
  await w.flush();
  expected = figures(r.summary);
  await w.stop();
  assert.equal(base().gen, compacted + 1);
  assert.equal(fs.existsSync(journalFile), false);

  // ---- a writer that keeps its file open may cause no event: transcripts in use are looked at anyway ----
  // The watchers say nothing here. s2 changed a moment ago (the cache says so), the Codex one grows while watched.
  const longAgo = new Date(Date.now() - 3600000);
  fs.utimesSync(s1, longAgo, longAgo);
  fs.utimesSync(sub2, longAgo, longAgo);
  w = start({ dropEvents: true, recentMs: 600000 });
  r = await w.scan();
  assert.deepEqual(figures(r.summary), expected);
  fs.appendFileSync(s2, reply(9, 9));
  r = await w.scan();
  assert.equal(totals(r.summary).replies, 11, 'the next pass sees it without an event');
  assert.deepEqual({ files: r.stats.files, read: r.stats.read, walked: r.stats.walked }, { files: 2, read: 1, walked: false }, 'only the files in use are looked at');
  r = await w.scan();
  assert.deepEqual({ same: r.same, files: r.stats.files, read: r.stats.read }, { same: true, files: 2, read: 0 });
  // One idle for longer than that is not looked at: its change waits for a walk.
  fs.appendFileSync(s1, reply(10, 10));
  r = await w.scan();
  assert.deepEqual({ same: r.same, files: r.stats.files }, { same: true, files: 2 });
  r = await w.scan({ full: true });
  assert.equal(totals(r.summary).replies, 12);
  expected = figures(r.summary);
  await w.stop();
  // Once the time is over nothing is looked at any more.
  w = start({ dropEvents: true, recentMs: 2000, flushMax: 0 }); // flushMax: what follows starts from a base alone
  r = await w.scan();
  assert.deepEqual(figures(r.summary), expected);
  fs.appendFileSync(s2, reply(11, 11));
  r = await w.scan({ full: true });
  assert.equal(totals(r.summary).replies, 13);
  fs.appendFileSync(s2, reply(12, 12));
  r = await w.scan();
  assert.deepEqual({ replies: totals(r.summary).replies, read: r.stats.read }, { replies: 14, read: 1 });
  await pause(2300);
  fs.appendFileSync(s2, reply(13, 13));
  r = await w.scan();
  assert.deepEqual({ same: r.same, files: r.stats.files }, { same: true, files: 0 }, 'idle for longer than the window: not looked at');
  r = await w.scan({ full: true });
  assert.equal(totals(r.summary).replies, 15);
  expected = figures(r.summary);
  await w.stop();

  // ---- a base of the format before the journal (no generation): read as it is, replaced by the first save ----
  const old = base();
  delete old.gen;
  fs.writeFileSync(cacheFile, JSON.stringify(old));
  fs.writeFileSync(journalFile, JSON.stringify({ v: old.v, gen: 0 }) + '\n' + JSON.stringify({ f: s2, e: null }) + '\n');
  w = await restarted(expected, 'a base without a generation');
  fs.appendFileSync(s2, reply(6, 6));
  r = await w.until('a reply after the old base', x => totals(x.summary).replies === 16);
  expected = figures(r.summary);
  await w.stop();
  assert.equal(base().gen, 1);
  assert.equal(fs.existsSync(journalFile), false);

  // ---- a cache that cannot be read costs one full scan ----
  fs.writeFileSync(cacheFile, '{"v":');
  w = start();
  r = await w.scan();
  assert.deepEqual(figures(r.summary), expected);
  assert.deepEqual({ read: r.stats.read, full: r.stats.full, saved: r.stats.saved }, { read: 4, full: true, saved: 'base' });
  await w.stop();

  // ---- usage.js, the main process's side: new figures are announced once, the same ones only say when they were checked ----
  const usage = require('../src/host/usage');
  const heard = [];
  const waitFor = async (what, done) => {
    for (const deadline = Date.now() + 15000; !(await done());) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${what}`);
      await pause(40);
    }
  };
  const first = await usage.start({ claudeDir, codexDir, openCodeDb: path.join(dir, 'none.db'), userData: dataDir, onChange: s => heard.push(s.version) });
  assert.deepEqual(figures(first), expected);
  assert.deepEqual(heard, [first.version]);
  const second = await usage.refresh();
  assert.equal(second.version, first.version);
  assert.equal(second.rows, first.rows, 'the figures held are kept');
  assert.equal(second.stats.read, 0);
  assert.ok(second.at >= first.at);
  assert.equal((await usage.refresh({ full: true })).stats.walked, true, 'the Refresh button walks the folders');
  assert.equal(heard.length, 1);
  fs.appendFileSync(s2, reply(8, 8));
  await waitFor('the reply to reach the main process', async () => totals(await usage.refresh()).replies === 17);
  assert.equal(heard.length, 2);
  // A snapshot written by a session: the watcher here names it to the worker.
  snapshot('s2', 777, 1800000003000);
  await waitFor('the snapshot to reach the main process', () => usage.get().sessions.find(x => x.key === 'Claude:s2').context.tokens === 777);
  assert.equal(heard.length, 3);
  await usage.flush();
  console.log('Usage scan: changed files only, idle passes, new and removed files, journal, restart, torn tail, compaction, files in use, main side OK');
}

// usage.js keeps its worker: the process is ended by hand.
main().then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }, e => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
