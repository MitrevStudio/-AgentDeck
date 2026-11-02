// Tokens and API-equivalent cost on the pages that list sessions (manager and edge menu). Classic script, loaded
// after common.js. Main sends one summary (usage.js): sessions, models and rows of
// [session, "YYYY-MM-DD", model, input, output, cacheWrite, cacheRead, usd|null, replies].
let usage = null, usageBySession = new Map(), contextBySession = new Map();
// From this size a cold session is marked as expensive to continue.
const LARGE_CONTEXT = 150000;
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
  contextBySession = new Map((u?.sessions || []).filter(x => x.context?.tokens).map(x => [x.key, x.context]));
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
// Session card (manager): "1.2m tok · $3.40"; a narrow window keeps the cost only (usage.css).
function usageChip(s) {
  const a = usageOf(s);
  if (!a) return "";
  const tokens = esc(tokensText(a.tokens));
  return `<span class="usage-chip" title="${esc(usageTitle(a))}">${a.cost == null ? tokens : `<span class="uc-tokens">${tokens} · </span>${esc(fmtUsd(a.cost))}`}</span>`;
}
// Session row (edge menu): the cost alone, or the tokens when there is no price.
function usageCost(s) {
  const a = usageOf(s);
  return a ? `<span class="rusage" title="${esc(usageTitle(a))}">${esc(a.cost == null ? tokensText(a.tokens) : fmtUsd(a.cost))}</span>` : "";
}
// What continuing a session costs: the context its next reply re-reads, green while the cache is warm, yellow once
// it went cold, red when it is cold and large. Both pages; refreshContextChips() turns them cold on time.
function getContextState(c) {
  if (Date.now() < c.warmUntil) {
    return "warm";
  }
  return c.tokens >= LARGE_CONTEXT ? "large" : "cold";
}
function getContextTitle(c, state) {
  const n = I18N.formatNumber(c.tokens);
  if (state === "warm") {
    return t("context.tip.warm", { n, until: I18N.formatTime(c.warmUntil) });
  }
  return t(state === "large" ? "context.tip.large" : "context.tip.cold", { n });
}
function getContextChip(s) {
  const c = contextBySession.get(sessionKey(s));
  // A Claude session that never reached the model (only commands such as /clear) has nothing to re-read.
  if (!c) {
    return s.agent === "Claude" && usage ? `<span class="ctx-chip empty" title="${esc(t("context.tip.empty"))}">${esc(t("context.label", { n: 0 }))}</span>` : "";
  }
  const state = getContextState(c);
  return `<span class="ctx-chip ${state}" data-ctx="${esc(sessionKey(s))}" title="${esc(getContextTitle(c, state))}">${esc(t("context.label", { n: fmtTokens(c.tokens).replace(/\.$/, "") }))}</span>`;
}
function refreshContextChips() {
  document.querySelectorAll("[data-ctx]").forEach(el => {
    const c = contextBySession.get(el.dataset.ctx);
    if (!c) {
      return;
    }
    const state = getContextState(c);
    el.className = `ctx-chip ${state}`;
    el.title = getContextTitle(c, state);
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
