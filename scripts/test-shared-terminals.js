// Shared terminals (mesh/serve.js over host/viewers.js, docs/SHARED-SESSIONS.md 4): nodes in one process - H serves a
// host with real terminals (the platform's backend, and node-pty too when it loads), D1 and D2 are desktop peers, P a
// peer that has asked nothing yet, X a resource host (no control). Checked: D1 and D2 both see every terminal; D2
// attaches to and types into the terminal D1 opened and into the host's own; viewers and driver in "terminals" and
// "terminal.size" to every viewer; a resize frame from a viewer that does not drive is only remembered, the terminal's
// own answers (a replayed query) it sends do not move the size, its input makes it the driver after HOLD; terminals.resize take / release; a link that drops hands the size back; close from
// D2 ends D1's terminal for everyone; a resume of a running session answers `already`; tooManyViewers; frames from a
// peer that made no request, and from one without control, are dropped; "terminal.resync" once a viewer that fell
// behind (a fake links.buffered) has caught up; live.list carries term; sessions.preview as before. No mDNS, no
// Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { equipTerminals, terminalEvents } = require("../src/host");
const { createLaunch } = require("../src/host/launch");
const { createSendText } = require("../src/host/send-text");
const { HOLD_MS, MAX_VIEWERS } = require("../src/host/viewers");
const sessionPreview = require("../src/host/session-preview");
const frames = require("../src/mesh/frames");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-shared-terms-"));
const opened = []; // every scenario's terminals, stopped on a failure too (a DockPty outlives this process)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = (emitter, event, test = () => true, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { emitter.off(event, on); reject(new Error(`no "${event}" within ${ms} ms`)); }, ms);
  const on = data => { if (test(data)) { clearTimeout(timer); emitter.off(event, on); resolve(data); } };
  emitter.on(event, on);
});
const waitFor = async (test, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 50) { if (test()) return; await sleep(50); }
  throw new Error(`timed out: ${what}`);
};
const node = (name, kind = "desktop") => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "node.json"))) fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
  return createLinks({ dir, defaultName: name, kind, version: "test", api: async () => null, discover: false, log: () => {} });
};
const fails = code => e => e.code === code;
const SHELL = process.platform === "win32" ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["bash", "--norc", "--noprofile"];

// A Claude transcript of one prompt and one reply, for sessions.preview.
function writeTranscript(file, id) {
  const at = new Date().toISOString();
  fs.writeFileSync(file, [
    { type: "user", sessionId: id, timestamp: at, message: { role: "user", content: "What is two plus two?" } },
    { type: "assistant", sessionId: id, timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "Four." }], id: "m1", model: "test" } }
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
}

// The host as host/index.js equips it, over the given backend, with a fake live status and sessions.
function makeHost(backend, dir) {
  const host = new EventEmitter();
  const { createTerminals } = require(backend === "dockpty" ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({ userDataDir: dir, ...terminalEvents(host) });
  opened.push(terminals);
  // The live status: s-local runs in the host's own terminal (waits for input unless busy), s-outside elsewhere.
  const state = { busy: false };
  const liveSessions = async () => [
    { agent: "Claude", id: "s-local", status: state.busy ? "busy" : "idle", pid: 1 },
    { agent: "Claude", id: "s-outside", status: "idle", pid: 2 }
  ];
  const transcript = path.join(dir, "s-local.jsonl");
  writeTranscript(transcript, "s-local");
  const sessions = {
    get: () => ({ sessions: [{ agent: "Claude", id: "s-local", file: transcript }] }), scan: async () => {},
    registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} }
  };
  const launch = createLaunch({ dataDir: dir, terminals, sessions, liveSessions, findTranscript: () => "" });
  equipTerminals(host, { terminals, launch, liveSessions });
  Object.assign(host, {
    git: {}, setup: {}, sessions, home: os.homedir(), sendText: createSendText({ terminals, liveSessions }),
    findTranscript: () => "", preview: (s, o) => sessionPreview.preview(s, o)
  });
  return { host, state };
}

