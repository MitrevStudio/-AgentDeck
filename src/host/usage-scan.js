// Turns agent transcripts into token records and sums them up per session, day and model. Pure functions: the
// worker (usage-worker.js) does the file and database access, and keeps what these return in its cache.
//
// A record: [key, time (ms), model, input, output, cacheWrite5m, cacheWrite1h, cacheRead, flags, reportedCost]
// - input excludes cache reads and writes; output includes reasoning.
// - key dedupes: Claude Code writes one line per content block of a reply, all carrying the reply's usage (output
//   still growing while it streams), and a resumed or forked session copies earlier replies into its new file.
const prices = require("./usage-prices");
const context = require("./session-context");

const K = 0, TIME = 1, MODEL = 2, IN = 3, OUT = 4, W5 = 5, W1 = 6, READ = 7, FLAGS = 8, REPORTED = 9;
const FAST = 1, GEO_US = 2, SIDE = 4; // SIDE: a subagent's reply, not the session's own conversation
const n = v => (Number.isFinite(v) && v > 0 ? v : 0);

// Complete lines only: a line still being written stays for the next pass. Calls fn(line) for each line containing
// one of `needles` near enough to its start (`within` bytes; Infinity = anywhere), and returns the bytes consumed.
function eachLine(buf, needles, within, fn) {
  const end = buf.lastIndexOf(10) + 1;
  if (within === Infinity) {
    // Jump from match to match: most of a transcript's bytes are tool output that never needs decoding.
    const next = needles.map(needle => buf.indexOf(needle));
    for (let pos = 0; pos < end;) {
      const at = Math.min(...next.filter(i => i >= pos));
      if (!Number.isFinite(at) || at >= end) break;
      const start = buf.lastIndexOf(10, at) + 1;
      const stop = buf.indexOf(10, at);
      fn(buf.toString("utf8", Math.max(start, pos), stop));
      pos = stop + 1;
      for (let i = 0; i < next.length; i++) if (next[i] >= 0 && next[i] < pos) next[i] = buf.indexOf(needles[i], pos);
    }
    return end;
  }
  for (let start = 0; start < end;) {
    const stop = buf.indexOf(10, start);
    const head = buf.toString("latin1", start, Math.min(stop, start + within));
    if (needles.some(s => head.includes(s))) fn(buf.toString("utf8", start, stop));
    start = stop + 1;
  }
  return end;
}
const parse = line => { try { return JSON.parse(line); } catch { return null; } };

// Two copies of one reply: the most complete numbers of each.
function merge(into, rec) {
  for (let i = IN; i <= READ; i++) into[i] = Math.max(into[i], rec[i]);
  into[REPORTED] = Math.max(into[REPORTED] || 0, rec[REPORTED] || 0);
  return into;
}
function put(msgs, rec) {
  const had = msgs.get(rec[K]);
  msgs.set(rec[K], had ? merge(had, rec) : rec);
}

// ---------- Claude Code ----------
function claudeRecord(x) {
  const m = x?.message, u = m?.usage;
  if (x.type !== "assistant" || !u || typeof u !== "object") return null;
  const written = n(u.cache_creation_input_tokens);
  const w1 = n(u.cache_creation?.ephemeral_1h_input_tokens);
  const w5 = Math.max(n(u.cache_creation?.ephemeral_5m_input_tokens), written - w1);
  const rec = [m.id && x.requestId ? `${m.id}:${x.requestId}` : m.id || x.uuid || "", Date.parse(x.timestamp) || 0,
    String(m.model || ""), n(u.input_tokens), n(u.output_tokens), w5, w1, n(u.cache_read_input_tokens),
    (u.speed === "fast" ? FAST : 0) | (u.inference_geo === "us" ? GEO_US : 0) | (x.isSidechain ? SIDE : 0), 0];
  return rec[K] && rec[IN] + rec[OUT] + rec[W5] + rec[W1] + rec[READ] > 0 ? rec : null;
}
// state: { msgs: Map, cwd } - updated in place; returns the bytes consumed.
function readClaude(buf, state) {
  return eachLine(buf, ['"usage"', '"compact_boundary"'], Infinity, line => {
    const x = parse(line);
    if (!x) return;
    if (!state.cwd && typeof x.cwd === "string") state.cwd = x.cwd;
    const rec = claudeRecord(x);
    if (rec) put(state.msgs, rec);
    state.context = context.latest(state.context, context.claude(x));
  });
}

