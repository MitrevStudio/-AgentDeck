// A session whose own turn is over ("idle") while a subagent of it still works counts as working
// (src/shared/live-status.js): in the lists' ranks and groups (common.js) and for the notifier (notify.js), which
// rings when the last subagent stops and not when the turn ends.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { liveStatus, hasWorkingSubagent } = require('../src/shared/live-status');
const { createNotifier, MIN_BUSY_MS } = require('../src/notify');

const sub = working => ({ id: working ? 'a-on' : 'a-off', at: 1, working, type: 'builder', description: '' });
const live = (status, subagents = [], more = {}) => ({ agent: 'Claude', id: 's1', cwd: 'C:/work/demo', pid: 100, status, subagents, ...more });

// ---------- the helper ----------
assert.equal(liveStatus(live('idle')), 'idle');
assert.equal(liveStatus(live('idle', [sub(false)])), 'idle', 'a subagent that stopped does not keep it working');
assert.equal(liveStatus(live('idle', [sub(false), sub(true)])), 'busy', 'one working subagent is enough');
assert.equal(liveStatus(live('busy', [sub(true)])), 'busy');
assert.equal(liveStatus(live('waiting', [sub(true)])), 'waiting', 'what needs the user still needs the user');
assert.equal(liveStatus(live('running', [sub(true)])), 'running', 'only idle is overridden');
assert.equal(liveStatus({ agent: 'Codex', id: 'c1', status: 'idle' }), 'idle', 'no subagents at all');
assert.equal(liveStatus({ status: 'idle', subagents: [null, {}] }), 'idle');
assert.equal(liveStatus(null), undefined);
assert.equal(hasWorkingSubagent(live('busy', [sub(true)])), true);
assert.equal(hasWorkingSubagent(live('busy')), false);

// ---------- the lists (common.js, its "live status" part, as the page has it: after the helper's script) ----------
const read = name => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const part = read('common.js').match(/\/\/ -{10} live status -{10}[\s\S]*?(?=\/\/ "running": started)/)[0];
const page = vm.createContext({ window: {}, t: key => key });
vm.runInContext(read('shared/live-status.js'), page);
vm.runInContext(part + '\nglobalThis.api = { getLiveRank, getLiveGroup, getLiveKind, countLiveGroups, isStale };', page);
const { getLiveRank, getLiveGroup, getLiveKind, countLiveGroups, isStale } = page.api;
const now = Date.now();
const fresh = { statusAt: now - 5 * 60 * 1000, activityAt: now - 1000 };
const background = live('idle', [sub(true)], fresh), done = live('idle', [sub(false)], fresh);
assert.equal(getLiveGroup(background), 'busy');
assert.equal(getLiveKind(background), 'busy');
assert.equal(getLiveRank(background), getLiveRank(live('busy', [], fresh)), 'ranked with the working ones');
assert.ok(getLiveRank(background) < getLiveRank(done));
assert.equal(getLiveGroup(done), 'idle');
assert.equal(getLiveGroup(live('waiting', [sub(true)], fresh)), 'waiting');
assert.equal(getLiveRank(live('waiting', [sub(true)], fresh)), 0, 'waiting stays first');
assert.deepEqual({ ...countLiveGroups([background, done, live('waiting', [sub(true)], fresh), live('busy', [], fresh)]) }, { busy: 2, waiting: 1, idle: 1 });
// Its turn ended long ago, its subagent wrote a moment ago (activityAt counts the subagents' writes, host/live.js).
assert.equal(isStale(live('idle', [sub(true)], { statusAt: now - 60 * 60 * 1000, activityAt: now - 1000 })), false);

// ---------- the notifier ----------
(async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    let list = [], balloons = [], changes = 0;
    const notifier = createNotifier({
      liveSessions: async () => list, describe: () => ({ title: 'Demo task', project: 'demo' }),
      balloon: (text, opts) => balloons.push(opts.title), focus: async () => {}, onChange: () => changes++,
      t: (key, vars) => `${key}:${vars.title || vars.project}`, tn: (key, n) => `${key}:${n}`, isEnabled: () => true
    });
    // One poll, as the timer would make it.
    const poll = async (next, after = 0) => {
      clock += after;
      list = next;
      notifier.start();
      await new Promise(resolve => setImmediate(resolve));
      notifier.stop();
    };

    // The turn ends with a subagent still working: nothing rings, however long the turn was.
    await poll([live('busy')]);
    await poll([live('idle', [sub(true)])], MIN_BUSY_MS + 1000);
    assert.deepEqual(balloons, [], 'no "finished" while a subagent works');
    assert.deepEqual(notifier.list(), []);
    await poll([live('idle', [sub(true)])], 60000);
    assert.deepEqual(balloons, []);
    // The last subagent stops: now it is finished.
    await poll([live('idle', [sub(false)])], 3000);
    assert.deepEqual(balloons, ['notify.title:Demo task'], 'rings when the last subagent stopped');
    assert.deepEqual(notifier.list().map(w => w.key), ['Claude:s1']);
    await poll([live('idle', [sub(false)])], 3000);
    assert.equal(balloons.length, 1, 'once');

    // A short turn that only starts a subagent: the work is counted from the turn's start, through the subagent's.
    await poll([live('busy')], 3000);
    assert.deepEqual(notifier.list(), [], 'working again: no longer waiting for the user');
    await poll([live('idle', [sub(true)])], 3000);
    await poll([live('idle', [sub(true)])], MIN_BUSY_MS);
    await poll([live('idle', [sub(false)])], 3000);
    assert.equal(balloons.length, 2, 'the subagent\'s time is work');

    // A subagent started by a session seen idle (no turn seen): its end rings too, after real work only.
    await poll([live('idle', [sub(true)])], 3000);
    assert.deepEqual(notifier.list(), []);
    await poll([live('idle', [sub(false)])], 3000);
    assert.equal(balloons.length, 2, 'a few seconds of a subagent do not ring');

    // Blocked on the user rings at once, whatever its subagents do.
    await poll([live('waiting', [sub(true)])], 3000);
    assert.equal(balloons.length, 3, 'waiting is not overridden');

    // As before for a session with no subagents: a long turn rings, a quick reply does not.
    balloons = [];
    await poll([{ ...live('busy'), id: 's2' }], 3000);
    await poll([{ ...live('idle'), id: 's2' }], 3000);
    assert.deepEqual(balloons, []);
    await poll([{ ...live('busy'), id: 's2' }], 3000);
    await poll([{ ...live('idle'), id: 's2' }], MIN_BUSY_MS);
    assert.equal(balloons.length, 1);
    assert.ok(changes > 0);
  } finally { Date.now = realNow; }
  console.log('Live status: idle with a working subagent counts as busy in the lists and for the notifier OK');
})().catch(e => { console.error(e); process.exit(1); });
