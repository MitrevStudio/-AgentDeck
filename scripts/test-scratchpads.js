// Claude Code's scratchpad folders (src/host/scratchpads.js) on a fixture temp folder: what is counted, which
// session folders count as finished, and that clearing removes those alone - never a running session's, a recently
// written one, anything that is not a session folder, or the target of a link.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScratchpads, defaultRoot } = require('../src/host/scratchpads');

const HOUR = 60 * 60 * 1000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [FINISHED, LIVE, JOB, RECENT, TRANSCRIPT, SUBAGENT, RESUMED, TOUCHED, ALONE, STUCK, AT_ROOT] = Array.from({ length: 11 }, (_, i) => id(i + 1));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-scratchpads-'));
const root = path.join(temp, 'claude'), projects = path.join(temp, 'projects'), outside = path.join(temp, 'outside');
const exists = (...parts) => fs.existsSync(path.join(root, ...parts));

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}
// Everything under a folder, the folder and the links in it included, written three hours ago.
function age(dir) {
  const old = new Date(Date.now() - 3 * HOUR);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) age(file); else fs.lutimesSync(file, old, old);
  }
  fs.utimesSync(dir, old, old);
}

(async () => {
  // A project folder named by its path, with sessions in every state and things that are no session's.
  const project = path.join(root, 'C--work-sample');
  write(path.join(project, FINISHED, 'scratchpad', 'notes.md'), 1000);
  write(path.join(project, FINISHED, 'scratchpad', 'deep', 'er', 'data.bin'), 2000);
  write(path.join(project, FINISHED, 'tasks', 'a1.output'), 500);
  write(path.join(project, FINISHED, 'scratchpad', 'locked.txt'), 100);
  fs.chmodSync(path.join(project, FINISHED, 'scratchpad', 'locked.txt'), 0o444);
  // A junction (a symlink off Windows) out of the scratchpad, as a worktree's node_modules can be.
  write(path.join(outside, 'node_modules', 'keep.txt'), 4000);
  fs.symlinkSync(path.join(outside, 'node_modules'), path.join(project, FINISHED, 'scratchpad', 'node_modules'), 'junction');
  write(path.join(project, LIVE, 'scratchpad', 'a.txt'), 200);
  write(path.join(project, JOB, 'scratchpad', 'a.txt'), 300);
  write(path.join(project, RECENT, 'scratchpad', 'a.txt'), 400);
  write(path.join(project, TRANSCRIPT, 'scratchpad', 'a.txt'), 600);
  write(path.join(project, SUBAGENT, 'scratchpad', 'a.txt'), 700);
  write(path.join(project, RESUMED, 'scratchpad', 'a.txt'), 800);
  write(path.join(project, TOUCHED, 'scratchpad', 'a.txt'), 900);
  write(path.join(project, STUCK, 'scratchpad', 'a.txt'), 150);
  write(path.join(project, 'scratch.log'), 50);
  write(path.join(project, 'not-a-session', 'a.txt'), 60);
  // A project folder named by a hash, with one finished session and nothing else.
  write(path.join(root, '0123456789abcdef', ALONE, 'scratchpad', 'a.txt'), 1100);
  // Not session folders: Claude Code's own things, and a folder named like a session where no session folder is.
  write(path.join(root, 'bundled-skills', '1.0.0', 'abc', 'skill.md'), 80);
  fs.mkdirSync(path.join(root, 'swc-cache'));
  write(path.join(root, 'loose.txt'), 10);
  write(path.join(root, AT_ROOT, 'a.txt'), 90);
  age(root);
  write(path.join(project, RECENT, 'scratchpad', 'new.txt'), 40); // written just now

  // Transcripts: an old one, one written just now, and an old one whose subagent wrote just now.
  for (const session of [FINISHED, TRANSCRIPT, SUBAGENT]) write(path.join(projects, 'C--work-sample', `${session}.jsonl`), 10);
  write(path.join(projects, 'C--work-sample', SUBAGENT, 'subagents', 'agent-1.jsonl'), 10);
  age(projects);
  write(path.join(projects, 'C--work-sample', `${TRANSCRIPT}.jsonl`), 20);
  write(path.join(projects, 'C--work-sample', SUBAGENT, 'subagents', 'agent-1.jsonl'), 20);

  const live = new Set([LIVE, JOB.toUpperCase()]);
  let asked = 0, onAsk = () => {};
  const pads = createScratchpads({
    root, projectsDir: projects,
    liveIds: async () => { asked++; onAsk(); return live; },
    remove: dir => (path.basename(dir) === STUCK ? Promise.reject(new Error('in use')) : fs.promises.rm(dir, { recursive: true, force: true }))
  });

  assert.deepEqual(pads.info(), { supported: true, dir: root });
  const first = await pads.scan();
  assert.equal(first.supported, true);
  // Finished: FINISHED (3600), RESUMED (800), TOUCHED (900), STUCK (150) and ALONE (1100). The link counts as nothing.
  assert.deepEqual(first.finished, { bytes: 3600 + 800 + 900 + 150 + 1100, folders: 5 });
  // Kept: the live session, the live job, the one written to, the two with a fresh transcript.
  assert.deepEqual(first.running, { bytes: 200 + 300 + 440 + 600 + 700, folders: 5 });
  assert.deepEqual(first.total, { bytes: first.finished.bytes + first.running.bytes + 50 + 60 + 80 + 10 + 90, folders: 10 });
  assert.equal(asked, 1);

  // Between the measurement and the removal one session is resumed and another is written to: both stay.
  asked = 0;
  onAsk = () => {
    if (asked !== 2) return; // 1: the measurement; 2: before the first folder goes
    live.add(RESUMED);
    write(path.join(project, TOUCHED, 'scratchpad', 'later.txt'), 5);
  };
  const cleared = await pads.clear();
  assert.deepEqual(cleared, { removed: 2, bytes: 3600 + 1100, failed: 1 });
  assert.ok(asked >= 4, 'the running sessions are read again before each folder goes');

  assert.equal(exists('C--work-sample', FINISHED), false);
  assert.equal(exists('0123456789abcdef'), false, 'a project folder left empty goes too');
  for (const kept of [LIVE, JOB, RECENT, TRANSCRIPT, SUBAGENT, RESUMED, TOUCHED, STUCK]) assert.equal(exists('C--work-sample', kept, 'scratchpad', 'a.txt'), true, kept);
  for (const kept of [['C--work-sample', 'scratch.log'], ['C--work-sample', 'not-a-session', 'a.txt'], ['bundled-skills', '1.0.0', 'abc', 'skill.md'],
    ['swc-cache'], ['loose.txt'], [AT_ROOT, 'a.txt']]) assert.equal(exists(...kept), true, kept.join('/'));
  // The link went, what it pointed to did not.
  assert.equal(fs.readFileSync(path.join(outside, 'node_modules', 'keep.txt')).length, 4000);

  const second = await pads.scan();
  assert.deepEqual(second.finished, { bytes: 150, folders: 1 }); // the one that could not be removed
  assert.equal(second.total.folders, 8);
  assert.deepEqual(await pads.clear(), { removed: 0, bytes: 0, failed: 1 });

  // Two requests at once are one measurement.
  asked = 0;
  await Promise.all([pads.scan(), pads.scan()]);
  assert.equal(asked, 1);

  // No such folder: hidden in Settings, and nothing to clear.
  const none = createScratchpads({ root: path.join(temp, 'missing'), projectsDir: projects, liveIds: () => new Set() });
  assert.deepEqual(none.info(), { supported: false, dir: path.join(temp, 'missing') });
  assert.equal((await none.scan()).supported, false);
  assert.deepEqual(await none.clear(), { removed: 0, bytes: 0, failed: 0 });
  assert.equal((await createScratchpads({ root: '', liveIds: () => new Set() }).scan()).supported, false);

  // Where Claude Code keeps them: <temp>\claude on Windows, <temp>/claude-<uid> elsewhere.
  assert.equal(path.basename(defaultRoot()), process.platform === 'win32' ? 'claude' : `claude-${process.getuid()}`);

  console.log('Scratchpad sizes, finished and running sessions, links kept whole, clearing and its re-checks OK');
})().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
