// The plan limits in the edge menu's top bar (limits.js in main): a group per installed agent (Claude, Codex), one pill
// per window with its percentage, a small bar with the time already gone in the window marked on it, and the forecast
// in the tooltip. Loaded after common.js.
(() => {
  let limits = null, resources = null, peers = [], agents = [];
  const LABEL = { five_hour: "bar.limits.five", seven_day: "bar.limits.week" };
  const when = ms => {
    if (!ms) return "?";
    return new Date(ms).toDateString() === new Date().toDateString()
      ? I18N.formatTime(ms)
      : I18N.formatDateTime(ms, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };

  const duration = mins => mins % 10080 === 0 ? t("bar.limits.week") : mins % 60 === 0
    ? t("bar.limits.hours", { n: mins / 60 }) : t("bar.limits.minutes", { n: mins });
  const codexLabel = w => w.label ? `${w.label} ${duration(w.durationMins)}` : duration(w.durationMins);
  // Codex's own 5-hour and weekly windows read like Claude's; any other is named by its limit and length.
  const STANDARD = { 300: "bar.limits.five", 10080: "bar.limits.week" };
  function pill(w, provider, state) {
    const level = w.util >= 95 ? "danger" : w.runsOut || w.util >= 80 ? "warn" : "";
    const e = w.elapsedPct ?? "?"; // null: the reset time is not known
    const key = provider === "claude" ? LABEL[w.key] : !w.label && STANDARD[w.durationMins];
    const tip = [
      key ? t(`${key}.long`, { u: w.util, e }) : t("bar.limits.codex.long", { name: codexLabel(w), u: w.util, e }),
      t("bar.limits.resets", { when: when(w.resetsAt) }),
      w.util >= 100 ? t("bar.limits.full")
        : w.fullAt ? t(w.runsOut ? "bar.limits.runsOut" : "bar.limits.lasts", { when: when(w.fullAt) }) : t("bar.limits.noBurn")
    ];
    if (provider === "claude" && w.key === "seven_day") for (const s of state.scoped || []) tip.push(t("bar.limits.scoped", { name: s.name, u: s.util }));
    if (state.error) tip.push(errText(state, provider));
    if (state.error && state.at) tip.push(t("bar.limits.stale", { when: when(state.at) }));
    const label = key ? t(key) : codexLabel(w);
    return `<span class="lim ${level} ${state.error ? "stale" : ""}" title="${esc(tip.join("\n"))}"><span class="lim-k">${esc(label)}</span><span class="lim-value">${esc(String(Math.round(w.util)))}%</span>`
      + `<span class="lim-bar"><i style="width:${Math.max(0, Math.min(100, w.util))}%"></i>${w.elapsedPct == null ? "" : `<b style="left:${w.elapsedPct}%"></b>`}</span></span>`;
  }

  function errText(state, provider) {
    const key = provider === "codex" ? `bar.limits.codex.err.${state.error}` : `bar.limits.err.${state.error}`;
    return t(key, { detail: state.detail || "" });
  }

  function group(provider, state) {
    if (!state?.installed) return "";
    const name = t(`bar.limits.provider.${provider}`);
    const contents = state.windows?.length ? state.windows.map(w => pill(w, provider, state)).join("")
      : `<span class="lim err" title="${esc(state.error ? errText(state, provider) : t("bar.limits.loading"))}">${esc(state.loading ? t("bar.limits.loading") : t("bar.limits.unknown"))}</span>`;
    return `<div class="lim-group ${provider}"><span class="lim-provider">${esc(name)}</span>${contents}</div>`;
  }

  const gib = n => I18N.formatNumber(n / 1073741824, { maximumFractionDigits: 1 });
  function machine(name, snapshot, stats, installed, offline = false) {
    const providers = ["claude", "codex"].map(id => group(id, snapshot?.providers?.[id] || (installed.some(a => a.toLowerCase() === id) ? { installed: true } : null))).join("");
    const memory = stats?.memory;
    const details = stats ? [t("resources.measured", { when: I18N.formatTime(stats.at) }),
      `CPU ${stats.cpu == null ? '—' : Math.round(stats.cpu) + '%'} · ${stats.cores || '?'} cores`,
      memory ? `RAM ${gib(memory.used)}/${gib(memory.total)} GiB` : '',
      stats.disk ? t("resources.diskFree", { free: gib(stats.disk.free), total: gib(stats.disk.total) }) + '\n' + t("resources.diskPath", { path: stats.disk.path }) : ''
    ].filter(Boolean).join('\n') : t("resources.unavailable");
    const cpu = stats?.cpu == null ? '—' : Math.round(stats.cpu) + '%';
    const ram = memory?.total ? Math.round(memory.used / memory.total * 100) + '%' : '—';
    const cpuIcon = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></svg>';
    const ramIcon = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 10v3m5-3v3m5-3v3M6 17v3m4-3v3m4-3v3m4-3v3"/></svg>';
    const measurements = '<span class="resource-value" aria-label="CPU ' + cpu + '">' + cpuIcon + cpu + '</span><span class="resource-value" aria-label="RAM ' + ram + '">' + ramIcon + ram + '</span>';
    return '<div class="machine-status' + (offline ? ' offline' : '') + '"><strong title="' + esc(name + (offline ? ' · ' + t("manager.node.offline") : '')) + '"><span class="machine-dot"></span>' + esc(name) + '</strong>' + (offline ? '<span class="machine-offline">' + esc(t("manager.node.offline")) + '</span>' : '') + '<span class="machine-providers">' + providers + '</span><span class="machine-resources" title="' + esc(details) + '">' + measurements + '</span></div>';
  }

  function render() {
    const el = $("limits");
    if (!el) return;
    if (!document.querySelector("footer.status")) {
      el.innerHTML = limits ? ["claude", "codex"].map(id => group(id, limits.providers?.[id])).join("") : "";
      return;
    }
    el.innerHTML = machine(resources?.name || t("resources.local"), limits, resources, agents)
      + [...peers].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true }))
        .map(n => machine(n.name, n.limits, n.resources, n.data?.agents || n.info?.agents || [], n.status !== "online")).join("");
  }

  const set = l => { limits = l; render(); };
  window.manager.onLimitsChanged(set);
  if (document.querySelector("footer.status")) {
    window.manager.onResourcesChanged(r => { resources = r; render(); });
    window.manager.getResources().then(r => { resources = r; render(); }).catch(() => {});
    window.manager.onNodesChanged(list => { peers = list || []; render(); });
    window.manager.getNodes().then(list => { peers = list || []; render(); }).catch(() => {});
    const setAgents = d => { agents = d?.agents || []; render(); };
    window.manager.getData().then(setAgents).catch(() => {});
    window.manager.onDataChanged(setAgents);
  }
  // Asked when the menu comes out (main answers from its last check when that is recent).
  window.limitsUi = { refresh: () => window.manager.getLimits().then(set).catch(() => {}) };
})();
