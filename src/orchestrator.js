// The command centre: a Claude Code session of AgentDeck's own that takes what the user says (a voice command,
// voice/command-runner.js) or types (the edge menu's command field, or its own terminal) - "отвори BDD и ми кажи
// колко тикета са отворени" - and does it with the tools AgentDeck serves it over MCP: the projects and sessions,
// starting a session on a prompt, typing into a running one, waiting for its answer and reading it, showing things
// in the window. It runs in a terminal tab of its own in the "orchestrator" space (the card above the projects in the
// sidebar), in a folder of its own under userData with the CLAUDE.md written here; its transcript is the history,
// and the next start resumes it.
//
// MCP: Streamable HTTP on 127.0.0.1, JSON answers only (no event stream), behind a bearer token. Port and token are
// kept in orchestrator/mcp.json, which Claude Code reads through --mcp-config, so a session that outlived a restart
// of AgentDeck finds the server again on the same port.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isObj } = require("./voice/util");

const SPACE = "orchestrator";
const SESSION_NAME = "AgentDeck";
const AGENTS = ["Claude", "Codex", "OpenCode"];
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;
const POLL_MS = 1500;
const ENTER_DELAY_MS = 400;     // the text first, Enter a moment later (as autopilot.js types)
const READY_WAIT_MS = 45000;    // a Claude Code just started takes a while before it reads its input
const STARTED_WAIT_MS = 30000;  // for a new session to register itself (live.js)
const SETTLE_MS = 20000;        // a session idle this long after a wait began has nothing more to say
const DEFAULT_WAIT_S = 600, MAX_WAIT_S = 1800;
const ANSWER_WAIT_MS = 30 * 60 * 1000;
const NOTIFY_CHARS = 240;
const TEXT_MAX = 20000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const str = (v, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clampInt = (v, min, max, fallback) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback);
const iso = ms => (ms ? new Date(ms).toISOString() : null);
const clip = (s, n) => { const f = String(s ?? "").replace(/\s+/g, " ").trim(); return f.length > n ? f.slice(0, n - 1) + "…" : f; };
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
// A promise of the first truthy answer of `check` (asked every POLL_MS), or null once `ms` passed.
async function waitFor(check, ms) {
  const from = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - from > ms) return null;
    await sleep(POLL_MS);
  }
}

// What the orchestrator is told (its CLAUDE.md). Rewritten on every start, so it follows the app.
function instructions() {
  return `# AgentDeck command centre

You are the command centre of AgentDeck, a Windows launcher for AI coding sessions (Claude Code, Codex, OpenCode).
The user talks to you by voice (a raw speech-to-text transcript, in Bulgarian, English or both, with names possibly
misheard) or by typing. You do not do the work yourself: you open projects, start sessions on a prompt, type into
running sessions, wait for their answers and report back - all through the \`agentdeck\` tools.

## How to act

- Answer in the language the user used. Be brief: what you did, and what came back. No preamble, no sign-off.
- Find the project the user names with list_projects. Speech recognition misspells names: pick the closest one.
  When two fit about equally, ask which.
- "Open X and tell me ...", "ask X ...": start_session in X with a clear prompt in the user's language that asks for
  a concise answer, then wait_for_session and report the answer in your own words, short. Pass the user's request on
  faithfully; do not add tasks of your own.
- "Open X and do ...": start_session in X with the task as the user said it (cleaned up, not reworded), then tell the
  user it runs. Wait for it only when the user wants the result.
- "Open the session about ...", "continue ...": list_sessions in that project, then show_session for one that runs,
  or send_to_session for one open in an AgentDeck tab. A stopped session cannot be continued from here: say so, and
  offer a new session.
- A session that waits on the user (status "waiting") needs them, not you: show_session and say what it waits for.
- Only session ids and project paths the tools returned exist; never make one up. Never start a session in a project
  the user did not name.
- You have no shell and no file tools on purpose: delegate to a session.
`;
}

