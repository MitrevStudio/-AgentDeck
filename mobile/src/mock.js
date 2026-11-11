// The Demo: a provider (see data.js) with three made-up computers behind it, answering the host's protocol the way
// serve.js does - snapshots, live status, terminals, previews - and changing over time, so every screen has
// something to show: a session turns to "waiting" now and then (the in-app banner), answers come back, terminals
// draw an agent-like screen at the host's 120x30 and take keys.
import { emitter } from "./util.js";

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const COLS = 120, ROWS = 30;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
// A node id: 64 hex characters, as the certificate fingerprints are.
const nodeId = seed => [...Array(64)].map((_, i) => ((seed.charCodeAt(i % seed.length) * (i + 7)) % 16).toString(16)).join("");
// The Demo's phone: the owner of the terminals it opens (and of one it left running on devws).
const PHONE = nodeId("demo-phone");

// ---------- the computers ----------
function sampleHosts(now) {
  const ws = {
    node: { id: nodeId("workstation"), name: "WS-IVAN", kind: "desktop", version: "1.12.0", status: "online", via: [], lastSeen: now, error: "" },
    platform: "win32", home: "C:\\Users\\ivan", agents: ["Claude", "Codex", "OpenCode"],
    projects: [
      { name: "ai-session-manager", path: "E:\\AIWorkTool\\ai-session-manager" },
      { name: "bgr-erp", path: "E:\\Work\\bgr-erp" },
      { name: "notify", path: "E:\\Work\\notify" }
    ],
    sessions: [
      { agent: "Claude", title: "Mobile app skeleton in Capacitor", cwd: "E:\\AIWorkTool\\ai-session-manager", ago: 2 * MIN,
        live: { status: "waiting", waitingFor: "permission to run Bash: npm run apk" }, term: "agent", screen: "permission",
        messages: [
          ["user", "Направи скелета на мобилното приложение в mobile/ – Capacitor, esbuild, xterm.js. Първо Android."],
          ["assistant", "I'll scaffold `mobile/` with its own package.json, an esbuild build into `www/` and the Android project from `cap add android`. Then the data layer with a mock provider, and the screens."],
          ["user", "Без Firebase и без Google Play Services. QR скенерът – през камерата в WebView-то."],
          ["assistant", "Understood: getUserMedia + jsQR, no ML Kit. The google-services hook from the Android template is removed too. The debug APK builds; I want to run `npm run apk` again after the manifest change."]
        ] },
      { agent: "Codex", title: "Relay throttling test is flaky", cwd: "E:\\AIWorkTool\\ai-session-manager", ago: 30 * 1000,
        live: { status: "busy" }, term: "agent", screen: "working",
        messages: [
          ["user", "scripts/test-mesh-pairing.js понякога пада на втория опит. Намери защо."],
          ["assistant", "The guard's window is measured with Date.now() while the test advances a fake clock: the second try lands in the same window. Running the test 50 times to confirm."]
        ] },
      { agent: "Claude", title: "Invoice export to PDF", cwd: "E:\\Work\\bgr-erp", ago: 12 * MIN,
        live: { status: "idle" }, term: "agent", screen: "prompt",
        messages: [
          ["user", "Експортът на фактури към PDF реже кирилицата в адреса."],
          ["assistant", "The PDF font had no Cyrillic glyphs. I embedded Noto Sans and added a test with a Bulgarian address. All 214 tests pass."],
          ["user", "Супер. Пусни и e2e-тестовете."],
          ["assistant", "Done: 38/38 e2e tests pass. Ready for the next step."]
        ] },
      { agent: "Claude", title: "Notify: retry webhooks with backoff", cwd: "E:\\Work\\notify", ago: 3 * HOUR,
        messages: [["user", "Добави retry с exponential backoff за webhook-ите."], ["assistant", "Added retries (5 tries, 2^n s, jitter) and a dead-letter table. Migration 0042."]] },
      { agent: "Codex", title: "Upgrade to Electron 41", cwd: "E:\\AIWorkTool\\ai-session-manager", ago: DAY + 2 * HOUR,
        messages: [["user", "Обнови Electron до 41 и провери node-pty."], ["assistant", "Electron 41 works; node-pty rebuilt. The tray icon needed a new size on Windows 11."]] },
      { agent: "OpenCode", title: "README in Bulgarian", cwd: "E:\\Work\\notify", ago: 3 * DAY,
        messages: [["user", "Преведи README-то на български."], ["assistant", "Translated; the code samples are left as they were."]] }
    ],
    shells: [{ cwd: "E:\\Work\\bgr-erp", title: "bgr-erp" }]
  };
  const devws = {
    node: { id: nodeId("devws-host"), name: "devws", kind: "headless", version: "1.12.0", status: "online", via: [], lastSeen: now, error: "" },
    platform: "linux", home: "/home/ivan", agents: ["Claude", "Codex"],
    projects: [
      { name: "notify-api", path: "/home/ivan/notify-api" },
      { name: "bdd-web", path: "/home/ivan/bdd-web" }
    ],
    sessions: [
      { agent: "Claude", title: "Flaky e2e test on checkout", cwd: "/home/ivan/bdd-web", ago: 5 * MIN,
        live: { status: "waiting", waitingFor: "a question: which branch should the fix go on?" }, term: "agent", screen: "question",
        messages: [
          ["user", "e2e тестът за checkout пада на CI всеки трети път."],
          ["assistant", "The cart is read before the session cookie is set: a race in `useCart`. I have a fix. Which branch should it go on - `dev` or a new `fix/checkout-race`?"]
        ] },
      { agent: "Claude", title: "Migrate to Postgres 17", cwd: "/home/ivan/notify-api", ago: 40 * 1000,
        live: { status: "busy" }, term: "",
        messages: [["user", "Мигрирай notify-api към Postgres 17 – docker-compose и CI."], ["assistant", "Updated compose and the CI service image; running the migrations against a fresh 17 instance now."]] },
      { agent: "Codex", title: "Rate limits for the public API", cwd: "/home/ivan/notify-api", ago: 6 * HOUR,
        messages: [["user", "Сложи rate limit на публичното API."], ["assistant", "Token bucket per API key, 100 req/min, 429 with Retry-After. Tests added."]] },
      { agent: "Claude", title: "Docker image size", cwd: "/home/ivan/bdd-web", ago: 2 * DAY,
        messages: [["user", "Образът е 1.2 GB. Смали го."], ["assistant", "Multi-stage build on node:24-alpine: 186 MB."]] }
    ],
    shells: [{ cwd: "/home/ivan/bdd-web", title: "bdd-web", owner: PHONE }]
  };
  const laptop = {
    node: { id: nodeId("laptop-ivan"), name: "Laptop", kind: "desktop", version: "1.11.0", status: "offline", via: [], lastSeen: now - 2 * DAY, error: "" },
    platform: "win32", home: "C:\\Users\\ivan", agents: ["Claude"], projects: [], sessions: [], shells: []
  };
  return [ws, devws, laptop];
}

