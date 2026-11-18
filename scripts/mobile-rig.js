// A throwaway relay with computers behind it, for looking at the phone app (mobile/) with something in it - the
// iOS simulator of the CI (scripts/ios-simulator.js), the Android emulator, the browser preview. Modelled on
// scripts/test-mobile-provider.js: a relay (relay only), a desktop-like host with real terminals and invented
// sessions, a headless host and an older AgentDeck, all on loopback. Every name, project and path in it is made up.
// Nothing of it is in the app: the app is paired with it like with any relay, by the text this hands out.
//
// Its data is in a new temporary folder of its own (removed on /quit) and its ports are free ones - never the data
// folder or the port (7421) of an AgentDeck that runs on this machine.
//
//   node scripts/mobile-rig.js [--phone-addr ADDR] [--listen ADDR] [--control N]
//     --phone-addr ADDR   the relay's address as the PHONE reaches it, written into the pairing text (default
//                         127.0.0.1: the iOS simulator and the browser preview share this machine's loopback;
//                         10.0.2.2 for the Android emulator)
//     --listen ADDR       where the relay listens (default 127.0.0.1)
//     --control N         the control server's port on 127.0.0.1 (default: a free one)
//   It prints one line, RIG READY { control, relayPort }, then serves on http://127.0.0.1:<control>:
//     /payload        a fresh AGENTDECK-PAIR text (the relay and three computers), 10 minutes, one use
//     /wait?id=s-busy that session starts waiting for the user (the banner)
//     /info           ports and the terminals' ids
//     /quit           closes the terminals, removes the data and exits
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createLinks } = require("../src/mesh/links");
const { createServed } = require("../src/mesh/serve");
const { createSendText } = require("../src/host/send-text");
const { createLaunch } = require("../src/host/launch");
const { equipTerminals, terminalEvents } = require("../src/host");
const { HostError } = require("../src/host/errors");
const sessionPreview = require("../src/host/session-preview");
const pairCode = require("../src/mesh/pair-code");

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PHONE_ADDR = opt("phone-addr", "127.0.0.1"), LISTEN = opt("listen", "127.0.0.1"), CONTROL = Number(opt("control", 0));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-mobile-rig-"));
const work = path.join(root, "work");
const PROJECTS = ["harbor-app", "ledger-service", "field-notes"];
for (const n of PROJECTS) fs.mkdirSync(path.join(work, n), { recursive: true });
const P = n => path.join(work, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const node = (name, { kind = "desktop", relayOnly = false, port = 0, api = async () => null, listen = "127.0.0.1" } = {}) => {
  const dir = path.join(root, "nodes", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port }));
  return createLinks({ dir, defaultName: name, kind, version: "1.27.0", api, relayOnly, discover: false, listen, log: () => {} });
};
const WIN = process.platform === "win32";
const SHELL = WIN ? ["powershell.exe", "-NoLogo", "-NoProfile"] : ["bash", "--norc", "--noprofile"];
// A short prompt and a few lines, with nothing of this machine in them.
const PROMPT = WIN ? "function prompt { 'demo> ' }; Clear-Host\r" : "PS1='demo$ '; clear\r";
const LINES = WIN
  ? "1..40 | ForEach-Object { 'line {0:d2}  the quick brown fox jumps over the lazy dog along a rather wide terminal line 0123456789' -f $_ }\r"
  : "for i in $(seq -w 1 40); do echo \"line $i  the quick brown fox jumps over the lazy dog along a rather wide terminal line 0123456789\"; done\r";
const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });

const now = Date.now();
const live = [
  { agent: "Claude", id: "s-wait", cwd: P(PROJECTS[0]), status: "waiting", waitingFor: "permission to run: npm run build", statusAt: now, activityAt: now },
  { agent: "Claude", id: "s-busy", cwd: P(PROJECTS[0]), status: "busy", statusAt: now, activityAt: now },
  { agent: "Codex", id: "s-idle", cwd: P(PROJECTS[1]), status: "idle", statusAt: now - 600000, activityAt: now - 600000 }
];

