// #39: the live status is one read that everyone who asks shares (host/shared-read.js), and the read of the Claude
// sessions (host/live.js) waits for the disk nowhere and opens no more than it must.
//
// First the sharing itself, over a reader made here and a clock of its own; then live.js over a home of its own with
// three sessions registered in it (all of them this process, so that they count as running): one whose transcript is
// in its folder's place, with two subagents; one whose transcript is in another folder; one nothing was sent to yet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-live-shared-'));
process.env.HOME = process.env.USERPROFILE = home; // host/live.js reads ~/.claude
const { createSharedRead, KEEP_MS } = require('../src/host/shared-read');
const live = require('../src/host/live');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function sharing() {
  let clock = 1000, reads = 0, gates = [];
  // A read that ends when the test lets it: gates[i](value) or gates[i](null, error).
  const read = () => new Promise((resolve, reject) => { reads++; gates.push((v, e) => e ? reject(e) : resolve(v)); });
  const get = createSharedRead(read, { keepMs: 1000, now: () => clock });
  const settle = () => new Promise(r => setImmediate(r));
  const value = () => [{ id: 'a', subagents: [{ id: 's1' }] }];

  // Five askers at once: one read, and each gets the list.
  const five = [get(), get(), get(), get(), get()];
  await settle();
  assert.equal(reads, 1, 'askers that come together share one read');
  gates[0](value());
  const lists = await Promise.all(five);
  for (const l of lists) assert.deepEqual(l, value());

  // Each a list of its own: what one does to it reaches neither the others nor the kept one.
  assert.notEqual(lists[0], lists[1]);
  lists[0][0].id = 'spoiled'; lists[0][0].subagents.push({ id: 'made up' }); lists[0].push({ id: 'extra' });
  assert.deepEqual(lists[1], value());
  clock += 999;
  assert.deepEqual(await get(), value(), 'the kept answer is as it was read');
  assert.equal(reads, 1, 'within the time an answer is kept: no new read');

  // Past it: one new read, again for all who come together.
  clock += 1;
  const later = [get(), get(), get()];
  await settle();
  assert.equal(reads, 2, 'after the time an answer is kept: one new read');
  gates[1]([{ id: 'b', subagents: [] }]);
  assert.deepEqual((await Promise.all(later)).map(l => l[0].id), ['b', 'b', 'b']);

  // fresh: a new read although the answer is still kept, which those who come after share and which is kept.
  const fresh = get({ fresh: true });
  await settle();
  assert.equal(reads, 3, 'fresh reads anew');
  const joined = get();
  gates[2]([{ id: 'c', subagents: [] }]);
  assert.equal((await fresh)[0].id, 'c');
  assert.equal((await joined)[0].id, 'c');
  assert.equal((await get())[0].id, 'c');
  assert.equal(reads, 3, 'the fresh read answers those who come after it');

  // fresh while a read is under way: that one began before the question, so a new one follows it - one for all who
  // asked for a fresh one meanwhile; whoever is content with the kept answer joins the read under way.
  clock += 5000;
  const old = get();
  await settle();
  assert.equal(reads, 4);
  const f1 = get({ fresh: true }), f2 = get({ fresh: true }), plain = get();
  await settle();
  assert.equal(reads, 4, 'the fresh read waits for the one under way');
  gates[3]([{ id: 'before', subagents: [] }]);
  assert.equal((await old)[0].id, 'before');
  assert.equal((await plain)[0].id, 'before');
  await settle();
  assert.equal(reads, 5, 'one read follows for all who asked for a fresh one');
  gates[4]([{ id: 'after', subagents: [] }]);
  assert.deepEqual([(await f1)[0].id, (await f2)[0].id], ['after', 'after']);

  // A read that fails is told to those who waited for it and is not kept: the next asker reads again.
  clock += 5000;
  const failing = [get(), get()];
  await settle();
  assert.equal(reads, 6);
  gates[5](null, new Error('disk'));
  for (const p of failing) await assert.rejects(p, /disk/);
  const again = get();
  await settle();
  assert.equal(reads, 7, 'a failed read is not kept');
  gates[6]([{ id: 'd', subagents: [] }]);
  assert.equal((await again)[0].id, 'd');
  // ... and a fresh one that waited for a failing read still gets its own.
  clock += 5000;
  const doomed = get();
  await settle();
  const after = get({ fresh: true });
  gates[7](null, new Error('disk'));
  await assert.rejects(doomed, /disk/);
  await settle();
  assert.equal(reads, 9);
  gates[8]([{ id: 'e', subagents: [] }]);
  assert.equal((await after)[0].id, 'e');

  // What the value depends on besides the read (key): a kept answer for another key is not given out.
  let tabs = 't1', keyed = 0;
  const byKey = createSharedRead(async () => `${tabs}#${++keyed}`, { keepMs: 1000, now: () => clock, key: () => tabs });
  assert.equal(await byKey(), 't1#1');
  assert.equal(await byKey(), 't1#1');
  tabs = 't1,t2';
  assert.equal(await byKey(), 't1,t2#2', 'read again when what it depends on changed');

  // A clock set back keeps nothing for ever.
  clock -= 60000;
  assert.equal(await byKey(), 't1,t2#3');
  assert.ok(KEEP_MS > 0 && KEEP_MS < 2000, 'kept for less than the fastest poll (2 s)');
}

