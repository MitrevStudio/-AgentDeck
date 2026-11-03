// The plan limits in the edge menu's top bar (limits.js in main): a group per installed agent (Claude, Codex), one pill
// per window with its percentage, a small bar with the time already gone in the window marked on it, and the forecast
// in the tooltip. Loaded after common.js.
(() => {
  let limits = null;
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

  function render() {
    const el = $("limits");
    if (!el) return;
    el.innerHTML = limits ? ["claude", "codex"].map(id => group(id, limits.providers?.[id])).join("") : "";
  }

  const set = l => { limits = l; render(); };
  window.manager.onLimitsChanged(set);
  // Asked when the menu comes out (main answers from its last check when that is recent).
  window.limitsUi = { refresh: () => window.manager.getLimits().then(set).catch(() => {}) };
})();
