// The "Day" tile of the edge menu: one day's work per ticket (or project) with its active time and sessions (day.js
// in main), the days before it a click away, and a summary for the time log written by `claude -p` on request.
// Loaded before bar.js; uses its `model` (the sessions the menu shows - hidden ones are left out here too) and
// openSession() at run time.
(() => {
  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = m => `${Math.floor(m / 60)}:${pad(m % 60)}`;
  const today = () => ymd(new Date());
  const shift = (date, days) => { const [y, m, d] = date.split("-").map(Number); return ymd(new Date(y, m - 1, d + days)); };
  const st = { date: today(), tried: "", rep: null, at: 0, loading: false, error: "", summary: new Map(), summarizing: "", sumError: "" };

  // Wall-clock minutes of merged [from, to] spans.
  function minutes(spans) {
    const s = [...spans].sort((a, b) => a[0] - b[0]);
    let total = 0, cur = null;
    for (const x of s) {
      if (cur && x[0] <= cur[1]) cur[1] = Math.max(cur[1], x[1]);
      else { if (cur) total += cur[1] - cur[0]; cur = [...x]; }
    }
    if (cur) total += cur[1] - cur[0];
    return Math.round(total / 60000);
  }

  // The report without the sessions the menu does not show (hidden ones while hiding is on).
  function visible() {
    if (!st.rep) return null;
    const shown = new Set(model.sessions.map(sessionKey));
    const groups = st.rep.groups.map(g => {
      const sessions = g.sessions.filter(s => shown.has(sessionKey(s)));
      return { ...g, sessions, minutes: minutes(sessions.flatMap(s => s.spans)) };
    }).filter(g => g.sessions.length).sort((a, b) => b.minutes - a.minutes);
    return { ...st.rep, groups, minutes: minutes(groups.flatMap(g => g.sessions.flatMap(s => s.spans))) };
  }
  const hiddenKeys = () => {
    const shown = new Set(model.sessions.map(sessionKey));
    return (st.rep?.groups || []).flatMap(g => g.sessions).map(sessionKey).filter(k => !shown.has(k));
  };

  // Tried once per day shown and then at most once a minute, whether it worked or not (a failing read must not loop
  // with the redraw it causes).
  async function load() {
    if (st.loading) return;
    st.loading = true;
    const date = st.tried = st.date;
    st.at = Date.now();
    try { const rep = await window.manager.getDay(date); if (date === st.date) { st.rep = rep; st.error = ""; } }
    catch (e) { if (date === st.date) st.error = e.message; }
    st.loading = false;
    redraw();
  }
  function redraw() { if (typeof render === "function") render({ strip: false }); }

  function dateLabel(date) {
    if (date === today()) return t("bar.day.today");
    if (date === shift(today(), -1)) return t("bar.day.yesterday");
    const [y, m, d] = date.split("-").map(Number);
    return I18N.formatDate(new Date(y, m - 1, d).getTime(), { weekday: "long", day: "numeric", month: "long" });
  }
  const clock = ms => I18N.formatTime(ms);

  function groupHtml(g) {
    const sessions = g.sessions.map(s => `<div class="drow" data-agent="${esc(s.agent)}" data-id="${esc(s.id)}" title="${esc(t("bar.day.open"))}">
        <span class="adot ${esc(s.agent.toLowerCase())}"></span>
        <div class="rmain"><div class="t">${esc(s.title || s.id)}</div><div class="path">${esc(`${clock(s.from)}–${clock(s.to)}${s.branch ? ` · ${s.branch}` : ""}`)}</div></div>
        <span class="when">${esc(hm(s.minutes))}</span></div>`).join("");
    return `<div class="dgroup"><div class="dg-head"><span class="dg-name">${esc(g.ticket || g.project)}</span>${g.ticket ? `<span class="dg-sub">${esc(g.project)}</span>` : ""}<span class="grow"></span><span class="dg-time">${esc(hm(g.minutes))}</span></div>${sessions}</div>`;
  }

  function summaryHtml() {
    const text = st.summary.get(st.date);
    const body = st.summarizing === st.date ? `<div class="empty">${esc(t("bar.day.summarizing"))}</div>`
      : st.sumError ? `<div class="empty err">${esc(st.sumError)}</div>`
      : text ? `<div class="dsum-text">${esc(text)}</div>`
      : `<div class="empty">${esc(t("bar.day.summaryHint"))}</div>`;
    return `<aside class="pv dsum"><div class="pv-title"><span class="t">${esc(t("bar.day.summary"))}</span><span class="grow"></span>
      ${text ? `<button class="icon-btn" data-day="copy" title="${esc(t("bar.day.copy"))}">${icon("copy")}</button>` : ""}</div>${body}</aside>`;
  }

  // The whole #detail for the tile.
  function html() {
    if (st.tried !== st.date || Date.now() - st.at > 60000) load();
    const rep = visible();
    const isToday = st.date === today();
    const head = `<div class="dhead"><span class="mono sm special day">${icon("clock")}</span>
      <div class="dtitle"><div class="dname">${esc(dateLabel(st.date))}${rep ? ` · ${esc(hm(rep.minutes))}` : ""}</div><div class="dsub">${esc(t("bar.day.sub"))}</div></div>
      <div class="dactions"><button class="btn" data-day="prev" title="${esc(t("bar.day.prev"))}">${icon("left")}</button>
        <button class="btn" data-day="today" ${isToday ? "disabled" : ""}>${esc(t("bar.day.today"))}</button>
        <button class="btn" data-day="next" title="${esc(t("bar.day.next"))}" ${isToday ? "disabled" : ""}>${icon("right")}</button>
        <button class="btn" data-day="summary" title="${esc(t("bar.day.summaryTitle"))}" ${st.summarizing || !rep?.groups.length ? "disabled" : ""}>${icon("bolt")}${esc(t("bar.day.summarize"))}</button></div></div>`;
    const list = st.error ? `<div class="empty err">${esc(st.error)}</div>`
      : !rep ? `<div class="empty">${esc(t("bar.loading"))}</div>`
      : rep.groups.length ? rep.groups.map(groupHtml).join("") : `<div class="empty">${esc(t("bar.day.none"))}</div>`;
    return head + `<div class="dbody"><div class="rows" id="rows">${list}</div>${summaryHtml()}</div>`;
  }

  async function summarize() {
    const date = st.date;
    st.summarizing = date; st.sumError = "";
    redraw();
    try { st.summary.set(date, await window.manager.summarizeDay(date, hiddenKeys())); }
    catch (e) { st.sumError = t("bar.day.summaryFailed", { error: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }); }
    if (st.summarizing === date) st.summarizing = "";
    redraw();
  }

  document.addEventListener("click", e => {
    const b = e.target.closest("[data-day]");
    if (b) {
      e.stopPropagation();
      const a = b.dataset.day;
      if (a === "prev" || a === "next" || a === "today") {
        st.date = a === "today" ? today() : shift(st.date, a === "prev" ? -1 : 1);
        if (st.date > today()) st.date = today();
        st.rep = null; st.error = ""; st.sumError = "";
        redraw();
      } else if (a === "summary") summarize();
      else if (a === "copy") window.manager.copyText(st.summary.get(st.date) || "").then(() => toast(t("bar.day.copied")));
      return;
    }
    const row = e.target.closest(".drow");
    if (row) {
      const s = model.sessions.find(x => x.agent === row.dataset.agent && x.id === row.dataset.id);
      if (s) openSession(s)?.catch?.(err => toast(err.message, true));
    }
  }, true);

  // Shown only while it is switched on in Settings (prefs.dayView); switched, the strip is drawn again.
  let enabled = window.prefs?.dayView === true;
  window.prefs?.onChanged?.(p => {
    const on = p?.dayView === true;
    if (on === enabled) return;
    enabled = on;
    if (typeof render === "function") render();
  });

  window.dayUi = { html, enabled: () => enabled, reset: () => { st.date = today(); st.rep = null; } };
})();