async function claudeSessions() {
  const claude = path.join(home, '.claude'), registry = path.join(claude, 'sessions'), projects = path.join(claude, 'projects');
  const cwd = path.join(home, 'work', 'app'), folder = cwd.replace(/[^a-z0-9]/gi, '-');
  const past = new Date(Date.now() - 60000);
  const register = (name, entry) => {
    const file = path.join(registry, name);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, cwd, startedAt: 1, updatedAt: 2, ...entry }));
    fs.utimesSync(file, past, past); // written a while ago, as the file of a session that waits is
    return file;
  };
  fs.mkdirSync(registry, { recursive: true });
  const first = register('101.json', { sessionId: 's-here', status: 'idle' });
  register('102.json', { sessionId: 's-moved', status: 'busy' });
  register('103.json', { sessionId: 's-new', status: 'idle' });
  fs.writeFileSync(path.join(registry, 'notes.json'), '{}'); // not a session's
  const subagents = path.join(projects, folder, 's-here', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  fs.mkdirSync(path.join(projects, 'elsewhere'), { recursive: true });
  for (let i = 0; i < 6; i++) fs.mkdirSync(path.join(projects, `other-${i}`));
  fs.writeFileSync(path.join(projects, folder, 's-here.jsonl'), '{}\n');
  fs.writeFileSync(path.join(projects, 'elsewhere', 's-moved.jsonl'), '{}\n');
  for (const [id, at] of [['agent-old', 5000], ['agent-new', 9000]]) {
    fs.writeFileSync(path.join(subagents, `${id}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(subagents, `${id}.meta.json`), JSON.stringify({ agentType: 'Explore', description: `look at ${id}` }));
    fs.utimesSync(path.join(subagents, `${id}.jsonl`), new Date(at), new Date(at));
  }

  // Every file operation under the home is counted: the asynchronous ones by name, the synchronous ones as a fault.
  const ops = [], sync = [];
  const mine = p => typeof p === 'string' && p.startsWith(home);
  const rel = p => path.relative(claude, p).replace(/\\/g, '/');
  for (const name of ['readdir', 'readFile', 'stat', 'open']) {
    const real = fs.promises[name];
    fs.promises[name] = function (p, ...rest) { if (mine(p)) ops.push(`${name} ${rel(p)}`); return real.call(this, p, ...rest); };
  }
  for (const name of ['readdirSync', 'readFileSync', 'statSync', 'existsSync', 'openSync', 'lstatSync', 'accessSync']) {
    const real = fs[name];
    fs[name] = function (p, ...rest) { if (mine(p)) sync.push(`${name} ${rel(p)}`); return real.call(this, p, ...rest); };
  }
  const count = start => ops.filter(o => o.startsWith(start)).length;
  const round = async opts => { ops.length = 0; return live.liveSessions(opts); };

  // Six askers at once - the windows, the notifier, the tab links, the peers: one read of the registry.
  ops.length = 0;
  const lists = await Promise.all(Array.from({ length: 6 }, () => live.liveSessions()));
  assert.equal(count('readdir sessions'), 1, 'six askers, one listing of the registry');
  assert.equal(count('readFile sessions/'), 3, 'each registry file read once');
  assert.equal(count('readFile') - count('readFile sessions/'), 2, 'each subagent description read once');
  for (const l of lists) assert.deepEqual(l, lists[0]);

  // What it says, as before.
  const [here, moved, fresh] = lists[0];
  const transcriptAt = fs.statSync(path.join(projects, folder, 's-here.jsonl')).mtimeMs;
  assert.deepEqual(here, {
    agent: 'Claude', id: 's-here', pid: process.pid, procStart: '', cwd, name: '', kind: '', jobId: '', status: 'idle',
    hasBackgroundShell: false, waitingFor: '', statusAt: 2, startedAt: 1, activityAt: transcriptAt,
    subagents: [
      { id: 'agent-new', at: 9000, working: false, type: 'Explore', description: 'look at agent-new' },
      { id: 'agent-old', at: 5000, working: false, type: 'Explore', description: 'look at agent-old' }
    ],
    jobs: []
  });
  assert.equal(moved.status, 'busy');
  assert.equal(moved.activityAt, fs.statSync(path.join(projects, 'elsewhere', 's-moved.jsonl')).mtimeMs, 'a transcript in another folder is found');
  assert.deepEqual([fresh.id, fresh.activityAt, fresh.subagents], ['s-new', 0, []], 'no transcript yet: no activity');
  sync.length = 0; // the checks above looked at the files themselves

  // Asked again at once: answered from the read just made, and what a caller did to its list is not in it.
  lists[0][0].status = 'spoiled'; lists[0][0].subagents.length = 0; lists[0].length = 1;
  const kept = await round();
  assert.deepEqual(ops, [], 'no file operation while the answer is kept');
  assert.deepEqual(kept, lists[1]);

  // A fresh read: the registry's listing, a stat a registry file, a transcript and a subagent, the subagents'
  // listing - and nothing opened to be read, as nothing changed. The session without a transcript is not searched
  // for in every folder again so soon.
  const second = await round({ fresh: true });
  assert.deepEqual(second, lists[1]);
  assert.equal(count('readdir sessions'), 1);
  assert.equal(count('readFile'), 0, 'unchanged registry files and known descriptions are not read again');
  assert.equal(count('open'), 0);
  assert.deepEqual(ops.filter(o => o.startsWith('readdir projects')).sort(),
    ['readdir projects/elsewhere/s-moved/subagents', `readdir projects/${folder}/s-here/subagents`].sort(), 'the project folders are not gone through again');
  assert.ok(ops.length <= 12, `a round of three sessions and two subagents: ${ops.length} file operations\n${ops.join('\n')}`);

  // A change of state at the same size ("idle" -> "busy") is seen: by the file's time.
  fs.writeFileSync(first, JSON.stringify({ pid: process.pid, cwd, startedAt: 1, updatedAt: 3, sessionId: 's-here', status: 'busy' }));
  sync.length = 0;
  const third = await round({ fresh: true });
  assert.equal(third[0].status, 'busy');
  assert.equal(third[0].statusAt, 3);
  assert.equal(count('readFile sessions/'), 1, 'only the file that changed is read');
  // Written just now, so it may change again within the same tick of the file system's clock: read once more.
  await round({ fresh: true });
  assert.equal(count('readFile sessions/'), 1);

  // Past the time an answer is kept: one new read.
  await wait(KEEP_MS + 100);
  ops.length = 0;
  await Promise.all([live.liveSessions(), live.liveSessions(), live.liveSessions()]);
  assert.equal(count('readdir sessions'), 1, 'a new read once the kept answer is too old');

  // A session that ended leaves the list; the transcript's place is known without the cwd too.
  assert.deepEqual(sync, [], 'the read waits for the disk nowhere');
  fs.rmSync(path.join(registry, '103.json'));
  sync.length = 0;
  assert.deepEqual((await round({ fresh: true })).map(l => l.id), ['s-here', 's-moved']);
  assert.equal(await live.locateTranscript('s-moved'), path.join(projects, 'elsewhere', 's-moved.jsonl'));
  assert.equal(await live.locateTranscript('s-none', cwd), '');

  assert.deepEqual(sync, [], 'the read waits for the disk nowhere');
}

(async () => {
  try {
    assert.equal(os.homedir(), home);
    await sharing();
    await claudeSessions();
    console.log('Live status: one shared read for all askers, kept briefly, fresh on request, no synchronous file reads OK');
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exit(1); });
