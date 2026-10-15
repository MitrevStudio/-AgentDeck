// The manager's Usage view: tokens and API-equivalent cost for today, the last 7 and 30 days and all time, a daily
// chart of the last 30 days, and the projects, sessions and models behind the chosen period. Classic script loaded
// after renderer.js, whose data, ui, live, render(), selectProject() and setQuery() it uses; figures and formats
// come from usage-ui.js. Kept in a function scope: the page's scripts share one global scope.
(() => {
const uv = { open: false, period: "d7", metric: "cost", focus: -1, refreshing: false };
const PERIODS = [["today", 1], ["d7", 7], ["d30", 30], ["all", 0]];
const CHART_DAYS = 30;
const LIST_MAX = 8;

// The last n local days, oldest first, as "YYYY-MM-DD".
function lastDays(n) {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() - (n - 1 - i)); return usageDay(x.getTime()); });
}
const dayMs = day => new Date(`${day}T12:00:00`).getTime();
const periodFrom = id => { const days = PERIODS.find(p => p[0] === id)[1]; return days ? lastDays(days)[0] : ""; };
const metricOf = a => (!a ? 0 : uv.metric === "cost" ? a.cost || 0 : a.tokens);
const byMetric = (a, b) => metricOf(b) - metricOf(a) || b.tokens - a.tokens;

// ---------- opening ----------
function openUsage(open = !uv.open) {
  uv.open = open;
  document.body.classList.toggle("usage-open", open);
  $("usageView").hidden = !open;
  $("usage").classList.toggle("on", open);
  $("usage").setAttribute("aria-pressed", String(open));
  if (open) { renderUsage(); refreshUsage(); $("usageView").focus({ preventScroll: true }); }
  else { $("usageView").innerHTML = ""; hideTip(); }
}
async function refreshUsage() {
  if (uv.refreshing) return;
  uv.refreshing = true;
  if (uv.open) renderUsage();
  // New figures arrive on their own (watchUsage below); unchanged ones only say when they were checked.
  try {
    const r = await window.manager.refreshUsage();
    if (r && usage && r.version === usage.version) Object.assign(usage, { at: r.at, stats: r.stats });
  } catch (e) { toast(e.message, true); }
  finally { uv.refreshing = false; if (uv.open) renderUsage(); }
}

// ---------- view ----------
function renderUsage() {
  const el = $("usageView");
  const focused = document.activeElement?.closest?.("#usageView [data-key]")?.dataset.key;
  el.innerHTML = usageHead() + (usage ? usageBody() : `<div class="uv-body"><div class="empty"><span class="spinner"></span><h3>${esc(t("usage.loading"))}</h3><p>${esc(t("usage.loadingBody"))}</p></div></div>`);
  if (usage) renderChart();
  if (focused) el.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
}

function usageHead() {
  const s = usage?.stats;
  const when = usage ? t("usage.updated", { time: I18N.formatTime(usage.at) }) : "";
  const detail = s ? t("usage.updatedTitle", { files: I18N.formatNumber(s.files), ms: I18N.formatNumber(s.ms) }) : "";
  return `<div class="uv-head">
    <div class="uv-titles"><h2>${esc(t("usage.title"))}</h2><p>${esc(t("usage.subtitle"))}</p></div>
    <span class="grow"></span>
    <span class="uv-updated" title="${esc(detail)}">${esc(when)}</span>
    <button class="btn sm ${uv.refreshing ? "spin" : ""}" data-uv="refresh" data-key="refresh" ${uv.refreshing ? "disabled" : ""} title="${esc(t("usage.refresh"))}">${icon("refresh")}${esc(t("manager.refresh.label"))}</button>
    <button class="btn sm" data-uv="close" data-key="close" title="${esc(t("usage.backTitle"))}">${icon("left")}${esc(t("usage.back"))}</button>
  </div>`;
}

