// Edge menu: project tiles in a horizontal strip, the selected project's sessions below, one search for both.
let raw = { registry: { projects: [] }, sessions: [], agents: [] };
let model = { projects: [], sessions: [] };
let live = new Map(), liveSig = "";
let tiles = [], rows = [];
// tile: selected tile key; row: highlighted row (-1 = none); confirm: session key awaiting "open again"; dir: typed directory
const st = { tile: "", row: -1, confirm: "", dir: "", shown: false };
const q = $("q");
const liveOf = s => live.get(sessionKey(s));

function initials(name) {
  const words = String(name).replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s\-_.]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}
function hue(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
const byLive = (a, b) => liveRank(liveOf(a)) - liveRank(liveOf(b)) || lastSign(liveOf(b)) - lastSign(liveOf(a));
const liveFirst = list => [...list.filter(liveOf).sort(byLive), ...list.filter(s => !liveOf(s))];

// ---------- model ----------
function computeTiles() {
  const toks = tokenize(q.value);
  const hits = toks.length ? model.sessions.filter(s => matches(s.hay, toks)) : model.sessions;
  const hitSet = new Set(hits);
  const out = [];
  if (toks.length) out.push({ key: "results", kind: "results", label: t("bar.tile.results"), count: hits.length + (st.dir ? 1 : 0) });
  const running = model.sessions.filter(liveOf);
  if (running.length && !toks.length) out.push({ key: "live", kind: "live", label: t("bar.tile.live"), count: running.length });
  for (const p of model.projects) {
    const inside = toks.length ? p.sessions.filter(s => hitSet.has(s)) : p.sessions;
    if (toks.length && !inside.length && !matches(p.hay, toks)) continue;
    const states = p.sessions.map(liveOf).filter(Boolean);
    out.push({
      key: "p:" + p.n, kind: "project", p, label: p.name, count: inside.length,
      busy: states.some(l => l.status === "busy" && !isStale(l)), idle: states.some(l => l.status !== "busy")
    });
  }
  return { toks, hits, tiles: out };
}

function rowsFor(tile, toks, hits) {
  if (!tile) return [];
  if (tile.kind === "results") {
    const dir = st.dir ? [{ type: "dir", path: st.dir }] : [];
    return [...dir, ...liveFirst(hits).slice(0, 150).map(s => ({ type: "session", s, showPath: true }))];
  }
  if (tile.kind === "live") return model.sessions.filter(liveOf).sort(byLive).map(s => ({ type: "session", s, showPath: true }));
  const list = toks.length ? tile.p.sessions.filter(s => matches(s.hay, toks)) : tile.p.sessions;
  return liveFirst(list).map(s => ({ type: "session", s, showPath: s.cwdN !== tile.p.n }));
}

// ---------- rendering ----------
function render({ strip = true } = {}) {
  const { toks, hits, tiles: list } = computeTiles();
  tiles = list;
  if (!tiles.some(tile => tile.key === st.tile)) { st.tile = tiles[0]?.key || ""; st.row = q.value ? 0 : -1; }
  const cur = tiles.find(tile => tile.key === st.tile);
  rows = rowsFor(cur, toks, hits);
  if (st.row >= rows.length) st.row = rows.length ? 0 : -1;
  if (strip) renderStrip(toks); else markTiles();
  renderDetail(cur, toks);
  renderLiveSum();
}

function tileHtml(tile, toks) {
  const badge = tile.busy ? '<span class="badge"><span class="spinner"></span></span>' : tile.idle ? '<span class="badge"><span class="pulse"></span></span>' : "";
  const mono = tile.kind === "project"
    ? `<span class="mono" style="--h:${hue(tile.p.n)}">${esc(initials(tile.label))}${badge}</span>`
    : `<span class="mono special ${tile.kind}">${icon(tile.kind === "live" ? "pulse" : "search")}</span>`;
  return `<button class="tile ${tile.key === st.tile ? "sel" : ""}" data-key="${esc(tile.key)}" title="${esc(tile.kind === "project" ? `${tile.label}\n${tile.p.path}` : tile.label)}">
    ${mono}<span class="tname">${tile.kind === "project" ? hl(tile.label, toks) : esc(tile.label)}</span><span class="tcount">${tile.count}</span></button>`;
}
function renderStrip(toks) {
  $("strip").innerHTML = tiles.length ? tiles.map(tile => tileHtml(tile, toks)).join("") : `<div class="none">${esc(t("bar.noProjects", { q: q.value }))}</div>`;
  updateNav();
}
function markTiles() {
  document.querySelectorAll(".tile").forEach(el => el.classList.toggle("sel", el.dataset.key === st.tile));
}
function updateNav() {
  const s = $("strip");
  $("navL").classList.toggle("on", s.scrollLeft > 4);
  $("navR").classList.toggle("on", s.scrollLeft + s.clientWidth < s.scrollWidth - 4);
}

function newButtons(cwd) {
  return (raw.agents?.length ? raw.agents : AGENTS).map(a =>
    `<button class="btn new ${a.toLowerCase()}" data-act="new" data-agent="${a}" data-path="${esc(cwd)}" title="${esc(t("bar.newSession", { agent: a, path: cwd }))}">${icon("plus")}${a}</button>`).join("");
}
function renderDetail(tile, toks) {
  if (!tile) {
    $("detail").innerHTML = `<div class="empty">${esc(t(model.projects.length ? "bar.nothingFound" : "bar.loading"))}</div>`;
    return;
  }
  const head = tile.kind === "project"
    ? `<div class="dhead"><span class="mono sm" style="--h:${hue(tile.p.n)}">${esc(initials(tile.label))}</span>
        <div class="dtitle"><div class="dname">${hl(tile.label, toks)}</div>${pathHtml(tile.p.path, toks)}</div>
        <button class="icon-btn" data-act="copy" data-path="${esc(tile.p.path)}" title="${esc(t("action.copyPath"))}">${icon("copy")}</button>
        <div class="dactions">${newButtons(tile.p.path)}
          <button class="btn" data-act="terminal" data-path="${esc(tile.p.path)}">${icon("terminal")}${esc(t("action.terminal"))}</button>
          <button class="btn" data-act="explorer" data-path="${esc(tile.p.path)}">${icon("open")}${esc(t("action.explorer"))}</button></div></div>`
    : `<div class="dhead"><div class="dtitle"><div class="dname">${esc(tile.kind === "live" ? t("bar.live.title") : t("bar.results.title", { q: q.value }))}</div>
        <div class="dsub">${esc(tile.kind === "live" ? t("bar.live.sub") : tn("bar.results.count", tile.count))}</div></div></div>`;
  const empty = t(tile.kind === "project" ? (toks.length ? "bar.empty.projectNoMatch" : "bar.empty.project") : "bar.empty.results");
  $("detail").innerHTML = head + `<div class="rows" id="rows">${rows.length ? rows.map((r, i) => rowHtml(r, i, toks)).join("") : `<div class="empty">${esc(empty)}</div>`}</div>`;
}
function livePill(l, key) {
  if (!l) return "";
  const busy = l.status === "busy";
  return `<span class="live ${busy ? "busy" : "idle"} ${isStale(l) ? "stale" : ""}" data-live="${esc(key)}">
    <span class="${busy ? "spinner" : "pulse"}"></span>${esc(t(busy ? "live.label.busy" : "live.label.idle"))}<span class="live-t">${esc(liveText(l))}</span></span>`;
}
function rowHtml(r, i, toks) {
  if (r.type === "dir") {
    return `<div class="row dir ${i === st.row ? "sel" : ""}" data-i="${i}"><span class="ricon">${icon("folder")}</span>
      <div class="rmain"><div class="t">${esc(t("bar.dir.new"))}</div>${pathHtml(r.path, [])}</div>
      <div class="ract show">${newButtons(r.path)}</div></div>`;
  }
  const s = r.s, l = liveOf(s), key = sessionKey(s);
  const confirm = st.confirm === key && l
    ? `<div class="confirm">${esc(t("bar.confirm.openAgain", { pid: l.pid }))}
        <button class="btn warn" data-act="resume-anyway">${esc(t("action.openAgain"))}</button><button class="btn" data-act="cancel">${esc(t("common.cancel"))}</button></div>`
    : "";
  return `<div class="row ${i === st.row ? "sel" : ""} ${l ? "is-live" : ""}" data-i="${i}">
    <span class="adot ${s.agent.toLowerCase()}" title="${esc(s.agent)}"></span>
    <div class="rmain"><div class="t" title="${esc(s.title)}">${hl(s.title, toks)}</div>${r.showPath && s.cwd ? pathHtml(s.cwd, toks) : ""}</div>
    ${livePill(l, key)}<span class="when" title="${esc(fullDate(s.updatedAt))}">${esc(ago(s.updatedAt))}</span>
    <span class="ract">${s.cwd ? `<button class="icon-btn" data-act="terminal" data-path="${esc(s.cwd)}" title="${esc(t("bar.terminalIn", { path: s.cwd }))}">${icon("terminal")}</button>
      <button class="icon-btn" data-act="copy" data-path="${esc(s.cwd)}" title="${esc(t("action.copyPath"))}">${icon("copy")}</button>` : ""}
      <button class="icon-btn go" data-act="resume" title="${esc(t(l ? "bar.alreadyOpen" : "action.resume"))}">${icon("play")}</button></span>
  </div>${confirm}`;
}
function renderLiveSum() {
  let busy = 0, idle = 0;
  for (const l of live.values()) l.status === "busy" ? busy++ : idle++;
  $("liveSum").innerHTML = busy || idle
    ? `<button class="sum" data-act="show-live" title="${esc(t("bar.showLive"))}">${busy ? `<span class="spinner"></span>${esc(tn("live.count.busy", busy))}` : ""}${busy && idle ? '<span class="sep"></span>' : ""}${idle ? `<span class="pulse"></span>${esc(tn("live.count.idle", idle))}` : ""}</button>`
    : "";
}
function updateLiveTexts() {
  document.querySelectorAll("[data-live]").forEach(el => {
    const l = live.get(el.dataset.live);
    if (!l) return;
    el.querySelector(".live-t").textContent = liveText(l);
    el.classList.toggle("stale", isStale(l));
  });
}
function markRows() {
  document.querySelectorAll(".row").forEach(el => el.classList.toggle("sel", Number(el.dataset.i) === st.row));
  document.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 4500 : 1800);
}