// ---------- a fake terminal ----------
const ESC = "\x1b[";
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const pad = (s, w) => s + " ".repeat(Math.max(0, w - strip(s).length));
const C = { dim: s => `${ESC}90m${s}${ESC}0m`, bold: s => `${ESC}1m${s}${ESC}0m`, orange: s => `${ESC}38;5;216m${s}${ESC}0m`, blue: s => `${ESC}38;5;111m${s}${ESC}0m`, green: s => `${ESC}38;5;114m${s}${ESC}0m`, inv: s => `${ESC}7m${s}${ESC}0m` };
function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > width) { out.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

// An agent's screen (Claude Code-like): a header, the conversation, and at the bottom the prompt box, a permission
// dialog or a question. It repaints itself on every change, as such TUIs do.
function agentTerm(host, s, emitOut) {
  const term = { cols: COLS, rows: ROWS, input: "", screen: s.screen || "prompt", spin: 0, timer: 0 };
  const name = s.agent === "Codex" ? "Codex" : s.agent === "OpenCode" ? "OpenCode" : "Claude Code";
  const convo = () => s.messages.flatMap(([role, text]) => {
    const w = term.cols - 4;
    const lines = wrap(text, w);
    return role === "user"
      ? [...lines.map((l, i) => C.dim(`${i ? "  " : "> "}${l}`)), ""]
      : [...lines.map((l, i) => `${i ? "  " : C.orange("● ")}${l}`), ""];
  });
  function box(lines, color = C.dim) {
    const w = term.cols - 2;
    return [color(`╭${"─".repeat(w)}╮`), ...lines.map(l => `${color("│")}${pad(" " + l, w)}${color("│")}`), color(`╰${"─".repeat(w)}╯`)];
  }
  function bottom() {
    if (term.screen === "permission") {
      return box([C.bold("Bash command"), "", `  ${host.platform === "win32" ? "npm run apk" : "npm test"}`, C.dim("  Build the debug APK again"), "",
        "Do you want to proceed?", `${C.blue("❯")} ${C.blue("1. Yes")}`, "  2. Yes, and don't ask again for npm commands in this project", "  3. No, and tell Claude what to do differently (esc)"], C.blue);
    }
    if (term.screen === "question") {
      return box([C.bold("Which branch should the fix go on?"), "", `${C.blue("❯")} ${C.blue("1. dev")}`, "  2. fix/checkout-race (new)", "  3. Type something else"], C.blue);
    }
    const spinner = "✻✶✳✢·"[term.spin % 5];
    const status = term.screen === "working" ? `${C.orange(spinner + " Working…")} ${C.dim("(esc to interrupt)")}` : C.dim("? for shortcuts");
    return ["", ...box([`> ${term.input}${C.inv(" ")}`]), `  ${status}`];
  }
  function paint() {
    const head = box([`${C.orange("✻")} ${C.bold(name)}`, C.dim(`cwd: ${s.cwd}`)]);
    const foot = bottom();
    const room = Math.max(0, term.rows - head.length - foot.length);
    const body = convo();
    const shown = body.slice(Math.max(0, body.length - room));
    while (shown.length < room) shown.push("");
    const lines = [...head, ...shown, ...foot].slice(0, term.rows).map(l => l + `${ESC}K`);
    return `${ESC}?25l${ESC}H${lines.join("\r\n")}`;
  }
  const redraw = () => emitOut(paint());
  const setLive = status => host.setLive(s, status);

  function work(reply, ms = 2600) {
    term.screen = "working";
    setLive({ status: "busy" });
    clearInterval(term.timer);
    term.timer = setInterval(() => { term.spin++; redraw(); }, 400);
    setTimeout(() => {
      clearInterval(term.timer);
      s.messages.push(["assistant", reply]);
      term.screen = "prompt";
      setLive({ status: "idle" });
      host.touch(s);
      redraw();
    }, ms);
    redraw();
  }
  function submit(text) {
    if (!text.trim()) return;
    s.messages.push(["user", text]);
    host.touch(s);
    work(`(demo) Got it: “${text.slice(0, 80)}”. Working on it - in a real session the agent would do the work here.`);
  }
  function choose(n) {
    const q = term.screen === "question";
    s.messages.push(["user", q ? ["dev", "fix/checkout-race", "…"][n - 1] : `[${["Yes", "Yes, don't ask again", "No"][n - 1]}]`]);
    if (n === 3 && !q) { term.screen = "prompt"; setLive({ status: "idle" }); redraw(); return; }
    work(q ? "Committed the fix and pushed. CI is running." : "Built: android/app/build/outputs/apk/debug/app-debug.apk (4.1 MB).");
  }

  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    paint,
    // Keys as xterm sends them.
    input(data) {
      if (term.screen === "permission" || term.screen === "question") {
        if (/^[123]$/.test(data) || data === "\r") return choose(data === "\r" ? 1 : Number(data));
        if (data === "\x1b") { term.screen = "prompt"; setLive({ status: "idle" }); }
        return redraw();
      }
      if (term.screen === "working") {
        if (data === "\x1b" || data === "\x03") { clearInterval(term.timer); term.screen = "prompt"; s.messages.push(["assistant", "Interrupted by the user."]); setLive({ status: "idle" }); }
        return redraw();
      }
      for (const ch of data.match(/\x1b\[[A-D]|[\s\S]/g) || []) {
        if (ch === "\r") { const text = term.input; term.input = ""; submit(text); }
        else if (ch === "\x7f" || ch === "\b") term.input = term.input.slice(0, -1);
        else if (ch === "\x03") term.input = "";
        else if (ch === "\x1b" || ch.startsWith("\x1b[") || ch === "\t") { /* nothing to do in the demo */ }
        else if (ch >= " ") term.input += ch;
      }
      redraw();
    },
    // Text sent with terminals.send: a paste and Enter.
    send(text) {
      if ((term.screen === "permission" || term.screen === "question") && /^[123]$/.test(text.trim())) return choose(Number(text.trim()));
      if (term.screen !== "prompt") term.screen = "prompt";
      submit(text);
    },
    resize(cols, rows) { term.cols = cols; term.rows = rows; redraw(); },
    // The waiting state started from outside (the demo's clock).
    ask() { term.screen = "permission"; redraw(); },
    close() { clearInterval(term.timer); }
  };
}

// A shell that echoes what is typed and answers every command with a line.
function shellTerm(host, cwd, emitOut) {
  const term = { cols: COLS, rows: ROWS, line: "", log: "" };
  const prompt = host.platform === "win32" ? `${C.blue("PS")} ${cwd}> ` : `${C.green("ivan@" + host.node.name)}:${C.blue(cwd.replace(host.home, "~"))}$ `;
  const out = s => { term.log += s; emitOut(s); };
  term.log = `${C.dim("AgentDeck demo shell - commands are not run anywhere.")}\r\n${prompt}`;
  return {
    get cols() { return term.cols; },
    get rows() { return term.rows; },
    paint: () => term.log,
    input(data) {
      for (const ch of data.match(/\x1b\[[A-D]|[\s\S]/g) || []) {
        if (ch === "\r") {
          const cmd = term.line.trim();
          term.line = "";
          out(`\r\n${cmd ? `${cmd.split(" ")[0]}: ${C.dim("(demo) nothing runs here")}\r\n` : ""}${prompt}`);
        } else if (ch === "\x7f" || ch === "\b") { if (term.line) { term.line = term.line.slice(0, -1); out("\b \b"); } }
        else if (ch === "\x03") { term.line = ""; out(`^C\r\n${prompt}`); }
        else if (ch >= " " && !ch.startsWith("\x1b")) { term.line += ch; out(ch); }
      }
    },
    send(text) { this.input(text + "\r"); },
    resize(cols, rows) { term.cols = cols; term.rows = rows; },
    close() {}
  };
}

// ---------- the provider ----------
export function createMockProvider() {
  const ev = emitter();
  const now = Date.now();
  const hosts = sampleHosts(now).map(h => ({ ...h, tabs: [], terms: new Map(), liveMap: new Map() }));
  const timers = [];
  let running = false;

  const hostOf = id => {
    const h = hosts.find(x => x.node.id === id);
    if (!h) throw new Error("unknown node");
    if (h.node.status !== "online") throw new Error("offline");
    return h;
  };

  // Each host's sessions get ids, live entries and terminals.
  for (const h of hosts) {
    h.setLive = (s, patch) => {
      const prev = h.liveMap.get(s.id);
      if (patch === null) h.liveMap.delete(s.id);
      else h.liveMap.set(s.id, { ...prev, ...patch, statusAt: Date.now(), activityAt: Date.now(), waitingFor: patch.status === "waiting" ? patch.waitingFor || prev?.waitingFor || "" : "" });
      if (running) ev.emit("notify", { node: h.node.id, event: "live", payload: liveList(h) });
    };
    h.touch = s => { s.updatedAt = Date.now(); if (running) ev.emit("notify", { node: h.node.id, event: "data", payload: snapshot(h) }); };
    for (const s of h.sessions) {
      s.id = uuid();
      s.updatedAt = now - (s.ago || 0);
      if (s.live) {
        h.liveMap.set(s.id, { status: s.live.status, waitingFor: s.live.waitingFor || "", statusAt: s.updatedAt, activityAt: s.updatedAt, startedAt: s.updatedAt - 40 * MIN, pid: 4000 + Math.floor(Math.random() * 5000) });
      }
      if (s.term === "agent") openTab(h, { cwd: s.cwd, title: s.title, agent: s.agent, sessionId: s.id, session: s });
    }
    for (const sh of h.shells) openTab(h, { cwd: sh.cwd, title: sh.title, owner: sh.owner || "" });
  }

  // owner: "" - the computer's own (a pane on its desktop); PHONE - opened from this phone.
  function openTab(h, { cwd, title, agent = "", sessionId = "", session = null, owner = "" }) {
    const id = uuid();
    const tab = { id, cwd, title, agent, sessionId, agentOnly: Boolean(agent), codexLog: "", pid: 10000 + Math.floor(Math.random() * 20000), owner, exited: false, lost: false, createdAt: Date.now(), note: "" };
    const t = { end: 0, watchers: 0 };
    const emitOut = data => {
      t.end += data.length;
      if (running && t.watchers) ev.emit("frame", { node: h.node.id, frame: { type: "output", id, data, end: t.end } });
    };
    t.impl = session ? agentTerm(h, session, emitOut) : shellTerm(h, cwd, emitOut);
    h.tabs.push(tab);
    h.terms.set(id, t);
    return tab;
  }
  const tabOut = (h, tab) => ({ ...tab, cols: h.terms.get(tab.id)?.impl.cols, rows: h.terms.get(tab.id)?.impl.rows });

  function snapshot(h) {
    return {
      registry: { projects: h.projects.map(p => ({ name: p.name, path: p.path })) },
      sessions: h.sessions.map(s => ({ id: s.id, agent: s.agent, cwd: s.cwd, title: s.title, prompt: "", projectName: h.projects.find(p => p.path === s.cwd)?.name, updatedAt: s.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      agents: h.agents, at: Date.now()
    };
  }
  function liveList(h) {
    return [...h.liveMap].map(([id, l]) => {
      const s = h.sessions.find(x => x.id === id);
      return { agent: s.agent, id, pid: l.pid || 0, procStart: "", cwd: s.cwd, name: "", kind: "", jobId: "", status: l.status, waitingFor: l.waitingFor || "",
        statusAt: l.statusAt, startedAt: l.startedAt || l.statusAt, activityAt: l.activityAt, subagents: [], jobs: [] };
    });
  }
  function preview(h, agent, id) {
    const s = h.sessions.find(x => x.agent === agent && x.id === id);
    if (!s) return null;
    const msgs = s.messages.map(([role, text], i) => ({ role, text, at: s.updatedAt - (s.messages.length - i) * 3 * MIN }));
    const shown = msgs.slice(-6);
    return { agent, id, startedAt: msgs[0]?.at || 0, lastAt: s.updatedAt, prompts: msgs.filter(m => m.role === "user").length, replies: msgs.filter(m => m.role === "assistant").length,
      model: agent === "Codex" ? "gpt-5.5-codex" : agent === "Claude" ? "claude-opus-5-5" : "", subagents: 0, firstPrompt: "", firstCut: false, more: msgs.length > 6, messages: shown };
  }

  const termOf = (h, id) => {
    const t = h.terms.get(id);
    if (!t) throw new Error("Not a terminal here.");
    return t;
  };
  function closeTab(h, id) {
    const tab = h.tabs.find(x => x.id === id);
    if (!tab) return;
    h.terms.get(id)?.impl.close();
    h.terms.delete(id);
    h.tabs = h.tabs.filter(x => x.id !== id);
    const s = h.sessions.find(x => x.id === tab.sessionId);
    if (s) h.setLive(s, null);
    ev.emit("notify", { node: h.node.id, event: "terminals", payload: h.tabs.map(x => tabOut(h, x)) });
  }

  const METHODS = {
    "host.info": h => ({ ...h.node, platform: h.platform, home: h.home, agents: h.agents }),
    "sessions.list": h => snapshot(h),
    "live.list": h => liveList(h),
    "terminals.list": h => h.tabs.map(x => tabOut(h, x)),
    "sessions.preview": (h, p) => preview(h, p.agent, p.id),
    "terminals.attach": (h, p) => {
      const t = termOf(h, p.id);
      t.watchers++;
      return { scrollback: t.impl.paint(), end: t.end, exitCode: null, cols: t.impl.cols, rows: t.impl.rows };
    },
    "terminals.detach": (h, p) => { const t = h.terms.get(p.id); if (t) t.watchers = Math.max(0, t.watchers - 1); return true; },
    "terminals.close": (h, p) => { closeTab(h, p.id); return true; },
    "terminals.send": (h, p) => { termOf(h, p.id).impl.send(String(p.text || "")); return true; },
    "sessions.stop": (h, p) => {
      const s = h.sessions.find(x => x.agent === p.agent && x.id === p.id);
      if (!s || !h.liveMap.has(s.id)) throw new Error("The session is not running.");
      h.setLive(s, null);
      return true;
    },
    "terminals.open": (h, p) => {
      const cwd = p.cwd;
      if (p.kind === "shell") {
        const tab = openTab(h, { cwd, title: cwd.split(/[\\/]/).pop(), owner: PHONE });
        ev.emit("notify", { node: h.node.id, event: "terminals", payload: h.tabs.map(x => tabOut(h, x)) });
        return tabOut(h, tab);
      }
      let s = p.kind === "resume" ? h.sessions.find(x => x.agent === p.agent && x.id === p.sessionId) : null;
      if (!s) {
        s = { id: uuid(), agent: p.agent || "Claude", cwd, title: (p.prompt || "").slice(0, 60) || `${p.agent} session`, updatedAt: Date.now(), messages: [] };
        h.sessions.push(s);
      }
      const tab = openTab(h, { cwd, title: s.title, agent: s.agent, sessionId: s.id, session: s, owner: PHONE });
      h.setLive(s, { status: "idle", startedAt: Date.now(), pid: 20000 + Math.floor(Math.random() * 9999) });
      h.touch(s);
      ev.emit("notify", { node: h.node.id, event: "terminals", payload: h.tabs.map(x => tabOut(h, x)) });
      if (p.prompt) setTimeout(() => h.terms.get(tab.id)?.impl.send(p.prompt), 600);
      return tabOut(h, tab);
    }
  };

  // The demo's clock: now and then a working session needs the user (the banner), and devws's external session
  // goes on working.
  function tick() {
    const h = hosts[0];
    const s = h.sessions.find(x => h.liveMap.get(x.id)?.status === "idle" && h.tabs.some(t => t.sessionId === x.id));
    if (!s) return;
    s.messages.push(["assistant", "The build needs to run again. May I?"]);
    h.setLive(s, { status: "waiting", waitingFor: "permission to run Bash: npm run apk" });
    h.touch(s);
    const tab = h.tabs.find(t => t.sessionId === s.id);
    h.terms.get(tab.id)?.impl.ask?.();
  }

  return {
    demo: true,
    id: PHONE,
    on: ev.on,
    async start() {
      running = true;
      timers.push(setInterval(tick, 45 * 1000), setTimeout(tick, 15 * 1000));
    },
    stop() {
      running = false;
      for (const t of timers.splice(0)) { clearInterval(t); clearTimeout(t); }
    },
    nodes: () => hosts.map(h => ({ ...h.node, lastSeen: h.node.status === "online" ? Date.now() : h.node.lastSeen })),
    async request(node, method, params = {}) {
      await new Promise(r => setTimeout(r, 60 + Math.random() * 120)); // a network's worth of delay
      const h = hostOf(node);
      if (!Object.hasOwn(METHODS, method)) throw new Error(`unknown method ${method}`);
      return METHODS[method](h, params);
    },
    sendFrame(node, frame) {
      const h = hosts.find(x => x.node.id === node);
      const t = h?.terms.get(frame.id);
      if (!t) return;
      if (frame.type === "input") t.impl.input(frame.data);
      else if (frame.type === "resize") {
        t.impl.resize(frame.cols, frame.rows);
        ev.emit("notify", { node, event: "terminal.size", payload: { id: frame.id, cols: frame.cols, rows: frame.rows } });
      }
    },
    async forget(node) {
      const i = hosts.findIndex(x => x.node.id === node);
      if (i >= 0) {
        for (const id of hosts[i].terms.keys()) hosts[i].terms.get(id).impl.close();
        hosts.splice(i, 1);
      }
      ev.emit("nodes", this.nodes());
    }
  };
}
