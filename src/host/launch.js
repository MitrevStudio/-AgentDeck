// Starting the agents and shells on this host: the command each launch runs (a new session, one resumed, one on a
// ready prompt, one with a handoff), the checks before it (the agent, the session id, the folder, the transcript),
// a terminal of the host's own (terminals.js) with that command in it, moving a session out of another terminal
// (stop-session.ps1), and deleting a session. Where a terminal goes - a pane of the window, Windows Terminal - is
// the caller's business (main.js); the host only knows its own terminals.
//
// A command is a PowerShell line (Windows Terminal and the host's terminals both run PowerShell); it reaches the
// host's own terminals encoded, so nothing in it can break the command line.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const promptLaunch = require("./prompt-launch");
const { fail } = require("./errors");

const { psQuote } = promptLaunch;
const NEW_SESSION = { Claude: "claude", OpenCode: "opencode", Codex: "codex" };
const SESSION_ID = /^[\w.:-]{1,200}$/;
const STOP_SCRIPT = path.join(__dirname, "stop-session.ps1");
const HANDOFF_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

// Every launcher checks its own arguments, whoever calls it (IPC, voice commands, a peer): an inherited key such as
// "constructor" is no agent, and a ";" in a session id would split wt.exe's command line.
const isAgent = agent => typeof agent === "string" && Object.hasOwn(NEW_SESSION, agent);
const checkAgent = agent => { if (!isAgent(agent)) fail("unknownAgent"); };
const checkSessionId = id => { if (typeof id !== "string" || !SESSION_ID.test(id)) fail("invalidSession"); };
const isDir = p => { try { return typeof p === "string" && path.isAbsolute(p) && fs.statSync(p).isDirectory(); } catch { return false; } };
function agentCommand(agent, id) {
  if (agent === "OpenCode") return ["opencode", "--session", id];
  if (agent === "Claude") return ["claude", "--resume", id];
  if (agent === "Codex") return ["codex", "resume", id];
  return fail("unknownAgent");
}

