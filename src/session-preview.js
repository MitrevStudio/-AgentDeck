// What a session was about, for the preview beside the session lists: its last few prompts and replies (tool calls,
// their output and the agents' own bookkeeping left out), its first prompt, when it started and was last active, how
// many prompts and replies it has, the model and the subagents. Claude Code and Codex transcripts are read from the
// end backwards; the counts come from one pass over the file that later only reads what was appended. OpenCode's
// sessions come from its database, opened read-only. Every answer is kept until its file (or session) changes.
const fs = require("node:fs");
const path = require("node:path");
const { readAt } = require("./file-chunks");

const SHOW = 6;                   // messages in a preview
const TAIL = 256 * 1024;          // bytes read from the end of a transcript at a time ...
const TAIL_MAX = 16 * TAIL;       // ... and at most, when the end is mostly tool output
const HEAD = 64 * 1024;           // the same from the start, for the first prompt
const HEAD_MAX = 8 * HEAD;
const COUNT_CHUNK = 1024 * 1024;
const LINE_HEAD = 640;            // a line's first bytes tell what it is
const TEXT_MAX = 1500;            // characters of a message sent to the page; it clips them further
const CACHE_MAX = 300;

// Slash-command echoes, caveats and hook output are not something the user typed as a prompt (main.js's titles use
// the same rule).
const NOISE_PROMPT = /^\s*(<(local-command|command-|system-reminder|bash-|user-prompt-submit-hook)|Caveat:)/i;
function contentText(c) {
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.filter(v => v?.type === "text").map(v => v.text || "").join(" ") : "";
}

const clip = s => (s.length > TEXT_MAX ? { text: s.slice(0, TEXT_MAX), cut: true } : { text: s });
const parse = line => { try { return JSON.parse(line); } catch { return null; } };
const time = v => (typeof v === "number" ? v : Date.parse(v) || 0);

// ---------- Claude Code ----------
// A message worth showing, or null: tool calls and results, thinking, meta lines, subagent (sidechain) lines,
// compaction summaries, task notifications, interruptions and the noise above are left out.
function claudeMessage(x) {
  if (!x || x.isSidechain || x.isMeta || x.isCompactSummary) return null;
  const at = time(x.timestamp);
  if (x.type === "user") {
    if (x.origin && x.origin.kind !== "human") return null;
    const c = x.message?.content;
    if (Array.isArray(c) && c.some(b => b?.type === "tool_result")) return null;
    const text = contentText(c).trim();
    if (!text || NOISE_PROMPT.test(text) || /^(\[Request interrupted|<task-notification>)/.test(text)) return null;
    return { role: "user", text, at };
  }
  if (x.type === "assistant") {
    const text = contentText(x.message?.content).trim();
    if (!text || (x.message?.model === "<synthetic>" && text === "No response requested.")) return null;
    return { role: "assistant", text, at, id: x.message?.id || "" };
  }
  return null;
}
// From a line's first bytes: "user" or "assistant" when it may hold text worth parsing, "" when it cannot (tool calls,
// tool output, thinking, everything that is not a message). Spares parsing the bulk of a transcript.
const ROLE = /"role":"(user|assistant)","content":(.{0,40})/;
const NOT_TEXT = /^\[\{"(tool_use_id|type":"(tool_result|tool_use|thinking|redacted_thinking|image))/;
function claudeKind(head) {
  if (head.includes('"isSidechain":true')) return "";
  const m = ROLE.exec(head);
  return m && !NOT_TEXT.test(m[2]) ? m[1] : "";
}
const MODEL = /"model":"([^"]+)"/;
const MSG_ID = /"id":"([^"]+)"/;