function usageBody() {
  if (!usage.rows.length) return `<div class="uv-body"><div class="empty"><h3>${esc(t("usage.empty"))}</h3><p>${esc(t("usage.emptyBody"))}</p></div></div>`;
  const from = periodFrom(uv.period);
  const rows = usage.rows.filter(r => !from || r[1] >= from);
  return `<div class="uv-body">
    <div class="uv-filters">${tilesHtml()}
      <div class="seg uv-metric" role="group" aria-label="${esc(t("usage.metric"))}">${["cost", "tokens"].map(m =>
        `<button class="${uv.metric === m ? "on" : ""}" data-metric="${m}" data-key="m:${m}" aria-pressed="${uv.metric === m}">${esc(t(`usage.metric.${m}`))}</button>`).join("")}</div>
    </div>
    <section class="panel uv-chart" aria-labelledby="uvChartTitle">
      <div class="uv-panel-head"><h3 id="uvChartTitle">${esc(t(uv.metric === "cost" ? "usage.chart.cost" : "usage.chart.tokens"))}</h3></div>
      <div class="uv-plot" id="uvPlot" tabindex="0" data-key="plot" aria-describedby="uvChartTable"></div>
      ${chartTable()}
    </section>
    <div class="uv-lists">
      ${listHtml("usage.list.projects", projectsOf(rows), "project")}
      ${listHtml("usage.list.sessions", sessionsOf(rows), "session")}
      ${listHtml("usage.list.models", modelsOf(rows), "model")}
    </div>
    <p class="uv-note">${icon("alert")}<span>${esc(t("usage.note", { date: I18N.formatDate(dayMs(usage.prices.asOf), { day: "numeric", month: "long", year: "numeric" }) }))}</span></p>
  </div>`;
}

function tilesHtml() {
  return `<div class="uv-tiles" role="group" aria-label="${esc(t("usage.period"))}">${PERIODS.map(([id]) => {
    const from = periodFrom(id);
    const a = sumUsage(usage.rows, r => (!from || r[1] >= from ? 1 : null)).get(1);
    const on = uv.period === id;
    const cost = a ? fmtUsd(a.cost) : fmtUsd(0), tokens = tokensText(a?.tokens || 0);
    const [value, sub] = uv.metric === "cost" ? [cost, tokens] : [tokens, cost];
    return `<button class="uv-tile ${on ? "on" : ""}" data-period="${id}" data-key="p:${id}" aria-pressed="${on}" ${a ? `title="${esc(usageTitle(a, t(`usage.period.${id}`)))}"` : ""}>
      <span class="uv-tile-label">${esc(t(`usage.period.${id}`))}</span>
      <span class="uv-tile-value">${esc(value)}</span>
      <span class="uv-tile-sub">${esc(sub)}</span></button>`;
  }).join("")}</div>`;
}

// ---------- lists ----------
// Sessions in the period, keyed like sessionKey(); the scan's own record of a session where there is one.
function sessionsOf(rows) {
  const known = new Map(data.sessions.map(s => [sessionKey(s), s])), scanned = new Map(usage.sessions.map(s => [s.key, s]));
  return [...sumUsage(rows, r => usage.sessions[r[0]].key)].map(([key, a]) => {
    const u = scanned.get(key), s = known.get(key);
    const [agent, ...id] = key.split(":");
    return { ...a, key, agent, id: id.join(":"), title: s?.title || u?.title || t("session.untitled", { agent, id: id.join(":").slice(0, 8) }),
      cwd: s?.cwd || u?.cwd || "", updatedAt: s?.updatedAt || 0, project: s?.projectName || "" };
  }).sort(byMetric);
}
// Grouped by registered project (the deepest one containing the folder), otherwise by folder.
function projectsOf(rows) {
  const out = new Map();
  for (const s of sessionsOf(rows)) {
    const n = normPath(s.cwd);
    const p = data.projects.filter(p => n && (n === p.n || n.startsWith(p.n + "/"))).sort((a, b) => b.n.length - a.n.length)[0];
    const key = p ? p.n : n;
    if (!out.has(key)) out.set(key, { ...emptyUsage(), key, name: p?.name || s.cwd.split(/[\\/]/).filter(Boolean).pop() || t("usage.noFolder"), path: p?.path || s.cwd, sessions: 0 });
    const g = out.get(key);
    addUsage(g, s); g.sessions++;
  }
  return [...out.values()].sort(byMetric);
}
function modelsOf(rows) {
  const agents = new Map();
  for (const r of rows) {
    const m = usage.models[r[2]];
    if (!agents.has(m)) agents.set(m, new Set());
    agents.get(m).add(usage.sessions[r[0]].key.split(":")[0]);
  }
  return [...sumUsage(rows, r => usage.models[r[2]])].map(([model, a]) => ({ ...a, model, agents: [...agents.get(model)] })).sort(byMetric);
}