// deps: dataDir (the prompt and handoff files); terminals (terminals.js); liveSessions(), findTranscript(id)
// (live.js); sessions (sessions.js, for a session's title and a rescan); log(line) (the launch log; never a prompt's
// text); noLauncher(exe): the text a terminal prints when an agent is not installed.
function createLaunch({ dataDir, terminals, liveSessions, findTranscript, sessions, log = () => {}, noLauncher = exe => `${exe} is not installed` }) {
  const PROMPTS_DIR = path.join(dataDir, "prompts");
  const HANDOFFS_DIR = path.join(dataDir, "handoffs");

  function getSessionTitle(agent, id) {
    return sessions.get()?.sessions.find(s => s.agent === agent && s.id === id)?.title || `${agent} ${id.slice(0, 8)}`;
  }
  function checkResumable(agent, id, cwd) {
    checkAgent(agent);
    checkSessionId(id);
    if (!isDir(cwd)) fail("sessionFolderUnknown");
    // Claude Code may have dropped the transcript since the scan; resuming it would only print "No conversation found".
    if (agent === "Claude" && !findTranscript(id)) {
      sessions.scan().catch(err => console.error("Scan failed:", err.message));
      fail("conversationMissing");
    }
  }

  // ---------- the commands ----------
  // Each answers { command, argv, meta: { title, agent, sessionId }, undo() }: command is the PowerShell line (Windows),
  // argv the program and its arguments as a pseudo terminal spawns them directly (Linux); undo() drops what the
  // command would have read (a prompt or handoff file) when the terminal never started. Both null: a plain shell.
  const none = () => {};
  function shellCommand() {
    return { command: null, argv: null, meta: {}, undo: none };
  }
  function newCommand(agent, cwd) {
    checkAgent(agent);
    return { command: "& " + psQuote(NEW_SESSION[agent]), argv: [NEW_SESSION[agent]], meta: { title: `${agent} · ${path.basename(cwd)}`, agent }, undo: none };
  }
  function resumeCommand(agent, id, cwd) {
    checkResumable(agent, id, cwd);
    const argv = agentCommand(agent, id);
    return { command: "& " + argv.map(psQuote).join(" "), argv, meta: { title: getSessionTitle(agent, id), agent, sessionId: id }, undo: none };
  }
  // A new session that starts on a prompt (voice commands, the command centre, a peer): the prompt travels in a file,
  // never on a command line. The terminal deletes the file once read; one whose terminal never started goes at once.
  function promptCommand(agent, cwd, prompt) {
    checkAgent(agent);
    const text = String(prompt ?? "").trim();
    if (!text) fail("invalidData");
    const meta = { title: `${agent} · ${path.basename(cwd)}`, agent };
    // A pseudo terminal takes the prompt as an argument as it is; only PowerShell needs the file.
    if (process.platform !== "win32") return { command: null, argv: [NEW_SESSION[agent], ...(agent === "OpenCode" ? ["--prompt"] : []), text], meta, undo: none };
    const file = promptLaunch.writePrompt(PROMPTS_DIR, text);
    return {
      command: promptLaunch.command(agent, NEW_SESSION[agent], file, noLauncher(NEW_SESSION[agent])), argv: null, meta,
      undo: () => { promptLaunch.remove(file); promptLaunch.sweep(PROMPTS_DIR); }
    };
  }
  // Continue fresh: a new Claude session that starts with the earlier one's handoff in its system prompt (Claude Code
  // keeps it for later resumes too), so nothing is pasted or sent.
  function handoffCommand(cwd, handoff) {
    promptLaunch.sweep(HANDOFFS_DIR, { maxAge: HANDOFF_KEEP_MS });
    fs.mkdirSync(HANDOFFS_DIR, { recursive: true });
    const file = path.join(HANDOFFS_DIR, `prompt-${crypto.randomBytes(8).toString("hex")}.txt`);
    fs.writeFileSync(file, handoff);
    const argv = [NEW_SESSION.Claude, "--append-system-prompt-file", file];
    return { command: "& " + argv.map(psQuote).join(" "), argv, meta: { title: `Claude · ${path.basename(cwd)}`, agent: "Claude" }, undo: () => promptLaunch.remove(file) };
  }
  // The command for a launch described as data (what a peer or the command centre asks for):
  // kind "shell" | "new" | "resume" | "prompt" | "handoff".
  function commandFor({ kind, agent, sessionId, prompt, handoff }, cwd) {
    switch (kind) {
      case "shell": return shellCommand();
      case "new": return newCommand(agent, cwd);
      case "resume": return resumeCommand(agent, sessionId, cwd);
      case "prompt": return promptCommand(agent, cwd, prompt);
      case "handoff": return handoffCommand(cwd, handoff);
      default: return fail("invalidData");
    }
  }

  // ---------- the host's own terminals ----------
  // A terminal of the host's own with the command in it (null: a shell): on Windows the PowerShell line `command`
  // (DockPty, terminals.js), elsewhere the program of `argv` (terminals-pty.js). env: already prepared by
  // terminal-env.js. how: for the launch log.
  async function openTerminal(cwd, command, meta, env, how, argv = null) {
    if (!isDir(cwd)) fail("folderMissing");
    const encoded = command ? Buffer.from(command, "utf16le").toString("base64") : "";
    const commandLine = command ? `powershell.exe -NoLogo -NoExit -EncodedCommand ${encoded}` : "powershell.exe -NoLogo";
    const id = await terminals.open({ cwd, commandLine, argv, title: meta.title || path.basename(cwd), agent: meta.agent, sessionId: meta.sessionId, owner: meta.owner, env });
    log(`agentdeck ${how}`, `cwd="${cwd}" cmd=${command ? `"${command.slice(0, 120)}"` : "-"}`);
    return id;
  }
  // Prompts of launches whose terminal never started (a start that was cut short).
  function sweepPrompts() {
    promptLaunch.sweep(PROMPTS_DIR);
  }

  // ---------- moving a session here ----------
  // "Move here": a session running in another terminal is stopped there (its terminal modes reset) so the caller can
  // resume it in a terminal of the host's own. Not while it works - that would cut the turn off. Answers the session's
  // live entry (its folder is where it resumes).
  // entry: the session's live registry entry; its procStart tells a recycled pid from the session's own process.
  function stopExternalSession(entry) {
    const start = /^\d+$/.test(entry.procStart) ? entry.procStart : "";
    const script = `$ClaudePid = ${Number(entry.pid)}\n$ClaudeStart = '${start}'\n$AgentDeckPid = ${process.pid}\n${fs.readFileSync(STOP_SCRIPT, "utf8")}`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return new Promise(resolve => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 20000 }, err => resolve(err ? err.code ?? 1 : 0));
    });
  }
  async function takeOverSession(agent, id) {
    checkAgent(agent);
    checkSessionId(id);
    const entry = (await liveSessions()).find(l => l.agent === agent && l.id === id);
    if (!entry) fail("moveNotRunning");
    if (entry.status === "busy") fail("moveBusy");
    // Checked before the session is stopped: one that cannot be resumed (no prompt sent yet) keeps running where it is.
    if (agent === "Claude" && !findTranscript(id)) fail("moveNoConversation");
    checkResumable(agent, id, entry.cwd);
    const code = await stopExternalSession(entry);
    if (code === 4) fail("moveHostsAgentDeck");
    if (code !== 0 && code !== 3) fail("moveStopFailed");
    return entry;
  }

  // ---------- deleting ----------
  // A Claude or Codex transcript goes through trash(file) (the Recycle Bin on a desktop; a Claude session's folder of
  // subagent and tool-result files with it), only from the agent's own folder; an OpenCode session is deleted by its
  // CLI, for good. A session open in a terminal is refused. A transcript already gone (Claude Code drops those older
  // than cleanupPeriodDays, possibly after the last scan) only leaves the list.
  async function deleteSession(agent, id, trash) {
    checkAgent(agent);
    checkSessionId(id);
    if ((await liveSessions()).some(l => l.agent === agent && l.id === id)) fail("sessionRunning");
    if (agent === "OpenCode") {
      if (!/^[\w-]+$/.test(id)) fail("invalidSession");
      await sessions.runOpenCode(["session", "delete", id], path.dirname(sessions.CLAUDE_DIR), 15000);
    } else {
      const root = agent === "Claude" ? sessions.CLAUDE_DIR : sessions.CODEX_DIR;
      const s = sessions.get()?.sessions.find(x => x.agent === agent && x.id === id);
      const file = s?.file || (agent === "Claude" ? findTranscript(id) : "");
      const rel = file ? path.relative(root, file) : "";
      if (file && (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !file.endsWith(".jsonl"))) fail("sessionNoFile");
      if (file && fs.existsSync(file)) await trash(file);
      const extra = file ? file.slice(0, -".jsonl".length) : "";
      if (agent === "Claude" && isDir(extra)) await trash(extra);
    }
    sessions.forget(agent, id);
  }

  return {
    NEW_SESSION, SESSION_ID, isAgent, checkAgent, checkSessionId, checkResumable, agentCommand, getSessionTitle, isDir,
    shellCommand, newCommand, resumeCommand, promptCommand, handoffCommand, commandFor,
    openTerminal, sweepPrompts, takeOverSession, deleteSession
  };
}

module.exports = { createLaunch, NEW_SESSION, SESSION_ID, isAgent, agentCommand };
