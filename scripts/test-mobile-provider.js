// The phone app's data layer against real nodes (mobile/src/provider-relay.js + data.js, docs/MOBILE.md): a relay R
// (relay only), a desktop-like host H (createServed over real terminals, as scripts/test-shared-terminals.js builds
// it) and an older host O (no live.list) behind R, all on loopback; the app's provider and store run in Node with
// `ws` as the WebSocket. What this pins:
//   * one pairing payload pairs the phone with R, H and O, with a progress report per node;
//   * the store: relays are not computers; the inbox is filled from sessions.list + live.list (waiting first); a
//     method an older host lacks is marked missing and the rest still shows;
//   * a shell opened from the phone: attach, type, output; terminals.send refused (agentNotReady) for a shell;
//   * the host's own terminal (the wide view): attach, "terminal.size" from the host, the phone's own resize, and
//     detach handing the size back to the host's pane;
//   * the relay goes away and comes back: the views say offline, then re-attach (after terminals.list all) with
//     a fresh scrollback, and typing works again; wake() dials the relay at once and on healthy links changes
//     nothing; a new name reaches the computers without a new link; Stop is offered only where it can work;
//   * a new provider from the saved identity and peers connects without pairing; forget drops a computer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { EventEmitter } = require("node:events");
const { WebSocket } = require("ws");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createSendText } = require("../src/host/send-text");
const { createLaunch } = require("../src/host/launch");
const { HostError } = require("../src/host/errors");
const sessionPreview = require("../src/host/session-preview");
const pairCode = require("../src/mesh/pair-code");
const noise = require("../src/mesh/noise");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mobile-provider-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mobile-work-"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (f, what, ms = 30000) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await sleep(50); } throw new Error(`timeout: ${what}`); };
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const opened = [];
const node = (name, { kind = "desktop", relayOnly = false, port = 0, api = async () => null } = {}) => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "node.json"))) fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port }));
  return createLinks({ dir, defaultName: name, kind, version: "test", api, relayOnly, discover: false, log: () => {} });
};
const SHELL = process.platform === "win32" ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["bash", "--norc", "--noprofile"];
const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });

// H: what a desktop serves - real terminals, a snapshot with one session, its live status, previews.
function makeHost() {
  const dir = path.join(root, "host-data");
  fs.mkdirSync(dir, { recursive: true });
  const host = new EventEmitter();
  const { createTerminals } = require(process.platform === "win32" ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({
    userDataDir: dir,
    onData: (id, data, end) => host.emit("terminal:data", { id, data, end }),
    onExit: () => {}, onChange: tabs => host.emit("terminals", tabs),
    onResize: (id, cols, rows) => host.emit("terminal:size", { id, cols, rows })
  });
  opened.push(terminals);
  const transcript = path.join(dir, "s-wait.jsonl");
  const at = new Date().toISOString();
  fs.writeFileSync(transcript, [
    { type: "user", sessionId: "s-wait", timestamp: at, message: { role: "user", content: "Build the APK" } },
    { type: "assistant", sessionId: "s-wait", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "May I run npm?" }], id: "m1", model: "test" } }
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  const now = Date.now();
  const data = {
    registry: { projects: [{ name: "work", path: work }] },
    sessions: [
      { agent: "Claude", id: "s-wait", cwd: work, title: "Waiting one", updatedAt: now - 60000, file: transcript },
      { agent: "Claude", id: "s-old", cwd: work, title: "Old one", updatedAt: now - 86400000 }
    ],
    agents: ["Claude"], at: now
  };
  const liveSessions = async () => [{ agent: "Claude", id: "s-wait", cwd: work, status: "waiting", waitingFor: "permission to run npm", statusAt: now, activityAt: now }];
  const sessions = { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} }, scan: async () => {} };
  const launch = createLaunch({ dataDir: dir, terminals, liveSessions, findTranscript: () => "", sessions });
  Object.assign(host, {
    terminals, liveSessions, launch, git: {}, setup: {}, sessions, home: os.homedir(),
    sendText: createSendText({ terminals, liveSessions }),
    findTranscript: () => "", preview: (s, o) => sessionPreview.preview(s, o)
  });
  return host;
}

