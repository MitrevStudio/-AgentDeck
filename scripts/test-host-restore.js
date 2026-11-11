// A host's terminals after a restart (host/index.js restoreTerminals, docs/SHARED-SESSIONS.md 4.6):
//   * the bounds, with a fake backend: launch.openTerminal refuses past MAX_TERMINALS; restoreTerminals opens the
//     newest first while there is room and drops the rest, skips what the caller brings back itself, drops an entry
//     whose folder is gone, falls back to a shell when a resume cannot be done;
//   * node-pty (when it loads): the registry - detachAll keeps the entries and reports no exit, the next host opens
//     the same ids (a shell, and an "agent" through a fake resumeCommand), marked reopened, with their owner; skip; a
//     folder gone; stopAll leaves nothing to open; the backend's restore() alone opens nothing and keeps the entries;
//   * Windows (DockPty): a terminal whose DockPty was killed opens anew under its id; one still running is attached,
//     not opened twice; an entry whose pid now runs another program is opened anew; one whose pid is a DockPty of
//     another terminal is dropped, never opened a second time.
// Only processes this test started are stopped, on a failure too.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { equipTerminals, terminalEvents } = require("../src/host");
const { createLaunch, MAX_TERMINALS } = require("../src/host/launch");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-host-restore-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = code => e => e.code === code;
const SHELL = process.platform === "win32" ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["bash", "--norc", "--noprofile"];
const backends = []; // every backend made here: stopped at the end, on a failure too
const ourPids = new Set(); // DockPty processes this test started
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const waitFor = async (test, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 50) { if (await test()) return; await sleep(50); }
  throw new Error(`timed out: ${what}`);
};

const sessions = { get: () => ({ sessions: [] }), scan: async () => {} };
// A host as host/index.js equips one, over `module`'s backend; its agents resume through a fake command (the agents
// need not be installed): a shell that says which session it is, or a failure for "s-broken".
function makeHost(dir, module) {
  const host = new EventEmitter();
  const exits = [];
  host.on("terminal:exit", e => exits.push(e));
  const terminals = require(module).createTerminals({ userDataDir: dir, ...terminalEvents(host) });
  backends.push(terminals);
  const launch = createLaunch({ dataDir: dir, terminals, sessions, liveSessions: async () => [], findTranscript: () => "" });
  launch.resumeCommand = (agent, id, cwd) => {
    if (id === "s-broken") throw Object.assign(new Error("Invalid session."), { code: "conversationMissing" });
    const say = `echo resumed-${id}`;
    return {
      command: say, argv: process.platform === "win32" ? [...SHELL, "-NoExit", "-Command", say] : ["bash", "--norc", "--noprofile", "-c", `${say}; exec bash --norc --noprofile`],
      meta: { title: `${agent} ${id}`, agent, sessionId: id }
    };
  };
  equipTerminals(host, { terminals, launch, liveSessions: async () => [] });
  return { host, terminals, launch, exits };
}
const registry = dir => { try { return fs.readdirSync(path.join(dir, "terminals")).filter(f => f.endsWith(".json")).sort(); } catch { return []; } };

// ---------- the bounds, with a fake backend ----------
async function bounds() {
  // launch.openTerminal past MAX_TERMINALS.
  const full = { countRunning: () => MAX_TERMINALS, open: async () => "x", getTabs: () => [] };
  const launch = createLaunch({ dataDir: root, terminals: full, sessions, liveSessions: async () => [], findTranscript: () => "" });
  await assert.rejects(launch.openTerminal(os.tmpdir(), null, {}, process.env, "test"), fails("tooManyTerminals"));
  assert.equal(MAX_TERMINALS, 64);

  // restoreTerminals over 70 dead entries, 3 running already: newest first, room for 61.
  const gone = path.join(root, "gone-folder");
  const dead = Array.from({ length: 70 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, createdAt: 1000 + i,
    meta: { cwd: os.tmpdir(), title: `t${i}`, agent: i === 69 ? "Claude" : i === 68 ? "Claude" : "", sessionId: i === 69 ? "s-1" : i === 68 ? "s-broken" : "", owner: i === 67 ? "peer-x" : "" }
  }));
  dead[66].meta.cwd = gone;          // its folder is gone
  dead[65].meta.cwd = path.join(root, "centre"); // the caller's own
  fs.mkdirSync(dead[65].meta.cwd, { recursive: true });
  const opened = [], forgotten = [];
  let running = 3;
  const fake = {
    restore: async () => ({ attached: ["a"], kept: ["k"], dead }),
    countRunning: () => running,
    open: async o => { opened.push(o); running++; return o.id; },
    forgetEntry: id => forgotten.push(id),
    getTabs: () => [], resize() {}, size: () => null
  };
  const host = new EventEmitter();
  const fl = createLaunch({ dataDir: root, terminals: fake, sessions, liveSessions: async () => [], findTranscript: () => "" });
  fl.resumeCommand = (agent, id) => {
    if (id === "s-broken") throw new Error("no");
    return { command: "resume", argv: ["resume"], meta: { title: "R", agent, sessionId: id } };
  };
  equipTerminals(host, { terminals: fake, launch: fl, liveSessions: async () => [] });
  const r = await host.restoreTerminals({ skip: meta => meta.cwd === dead[65].meta.cwd, env: { X: "1" } });
  assert.deepEqual([r.attached, r.kept], [["a"], ["k"]]);
  const room = MAX_TERMINALS - 3;
  // Of the 70, from the newest: 65 skipped, 66 gone - neither takes room.
  const expected = dead.slice().reverse().filter((_, i) => ![65, 66].includes(69 - i)).slice(0, room).map(x => x.id);
  assert.deepEqual(r.reopened.slice().sort(), expected.slice().sort(), "the newest first, while there is room");
  assert.equal(opened.length, room);
  assert.deepEqual(forgotten.slice().sort(), dead.map(x => x.id).filter(id => !expected.includes(id)).sort(), "the rest are forgotten");
  const byId = id => opened.find(o => o.id === id);
  assert.deepEqual([byId(dead[69].id).agent, byId(dead[69].id).sessionId, byId(dead[69].id).commandLine.includes("EncodedCommand")], ["Claude", "s-1", true], "an agent resumes");
  assert.deepEqual([byId(dead[68].id).agent || "", byId(dead[68].id).sessionId || "", byId(dead[68].id).commandLine], ["", "", "powershell.exe -NoLogo"], "a resume that cannot be done: a shell");
  assert.equal(byId(dead[67].id).owner, "peer-x", "the owner stays");
  assert.ok(opened.every(o => o.reopened === true && o.createdAt >= 1000 && o.env.X === "1"), "reopened, as old as it was, with the caller's env");
  console.log("host restore: bounds, skip, missing folder, resume fallback - passed");
}