// ---------- Codex ----------
// token_count events carry running totals for the session (input includes cached input, output includes reasoning);
// a record is the difference to the previous total. state: { msgs, cwd, id, model, total, window } - window: the
// model's context window as Codex reports it (model_context_window).
const CODEX_TOTAL = ["input_tokens", "cached_input_tokens", "output_tokens"];
function readCodex(buf, state) {
  return eachLine(buf, ['"session_meta"', '"turn_context"', '"token_count"', '"compacted"', '"context_compacted"'], 400, line => {
    const x = parse(line), p = x?.payload;
    if (!p) return;
    if (x.type === "session_meta") { state.id ||= p.id || ""; state.cwd ||= p.cwd || ""; }
    const at = Date.parse(x.timestamp) || 0;
    if (x.type === "compacted" || p.type === "context_compacted") state.context = context.pending(at, state.model, 'codex-transcript');
    if (x.type === "turn_context") {
      if (p.model && state.model && state.model !== p.model) state.context = context.pending(at, String(p.model), 'codex-transcript');
      if (p.model) state.model = String(p.model);
      state.cwd ||= p.cwd || "";
    }
    if (x.type !== "event_msg" || p.type !== "token_count" || !p.info) return;
    if (n(p.info.model_context_window)) state.window = n(p.info.model_context_window);
    const total = p.info.total_token_usage, last = p.info.last_token_usage;
    state.context = context.latest(state.context, context.codex(p.info, at, state.model));
    let d = null;
    if (total) {
      const prev = state.total;
      d = prev ? Object.fromEntries(CODEX_TOTAL.map(k => [k, n(total[k]) - n(prev[k])])) : total;
      if (prev && CODEX_TOTAL.some(k => d[k] < 0)) d = last || total; // the totals started over
      state.total = Object.fromEntries(CODEX_TOTAL.map(k => [k, n(total[k])]));
    } else d = last;
    if (!d) return;
    const cached = Math.min(n(d.cached_input_tokens), n(d.input_tokens));
    const rec = [`cx:${x.timestamp}:${n(total?.total_tokens)}`, Date.parse(x.timestamp) || 0, state.model || "",
      n(d.input_tokens) - cached, n(d.output_tokens), 0, 0, cached, 0, 0];
    if (rec[IN] + rec[OUT] + rec[READ] > 0) put(state.msgs, rec);
  });
}

// ---------- OpenCode ----------
// OpenCode 2 session_message: role is in the type column, model in data.model.
function openCodeRecord(row) {
  const d = parse(row.data);
  if (!d || row.type !== "assistant" || !d.tokens) return null;
  const t = d.tokens;
  const rec = [row.id, n(d.time?.created) || n(row.time_created), String(d.model?.id || ""), n(t.input),
    n(t.output) + n(t.reasoning), n(t.cache?.write), 0, n(t.cache?.read), 0, n(d.cost)];
  return rec[IN] + rec[OUT] + rec[W5] + rec[READ] > 0 ? rec : null;
}

// ---------- totals ----------
function recordCost(rec) {
  const usd = prices.cost(rec[MODEL], { input: rec[IN], output: rec[OUT], write5m: rec[W5], write1h: rec[W1], read: rec[READ] },
    { fast: Boolean(rec[FLAGS] & FAST), geo: rec[FLAGS] & GEO_US ? "us" : "" });
  // Models the price table does not know: what the agent itself worked out, if anything.
  return usd ?? (rec[REPORTED] > 0 ? rec[REPORTED] : null);
}
const pad = v => String(v).padStart(2, "0");
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// sources: [{ key: "Claude:<id>", cwd, title, msgs: iterable of records, context?, sub? }], in priority order - a record seen again
// later (a copied reply) only completes the first one. Returns the summary the windows receive.
function aggregate(sources) {
  const seen = new Map(), owner = new Map();
  for (const src of sources) {
    for (const rec of src.msgs) {
      const had = seen.get(rec[K]);
      if (had) { merge(had, rec); continue; }
      const copy = rec.slice();
      seen.set(rec[K], copy);
      owner.set(copy, src.key);
    }
  }
  const sessions = [], sIndex = new Map(), models = [], mIndex = new Map(), rows = new Map(), contexts = new Map();
  for (const src of sources) {
    if (!src.sub && src.context) contexts.set(src.key, context.latest(contexts.get(src.key), src.context));
    if (sIndex.has(src.key)) { const s = sessions[sIndex.get(src.key)]; s.cwd ||= src.cwd || ""; s.title ||= src.title || ""; continue; }
    sIndex.set(src.key, sessions.length);
    sessions.push({ key: src.key, cwd: src.cwd || "", title: src.title || "" });
  }
  for (const rec of seen.values()) {
    const model = rec[MODEL] || "?";
    if (!mIndex.has(model)) { mIndex.set(model, models.length); models.push(model); }
    const s = sIndex.get(owner.get(rec)), m = mIndex.get(model), day = localDay(rec[TIME]);
    const id = `${s}|${day}|${m}`;
    let row = rows.get(id);
    if (!row) rows.set(id, row = [s, day, m, 0, 0, 0, 0, null, 0]);
    row[3] += rec[IN]; row[4] += rec[OUT]; row[5] += rec[W5] + rec[W1]; row[6] += rec[READ];
    const usd = recordCost(rec);
    if (usd != null) row[7] = (row[7] || 0) + usd;
    row[8]++;
  }
  // A context-only session still matters, including after compaction or a fork.
  const used = [...new Set([...rows.values()].map(r => r[0]).concat([...contexts.keys()].map(key => sIndex.get(key))))].sort((a, b) => a - b);
  const remap = new Map(used.map((i, j) => [i, j]));
  return {
    models,
    sessions: used.map(i => ({ ...sessions[i], context: contexts.get(sessions[i].key) || null })),
    // [session, "YYYY-MM-DD" (local), model, input, output, cacheWrite, cacheRead, usd|null, replies]
    rows: [...rows.values()].map(r => [remap.get(r[0]), ...r.slice(1)]),
    prices: { asOf: prices.AS_OF, sources: prices.SOURCES }
  };
}

module.exports = { readClaude, readCodex, openCodeRecord, claudeRecord, aggregate, recordCost, localDay, eachLine, R: { K, TIME, MODEL, IN, OUT, W5, W1, READ, FLAGS, REPORTED } };