function listHtml(titleKey, items, kind) {
  const top = items.slice(0, kind === "model" ? 50 : LIST_MAX);
  const max = Math.max(...top.map(metricOf), 0) || 1;
  const rows = top.map(item => rowHtml(item, kind, metricOf(item) / max)).join("");
  return `<section class="panel uv-list"><div class="uv-panel-head"><h3>${esc(t(titleKey))}</h3><span class="count">${I18N.formatNumber(items.length)}</span></div>
    <div class="uv-rows">${rows || `<div class="empty small">${esc(t("usage.list.none"))}</div>`}</div></section>`;
}
function rowHtml(item, kind, share) {
  let name, meta, attrs, title;
  if (kind === "project") {
    name = esc(item.name); meta = esc(tn("usage.sessions", item.sessions));
    attrs = `data-project="${esc(item.path)}" data-key="project:${esc(item.key)}"`; title = `${item.path}\n\n${usageTitle(item)}`;
  } else if (kind === "session") {
    name = esc(item.title);
    meta = `<span class="dot ${esc(item.agent.toLowerCase())}"></span>${esc([item.agent, item.project || (item.cwd && item.cwd.split(/[\\/]/).filter(Boolean).pop()), item.updatedAt && ago(item.updatedAt)].filter(Boolean).join(" · "))}`;
    attrs = `data-session="${esc(item.key)}" data-key="session:${esc(item.key)}"`; title = `${item.title}\n${item.cwd}\n\n${usageTitle(item)}`;
  } else {
    name = esc(item.model === "?" ? t("usage.model.unknown") : item.model);
    meta = item.agents.map(a => `<span class="dot ${esc(a.toLowerCase())}"></span>${esc(a)}`).join(" ");
    title = usageTitle(item);
  }
  const tag = kind === "model" ? "div" : "button";
  // The chosen metric leads.
  const [first, second] = [fmtUsd(item.cost), tokensText(item.tokens)][uv.metric === "cost" ? "slice" : "reverse"]();
  return `<${tag} class="uv-row" ${attrs || ""} title="${esc(title)}">
    <span class="uv-name"><span class="uv-label">${name}</span><span class="uv-meta">${meta}</span></span>
    <span class="uv-val"><b>${esc(first)}</b><span>${esc(second)}</span></span>
    <span class="uv-meter" aria-hidden="true"><span style="width:${(share * 100).toFixed(1)}%"></span></span>
  </${tag}>`;
}

