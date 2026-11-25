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
// main.js does the work (preload.js window.files; file-transfers.js): a side is a computer, "" for this one, and its
// paths are its own - the other computer may be Linux, so a path there is joined with the separator it answered, never
// with this one's. The overlay sits under the app's menus, messages and dialogs (styles.css z-index), so the menu of a
// row, a toast and the delete confirmation are the app's own. Loaded after renderer.js: uses $, esc, icon, t from
// common.js and openMenu, groupMenu, toast, confirmDialog.
let filesView = null;     // the overlay, once built
let filesPanes = [];      // [left, right]: { side, node, name, trash, error, path, sep, parent, entries, next, sel, anchor, loading, note }
let filesQueue = [];      // main's list (preload.js files.transfers)
let filesDrag = null;     // the pane a drag started in
let filesPhones = [];     // the paired phones, [{ id, name, online }] (preload.js files.phones)
const FILES_SORT_KEY = "agentdeck.files.sort"; // { left: { sort, desc }, right: { sort, desc } }
const FILTER_MS = 350;    // the pause in typing after which the computer is asked
const SORTS = ["name", "size", "mtime"];
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
const filePathOf = (pane, name) => (pane.path === "" ? name : pane.path.endsWith(pane.sep) ? pane.path + name : pane.path + pane.sep + name);
const otherPane = pane => filesPanes[pane.side === "left" ? 1 : 0];
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
  return el;
}

async function openFilesDialog(term) {
  const sides = await window.files.open(term);
  filesView ||= buildFilesView();
  filesPanes = [sides.left, sides.right].map((s, i) => ({ ...s, side: i ? "right" : "left", path: null, sep: "", parent: null, entries: [], next: "", sel: new Set(), anchor: -1, loading: false, note: "",
    ...savedSort(i ? "right" : "left"), filter: "", total: null, sortable: false, timer: 0 }));
  for (const pane of filesPanes) paneEl(pane).querySelector(".fpane-filter").value = "";
  filesView.querySelector("#filesTitle span").textContent = t("files.title", { name: sides.right.name });
  for (const pane of filesPanes) {
    const el = paneEl(pane);
    el.querySelector(".fpane-name").textContent = pane.name;
    el.querySelector(".fpane-name").title = pane.name;
  }
  const [left, right] = filesPanes;
  for (const [btn, from, to] of [[filesView.querySelector('[data-send="right"]'), left, right], [filesView.querySelector('[data-send="left"]'), right, left]]) {
    const title = t("files.sendTo", { from: from.name, to: to.name });
    btn.title = title;
    btn.setAttribute("aria-label", title);
  }
  filesView.hidden = false;
  // The window behind takes no focus and no keys meanwhile (a terminal there would type them).
  document.querySelector("main").inert = true;
  renderFilesQueue(await window.files.transfers());
  filesPhones = await window.files.phones();
  for (const pane of filesPanes) {
    if (pane.error) { pane.note = t(pane.error === "offline" ? "files.offline" : "files.needsUpdate", { name: pane.name }); renderPane(pane); }
    else goTo(pane, pane.start, [pane.node ? "~" : "", ""]);
  }
  paneEl(right).querySelector(".fpane-list").focus();
}
function closeFilesDialog() {
  if (!filesView || filesView.hidden) return;
  if (typeof closeGroupMenu === "function") closeGroupMenu();
  filesView.hidden = true;
  document.querySelector("main").inert = false;
}
const paneEl = pane => filesView.querySelector(`.fpane[data-side="${pane.side}"]`);
const paneOf = el => filesPanes.find(p => p.side === el?.closest?.(".fpane")?.dataset.side) || null;

