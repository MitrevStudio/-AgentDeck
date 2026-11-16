// #42: the Codex log folders under <dataDir>/codex-links (host/codex-link.js prune) stay bounded - those of terminals
// that are gone go by age and by total size, oldest first - and the folder of a terminal the host has, or has saved
// to find again after a restart, is never removed.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { launchIdentity, prune } = require('../src/host/codex-link');

const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR, KB = 1024;

(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdeck-codex-links-'));
  const root = path.join(dataDir, 'codex-links'), now = Date.now();
  // A launch's folder as Codex leaves it: the log and its database, last written `age` ago.
  async function folder(age, bytes = KB) {
    const { codexLog } = launchIdentity(dataDir), dir = path.dirname(codexLog), at = new Date(now - age);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(codexLog, 'x'.repeat(bytes / 2));
    await fs.writeFile(path.join(dir, 'logs_2.sqlite'), 'x'.repeat(bytes / 2));
    for (const file of [codexLog, path.join(dir, 'logs_2.sqlite'), dir]) await fs.utimes(file, at, at);
    return codexLog;
  }
  const name = codexLog => path.basename(path.dirname(codexLog));
  const left = async () => (await fs.readdir(root)).sort();
  const names = (...logs) => logs.map(name).sort();
  try {
    assert.deepEqual(await prune(dataDir), [], 'no folder yet: nothing to do');

    // ----- in use, the grace period, the age -----
    const open = await folder(30 * DAY, 200 * KB);      // a terminal the host has: old and far over the limit
    const saved = await folder(30 * DAY, 200 * KB);     // a terminal saved for the restart, not in the host's list
    const starting = await folder(10 * 60 * 1000, 200 * KB); // just launched, its terminal not listed yet
    const recent = await folder(2 * DAY);
    const old = await folder(8 * DAY);
    // What is not a launch's folder is none of prune's business, however old.
    const other = path.join(root, 'notes'), file = path.join(root, 'readme.txt'), stray = path.join(root, '11111111-1111-4111-8111-111111111111');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'codex-tui.log'), 'x');
    await fs.writeFile(file, 'x');
    await fs.writeFile(stray, 'x'); // named like a folder, but a file
    for (const x of [path.join(other, 'codex-tui.log'), other, file, stray]) await fs.utimes(x, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
    const untouched = ['notes', 'readme.txt', path.basename(stray)];
    await fs.mkdir(path.join(dataDir, 'terminals'));
    await fs.writeFile(path.join(dataDir, 'terminals', '00000000-0000-4000-8000-000000000001.json'),
      JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', pid: 1, token: '0'.repeat(32), createdAt: now, meta: { cwd: dataDir, agent: 'Codex', sessionId: '', codexLog: saved } }));
    await fs.writeFile(path.join(dataDir, 'terminals', 'broken.json'), '{');

    const limits = { inUse: [open, '', undefined], maxBytes: 100 * KB, now };
    assert.deepEqual(await prune(dataDir, limits), names(old), 'idle for longer than the age: gone');
    assert.deepEqual(await left(), [...names(open, saved, starting, recent), ...untouched].sort(),
      'kept: in use (listed or saved) though old and over the limit, just launched, recent; the rest is not looked at');
    assert.deepEqual(await prune(dataDir, limits), [], 'nothing more the second time');

    // ----- the total size, oldest first -----
    const a = await folder(6 * DAY, 40 * KB), b = await folder(5 * DAY, 40 * KB), c = await folder(4 * DAY, 40 * KB), d = await folder(3 * DAY, 40 * KB);
    // recent (1 KB, 2 days) + d + c = 81 KB fit in 100 KB; b and a, the oldest, do not.
    assert.deepEqual((await prune(dataDir, limits)).sort(), names(a, b), 'over the limit: the oldest go until the rest fits');
    assert.deepEqual(await left(), [...names(open, saved, starting, recent, c, d), ...untouched].sort());
    // No room at all and no grace: every folder goes but those in use.
    assert.deepEqual((await prune(dataDir, { ...limits, maxBytes: 0, graceMs: 0 })).sort(), names(starting, recent, c, d));
    assert.deepEqual(await left(), [...names(open, saved), ...untouched].sort(), 'a terminal\'s folder stays whatever the limits');
    assert.equal((await fs.stat(open)).size, 100 * KB, 'and its log is as it was');
    console.log('Codex log folders: in use kept, grace period, age, size limit oldest first, other entries untouched OK');
  } finally {
    // dataDir is the unique temporary fixture directory created above.
    await fs.rm(dataDir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
