// Context snapshots are independent of the accounting ledger: they can shrink, become
// unknown after compaction, or change without a new billable request.
const prices = require('./usage-prices');
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const sum = (...values) => values.reduce((n, v) => n + (number(v) || 0), 0);

function snapshot({ tokens, at, model = '', provider = '', window = 0, source, status = 'reported', percent = null, cache = null }) {
  const limit = number(window) || 0;
  return { tokens: number(tokens), at: number(at) || 0, model, provider, window: limit,
    exact: limit > 0, source, status, percent: number(percent), cache, warmUntil: cache?.warm ? cache.expiresAt || 0 : 0 };
}
function pending(at, model = '', source = 'transcript') {
  return snapshot({ tokens: null, at, model, source, status: 'pending' });
}
function claude(x) {
  const at = Date.parse(x.timestamp) || 0;
  if (x.isSidechain) return null;
  if (x.type === 'system' && x.subtype === 'compact_boundary') return pending(at);
  const u = x.message?.usage;
  if (x.type !== 'assistant' || !u || x.message?.model === '<synthetic>') return null;
  const tokens = sum(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens);
  // Error/placeholder replies sometimes carry zero usage; they are not measurements.
  if (!tokens) return null;
  const model = String(x.message.model || '');
  const c = snapshot({ tokens, at, model, source: 'claude-transcript' });
  c.window = prices.contextWindow(model);
  c.exact = false;
  return c;
}
function codex(info, at, model) {
  const u = info.last_token_usage;
  if (!u) return null;
  const tokens = number(u.total_tokens) ?? sum(u.input_tokens, u.output_tokens);
  return snapshot({ tokens, at, model, window: info.model_context_window, source: 'codex-transcript' });
}
function openCode(row) {
  let d;
  try { d = JSON.parse(row.data); } catch { return null; }
  const at = number(d.time?.completed) || number(row.time_updated) || number(row.time_created) || 0;
  if (row.type === 'compaction') return d.status === 'completed' ? pending(at, '', 'opencode-db') : null;
  if (row.type === 'model-switched') return pending(at, d.model?.id, 'opencode-db');
  if (row.type !== 'assistant' || !d.tokens || d.error) return null;
  const t = d.tokens;
  const tokens = number(t.total) || sum(t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write);
  if (!tokens) return null;
  return snapshot({ tokens, at, model: String(d.model?.id || ''), provider: String(d.model?.providerID || ''), source: 'opencode-db' });
}
function statusLine(data, at = Date.now()) {
  const w = data.context_window;
  if (!w || data.agent?.id || data.task) return null;
  const u = w.current_usage;
  const cache = data.prompt_cache;
  return snapshot({ tokens: u ? sum(u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens) : null,
    at, model: String(data.model?.id || ''), window: w.context_window_size, source: 'claude-statusline',
    status: u ? 'reported' : 'pending', percent: u ? w.used_percentage : null,
    cache: cache ? { warm: cache.warm === true, expiresAt: (number(cache.expires_at) || 0) * 1000 } : null });
}
function latest(a, b) { return b && (!a || b.at >= a.at) ? b : a; }
module.exports = { snapshot, pending, claude, codex, openCode, statusLine, latest };
