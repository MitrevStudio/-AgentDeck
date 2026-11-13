// The phone app's data layer against real nodes (mobile/src/provider-relay.js + data.js, docs/MOBILE.md): a relay R
// (relay only), a desktop-like host H (createServed over real terminals, as scripts/test-shared-terminals.js builds
// it) and an older host O (no live.list) behind R, all on loopback; the app's provider and store run in Node with
// `ws` as the WebSocket. What this pins:
//   * one pairing payload pairs the phone with R, H and O, with a progress report per node;
//   * the store: relays are not computers; the inbox is filled from sessions.list + live.list (waiting first); a
//     method an older host lacks is marked missing and the rest still shows;
//   * a shell opened from the phone: attach, type, output; terminals.send refused (agentNotReady) for a shell; a
//     session's terminal found by live.term first;
//   * the host's own terminal, shared (docs/SHARED-SESSIONS.md 4, host.info terminals: 2): the host's window is a
//     viewer with a 100x30 pane; the phone's row lists it (not the phone); attach says whose size it is; "Fit to
//     phone" takes the size (terminals.resize), pressing again releases it to the pane, and so do the phone's link
//     dropping and leaving the view (detach); the phone's keys never take it;
//   * the relay goes away and comes back: the views say offline, then re-attach (after terminals.list) with
//     a fresh scrollback, and typing works again; "Fit to phone" pressed before that waits for the attach, and one
//     the host refuses (notViewing: it forgot the phone) attaches again and asks once more; wake() dials the relay at once and on healthy links changes
//     nothing; a new name reaches the computers without a new link; Stop is offered only where it can work;
//   * a lagging link: output skipped, "terminal.resync", attached again with what was missed in the scrollback;
//   * a resume of a session running in a terminal there answers that terminal (already: true);
//   * a host without terminals: 2: "Fit to phone" and back are resize frames, as before;
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
const { equipTerminals, terminalEvents } = require("../src/host");
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

