// "Files" (the button of a remote terminal's pane; docs/FILES.md 6): this computer's files on the left and the
// terminal's computer's on the right, as in FileZilla, and the queue of what goes between them under both. Which pane
// is which computer is said in each pane's head (the name, and "This computer" or "Remote"), and every row of the queue
// says "from → to" by name. A transfer goes into the folder the other pane shows: a drag from one pane onto the other,
// a double click on a file, or the arrows between the panes; a folder goes with everything in it. A file of this
// computer can also be sent to a paired phone that is linked now ("Send to phone" in its menu): the phone is offered it,
// asks its user and pulls it itself (docs/FILES.md 3.6); its row follows the phone's answers.
//
// Each pane has its own order - a click on a column's head sorts by it, a second click the other way round, an arrow
// shows which - and a search by name, asked of that computer a moment after the typing stops (its x and Escape clear
// it; it goes when another folder is opened). The order of each side is remembered (localStorage). Folders stay
// first. Any order but the name's makes the computer look at every entry before the first page, so a list is asked
// for only when the user changes something. A computer whose answer has no `total` cannot sort yet: its pane shows
// neither. Transfers walk folders in the default order (file-transfers.js), whatever a pane shows.
//
// Every answer comes later than its question, and the pane may be elsewhere by then. So an action takes what it is
// about - the computer, the folder, each entry's whole path - when it is asked for (snap), before it asks or waits
// for anything; and an answer is drawn only into the pane that asked, while that pane is still one of the open dialog's
// and nothing newer was asked of it (paneLive, pane.asked).
//
// main.js does the work (preload.js window.files; file-transfers.js): a side is a computer, "" for this one, and its
// paths are its own - the other computer may be Linux, so a path there is joined with the separator it answered, never
// with this one's. The overlay sits under the app's menus, messages and dialogs (styles.css z-index), so the menu of a
// row, a toast and the delete confirmation are the app's own. Loaded after renderer.js and workspace-ui.js: uses $, esc,
// icon, t, tn from common.js, openMenu, groupMenu, toast, confirmDialog, and termViews, setFileTransfers, setFilesOpening.
let filesView = null;     // the overlay, once built
let filesPanes = [];      // [left, right] of the opening shown now (newPane)
let filesQueue = [];      // main's list (preload.js files.transfers)
let filesDrag = null;     // a drag that started in a pane: { side, what: snap of what was selected then }
let filesPhones = [];     // the paired phones, [{ id, name, online }] (preload.js files.phones)
let filesTerm = "";       // the terminal the dialog was opened from: asked about again by Refresh, focused again on close
let filesOpening = false; // main is being asked what the sides are
let filesPreviewAsk = 0;  // the preview asked for last: an answer to an earlier one is shown to nobody
// A row of the queue this window started -> the folders it changes, [{ node, folder }]: main's rows do not say them.
const filesTargets = new Map();
const FILES_SORT_KEY = "agentdeck.files.sort"; // { left: { sort, desc }, right: { sort, desc } }
const FILTER_MS = 350;    // the pause in typing after which the computer is asked
const RELOAD_MS = 200;    // rows of the queue that end together list a folder again once
const SORTS = ["name", "size", "mtime"];
const FILES_LIVE = ["queued", "running", "waiting", "noAnswer"]; // a row that has not ended
function savedSort(side) {
  try {
    const x = JSON.parse(localStorage.getItem(FILES_SORT_KEY))?.[side];
    if (SORTS.includes(x?.sort)) return { sort: x.sort, desc: x.desc === true };
  } catch {}
  return { sort: "name", desc: false };
}
function saveSort(pane) {
  try {
    const all = JSON.parse(localStorage.getItem(FILES_SORT_KEY)) || {};
    all[pane.side] = { sort: pane.sort, desc: pane.desc };
    localStorage.setItem(FILES_SORT_KEY, JSON.stringify(all));
  } catch {}
}
// What files.list is asked for besides the path: only what differs from the default (an older computer sees nothing
// it does not know); the list of the drives takes none.
function listParams(pane, path) {
  if (!path) return {};
  return { ...(pane.sort !== "name" ? { sort: pane.sort } : {}), ...(pane.desc ? { desc: true } : {}), ...(pane.filter ? { filter: pane.filter } : {}) };
}
const FILE_DRAG_TYPE = "text/x-agentdeck-files";

// ---------- small helpers ----------
const joinPath = (folder, sep, name) => (folder === "" ? name : folder.endsWith(sep) ? folder + name : folder + sep + name);
const filePathOf = (pane, name) => joinPath(pane.path, pane.sep, name);
const otherPane = pane => filesPanes[pane.side === "left" ? 1 : 0];
const filesShown = () => Boolean(filesView && !filesView.hidden);
// A pane of the dialog as it is open now. Every opening draws into the same elements, so an answer for a pane of an
// earlier opening - or one that comes after the dialog was closed - must not be drawn at all.
const paneLive = pane => filesShown() && filesPanes.includes(pane);
// Two ways to write one folder of a computer: a separator at the end or not, and on Windows any case.
function sameFolder(a, b, sep) {
  const norm = p => { const cut = String(p).replace(/[\\/]+$/, ""); return sep === "\\" ? cut.toLowerCase() : cut; };
  return norm(a) === norm(b);
}
// What an action is about, taken when it is asked for: the computer, the folder the pane shows and each entry's whole
// path. The names alone would be looked for in whatever folder the pane shows once the question is answered.
const snap = (pane, entries = []) => ({ pane, node: pane.node, computer: pane.name, trash: pane.trash, folder: pane.path, sep: pane.sep,
  items: entries.map(e => ({ name: e.name, dir: Boolean(e.dir), path: filePathOf(pane, e.name) })) });
