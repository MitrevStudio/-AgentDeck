// Tokens and API-equivalent cost on the pages that list sessions (manager and edge menu). Classic script, loaded
// after common.js. Main sends one summary (usage.js): sessions, models and rows of
// [session, "YYYY-MM-DD", model, input, output, cacheWrite, cacheRead, usd|null, replies].
let usage = null, usageBySession = new Map(), contextBySession = new Map();
// A visual high-usage marker, not a prediction of the agent's compaction threshold.
const FULL_CONTEXT = 0.8;
const CONTEXT_REFRESH_MS = 30000;

const usageDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// Rows summed per keyOf(row) (null = skip the row).
function sumUsage(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    let a = out.get(k);
    if (!a) out.set(k, a = { input: 0, output: 0, write: 0, read: 0, tokens: 0, cost: null, unpriced: 0, models: new Set() });
    a.input += r[3]; a.output += r[4]; a.write += r[5]; a.read += r[6];
    const tokens = r[3] + r[4] + r[5] + r[6];
    a.tokens += tokens;
    if (r[7] == null) a.unpriced += tokens; else a.cost = (a.cost || 0) + r[7];
    a.models.add(usage.models[r[2]]);
  }
  return out;
}
function addUsage(into, a) {
  if (!a) return into;
  for (const k of ["input", "output", "write", "read", "tokens", "unpriced"]) into[k] += a[k];
  if (a.cost != null) into.cost = (into.cost || 0) + a.cost;
  a.models.forEach(m => into.models.add(m));
  return into;
}
const emptyUsage = () => ({ input: 0, output: 0, write: 0, read: 0, tokens: 0, cost: null, unpriced: 0, models: new Set() });

function setUsage(u) {
  usage = u;
  usageBySession = u ? sumUsage(u.rows, r => u.sessions[r[0]]?.key) : new Map();
  contextBySession = new Map((u?.sessions || []).filter(x => x.context).map(x => [x.key, x.context]));
}
const usageOf = s => usageBySession.get(sessionKey(s)) || null;
// Several sessions together (a project's), or null when none of them used anything.
function usageOfAll(sessions) {
  const total = sessions.reduce((acc, s) => addUsage(acc, usageOf(s)), emptyUsage());
  return total.tokens ? total : null;
}