// ---------- a pane: listing, paging, drawing ----------
// A folder opened: its first page. One that cannot be listed leaves the pane where it was - or, for the folder a pane
// starts in, goes on to the next of `fallback` (the home, the drives).
// keep: the same folder in another order or with another search (else a search typed for the last folder goes).
async function goTo(pane, path, fallback = [], { keep = false } = {}) {
  if (!keep && pane.filter) { pane.filter = ""; paneEl(pane).querySelector(".fpane-filter").value = ""; }
  pane.loading = true;
  renderPane(pane);
  const asked = pane.asked = (pane.asked || 0) + 1;
  const r = await window.files.call(pane.node, "list", { path, ...listParams(pane, path) });
  if (asked !== pane.asked) return false;   // a later request took over: this answer is of an older question
  pane.loading = false;
  if (r.error) {
    if (fallback.length && r.error !== "offline" && r.error !== "unknownMethod") return goTo(pane, fallback[0], fallback.slice(1));
    if (r.error === "unknownMethod") pane.note = t("files.needsUpdate", { name: pane.name });
    else if (r.error === "offline") pane.note = t("files.offline", { name: pane.name });
    else filesFailed(pane, r);
    renderPane(pane);
    return false;
  }
  Object.assign(pane, { path: r.value.path, sep: r.value.sep, parent: r.value.parent, entries: r.value.entries, next: r.value.next, sel: new Set(), anchor: -1, note: "" });
  // A computer that answers no total cannot sort or search (an older AgentDeck); the drives are not sorted either.
  pane.total = Number.isInteger(r.value.total) ? r.value.total : null;
  if (pane.path) pane.sortable = pane.total !== null;
  renderPane(pane);
  paneEl(pane).querySelector(".fpane-list").scrollTop = 0;
  return true;
}
const refreshPane = pane => (pane.path === null ? Promise.resolve(false) : goTo(pane, pane.path, [], { keep: true }));
async function loadMore(pane) {
  if (!pane.next || pane.loading) return;
  pane.loading = true;
  const asked = pane.asked;
  const r = await window.files.call(pane.node, "list", { path: pane.path, after: pane.next, ...listParams(pane, pane.path) });
  if (asked !== pane.asked) return;         // the folder, order or search changed meanwhile: not a page of what is shown
  pane.loading = false;
  if (r.error) return filesFailed(pane, r);
  if (r.value.path !== pane.path) return;
  pane.entries = [...pane.entries, ...r.value.entries];
  pane.next = r.value.next;
  renderPane(pane);
}
// The folders above the shown one, each a step back: the drives first, then each folder down to this one.
function crumbsOf(pane) {
  const out = [{ label: t("files.roots"), path: "" }];
  if (!pane.path) return out;
  const parts = pane.path.split(pane.sep).filter(Boolean);
  let at = pane.sep === "/" ? "/" : "";
  if (pane.sep === "/") out.push({ label: "/", path: "/" });
  parts.forEach((part, i) => {
    at = pane.sep === "/" ? (at === "/" ? `/${part}` : `${at}/${part}`) : i === 0 ? `${part}${pane.sep}` : at.endsWith(pane.sep) ? at + part : at + pane.sep + part;
    out.push({ label: part, path: at });
  });
  return out;
}
function renderPane(pane) {
  const el = paneEl(pane), off = Boolean(pane.error);
  el.classList.toggle("off", off);
  for (const b of el.querySelectorAll(".fpane-tools button")) b.disabled = off || pane.path === null;
  el.querySelector('[data-fa="up"]').disabled = off || pane.parent === null || pane.path === null;
  el.querySelector('[data-fa="mkdir"]').disabled = off || !pane.path;
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
  if (pane.note) { list.innerHTML = `<div class="fpane-note">${icon("alert")}<span>${esc(pane.note)}</span></div>`; return; }
  if (pane.loading && !pane.entries.length) { list.innerHTML = `<div class="fpane-note">${esc(t("files.loading"))}</div>`; return; }
  const rows = pane.entries.map((e, i) => `<div class="frow${e.dir ? " dir" : ""}${pane.sel.has(i) ? " sel" : ""}${e.name.startsWith(".") ? " hidden-file" : ""}" data-i="${i}" draggable="true" role="option" aria-selected="${pane.sel.has(i)}">
      <span class="fname">${icon(e.dir ? "folder" : "file")}<span title="${esc(e.name)}">${esc(e.name)}</span>${e.link ? `<small class="flink">↪</small>` : ""}</span>
      <span class="fsize">${e.dir ? "" : esc(sizeText(e.size))}</span><span class="ftime">${esc(timeText(e.mtime))}</span></div>`).join("");
  list.innerHTML = (rows || `<div class="fpane-note">${esc(pane.filter ? t("files.noMatch", { filter: pane.filter }) : t("files.empty"))}</div>`) + (pane.next ? `<button class="btn sm fmore" data-fa="more">${esc(t("files.loadMore"))}</button>` : "");
}
const selectedOf = pane => [...pane.sel].sort((a, b) => a - b).map(i => pane.entries[i]).filter(Boolean);
function select(pane, i, { toggle = false, range = false } = {}) {
  if (range && pane.anchor >= 0) {
    pane.sel = new Set();
    for (let k = Math.min(pane.anchor, i); k <= Math.max(pane.anchor, i); k++) pane.sel.add(k);
  } else if (toggle) {
    if (pane.sel.has(i)) pane.sel.delete(i); else pane.sel.add(i);
    pane.anchor = i;
  } else { pane.sel = new Set(i >= 0 ? [i] : []); pane.anchor = i; }
  for (const row of paneEl(pane).querySelectorAll(".frow[data-i]")) {
    const on = pane.sel.has(Number(row.dataset.i));
    row.classList.toggle("sel", on);
    row.setAttribute("aria-selected", String(on));
  }
}