// ---------- actions ----------
const hide = () => window.manager.barCommand("hide");
async function launch(fn) { await fn(); hide(); }
async function resume(s) {
  if (!s) return;
  if (!s.cwd) return toast(t("errors.sessionNoDir"), true);
  if (liveOf(s)) { st.confirm = sessionKey(s); return render({ strip: false }); }
  await launch(() => window.manager.launchAgent(s.agent, s.id, s.cwd));
}
async function act(name, el) {
  const path = el.dataset.path;
  try {
    if (name === "resume") return await resume(rows[Number(el.closest(".row")?.dataset.i)]?.s);
    if (name === "resume-anyway") {
      const s = rows.find(r => r.s && sessionKey(r.s) === st.confirm)?.s;
      st.confirm = "";
      if (s) await launch(() => window.manager.launchAgent(s.agent, s.id, s.cwd));
      return;
    }
    if (name === "cancel") { st.confirm = ""; return render({ strip: false }); }
    if (name === "new") return await launch(() => window.manager.launchNew(el.dataset.agent, path));
    if (name === "terminal") return await launch(() => window.manager.launchFolder(path));
    if (name === "explorer") { const err = await window.manager.openPath(path); if (err) throw new Error(err); return hide(); }
    if (name === "copy") { await window.manager.copyText(path); return toast(t("toast.copied", { path })); }
    if (name === "show-live") { setQuery(""); return selectTile("live"); }
  } catch (e) { toast(e.message, true); }
}
function selectTile(key) {
  if (!key || key === st.tile) return;
  st.tile = key; st.row = q.value ? 0 : -1; st.confirm = "";
  render({ strip: false });
  document.querySelector(`.tile[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
function moveTile(delta) {
  const i = tiles.findIndex(tile => tile.key === st.tile);
  const next = tiles[Math.max(0, Math.min(tiles.length - 1, i + delta))];
  if (next) selectTile(next.key);
}
function moveRow(delta) {
  if (!rows.length) return;
  st.row = st.row < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, st.row + delta));
  markRows();
}
// Enter: resume the highlighted session, or start the first available agent in a typed directory.
function activateRow() {
  const r = rows[st.row >= 0 ? st.row : 0];
  if (!r) return;
  const run = r.type === "dir"
    ? launch(() => window.manager.launchNew((raw.agents?.length ? raw.agents : AGENTS)[0], r.path))
    : resume(r.s);
  run.catch(e => toast(e.message, true));
}

const looksLikePath = v => /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("\\\\");
let dirCheck = 0;
async function setQuery(value) {
  if (q.value !== value) q.value = value;
  st.confirm = ""; st.row = value ? 0 : -1;
  // Typing pins the menu open in hover mode, so moving the mouse away does not lose the query.
  window.manager.barCommand("pin", Boolean(value));
  const v = value.trim(), ticket = ++dirCheck;
  st.dir = looksLikePath(v) ? await window.manager.isDir(v) : "";
  if (ticket !== dirCheck) return; // a newer keystroke won
  if (value) st.tile = "results";
  render();
}

// ---------- data ----------
function applyData(d) { raw = d; model = buildData(raw, live); if (st.shown) render(); }
async function pollLive() {
  if (!st.shown) return;
  let list;
  try { list = await window.manager.getLive(); } catch { return; }
  live = new Map(list.map(l => [sessionKey(l), l]));
  const sig = list.map(l => `${sessionKey(l)}:${l.status}`).sort().join("|");
  if (sig === liveSig) return updateLiveTexts();
  liveSig = sig;
  model = buildData(raw, live);
  render();
}

// ---------- events ----------
window.manager.onDataChanged(applyData);
window.manager.onBarEvent(ev => {
  if (ev.type === "show") {
    st.shown = true; st.tile = ""; st.row = -1; st.confirm = ""; st.dir = ""; q.value = "";
    $("hotkey").textContent = ev.hotkey ? t("bar.hint.hotkey", { hotkey: ev.hotkey }) : t("bar.hint.edge");
    model = buildData(raw, live);
    render();
    $("strip").scrollLeft = 0; updateNav();
    $("shell").classList.add("in");
    pollLive();
    if (ev.mode === "hotkey") q.focus();
  }
  if (ev.type === "hide") { st.shown = false; $("shell").classList.remove("in"); q.blur(); }
  if (ev.type === "focus") { q.focus(); q.select(); }
});

q.addEventListener("input", () => setQuery(q.value));
$("openManager").addEventListener("click", () => window.manager.barCommand("open-manager"));
$("navL").addEventListener("click", () => $("strip").scrollBy({ left: -$("strip").clientWidth * 0.7 }));
$("navR").addEventListener("click", () => $("strip").scrollBy({ left: $("strip").clientWidth * 0.7 }));
$("strip").addEventListener("scroll", updateNav);
// The mouse wheel scrolls the strip sideways.
$("strip").addEventListener("wheel", e => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.preventDefault();
  $("strip").scrollLeft += e.deltaY;
}, { passive: false });

// Pointing at a tile switches the project immediately (no hover delay, by the user's choice).
$("strip").addEventListener("mouseover", e => {
  const tile = e.target.closest(".tile");
  if (tile) selectTile(tile.dataset.key);
});

document.addEventListener("click", e => {
  const btn = e.target.closest("button[data-act]");
  if (btn) { e.stopPropagation(); return act(btn.dataset.act, btn); }
  const row = e.target.closest(".row:not(.dir)");
  if (row) resume(rows[Number(row.dataset.i)]?.s).catch(err => toast(err.message, true));
});
$("detail").addEventListener("mousemove", e => {
  const row = e.target.closest(".row");
  if (row && Number(row.dataset.i) !== st.row) { st.row = Number(row.dataset.i); document.querySelectorAll(".row").forEach(el => el.classList.toggle("sel", el === row)); }
});

document.addEventListener("keydown", e => {
  const inQ = e.target === q;
  if (e.key === "Escape") {
    e.preventDefault();
    if (st.confirm) { st.confirm = ""; render({ strip: false }); }
    else if (q.value) setQuery("");
    else hide();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveRow(e.key === "ArrowDown" ? 1 : -1); return; }
  // Left/right switch projects, unless the caret still has room to move inside the search text.
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const left = e.key === "ArrowLeft";
    const caretFree = inQ && q.value && (left ? q.selectionStart > 0 : q.selectionEnd < q.value.length);
    if (!caretFree) { e.preventDefault(); moveTile(left ? -1 : 1); }
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (st.confirm) return act("resume-anyway", e.target);
    return activateRow();
  }
  // Typing anywhere goes to the search box.
  if (!inQ && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) q.focus();
});

window.manager.getData({ cached: true }).then(applyData).catch(() => {});
setInterval(pollLive, 2000);