// H: what a desktop serves - real terminals (equipped as host/index.js does: viewers, tabs, live with term), a
// snapshot with one session, its live status, previews.
function makeHost() {
  const dir = path.join(root, "host-data");
  fs.mkdirSync(dir, { recursive: true });
  const host = new EventEmitter();
  const { createTerminals } = require(process.platform === "win32" ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({ userDataDir: dir, ...terminalEvents(host) });
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
  equipTerminals(host, { terminals, launch, liveSessions });
  Object.assign(host, {
    git: {}, setup: {}, sessions, home: os.homedir(),
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
    // legacy: H answers host.info as a host before terminals: 2 does (the phone then keeps the resize frame).
    let legacy = false;
    const h = node("H", { api: async (method, params, peer) => {
      const v = await served.api(method, params, peer);
      return legacy && method === "host.info" ? { ...v, terminals: undefined } : v;
    } });
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
    for (const x of [h, o]) await x.pair("127.0.0.1", rPort, r.self().code);
    await wait(() => h.online(selfR.id) && o.online(selfR.id), "H and O linked with R");

    // The host's own agent terminal (as the desktop's pane has it), running session s-wait.
    const local = await host.terminals.open({ cwd: work, commandLine: SHELL.join(" "), argv: SHELL, title: "local", agent: "Claude", sessionId: "s-wait", agentOnly: true, owner: "", env: process.env });
    let hostOut = ""; // what the host's own terminal printed, as the host has it
    host.on("terminal:data", e => { if (e.id === local) hostOut += e.data; });

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
    assert.equal(inbox.waiting[0].term, local, "the session's terminal (live.term)");
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
    // The live status's `term` comes first: a session the host says runs in this shell, though no tab names it (as
    // after /clear, before the host links the tab to the new id), is found there.
    const equippedLive = host.liveSessions;
    host.liveSessions = async () => [...await equippedLive(), { agent: "Claude", id: "s-new", cwd: work, status: "idle", statusAt: Date.now(), activityAt: Date.now(), term: tab.id }];
    await wait(() => store.item(selfH.id, "Claude", "s-new"), "the live push with s-new");
    assert.equal(store.item(selfH.id, "Claude", "s-new").term, tab.id, "live.term is used");
    assert.equal(store.stopKind(selfH.id, "Claude", "s-new"), "terminal");
    assert.equal(store.node(selfH.id).live.find(l => l.id === "s-wait").term, local, "the host's live.list carries term");
    host.liveSessions = equippedLive;
    await wait(() => !store.item(selfH.id, "Claude", "s-new"), "s-new gone again");
    shell.detach();

    // ---------- the host's own terminal: viewers and sizes ----------
    // The host's own window has it open in a 100x30 pane (main.js makes its panes viewers, who "").
    host.viewers.attach(local, "", { kind: "desktop" });
    host.viewers.want(local, "", 100, 30);
    const hostSize = () => { const s = host.viewers.state(local); return [s.cols, s.rows, s.driver]; };
    assert.deepEqual(hostSize(), [100, 30, ""]);
    assert.ok(store.shared(selfH.id), "H shares its terminals (terminals: 2)");
    const view = await store.attach(selfH.id, local);
    assert.deepEqual([view.cols, view.rows, view.driver, view.mine, view.shared], [100, 30, selfH.id, false, true], "attach: the size and whose it is (the host's window: the host's id)");
    assert.ok(host.tabs().find(x => x.id === local).viewers.some(v => v.id === provider.id && v.kind === "mobile"), "on the host the phone is a viewer");
    // The row: the host's own window has it open too; the phone itself is not listed among the others.
    await wait(() => store.terminals({ node: selfH.id }).find(x => x.id === local)?.viewers.length === 1, "the row carries the viewers");
    const row = store.terminals({ node: selfH.id }).find(x => x.id === local);
    assert.deepEqual(row.viewers, [{ id: selfH.id, name: "H", kind: "desktop" }]);
    assert.equal(row.driver, "H", "whose size it has, by name");
    assert.deepEqual(store.viewers(selfH.id, local).map(v => v.name), ["H"]);
    assert.ok(store.node(selfH.id).terminals.find(x => x.id === local).viewers.some(v => v.id === provider.id), "the host lists the phone; the store leaves it out");
    const sizes = [];
    view.onSize(s => sizes.push(s));
    // "Fit to phone" takes the size (terminals.resize), whatever the host's pane wants.
    assert.deepEqual(await view.take(50, 20), { cols: 50, rows: 20, driver: provider.id });
    assert.ok(view.mine);
    assert.deepEqual(hostSize(), [50, 20, provider.id]);
    assert.equal(store.sizeOwner(selfH.id, local, view.driver), "phone");
    host.viewers.want(local, "", 100, 30);
    assert.deepEqual(hostSize(), [50, 20, provider.id], "the pane fitting again is only remembered");
    // Pressing it again gives the size back: the host's pane has it again.
    assert.deepEqual(await view.release(), { cols: 100, rows: 30, driver: selfH.id });
    assert.deepEqual(hostSize(), [100, 30, ""]);
    assert.ok(!view.mine);
    await wait(() => sizes.some(s => s.cols === 100 && s.rows === 30 && s.driver === selfH.id), "terminal.size with its driver");
    // Taken again, for the link to drop below.
    await view.take(50, 20);
    assert.deepEqual(hostSize(), [50, 20, provider.id]);

    // ---------- the relay goes and comes back ----------
    const states = [], resets = [];
    view.onState(s => states.push(s.online));
    view.onReset(x => resets.push(x));
    let vout = "";
    view.onData(d => { vout += d; });
    r.stop();
    await wait(() => states.includes(false), "the view hears the link is gone");
    assert.notEqual(store.connection().state, "ok");
    await wait(() => hostSize().join() === "100,30,", "the size goes back to the host's pane once the phone's link dropped");
    r = node("R", { kind: "host", relayOnly: true, port: rPort });
    all.push(r);
    await r.start();
    // "Fit to phone" pressed while the view is still away: it waits for the attach (a take before it would find the
    // phone no viewer), then takes the size.
    const resizeAsks = [];
    const plainRequest = provider.request;
    provider.request = (n, method, params, opts) => {
      if (method === "terminals.resize" || method === "terminals.attach") resizeAsks.push(method);
      return plainRequest(n, method, params, opts);
    };
    const early = view.take(40, 15);
    // "Try now" (store.wake): the relay is dialled at once rather than at its next backoff step.
    const relayLinks = [];
    const offLinks = provider.on("link", e => { if (e.node === selfR.id) relayLinks.push(e.up); });
    await store.wake();
    await wait(() => provider.nodes().find(n => n.id === selfR.id)?.status === "online", "the relay dialled at once by wake", 3000);
    offLinks();
    await wait(() => resets.length && states.at(-1) === true, "re-attached after the link came back", 60000);
    assert.deepEqual(await early, { cols: 40, rows: 15, driver: provider.id }, "a take right after the reconnect waits for the attach");
    assert.deepEqual(resizeAsks, ["terminals.attach", "terminals.resize"], "attached first, then the take - no notViewing");
    assert.deepEqual(hostSize(), [40, 15, provider.id]);
    assert.deepEqual(await view.release(), { cols: 100, rows: 30, driver: selfH.id });
    // The host forgot the phone as a viewer without the phone noticing (its link dropped and came back at once): the
    // host answers notViewing, the handle attaches again and asks once more.
    resizeAsks.length = 0;
    host.viewers.detach(local, provider.id);
    assert.deepEqual(await view.take(40, 15), { cols: 40, rows: 15, driver: provider.id }, "taken after attaching again");
    assert.deepEqual(resizeAsks, ["terminals.resize", "terminals.attach", "terminals.resize"]);
    assert.deepEqual(await view.release(), { cols: 100, rows: 30, driver: selfH.id });
    provider.request = plainRequest;
    assert.equal(typeof resets[0].scrollback, "string");
    assert.equal(store.connection().state, "ok");
    assert.deepEqual([view.cols, view.rows, view.driver, view.mine], [100, 30, selfH.id, false], "attached again: the host's size, not the phone's");
    view.write("echo back-again\r");
    await wait(() => vout.includes("back-again"), "typing after the reconnect");
    assert.deepEqual(hostSize(), [100, 30, ""], "the phone's keys do not take the size (it wants none)");
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

    // ---------- resync: the phone's link lags, its output is skipped, it attaches again ----------
    const realBuffered = h.buffered;
    h.buffered = id => (id === provider.id ? 8 * 1024 * 1024 : realBuffered(id));
    const resetsBefore = resets.length;
    host.terminals.input(local, process.platform === "win32" ? "echo while-$(6*7)-behind\r" : "echo while-$((6*7))-behind\r");
    await wait(() => hostOut.includes("while-42-behind"), "the host's terminal printed it");
    await sleep(300);
    assert.ok(!vout.includes("while-42-behind"), "output to a phone that lags is skipped");
    h.buffered = realBuffered;
    await wait(() => resets.length > resetsBefore, "terminal.resync: attached again");
    assert.ok(resets.at(-1).scrollback.includes("while-42-behind"), "what it missed comes with the scrollback");
    assert.ok(view.online);
    view.write(process.platform === "win32" ? "echo after-$(6*7)-resync\r" : "echo after-$((6*7))-resync\r");
    await wait(() => vout.includes("after-42-resync"), "the output goes on after the resync");

    // ---------- resume of a session that runs in a terminal there: that terminal ----------
    const already = await store.launch(selfH.id, { cwd: work, kind: "resume", agent: "Claude", sessionId: "s-wait" });
    assert.deepEqual([already.id, already.already], [local, true], "nothing new runs: the running terminal, already");
    assert.equal(host.terminals.getTabs().filter(x => x.sessionId === "s-wait").length, 1);

    // ---------- a host before terminals: 2: the resize frame, as before ----------
    const requests = [], frameLog = [];
    const realRequest = provider.request, realSendFrame = provider.sendFrame;
    provider.request = (n, method, params, opts) => { requests.push(method); return realRequest(n, method, params, opts); };
    provider.sendFrame = (n, frame) => { frameLog.push(frame); return realSendFrame(n, frame); };
    legacy = true;
    let resetsNow = resets.length;
    await store.refresh(selfH.id);
    assert.ok(!store.shared(selfH.id) && !view.shared, "H looks like an older host now");
    await wait(() => resets.length > resetsNow, "attached again after the refresh");
    assert.equal(view.driver, null, "an older host's driver is not looked at");
    assert.deepEqual(await view.take(60, 24), { cols: 60, rows: 24, driver: null }, "an older host: the phone's own size");
    assert.deepEqual(await view.release({ cols: 100, rows: 30 }), { cols: 100, rows: 30, driver: null });
    assert.deepEqual(frameLog.filter(f => f.type === "resize").map(f => [f.cols, f.rows]), [[60, 24], [100, 30]], "as resize frames");
    assert.ok(!requests.includes("terminals.resize"), "no terminals.resize for an older host");
    provider.request = realRequest;
    provider.sendFrame = realSendFrame;
    legacy = false;
    resetsNow = resets.length;
    await store.refresh(selfH.id);
    assert.ok(store.shared(selfH.id));
    await wait(() => resets.length > resetsNow, "attached again");
    assert.equal(view.driver, selfH.id);

    // ---------- leaving the view hands the size back ----------
    await view.take(50, 20);
    assert.deepEqual(hostSize(), [50, 20, provider.id]);
    view.detach();
    await wait(() => hostSize().join() === "100,30,", "detach: the size goes back to the host's pane");
    assert.ok(!host.viewers.state(local).viewers.includes(provider.id), "the phone views it no more");

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
    // A terminal started as an agent, its session not there yet (#31, #32): the host sends a stand-in for it, so it is
    // one row among the running sessions - under the terminal's title - and not also a loose terminal.
    const starting = await host.terminals.open({ cwd: work, commandLine: SHELL.join(" "), argv: SHELL, title: "Codex · work", agent: "Codex", sessionId: "", agentOnly: true, owner: "", env: process.env });
    const standIn = () => again.inbox().working.find(x => x.agent === "Codex" && x.id === starting);
    await wait(() => standIn() && byId(starting), "the stand-in and its terminal reached the phone");
    assert.deepEqual([standIn().status, standIn().term, standIn().title, standIn().project], ["other", starting, "Codex · work", "work"]);
    assert.equal(byId(starting).item?.id, starting, "its terminal row is that session's");
    assert.ok(!again.terminals({ running: true, loose: true }).some(x => x.id === starting), "listed once: not under the loose terminals too");
    await again.closeTerminal(selfH.id, starting);
    await wait(() => !standIn() && !byId(starting), "gone with its terminal");
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

    console.log("mobile provider: pairing from one payload with progress, inbox from sessions/live (relay apart, older host), shell attach/type/output, live.term, shared terminal (viewers on the row, take/release, hand-back on link drop and detach), reconnect with re-attach, resync, resume answering already, an older host's resize frames, wake, restart from saved peers, forget, every terminal of a computer (own, the phone's, a pane, another's; open, ended, closed), no dialling while paused, forgotten by the relay first (told, and while away: unpaired) and mended by a fresh code - passed");
  } finally {
    for (const s of stores) { try { s.disconnect(); } catch {} }
    for (const t of opened) t.stopAll();
    for (const n of all) n.stop();
    await sleep(1000);
    try { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