// What a desktop serves: real terminals (equipped as host/index.js does), a snapshot with a few sessions, their
// live status, one transcript with an answer in markdown.
function makeHost() {
  const dir = path.join(root, "host-data");
  fs.mkdirSync(dir, { recursive: true });
  const host = new EventEmitter();
  const { createTerminals } = require(WIN ? "../src/host/terminals" : "../src/host/terminals-pty");
  const terminals = createTerminals({ userDataDir: dir, ...terminalEvents(host) });
  const transcript = path.join(dir, "s-wait.jsonl");
  const at = new Date().toISOString();
  const answer = [
    "# Release plan for `harbor-app`",
    "",
    "Here is **what I found** and *what I suggest*. The build has three stages:",
    "",
    "1. Bundles the web code with `esbuild` - one file, no `eval`.",
    "2. Copies `static/` as it is.",
    "3. Runs `npx cap sync`.",
    "",
    "```js",
    "const options = { entryPoints: { app: \"src/main.js\", style: \"src/style.css\" }, bundle: true, format: \"iife\" };",
    "await esbuild.build(options);",
    "```",
    "",
    "| File | Before | After |",
    "|:-----|-------:|------:|",
    "| `app.js` | 690.5 kB | 707.7 kB |",
    "| `style.css` | 28.5 kB | 33.4 kB |",
    "",
    "> **Note:** the signing key is only in CI.",
    "",
    "- [x] the version comes from the tag",
    "- [ ] changelog",
    "",
    "May I run `npm run build`?"
  ].join("\n");
  const msgs = [
    ["user", "Build the release and tell me which build number it got."],
    ["assistant", "The build number is derived from the tag (`2.4.1` -> 2004001). Both signing secrets are present in CI."],
    ["user", "Write up the release plan."],
    ["assistant", answer]
  ];
  fs.writeFileSync(transcript, msgs.map(([role, text], i) => JSON.stringify(role === "user"
    ? { type: "user", sessionId: "s-wait", timestamp: at, message: { role, content: text } }
    : { type: "assistant", sessionId: "s-wait", timestamp: at, message: { role, content: [{ type: "text", text }], id: `m${i}`, model: "demo" } })).join("\n") + "\n");
  const sessions0 = [
    { agent: "Claude", id: "s-wait", cwd: P(PROJECTS[0]), title: "Build the release and report its build number", updatedAt: now - 60000, file: transcript },
    { agent: "Claude", id: "s-busy", cwd: P(PROJECTS[0]), title: "Mobile UI review", updatedAt: now - 5000 },
    { agent: "Codex", id: "s-idle", cwd: P(PROJECTS[1]), title: "Fix the flaky invoice rounding test", updatedAt: now - 600000 }
  ];
  const agents = ["Claude", "Codex", "OpenCode"];
  for (let i = 0; i < 8; i++) sessions0.push({ agent: agents[i % 3], id: `s-old-${i}`, cwd: P(PROJECTS[i % 3]), title: `Older session ${i + 1}`, updatedAt: now - (i + 1) * 5 * 3600000 });
  const data = { registry: { projects: PROJECTS.map(n => ({ name: n, path: P(n) })) }, sessions: sessions0, agents, at: now };
  const liveSessions = async () => live.map(l => ({ ...l }));
  const sessions = { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} }, scan: async () => {} };
  const launch = createLaunch({ dataDir: dir, terminals, liveSessions, findTranscript: () => "", sessions });
  equipTerminals(host, { terminals, launch, liveSessions });
  Object.assign(host, {
    git: {}, setup: {}, sessions, home: work,
    sendText: createSendText({ terminals, liveSessions }),
    findTranscript: () => "", preview: (s, o) => sessionPreview.preview(s, o)
  });
  return host;
}