const claude = {
  message: claudeMessage,
  // lines: Buffers, newest first. The text blocks of one reply are lines of their own, so they are joined again here.
  async tail(lines, out) {
    const msgs = [];
    for await (const line of lines) {
      const head = line.toString("latin1", 0, LINE_HEAD);
      if (!out.model && head.includes('"role":"assistant"')) { const m = MODEL.exec(head)?.[1]; if (m && m !== "<synthetic>") out.model = m; }
      if (!claudeKind(head)) continue;
      const m = claudeMessage(parse(line.toString("utf8")));
      if (!m) continue;
      const newer = msgs.at(-1);
      if (m.role === "assistant" && newer?.role === "assistant" && m.id && newer.id === m.id) { newer.text = `${m.text}\n\n${newer.text}`; continue; }
      if (msgs.length === SHOW) { out.more = true; break; }
      msgs.push(m);
    }
    return msgs;
  },
  // prompts: what the user typed; replies: the agent's messages with text.
  count(head, line, c) {
    const kind = claudeKind(head);
    if (kind === "assistant") {
      if (head.includes('"model":"<synthetic>"')) return; // written by Claude Code itself (interruptions, API errors)
      const id = MSG_ID.exec(head.slice(head.indexOf('"message":')))?.[1] || "";
      if (!id || id !== c.lastId) c.replies++;
      c.lastId = id;
    } else if (kind === "user" && claudeMessage(parse(line()))) c.prompts++;
  }
};

