const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { databasePath, readSessions } = require('../src/host/opencode-sessions');
const { createSessions } = require('../src/host/sessions');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-opencode-'));
  const file = path.join(dir, 'opencode.db');
  const previous = process.env.OPENCODE_DB;
  let db, sessions;
  try {
    assert.equal(databasePath(dir, {}), path.join(dir, '.local', 'share', 'opencode', 'opencode.db'));
    assert.equal(databasePath(dir, { XDG_DATA_HOME: dir, OPENCODE_DB: 'custom.db' }), path.join(dir, 'opencode', 'custom.db'));
    assert.equal(databasePath(dir, { OPENCODE_DB: file }), file);
    assert.equal(databasePath(dir, { OPENCODE_DB: ':memory:' }), ':memory:');
    assert.equal(readSessions(file), null);
    assert.equal(fs.existsSync(file), false, 'reading a missing store must not create it');
    const legacyFile = path.join(dir, 'v1.db');
    const legacy = new DatabaseSync(legacyFile);
    legacy.exec('CREATE TABLE session(id TEXT)'); legacy.close();
    assert.throws(() => readSessions(legacyFile), /OpenCode 2 is required/, 'v1 is explicitly unsupported');
    db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_updated INTEGER, parent_id TEXT);
      INSERT INTO session VALUES ('legacy', '/legacy', 'Ignored v1 row', 999, NULL);`);
    assert.deepEqual(readSessions(file), []);
    const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)');
    const a = path.join(dir, 'project-a'), b = path.join(dir, 'project-b');
    fs.mkdirSync(a); fs.mkdirSync(b);
    insert.run('a', a, 'First project', 100, null);
    insert.run('b', b, 'Second project', 200, null);
    insert.run('child', b, 'Subagent', 300, 'b');
    assert.deepEqual(readSessions(file).map(s => s.id), ['b', 'a'], 'read all projects and omit child sessions');
    process.env.OPENCODE_DB = file;
    sessions = createSessions({ dataDir: path.join(dir, 'manager'), home: dir });
    const first = await sessions.scan();
    assert.deepEqual(first.sessions.map(s => s.id), ['b', 'a']);
    assert.equal(first.sessions[0].agent, 'OpenCode');
    assert.equal(first.sessions[0].cwd, b);
    assert.equal(first.sessions[0].updatedAt, 200);
    assert.equal(first.registry.projects.length, 2, 'discover projects without pre-registration');
    db.prepare('UPDATE session_v2 SET title = ? WHERE id = ?').run('Watched title', 'b');
    const deadline = Date.now() + 10000;
    while (sessions.get().sessions[0].title !== 'Watched title' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(sessions.get().sessions[0].title, 'Watched title', 'WAL changes refresh the list automatically');
    db.prepare('UPDATE session_v2 SET title = ?, time_updated = ? WHERE id = ?').run('Updated title', 400, 'a');
    const updated = await sessions.scan({ full: false });
    assert.equal(updated.sessions[0].title, 'Updated title', 'light rescans see committed WAL updates');
    db.exec('DELETE FROM session_v2');
    assert.equal((await sessions.scan({ full: false })).sessions.length, 0, 'empty store clears stale sessions');
    db.close(); db = null;
    assert.throws(() => {
      const ro = new DatabaseSync(file, { readOnly: true });
      try { ro.exec('DROP TABLE session_v2'); } finally { ro.close(); }
    }, /readonly/i);
    fs.writeFileSync(path.join(dir, 'invalid.db'), 'not a database');
    assert.throws(() => readSessions(path.join(dir, 'invalid.db')));
    console.log('OpenCode global discovery, root sessions, paths, WAL updates and deletion OK');
  } finally {
    sessions?.stop();
    db?.close();
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
    // dir is the unique temporary fixture directory created above.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
