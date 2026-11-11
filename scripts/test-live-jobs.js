// Claude Code's background jobs in the live registry (live.js): a job's process is folded into the interactive session
// that parked it, a spare process is left out, and an orphaned job stays a session of its own.
const assert = require("node:assert/strict");
const { foldJobs, leadingEntry, getStatus } = require("../src/host/live");

// As ~/.claude/sessions/<pid>.json on 2026-11-09 (Claude Code 2.1.317): the interactive session, the bg process
// running its parked turn (a fork with a sessionId of its own) and the spare kept ready.
const parent = { pid: 29160, sessionId: "5f8530f3-fa42", kind: "interactive", status: "idle", statusUpdatedAt: 10, parkedJobId: "c6ab038e" };
const job = { pid: 13724, sessionId: "c6ab038e-3f00", kind: "bg", status: "shell", statusUpdatedAt: 20, jobId: "c6ab038e", name: "Вълна 4.3" };
const spare = { pid: 35208, sessionId: "3c86e3e6-51be", kind: "bg", status: "idle", jobId: "3c86e3e6", spare: true };
const other = { pid: 1, sessionId: "aaaa", kind: "interactive", status: "waiting" };

const folded = foldJobs([parent, job, spare, other]);
assert.deepEqual(folded.map(x => x.sessionId), ["5f8530f3-fa42", "aaaa"], "one entry per session the user started; no spare");
assert.deepEqual(folded[0].jobs.map(j => j.sessionId), ["c6ab038e-3f00"]);
assert.equal(folded[1].jobs.length, 0);

// The working job shows as the parent's state; a parent that waits on the user wins over a working job.
assert.equal(leadingEntry(folded[0]).status, "shell");
assert.equal(leadingEntry({ ...folded[0], status: "waiting" }).status, "waiting");
assert.equal(leadingEntry({ ...folded[0], jobs: [] }).status, "idle");

// "shell": the session waits for the user with a background shell running - idle; a job's "shell" is its work - busy.
assert.equal(getStatus(job), "busy");
assert.equal(getStatus({ ...parent, status: "shell" }), "idle");
assert.equal(getStatus({ pid: 3, sessionId: "cccc", status: "shell" }), "idle", "older Claude Code, no kind");
assert.equal(leadingEntry({ ...folded[0], status: "shell" }).status, "shell", "the working job leads over an idle session");
assert.equal(getStatus(leadingEntry({ ...folded[0], status: "shell", jobs: [] })), "idle");

// A job whose parent exited is still running work: it stays, as itself.
const orphan = foldJobs([job, spare]);
assert.deepEqual(orphan.map(x => x.sessionId), ["c6ab038e-3f00"]);
assert.deepEqual(orphan[0].jobs, []);

// Entries without the new fields (older Claude Code) pass through unchanged.
const plain = { pid: 2, sessionId: "bbbb", status: "busy" };
assert.deepEqual(foldJobs([plain]), [{ ...plain, jobs: [] }]);

console.log("Live registry: background jobs folded into their session, spares dropped, orphans kept OK");