// ---------- Codex ----------
// Its rollout files carry each message twice: as a response item (with the injected environment and instructions)
// and as an event (what was typed and said). Events are used when there are any; older files have only items.
const CODEX_NOISE = /^\s*(<(environment_context|user_instructions|permissions|ide_context|turn_aborted|user_shell_command)|# AGENTS\.md instructions)/i;
function codexMessage(x) {
  if (!x) return null;
  const p = x.payload ?? x, at = time(x.timestamp);
  if (x.type === "event_msg") {
    const role = p.type === "user_message" ? "user" : p.type === "agent_message" ? "assistant" : "";
    const text = typeof p.message === "string" ? p.message.trim() : "";
    return role && text ? { role, text, at, event: true } : null;
  }
  if (p.type !== "message" || (p.role !== "user" && p.role !== "assistant")) return null;
  const text = (Array.isArray(p.content) ? p.content : []).map(c => c?.text || "").join("\n").trim();
  if (!text || (p.role === "user" && CODEX_NOISE.test(text))) return null;
  return { role: p.role, text, at, event: false };
}
const CODEX_LINE = /"(turn_context|user_message|agent_message)"|"type":"message"/;
const codex = {
  message: codexMessage,
  async tail(lines, out) {
    const events = [], items = [];
    for await (const line of lines) {
      if (!CODEX_LINE.test(line.toString("latin1", 0, LINE_HEAD))) continue; // tool calls and their output
      const x = parse(line.toString("utf8"));
      if (!x) continue;
      if (!out.model && x.type === "turn_context" && x.payload?.model) out.model = String(x.payload.model);
      const m = codexMessage(x);
      if (!m) continue;
      const list = m.event ? events : items;
      if (list.length === SHOW) { out.more = true; if (m.event) break; continue; }
      list.push(m);
    }
    return events.length ? events : items;
  },
  count(head, line, c) {
    if (!head.includes('"event_msg"')) return;
    if (head.includes('"type":"user_message"')) c.prompts++;
    else if (head.includes('"type":"agent_message"')) c.replies++;
  }
};

// ---------- reading ----------
// Complete lines (Buffers) from the end backwards, newest first; a line cut by where reading stopped is left out.
// A line longer than a chunk is put together only once its start is found.
async function* linesFromEnd(fh, size) {
  let end = size, parts = []; // the start of the line read so far: pieces from newer chunks, oldest first
  while (end > 0 && size - end < TAIL_MAX) {
    const start = Math.max(0, end - TAIL);
    const buf = await readAt(fh, start, end - start);
    let stop = buf.length;
    for (let nl; stop > 0 && (nl = buf.lastIndexOf(10, stop - 1)) >= 0; stop = nl) {
      let line = buf.subarray(nl + 1, stop);
      if (stop === buf.length && parts.length) { line = Buffer.concat([line, ...parts]); parts = []; }
      if (line.length) yield line;
    }
    parts.unshift(buf.subarray(0, stop));
    end = start;
  }
  if (end === 0) { const line = Buffer.concat(parts); if (line.length) yield line; }
}
// The first message the user typed, and the first timestamp.
async function readHead(fh, size, agent) {
  const out = { startedAt: 0, firstPrompt: "" };
  let pos = 0, carry = "";
  while (pos < size && pos < HEAD_MAX) {
    const buf = await readAt(fh, pos, Math.min(HEAD, size - pos));
    pos += buf.length;
    const lines = (carry + buf.toString("utf8")).split("\n");
    carry = pos < size ? lines.pop() : "";
    for (const line of lines) {
      const x = parse(line);
      if (!x) continue;
      if (!out.startedAt) out.startedAt = time(x.timestamp || x.payload?.timestamp);
      const m = agent.message(x);
      if (m?.role === "user") { out.firstPrompt = m.text; return out; }
    }
  }
  return out;
}
// Counts the lines appended since c.offset (complete lines only; a line still being written waits for next time).
async function count(fh, size, agent, c) {
  while (c.offset < size) {
    const buf = await readAt(fh, c.offset, Math.min(COUNT_CHUNK, size - c.offset));
    let end = buf.lastIndexOf(10) + 1;
    if (!end) {
      // One line longer than a chunk (tool output, an image): nothing to count in it, so it is skipped.
      if (c.offset + buf.length >= size) return;
      const next = await findNewline(fh, c.offset + buf.length, size);
      if (next < 0) return;
      c.offset = next + 1;
      continue;
    }
    for (let start = 0; start < end;) {
      const stop = buf.indexOf(10, start);
      const s = start;
      agent.count(buf.toString("latin1", s, Math.min(stop, s + LINE_HEAD)), () => buf.toString("utf8", s, stop), c);
      start = stop + 1;
    }
    c.offset += end;
  }
}
async function findNewline(fh, pos, size) {
  while (pos < size) {
    const buf = await readAt(fh, pos, Math.min(COUNT_CHUNK, size - pos));
    const i = buf.indexOf(10);
    if (i >= 0) return pos + i;
    pos += buf.length;
  }
  return -1;
}
async function subagentCount(file) {
  try { return (await fs.promises.readdir(path.join(file.slice(0, -".jsonl".length), "subagents"))).filter(f => f.endsWith(".jsonl")).length; }
  catch { return 0; }
}

// ---------- results ----------
const cache = new Map();   // file or "OpenCode:<id>" -> { stamp, result, ... }
const pending = new Map();
function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
function result(agentName, id, { head, counts, tail, subagents }) {
  const messages = tail.messages.reverse().map(m => ({ role: m.role, at: m.at, ...clip(m.text) }));
  // Shown apart only when it is not among the last messages anyway.
  const first = head.firstPrompt && !(messages[0]?.role === "user" && !tail.more && messages[0].text === clip(head.firstPrompt).text) ? clip(head.firstPrompt) : null;
  return {
    agent: agentName, id, startedAt: head.startedAt || messages[0]?.at || 0, lastAt: tail.lastAt || messages.at(-1)?.at || 0,
    prompts: counts ? counts.prompts : null, replies: counts ? counts.replies : null, model: tail.model || "",
    subagents, firstPrompt: first?.text || "", firstCut: Boolean(first?.cut), more: tail.more, messages
  };
}

async function fromTranscript(agentName, id, file) {
  const agent = agentName === "Codex" ? codex : claude;
  const st = await fs.promises.stat(file);
  let e = cache.get(file);
  if (e && e.size === st.size && e.mtime === st.mtimeMs) return e.result;
  if (e && st.size < e.counts.offset) e = null; // rewritten, not appended to
  const fh = await fs.promises.open(file, "r");
  try {
    const head = e?.head?.firstPrompt ? e.head : await readHead(fh, st.size, agent);
    const counts = e ? e.counts : { offset: 0, prompts: 0, replies: 0, lastId: "" };
    await count(fh, st.size, agent, counts);
    // The last write is the last activity (the session lists use it too).
    const tail = { lastAt: st.mtimeMs, model: "", more: false, messages: [] };
    tail.messages = await agent.tail(linesFromEnd(fh, st.size), tail);
    const subagents = agentName === "Claude" ? await subagentCount(file) : 0;
    const res = result(agentName, id, { head, counts, tail, subagents });
    remember(file, { size: st.size, mtime: st.mtimeMs, head, counts, result: res });
    return res;
  } finally { await fh.close(); }
}

// ---------- OpenCode ----------
// Messages are rows of `message` (role, model, times in data) with their text in `part` rows; a reply is counted per
// finished turn (finish "stop"), since every tool step of a turn is a message of its own.
function fromOpenCode(id, dbFile) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return null; }
  if (!fs.existsSync(dbFile)) return null;
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const s = db.prepare("SELECT time_created AS created, time_updated AS updated FROM session WHERE id = ?").get(id);
    if (!s) return null;
    const key = `OpenCode:${id}`, e = cache.get(key);
    if (e && e.updated === s.updated) return e.result;
    const recent = db.prepare("SELECT id, time_created AS at, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 40").all(id);
    const first = db.prepare("SELECT id, time_created AS at, data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created, id LIMIT 1").all(id);
    const rows = [...recent, ...first];
    const texts = new Map();
    if (rows.length) {
      const parts = db.prepare(`SELECT message_id AS m, data FROM part WHERE message_id IN (${rows.map(() => "?").join(",")}) AND json_extract(data, '$.type') = 'text' ORDER BY message_id, id`).all(...rows.map(r => r.id));
      for (const p of parts) {
        const d = parse(p.data);
        if (!d?.text?.trim() || d.synthetic || d.ignored) continue;
        texts.set(p.m, [texts.get(p.m), d.text.trim()].filter(Boolean).join("\n\n"));
      }
    }
    const tail = { lastAt: Number(s.updated) || 0, model: "", more: false, messages: [] };
    for (const r of recent) {
      const d = parse(r.data);
      if (!tail.model && d?.role === "assistant" && d.modelID) tail.model = String(d.modelID);
      const text = texts.get(r.id);
      if (!text || (d?.role !== "user" && d?.role !== "assistant")) continue;
      if (tail.messages.length === SHOW) { tail.more = true; break; }
      tail.messages.push({ role: d.role, text, at: Number(d.time?.created) || Number(r.at) || 0 });
    }
    const c = db.prepare(`SELECT sum(json_extract(data, '$.role') = 'user') AS prompts,
      sum(json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.finish') = 'stop') AS replies FROM message WHERE session_id = ?`).get(id);
    const subagents = db.prepare("SELECT count(*) AS n FROM session WHERE parent_id = ?").get(id).n;
    const head = { startedAt: Number(s.created) || 0, firstPrompt: first[0] ? texts.get(first[0].id) || "" : "" };
    const res = result("OpenCode", id, { head, counts: { prompts: Number(c.prompts) || 0, replies: Number(c.replies) || 0 }, tail, subagents: Number(subagents) || 0 });
    remember(key, { updated: s.updated, result: res });
    return res;
  } finally { db.close(); }
}

// ---------- entry ----------
// session: { agent, id, file } as main's scan found it; openCodeDb: where OpenCode keeps its database.
// Resolves to the preview, or null when there is nothing to read.
function preview(session, { openCodeDb } = {}) {
  const key = `${session.agent}:${session.id}`;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    if (session.agent === "OpenCode") return openCodeDb ? fromOpenCode(session.id, openCodeDb) : null;
    if (!session.file) return null;
    return fromTranscript(session.agent, session.id, session.file);
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

module.exports = { preview, NOISE_PROMPT, contentText, _test: { claudeMessage, codexMessage, linesFromEnd, readHead, count, claude, codex, cache } };