async function scenario(backend) {
  const dir = path.join(root, `host-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  const { host, state } = makeHost(backend, dir);
  const { terminals, viewers } = host;
  const served = createServed({ host });

  const h = createLinks({ dir: path.join(root, `H-${backend}`), defaultName: `H-${backend}`, kind: "desktop", version: "test", api: (m, p, peer) => served.api(m, p, peer), discover: false, log: () => {} });
  fs.mkdirSync(path.join(root, `H-${backend}`), { recursive: true });
  fs.writeFileSync(path.join(root, `H-${backend}`, "node.json"), JSON.stringify({ port: 0 }));
  const d1 = node(`D1-${backend}`), d2 = node(`D2-${backend}`), p = node(`P-${backend}`), x = node(`X-${backend}`, "host");
  const selfH = await h.start();
  served.attach(h);
  const peers = { D1: d1, D2: d2, P: p, X: x };
  const self = {};
  for (const [name, l] of Object.entries(peers)) {
    self[name] = await l.start();
    await l.pair("127.0.0.1", selfH.port, h.self().code);
    await sleep(1100); // one pairing per second from one address (pair-guard.js)
  }
  await waitFor(() => Object.values(self).every(s => h.online(s.id)) && Object.values(peers).every(l => l.online(selfH.id)), "every peer linked");
  assert.equal(h.peers().get(self.X.id).control, false, "X is a host: no control");

  // Everything the peers receive.
  const got = { D1: [], D2: [], P: [], X: [] };
  const output = { D1: new Map(), D2: new Map(), P: new Map(), X: new Map() };
  for (const [name, l] of Object.entries(peers)) {
    l.on("event", e => e.node === selfH.id && got[name].push(e));
    l.on("binary", ({ data }) => {
      const f = frames.decode(data);
      if (f?.type === "output") output[name].set(f.id, (output[name].get(f.id) || "") + f.data);
    });
  }
  const waitOutput = (who, id, text) => waitFor(() => (output[who].get(id) || "").includes(text), `${who} sees "${text}" in ${id}: ${JSON.stringify((output[who].get(id) || "").slice(-300))}`);
  const lastEvent = (who, name, test = () => true) => got[who].filter(e => e.name === name && test(e.data)).at(-1)?.data;
  const hostSizes = [];
  host.on("terminal:size", e => hostSizes.push(e));

  // The host's own agent terminal (as the desktop's pane would have it) and one D1 opened.
  // In the temp folder itself: a shell's folder stays busy for a while after it was stopped.
  const open = meta => terminals.open({ cwd: os.tmpdir(), commandLine: SHELL.join(" "), argv: SHELL, title: meta.title, agent: meta.agent || "", sessionId: meta.sessionId || "", agentOnly: Boolean(meta.agent), owner: meta.owner || "", env: process.env });
  const local = await open({ title: "local", agent: "Claude", sessionId: "s-local" });
  const ofD1 = await open({ title: "of D1", owner: self.D1.id });

  // ---- host.info, the lists ----
  assert.equal((await d1.call(selfH.id, "host.info")).terminals, 2, "the capability");
  for (const l of [d1, d2]) {
    const list = await l.call(selfH.id, "terminals.list");
    assert.deepEqual(list.map(t => t.id).sort(), [local, ofD1].sort(), "every peer lists every terminal");
    const t1 = list.find(t => t.id === ofD1), t0 = list.find(t => t.id === local);
    assert.equal(t1.owner, self.D1.id);
    assert.equal(t1.ownerName, `D1-${backend}`, "the opener's name");
    assert.equal(t0.ownerName, "", "the host's own: no owner name");
    assert.deepEqual([t0.viewers, t0.driver, t0.reopened], [[], null, false]);
    for (const k of ["cwd", "title", "exited", "createdAt", "agent", "sessionId", "note", "lost"]) assert.ok(k in t0, `a tab carries ${k}`);
  }
  assert.deepEqual((await d2.call(selfH.id, "terminals.list", { all: true })).map(t => t.id).sort(), [local, ofD1].sort(), "all means nothing");
  const live = await d1.call(selfH.id, "live.list");
  assert.equal(live.find(l => l.id === "s-local").term, local, "live.list: the terminal a session runs in");
  assert.equal(live.find(l => l.id === "s-outside").term, "");

  // ---- the host's window views its terminal; D2 attaches too ----
  viewers.attach(local, "", { kind: "desktop" });
  viewers.want(local, "", 100, 30);
  assert.deepEqual(viewers.state(local), { cols: 100, rows: 30, driver: "", viewers: [""] });
  const evViewers = until(d1, "event", e => e.name === "terminals" && e.data.find(t => t.id === local)?.viewers.length === 2);
  const a2 = await d2.call(selfH.id, "terminals.attach", { id: local });
  assert.deepEqual([a2.cols, a2.rows, a2.driver], [100, 30, selfH.id], "attach answers the size and the driver (the host's window: its node id)");
  assert.equal(typeof a2.scrollback, "string");
  const tabNow = (await evViewers).data.find(t => t.id === local);
  assert.deepEqual(tabNow.viewers, [{ id: selfH.id, name: `H-${backend}`, kind: "desktop" }, { id: self.D2.id, name: `D2-${backend}`, kind: "desktop" }], "viewers with names, to a peer that is not one");
  assert.equal(tabNow.driver, selfH.id);

  // A resize frame from D2 (it does not drive): only remembered.
  d2.sendBinary(selfH.id, frames.encodeResize(local, 80, 24));
  await sleep(300);
  assert.deepEqual([viewers.state(local).cols, viewers.state(local).driver], [100, ""], "a want from a viewer that does not drive changes nothing");
  // D2's xterm.js answers the questions it replays from the scrollback it was just sent (ConPTY's cursor query first):
  // written to the terminal, but no one's typing - the host's window never typed, so a keystroke would take the size.
  const typedAt = terminals.getLastInputAt(local);
  d2.sendBinary(selfH.id, frames.encodeInput(local, "\x1b[1;1R\x1b[?1;2c"));
  d2.sendBinary(selfH.id, frames.encodeInput(local, "\x1b[I"));
  await sleep(300);
  assert.deepEqual([viewers.state(local).cols, viewers.state(local).driver], [100, ""], "a replayed query's answer does not move the size");
  assert.equal(terminals.getLastInputAt(local), typedAt, "nor counts as typed");
  // The host's window typed just now: D2's input within HOLD keeps the driver, after HOLD it takes over.
  viewers.input(local, "");
  d2.sendBinary(selfH.id, frames.encodeInput(local, "echo d2-was-here\r"));
  await waitOutput("D2", local, "d2-was-here");
  assert.equal(viewers.state(local).driver, "", "within HOLD");
  await sleep(HOLD_MS + 100);
  const sizeD2 = until(d2, "event", e => e.name === "terminal.size" && e.data.id === local && e.data.cols === 80);
  d2.sendBinary(selfH.id, frames.encodeInput(local, "echo again\r"));
  assert.deepEqual((await sizeD2).data, { id: local, cols: 80, rows: 24, driver: self.D2.id }, "D2 drives: its want applies, every viewer hears");
  assert.deepEqual(hostSizes.at(-1), { id: local, cols: 80, rows: 24, driver: self.D2.id }, "the host hears it too");
  assert.deepEqual(terminals.size(local), { cols: 80, rows: 24 });

  // ---- D2 in D1's terminal; D1 views it too ----
  const a1 = await d1.call(selfH.id, "terminals.attach", { id: ofD1 });
  assert.deepEqual([a1.cols, a1.rows, a1.driver], [120, 32, null]);
  await d2.call(selfH.id, "terminals.attach", { id: ofD1 });
  d2.sendBinary(selfH.id, frames.encodeInput(ofD1, "echo d2-in-d1s\r"));
  await waitOutput("D1", ofD1, "d2-in-d1s");
  await waitOutput("D2", ofD1, "d2-in-d1s");
  assert.ok(!(output.D1.get(local) || ""), "no output of a terminal D1 does not view");
  // terminals.send from a peer that did not open it.
  assert.equal(await d2.call(selfH.id, "terminals.send", { id: local, text: "echo sent-\nby-d2" }), true);
  await waitOutput("D2", local, "sent- by-d2");
  state.busy = true;
  await assert.rejects(d2.call(selfH.id, "terminals.send", { id: local, text: "nope" }), fails("agentNotReady"));
  state.busy = false;
  await assert.rejects(d2.call(selfH.id, "terminals.send", { id: ofD1, text: "x" }), fails("agentNotReady"), "a shell has no session to be ready");
  assert.equal(viewers.state(local).driver, self.D2.id, "terminals.send is no person's input");

  // ---- terminals.resize: take and release ----
  const take = until(d2, "event", e => e.name === "terminal.size" && e.data.id === ofD1 && e.data.cols === 70);
  assert.deepEqual(await d1.call(selfH.id, "terminals.resize", { id: ofD1, cols: 70, rows: 20 }), { cols: 70, rows: 20, driver: self.D1.id });
  assert.deepEqual((await take).data, { id: ofD1, cols: 70, rows: 20, driver: self.D1.id });
  const released = until(d2, "event", e => e.name === "terminal.size" && e.data.id === ofD1 && e.data.driver === null);
  await d1.call(selfH.id, "terminals.resize", { id: ofD1, release: true });
  assert.deepEqual((await released).data, { id: ofD1, cols: 70, rows: 20, driver: null }, "no other want: nobody drives, the size stays");
  for (const bad of [{ cols: 0, rows: 10 }, { cols: 10, rows: 1001 }, { cols: "10", rows: 10 }, {}]) {
    await assert.rejects(d1.call(selfH.id, "terminals.resize", { id: ofD1, ...bad }), fails("invalidData"), JSON.stringify(bad));
  }
  await assert.rejects(d1.call(selfH.id, "terminals.attach", { id: "not-there" }), fails("invalidData"));
  await assert.rejects(d1.call(selfH.id, "terminals.close", { id: 5 }), fails("invalidData"));

  // ---- frames from a peer that asked nothing, and from one without control ----
  p.sendBinary(selfH.id, frames.encodeInput(local, "echo p-was-here\r"));
  x.sendBinary(selfH.id, frames.encodeInput(local, "echo x-was-here\r"));
  x.sendBinary(selfH.id, frames.encodeResize(local, 20, 5));
  await assert.rejects(x.call(selfH.id, "terminals.list"), fails("relayOnly"), "a host may not ask");
  await assert.rejects(x.call(selfH.id, "terminals.attach", { id: local }), fails("relayOnly"));
  x.sendBinary(selfH.id, frames.encodeInput(local, "echo x-again\r"));
  d2.sendBinary(selfH.id, frames.encodeInput(local, "echo marker-after\r"));
  await waitOutput("D2", local, "marker-after");
  const seen = terminals.attach(local).scrollback;
  for (const w of ["p-was-here", "x-was-here", "x-again"]) assert.ok(!seen.includes(w), `dropped: ${w}`);
  assert.deepEqual(terminals.size(local), { cols: 80, rows: 24 }, "X's size frame was dropped");
  assert.ok(!got.X.some(e => e.name === "terminals" || e.name === "terminal.size"), "a host hears nothing of the terminals");
  // P asks once: its frames count from now on.
  await p.call(selfH.id, "terminals.list");
  p.sendBinary(selfH.id, frames.encodeInput(local, "echo p-now\r"));
  await waitOutput("D2", local, "p-now");
  await assert.rejects(p.call(selfH.id, "terminals.resize", { id: ofD1, cols: 50, rows: 10 }), fails("notViewing"), "only a viewer: a code of its own (a take that overtook its attach)");

  // ---- tooManyViewers ----
  for (let i = viewers.state(local).viewers.length; i < MAX_VIEWERS; i++) viewers.attach(local, `fake-${i}`);
  await assert.rejects(d1.call(selfH.id, "terminals.attach", { id: local }), fails("tooManyViewers"));
  for (const who of viewers.state(local).viewers.filter(w => w.startsWith("fake-"))) viewers.detach(local, who);

  // ---- resume of a running session; one running outside ----
  const again = await d1.call(selfH.id, "terminals.open", { cwd: os.tmpdir(), kind: "resume", agent: "Claude", sessionId: "s-local" });
  assert.deepEqual([again.id, again.already], [local, true], "no second resume: the terminal it runs in");
  await assert.rejects(d1.call(selfH.id, "terminals.open", { cwd: os.tmpdir(), kind: "resume", agent: "Claude", sessionId: "s-outside" }), fails("sessionRunningOutside"));
  // force: past that check (this fake has no transcript to resume).
  await assert.rejects(d1.call(selfH.id, "terminals.open", { cwd: os.tmpdir(), kind: "resume", agent: "Claude", sessionId: "s-outside", force: true }), fails("conversationMissing"));
  assert.equal(terminals.getTabs().length, 2, "nothing opened");
  // "Move here" refuses a session in a terminal here.
  await assert.rejects(host.launch.takeOverSession("Claude", "s-local"), fails("sessionRunning"));

  // ---- resync: D1 falls behind on ofD1, then catches up ----
  const realBuffered = h.buffered;
  h.buffered = id => (id === self.D1.id ? 8 * 1024 * 1024 : realBuffered(id));
  const before = (output.D1.get(ofD1) || "").length;
  terminals.input(ofD1, "echo while-behind\r");
  await waitOutput("D2", ofD1, "while-behind");
  await sleep(300);
  assert.ok(!(output.D1.get(ofD1) || "").slice(before).includes("while-behind"), "output to a viewer that is behind is skipped");
  const resync = until(d1, "event", e => e.name === "terminal.resync");
  h.buffered = realBuffered;
  assert.deepEqual((await resync).data, { id: ofD1 }, "told once it caught up");
  const back = await d1.call(selfH.id, "terminals.attach", { id: ofD1 });
  assert.ok(back.scrollback.includes("while-behind"), "the missed output comes from the scrollback");
  terminals.input(ofD1, "echo after-resync\r");
  await waitOutput("D1", ofD1, "after-resync");
  assert.equal(got.D1.filter(e => e.name === "terminal.resync").length, 1, "once");

  // ---- sessions.preview (as before) ----
  const pv = await d2.call(selfH.id, "sessions.preview", { agent: "Claude", id: "s-local" });
  assert.deepEqual(pv.messages.map(m => [m.role, m.text]), [["user", "What is two plus two?"], ["assistant", "Four."]]);
  await assert.rejects(d2.call(selfH.id, "sessions.preview", { agent: "Nobody", id: "s-local" }), fails("invalidSession"));
  await assert.rejects(d2.call(selfH.id, "sessions.preview", { agent: "Claude", id: "a;b" }), fails("invalidSession"));
  await assert.rejects(d2.call(selfH.id, "sessions.preview", { agent: "Claude" }), fails("invalidData"));

  // ---- D2's link drops: the size goes back to the host's window, D2 views nothing ----
  assert.equal(viewers.state(local).driver, self.D2.id);
  const down = until(h, "link", l => !l.up && l.node === self.D2.id);
  d2.stop();
  await down;
  assert.deepEqual(viewers.state(local), { cols: 100, rows: 30, driver: "", viewers: [""] }, "hand-back to the host's window");
  assert.ok(!viewers.state(ofD1).viewers.includes(self.D2.id));
  await waitFor(() => lastEvent("D1", "terminals").find(t => t.id === local).driver === selfH.id, "the others hear the driver");
  // D2 comes back: its frames are not taken until it asks again.
  const d2b = node(`D2-${backend}`);
  await d2b.start();
  await waitFor(() => d2b.online(selfH.id) && h.online(self.D2.id), "D2 back");
  d2b.sendBinary(selfH.id, frames.encodeInput(local, "echo d2-back-early\r"));
  d2b.sendBinary(selfH.id, frames.encodeResize(local, 30, 10));
  await sleep(500);
  assert.ok(!terminals.attach(local).scrollback.includes("d2-back-early"), "a new link starts without frames");

  // ---- close from D2: D1's terminal ends for everyone ----
  const gone = until(d1, "event", e => e.name === "terminals" && !e.data.some(t => t.id === ofD1));
  const goneP = until(p, "event", e => e.name === "terminals" && !e.data.some(t => t.id === ofD1));
  assert.equal(await d2b.call(selfH.id, "terminals.close", { id: ofD1 }), true);
  await gone;
  await goneP;
  assert.equal(viewers.state(ofD1), null, "its viewers went with it");
  d1.sendBinary(selfH.id, frames.encodeInput(ofD1, "x")); // a frame for a terminal that is gone: dropped

  // ---- a peer's new shell; MAX_TERMINALS is launch.js's (test-host-restore.js) ----
  const shell = await d2b.call(selfH.id, "terminals.open", { cwd: os.tmpdir(), kind: "shell" });
  assert.equal(shell.owner, self.D2.id);
  assert.equal(shell.ownerName, `D2-${backend}`);
  assert.deepEqual(shell.viewers, [], "opening does not attach");

  terminals.stopAll();
  d2b.stop(); d1.stop(); p.stop(); x.stop(); h.stop();
  await require("../src/shared/atomic-file").flush?.();
  console.log(`shared terminals (${backend}): all checks passed`);
}

(async () => {
  const backends = process.platform === "win32" ? ["dockpty"] : [];
  try { require("node-pty"); backends.push("node-pty"); } catch { console.log("node-pty does not load here: its backend is not checked"); }
  for (const b of backends) await scenario(b);
  // The stopped shells let go of their folders a moment later (node-pty's console only when this process ends).
  await sleep(1000);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch(async e => {
  console.error(e);
  opened.forEach(t => t.stopAll());
  await sleep(1000);
  process.exit(1);
});