// ---------- formats ----------
const fmtTokens = n => I18N.formatNumber(n, { notation: "compact", maximumFractionDigits: n >= 1000 ? 1 : 0 });
// "1.2m tok" / "1,2 млн ток." - the compact count without its own abbreviation dot, so the chip stays short.
const tokensText = n => t("usage.tokens", { n: fmtTokens(n).replace(/\.$/, "") });
function fmtUsd(n) {
  if (n == null) return "—";
  const cur = (v, digits) => I18N.formatNumber(v, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (n > 0 && n < 0.01) return "<" + cur(0.01, 2);
  return cur(n, n >= 1000 ? 0 : 2);
}
// "1.2m tok · $3.40" - or the tokens alone when no model in it has a price.
const usageShort = a => (a.cost == null ? tokensText(a.tokens) : `${tokensText(a.tokens)} · ${fmtUsd(a.cost)}`);
// Tooltip text: the breakdown, the models, and what the figure means.
function usageTitle(a, scope = "") {
  const lines = [];
  if (scope) lines.push(scope);
  lines.push(a.cost == null ? t("usage.tip.noPrice") : t("usage.tip.cost", { cost: fmtUsd(a.cost) }));
  lines.push(t("usage.tip.tokens", { n: I18N.formatNumber(a.tokens) }));
  lines.push(t("usage.tip.breakdown", { input: fmtTokens(a.input), output: fmtTokens(a.output), write: fmtTokens(a.write), read: fmtTokens(a.read) }));
  if (a.cost != null && a.unpriced) lines.push(t("usage.tip.partly", { n: fmtTokens(a.unpriced) }));
  lines.push(t("usage.tip.models", { models: [...a.models].join(", ") }));
  lines.push(t("usage.apiEquivalent"));
  return lines.join("\n");
}

// ---------- markup ----------
// Session row (edge menu): the cost alone, or the tokens when there is no price.
function usageCost(s) {
  const a = usageOf(s);
  return a ? `<span class="rusage" title="${esc(usageTitle(a))}">${esc(a.cost == null ? tokensText(a.tokens) : fmtUsd(a.cost))}</span>` : "";
}
// Context occupancy and provider cache state are independent.
function getContextState(c) {
  if (c.status === "pending" || c.tokens == null) return "empty";
  return getContextFill(c) >= FULL_CONTEXT ? "large" : "neutral";
}
// The share of the model's context window in use (0..1), or null when the window is not known (OpenCode, a model
// usage-prices.js does not list).
function getContextFill(c) {
  if (c.status === "pending" || c.tokens == null) return null;
  if (Number.isFinite(c.percent)) return Math.max(0, c.percent / 100);
  return c.window > 0 ? c.tokens / c.window : null;
}
// "52%", or "≈52%" when the window is the model's usual one rather than what the agent reported.
function getFillText(c) {
  const pct = I18N.formatNumber(getContextFill(c), { style: "percent", maximumFractionDigits: 0 });
  return c.exact ? pct : `≈${pct}`;
}
function getContextTitle(c) {
  if (c.status === "pending" || c.tokens == null) return t("context.pending");
  const n = I18N.formatNumber(c.tokens);
  const lines = [t("context.reported", { n, at: I18N.formatTime(c.at) })];
  if (c.model) lines.push(t("context.model", { model: [c.provider, c.model].filter(Boolean).join('/') }));
  if (c.limitSource === 'opencode-current-config') lines.push(t("context.currentLimits"));
  if (c.cache) lines.push(t(c.cache.warm && Date.now() < c.cache.expiresAt ? "context.cacheWarm" : "context.cacheCold"));
  const fill = getContextFill(c);
  if (fill != null) {
    lines.push(t(c.exact ? "context.tip.window" : "context.tip.windowApprox", { pct: getFillText(c), window: I18N.formatNumber(c.window) }));
    if (fill >= FULL_CONTEXT) lines.push(t("context.tip.full"));
  }
  return lines.join("\n");
}
function getContextClass(c) {
  const fill = getContextFill(c);
  return `ctx-chip ${getContextState(c)}${fill != null && fill >= FULL_CONTEXT ? " full" : ""}`;
}
function getContextChip(s) {
  const c = s.node ? getNode(s.node)?.usage?.sessions?.find(x => x.key === `${s.agent}:${s.id}`)?.context : contextBySession.get(sessionKey(s));
  if (!c) {
    return "";
  }
  if (c.status === "pending" || c.tokens == null) return `<span class="ctx-chip empty" title="${esc(t("context.pending"))}">${esc(t("context.pending"))}</span>`;
  const n = fmtTokens(c.tokens).replace(/\.$/, "");
  const fill = getContextFill(c);
  // The share in use also fills the chip from the left, as a thin line along its bottom.
  const label = fill == null ? t("context.label", { n }) : t("context.labelFill", { n, pct: getFillText(c) });
  const style = fill == null ? "" : ` style="--fill: ${Math.min(100, Math.round(fill * 1000) / 10)}%"`;
  return `<span class="${getContextClass(c)}" data-ctx="${esc(`${s.agent}:${s.id}`)}"${s.node ? ` data-ctx-node="${esc(s.node)}"` : ""}${style} title="${esc(getContextTitle(c))}">${esc(label)}</span>`;
}
function refreshContextChips() {
  document.querySelectorAll("[data-ctx]").forEach(el => {
    const c = el.dataset.ctxNode ? getNode(el.dataset.ctxNode)?.usage?.sessions?.find(x => x.key === el.dataset.ctx)?.context : contextBySession.get(el.dataset.ctx);
    if (!c) {
      return;
    }
    el.className = getContextClass(c);
    el.title = getContextTitle(c);
  });
}
setInterval(refreshContextChips, CONTEXT_REFRESH_MS);

// A project's sessions together (edge menu header).
function usageTotal(sessions) {
  const a = usageOfAll(sessions);
  return a ? `<span class="dusage" title="${esc(usageTitle(a, t("usage.tip.project")))}">${esc(usageShort(a))}</span>` : "";
}

// Calls onChange() whenever the figures change (the first time once main has them).
function watchUsage(onChange) {
  const apply = u => { if (!u) return; setUsage(u); onChange(); };
  window.manager.onUsageChanged(apply);
  window.manager.getUsage().then(apply).catch(() => {});
}