// ---------- what a row does ----------
function openEntry(pane, e) {
  if (e.dir) return goTo(pane, filePathOf(pane, e.name));
  return sendEntries(pane, [e]);
}
// Files and folders of one pane into the folder the other one shows.
async function sendEntries(from, entries, folder = null) {
  const to = otherPane(from);
  if (!entries.length) return toast(t("files.pickFirst", { name: from.name }), true);
  if (to.error || !to.path) return toast(to.note || t("files.pickFolder", { name: to.name }), true);
  for (const e of entries) {
    const r = await window.files.send({ node: from.node, path: filePathOf(from, e.name) }, { node: to.node, folder: folder || to.path });
    if (r.error) return filesFailed(from, r);
  }
}
// Files dragged in from the system (Explorer) onto the remote pane: from this computer.
// folder: the folder row they were let go on, else the folder the pane shows.
async function sendDropped(to, files, folder) {
  const from = otherPane(to);
  for (const f of files) {
    const p = window.terminals.getPathForFile(f);
    if (!p) continue;
    const r = await window.files.send({ node: from.node, path: p }, { node: to.node, folder: folder || to.path });
    if (r.error) return filesFailed(from, r);
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
    d.addEventListener("close", () => { d.remove(); resolve(d.returnValue === "ok" ? field.value.trim() : ""); });
    document.body.append(d);
    d.showModal();
    // A file's name is chosen without its extension, as Explorer does.
    const dot = stem ? value.lastIndexOf(".") : -1;
    field.focus();
    field.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}
async function renameEntry(pane, e) {
  let name = e.name, body = t("files.rename.body", { name: e.name, computer: pane.name });
  for (;;) {
    const next = await askFileText({ title: t("files.rename.title"), body, value: name, ok: t("files.rename.title"), stem: !e.dir });
    if (!next || next === e.name) return;
    if (!isPlainName(next)) return toast(t("files.error", { computer: pane.name, message: t("errors.invalidData") }), true);
    const r = await window.files.call(pane.node, "rename", { from: filePathOf(pane, e.name), to: filePathOf(pane, next) });
    // A name that is taken: "name (2)" is offered (docs/FILES.md 1).
    if (r.error === "exists") { name = nextFreeName(next, e.dir); body = t("files.rename.taken", { name: next, computer: pane.name }); continue; }
    if (r.error) return filesFailed(pane, r);
    return refreshPane(pane);
  }
}
async function makeFolder(pane) {
  const name = await askFileText({ title: t("files.newFolder"), body: t("files.mkdir.body", { folder: pane.path, computer: pane.name }), value: t("files.newFolder"), ok: t("files.newFolder") });
  if (!name) return;
  if (!isPlainName(name)) return toast(t("files.error", { computer: pane.name, message: t("errors.invalidData") }), true);
  const r = await window.files.call(pane.node, "mkdir", { path: filePathOf(pane, name), keep: true });
  if (r.error) return filesFailed(pane, r);
  await refreshPane(pane);
}
// "Copy to folder…" and "Move to folder…": a folder of the same computer, typed (it starts as the one shown). A copy
// is a job there and a row of the queue, and gets "name (2)" where the name is taken; a move is a rename, and one
// across drives becomes a copy that removes the source when all of it arrived.
async function copyEntry(pane, e, move) {
  const kind = move ? "move" : "copy";
  const folder = await askFileText({ title: t(`files.${kind}.title`), body: t(`files.${kind}.body`, { name: e.name, computer: pane.name }), value: pane.path, ok: t(`files.${kind}.title`) });
  if (!folder) return;
  const into = name => (folder.endsWith(pane.sep) ? folder + name : folder + pane.sep + name);
  const from = filePathOf(pane, e.name);
  if (!move) {
    // A folder copied into the folder it is in: the host takes its own path for "into itself", so the copy is asked
    // for as "name (2)" from the start (a file gets that number there anyway).
    const same = into(e.name) === from;
    const r = await window.files.copy(pane.node, from, into(same ? nextFreeName(e.name, e.dir) : e.name), false);
    return r.error ? filesFailed(pane, r) : undefined;
  }
  let name = e.name;
  for (;;) {
    const r = await window.files.call(pane.node, "rename", { from, to: into(name) });
    if (r.error === "crossDevice") {
      const c = await window.files.copy(pane.node, from, into(name), true);
      return c.error ? filesFailed(pane, c) : undefined;
    }
    if (r.error === "exists") {
      name = await askFileText({ title: t("files.move.title"), body: t("files.move.taken", { name, computer: pane.name }), value: nextFreeName(name, e.dir), ok: t("files.move.title"), stem: !e.dir });
      if (!name || !isPlainName(name)) return;
      continue;
    }
    if (r.error) return filesFailed(pane, r);
    return refreshPane(pane);
  }
}
// A file of this computer offered to a phone: a row of the queue from now on; the phone asks before it saves it.
async function offerEntry(pane, e, phone) {
  const r = await window.files.offer(phone.id, filePathOf(pane, e.name));
  if (r.error) return toast(t("files.error", { computer: phone.name, message: r.message || r.error }), true);
  toast(t("files.toPhone.sent", { name: e.name, phone: phone.name }));
}
// Always asked first, naming the computer and saying where it goes: its bin, or nowhere (docs/FILES.md 1).
async function deleteEntries(pane, entries) {
  if (!entries.length) return;
  const name = entries.length === 1 ? entries[0].name : tn("files.items", entries.length);
  const body = [t(pane.trash ? "files.delete.trash" : "files.delete.forGood", { name, computer: pane.name }), entries.some(e => e.dir) ? t("files.delete.folder") : ""].filter(Boolean).join("\n");
  if (!(await confirmDialog({ title: t("files.delete.title", { name }), body, confirmLabel: t("files.delete.go"), danger: true }))) return;
  let trashed = pane.trash, failed = false;
  for (const e of entries) {
    const r = await window.files.call(pane.node, "delete", { path: filePathOf(pane, e.name) });
    if (r.error) { filesFailed(pane, r); failed = true; break; }
    trashed = r.value?.trashed === true;
  }
  // Said done only when all of it went (a file in use stops the rest, and says so).
  if (!failed) toast(t(trashed ? "files.deleted.trash" : "files.deleted.forGood", { name, computer: pane.name }));
  await refreshPane(pane);
}
const previewBox = () => $("filesPreview") || (() => {
  const d = document.createElement("dialog");
  d.id = "filesPreview";
  d.className = "dialog files-preview";
  d.innerHTML = `<header><h2></h2><button class="icon-btn" data-close title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}">${icon("x")}</button></header><div class="fpv-body"></div>`;
  d.querySelector("[data-close]").addEventListener("click", () => d.close());
  document.body.append(d);
  return d;
})();
async function previewEntry(pane, e) {
  const r = await window.files.preview(pane.node, filePathOf(pane, e.name));
  if (r.error) return filesFailed(pane, r);
  const v = r.value;
  if (v.kind === "pdf") return toast(t("files.preview.pdf", { name: e.name }));
  if (v.kind === "binary") return toast(t("files.preview.binary", { name: e.name }), true);
  if (v.kind === "tooBig") return toast(t("files.preview.tooBig", { name: e.name, size: sizeText(v.max) }), true);
  const d = previewBox();
  d.querySelector("h2").textContent = `${e.name} · ${pane.name}`;
  const body = d.querySelector(".fpv-body");
  body.className = `fpv-body ${v.kind}`;
  if (v.kind === "image") { body.innerHTML = "<img alt=\"\">"; body.querySelector("img").src = v.data; }
  else if (v.kind === "markdown") body.innerHTML = `<div class="fpv-md">${markdownHtml(v.text)}</div>`;
  else { body.innerHTML = "<pre></pre>"; body.querySelector("pre").textContent = v.text; }
  d.showModal();
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

// The menu of a row (or of the folder, on its empty part), opened where the pointer is.
function openFileMenu(pane, e, x, y) {
  const anchor = document.createElement("span");
  anchor.className = "files-anchor";
  anchor.style.left = `${x}px`;
  anchor.style.top = `${y}px`;
  filesView.append(anchor);
  const picked = selectedOf(pane), one = picked.length === 1 ? picked[0] : null, other = otherPane(pane);
  // The pane's list has the keyboard again before an item runs: a dialog it opens gives the focus back there.
  const list = paneEl(pane).querySelector(".fpane-list");
  const run = fn => () => { list.focus(); return fn().catch(err => toast(err.message, true)); };
  // To a phone: only a file of this computer (the phone pulls it from here), and only a phone linked now - with one,
  // the item names it; with more, they are its submenu; with none, it says why it cannot.
  const phones = filesPhones.filter(p => p.online);
  const toPhone = pane.node || !one || one.dir ? [] : phones.length === 1
    ? [{ label: t("files.menu.toPhoneNamed", { name: phones[0].name }), icon: "phone", run: run(() => offerEntry(pane, one, phones[0])) }]
    : phones.length ? [{ label: t("files.menu.toPhone"), icon: "phone", items: phones.map(p => ({ label: p.name, icon: "phone", run: run(() => offerEntry(pane, one, p)) })) }]
    : [{ label: t("files.menu.toPhone"), icon: "phone", disabled: true, detail: t(filesPhones.length ? "files.toPhone.offline" : "files.toPhone.none") }];
  const items = !e ? [
    { label: t("files.newFolder"), icon: "plus", disabled: !pane.path, run: run(() => makeFolder(pane)) },
    { label: t("files.refresh"), icon: "refresh", run: run(() => refreshPane(pane)) }
  ] : [
    ...(one?.dir ? [{ label: t("files.menu.open"), icon: "folder", run: run(() => goTo(pane, filePathOf(pane, one.name))) }] : []),
    ...(one && !one.dir ? [{ label: t("files.menu.preview"), icon: "eye", run: run(() => previewEntry(pane, one)) }] : []),
    { label: t("files.menu.send", { name: other.name }), icon: pane.node ? "download" : "upload", disabled: Boolean(other.error) || !other.path, run: run(() => sendEntries(pane, picked)) },
    ...toPhone,
    { separator: true },
    ...(one ? [
      { label: t("files.menu.rename"), icon: "pencil", run: run(() => renameEntry(pane, one)) },
      { label: t("files.menu.copy"), icon: "copy", run: run(() => copyEntry(pane, one, false)) },
      { label: t("files.menu.move"), icon: "stack", run: run(() => copyEntry(pane, one, true)) },
      { label: t("files.menu.copyPath"), icon: "copy", run: run(async () => { const p = filePathOf(pane, one.name); await window.manager.copyText(p); toast(t("files.copiedPath", { path: p })); }) }
    ] : []),
    { label: t("files.newFolder"), icon: "plus", disabled: !pane.path, run: run(() => makeFolder(pane)) },
    { separator: true },
    { label: t("files.menu.delete"), icon: "trash", danger: true, run: run(() => deleteEntries(pane, picked)) }
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
    const live = ["running", "queued", "waiting", "noAnswer"].includes(r.state);
    // An offer's bytes move on the phone, out of sight: its row says what the phone answered, and Stop is there only
    // while the phone has not taken it.
    const offer = r.kind === "offer";
    const state = r.state === "running" ? (offer ? t("files.state.saving") : `${pct} %`) : t(`files.state.${r.state}`);
    const stoppable = offer ? r.state === "waiting" || r.state === "noAnswer" : live;
    const details = [
      r.state === "running" && r.current && r.count > 1 ? r.current : "",
      r.count > 1 ? t("files.row.files", { done: r.files, count: r.count }) : "",
      r.total ? (offer ? sizeText(r.total) : `${sizeText(r.bytes)} / ${sizeText(r.total)}`) : "",
      r.skipped ? t("files.row.skipped", { n: r.skipped }) : "",
      r.state === "done" && r.path && r.kind === "transfer" ? t("files.row.into", { path: r.path }) : "",
      offer && (r.state === "noAnswer" || r.state === "expired") ? t("files.toPhone.noAnswer", { name: r.to.name }) : "",
      offer && r.state === "declined" ? t("files.toPhone.declined", { name: r.to.name }) : "",
      r.state === "failed" ? t("files.error", { computer: offer || (r.error === "offline" && r.to.node) ? r.to.name : r.from.name, message: r.message || fileErrorText(r.error) }) : ""
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
window.files?.onPhones?.(list =>{ filesPhones = Array.isArray(list) ? list : []; });
// (A page without the bridge - a test's fixture of the window - has no queue to follow.)
window.files?.onTransfers(list => {
  const before = new Map(filesQueue.map(r => [r.id, r.state]));
  renderFilesQueue(list);
  if (!filesView || filesView.hidden) return;
  // A row that just ended changed a folder: the pane of its computer is listed again (asked now, not on a timer).
  const ended = filesQueue.filter(r => before.has(r.id) && before.get(r.id) !== r.state && !["queued", "running"].includes(r.state));
  for (const pane of filesPanes) if (ended.some(r => r.to.node === pane.node || (r.kind === "copy" && r.from.node === pane.node))) refreshPane(pane);
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
    if (send) { const to = filesPanes.find(p => p.side === send); return sendEntries(otherPane(to), selectedOf(otherPane(to))).catch(err => toast(err.message, true)); }
    if (!pane) return;
    if (fa === "up") return pane.parent !== null && goTo(pane, pane.parent);
    if (fa === "refresh") return refreshPane(pane);
    if (fa === "mkdir") return makeFolder(pane).catch(err => toast(err.message, true));
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
    if (entry) openEntry(pane, entry).catch(err => toast(err.message, true));
  });
  el.addEventListener("contextmenu", e => {
    const pane = paneOf(e.target);
    if (!pane || !e.target.closest(".fpane-list") || pane.error || pane.path === null) return;
    e.preventDefault();
    const row = e.target.closest(".frow[data-i]"), i = row ? Number(row.dataset.i) : -1;
    if (i >= 0 && !pane.sel.has(i)) select(pane, i);
    if (i < 0) select(pane, -1);
    openFileMenu(pane, i >= 0 ? pane.entries[i] : null, e.clientX, e.clientY);
  });
  // A drag from one pane onto the other copies the selected there - into a folder row it is let go on, else into the
  // folder that pane shows. Files from the system's Explorer go to the remote pane the same way.
  el.addEventListener("dragstart", e => {
    const pane = paneOf(e.target), row = e.target.closest?.(".frow[data-i]");
    if (!pane || !row) return;
    const i = Number(row.dataset.i);
    if (!pane.sel.has(i)) select(pane, i);
    filesDrag = pane;
    e.dataTransfer.setData(FILE_DRAG_TYPE, pane.side);
    e.dataTransfer.effectAllowed = "copy";
  });
  el.addEventListener("dragend", () => { filesDrag = null; el.querySelectorAll(".fpane.drop").forEach(x => x.classList.remove("drop")); });
  const target = e => {
    const pane = paneOf(e.target);
    if (!pane || pane.error || !pane.path) return null;
    if (filesDrag && filesDrag !== pane) return pane;
    return !filesDrag && pane.node && [...(e.dataTransfer?.types || [])].includes("Files") ? pane : null;
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
    const pane = target(e);
    e.preventDefault();
    if (!pane) return;
    paneEl(pane).classList.remove("drop");
    const row = e.target.closest(".frow[data-i]"), into = row && pane.entries[Number(row.dataset.i)];
    const folder = into?.dir ? filePathOf(pane, into.name) : null;
    const from = filesDrag;
    filesDrag = null;
    const work = from ? sendEntries(from, selectedOf(from), folder) : sendDropped(pane, [...e.dataTransfer.files], folder);
    work.catch(err => toast(err.message, true));
  });
  el.addEventListener("keydown", e => {
    // In a pane's search: Escape clears it (a second one, on an empty field, closes the dialog); Enter asks at once.
    if (e.target.classList?.contains("fpane-filter")) {
      const pane = paneOf(e.target);
      if (e.key === "Enter") { e.preventDefault(); return void filterNow(pane); }
      if (e.key === "Escape" && e.target.value) { e.preventDefault(); e.stopPropagation(); e.target.value = ""; return void filterNow(pane); }
    }
    if (e.key === "Escape") {
      if (typeof groupMenu !== "undefined" && groupMenu) return;
      e.preventDefault();
      e.stopPropagation();
      return closeFilesDialog();
    }
    const pane = paneOf(e.target);
    if (!pane || !e.target.classList.contains("fpane-list") || pane.error) return;
    const picked = selectedOf(pane), last = pane.anchor;
    const keys = {
      Enter: () => picked.length === 1 && openEntry(pane, picked[0]),
      Delete: () => deleteEntries(pane, picked),
      F2: () => picked.length === 1 && renameEntry(pane, picked[0]),
      Backspace: () => pane.parent !== null && goTo(pane, pane.parent),
      ArrowDown: () => pane.entries.length && select(pane, Math.min(pane.entries.length - 1, last + 1), { range: e.shiftKey }),
      ArrowUp: () => pane.entries.length && select(pane, Math.max(0, last - 1), { range: e.shiftKey })
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve().then(keys[e.key]).catch(err => toast(err.message, true));
    paneEl(pane).querySelector(".frow.sel")?.scrollIntoView({ block: "nearest" });
  });
  // A click on the backdrop beside the dialog closes it, as the palette's does.
  el.addEventListener("mousedown", e => { if (e.target === el) closeFilesDialog(); });
}
