// The plan limits in the edge menu's top bar (limits.js in main): one pill per window with its percentage, a small bar
// with the time already gone in the window marked on it, and the forecast in the tooltip. Loaded after common.js.
(() => {
  let limits = null;
  const LABEL = { five_hour: "bar.limits.five", seven_day: "bar.limits.week" };
  const when = ms => {
    if (!ms) return "?";
    return new Date(ms).toDateString() === new Date().toDateString()
      ? I18N.formatTime(ms)
      : I18N.formatDateTime(ms, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  };
  const errText = l => t(`bar.limits.err.${l.error}`, { detail: l.detail || "" });

  function pill(w) {
    const level = w.util >= 95 ? "danger" : w.runsOut || w.util >= 80 ? "warn" : "";
    const tip = [
      t(`${LABEL[w.key]}.long`, { u: w.util, e: w.elapsedPct }),
      t("bar.limits.resets", { when: when(w.resetsAt) }),
      w.util >= 100 ? t("bar.limits.full")
        : w.fullAt ? t(w.runsOut ? "bar.limits.runsOut" : "bar.limits.lasts", { when: when(w.fullAt) }) : t("bar.limits.noBurn")
    ];
    if (w.key === "seven_day") for (const s of limits.scoped || []) tip.push(t("bar.limits.scoped", { name: s.name, u: s.util }));
    if (limits.error) tip.push(errText(limits));
    return `<span class="lim ${level}" title="${esc(tip.join("\n"))}"><span class="lim-k">${esc(t(LABEL[w.key]))}</span>${esc(String(w.util))}%`
      + `<span class="lim-bar"><i style="width:${Math.min(100, w.util)}%"></i><b style="left:${w.elapsedPct}%"></b></span></span>`;
  }

  function render() {
    const el = $("limits");
    if (!el) return;
    if (!limits || (!limits.windows?.length && !limits.error)) { el.innerHTML = ""; return; }
    el.innerHTML = limits.windows?.length
      ? limits.windows.map(pill).join("")
      : `<span class="lim err" title="${esc(errText(limits))}">${esc(t("bar.limits.unknown"))}</span>`;
  }

  const set = l => { limits = l; render(); };
  window.manager.onLimitsChanged(set);
  // Asked when the menu comes out (main answers from its last check when that is recent).
  window.limitsUi = { refresh: () => window.manager.getLimits().then(set).catch(() => {}) };
})();