// ---------- node-pty ----------
async function nodePty() {
  try { require("node-pty"); } catch { console.log("node-pty does not load here: its registry is not checked"); return; }
  const dir = path.join(root, "pty");
  const work = path.join(root, "pty-work"), centre = path.join(root, "pty-centre"), doomed = path.join(root, "pty-doomed");
  for (const d of [dir, work, centre, doomed]) fs.mkdirSync(d, { recursive: true });
  const env = process.env;

  const a = makeHost(dir, "../src/host/terminals-pty");
  const shell = await a.launch.openTerminal(work, null, { owner: "peer-1" }, env, "test", SHELL);
  const agent = await a.launch.openTerminal(work, "x", { title: "Agent", agent: "Claude", sessionId: "s-7" }, env, "test", SHELL);
  const own = await a.launch.openTerminal(centre, null, {}, env, "test", SHELL);
  const lost = await a.launch.openTerminal(doomed, null, {}, env, "test", SHELL);
  await sleep(500);
  a.terminals.link(agent, "Claude", "s-8", { replace: true }); // /clear: the newest conversation is the one resumed
  await require("../src/shared/atomic-file").flush();
  assert.deepEqual(registry(dir), [shell, agent, own, lost].map(id => `${id}.json`).sort(), "an entry per terminal");
  // The host stops: SIGHUP, entries kept, no exit reported.
  a.terminals.detachAll();
  await sleep(1500);
  assert.deepEqual(a.exits, [], "detachAll reports no exit");
  assert.equal(registry(dir).length, 4, "the entries stay");

  // The next start.
  fs.rmSync(doomed, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  const b = makeHost(dir, "../src/host/terminals-pty");
  const r = await b.host.restoreTerminals({ skip: meta => meta.cwd === centre });
  assert.deepEqual(r.reopened.slice().sort(), [shell, agent].sort(), "the same ids, opened anew");
  await require("../src/shared/atomic-file").flush();
  assert.deepEqual(registry(dir), [shell, agent].map(id => `${id}.json`).sort(), "skipped and folder-less entries go");
  const tabs = b.host.tabs();
  const ts = tabs.find(x => x.id === shell), ta = tabs.find(x => x.id === agent);
  assert.deepEqual([ts.reopened, ts.owner, ts.agent, ts.cwd], [true, "peer-1", "", work]);
  assert.deepEqual([ta.reopened, ta.agent, ta.sessionId], [true, "Claude", "s-8"], "the agent resumed its latest session");
  await waitFor(() => b.terminals.attach(agent).scrollback.includes("resumed-s-8"), "the resume ran");
  assert.deepEqual([ts.viewers, ts.driver], [[], null], "viewers start anew");

  // "Stop all": nothing to open next time.
  b.terminals.stopAll();
  assert.deepEqual(registry(dir), [], "stopAll removes the entries at once");
  const c = makeHost(dir, "../src/host/terminals-pty");
  assert.deepEqual((await c.host.restoreTerminals()).reopened, []);

  // The backend's restore() alone opens nothing: it answers the entries in `dead` and keeps them for restoreTerminals.
  const d = makeHost(dir, "../src/host/terminals-pty");
  const left = await d.launch.openTerminal(work, null, {}, env, "test", SHELL);
  d.terminals.detachAll();
  await require("../src/shared/atomic-file").flush();
  assert.equal(registry(dir).length, 1);
  const e = makeHost(dir, "../src/host/terminals-pty");
  const r2 = await e.terminals.restore();
  assert.deepEqual([r2.attached, r2.kept, r2.dead.map(x => [x.id, x.meta.cwd])], [[], [], [[left, work]]]);
  assert.deepEqual(e.terminals.getTabs(), [], "nothing opened");
  await require("../src/shared/atomic-file").flush();
  assert.deepEqual(registry(dir), [`${left}.json`], "the entry stays for the host to open");
  e.terminals.forgetEntry(left);
  await require("../src/shared/atomic-file").flush();
  assert.deepEqual(registry(dir), []);
  console.log("host restore (node-pty): registry, detachAll, same ids, skip, stopAll, restore() - passed");
}

// ---------- Windows: DockPty ----------
async function dockPty() {
  if (process.platform !== "win32") return;
  const dir = path.join(root, "dock");
  const work = path.join(root, "dock-work");
  for (const d of [dir, work]) fs.mkdirSync(d, { recursive: true });
  const a = makeHost(dir, "../src/host/terminals");
  const killed = await a.launch.openTerminal(work, null, { owner: "peer-1" }, process.env, "test");
  const kept = await a.launch.openTerminal(work, null, {}, process.env, "test");
  for (const t of a.terminals.getTabs()) ourPids.add(t.pid);
  const killedPid = a.terminals.getTabs().find(x => x.id === killed).pid, keptPid = a.terminals.getTabs().find(x => x.id === kept).pid;
  await require("../src/shared/atomic-file").flush();
  // An entry whose pid now runs another program (this node), and one whose pid is the DockPty of another terminal.
  const stranger = "11111111-1111-4111-8111-111111111111", impostor = "22222222-2222-4222-8222-222222222222";
  const entry = (id, pid) => JSON.stringify({ id, pid, token: "0".repeat(32), createdAt: Date.now(), meta: { cwd: work, title: id.slice(0, 4), agent: "", sessionId: "", agentOnly: false, codexLog: "", owner: "" } });
  fs.writeFileSync(path.join(dir, "terminals", `${stranger}.json`), entry(stranger, process.pid));
  fs.writeFileSync(path.join(dir, "terminals", `${impostor}.json`), entry(impostor, keptPid));
  // AgentDeck quits (detachAll); then DockPty of `killed` dies (a reboot, the Task Manager).
  a.terminals.detachAll();
  process.kill(killedPid);
  await waitFor(() => !isAlive(killedPid), "the killed DockPty is gone");
  assert.deepEqual(a.exits, [], "detachAll reports no exit");

  const b = makeHost(dir, "../src/host/terminals");
  const r = await b.host.restoreTerminals();
  for (const t of b.terminals.getTabs()) ourPids.add(t.pid);
  assert.deepEqual(r.attached, [kept], "a running DockPty is attached");
  assert.deepEqual(r.reopened.slice().sort(), [killed, stranger].sort(), "the killed one and the stranger's open anew under their ids");
  assert.ok(!b.terminals.getTabs().some(x => x.id === impostor), "a pid that is another terminal's DockPty is never taken for gone");
  assert.ok(!registry(dir).includes(`${impostor}.json`));
  const t = b.host.tabs().find(x => x.id === killed);
  assert.deepEqual([t.reopened, t.owner, t.exited], [true, "peer-1", false]);
  assert.notEqual(t.pid, killedPid, "a new DockPty");
  assert.equal(b.host.tabs().find(x => x.id === kept).reopened, false);
  b.terminals.input(killed, "echo back-again\r");
  await waitFor(() => b.terminals.attach(killed).scrollback.includes("back-again"), "the reopened terminal works");
  // The command centre (skip) and stopAll: nothing opens next time.
  b.terminals.stopAll();
  await waitFor(() => [...ourPids].every(pid => !isAlive(pid)), "every DockPty of this test ended");
  assert.deepEqual(registry(dir), []);
  const c = makeHost(dir, "../src/host/terminals");
  assert.deepEqual(await c.host.restoreTerminals(), { attached: [], kept: [], reopened: [] });
  console.log("host restore (DockPty): killed -> same id, running -> attached, pid reused -> same id, another DockPty -> dropped, stopAll - passed");
}

(async () => {
  let failed = null;
  try {
    await bounds();
    await nodePty();
    await dockPty();
  } catch (e) {
    failed = e;
  }
  // Stop what this test started, whatever happened.
  for (const t of backends) try { t.stopAll(); } catch {}
  for (const pid of ourPids) if (isAlive(pid)) try { process.kill(pid); } catch {}
  await sleep(1000);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  if (failed) {
    console.error(failed);
    process.exit(1);
  }
  process.exit(0);
})();
