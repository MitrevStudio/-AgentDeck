// The wide view of a host's terminals (mesh/serve.js, docs/MOBILE.md §6): three nodes in one process - H serves a
// host with real terminals (the platform's backend, and node-pty too when it loads), D is a desktop peer, P a peer
// that asks for every terminal (as the phone will). Checked: D's list, attach, input and events stay its own; P sees
// all terminals, attaches to and types into one it does not own, sends a message (terminals.send), gets the size on
// attach and "terminal.size" on changes; a size P set goes back to the pane that shows the terminal when P lets go
// (detach, link down); sessions.preview answers a session's last messages with checked params. No mDNS, no Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createSendText } = require("../src/host/send-text");
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
const node = (name, api) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "node.json"))) fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
  return createLinks({ dir, defaultName: name, kind: "desktop", version: "test", api, discover: false, log: () => {} });
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

async function scenario(backend) {
  const dir = path.join(root, `host-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  const host = new EventEmitter();
  const { createTerminals } = require(backend === "dockpty" ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({
    userDataDir: dir,
    onData: (id, data, end) => host.emit("terminal:data", { id, data, end }),
    onExit: () => {}, onChange: tabs => host.emit("terminals", tabs),
    onResize: (id, cols, rows) => host.emit("terminal:size", { id, cols, rows })
  });
  opened.push(terminals);
  // The live status the host would read: the session in the shared terminal waits for input unless `busy`.
  let busy = false;
  const liveSessions = async () => [{ agent: "Claude", id: "s-local", status: busy ? "busy" : "idle" }];
  const transcript = path.join(dir, "s-local.jsonl");
  writeTranscript(transcript, "s-local");
  Object.assign(host, {
    terminals, liveSessions, launch: {}, git: {}, setup: {},
    sendText: createSendText({ terminals, liveSessions }),
    sessions: { get: () => ({ sessions: [{ agent: "Claude", id: "s-local", file: transcript }] }), registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } },
    findTranscript: () => "", preview: (s, o) => sessionPreview.preview(s, o)
  });
  const served = createServed({ host });

  const h = node(`H-${backend}`, (method, params, peer) => served.api(method, params, peer));
  const d = node(`D-${backend}`, async () => null);
  const p = node(`P-${backend}`, async () => null);
  const selfH = await h.start();
  const selfD = await d.start(), selfP = await p.start();
  served.attach(h);
  await d.pair("127.0.0.1", selfH.port, h.self().code);
  await until(h, "link", l => l.up && l.node === selfD.id).catch(() => {});
  await sleep(1100);
  await p.pair("127.0.0.1", selfH.port, h.self().code);
  for (let i = 0; i < 100 && !(h.online(selfD.id) && h.online(selfP.id) && d.online(selfH.id) && p.online(selfH.id)); i++) await sleep(100);
  assert.ok(h.online(selfD.id) && h.online(selfP.id), "both peers linked");

  // Everything D and P receive.
  const got = { D: [], P: [] };
  d.on("event", e => e.node === selfH.id && got.D.push(e));
  p.on("event", e => e.node === selfH.id && got.P.push(e));
  const output = { D: new Map(), P: new Map() };
  const collect = (who, links) => links.on("binary", ({ data }) => {
    const f = frames.decode(data);
    if (f?.type === "output") output[who].set(f.id, (output[who].get(f.id) || "") + f.data);
  });
  collect("D", d);
  collect("P", p);
  const waitOutput = async (who, id, text, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) { if ((output[who].get(id) || "").includes(text)) return; await sleep(100); }
    throw new Error(`${who} saw no "${text}" in ${id}: ${JSON.stringify((output[who].get(id) || "").slice(-300))}`);
  };
  const refits = [];
  host.on("terminal:refit", e => refits.push(e.id));

  // The host's own agent terminal (as the desktop's pane would have it) and one D opened.
  // In the temp folder itself: a shell's folder stays busy for a while after it was stopped.
  const open = meta => terminals.open({ cwd: os.tmpdir(), commandLine: SHELL.join(" "), argv: SHELL, title: meta.title, agent: meta.agent || "", sessionId: meta.sessionId || "", agentOnly: Boolean(meta.agent), owner: meta.owner || "", env: process.env });
  const local = await open({ title: "local", agent: "Claude", sessionId: "s-local" });
  const ofD = await open({ title: "of D", owner: selfD.id });

  // ---- a normal peer's view is as before ----
  assert.deepEqual((await d.call(selfH.id, "terminals.list")).map(x => x.id), [ofD], "D lists only its own");
  assert.deepEqual((await d.call(selfH.id, "terminals.list", { all: false })).map(x => x.id), [ofD], "all: false is the narrow list");
  await assert.rejects(d.call(selfH.id, "terminals.attach", { id: local }), fails("invalidData"), "D cannot attach to the host's own");
  await assert.rejects(d.call(selfH.id, "terminals.send", { id: local, text: "x" }), fails("invalidData"), "D cannot send to the host's own");
  await assert.rejects(d.call(selfH.id, "terminals.close", { id: local }), fails("invalidData"));
  const aD = await d.call(selfH.id, "terminals.attach", { id: ofD });
  assert.equal(typeof aD.scrollback, "string");
  assert.deepEqual([aD.cols, aD.rows], [120, 32], "attach answers the size");
  // D's keystrokes for a terminal not its own go nowhere.
  d.sendBinary(selfH.id, frames.encodeInput(local, "echo d-was-here\r"));

  // ---- the wide view ----
  assert.deepEqual((await p.call(selfH.id, "terminals.list")).map(x => x.id), [], "P has none of its own");
  const all = await p.call(selfH.id, "terminals.list", { all: true });
  assert.deepEqual(all.map(x => x.id).sort(), [local, ofD].sort(), "P lists every terminal");
  const mine = all.find(x => x.id === local);
  assert.equal(mine.owner, "");
  assert.equal(mine.agent, "Claude");
  assert.equal(mine.sessionId, "s-local", "matched to its session");
  assert.equal(all.find(x => x.id === ofD).owner, selfD.id);
  for (const k of ["cwd", "title", "exited", "createdAt"]) assert.ok(k in mine, `a tab carries ${k}`);

  // Attach and input to a terminal P does not own.
  const aP = await p.call(selfH.id, "terminals.attach", { id: local });
  assert.deepEqual([aP.cols, aP.rows], [120, 32]);
  p.sendBinary(selfH.id, frames.encodeInput(local, "echo p-was-here\r"));
  await waitOutput("P", local, "p-was-here");
  assert.ok(!(output.D.get(local) || ""), "D gets no output of a terminal it is not attached to");
  assert.ok(!terminals.attach(local).scrollback.includes("d-was-here"), "D's frame for the host's terminal was dropped");

  // The terminals event: the full list to P, D's own to D.
  const evP = until(p, "event", e => e.name === "terminals"), evD = until(d, "event", e => e.name === "terminals");
  terminals.setNote(local, "note");
  assert.deepEqual((await evP).data.map(x => x.id).sort(), [local, ofD].sort());
  assert.deepEqual((await evD).data.map(x => x.id), [ofD]);

  // terminals.send: typed and submitted, refused while the agent works, and on bad params.
  assert.equal(await p.call(selfH.id, "terminals.send", { id: local, text: "echo sent-\nby-p" }), true);
  await waitOutput("P", local, "sent- by-p");
  busy = true;
  await assert.rejects(p.call(selfH.id, "terminals.send", { id: local, text: "nope" }), fails("agentNotReady"));
  busy = false;
  await assert.rejects(p.call(selfH.id, "terminals.send", { id: local, text: "" }), fails("invalidData"));
  await assert.rejects(p.call(selfH.id, "terminals.send", { id: ofD, text: "x" }), fails("agentNotReady"), "a shell has no session to be ready");

  // ---- the size ----
  // The desktop's pane sizes it: P hears it, D (not wide) hears nothing of sizes.
  let size = until(p, "event", e => e.name === "terminal.size");
  terminals.resize(local, 100, 30);
  assert.deepEqual((await size).data, { id: local, cols: 100, rows: 30 });
  assert.deepEqual([(await d.call(selfH.id, "terminals.attach", { id: ofD })).cols], [120]);
  // "Fit to phone": P's resize applies, and P detaching hands the size back to the host's pane.
  size = until(p, "event", e => e.name === "terminal.size" && e.data.cols === 50);
  p.sendBinary(selfH.id, frames.encodeResize(local, 50, 20));
  await size;
  assert.deepEqual([(await p.call(selfH.id, "terminals.attach", { id: local })).cols], [50]);
  await p.call(selfH.id, "terminals.detach", { id: local });
  assert.deepEqual(refits, [local], "the host's pane is asked to fit again");
  // Fitted, then the desktop sized it again: nothing to hand back.
  await p.call(selfH.id, "terminals.attach", { id: local });
  size = until(p, "event", e => e.name === "terminal.size" && e.data.cols === 60);
  p.sendBinary(selfH.id, frames.encodeResize(local, 60, 20));
  await size;
  terminals.resize(local, 100, 30);
  await p.call(selfH.id, "terminals.detach", { id: local });
  assert.deepEqual(refits, [local], "no refit once the pane sized it after P");
  // A terminal D owns, sized by P: D is told to fit its pane again.
  await p.call(selfH.id, "terminals.attach", { id: ofD });
  size = until(p, "event", e => e.name === "terminal.size" && e.data.id === ofD);
  p.sendBinary(selfH.id, frames.encodeResize(ofD, 40, 15));
  await size;
  const refitD = until(d, "event", e => e.name === "terminal.refit");
  await p.call(selfH.id, "terminals.detach", { id: ofD });
  assert.deepEqual((await refitD).data, { id: ofD });

  // ---- sessions.preview ----
  const pv = await p.call(selfH.id, "sessions.preview", { agent: "Claude", id: "s-local" });
  assert.deepEqual(pv.messages.map(m => [m.role, m.text]), [["user", "What is two plus two?"], ["assistant", "Four."]]);
  assert.ok(JSON.stringify(pv).length < 64 * 1024, "the preview stays small");
  await assert.rejects(p.call(selfH.id, "sessions.preview", { agent: "Nobody", id: "s-local" }), fails("invalidSession"));
  await assert.rejects(p.call(selfH.id, "sessions.preview", { agent: "Claude", id: "a;b" }), fails("invalidSession"));
  await assert.rejects(p.call(selfH.id, "sessions.preview", { agent: "Claude" }), fails("invalidData"));
  assert.equal(await p.call(selfH.id, "sessions.preview", { agent: "Codex", id: "unknown" }), null);

  // D never heard of sizes or of other terminals.
  assert.ok(!got.D.some(e => e.name === "terminal.size"), "a normal peer gets no size events");
  assert.ok(got.D.filter(e => e.name === "terminals").every(e => e.data.every(x => x.owner === selfD.id)), "a normal peer hears only of its own");

  // ---- P's link drops: a size it set is handed back, and the wide view ends with the link ----
  await p.call(selfH.id, "terminals.attach", { id: local });
  size = until(p, "event", e => e.name === "terminal.size" && e.data.cols === 70);
  p.sendBinary(selfH.id, frames.encodeResize(local, 70, 25));
  await size;
  const down = until(h, "link", l => !l.up && l.node === selfP.id);
  p.stop();
  await down;
  assert.deepEqual(refits, [local, local], "the pane fits again when P goes away");
  // P comes back: narrow until it asks for all again.
  const p2 = node(`P-${backend}`, async () => null);
  await p2.start();
  for (let i = 0; i < 200 && !p2.online(selfH.id); i++) await sleep(100);
  await assert.rejects(p2.call(selfH.id, "terminals.attach", { id: local }), fails("invalidData"), "the wide view ends with the link");

  terminals.stopAll();
  p2.stop(); d.stop(); h.stop();
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