(async () => {
  const { createRelayProvider } = await import(pathToFileURL(path.join(__dirname, "../mobile/src/provider-relay.js")).href);
  const { createStore } = await import(pathToFileURL(path.join(__dirname, "../mobile/src/data.js")).href);
  const all = [], stores = [];
  try {
    // ---------- the nodes ----------
    const rPort = await freePort();
    let r = node("R", { kind: "host", relayOnly: true, port: rPort });
    const host = makeHost();
    const served = createServed({ host });
    const h = node("H", { api: (method, params, peer) => served.api(method, params, peer) });
    // O: an older AgentDeck - no live.list, no previews.
    const o = node("O", { api: method => {
      if (method === "host.info") return { name: "O", agents: ["Codex"] };
      if (method === "sessions.list") return { registry: { projects: [] }, sessions: [{ agent: "Codex", id: "o-1", cwd: "/srv", title: "On the old one", updatedAt: Date.now() }], agents: ["Codex"] };
      if (method === "terminals.list") return [];
      throw new HostError("unknownMethod");
    } });
    all.push(r, h, o);
    const selfR = await r.start(), selfH = await h.start(), selfO = await o.start();
    served.attach(h);
    const refits = [];
    host.on("terminal:refit", e => refits.push(e.id));
    for (const x of [h, o]) await x.pair("127.0.0.1", rPort, r.self().code);
    await wait(() => h.online(selfR.id) && o.online(selfR.id), "H and O linked with R");

    // The host's own agent terminal (as the desktop's pane has it), running session s-wait.
    const local = await host.terminals.open({ cwd: work, commandLine: SHELL.join(" "), argv: SHELL, title: "local", agent: "Claude", sessionId: "s-wait", agentOnly: true, owner: "", env: process.env });

    // ---------- the payload, as "Add phone" makes it ----------
    const invR = await h.call(selfR.id, "pair.invite");
    const { t: _kind, ...relayNode } = entry(invR);
    const text = pairCode.encode({ r: { a: "127.0.0.1", p: rPort, ...relayNode }, n: [entry(h.invite()), entry(o.invite())] });

    // ---------- the provider and the store ----------
    const keypair = noise.generateKeypair();
    let saved = [], meta = {};
    // As the app does: the peers and what is remembered of them (which ones are relays) are kept and handed back.
    const make = peers => createRelayProvider({ WebSocket, keypair, peers, name: "Test phone", version: "test", meta,
      onPeersChanged: list => { saved = list; }, onMetaChanged: m => { meta = m; } });
    const provider = make([]);
    const store = createStore(provider);
    stores.push(store);
    await store.connect();
    assert.equal(store.connection().state, "none", "nothing paired yet");

    const progress = [];
    const rows = await provider.pairAll(text, list => progress.push(list));
    assert.deepEqual(rows.map(x => [x.id, x.kind, x.state, x.error]), [[selfR.id, "relay", "paired", ""], [selfH.id, "desktop", "paired", ""], [selfO.id, "desktop", "paired", ""]]);
    assert.ok(progress[0].every(x => x.state === "pending"), "the first report: all pending");
    assert.ok(progress.length >= 3, "a report as each node is paired");
    assert.deepEqual(saved.map(p => p.id).sort(), [selfR.id, selfH.id, selfO.id].sort(), "the peers are handed over to be kept");
    assert.ok(meta[selfR.id]?.relay, "the relay is remembered as one");
    assert.ok(h.peers().get(provider.id)?.kind === "mobile");

    // ---------- the store fills ----------
    await wait(() => store.computers().length === 2 && store.computers().every(n => n.online) && !store.loading(), "H and O online and loaded");
    assert.equal(store.connection().state, "ok");
    assert.deepEqual(store.nodes().filter(n => n.kind === "relay").map(n => n.id), [selfR.id], "R is a relay, not a computer");
    let inbox = store.inbox();
    assert.deepEqual(inbox.waiting.map(x => [x.node, x.id, x.waitingFor]), [[selfH.id, "s-wait", "permission to run npm"]]);
    assert.equal(inbox.waiting[0].term, local, "the session's terminal through the wide view");
    assert.ok(inbox.recent.some(x => x.id === "s-old") && inbox.recent.some(x => x.node === selfO.id && x.id === "o-1"), "the older host's sessions are there too");
    assert.ok(store.missing(selfO.id, "live.list"), "what O lacks is marked missing");
    assert.ok(!store.missing(selfH.id, "live.list"));
    assert.deepEqual(store.agents(selfH.id), ["Claude"]);
    // Stop: a session in a terminal closes it; a Claude session elsewhere is stopped by the host; a Codex one elsewhere
    // has no Stop (the host cannot know its process for sure: stopUnsupported).
    assert.equal(store.stopKind(selfH.id, "Claude", "s-wait"), "terminal");
    assert.equal(store.stopKind(selfH.id, "Claude", "s-old"), "session");
    assert.equal(store.stopKind(selfO.id, "Codex", "o-1"), "");
    await assert.rejects(host.launch.stopSession("Codex", "o-1"), e => e.code === "stopUnsupported");
    const pv = await store.preview(selfH.id, "Claude", "s-wait");
    assert.deepEqual(pv.messages.map(m => m.text), ["Build the APK", "May I run npm?"]);
    await assert.rejects(store.preview(selfO.id, "Codex", "o-1"), e => e.code === "unknownMethod");

    // ---------- a shell opened from the phone ----------
    const tab = await store.launch(selfH.id, { cwd: work, kind: "shell" });
    assert.ok(tab?.id && tab.owner === provider.id);
    await wait(() => store.tab(selfH.id, tab.id), "the terminals event reaches the store");
    const shell = await store.attach(selfH.id, tab.id);
    assert.deepEqual([shell.cols, shell.rows], [120, 32], "the size comes with attach");
    let out = shell.scrollback;
    shell.onData(d => { out += d; });
    await sleep(1500); // the shell's prompt
    shell.write(process.platform === "win32" ? "echo hello-$(6*7)-phone\r" : "echo hello-$((6*7))-phone\r");
    await wait(() => out.includes("hello-42-phone"), "the shell's output");
    await assert.rejects(store.send(selfH.id, tab.id, "x"), e => e.code === "agentNotReady", "no agent in a shell to send to");
    shell.detach();

    // ---------- the host's own terminal: sizes ----------
    const view = await store.attach(selfH.id, local);
    const sizes = [];
    view.onSize(s => sizes.push(s));
    host.terminals.resize(local, 100, 30);
    await wait(() => sizes.some(s => s.cols === 100 && s.rows === 30), "terminal.size from the host");
    view.resize(50, 20); // "Fit to phone"
    await wait(() => sizes.some(s => s.cols === 50), "the phone's own size comes back as terminal.size");
    assert.deepEqual([view.cols, view.rows], [50, 20]);

    // ---------- the relay goes and comes back ----------
    const states = [], resets = [];
    view.onState(s => states.push(s.online));
    view.onReset(x => resets.push(x));
    let vout = "";
    view.onData(d => { vout += d; });
    r.stop();
    await wait(() => states.includes(false), "the view hears the link is gone");
    assert.notEqual(store.connection().state, "ok");
    await wait(() => refits.includes(local), "the host's pane refits once the phone's link dropped");
    r = node("R", { kind: "host", relayOnly: true, port: rPort });
    all.push(r);
    await r.start();
    // "Try now" (store.wake): the relay is dialled at once rather than at its next backoff step.
    const relayLinks = [];
    const offLinks = provider.on("link", e => { if (e.node === selfR.id) relayLinks.push(e.up); });
    await store.wake();
    await wait(() => provider.nodes().find(n => n.id === selfR.id)?.status === "online", "the relay dialled at once by wake", 3000);
    offLinks();
    await wait(() => resets.length && states.at(-1) === true, "re-attached after the link came back", 60000);
    assert.equal(typeof resets[0].scrollback, "string");
    assert.equal(store.connection().state, "ok");
    view.write("echo back-again\r");
    await wait(() => vout.includes("back-again"), "typing after the reconnect");
    // wake() on healthy links: nothing is torn down.
    const before = states.length;
    await provider.wake();
    await sleep(500);
    assert.equal(states.length, before, "wake on live links changes nothing");
    // A new name reaches the computers over the links that are up: nothing is made again.
    provider.setName("Renamed phone");
    assert.equal(provider.name, "Renamed phone");
    await wait(() => h.peers().get(provider.id)?.name === "Renamed phone" && r.nodes().find(n => n.id === provider.id)?.name === "Renamed phone", "the new name on H and R", 5000);
    await sleep(300);
    assert.equal(states.length, before, "renamed without a new link");
    assert.deepEqual(relayLinks, [true], "the relay came up once, by wake");
    view.detach();

    // ---------- a new start from what was saved ----------
    store.disconnect();
    const provider2 = make(saved);
    const again = createStore(provider2);
    stores.push(again);
    await again.connect();
    await wait(() => again.computers().every(n => n.online) && again.inbox().waiting.length === 1, "connected again from the saved peers");
    await again.forget(selfO.id);
    await wait(() => !again.nodes().some(n => n.id === selfO.id) && !o.peers().get(provider.id), "O forgotten on both sides");

    // ---------- every terminal of a computer ----------
    // H's own agent terminal (a session), the shell the phone opened above and left (detached, still running), a
    // plain shell pane of H's own (no session: the phone saw nothing of it before), and one another computer opened.
    await wait(() => again.node(selfH.id)?.loaded, "H loaded");
    const pane = await host.terminals.open({ cwd: work, commandLine: SHELL.join(" "), argv: SHELL, title: "pane", agent: "", sessionId: "", agentOnly: false, owner: "", env: process.env });
    const theirs = await host.terminals.open({ cwd: work, commandLine: SHELL.join(" "), argv: SHELL, title: "theirs", agent: "", sessionId: "", agentOnly: false, owner: selfR.id, env: process.env });
    await wait(() => [pane, theirs].every(id => again.terminals({ node: selfH.id }).some(x => x.id === id)), "the new terminals in the list");
    const byId = id => again.terminals({ node: selfH.id }).find(x => x.id === id);
    assert.deepEqual([byId(local).owner, byId(local).item?.id, byId(local).title], ["here", "s-wait", "Waiting one"], "an agent's terminal links to its session");
    assert.deepEqual([byId(tab.id).owner, byId(tab.id).item, byId(tab.id).exited], ["phone", null, false], "the phone's own shell, left running");
    assert.deepEqual([byId(pane).owner, byId(pane).title, byId(pane).project], ["here", "pane", "work"], "a plain shell pane of the computer");
    assert.equal(byId(theirs).owner, "peer");
    const loose = again.terminals({ running: true, loose: true }).map(x => x.id);
    assert.ok(loose.includes(pane) && loose.includes(tab.id) && !loose.includes(local), "the inbox lists the terminals that are not a running session's");
    assert.deepEqual(again.terminals({ query: "pane" }).map(x => x.id), [pane], "searched as the inbox is");
    // Opened again from the list and typed into: it is the same shell.
    const back = await again.attach(selfH.id, tab.id);
    let bout = back.scrollback;
    back.onData(d => { bout += d; });
    back.write("exit\r");
    await wait(() => byId(tab.id)?.exited, "the shell ended: still listed, as ended");
    assert.ok(!again.terminals({ running: true }).some(x => x.id === tab.id));
    back.detach();
    // Closed from the list (as the X does): gone on the host and from the list.
    await again.closeTerminal(selfH.id, pane);
    await wait(() => !byId(pane) && !host.terminals.getTabs().some(x => x.id === pane), "closed on the host");
    await again.closeTerminal(selfH.id, tab.id);
    await again.closeTerminal(selfH.id, theirs);

    // ---------- in the background: nothing is dialled ----------
    again.pause();
    r.stop();
    await wait(() => !provider2.nodes().some(n => n.status === "online"), "the links went with the relay");
    r = node("R", { kind: "host", relayOnly: true, port: rPort });
    all.push(r);
    await r.start();
    await sleep(4500); // past the first retries (2 s, 4 s)
    assert.ok(!provider2.nodes().some(n => n.status === "online"), "paused: the relay is not dialled");
    await again.wake();
    await wait(() => again.computers().every(n => n.online), "wake: dialled at once", 15000);

    // ---------- forgotten elsewhere, the relay first ----------
    // The relay forgets the phone and tells it; H, reached only through it, cannot any more. The phone drops the
    // relay, and H - which it still lists - has no way to be reached: said so (noHub), its stale sessions hidden, and
    // "nohub" for the link as a whole (the app: "No relay - add one").
    assert.ok(again.inbox().waiting.length === 1);
    assert.deepEqual(await h.call(selfR.id, "peers.revoke", { id: provider.id }), { removed: true });
    await wait(() => again.connection().state === "nohub", "nothing left to dial");
    assert.deepEqual(saved.map(p => p.id), [selfH.id], "the relay dropped, H kept (it was not told)");
    assert.equal(again.nodes().find(n => n.id === selfH.id).error, "noHub");
    assert.ok(again.lost(selfH.id) && again.node(selfH.id).data, "lost, with what was loaded of it still held");
    assert.deepEqual(again.inbox(), { waiting: [], working: [], recent: [] }, "but not shown as its sessions");
    // A fresh code mends it: the relay, and H paired again (not "already": it is not reachable).
    const mend = pairCode.encode({ r: { a: "127.0.0.1", p: rPort, ...(({ t: _, ...x }) => x)(entry(await h.call(selfR.id, "pair.invite"))) }, n: [entry(h.invite())] });
    const mended = await provider2.pairAll(mend);
    assert.deepEqual(mended.map(x => [x.id, x.state, x.error]), [[selfR.id, "paired", ""], [selfH.id, "paired", ""]]);
    await wait(() => again.connection().state === "ok" && again.inbox().waiting.length === 1, "back, with its sessions");

    // ---------- forgotten while away ----------
    // The relay forgets the phone while the phone is not linked: it answers "unpaired", and is dropped - not dialled
    // in vain every 30 s - and H says it cannot be reached.
    again.disconnect();
    assert.deepEqual(await h.call(selfR.id, "peers.revoke", { id: provider.id }), { removed: true });
    const third = createStore(make(saved));
    stores.push(third);
    await third.connect();
    await wait(() => third.connection().state === "nohub", "the relay answered unpaired and was dropped");
    assert.deepEqual(saved.map(p => p.id), [selfH.id]);
    assert.equal(third.nodes().find(n => n.id === selfH.id)?.error, "noHub");

    console.log("mobile provider: pairing from one payload with progress, inbox from sessions/live (relay apart, older host), shell attach/type/output, wide view sizes and refit, reconnect with re-attach, wake, restart from saved peers, forget, every terminal of a computer (own, the phone's, a pane, another's; open, ended, closed), no dialling while paused, forgotten by the relay first (told, and while away: unpaired) and mended by a fresh code - passed");
  } finally {
    for (const s of stores) { try { s.disconnect(); } catch {} }
    for (const t of opened) t.stopAll();
    for (const n of all) n.stop();
    await sleep(1000);
    try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
