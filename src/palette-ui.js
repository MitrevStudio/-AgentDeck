// Search (Ctrl+K, or the sidebar's search field): projects and sessions - their titles, folders and ids, and the
// text of the conversations (main's full-text index) - with the chosen session's preview beside the list. Enter opens
// it (a running one comes up, any other is resumed in a new tab), Alt+Enter beside the focused pane; a project comes
// up as the shown space. Loaded after renderer.js: data, live, liveOf, resume, showTerminal, continueFresh, selectProject.
(() => {
  const TEXT_DELAY_MS = 220;
  const MAX_SESSIONS = 80, MAX_PROJECTS = 6, IDLE_SESSIONS = 40;
  const st = { open: false, q: "", items: [], i: 0, text: { q: "", hits: new Map() }, timer: 0, ticket: 0 };
  const box = $("palette"), input = $("palQ"), list = $("palList"), pv = $("palPv");

  // ---------- results ----------
  const byLive = (a, b) => getLiveRank(liveOf(a)) - getLiveRank(liveOf(b)) || lastSign(liveOf(b)) - lastSign(liveOf(a));
  const byDate = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const isTextHit = s => st.text.q !== "" && st.text.q === st.q.trim() && st.text.hits.has(sessionKey(s));
  function compute() {
    const toks = tokenize(st.q);
    const found = toks.length ? data.sessions.filter(s => matches(s.hay, toks) || isTextHit(s)) : data.sessions;
    const running = found.filter(liveOf).sort(byLive);
    const rest = found.filter(s => !liveOf(s)).sort(byDate).slice(0, toks.length ? MAX_SESSIONS : IDLE_SESSIONS);
    const projects = toks.length ? data.projects.filter(p => matches(p.hay, toks)).slice(0, MAX_PROJECTS) : [];
    return [...projects.map(p => ({ p })), ...[...running, ...rest].map(s => ({ s }))];
  }
  function searchText() {
    clearTimeout(st.timer);
    const v = st.q.trim();
    if (!v.split(/\s+/).some(w => [...w].length >= 3)) { st.text = { q: "", hits: new Map() }; return; }
    const ticket = ++st.ticket;
    st.timer = setTimeout(async () => {
      let hits = [];
      try { hits = await window.manager.searchText(v); } catch {}
      if (ticket !== st.ticket || st.q.trim() !== v) return;
      st.text = { q: v, hits: new Map(hits.map(h => [h.key, h.snippet])) };
      render();
    }, TEXT_DELAY_MS);
  }

  // ---------- drawing ----------
  function rowHtml(item, i, toks) {
    const sel = i === st.i ? "sel" : "";
    if (item.p) {
      const p = item.p;
      return `<div class="pal-row ${sel}" data-i="${i}"><span class="pmono" style="--h:${hue(p.n)}">${esc(initials(p.name))}</span>
        <div class="pal-main"><div class="pal-title">${hl(p.name, toks)}</div><div class="pal-sub">${hl(p.path, toks)}</div></div>
        <span class="pal-kind">${esc(t("palette.project"))}</span></div>`;
    }
    const s = item.s, l = liveOf(s);
    const project = data.projects.find(p => inProject(s, p))?.name || s.cwd;
    const snip = isTextHit(s) && !matches(s.hay, toks)
      ? `<div class="pal-snip">${esc(st.text.hits.get(sessionKey(s)).replace(/\s+/g, " ")).replace(/\u0002/g, "<mark>").replace(/\u0003/g, "</mark>")}</div>` : "";
    return `<div class="pal-row ${sel}" data-i="${i}">${agentMark(s.agent)}
      <div class="pal-main"><div class="pal-title">${hl(s.title, toks)}</div><div class="pal-sub">${esc(project)}</div>${snip}</div>
      ${getContextChip(s)}<span class="when">${esc(ago(s.updatedAt))}</span>${l ? statusMark(l, false) : '<span class="st none"></span>'}</div>`;
  }
  function render() {
    st.items = compute();
    st.i = Math.max(0, Math.min(st.i, st.items.length - 1));
    const toks = tokenize(st.q);
    list.innerHTML = st.items.length ? st.items.map((x, i) => rowHtml(x, i, toks)).join("")
      : `<div class="empty small">${esc(t(data.sessions.length ? "palette.none" : "manager.status.scanning"))}</div>`;
    syncPreview();
  }
  function syncPreview() {
    const s = st.items[st.i]?.s;
    pv.hidden = !s;
    showPreview(pv, s || null);
  }
  function select(i) {
    if (!st.items.length) return;
    st.i = (i + st.items.length) % st.items.length;
    list.querySelectorAll(".pal-row").forEach(el => el.classList.toggle("sel", Number(el.dataset.i) === st.i));
    list.querySelector(".pal-row.sel")?.scrollIntoView({ block: "nearest" });
    syncPreview();
  }

  // ---------- acting ----------
  // beside: Alt+Enter - a session not running yet is resumed in a pane beside the focused one.
  async function choose(i, beside = false) {
    const item = st.items[i];
    if (!item) return;
    close();
    try {
      if (item.p) return selectProject(item.p.n);
      const s = item.s;
      if (liveOf(s)) return await showTerminal(s);
      await resume(s, beside ? "right" : "tab");
    } catch (e) { toast(e.message, true); }
  }
  function open(text = "") {
    st.open = true;
    box.hidden = false;
    input.value = text;
    st.q = text;
    st.i = 0;
    searchText();
    render();
    input.focus();
  }
  function close() {
    if (!st.open) return;
    st.open = false;
    box.hidden = true;
    clearTimeout(st.timer);
  }

  // ---------- events ----------
  input.addEventListener("input", () => { st.q = input.value; st.i = 0; searchText(); render(); });
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); select(st.i + (e.key === "ArrowDown" ? 1 : -1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(st.i, e.altKey); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener("mousemove", e => {
    const row = e.target.closest(".pal-row");
    if (row && Number(row.dataset.i) !== st.i) select(Number(row.dataset.i));
  });
  list.addEventListener("click", e => {
    const row = e.target.closest(".pal-row");
    if (row) choose(Number(row.dataset.i), e.altKey);
  });
  // The preview's own buttons (Resume, Continue fresh) act on the chosen session.
  pv.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-action]");
    const s = st.items[st.i]?.s;
    if (!btn || !s) return;
    close();
    try {
      if (btn.dataset.action === "fresh") { await continueFresh(s); toast(t("preview.fresh.started")); }
      else await resume(s);
    } catch (err) { toast(err.message, true); }
  });
  box.addEventListener("mousedown", e => { if (e.target === box) close(); });
  // Ctrl+K anywhere, the terminals included; the sidebar's field opens it too, keeping what was typed.
  document.addEventListener("keydown", e => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyK") { e.preventDefault(); e.stopPropagation(); st.open ? close() : open(); }
  }, true);
  $("openPalette").addEventListener("click", () => open());
  window.manager.onDataChanged(() => { if (st.open) setTimeout(render); });

  // Not window.palette: that name is the #palette element's.
  window.searchPalette = { open, close, isOpen: () => st.open, render: () => st.open && render() };
})();
