// One day of work read out of the Claude Code transcripts: per ticket (SC-1234 from the branch, folder or title) or
// else per project, the active time and the sessions, and on request a short summary of what was done, written by
// `claude -p` for the time log.
//
// Active time follows the messages: from one message to the next counts while the gap is at most GAP_MS, the last
// message of a stretch adds TAIL_MS. Sessions that ran side by side are counted once in a group's and the day's
// total (the stretches are merged), so the totals are wall-clock time.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const GAP_MS = 10 * 60 * 1000;
const TAIL_MS = 2 * 60 * 1000;
const PROMPTS_PER_SESSION = 6;
const DIGEST_CHARS = 40000;
const SUMMARY_TIMEOUT_MS = 120000;
const TICKET = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{2,})\b/;
const NOISE = /^(<command-|<local-command|Caveat:|\[Request interrupted)/;

const textOf = content => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(c => c?.type === "text").map(c => c.text || "").join("\n") : "";
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// "2026-10-26" -> [start, end) in local time.
function dayRange(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  const start = new Date(y, m - 1, d).getTime();
  return [start, new Date(y, m - 1, d + 1).getTime()];
}

// Stretches of activity from sorted timestamps.
function stretches(ts) {
  const out = [];
  for (const t of ts) {
    const last = out.at(-1);
    if (last && t - last[1] <= GAP_MS) last[1] = t;
    else out.push([t, t]);
  }
  return out.map(([a, b]) => [a, b + TAIL_MS]);
}
function union(spans) {
  const s = [...spans].sort((a, b) => a[0] - b[0]), out = [];
  for (const x of s) { const last = out.at(-1); if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([...x]); }
  return out;
}
const minutes = spans => Math.round(union(spans).reduce((m, [a, b]) => m + (b - a), 0) / 60000);

// Any KEY-123 in a branch or folder name (feature/SC-2457-x, wt-sc2672 via the known keys below); in a title or a
// prompt only the team's own Jira keys, which keeps SHA-256 and hex ids out.
const KNOWN = /(?:^|[^a-z0-9])(sc|prod|ort|vs|inc)-?(\d{2,})(?![0-9])/i;
function ticketOf({ strong = [], weak = [] }) {
  for (const t of strong) {
    const m = TICKET.exec(String(t || "").replace(/_/g, " "));
    if (m && /-/.test(m[0])) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  for (const t of [...strong, ...weak]) {
    const m = KNOWN.exec(String(t || ""));
    if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return "";
}

// One transcript's part in the day.
function readSession(s, start, end) {
  let raw;
  try { raw = fs.readFileSync(s.file, "utf8"); } catch { return null; }
  const ts = [], prompts = [];
  let branch = "", lastAnswer = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line || !line.includes('"timestamp"')) continue;
    let x; try { x = JSON.parse(line); } catch { continue; }
    const at = Date.parse(x.timestamp);
    if (!(at >= start && at < end) || (x.type !== "user" && x.type !== "assistant")) continue;
    ts.push(at);
    if (typeof x.gitBranch === "string" && x.gitBranch && x.gitBranch !== "HEAD") branch = x.gitBranch;
    if (x.type === "user" && !x.isMeta && !x.isSidechain) {
      const text = textOf(x.message?.content).trim();
      if (text && !NOISE.test(text) && prompts.length < PROMPTS_PER_SESSION) prompts.push(clip(text.replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, " "), 300));
    } else if (x.type === "assistant") {
      const text = textOf(x.message?.content).trim();
      if (text) lastAnswer = text;
    }
  }
  if (!ts.length) return null;
  ts.sort((a, b) => a - b);
  const spans = stretches(ts);
  return { agent: s.agent, id: s.id, title: s.title, cwd: s.cwd, branch, prompts, lastAnswer: clip(lastAnswer, 400), spans, minutes: minutes(spans), from: ts[0], to: ts.at(-1) };
}