// deps: userData, version; terminals (terminals.js); workspace (workspace.js); liveSessions(); findTranscript(id);
// data() -> the scan ({registry, sessions}); preview(session, opts) (session-preview.js); norm(path);
// openTerminal(cwd, command, meta) -> terminal id (the terminal only; the orchestrator places it);
// launchNew(agent, cwd, prompt); focusSession({agent, id}); showSpace(key); showTab(id);
// balloon(text, {onClick}); managerInFront(); t.
function createOrchestrator(deps) {
  const dir = path.join(deps.userData, "orchestrator");
  const mcpFile = path.join(dir, "mcp.json"), stateFile = path.join(dir, "state.json"), claudeMd = path.join(dir, "CLAUDE.md");
  let server = null, port = 0, token = "";
  let state = { sessionId: "" };
  let answerWatch = null; // the tab id whose next answer is announced

  const isOwn = cwd => typeof cwd === "string" && deps.norm(cwd) === deps.norm(dir);
  const getTab = () => deps.terminals.getTabs().find(x => isOwn(x.cwd) && !x.exited) || null;
  const tabOf = id => deps.terminals.getTabs().find(x => x.sessionId === id && !x.exited) || null;
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state));

  // ---------- the server ----------
  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handleRequest);
      s.once("error", e => { s.close(); reject(e); });
      s.listen(p, "127.0.0.1", () => { server = s; resolve(s.address().port); });
    });
  }
  async function start() {
    fs.mkdirSync(dir, { recursive: true });
    const saved = readJson(stateFile);
    state = { sessionId: typeof saved?.sessionId === "string" ? saved.sessionId : "" };
    const mcp = readJson(mcpFile)?.mcpServers?.agentdeck;
    const auth = String(mcp?.headers?.Authorization || "");
    let savedPort = 0;
    try { savedPort = Number(new URL(mcp.url).port) || 0; } catch {}
    token = /^Bearer [0-9a-f]{48}$/.test(auth) ? auth.slice(7) : crypto.randomBytes(24).toString("hex");
    port = await listen(savedPort).catch(() => listen(0));
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { agentdeck: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }, null, 2));
    fs.writeFileSync(claudeMd, instructions());
  }
  function stop() {
    server?.close();
    server = null;
  }
  function answer(res, code, body) {
    const text = JSON.stringify(body);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  }
  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  function handleRequest(req, res) {
    if (req.headers.authorization !== `Bearer ${token}`) return answer(res, 401, { error: "unauthorized" });
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) req.destroy(); else chunks.push(c);
    });
    req.on("end", async () => {
      let msg;
      try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return answer(res, 400, rpcError(null, -32700, "parse error")); }
      const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(handleMessage))).filter(Boolean);
      if (!replies.length) { res.writeHead(202); return res.end(); }
      answer(res, 200, Array.isArray(msg) ? replies : replies[0]);
    });
  }
  async function handleMessage(m) {
    if (!isObj(m) || m.jsonrpc !== "2.0") return rpcError(null, -32600, "invalid request");
    if (m.id === undefined) return null; // a notification
    const reply = result => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize": {
        const v = m.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0], capabilities: { tools: {} }, serverInfo: { name: "agentdeck", version: deps.version } });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = TOOLS.find(x => x.name === m.params?.name);
        if (!tool) return rpcError(m.id, -32602, `unknown tool ${m.params?.name}`);
        try {
          const out = await tool.run(isObj(m.params.arguments) ? m.params.arguments : {});
          return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return reply({ content: [{ type: "text", text: e?.message || String(e) }], isError: true });
        }
      }
      default: return rpcError(m.id, -32601, `unknown method ${m.method}`);
    }
  }

  // ---------- the tools ----------
  const inFolder = (cwd, n) => typeof cwd === "string" && (deps.norm(cwd) === n || deps.norm(cwd).startsWith(n + "/"));
  const statusOf = l => (!l ? "stopped" : l.status === "busy" ? "working" : l.status === "idle" ? "idle" : l.status === "waiting" ? "waiting" : "starting");
  const projectOf = (data, cwd) => (data.registry?.projects || []).filter(p => inFolder(cwd, deps.norm(p.path))).sort((a, b) => b.path.length - a.path.length)[0] || null;
  // The project named or pointed at; the names may come misspelled from speech recognition, so a part of one counts.
  function resolveProject(data, text) {
    const q = str(text, 1000);
    if (!q) throw new Error("project is required: a name or a path from list_projects");
    const projects = (data.registry?.projects || []).filter(p => !isOwn(p.path));
    const low = q.toLowerCase();
    const tries = [
      p => deps.norm(p.path) === deps.norm(q),
      p => p.name.toLowerCase() === low,
      p => path.basename(p.path).toLowerCase() === low,
      p => p.name.toLowerCase().includes(low) || path.basename(p.path).toLowerCase().includes(low)
    ];
    for (const fits of tries) {
      const hits = projects.filter(fits);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error(`Several projects match "${q}": ${hits.map(p => `${p.name} (${p.path})`).join(", ")}. Pass the path.`);
    }
    throw new Error(`No project matches "${q}". Use list_projects and pass a name or a path from it.`);
  }
  async function findSession(id) {
    if (!id) throw new Error("session is required: a sessionId from list_sessions or start_session");
    const data = await deps.data();
    const s = data.sessions.find(x => x.id === id);
    if (s) return s;
    const l = (await deps.liveSessions()).find(x => x.id === id);
    if (l) return { agent: l.agent, id, cwd: l.cwd, file: deps.findTranscript(id) };
    const file = deps.findTranscript(id);
    if (file) return { agent: "Claude", id, cwd: "", file };
    throw new Error(`No session ${id}.`);
  }
  function typeLine(tabId, text) {
    deps.terminals.type(tabId, text);
    setTimeout(() => deps.terminals.type(tabId, "\r"), ENTER_DELAY_MS);
  }

  async function listProjects() {
    const [data, live] = await Promise.all([deps.data(), deps.liveSessions()]);
    return (data.registry?.projects || []).filter(p => !isOwn(p.path)).map(p => {
      const n = deps.norm(p.path);
      const sessions = data.sessions.filter(s => inFolder(s.cwd, n));
      return { name: p.name, path: p.path, sessions: sessions.length, lastActivity: iso(Math.max(0, ...sessions.map(s => s.updatedAt || 0))),
        running: live.filter(l => inFolder(l.cwd, n)).length };
    });
  }
  async function listSessions({ project, limit }) {
    const [data, live] = await Promise.all([deps.data(), deps.liveSessions()]);
    const p = project ? resolveProject(data, project) : null;
    const n = p ? deps.norm(p.path) : "";
    const liveBy = new Map(live.map(l => [l.id, l]));
    const known = new Set(data.sessions.map(s => s.id));
    // Running without a transcript yet: nothing sent so far.
    const fresh = live.filter(l => !known.has(l.id) && !isOwn(l.cwd)).map(l => ({ agent: l.agent, id: l.id, cwd: l.cwd, title: "", prompt: "", updatedAt: l.startedAt }));
    const list = [...data.sessions, ...fresh].filter(s => !isOwn(s.cwd) && (!n || inFolder(s.cwd, n)))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, clampInt(limit, 1, 50, 15));
    return list.map(s => ({
      sessionId: s.id, agent: s.agent, project: projectOf(data, s.cwd)?.name || null, folder: s.cwd || null,
      title: s.title || "(new, nothing sent yet)", firstPrompt: clip(s.prompt, 160) || null, lastActivity: iso(s.updatedAt),
      status: statusOf(liveBy.get(s.id)), inAgentDeckTab: Boolean(tabOf(s.id))
    }));
  }
  async function startSession({ project, prompt, agent }) {
    const data = await deps.data();
    const p = resolveProject(data, project);
    const a = AGENTS.includes(agent) ? agent : "Claude";
    const text = str(prompt, TEXT_MAX);
    if (!text) throw new Error("prompt is required");
    const since = Date.now();
    await deps.launchNew(a, p.path, text);
    if (a !== "Claude") return { started: true, agent: a, project: p.name, sessionId: null, note: `${a} reports no live status; find the session later with list_sessions.` };
    const l = await waitFor(async () => (await deps.liveSessions()).find(x => x.agent === "Claude" && inFolder(x.cwd, deps.norm(p.path)) && x.startedAt >= since - 5000), STARTED_WAIT_MS);
    return { started: true, agent: a, project: p.name, sessionId: l?.id || null,
      note: l ? "wait_for_session with this sessionId brings its answer." : "The session has not registered yet; list_sessions will show it." };
  }
  async function sendToSession({ session, text }) {
    const id = str(session, 200), line = str(text, TEXT_MAX).replace(/\s*\n\s*/g, " ");
    if (!line) throw new Error("text is required");
    const tab = tabOf(id);
    if (!tab) throw new Error("That session is not open in an AgentDeck tab, so nothing can be typed into it. Running elsewhere: ask the user to move it here; stopped: start_session with a new prompt.");
    typeLine(tab.id, line);
    return { sent: true, sessionId: id, note: "wait_for_session brings the answer." };
  }
  async function readSession({ session, count }) {
    const id = str(session, 200);
    const s = await findSession(id);
    const l = (await deps.liveSessions()).find(x => x.id === id) || null;
    const pv = await deps.preview(s, { textMax: TEXT_MAX });
    const n = clampInt(count, 1, 6, 2);
    return { sessionId: id, agent: s.agent, status: statusOf(l), waitingFor: l?.waitingFor || undefined,
      messages: (pv?.messages || []).slice(-n).map(m => ({ role: m.role, at: iso(m.at), text: m.text })) };
  }
  // Until the session answered (idle after working, or waiting on the user), ended, or the time ran out.
  async function waitForSession({ session, timeoutSeconds }) {
    const id = str(session, 200);
    const limit = clampInt(timeoutSeconds, 5, MAX_WAIT_S, DEFAULT_WAIT_S) * 1000;
    const from = Date.now();
    let sawWork = false;
    const done = async (status, extra = {}) => {
      let r = { sessionId: id, status, messages: [] };
      try { r = await readSession({ session: id, count: 2 }); } catch {}
      return { ...r, status, ...extra };
    };
    for (;;) {
      const l = (await deps.liveSessions()).find(x => x.id === id);
      const waited = Date.now() - from;
      if (!l) {
        if (sawWork || waited > SETTLE_MS) return done("ended", { note: "The session is not running any more." });
      } else if (l.status === "busy") {
        sawWork = true;
      } else if (l.status === "waiting") {
        return done("waiting", { waitingFor: l.waitingFor || "", note: "The session needs the user: show_session and tell them." });
      } else if (l.status === "idle" && (sawWork || waited > SETTLE_MS)) {
        return done("idle");
      }
      if (waited > limit) return done(l ? statusOf(l) : "unknown", { timedOut: true, note: "Still working when the time ran out; wait_for_session again, or read_session later." });
      await sleep(POLL_MS);
    }
  }
  async function showProject({ project }) {
    const p = resolveProject(await deps.data(), project);
    deps.showSpace(deps.norm(p.path));
    return { shown: p.name };
  }
  async function showSession({ session }) {
    const s = await findSession(str(session, 200));
    const r = await deps.focusSession({ agent: s.agent, id: s.id });
    return { shown: Boolean(r?.ok), reason: r?.reason || undefined };
  }

  const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const TOOLS = [
    { name: "list_projects", description: "The user's projects: name, folder, how many sessions each has, when it was last active and how many sessions run in it now.",
      inputSchema: obj({}), run: listProjects },
    { name: "list_sessions", description: "Recent sessions, newest first, with their status (working, idle, waiting on the user, stopped). Optionally only those of one project.",
      inputSchema: obj({ project: { type: "string", description: "A project name or path from list_projects" }, limit: { type: "integer", description: "At most this many (default 15)" } }), run: listSessions },
    { name: "start_session", description: "Starts a new agent session in a project on the given prompt and answers with its sessionId once it registered. The session opens in AgentDeck for the user to see.",
      inputSchema: obj({ project: { type: "string", description: "A project name or path from list_projects" }, prompt: { type: "string", description: "What the session should do, in the user's language" },
        agent: { type: "string", enum: AGENTS, description: "Claude unless the user names another" } }, ["project", "prompt"]), run: startSession },
    { name: "send_to_session", description: "Types a message into a session that runs in an AgentDeck tab and sends it.",
      inputSchema: obj({ session: { type: "string", description: "Its sessionId" }, text: { type: "string" } }, ["session", "text"]), run: sendToSession },
    { name: "wait_for_session", description: "Waits until the session has answered (or needs the user, or ended) and returns its last messages. Default 10 minutes.",
      inputSchema: obj({ session: { type: "string", description: "Its sessionId" }, timeoutSeconds: { type: "integer", description: "5 to 1800" } }, ["session"]), run: waitForSession },
    { name: "read_session", description: "The last messages of a session (the user's prompts and the agent's replies, no tool output), newest last.",
      inputSchema: obj({ session: { type: "string", description: "Its sessionId" }, count: { type: "integer", description: "1 to 6 messages (default 2)" } }, ["session"]), run: readSession },
    { name: "show_project", description: "Shows the project in AgentDeck's window.",
      inputSchema: obj({ project: { type: "string", description: "A project name or path from list_projects" } }, ["project"]), run: showProject },
    { name: "show_session", description: "Brings a running session's terminal in front of the user.",
      inputSchema: obj({ session: { type: "string", description: "Its sessionId" } }, ["session"]), run: showSession }
  ];

  // ---------- the orchestrator's own terminal ----------
  function command() {
    const resume = state.sessionId && deps.findTranscript(state.sessionId) ? ["--resume", state.sessionId] : [];
    return ["claude", "--name", SESSION_NAME, "--restricted", "--strict-mcp-config", "--mcp-config", mcpFile, "--allowedTools", "mcp__agentdeck", ...resume];
  }
  // The terminal, running or opened now; `place`: into its space as a tab (not while a saved layout puts it back).
  async function open(place = true) {
    const running = getTab();
    if (running) return running.id;
    const args = command();
    const id = await deps.openTerminal(dir, args, { title: deps.t("centre.title"), agent: "Claude", sessionId: args.includes("--resume") ? state.sessionId : "" });
    if (place) deps.workspace.addTab(SPACE, id);
    return id;
  }
  // terminals.js changed: the session the terminal got (tab-links.js) is remembered for the next start.
  function terminalsChanged() {
    const tab = getTab();
    if (tab?.sessionId && tab.sessionId !== state.sessionId) {
      state.sessionId = tab.sessionId;
      try { saveState(); } catch (e) { console.error("Saving the command centre's session failed:", e.message); }
    }
  }
  async function isReady(tabId) {
    const tab = deps.terminals.getTabs().find(x => x.id === tabId);
    if (!tab || tab.exited) return true; // nothing to wait for
    if (!tab.sessionId) return false;
    const l = (await deps.liveSessions()).find(x => x.id === tab.sessionId);
    return Boolean(l && l.status !== "running");
  }
  // What the user said or typed goes into the terminal (started first when it does not run), and the window shows
  // it. Its answer is announced when the window is not in front.
  async function send(text) {
    const line = str(text, TEXT_MAX).replace(/\s*\n\s*/g, " ");
    if (!line) return { ok: false };
    const started = !getTab();
    const id = await open();
    deps.showTab(id);
    await waitFor(() => isReady(id), READY_WAIT_MS);
    typeLine(id, line);
    watchAnswer(id);
    return { ok: true, started };
  }
  async function watchAnswer(tabId) {
    const mark = answerWatch = {};
    const from = Date.now();
    let sawWork = false;
    while (answerWatch === mark && Date.now() - from < ANSWER_WAIT_MS) {
      await sleep(POLL_MS);
      const tab = deps.terminals.getTabs().find(x => x.id === tabId);
      if (!tab || tab.exited || !tab.sessionId) continue;
      const l = (await deps.liveSessions()).find(x => x.id === tab.sessionId);
      if (l?.status === "busy") { sawWork = true; continue; }
      if (!sawWork || !l || l.status !== "idle") continue;
      if (answerWatch !== mark) return;
      answerWatch = null;
      if (deps.managerInFront()) return;
      try {
        const pv = await deps.preview({ agent: "Claude", id: tab.sessionId, file: deps.findTranscript(tab.sessionId) }, { textMax: TEXT_MAX });
        const last = (pv?.messages || []).filter(m => m.role === "assistant").at(-1);
        if (last?.text) deps.balloon(clip(last.text, NOTIFY_CHARS), { onClick: () => deps.showTab(tabId) });
      } catch (e) { console.error("Reading the command centre's answer failed:", e.message); }
      return;
    }
  }

  return { SPACE, dir, start, stop, isOwn, getTab, open, send, terminalsChanged, instructions };
}

module.exports = { createOrchestrator, SPACE };