// Where a transfer into a pane goes: the folder it shows (or a folder row of it); folder null when it shows none.
const destOf = (pane, folder = null) => ({ node: pane.node, computer: pane.name, note: pane.note, folder: pane.error || pane.note || !pane.path ? null : folder || pane.path });
function sizeText(n) {
  if (!(n >= 0)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${I18N.formatNumber(i ? Math.round(v * 10) / 10 : v)} ${units[i]}`;
}
const timeText = ms => (ms > 0 ? I18N.formatDateTime(ms, { dateStyle: "short", timeStyle: "short" }) : "");
// "name.ext" -> "name (2).ext", "name (2).ext" -> "name (3).ext"; a folder's name has no extension (host/files.js).
function nextFreeName(name, dir) {
  const dot = dir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  const m = /^(.*) \((\d+)\)$/.exec(stem);
  return m ? `${m[1]} (${Number(m[2]) + 1})${ext}` : `${stem} (2)${ext}`;
}
// A name typed for a new name: one name, not a path.
const isPlainName = s => Boolean(s) && s !== "." && s !== ".." && !/[\\/\0]/.test(s);
// An answer of main's: its value, or the error said with the computer's name.
function filesFailed(pane, r) {
  toast(t("files.error", { computer: pane.name, message: r.error === "unknownMethod" ? t("files.needsUpdate", { name: pane.name }) : r.message || r.error }), true);
}

// ---------- the overlay ----------
function buildFilesView() {
  const el = document.createElement("div");
  el.className = "files-back";
  el.id = "filesView";
  el.hidden = true;
  const pane = side => `<section class="fpane ${side === "left" ? "local" : "remote"}" data-side="${side}">
      <header class="fpane-head">
        <span class="fpane-badge">${icon(side === "left" ? "window" : "nodes")}<span>${esc(t(side === "left" ? "files.thisComputer" : "files.remote"))}</span></span>
        <b class="fpane-name"></b>
        <span class="fpane-tools">
          <button class="icon-btn" data-fa="up" title="${esc(t("files.up"))}" aria-label="${esc(t("files.up"))}">${icon("left")}</button>
          <button class="icon-btn" data-fa="refresh" title="${esc(t("files.refresh"))}" aria-label="${esc(t("files.refresh"))}">${icon("refresh")}</button>
          <button class="icon-btn" data-fa="mkdir" title="${esc(t("files.newFolder"))}" aria-label="${esc(t("files.newFolder"))}">${icon("plus")}</button>
        </span>
      </header>
      <nav class="fpane-crumbs"></nav>
      <div class="fpane-find"><span class="fpane-search">${icon("search")}<input class="input fpane-filter" type="text" autocomplete="off" spellcheck="false" placeholder="${esc(t("files.filterPh"))}" aria-label="${esc(t("files.filterPh"))}">
        <button class="icon-btn" data-fa="unfilter" title="${esc(t("files.filterClear"))}" aria-label="${esc(t("files.filterClear"))}" hidden>${icon("x")}</button></span><small class="fpane-count" role="status"></small></div>
      <div class="frow fhead">${[["name", "fname", "files.col.name"], ["size", "fsize", "files.col.size"], ["mtime", "ftime", "files.col.time"]].map(([key, cls, label]) =>
        `<button class="fcol ${cls}" data-sort="${key}" title="${esc(t("files.sortBy", { column: t(label) }))}"><span>${esc(t(label))}</span><i class="fsort" aria-hidden="true"></i></button>`).join("")}</div>
      <div class="fpane-list" tabindex="0" role="listbox" aria-multiselectable="true"></div>
    </section>`;
  el.innerHTML = `<div class="files-dlg" role="dialog" aria-modal="true" aria-labelledby="filesTitle">
    <header class="files-head"><h2 id="filesTitle">${icon("folder")}<span></span></h2>
      <button class="icon-btn" data-fa="close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x")}</button></header>
    <div class="files-body">
      ${pane("left")}
      <div class="files-mid">
        <button class="btn files-send" data-send="right"><span class="files-arrow">▶</span></button>
        <button class="btn files-send" data-send="left"><span class="files-arrow">◀</span></button>
      </div>
      ${pane("right")}
    </div>
    <section class="files-queue">
      <header class="fq-head"><h3>${esc(t("files.queue"))}</h3><button class="btn sm" data-fa="clear">${esc(t("files.clear"))}</button></header>
      <div class="fq-list"></div>
    </section>
  </div>`;
  document.body.append(el);
  wireFilesView(el);
  // The window's own keys act on what is behind the dialog (hide a pane, the next tab, the search), so while it is
  // shown none of them gets a key - not from the dialog, and not from the app's menu, questions and messages over it,
  // which are the body's children as the dialog is. The window listens on the document, after the body; a menu takes
  // its keys on the way down (renderer.js), before this.
  document.body.addEventListener("keydown", e => { if (filesShown()) e.stopPropagation(); });
  // The palette's Ctrl+K is taken on the way down too: it is stopped above it.
  window.addEventListener("keydown", e => {
    if (filesShown() && e.ctrlKey && !e.altKey && !e.shiftKey && e.code === "KeyK") { e.preventDefault(); e.stopPropagation(); }
  }, true);
  return el;
}

const newPane = (s, side) => ({ ...s, error: s.error || "", side, path: null, sep: "", parent: null, entries: [], next: "", sel: new Set(), anchor: -1, cursor: -1,
  loading: false, going: false, note: "", asked: 0, ...savedSort(side), filter: "", total: null, sortable: false, timer: 0, reloadTimer: 0, stale: [] });
// term: the terminal whose pane's button was pressed. Its computer is asked what it is first, which takes a while on
// a slow link: the button waits meanwhile (workspace-ui.js) and a second press opens nothing.
async function openFilesDialog(term) {
  if (filesOpening || filesShown()) return;
  filesOpening = true;
  setFilesOpening(term);
  let sides;
  try { sides = await window.files.open(term); } finally { filesOpening = false; setFilesOpening(""); }
  filesView ||= buildFilesView();
  filesTerm = term;
  filesDrag = null;
  filesPanes = [newPane(sides.left, "left"), newPane(sides.right, "right")];
  const [left, right] = filesPanes;
  filesView.querySelector("#filesTitle span").textContent = t("files.title", { name: right.name });
  for (const pane of filesPanes) {
    const el = paneEl(pane);
    el.querySelector(".fpane-filter").value = "";
    el.classList.remove("drop");
    showPaneName(pane);
  }
  filesView.hidden = false;
  // The window behind takes no focus and no keys meanwhile (a terminal there would type them).
  document.querySelector("main").inert = true;
  for (const pane of filesPanes) startPane(pane);
  paneEl(right).querySelector(".fpane-list").focus();
  const [queue, phones] = await Promise.all([window.files.transfers(), window.files.phones()]);
  renderFilesQueue(queue);
  filesPhones = Array.isArray(phones) ? phones : [];
}
// The names of both computers: in each pane's head and on the arrows between them.
function showPaneName(pane) {
  const name = paneEl(pane).querySelector(".fpane-name");
  name.textContent = name.title = pane.name;
  const [left, right] = filesPanes;
  for (const [btn, from, to] of [[filesView.querySelector('[data-send="right"]'), left, right], [filesView.querySelector('[data-send="left"]'), right, left]]) {
    const title = t("files.sendTo", { from: from.name, to: to.name });
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }
}
// A pane's first folder: the one main named, else the home, else the drives. A computer that cannot be asked says why.
function startPane(pane) {
  if (pane.error) {
    setPaneNote(pane, t(pane.error === "offline" ? "files.offline" : "files.needsUpdate", { name: pane.name }));
    renderPane(pane);
    return Promise.resolve(false);
  }
  return goTo(pane, pane.start, [pane.node ? "~" : "", ""]);
}
// Refresh on a pane that never got a folder (its computer was away when the dialog opened, or went while the first
// one was asked for): the opening again, for that side.
async function reopenPane(pane) {
  const asked = ++pane.asked;
  pane.loading = true;
  renderPane(pane);
  let sides = null, failed = null;
  try { sides = await window.files.open(filesTerm); } catch (e) { failed = e; }
  if (!paneLive(pane) || asked !== pane.asked) return false;
  pane.loading = false;
  if (failed) { renderPane(pane); toast(failed.message, true); return false; }
  const s = sides[pane.side];
  Object.assign(pane, { name: s.name, start: s.start, trash: s.trash, error: s.error || "" });
  showPaneName(pane);
  return startPane(pane);
}
function closeFilesDialog() {
  if (!filesShown()) return;
  if (typeof closeGroupMenu === "function") closeGroupMenu();
  for (const pane of filesPanes) { clearTimeout(pane.timer); clearTimeout(pane.reloadTimer); }
  filesDrag = null;
  if ($("filesPreview")?.open) $("filesPreview").close();
  filesView.querySelectorAll(".fpane.drop").forEach(x => x.classList.remove("drop"));
  filesView.hidden = true;
  document.querySelector("main").inert = false;
  // The keyboard goes back to the terminal the dialog was opened from, if its pane is still on the page.
  const view = termViews.get(filesTerm);
  if (view?.host?.isConnected) view.term.focus();
}
const paneEl = pane => filesView.querySelector(`.fpane[data-side="${pane.side}"]`);
const paneOf = el => filesPanes.find(p => p.side === el?.closest?.(".fpane")?.dataset.side) || null;

// ---------- a pane: listing, paging, drawing ----------
// A note in place of the list (the computer is away, or too old). What was listed goes with it: rows that are not
// drawn must not answer the keys.
function setPaneNote(pane, note) {
  Object.assign(pane, { note, entries: [], next: "", sel: new Set(), anchor: -1, cursor: -1, total: null });
}
// An answer that says the computer cannot be asked: its note. -> whether it was one.
function paneAway(pane, r) {
  if (r.error !== "unknownMethod" && r.error !== "offline") return false;
  setPaneNote(pane, t(r.error === "offline" ? "files.offline" : "files.needsUpdate", { name: pane.name }));
  return true;
}
// A folder opened: its first page. One that cannot be listed leaves the pane where it was - or, for the folder a pane
// starts in, goes on to the next of `fallback` (the home, the drives) and says why it is not the one expected: a
// terminal's folder may be gone, or be one the computer does not list (a network share).
// keep: the same folder in another order or with another search (else a search typed for the last folder goes).
// While it is asked for (pane.going) the rows still drawn are of the folder being left: they take no action.
async function goTo(pane, path, fallback = [], { keep = false } = {}) {
  if (!keep && pane.filter) { pane.filter = ""; paneEl(pane).querySelector(".fpane-filter").value = ""; }
  pane.loading = pane.going = true;
  renderPane(pane);
  const asked = ++pane.asked;
  const r = await window.files.call(pane.node, "list", { path, ...listParams(pane, path) });
  if (!paneLive(pane) || asked !== pane.asked) return false;   // a later request took over, or the dialog was closed
  pane.loading = pane.going = false;
  if (r.error) {
    if (fallback.length && r.error !== "offline" && r.error !== "unknownMethod") {
      if (path === pane.start) toast(t("files.startFailed", { computer: pane.name, folder: path, message: r.message || r.error }), true);
      return goTo(pane, fallback[0], fallback.slice(1));
    }
    if (!paneAway(pane, r)) filesFailed(pane, r);
    renderPane(pane);
    return false;
  }
  Object.assign(pane, { path: r.value.path, sep: r.value.sep, parent: r.value.parent, entries: r.value.entries, next: r.value.next, sel: new Set(), anchor: -1, cursor: -1, note: "" });
  // A computer that answers no total cannot sort or search (an older AgentDeck); the drives are not sorted either.
  pane.total = Number.isInteger(r.value.total) ? r.value.total : null;
  if (pane.path) pane.sortable = pane.total !== null;
  renderPane(pane);
  paneEl(pane).querySelector(".fpane-list").scrollTop = 0;
  return true;
}
// The folder shown, listed again because something in it changed (an action here, a row of the queue that ended,
// Refresh): what was selected stays selected - by name -, the list stays where it was scrolled, and as many entries
// as were loaded are asked for again. A folder being opened is left alone: its answer is the newer one.
async function reloadPane(pane) {
  if (pane.path === null || pane.going) return false;
  const path = pane.path, want = pane.entries.length, list = paneEl(pane).querySelector(".fpane-list");
  const asked = ++pane.asked;
  pane.loading = true;
  if (!want) renderPane(pane);
  let entries = [], last = null, after = "";
  do {
    const r = await window.files.call(pane.node, "list", { path, ...(after ? { after } : {}), ...listParams(pane, path) });
    if (!paneLive(pane) || asked !== pane.asked) return false;
    if (r.error || r.value.path !== path) {
      pane.loading = false;
      if (r.error && !paneAway(pane, r)) filesFailed(pane, r);
      renderPane(pane);
      return false;
    }
    last = r.value;
    entries = entries.concat(last.entries);
    after = last.next;
  } while (after && entries.length < want);
  const nameAt = i => pane.entries[i]?.name, at = name => (name === undefined ? -1 : entries.findIndex(e => e.name === name));
  const picked = new Set(selectedOf(pane).map(e => e.name)), anchor = at(nameAt(pane.anchor)), cursor = at(nameAt(pane.cursor)), top = list.scrollTop;
  Object.assign(pane, { loading: false, note: "", sep: last.sep, parent: last.parent, entries, next: after, anchor, cursor,
    sel: new Set(entries.flatMap((e, i) => (picked.has(e.name) ? [i] : []))), total: Number.isInteger(last.total) ? last.total : null });
  renderPane(pane);
  list.scrollTop = top;
  return true;
}
const refreshPane = pane => (pane.path === null ? reopenPane(pane) : reloadPane(pane));
// After an action in the folder a pane showed: listed again if the pane still shows it.
const reloadShown = s => (paneLive(s.pane) && s.pane.path === s.folder ? reloadPane(s.pane) : Promise.resolve(false));
// A row of the queue ended and changed `folder` on a pane's computer (null: it is not known which): the pane is
// listed again if that is the folder it shows - a moment later, so that rows ending together ask once, and after a
// folder that is being opened has come.
function paneChanged(pane, folder) {
  pane.stale.push(folder);
  clearTimeout(pane.reloadTimer);
  pane.reloadTimer = setTimeout(function fire() {
    if (!paneLive(pane)) return;
    if (pane.going) return void (pane.reloadTimer = setTimeout(fire, RELOAD_MS));
    const hit = pane.path !== null && pane.stale.some(f => f === null || sameFolder(f, pane.path, pane.sep));
    pane.stale = [];
    if (hit) reloadPane(pane);
  }, RELOAD_MS);
}
async function loadMore(pane) {
  if (!pane.next || pane.loading) return;
  pane.loading = true;
  const asked = pane.asked;
  const r = await window.files.call(pane.node, "list", { path: pane.path, after: pane.next, ...listParams(pane, pane.path) });
  // The folder, order or search changed meanwhile, or the dialog was closed: not a page of what is shown.
  if (!paneLive(pane) || asked !== pane.asked) return;
  pane.loading = false;
  if (r.error) return filesFailed(pane, r);
  if (r.value.path !== pane.path) return;
  const top = paneEl(pane).querySelector(".fpane-list").scrollTop;
  pane.entries = [...pane.entries, ...r.value.entries];
  pane.next = r.value.next;
  renderPane(pane);
  paneEl(pane).querySelector(".fpane-list").scrollTop = top;
}
// The folders above the shown one, each a step back: the drives first, then each folder down to this one. A share's
// root ("\\server\share") is one step: neither half of it is a folder that can be opened.
function crumbsOf(pane) {
  const out = [{ label: t("files.roots"), path: "" }];
  if (!pane.path) return out;
  const posix = pane.sep === "/", share = posix ? null : /^\\\\[^\\]+\\[^\\]+/.exec(pane.path)?.[0] || "";
  let at = posix ? "/" : share || "";
  if (posix) out.push({ label: "/", path: "/" });
  if (share) out.push({ label: share, path: share });
  for (const part of pane.path.slice(share ? share.length : 0).split(pane.sep).filter(Boolean)) {
    at = posix ? (at === "/" ? `/${part}` : `${at}/${part}`) : !at ? `${part}${pane.sep}` : at.endsWith(pane.sep) ? at + part : at + pane.sep + part;
    out.push({ label: part, path: at });
  }
  return out;
}
function renderPane(pane) {
  const el = paneEl(pane), off = Boolean(pane.error);
  el.classList.toggle("off", off);
  for (const b of el.querySelectorAll(".fpane-tools button")) b.disabled = off || pane.path === null;
  el.querySelector('[data-fa="up"]').disabled = off || pane.parent === null || pane.path === null;
  el.querySelector('[data-fa="mkdir"]').disabled = off || !pane.path || Boolean(pane.note) || pane.going;
  // Refresh stays: on a pane whose computer was away it asks again.
  el.querySelector('[data-fa="refresh"]').disabled = false;
  pane.crumbs = pane.path === null ? [] : crumbsOf(pane);
  // The order and the search: only where that computer can do them, and not on the list of the drives.
  const sorting = !off && pane.sortable && Boolean(pane.path);
  el.querySelector(".fpane-find").hidden = !sorting;
  el.classList.toggle("sortable", sorting);
  for (const b of el.querySelectorAll(".fhead [data-sort]")) {
    const on = sorting && b.dataset.sort === pane.sort;
    b.disabled = !sorting;
    b.classList.toggle("on", on);
    b.querySelector(".fsort").textContent = on ? (pane.desc ? "▼" : "▲") : "";
    b.setAttribute("aria-sort", on ? (pane.desc ? "descending" : "ascending") : "none");
  }
  el.querySelector('[data-fa="unfilter"]').hidden = !el.querySelector(".fpane-filter").value;
  el.querySelector(".fpane-count").textContent = !sorting || pane.total === null ? ""
    : pane.filter ? t("files.count.matching", { n: pane.total })
    : pane.entries.length < pane.total ? t("files.count.some", { n: pane.entries.length, total: pane.total }) : tn("files.items", pane.total);
  el.querySelector(".fpane-crumbs").innerHTML = pane.crumbs.map((c, i) => `${i ? `<span class="fcrumb-sep">›</span>` : ""}<button class="fcrumb" data-crumb="${i}" title="${esc(c.path || c.label)}">${esc(c.label)}</button>`).join("");
  const list = el.querySelector(".fpane-list");
  if (pane.loading && !pane.entries.length) { list.innerHTML = `<div class="fpane-note">${esc(t("files.loading"))}</div>`; return; }
  if (pane.note) { list.innerHTML = `<div class="fpane-note">${icon("alert")}<span>${esc(pane.note)}</span></div>`; return; }
  const rows = pane.entries.map((e, i) => `<div class="frow${e.dir ? " dir" : ""}${pane.sel.has(i) ? " sel" : ""}${e.name.startsWith(".") ? " hidden-file" : ""}" data-i="${i}" draggable="true" role="option" aria-selected="${pane.sel.has(i)}">
      <span class="fname">${icon(e.dir ? "folder" : "file")}<span title="${esc(e.name)}">${esc(e.name)}</span>${e.link ? `<small class="flink">↪</small>` : ""}</span>
      <span class="fsize">${e.dir ? "" : esc(sizeText(e.size))}</span><span class="ftime">${esc(timeText(e.mtime))}</span></div>`).join("");
  list.innerHTML = (rows || `<div class="fpane-note">${esc(pane.filter ? t("files.noMatch", { filter: pane.filter }) : t("files.empty"))}</div>`) + (pane.next ? `<button class="btn sm fmore" data-fa="more">${esc(t("files.loadMore"))}</button>` : "");
}
const selectedOf = pane => [...pane.sel].sort((a, b) => a - b).map(i => pane.entries[i]).filter(Boolean);
// anchor: where a range starts (the row clicked or reached last without Shift); cursor: the row the arrows move from,
// which is the range's other end while Shift is held.
function select(pane, i, { toggle = false, range = false } = {}) {
  if (range && pane.anchor >= 0) {
    pane.sel = new Set();
    for (let k = Math.min(pane.anchor, i); k <= Math.max(pane.anchor, i); k++) pane.sel.add(k);
  } else if (toggle) {
    if (pane.sel.has(i)) pane.sel.delete(i); else pane.sel.add(i);
    pane.anchor = i;
  } else { pane.sel = new Set(i >= 0 ? [i] : []); pane.anchor = i; }
  pane.cursor = i;
  for (const row of paneEl(pane).querySelectorAll(".frow[data-i]")) {
    const on = pane.sel.has(Number(row.dataset.i));
    row.classList.toggle("sel", on);
    row.setAttribute("aria-selected", String(on));
  }
}

// ---------- what a row does ----------
function openEntry(pane, e) {
  if (e.dir) return goTo(pane, filePathOf(pane, e.name));
  return sendEntries(snap(pane, [e]), destOf(otherPane(pane)));
}
// Files and folders (s: a snap, or paths of this computer dropped from the system) into a folder of the other side.
async function sendEntries(s, dest) {
  if (!s.items.length) return toast(t("files.pickFirst", { name: s.computer }), true);
  if (dest.folder === null) return toast(dest.note || t("files.pickFolder", { name: dest.computer }), true);
  for (const x of s.items) {
    const r = await window.files.send({ node: s.node, path: x.path }, { node: dest.node, folder: dest.folder });
    if (r.error) return filesFailed(s.pane, r);
    if (r.value?.id) filesTargets.set(r.value.id, [{ node: dest.node, folder: dest.folder }]);
  }
}
// A name asked for in a dialog of AgentDeck's own (as workspace-ui.js askPort): -> the text, or "" when given up.
function askFileText({ title, body, value = "", ok, stem = false }) {
  return new Promise(resolve => {
    const d = document.createElement("dialog");
    d.className = "dialog confirm files-ask";
    d.innerHTML = `<form method="dialog" class="confirm-form"><h2>${esc(title)}</h2><p>${esc(body)}</p>
      <input class="input mono" autocomplete="off" spellcheck="false" aria-label="${esc(title)}">
      <div class="confirm-actions"><button class="btn sm" type="button" data-cancel>${esc(t("common.cancel"))}</button>
      <button class="btn sm primary" value="ok">${esc(ok)}</button></div></form>`;
    const field = d.querySelector("input"), okBtn = d.querySelector("button[value=ok]");
    field.value = value;
    field.addEventListener("input", () => { okBtn.disabled = !field.value.trim(); });
    d.querySelector("[data-cancel]").addEventListener("click", () => d.close("cancel"));
    // The window's own keys stay out of it, as out of the dialog under it.
    d.addEventListener("keydown", e => e.stopPropagation());
    d.addEventListener("close", () => { d.remove(); resolve(d.returnValue === "ok" ? field.value.trim() : ""); });
    document.body.append(d);
    d.showModal();
    // A file's name is chosen without its extension, as Explorer does.
    const dot = stem ? value.lastIndexOf(".") : -1;
    field.focus();
    field.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}
// s: a snap of one entry.
async function renameEntry(s) {
  const e = s.items[0];
  let name = e.name, body = t("files.rename.body", { name: e.name, computer: s.computer });
  for (;;) {
    const next = await askFileText({ title: t("files.rename.title"), body, value: name, ok: t("files.rename.title"), stem: !e.dir });
    if (!next || next === e.name) return;
    if (!isPlainName(next)) return toast(t("files.error", { computer: s.computer, message: t("errors.invalidData") }), true);
    const r = await window.files.call(s.node, "rename", { from: e.path, to: joinPath(s.folder, s.sep, next) });
    // A name that is taken: "name (2)" is offered (docs/FILES.md 1).
    if (r.error === "exists") { name = nextFreeName(next, e.dir); body = t("files.rename.taken", { name: next, computer: s.computer }); continue; }
    if (r.error) return filesFailed(s.pane, r);
    return reloadShown(s);
  }
}
// s: a snap of the pane, for the folder it showed when asked.
async function makeFolder(s) {
  if (!s.folder) return;
  const name = await askFileText({ title: t("files.newFolder"), body: t("files.mkdir.body", { folder: s.folder, computer: s.computer }), value: t("files.newFolder"), ok: t("files.newFolder") });
  if (!name) return;
  if (!isPlainName(name)) return toast(t("files.error", { computer: s.computer, message: t("errors.invalidData") }), true);
  const r = await window.files.call(s.node, "mkdir", { path: joinPath(s.folder, s.sep, name), keep: true });
  if (r.error) return filesFailed(s.pane, r);
  await reloadShown(s);
}
// "Copy to folder…" and "Move to folder…": a folder of the same computer, typed (it starts as the one shown). A copy
// is a job there and a row of the queue, and gets "name (2)" where the name is taken; a move is a rename, and one
// across drives becomes a copy that removes the source when all of it arrived.
async function copyEntry(s, move) {
  const e = s.items[0], kind = move ? "move" : "copy";
  const folder = await askFileText({ title: t(`files.${kind}.title`), body: t(`files.${kind}.body`, { name: e.name, computer: s.computer }), value: s.folder, ok: t(`files.${kind}.title`) });
  if (!folder) return;
  const into = name => joinPath(folder, s.sep, name);
  // The row of the queue: which folders it changes (the one typed; a move, the one it leaves too).
  const queued = r => { if (r.value?.id) filesTargets.set(r.value.id, [{ node: s.node, folder }, ...(move ? [{ node: s.node, folder: s.folder }] : [])]); };
  if (!move) {
    // A folder copied into the folder it is in: the host takes its own path for "into itself", so the copy is asked
    // for as "name (2)" from the start (a file gets that number there anyway).
    const same = into(e.name) === e.path;
    const r = await window.files.copy(s.node, e.path, into(same ? nextFreeName(e.name, e.dir) : e.name), false);
    return r.error ? filesFailed(s.pane, r) : queued(r);
  }
  let name = e.name;
  for (;;) {
    const r = await window.files.call(s.node, "rename", { from: e.path, to: into(name) });
    if (r.error === "crossDevice") {
      const c = await window.files.copy(s.node, e.path, into(name), true);
      return c.error ? filesFailed(s.pane, c) : queued(c);
    }
    if (r.error === "exists") {
      name = await askFileText({ title: t("files.move.title"), body: t("files.move.taken", { name, computer: s.computer }), value: nextFreeName(name, e.dir), ok: t("files.move.title"), stem: !e.dir });
      if (!name || !isPlainName(name)) return;
      continue;
    }
    if (r.error) return filesFailed(s.pane, r);
    return reloadShown(s);
  }
}
// A file of this computer offered to a phone: a row of the queue from now on; the phone asks before it saves it.
async function offerEntry(s, phone) {
  const e = s.items[0];
  const r = await window.files.offer(phone.id, e.path);
  if (r.error) return toast(t("files.error", { computer: phone.name, message: r.message || r.error }), true);
  toast(t("files.toPhone.sent", { name: e.name, phone: phone.name }));
}
// Always asked first, naming the computer and the folder and saying where it goes: its bin, or nowhere
// (docs/FILES.md 1). What is deleted is what was selected in that folder when it was asked - by whole path.
async function deleteEntries(s) {
  const n = s.items.length, one = n === 1 ? s.items[0].name : "";
  if (!n) return;
  const body = [
    one ? t(s.trash ? "files.delete.trash" : "files.delete.forGood", { name: one, computer: s.computer }) : tn(s.trash ? "files.delete.trashMany" : "files.delete.forGoodMany", n, { computer: s.computer }),
    s.folder ? t("files.delete.where", { folder: s.folder }) : "",
    !s.items.some(x => x.dir) ? "" : t(one ? "files.delete.folder" : "files.delete.folders")
  ].filter(Boolean).join("\n");
  if (!(await confirmDialog({ title: one ? t("files.delete.title", { name: one }) : tn("files.delete.titleMany", n), body, confirmLabel: t("files.delete.go"), danger: true }))) return;
  let trashed = s.trash, failed = false;
  for (const x of s.items) {
    const r = await window.files.call(s.node, "delete", { path: x.path });
    if (r.error) { filesFailed(s.pane, r); failed = true; break; }
    trashed = r.value?.trashed === true;
  }
  // Said done only when all of it went (a file in use stops the rest, and says so).
  if (!failed) toast(one ? t(trashed ? "files.deleted.trash" : "files.deleted.forGood", { name: one, computer: s.computer }) : tn(trashed ? "files.deleted.trashMany" : "files.deleted.forGoodMany", n, { computer: s.computer }));
  await reloadShown(s);
}
const previewBox = () => $("filesPreview") || (() => {
  const d = document.createElement("dialog");
  d.id = "filesPreview";
  d.className = "dialog files-preview";
  d.innerHTML = `<header><h2></h2><button class="icon-btn" data-close title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x")}</button></header><div class="fpv-body"></div>`;
  d.querySelector("[data-close]").addEventListener("click", () => d.close());
  d.addEventListener("keydown", e => e.stopPropagation());
  // Closed - while it waits too, which gives the wait up: what comes for it later is dropped, and a picture is let go.
  d.addEventListener("close", () => { filesPreviewAsk++; d.querySelector(".fpv-body").innerHTML = ""; });
  document.body.append(d);
  return d;
})();
// The file is read whole before it shows, which takes a while for a picture over a relay: the dialog opens at once and
// says it waits. s: a snap of one file.
async function previewEntry(s) {
  const e = s.items[0], d = previewBox(), body = d.querySelector(".fpv-body"), ask = ++filesPreviewAsk;
  d.querySelector("h2").textContent = `${e.name} · ${s.computer}`;
  d.classList.add("loading");
  body.className = "fpv-body wait";
  body.innerHTML = `<div class="fpv-wait" role="status"><span class="spinner"></span><span>${esc(t("files.preview.loading", { name: e.name, computer: s.computer }))}</span></div>`;
  if (!d.open) d.showModal();
  const r = await window.files.preview(s.node, e.path);
  if (ask !== filesPreviewAsk || !d.open) return;
  const v = r.value;
  if (r.error || v.kind === "pdf" || v.kind === "binary" || v.kind === "tooBig") {
    d.close();
    if (r.error) return filesFailed(s.pane, r);
    if (v.kind === "pdf") return toast(t("files.preview.pdf", { name: e.name }));
    if (v.kind === "binary") return toast(t("files.preview.binary", { name: e.name }), true);
    return toast(t("files.preview.tooBig", { name: e.name, size: sizeText(v.max) }), true);
  }
  d.classList.remove("loading");
  body.className = `fpv-body ${v.kind}`;
  if (v.kind === "image") { body.innerHTML = "<img alt=\"\">"; body.querySelector("img").src = v.data; }
  else if (v.kind === "markdown") body.innerHTML = `<div class="fpv-md">${markdownHtml(v.text)}</div>`;
  else { body.innerHTML = "<pre></pre>"; body.querySelector("pre").textContent = v.text; }
  body.scrollTop = 0;
}
// .md as headings, lists, quotes, code and paragraphs. The file is anybody's text: every piece of it is escaped, and
// the only elements are the ones made here - no link, no image, no attribute of its own.
function markdownHtml(src) {
  const out = [];
  let para = [], list = "", code = null;
  const inline = s => s.split(/(`[^`]*`)/).map(part => (part.length > 1 && part.startsWith("`") && part.endsWith("`") ? `<code>${esc(part.slice(1, -1))}</code>`
    : esc(part).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*\w])[*_]([^*_\s][^*_]*)[*_](?=$|[^*\w])/g, "$1<i>$2</i>"))).join("");
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`</${list}>`);
    list = "";
  };
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    if (code !== null) {
      if (/^\s*```/.test(line)) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flush(); code = []; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line), item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line), quote = /^>\s?(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${Math.min(h[1].length + 2, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); }
    else if (item) {
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if (para.length || list !== kind) flush();
      if (!list) { out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(item[2])}</li>`);
    } else if (quote) { flush(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push("<hr>"); }
    else if (!line.trim()) flush();
    else { if (list) flush(); para.push(line.trim()); }
  }
  if (code !== null) out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
  flush();
  return out.join("");
}

// The menu of a row (or of the folder, on its empty part), opened where the pointer is. Its items act on what was
// selected, and where, when it opened.
function openFileMenu(pane, e, x, y) {
  const anchor = document.createElement("span");
  anchor.className = "files-anchor";
  anchor.style.left = `${x}px`;
  anchor.style.top = `${y}px`;
  filesView.append(anchor);
  const s = snap(pane, selectedOf(pane)), one = s.items.length === 1 ? s : null, file = one?.items[0], other = otherPane(pane), dest = destOf(other);
  // The pane's list has the keyboard again before an item runs: a dialog it opens gives the focus back there.
  const list = paneEl(pane).querySelector(".fpane-list");
  const run = fn => () => { list.focus(); return fn().catch(err => toast(err.message, true)); };
  // To a phone: only a file of this computer (the phone pulls it from here), and only a phone linked now - with one,
  // the item names it; with more, they are its submenu; with none, it says why it cannot.
  const phones = filesPhones.filter(p => p.online);
  const toPhone = pane.node || !file || file.dir ? [] : phones.length === 1
    ? [{ label: t("files.menu.toPhoneNamed", { name: phones[0].name }), icon: "phone", run: run(() => offerEntry(one, phones[0])) }]
    : phones.length ? [{ label: t("files.menu.toPhone"), icon: "phone", items: phones.map(p => ({ label: p.name, icon: "phone", run: run(() => offerEntry(one, p)) })) }]
    : [{ label: t("files.menu.toPhone"), icon: "phone", disabled: true, detail: t(filesPhones.length ? "files.toPhone.offline" : "files.toPhone.none") }];
  const items = !e ? [
    { label: t("files.newFolder"), icon: "plus", disabled: !s.folder, run: run(() => makeFolder(s)) },
    { label: t("files.refresh"), icon: "refresh", run: run(() => refreshPane(pane)) }
  ] : [
    ...(file?.dir ? [{ label: t("files.menu.open"), icon: "folder", run: run(() => goTo(pane, file.path)) }] : []),
    ...(file && !file.dir ? [{ label: t("files.menu.preview"), icon: "eye", run: run(() => previewEntry(one)) }] : []),
    { label: t("files.menu.send", { name: other.name }), icon: pane.node ? "download" : "upload", disabled: dest.folder === null, run: run(() => sendEntries(s, dest)) },
    ...toPhone,
    { separator: true },
    ...(file ? [
      { label: t("files.menu.rename"), icon: "pencil", run: run(() => renameEntry(one)) },
      { label: t("files.menu.copy"), icon: "copy", run: run(() => copyEntry(one, false)) },
      { label: t("files.menu.move"), icon: "stack", run: run(() => copyEntry(one, true)) },
      { label: t("files.menu.copyPath"), icon: "copy", run: run(async () => { await window.manager.copyText(file.path); toast(t("files.copiedPath", { path: file.path })); }) }
    ] : []),
    { label: t("files.newFolder"), icon: "plus", disabled: !s.folder, run: run(() => makeFolder(s)) },
    { separator: true },
    { label: t("files.menu.delete"), icon: "trash", danger: true, run: run(() => deleteEntries(s)) }
  ];
  openMenu(anchor, "", items, "files-menu");
  anchor.remove();
  groupMenu.returnFocus = list; // Escape on the menu goes back to the list, not to the anchor that is gone
}

// ---------- the queue ----------
// Each row stays the same element while its transfer runs - only its bar and its words change - so a click on its
// Stop is never lost to the next piece's redraw.
function queueRowEl(r) {
  const el = document.createElement("div");
  el.dataset.id = r.id;
  // By name, and this computer's side said in words too.
  const who = s => `<b>${esc(s.name)}</b>${s.node ? "" : ` <small class="fq-here">(${esc(t("term.thisComputer"))})</small>`}`;
  const route = r.kind === "copy" ? esc(t(r.move ? "files.row.move" : "files.row.copy", { name: r.from.name }))
    : `${who(r.from)} <span class="fq-to">→</span> ${who(r.to)}`;
  const dir = r.kind === "copy" ? "copy" : r.kind === "offer" ? "phone" : r.to.node === "" ? "download" : "upload";
  el.innerHTML = `<span class="fq-icon">${icon(dir)}</span>
    <span class="fq-name" title="${esc(r.name)}">${esc(r.name)}</span>
    <span class="fq-route" title="${esc(r.kind === "copy" ? "" : `${r.from.name} → ${r.to.name}`)}">${route}</span>
    <span class="fq-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></span>
    <span class="fq-state"></span><span class="fq-act"></span><small class="fq-detail"></small>`;
  return el;
}
// Why a row failed, with the computer it failed on: main says which end (failedAt); an older answer has none, and
// then it is the source's - but for a link that went, and a phone's own answer.
function failedText(r) {
  const at = r.failedAt === "from" || r.failedAt === "to" ? r[r.failedAt]?.name : "";
  const who = at || (r.kind === "offer" || (r.error === "offline" && r.to.node) ? r.to.name : r.from.name);
  return t("files.error", { computer: who, message: r.message || fileErrorText(r.error) });
}
function renderFilesQueue(list) {
  filesQueue = Array.isArray(list) ? list : [];
  if (!filesView) return;
  const box = filesView.querySelector(".fq-list");
  if (!filesQueue.length) { box.innerHTML = `<div class="fq-empty">${esc(t("files.queueEmpty"))}</div>`; return; }
  box.querySelector(".fq-empty")?.remove();
  const kept = new Map([...box.querySelectorAll(".fq-row")].map(el => [el.dataset.id, el]));
  let at = box.firstElementChild;
  for (const r of filesQueue) {
    const el = kept.get(r.id) || queueRowEl(r);
    kept.delete(r.id);
    if (el === at) at = at.nextElementSibling; else box.insertBefore(el, at);
    const pct = r.total > 0 ? Math.min(100, Math.floor((r.bytes / r.total) * 100)) : r.state === "done" ? 100 : 0;
    const live = FILES_LIVE.includes(r.state);
    // An offer's bytes move on the phone, out of sight: its row says what the phone answered. Stop takes it back,
    // taken or not (file-transfers.js): one the phone took and went quiet about is not left under way.
    const offer = r.kind === "offer";
    const state = r.state === "running" ? (offer ? t("files.state.saving") : `${pct} %`) : t(`files.state.${r.state}`);
    const stoppable = live;
    const details = [
      r.state === "running" && r.current && r.count > 1 ? r.current : "",
      r.count > 1 ? t("files.row.files", { done: r.files, count: r.count }) : "",
      r.total ? (offer ? sizeText(r.total) : `${sizeText(r.bytes)} / ${sizeText(r.total)}`) : "",
      r.skipped ? t("files.row.skipped", { n: r.skipped }) : "",
      r.state === "done" && r.path && r.kind === "transfer" ? t("files.row.into", { path: r.path }) : "",
      offer && (r.state === "noAnswer" || r.state === "expired") ? t("files.toPhone.noAnswer", { name: r.to.name }) : "",
      offer && r.state === "declined" ? t("files.toPhone.declined", { name: r.to.name }) : "",
      r.state === "failed" ? failedText(r) : ""
    ].filter(Boolean).join(" · ");
    el.className = `fq-row ${r.state}`;
    el.querySelector(".fq-bar").setAttribute("aria-valuenow", String(pct));
    el.querySelector(".fq-bar i").style.width = `${pct}%`;
    el.querySelector(".fq-state").textContent = state;
    const detail = el.querySelector(".fq-detail");
    detail.textContent = details;
    detail.title = details;
    setHtml(el.querySelector(".fq-act"), stoppable ? `<button class="btn sm" data-fa="stop">${esc(t("files.stop"))}</button>` : "");
  }
  for (const el of kept.values()) el.remove();
}
// A code as words; a code with none (a phone's may be newer than this app) as it is.
function fileErrorText(code) {
  const words = t(`errors.${code}`);
  return words === `errors.${code}` ? code : words;
}
// Rows that ended while the dialog is closed: a failure is said, and so is the end of the last one under way - the
// queue is out of sight, and the button on the pane only counts what still runs.
function tellEnded(ended) {
  for (const r of ended) if (r.state === "failed") toast(t("files.toast.failed", { name: r.name, reason: failedText(r) }), true);
  const last = ended.filter(r => r.state === "done").at(-1);
  if (!last || filesQueue.some(r => FILES_LIVE.includes(r.state))) return;
  toast(last.kind === "copy" ? t(last.move ? "files.toast.moved" : "files.toast.copied", { name: last.name, computer: last.from.name })
    : t(last.kind === "offer" ? "files.toast.saved" : "files.toast.done", { name: last.name, from: last.from.name, to: last.to.name }));
}
window.files?.onPhones?.(list => { filesPhones = Array.isArray(list) ? list : []; });
// (A page without the bridge - a test's fixture of the window - has no queue to follow.)
window.files?.onTransfers(list => {
  const before = new Map(filesQueue.map(r => [r.id, r.state]));
  renderFilesQueue(list);
  setFileTransfers(filesQueue.filter(r => FILES_LIVE.includes(r.state)));
  const ended = filesQueue.filter(r => FILES_LIVE.includes(before.get(r.id)) && !FILES_LIVE.includes(r.state));
  // A row that just ended changed a folder: a pane that shows that folder is listed again. Where it is not known
  // which folder (a row from before the window was loaded), any folder of its computer is taken for it.
  const changed = ended.filter(r => r.kind !== "offer").flatMap(r => filesTargets.get(r.id) || [{ node: r.kind === "copy" ? r.from.node : r.to.node, folder: null }]);
  for (const id of [...filesTargets.keys()]) if (!filesQueue.some(r => r.id === id && FILES_LIVE.includes(r.state))) filesTargets.delete(id);
  if (!filesShown()) return tellEnded(ended);
  for (const pane of filesPanes) for (const x of changed) if (x.node === pane.node) paneChanged(pane, x.folder);
});

// ---------- the order and the search ----------
// The same column again: the other way round. Another: name A-Z, the newest or the largest first.
function sortBy(pane, key) {
  if (!SORTS.includes(key) || pane.path === null) return;
  if (pane.sort === key) pane.desc = !pane.desc;
  else Object.assign(pane, { sort: key, desc: key !== "name" });
  saveSort(pane);
  return goTo(pane, pane.path, [], { keep: true });
}
function filterNow(pane) {
  clearTimeout(pane.timer);
  if (!paneLive(pane)) return;
  const next = paneEl(pane).querySelector(".fpane-filter").value.trim().slice(0, 200);
  paneEl(pane).querySelector('[data-fa="unfilter"]').hidden = !paneEl(pane).querySelector(".fpane-filter").value;
  if (next === pane.filter || !pane.path) return;
  pane.filter = next;
  return goTo(pane, pane.path, [], { keep: true });
}

// ---------- the pointer and the keys ----------
function wireFilesView(el) {
  el.addEventListener("input", e => {
    if (!e.target.classList?.contains("fpane-filter")) return;
    const pane = paneOf(e.target);
    if (!pane) return;
    paneEl(pane).querySelector('[data-fa="unfilter"]').hidden = !e.target.value;
    clearTimeout(pane.timer);
    pane.timer = setTimeout(() => filterNow(pane), FILTER_MS);
  });
  el.addEventListener("click", e => {
    const fa = e.target.closest("[data-fa]")?.dataset.fa, pane = paneOf(e.target);
    if (fa === "close") return closeFilesDialog();
    if (fa === "clear") return window.files.clear().then(renderFilesQueue);
    if (fa === "stop") return window.files.stop(e.target.closest("[data-id]").dataset.id);
    const send = e.target.closest("[data-send]")?.dataset.send;
    if (send) {
      const to = filesPanes.find(p => p.side === send), from = otherPane(to);
      return from.going ? undefined : sendEntries(snap(from, selectedOf(from)), destOf(to)).catch(err => toast(err.message, true));
    }
    if (!pane) return;
    if (fa === "up") return pane.parent !== null && goTo(pane, pane.parent);
    if (fa === "refresh") return refreshPane(pane);
    if (fa === "mkdir") return pane.going ? undefined : makeFolder(snap(pane)).catch(err => toast(err.message, true));
    if (fa === "more") return loadMore(pane);
    if (fa === "unfilter") { const field = paneEl(pane).querySelector(".fpane-filter"); field.value = ""; field.focus(); return filterNow(pane); }
    const col = e.target.closest(".fhead [data-sort]");
    if (col && !col.disabled) return sortBy(pane, col.dataset.sort);
    const crumb = e.target.closest("[data-crumb]");
    if (crumb) return goTo(pane, pane.crumbs[Number(crumb.dataset.crumb)].path);
    const row = e.target.closest(".frow[data-i]");
    if (e.target.closest(".fpane-list")) select(pane, row ? Number(row.dataset.i) : -1, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
  });
  el.addEventListener("dblclick", e => {
    const pane = paneOf(e.target), row = e.target.closest(".frow[data-i]");
    const entry = row && pane?.entries[Number(row.dataset.i)];
    if (entry && !pane.going) openEntry(pane, entry).catch(err => toast(err.message, true));
  });
  el.addEventListener("contextmenu", e => {
    const pane = paneOf(e.target);
    if (!pane || !e.target.closest(".fpane-list") || pane.error || pane.note || pane.path === null) return;
    e.preventDefault();
    if (pane.going) return;
    const row = e.target.closest(".frow[data-i]"), i = row ? Number(row.dataset.i) : -1;
    if (i >= 0 && !pane.sel.has(i)) select(pane, i);
    if (i < 0) select(pane, -1);
    openFileMenu(pane, i >= 0 ? pane.entries[i] : null, e.clientX, e.clientY);
  });
  // A drag from one pane onto the other copies the selected there - into a folder row it is let go on, else into the
  // folder that pane shows. Files from the system's Explorer go to the remote pane the same way. Which of the two a
  // drag is, is read from what it carries: the row a drag started on may be drawn again before it ends, and its end
  // is then told to nobody - so what a pane's drag carries is taken at its start and never outlives the next one.
  const dragKind = e => { const types = [...(e.dataTransfer?.types || [])]; return types.includes(FILE_DRAG_TYPE) ? "pane" : types.includes("Files") ? "system" : ""; };
  const undrop = () => el.querySelectorAll(".fpane.drop").forEach(x => x.classList.remove("drop"));
  el.addEventListener("dragstart", e => {
    filesDrag = null;
    const pane = paneOf(e.target), row = e.target.closest?.(".frow[data-i]");
    if (!pane || !row) return;
    if (pane.going) return void e.preventDefault();
    const i = Number(row.dataset.i);
    if (!pane.sel.has(i)) select(pane, i);
    filesDrag = { side: pane.side, what: snap(pane, selectedOf(pane)) };
    e.dataTransfer.setData(FILE_DRAG_TYPE, pane.side);
    e.dataTransfer.effectAllowed = "copy";
  });
  el.addEventListener("dragend", () => { filesDrag = null; undrop(); });
  const target = e => {
    const pane = paneOf(e.target), kind = dragKind(e);
    if (!pane || !kind || pane.error || pane.note || !pane.path || pane.going) return null;
    if (kind === "pane") return filesDrag && filesDrag.side !== pane.side ? pane : null;
    return pane.node ? pane : null;
  };
  el.addEventListener("dragover", e => {
    const pane = target(e);
    // A file let go anywhere else in the dialog is refused, not opened by the window.
    if (!pane) { e.preventDefault(); e.dataTransfer.dropEffect = "none"; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const p = paneEl(pane);
    if (!p.classList.contains("drop")) { p.classList.add("drop"); p.dataset.drop = t("files.dropHere", { name: pane.name }); }
  });
  el.addEventListener("dragleave", e => { const p = e.target.closest?.(".fpane"); if (p && !p.contains(e.relatedTarget)) p.classList.remove("drop"); });
  el.addEventListener("drop", e => {
    const pane = target(e), drag = dragKind(e) === "pane" ? filesDrag : null;
    e.preventDefault();
    filesDrag = null;
    undrop();
    if (!pane) return;
    const row = e.target.closest(".frow[data-i]"), into = row && pane.entries[Number(row.dataset.i)];
    const dest = destOf(pane, into?.dir ? filePathOf(pane, into.name) : null);
    // From the system: the paths of this computer's files, as it gives them.
    const what = drag ? drag.what : { ...snap(otherPane(pane)), items: [...e.dataTransfer.files].map(f => window.terminals.getPathForFile(f)).filter(Boolean).map(path => ({ path })) };
    if (what.items.length) sendEntries(what, dest).catch(err => toast(err.message, true));
  });
  el.addEventListener("keydown", e => {
    // In a pane's search: Escape clears it (a second one, on an empty field, closes the dialog); Enter asks at once.
    if (e.target.classList?.contains("fpane-filter")) {
      const pane = paneOf(e.target);
      if (e.key === "Enter") { e.preventDefault(); return void filterNow(pane); }
      if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.target.value = ""; return void filterNow(pane); }
    }
    if (e.key === "Escape") {
      if (typeof groupMenu !== "undefined" && groupMenu) return;
      e.preventDefault();
      return closeFilesDialog();
    }
    const pane = paneOf(e.target);
    if (!pane || !e.target.classList.contains("fpane-list") || pane.error || pane.note) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!pane.entries.length) return;
      // From the row reached last, not from where the range began: Shift held, each press takes one row more.
      select(pane, Math.max(0, Math.min(pane.entries.length - 1, pane.cursor + (e.key === "ArrowDown" ? 1 : -1))), { range: e.shiftKey });
      paneEl(pane).querySelector(`.frow[data-i="${pane.cursor}"]`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === "Backspace") { e.preventDefault(); return void (pane.parent !== null && goTo(pane, pane.parent)); }
    const picked = selectedOf(pane);
    const act = { Enter: () => picked.length === 1 && openEntry(pane, picked[0]), Delete: () => deleteEntries(snap(pane, picked)), F2: () => picked.length === 1 && renameEntry(snap(pane, picked)) }[e.key];
    if (!act) return;
    e.preventDefault();
    // Run now, not a moment later: what it is about is taken while the pane still shows it.
    if (!pane.going) Promise.resolve(act()).catch(err => toast(err.message, true));
  });
  // A click on the backdrop beside the dialog closes it, as the palette's does.
  el.addEventListener("mousedown", e => { if (e.target === el) closeFilesDialog(); });
}