// sessions: the scan's list; projects: the registry's. -> {date, minutes, groups: [{key, ticket, project, minutes,
// sessions: [...]}]}, the biggest group first.
function report({ date, sessions, projects }) {
  const [start, end] = dayRange(date);
  const norm = p => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const projectOf = cwd => {
    const n = norm(cwd);
    const p = [...(projects || [])].sort((a, b) => b.path.length - a.path.length).find(p => n === norm(p.path) || n.startsWith(norm(p.path) + "/"));
    return p?.name || path.basename(cwd || "") || "?";
  };
  const groups = new Map();
  for (const s of sessions || []) {
    if (s.agent !== "Claude" || !s.file || (s.updatedAt || 0) < start) continue;
    const r = readSession(s, start, end);
    if (!r) continue;
    const ticket = ticketOf({ strong: [r.branch, path.basename(r.cwd || "")], weak: [r.title, r.prompts[0]] });
    const project = projectOf(r.cwd);
    const key = ticket || `project:${project}`;
    if (!groups.has(key)) groups.set(key, { key, ticket, project, sessions: [] });
    groups.get(key).sessions.push(r);
  }
  const list = [...groups.values()].map(g => {
    g.sessions.sort((a, b) => a.from - b.from);
    return { ...g, minutes: minutes(g.sessions.flatMap(s => s.spans)) };
  }).sort((a, b) => b.minutes - a.minutes);
  return { date, minutes: minutes(list.flatMap(g => g.sessions.flatMap(s => s.spans))), groups: list };
}

// The report without some sessions ("Claude:<id>" keys) - the ones the menu hides - with the times counted again.
function exclude(rep, keys) {
  const drop = new Set(keys || []);
  const groups = rep.groups.map(g => {
    const sessions = g.sessions.filter(s => !drop.has(`${s.agent}:${s.id}`));
    return { ...g, sessions, minutes: minutes(sessions.flatMap(s => s.spans)) };
  }).filter(g => g.sessions.length).sort((a, b) => b.minutes - a.minutes);
  return { ...rep, groups, minutes: minutes(groups.flatMap(g => g.sessions.flatMap(s => s.spans))) };
}

const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

// What `claude -p` reads on stdin.
function digest(rep) {
  let out = `Ден: ${rep.date}. Общо активно време: ${hm(rep.minutes)}.\n`;
  for (const g of rep.groups) {
    out += `\n## ${g.ticket || g.project} (${hm(g.minutes)})${g.ticket ? ` - проект ${g.project}` : ""}\n`;
    for (const s of g.sessions) {
      out += `- Сесия „${clip(s.title, 120)}“${s.branch ? `, клон ${s.branch}` : ""}, ${hm(s.minutes)}\n`;
      for (const p of s.prompts) out += `  - поиска: ${p}\n`;
      if (s.lastAnswer) out += `  - последен отговор: ${s.lastAnswer}\n`;
    }
    if (out.length > DIGEST_CHARS) { out = out.slice(0, DIGEST_CHARS) + "\n…"; break; }
  }
  return out;
}

const INSTRUCTION = [
  "На stdin е дигест на работния ден на frontend разработчик: групи по Jira тикет (или проект) с активно време, сесиите с Claude Code, какво е поискал и последния отговор.",
  "Напиши обобщение за отчитане на времето в Jira, на български, по един ред на група, в реда на дигеста, в този формат:",
  "ТИКЕТ_ИЛИ_ПРОЕКТ (ч:мм) - какво е свършено, 1-2 кратки изречения в минало време, по същество.",
  "Само това, което личи от дигеста - без догадки и без измислени подробности. Без увод, без заключение, без Markdown заглавия, без удебеляване.",
  "Времената на групите може да се застъпват (паралелни сесии), затова сборът им може да е по-голям от общото време - това е нормално, не го коментирай."
].join(" ");

// claude: the claude executable. -> the summary text. Runs outside any project, without the user's settings (so no
// hooks or plugins of theirs run) and without saving a transcript.
function summarize(rep, { claude, model = "haiku" }) {
  if (!rep.groups.length) return Promise.resolve("");
  const cwd = path.join(os.tmpdir(), "agentdeck-summary");
  fs.mkdirSync(cwd, { recursive: true });
  const args = ["-p", "--setting-sources", "local", "--no-session-persistence", "--model", model, "--tools", "", "--strict-mcp-config", "--disable-slash-commands", INSTRUCTION];
  return new Promise((resolve, reject) => {
    const child = spawn(claude, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, SUMMARY_TIMEOUT_MS);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(clip(err || out || `exit ${code}`, 300)));
    });
    child.stdin.end(digest(rep));
  });
}

module.exports = { report, exclude, summarize, digest, dayRange, ticketOf };
