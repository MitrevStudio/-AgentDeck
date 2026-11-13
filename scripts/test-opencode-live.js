// #32: OpenCode sessions as agents. The live source (host/opencode-live.js) over a database made here with the
// columns OpenCode 2.2 has - working and ready by the turn times, subagents, sessions outside AgentDeck, older
// databases -; the id a new session is started under (host/opencode-link.js, launch.js); and the host's list
// (host/index.js liveAgents): an OpenCode terminal is one agent row from its launch to its end.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createOpenCodeLive } = require('../src/host/opencode-live');
const { createOpenCodeLink, newSessionId } = require('../src/host/opencode-link');
const { createLaunch } = require('../src/host/launch');
const { createTabLinks } = require('../src/host/tab-links');
const { equipTerminals } = require('../src/host');

const SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const HELP = '  --session, -s string    Session ID to continue, or to create if it does not exist\n';
const OLD_HELP = '  --session, -s string    Session ID to continue\n';

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-opencode-live-'));
  const file = path.join(dir, 'opencode.db'), work = path.join(dir, 'ClinicDesk');
  fs.mkdirSync(work);
  let db;
  try {
    let clock = 1_800_000_000_000, tabs = [];
    const tick = (ms = 1500) => { clock += ms; }; // past what one read is kept for
    const tab = (id, sessionId, more = {}) => ({ id, cwd: work, title: 'OpenCode', agent: 'OpenCode', sessionId, agentOnly: true, pid: 700, exited: false, createdAt: clock, ...more });
    const live = createOpenCodeLive({ dbFile: file, tabs: () => tabs, now: () => clock });
    const terminals = { getTabs: () => tabs.map(x => ({ ...x })), resize() {}, size: () => null };
    const host = equipTerminals(new EventEmitter(), { terminals, launch: {}, liveSessions: live });
    const rows = async () => { tick(); return (await host.liveAgents()).map(l => `${l.id}:${l.status}:${l.term}${l.unlinked ? ':unlinked' : ''}`); };

    // ---------- no database, and one that tells no turn times ----------
    tabs = [tab('t1', 'ses_new')];
    assert.deepEqual(await live(), [], 'no database: nothing to tell');
    assert.equal(fs.existsSync(file), false, 'reading a missing store must not create it');
    assert.deepEqual(await rows(), ['ses_new:running:t1'], 'its terminal is an agent all the same, by the session it was started with');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)');
    db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, ?, ?, ?)').run('ses_new', work, 'Invoices', clock, clock);
    tick();
    assert.deepEqual(await live(), [], 'an OpenCode without turn times: no state is made up');
    assert.deepEqual(await rows(), ['ses_new:running:t1']);
    db.exec('DROP TABLE session_v2');
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_busy INTEGER, time_idle INTEGER, idle_outcome TEXT)`);
    const insert = db.prepare('INSERT INTO session_v2 (id, parent_id, directory, title, agent, time_created, time_updated, time_busy, time_idle, idle_outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const set = (id, fields) => db.prepare(`UPDATE session_v2 SET ${Object.keys(fields).map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fields), id);

    // ---------- a new session: nothing sent, then its turns ----------
    assert.deepEqual(await rows(), ['ses_new:running:t1'], 'nothing sent yet: no session in the store, the terminal stands in');
    insert.run('ses_new', null, work, 'Invoices', 'build', clock, clock, null, null, null);
    assert.deepEqual(await rows(), ['ses_new:running:t1'], 'a session no turn was timed in tells no state');
    set('ses_new', { time_busy: clock, time_updated: clock });
    assert.deepEqual(await rows(), ['ses_new:busy:t1'], 'a turn started: working, the same row');
    const [busy] = await live();
    assert.deepEqual([busy.agent, busy.cwd, busy.pid, busy.statusAt, busy.subagents], ['OpenCode', work, 700, clock - 1500, []]);
    set('ses_new', { time_idle: clock, idle_outcome: 'succeeded', time_updated: clock });
    assert.deepEqual(await rows(), ['ses_new:idle:t1'], 'the turn ended: ready');
    tick(3 * 60 * 60 * 1000);
    assert.deepEqual(await rows(), ['ses_new:idle:t1'], 'hours later it is live while its terminal runs');
    set('ses_new', { time_busy: clock });
    assert.deepEqual(await rows(), ['ses_new:busy:t1'], 'the next turn');
    set('ses_new', { time_idle: clock, idle_outcome: 'interrupted' });
    assert.deepEqual(await rows(), ['ses_new:idle:t1'], 'an end in the same millisecond as its start is an end');

    // ---------- one read answers the askers that come together ----------
    set('ses_new', { time_busy: clock + 1 });
    assert.equal((await live())[0].status, 'idle', 'within a second the last answer stands');
    tick();
    assert.equal((await live())[0].status, 'busy');

    // ---------- subagents ----------
    insert.run('ses_child1', 'ses_new', work, 'Read the schema', 'explorer', clock, clock, clock, null, null);
    insert.run('ses_child2', 'ses_new', work, 'Check the totals', 'general', clock - 5000, clock - 4000, clock - 5000, clock - 4000, 'succeeded');
    tick();
    assert.deepEqual((await live())[0].subagents.map(a => [a.id, a.type, a.description, a.working]),
      [['ses_child1', 'explorer', 'Read the schema', true], ['ses_child2', 'general', 'Check the totals', false]], 'its child sessions, newest first');
    assert.ok(!(await host.liveAgents()).some(l => l.id.startsWith('ses_child')), 'a child session is no agent row of its own');

    // ---------- sessions outside AgentDeck's terminals ----------
    insert.run('ses_outside', null, work, 'Outside', 'build', clock, clock, clock, null, null);
    insert.run('ses_ready', null, work, 'Ready outside', 'build', clock, clock, clock - 1000, clock, 'succeeded');
    insert.run('ses_stuck', null, work, 'Cut off long ago', 'build', clock - 3_600_000, clock - 3_600_000, clock - 3_600_000, null, null);
    tick();
    const outside = (await live()).filter(l => l.id !== 'ses_new');
    assert.deepEqual(outside.map(l => [l.id, l.status, l.pid]), [['ses_outside', 'busy', 0]], 'only one that works and was written to lately');
    assert.equal((await host.liveAgents()).find(l => l.id === 'ses_outside').term, '', 'in no terminal here');

    // ---------- the terminal ends; one with no session at all ----------
    set('ses_new', { time_idle: clock + 10 });
    tabs[0].exited = true;
    assert.deepEqual(await rows(), ['ses_outside:busy:'], 'its terminal ended: the ready session is no agent any more');
    tabs = [tab('t2', '')];
    assert.deepEqual(await rows(), ['ses_outside:busy:', 't2:running:t2:unlinked'], 'started without an id: an agent by its terminal');
    assert.deepEqual((await host.liveSessions()).map(l => l.id), ['ses_outside'], 'a stand-in is no session: nothing acts on it');

    // ---------- never written to ----------
    db.close(); db = null;
    assert.throws(() => {
      const ro = new DatabaseSync(file, { readOnly: true });
      try { ro.exec('DELETE FROM session_v2'); } finally { ro.close(); }
    }, /readonly/i);

    // ---------- the id a new session starts under ----------
    const ids = Array.from({ length: 50 }, () => newSessionId());
    assert.ok(ids.every(id => SESSION_ID.test(id)), 'made as OpenCode makes its own');
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(newSessionId(1_900_000_060_000) < newSessionId(1_900_000_000_000), 'newer sessions sort first');
    let asked = 0;
    const link = createOpenCodeLink({ help: async () => { asked++; return HELP; } });
    assert.deepEqual(link.launchIdentity(), { args: [] }, 'not before the installed OpenCode is known to take one');
    await link.check();
    const given = link.launchIdentity();
    assert.deepEqual([given.args[0], given.args[1], SESSION_ID.test(given.sessionId)], ['--session', given.sessionId, true]);
    assert.equal(asked, 1, 'asked once');
    const old = createOpenCodeLink({ help: async () => OLD_HELP });
    await old.check();
    assert.deepEqual(old.launchIdentity(), { args: [] }, 'an OpenCode that only continues a session gets no id');
    const broken = createOpenCodeLink({ help: async () => { throw new Error('not on PATH'); } });
    await broken.check();
    assert.deepEqual(broken.launchIdentity(), { args: [] });

    // ---------- the launches carry it ----------
    const launch = createLaunch({ dataDir: dir, terminals: { getTabs: () => [] }, openCodeIdentity: link.launchIdentity });
    const fresh = launch.newCommand('OpenCode', work);
    assert.ok(SESSION_ID.test(fresh.meta.sessionId), 'the terminal knows its session from the launch');
    assert.deepEqual(fresh.argv, ['opencode', '--session', fresh.meta.sessionId]);
    assert.ok(fresh.command.includes(`'--session' '${fresh.meta.sessionId}'`));
    const prompted = launch.promptCommand('OpenCode', work, 'List the invoices');
    assert.ok(SESSION_ID.test(prompted.meta.sessionId) && prompted.meta.sessionId !== fresh.meta.sessionId);
    if (process.platform === 'win32') assert.ok(prompted.command.includes(`'--session' '${prompted.meta.sessionId}' '--prompt' $p`));
    else assert.deepEqual(prompted.argv, ['opencode', '--session', prompted.meta.sessionId, '--prompt', 'List the invoices']);
    prompted.undo();
    const cloned = launch.cloneCommand({ url: 'https://example.invalid/clinicdesk.git', dir: 'clinicdesk', agent: 'OpenCode', prompt: 'Start' }, dir);
    assert.ok(cloned.command.includes(`'--session' '${cloned.meta.sessionId}' '--prompt'`) && cloned.argv[2].includes(`'--session' '${cloned.meta.sessionId}' '--prompt'`));
    assert.equal(launch.newCommand('Codex', work).meta.sessionId, undefined, 'only OpenCode is given an id');
    assert.deepEqual(createLaunch({ dataDir: dir, terminals: {} }).newCommand('OpenCode', work).argv, ['opencode'], 'without it, as before');
    // The lists name a terminal without a session by its own id: it is found by that, and a session open in a terminal
    // is not deleted under it.
    const open = [tab('t3', ''), tab('t4', 'ses_open')];
    const guarded = createLaunch({ dataDir: dir, terminals: { getTabs: () => open }, liveSessions: async () => [], sessions: { forget() {} } });
    assert.equal(guarded.runningTab('OpenCode', 't3')?.id, 't3');
    assert.equal(guarded.runningTab('OpenCode', 't4'), null, 'a linked terminal goes by its session only');
    assert.equal(guarded.runningTab('OpenCode', 'ses_open')?.id, 't4');
    await assert.rejects(guarded.deleteSession('OpenCode', 'ses_open', async () => {}), e => e.code === 'sessionRunning');

    // ---------- no process is looked for on its behalf ----------
    let snapshots = 0;
    const links = createTabLinks({ terminals: { getTabs: () => [tab('t5', 'ses_quiet')], link() { throw new Error('linked'); } },
      liveSessions: async () => [{ agent: 'Claude', id: 'elsewhere', pid: 4242 }], parentMap: async () => { snapshots++; return new Map(); } });
    await links.linkTabs();
    assert.equal(snapshots, 0, 'an OpenCode terminal whose session reports nothing yet is not taken for a stale link');

    console.log('OpenCode live status, subagents, outside sessions, launch ids and agent terminals OK');
  } finally {
    db?.close();
    // dir is the unique temporary fixture directory created above.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