// ---------- chart ----------
// One series (the chosen metric per day), so no legend: the panel title names it. Bars in the chosen period are in
// the accent, earlier days recede. Every value is also in the table read out to screen readers.
function chartDays() {
  const days = lastDays(CHART_DAYS);
  const per = sumUsage(usage.rows, r => (r[1] >= days[0] ? r[1] : null));
  return days.map(day => ({ day, a: per.get(day) || emptyUsage(), value: metricOf(per.get(day)) }));
}
function niceTicks(max) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 3, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}
const axisLabel = v => (v === 0 ? "0" : uv.metric === "cost"
  ? I18N.formatNumber(v, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", notation: "compact", maximumFractionDigits: 2 })
  : fmtTokens(v));
const valueLabel = v => (uv.metric === "cost" ? fmtUsd(v) : tokensText(v));
const longDate = day => I18N.formatDate(dayMs(day), { weekday: "short", day: "numeric", month: "short" });

function renderChart() {
  const plot = $("uvPlot");
  if (!plot) return;
  const W = Math.max(320, Math.floor(plot.clientWidth)), H = 190, top = 22, bottom = 26, left = 56, right = 6;
  const days = chartDays(), from = periodFrom(uv.period);
  const ticks = niceTicks(Math.max(...days.map(d => d.value))), yMax = ticks.at(-1);
  const plotH = H - top - bottom, slot = (W - left - right) / days.length;
  const bw = Math.max(2, Math.min(24, slot - 4));
  const y = v => top + plotH - (v / yMax) * plotH;
  const grid = ticks.map(v => `<line class="uv-grid" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="uv-axis" x="${left - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${esc(axisLabel(v))}</text>`).join("");
  let peak = -1;
  days.forEach((d, i) => { if (d.value > 0 && (peak < 0 || d.value > days[peak].value)) peak = i; });
  const bars = days.map((d, i) => {
    const x = left + i * slot + (slot - bw) / 2, base = top + plotH, h = base - y(d.value), r = Math.min(4, bw / 2, h);
    const shape = h > 0 ? `<path class="uv-bar ${!from || d.day >= from ? "in" : ""}" d="M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + bw - r}Q${x + bw},${base - h} ${x + bw},${base - h + r}V${base}Z"/>` : "";
    const label = i === peak ? `<text class="uv-peak" x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle">${esc(valueLabel(d.value))}</text>` : "";
    const tickDay = (days.length - 1 - i) % 7 === 0
      ? `<text class="uv-axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(I18N.formatDate(dayMs(d.day), { day: "numeric", month: "short" }))}</text>` : "";
    return `<g data-i="${i}">${shape}${label}${tickDay}<rect class="uv-hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${plotH}"/></g>`;
  }).join("");
  const total = days.reduce((s, d) => s + d.value, 0);
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("usage.chart.aria", {
    total: valueLabel(total), peak: peak < 0 ? "—" : `${valueLabel(days[peak].value)}, ${longDate(days[peak].day)}` }))}">
    ${grid}<line class="uv-base" x1="${left}" x2="${W - right}" y1="${top + plotH}" y2="${top + plotH}"/>${bars}</svg>
    <div class="uv-tip" id="uvTip" role="status" hidden><b></b><span></span><span></span></div>`;
  if (uv.focus >= 0 && document.activeElement === plot) showTip(uv.focus);
}
function chartTable() {
  const days = chartDays();
  return `<table class="uv-sr" id="uvChartTable"><caption>${esc(t(uv.metric === "cost" ? "usage.chart.cost" : "usage.chart.tokens"))}</caption>
    <tr><th>${esc(t("usage.table.day"))}</th><th>${esc(t("usage.metric.cost"))}</th><th>${esc(t("usage.metric.tokens"))}</th></tr>
    ${days.filter(d => d.a.tokens).map(d => `<tr><td>${esc(longDate(d.day))}</td><td>${esc(fmtUsd(d.a.cost))}</td><td>${esc(I18N.formatNumber(d.a.tokens))}</td></tr>`).join("")}</table>`;
}

// One tooltip, on hover and on keyboard focus (left/right step through the days).
function showTip(i) {
  const plot = $("uvPlot"), tip = $("uvTip");
  if (!plot || !tip) return;
  const days = chartDays(), d = days[i];
  if (!d) return hideTip();
  uv.focus = i;
  plot.querySelectorAll(".uv-bar.hot").forEach(el => el.classList.remove("hot"));
  plot.querySelector(`g[data-i="${i}"] .uv-bar`)?.classList.add("hot");
  const [value, date, other] = tip.children;
  value.textContent = d.a.tokens ? (uv.metric === "cost" ? fmtUsd(d.a.cost) : t("usage.tokens", { n: I18N.formatNumber(d.a.tokens) })) : t("usage.chart.none");
  date.textContent = longDate(d.day);
  other.textContent = d.a.tokens ? (uv.metric === "cost" ? t("usage.tokens", { n: I18N.formatNumber(d.a.tokens) }) : fmtUsd(d.a.cost)) : "";
  tip.hidden = false;
  const hit = plot.querySelector(`g[data-i="${i}"] .uv-hit`).getBBox();
  const x = Math.min(Math.max(hit.x + hit.width / 2 - tip.offsetWidth / 2, 4), plot.clientWidth - tip.offsetWidth - 4);
  tip.style.transform = `translate(${x}px, 0)`;
}
function hideTip() {
  uv.focus = -1;
  const tip = $("uvTip");
  if (tip) tip.hidden = true;
  document.querySelectorAll(".uv-bar.hot").forEach(el => el.classList.remove("hot"));
}

// ---------- events ----------
$("usage").addEventListener("click", () => openUsage());
$("usageView").addEventListener("click", e => {
  const el = e.target.closest("[data-uv], [data-period], [data-metric], [data-project], [data-session]");
  if (!el) return;
  if (el.dataset.uv === "close") return openUsage(false);
  if (el.dataset.uv === "refresh") return refreshUsage();
  if (el.dataset.period) { uv.period = el.dataset.period; return renderUsage(); }
  if (el.dataset.metric) { uv.metric = el.dataset.metric; return renderUsage(); }
  // From a project or a session to the sessions list, filtered to it.
  if (el.dataset.project != null) { openUsage(false); ui.selected = ""; selectProject(el.dataset.project); return; }
  if (el.dataset.session) { openUsage(false); setQuery(el.dataset.session.slice(el.dataset.session.indexOf(":") + 1)); }
});
$("usageView").addEventListener("pointermove", e => {
  const g = e.target.closest?.("#uvPlot g[data-i]");
  if (g) { if (Number(g.dataset.i) !== uv.focus) showTip(Number(g.dataset.i)); }
  else if (uv.focus >= 0 && !e.target.closest?.("#uvTip")) hideTip();
});
$("usageView").addEventListener("pointerleave", hideTip);
$("usageView").addEventListener("focusin", e => { if (e.target.id === "uvPlot") showTip(uv.focus >= 0 ? uv.focus : CHART_DAYS - 1); });
$("usageView").addEventListener("focusout", e => { if (e.target.id === "uvPlot") hideTip(); });
$("usageView").addEventListener("keydown", e => {
  if (e.target.id !== "uvPlot") return;
  const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (step) { e.preventDefault(); showTip(Math.max(0, Math.min(CHART_DAYS - 1, (uv.focus < 0 ? CHART_DAYS - 1 : uv.focus) + step))); }
  if (e.key === "Home" || e.key === "End") { e.preventDefault(); showTip(e.key === "Home" ? 0 : CHART_DAYS - 1); }
});
// The sessions list's keys (arrows, Enter) must not act on the hidden list - a focused button still gets its
// click, which is the default action; Esc goes back to the list.
window.addEventListener("keydown", e => {
  if (!uv.open) return;
  if (e.key === "Escape" && !e.target.matches?.("input, textarea")) { e.stopImmediatePropagation(); e.preventDefault(); openUsage(false); return; }
  if (["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) e.stopImmediatePropagation();
}, true);
// Searching is about sessions.
$("search").addEventListener("input", () => { if (uv.open) openUsage(false); });
new ResizeObserver(() => { if (uv.open && usage) renderChart(); }).observe($("usageView"));

// Figures follow the scans; a running session's numbers are refreshed every so often while the window is in view.
watchUsage(() => {
  if (uv.open) renderUsage();
  if (ui.loaded && !ui.renaming) render();
});
setInterval(() => { if (!document.hidden && live.size) refreshUsage(); }, 45_000);
})();
