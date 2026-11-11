// The plan limits in the edge menu's top bar (limits.js in main): a group per installed agent (Claude, Codex), one pill
// per window with its percentage, a small bar with the time already gone in the window marked on it, and the forecast
// in the tooltip. In the manager's status bar: this computer in full, every other computer as one short chip - its
// name and its fullest limit - that opens to the full figures on a click. Loaded after common.js.
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
  const getLevel = w => (w.util >= 95 ? "danger" : w.runsOut || w.util >= 80 ? "warn" : "");
  const getWindowKey = (w, provider) => (provider === "claude" ? LABEL[w.key] : !w.label && STANDARD[w.durationMins]);
  const getWindowLabel = (w, provider) => (getWindowKey(w, provider) ? t(getWindowKey(w, provider)) : codexLabel(w));
  function pill(w, provider, state) {
    const level = getLevel(w);
    const e = w.elapsedPct ?? "?"; // null: the reset time is not known
    const key = getWindowKey(w, provider);
    const tip = [
      key ? t(`${key}.long`, { u: w.util, e }) : t("bar.limits.codex.long", { name: codexLabel(w), u: w.util, e }),
      t("bar.limits.resets", { when: when(w.resetsAt) }),
      w.util >= 100 ? t("bar.limits.full")
        : w.fullAt ? t(w.runsOut ? "bar.limits.runsOut" : "bar.limits.lasts", { when: when(w.fullAt) }) : t("bar.limits.noBurn")
    ];
    if (provider === "claude" && w.key === "seven_day") for (const s of state.scoped || []) tip.push(t("bar.limits.scoped", { name: s.name, u: s.util }));
    if (state.error) tip.push(errText(state, provider));
    if (state.error && state.at) tip.push(t("bar.limits.stale", { when: when(state.at) }));
    const label = getWindowLabel(w, provider);
    // In the status bar the computer's card says all of it (showCard), so nothing here has a tooltip of its own.
    return `<span class="lim ${level} ${state.error ? "stale" : ""}"${inBar ? "" : ` title="${esc(tip.join("\n"))}"`}><span class="lim-k">${esc(label)}</span><span class="lim-value">${esc(String(Math.round(w.util)))}%</span>`
      + `<span class="lim-bar"><i style="width:${Math.max(0, Math.min(100, w.util))}%"></i>${w.elapsedPct == null ? "" : `<b style="left:${w.elapsedPct}%"></b>`}</span></span>`;
  }

  function errText(state, provider) {
    const key = provider === "codex" ? `bar.limits.codex.err.${state.error}` : `bar.limits.err.${state.error}`;
    return t(key, { detail: state.detail || "" });
  }

  // Why an agent shows no figures.
  const getMissingText = (state, provider) => (state.error ? errText(state, provider) : t(state.loading ? "bar.limits.loading" : "resources.noLimits"));

  // The manager's status bar (the edge menu has the same pills in its top bar, with no computers).
  const inBar = Boolean(document.querySelector("footer.status"));
  const PROVIDERS = ["claude", "codex"];
  function group(provider, state) {
    if (!state?.installed) return "";
    const name = t(`bar.limits.provider.${provider}`);
    const contents = state.windows?.length ? state.windows.map(w => pill(w, provider, state)).join("")
      : `<span class="lim err"${inBar ? "" : ` title="${esc(getMissingText(state, provider))}"`}>${esc(state.loading ? t("bar.limits.loading") : "—")}</span>`;
    return `<div class="lim-group ${provider}"><span class="lim-provider">${esc(name)}</span>${contents}</div>`;
  }

  const gib = n => I18N.formatNumber(n / 1073741824, { maximumFractionDigits: 1 });
  const CPU_ICON = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></svg>';
  const RAM_ICON = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 10v3m5-3v3m5-3v3M6 17v3m4-3v3m4-3v3m4-3v3"/></svg>';
  // The computers opened to their full figures: this window's own choice.
  const OPEN_KEY = "agentdeck.limitsOpen";
  let open = new Set();
  try { open = new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []); } catch {}
  function toggleOpen(id) {
    if (!open.delete(id)) open.add(id);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch {}
    render();
  }
  const getProviderState = (snapshot, installed, id) => snapshot?.providers?.[id] || (installed.some(a => a.toLowerCase() === id) ? { installed: true } : null);
  const getCpu = stats => (stats?.cpu == null ? "" : Math.round(stats.cpu) + "%");
  const getRam = stats => (stats?.memory?.total ? Math.round(stats.memory.used / stats.memory.total * 100) + "%" : "");
  // From here on a processor or a memory counts as nearly full: its figure beats in red in the bar.
  const HOT_PCT = 90;
  const isHot = text => parseInt(text, 10) >= HOT_PCT;
  const resourceValue = (name, glyph, text) => (text ? `<span class="resource-value${isHot(text) ? " hot" : ""}" aria-label="${name} ${text}">${glyph}${text}</span>` : "");
  // CPU and memory, or nothing when the computer sent none. hotOnly: a chip, which shows them only once they are
  // nearly full.
  function resourcesHtml(stats, hotOnly = false) {
    const cpu = getCpu(stats), ram = getRam(stats);
    const html = (hotOnly && !isHot(cpu) ? "" : resourceValue("CPU", CPU_ICON, cpu)) + (hotOnly && !isHot(ram) ? "" : resourceValue("RAM", RAM_ICON, ram));
    return html ? `<span class="machine-resources">${html}</span>` : "";
  }
  const isMachineHot = m => !m.offline && (isHot(getCpu(m.stats)) || isHot(getRam(m.stats)));
  // The fullest limit among some windows.
  const getFullest = windows => [...(windows || [])].sort((a, b) => b.util - a.util)[0] || null;
  // m: a computer of the bar - { id, name, snapshot, stats, installed, offline, local }.
  const getWindows = m => PROVIDERS.flatMap(id => getProviderState(m.snapshot, m.installed, id)?.windows || []);
  // Another computer opened to its figures: its name closes it back to a chip.
  function machine(m) {
    const providers = PROVIDERS.map(p => group(p, getProviderState(m.snapshot, m.installed, p))).join("");
    const label = `<span class="machine-dot"></span>${esc(m.name)}`;
    const head = m.local ? `<strong class="machine-name">${label}</strong>`
      : `<button class="machine-name" data-machine="${esc(m.id)}" aria-expanded="true">${label}</button>`;
    return `<div class="machine-status${m.offline ? " offline" : ""}" data-card="${esc(m.id)}">${head}${m.offline ? `<span class="machine-offline">${esc(t("manager.node.offline"))}</span>` : ""}<span class="machine-providers">${providers}</span>${resourcesHtml(m.stats)}</div>`;
  }
  // A computer in short: its name, a small meter per agent (its fullest limit) and the fullest figure of all.
  function chip(m) {
    const meters = m.offline ? "" : PROVIDERS.map(id => {
      const w = getFullest(getProviderState(m.snapshot, m.installed, id)?.windows);
      return w ? `<span class="machine-meter ${id} ${getLevel(w)}"><i style="width:${Math.max(8, Math.min(100, w.util))}%"></i></span>` : "";
    }).join("");
    const w = m.offline ? null : getFullest(getWindows(m));
    return `<button class="machine-status${m.offline ? " offline" : ""} chip${isMachineHot(m) ? " hot" : ""}" data-machine="${esc(m.id)}" data-card="${esc(m.id)}" aria-expanded="false"><span class="machine-name"><span class="machine-dot"></span>${esc(m.name)}</span>${meters ? `<span class="machine-meters">${meters}</span>` : ""}${w ? `<span class="machine-fullest ${getLevel(w)}">${Math.round(w.util)}%</span>` : ""}${m.offline ? "" : resourcesHtml(m.stats, true)}</button>`;
  }

  // ---------- a computer's card ----------
  // Shown above a computer of the bar while it is pointed at or has the keyboard: every limit with its bar, when it
  // resets and how the pace looks, then the processor, the memory and the disk.
  const meter = (pct, level = "", mark = null) => `<span class="mc-bar ${level}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i>${mark == null ? "" : `<b style="left:${mark}%"></b>`}</span>`;
  const cardRow = (k, pct, value, note, level = "", mark = null) => `<div class="mc-row ${level}"><span class="mc-k">${esc(k)}</span>${meter(pct, level, mark)}<span class="mc-v">${esc(value)}</span><span class="mc-note">${esc(note)}</span></div>`;
  function getPaceText(w) {
    if (w.util >= 100) return t("bar.limits.full");
    return w.runsOut && w.fullAt ? t("bar.limits.runsOut", { when: when(w.fullAt) }) : "";
  }
  function providerCard(m, id) {
    const state = getProviderState(m.snapshot, m.installed, id);
    if (!state?.installed) return "";
    const rows = (state.windows || []).map(w => cardRow(getWindowLabel(w, id), w.util, `${Math.round(w.util)}%`, w.resetsAt ? t("bar.limits.resets", { when: when(w.resetsAt) }) : "", getLevel(w), w.elapsedPct)
      + (getPaceText(w) ? `<div class="mc-warn ${getLevel(w)}">${esc(getPaceText(w))}</div>` : "")).join("");
    const scoped = id === "claude" ? (state.scoped || []).map(s => `<div class="mc-text">${esc(t("bar.limits.scoped", { name: s.name, u: s.util }))}</div>`).join("") : "";
    const stale = state.error && state.windows?.length ? `<div class="mc-text">${esc([errText(state, id), state.at ? t("bar.limits.stale", { when: when(state.at) }) : ""].filter(Boolean).join(" "))}</div>` : "";
    return `<section class="mc-part ${id}"><h4>${esc(t(`bar.limits.provider.${id}`))}</h4>${rows || `<div class="mc-text">${esc(getMissingText(state, id))}</div>`}${scoped}${stale}</section>`;
  }
  function resourcesCard(stats) {
    if (!stats) return `<section class="mc-part"><div class="mc-text">${esc(t("resources.unavailable"))}</div></section>`;
    const memory = stats.memory?.total ? stats.memory : null, disk = stats.disk?.total ? stats.disk : null;
    const share = (used, total) => Math.round(used / total * 100);
    const getLoadLevel = pct => (pct >= HOT_PCT ? "danger" : pct >= 80 ? "warn" : "");
    const rows = [
      stats.cpu == null ? "" : cardRow("CPU", stats.cpu, getCpu(stats), stats.cores ? t("resources.cores", { n: stats.cores }) : "", getLoadLevel(stats.cpu)),
      memory ? cardRow("RAM", share(memory.used, memory.total), getRam(stats), `${gib(memory.used)} / ${gib(memory.total)} GiB`, getLoadLevel(share(memory.used, memory.total))) : "",
      disk ? cardRow(t("resources.disk"), share(disk.total - disk.free, disk.total), `${share(disk.total - disk.free, disk.total)}%`, t("resources.diskLeft", { free: gib(disk.free), path: disk.path }), getLoadLevel(share(disk.total - disk.free, disk.total))) : ""
    ].join("");
    return rows ? `<section class="mc-part"><h4>${esc(t("resources.title"))}<span>${esc(I18N.formatTime(stats.at))}</span></h4>${rows}</section>` : "";
  }
  function cardHtml(m) {
    const state = m.offline ? t("manager.node.offline") : m.local ? t("resources.local") : t("manager.node.online");
    const hint = m.local ? "" : `<footer>${esc(t(open.has(m.id) ? "resources.closeHint" : "resources.openHint", { name: m.name }))}</footer>`;
    return `<header class="${m.offline ? "offline" : ""}"><span class="machine-dot"></span><b>${esc(m.name)}</b><span>${esc(state)}</span></header>`
      + PROVIDERS.map(id => providerCard(m, id)).join("") + (m.offline && !m.stats ? "" : resourcesCard(m.stats)) + hint;
  }
  let card = null, cardFor = "";
  function showCard(id) {
    const m = getMachines().find(x => x.id === id), anchor = m && $("limits").querySelector(`[data-card="${CSS.escape(id)}"]`);
    if (!anchor) return hideCard();
    if (!card) {
      card = document.createElement("div");
      card.className = "machine-card";
      card.setAttribute("role", "tooltip");
      document.body.append(card);
    }
    cardFor = id;
    setHtml(card, cardHtml(m));
    card.hidden = false;
    // Above the computer, its middle over the computer's, kept inside the window.
    const a = anchor.getBoundingClientRect(), w = card.offsetWidth, GAP = 8;
    card.style.left = `${Math.round(Math.max(GAP, Math.min(innerWidth - w - GAP, a.left + a.width / 2 - w / 2)))}px`;
    card.style.bottom = `${Math.round(innerHeight - a.top + GAP)}px`;
  }
  function hideCard() {
    cardFor = "";
    if (card) card.hidden = true;
  }

  function getMachines() {
    const local = { id: "local", name: resources?.name || t("resources.local"), snapshot: limits, stats: resources, installed: agents, offline: false, local: true };
    const others = [...peers].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, { numeric: true }))
      .map(n => ({ id: n.id, name: n.name, snapshot: n.limits, stats: n.resources, installed: n.data?.agents || n.info?.agents || [], offline: n.status !== "online", local: false }));
    return [local, ...others];
  }
  function render() {
    const el = $("limits");
    if (!el) return;
    if (!inBar) {
      el.innerHTML = limits ? PROVIDERS.map(id => group(id, limits.providers?.[id])).join("") : "";
      return;
    }
    setHtml(el, getMachines().map(m => (m.local || open.has(m.id) ? machine(m) : chip(m))).join(""));
    // New figures while a card is up: it follows them, on the element that now stands for its computer.
    if (cardFor) showCard(cardFor);
  }

  const set = l => { limits = l; render(); };
  window.manager.onLimitsChanged(set);
  if (inBar) {
    $("limits").addEventListener("click", e => {
      const id = e.target.closest("[data-machine]")?.dataset.machine;
      if (id) toggleOpen(id);
    });
    const getCardId = e => e.target.closest?.("[data-card]")?.dataset.card || "";
    $("limits").addEventListener("mouseover", e => { const id = getCardId(e); if (id && id !== cardFor) showCard(id); });
    $("limits").addEventListener("mouseleave", hideCard);
    $("limits").addEventListener("focusin", e => { const id = getCardId(e); if (id) showCard(id); });
    $("limits").addEventListener("focusout", hideCard);
    $("limits").addEventListener("scroll", hideCard, { passive: true });
    window.addEventListener("blur", hideCard);
    // The wheel moves along the bar when the computers do not all fit.
    $("limits").addEventListener("wheel", e => {
      const el = e.currentTarget;
      if (e.deltaX || !e.deltaY || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft -= e.deltaY;
    }, { passive: false });
    // The computer's name also stands on its terminals (workspace-ui.js), which are drawn again once it is known.
    const setResources = r => { const named = !resources?.name && r?.name; resources = r; render(); if (named && typeof renderWorkspace === "function") renderWorkspace(); };
    window.manager.onResourcesChanged(setResources);
    window.manager.getResources().then(setResources).catch(() => {});
    window.manager.onNodesChanged(list => { peers = list || []; render(); });
    window.manager.getNodes().then(list => { peers = list || []; render(); }).catch(() => {});
    const setAgents = d => { agents = d?.agents || []; render(); };
    window.manager.getData().then(setAgents).catch(() => {});
    window.manager.onDataChanged(setAgents);
    // The page's first scan may be back before this script runs, and would then not have asked.
    window.manager.getLimits().then(set).catch(() => {});
  }
  // Asked when the menu comes out (main answers from its last check when that is recent).
  // getLocalName: this computer's own name, once main has measured it ("" until then).
  window.limitsUi = { refresh: () => window.manager.getLimits().then(set).catch(() => {}), getLocalName: () => resources?.name || "" };
})();
