// Words the dictation is likely to need right now, taken from the Claude Code session the user worked in last: its
// git branch, the ticket keys in it, its folder and the names of the files it touched most recently. They go to the
// transcription (Whisper's prompt, Gemini's custom vocabulary) and the rewrite after the user's own terms and the
// project names, so "бил детейлс" comes out as bill-details.
//
// Kept up to date in the background: the dictionary reads it synchronously at every attempt.
const fs = require("node:fs");
const path = require("node:path");

const EVERY_MS = 15000;
const TAIL_BYTES = 512 * 1024;
const MAX_TERMS = 20;
const MAX_FILES = 12;
const TICKET = /\b[A-Za-z][A-Za-z0-9]+-\d+\b/g;

const lastSign = l => Math.max(l.activityAt || 0, l.statusAt || 0);

function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size, len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return len < size ? text.slice(text.indexOf("\n") + 1) : text; // drop the cut first line
  } catch { return ""; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// "src/app/bill-details/bill-details.component.ts" -> "bill-details"
const stem = p => path.basename(String(p).replace(/[\\/]+$/, "")).split(".")[0];

// The terms of one transcript tail, newest first.
function termsOf(text, cwd) {
  const out = [], seen = new Set();
  const add = s => {
    const v = String(s || "").trim();
    if (v.length < 3 || v.length > 60 || !/\p{L}/u.test(v) || seen.has(v.toLowerCase())) return;
    seen.add(v.toLowerCase());
    out.push(v);
  };
  let branch = "", files = 0;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && (files < MAX_FILES || !branch); i--) {
    const line = lines[i];
    if (!line || (!line.includes('"gitBranch"') && !line.includes('"tool_use"'))) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    if (!branch && typeof x.gitBranch === "string" && x.gitBranch !== "HEAD") branch = x.gitBranch;
    for (const c of Array.isArray(x.message?.content) ? x.message.content : []) {
      if (c?.type !== "tool_use" || files >= MAX_FILES) continue;
      const p = c.input?.file_path || c.input?.notebook_path || c.input?.path;
      if (typeof p === "string" && p) { const before = out.length; add(stem(p)); if (out.length > before) files++; }
    }
  }
  const head = [];
  if (branch) {
    for (const m of branch.match(TICKET) || []) head.push(m.toUpperCase());
    head.push(branch);
  }
  if (cwd) head.push(path.basename(cwd));
  const files_ = out.splice(0);
  seen.clear();
  for (const v of [...head, ...files_]) add(v);
  return out.slice(0, MAX_TERMS);
}

// liveSessions() -> live.js entries; findTranscript(id) -> path.
function createVoiceContext({ liveSessions, findTranscript }) {
  let terms = [], timer = null, busy = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const list = (await liveSessions()).filter(l => l.agent === "Claude");
      if (!list.length) { terms = []; return; }
      const last = list.sort((a, b) => lastSign(b) - lastSign(a))[0];
      const file = findTranscript(last.id);
      terms = file ? termsOf(tail(file), last.cwd) : (last.cwd ? [path.basename(last.cwd)] : []);
    } catch (e) { console.error("Voice context failed:", e.message); } finally { busy = false; }
  }
  return {
    start() { if (!timer) { timer = setInterval(refresh, EVERY_MS); refresh(); } },
    terms: () => terms
  };
}

module.exports = { createVoiceContext, termsOf };