(async () => {
  const rPort = await freePort();
  const r = node("relay-home", { kind: "host", relayOnly: true, port: rPort, listen: LISTEN });
  const host = makeHost();
  const served = createServed({ host });
  const h = node("ATLAS-DESK", { api: (m, p, peer) => served.api(m, p, peer) });
  // A headless host (invented paths: nothing is opened there).
  const bProjects = ["infra", "deploy-scripts", "metrics"].map(n => ({ name: n, path: `/srv/${n}` }));
  const b = node("build-server.lan", { kind: "host", api: method => {
    if (method === "host.info") return { name: "build-server.lan", kind: "host", agents: ["Claude"], home: "/home/ci", platform: "linux" };
    if (method === "sessions.list") return { registry: { projects: bProjects }, sessions: [
      { agent: "Claude", id: "b-1", cwd: "/srv/infra", title: "Nightly deploy check", updatedAt: Date.now() - 7200000 },
      { agent: "Claude", id: "b-2", cwd: "/srv/metrics", title: "Dashboards for the queue depth", updatedAt: Date.now() - 300000 }], agents: ["Claude"] };
    if (method === "live.list") return [{ agent: "Claude", id: "b-2", cwd: "/srv/metrics", status: "busy", statusAt: Date.now(), activityAt: Date.now(), term: "" }];
    if (method === "terminals.list") return [];
    throw new HostError("unknownMethod");
  } });
  // An older AgentDeck: no live.list, no previews.
  const o = node("old-laptop", { api: method => {
    if (method === "host.info") return { name: "old-laptop", agents: ["Codex"] };
    if (method === "sessions.list") return { registry: { projects: [] }, sessions: [{ agent: "Codex", id: "o-1", cwd: "/srv/legacy", title: "On the old one", updatedAt: Date.now() - 86400000 }], agents: ["Codex"] };
    if (method === "terminals.list") return [];
    throw new HostError("unknownMethod");
  } });
  const selfR = await r.start();
  await h.start(); await b.start(); await o.start();
  served.attach(h);
  for (const x of [h, b, o]) await x.pair("127.0.0.1", rPort, r.self().code);
  for (let i = 0; i < 400 && !(h.online(selfR.id) && b.online(selfR.id) && o.online(selfR.id)); i++) await sleep(50);
  if (!(h.online(selfR.id) && b.online(selfR.id) && o.online(selfR.id))) throw new Error("the computers did not link with the relay");

  // The host's own agent terminals (as the desktop's panes have them) and a plain shell pane, at a desktop's sizes.
  const env = { ...process.env, PS1: "demo$ ", TERM: "xterm-256color" };
  const open = (project, title, extra = {}) => host.terminals.open({ cwd: P(project), commandLine: SHELL.join(" "), argv: SHELL, title, owner: "", env, ...extra });
  const tWait = await open(PROJECTS[0], `Claude · ${PROJECTS[0]}`, { agent: "Claude", sessionId: "s-wait", agentOnly: true });
  const tBusy = await open(PROJECTS[0], `Claude · ${PROJECTS[0]}`, { agent: "Claude", sessionId: "s-busy", agentOnly: true });
  const tShell = await open(PROJECTS[2], `Shell · ${PROJECTS[2]}`);
  for (const id of [tWait, tBusy, tShell]) { host.viewers.attach(id, "", { kind: "desktop" }); host.viewers.want(id, "", 120, 32); }
  await sleep(1500);
  for (const id of [tWait, tBusy, tShell]) host.terminals.type(id, PROMPT);
  await sleep(600);
  for (const id of [tWait, tShell]) host.terminals.type(id, LINES);

  const payload = async () => {
    const { t: _kind, ...relayNode } = entry(await h.call(selfR.id, "pair.invite"));
    return pairCode.encode({ r: { a: PHONE_ADDR, p: rPort, ...relayNode }, n: [entry(h.invite()), entry(b.invite()), entry(o.invite())] });
  };
  const ctl = http.createServer(async (rq, rs) => {
    const u = new URL(rq.url, "http://x");
    try {
      let out = "ok";
      if (u.pathname === "/payload") out = await payload();
      else if (u.pathname === "/wait") {
        const l = live.find(x => x.id === u.searchParams.get("id"));
        if (l) Object.assign(l, { status: "waiting", waitingFor: "a question: which branch should I push to?", statusAt: Date.now() });
      } else if (u.pathname === "/info") out = JSON.stringify({ phoneAddr: PHONE_ADDR, relayPort: rPort, terms: { tWait, tBusy, tShell } });
      else if (u.pathname === "/quit") {
        for (const x of host.terminals.getTabs()) { try { await host.terminals.close(x.id); } catch {} }
        out = "closing";
        setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(0); }, 1500);
      } else { rs.writeHead(404).end("not found"); return; }
      rs.writeHead(200, { "content-type": "text/plain" }).end(out);
    } catch (e) { rs.writeHead(500).end(String(e?.stack || e)); }
  }).listen(CONTROL, "127.0.0.1", () => console.log("RIG READY", JSON.stringify({ control: ctl.address().port, relayPort: rPort })));
})().catch(e => { console.error("RIG FAILED", e); process.exit(1); });
