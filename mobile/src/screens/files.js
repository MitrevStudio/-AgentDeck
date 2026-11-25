// "Files" (docs/FILES.md 5): the files of one computer - the one of the session, terminal or row it was opened from -
// in one pane, its name in the title. It starts in the folder it was opened for (a session's or a terminal's folder,
// the computer's home); a folder that is no longer there gives the home. Above the list the folders the path goes
// through, each a step back up, the computer's drives at the start. The list: folders first, hidden ones too, a
// file's size and time. A tap opens: a folder, text and markdown (rendered) and a picture here, a PDF in the system's
// viewer through the app's Files plugin; anything else asks "Download". A long press - or the button at a row's end -
// opens a sheet with Download, Copy to…, Move to…, Rename, Delete; Delete always asks, naming the computer and saying
// "to the bin" or "for good" (host.info `trash`). "Copy to…" and "Move to…" choose a folder in a dialog of the
// computer's folders, which has "New folder". "Upload file" in the header takes a file from the phone's picker into
// the open folder. A transfer - one at a time - shows its progress under the list, with Stop; leaving the screen stops
// a download or an upload, while a copy goes on on the computer.
//
// The logic is files.js (no DOM there; scripts/test-mobile-files.js runs it). The sheet, the folder dialog and the
// viewer are .sheet-backdrop elements: the phone's Back closes them as it closes every sheet (main.js). Nothing is
// asked on a timer except a running copy's progress.
//
// Above the list, in a folder of a computer that can sort: a search field (only the names that hold what is typed,
// asked of the computer a moment after the typing stops; its x and Escape clear it) and the order (a sheet: name
// A-Z / Z-A, newest / oldest, largest / smallest; folders stay first). The order is remembered on this phone; the
// search is the folder's and goes when another folder is opened. Any order but the name's makes the computer look at
// every entry before the first page, so neither is asked for by itself. A computer whose AgentDeck cannot sort yet
// (no `total` in its answer) gets no such controls.
// params: node; path - the folder to start in ("~": the home).
import { t, errorText, formatTime, formatDate } from "../i18n.js";
import { esc, baseName } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { renderMarkdown } from "../markdown.js";
import { createRemoteFiles, crumbs, entryPath, tapAction, actionsFor, bytesText, filesOutdated, ORDERS, orderOf } from "../files.js";
import { nativeFiles } from "../files-native.js";

const LONG_MS = 500, MOVE_PX = 10;
const HOME = "~";
const ORDER_KEY = "agentdeck.files.order"; // the order chosen last (ORDERS key), on this phone only
const FILTER_MS = 350;                       // the pause in typing after which the computer is asked
const savedOrder = () => { try { return orderOf(localStorage.getItem(ORDER_KEY)); } catch { return orderOf(""); } };

// A file's time in a row: the time today, the day this year, the date before.
function when(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return t("files.today", { time: formatTime(ms) });
  return formatDate(ms, d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export function render(el, ctx, p) {
  const { store } = ctx, name = store.nodeName(p.node);
  const files = createRemoteFiles({ provider: store.provider, node: p.node, plugin: nativeFiles() });
  let left = false, folder = null, loading = false, error = null, gen = 0, task = null, wasOnline = null;
  let order = savedOrder(), filter = "", filterTimer = 0;
  const overlays = new Set();
  el.classList.add("files");
  el.innerHTML = `${header(t("files.titleOn", { name }), { back: true, actions: `<button class="btn sm" data-act="upload" hidden>${icon("upload")}<span>${esc(t("files.upload"))}</span></button>` })}
    <nav class="files-crumbs" aria-label="${esc(t("files.where"))}"></nav>
    <div class="files-tools" hidden><div class="searchbar files-search">${icon("search")}<input type="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t("files.filterPh"))}" aria-label="${esc(t("files.filterPh"))}">
      ${iconBtn("x", t("files.filterClear"), 'data-act="unfilter" hidden')}</div>
      <button class="btn sm files-order" data-act="order" aria-haspopup="dialog">${icon("sort")}<span></span></button></div>
    <main class="body files-list"></main>
    <div class="files-task" role="status" hidden><div class="task-text"><b></b><small></small><i class="task-bar"><i></i></i></div>
      <button class="btn sm" data-act="stop">${icon("stop")}<span>${esc(t("files.stop"))}</span></button></div>
    <input class="files-input" type="file" hidden>`;
  wireBack(el, ctx);
  const nav = el.querySelector(".files-crumbs"), body = el.querySelector(".files-list"), taskEl = el.querySelector(".files-task");
  const uploadBtn = el.querySelector("[data-act='upload']"), input = el.querySelector(".files-input");
  const tools = el.querySelector(".files-tools"), search = tools.querySelector("input"), unfilter = tools.querySelector("[data-act='unfilter']"), orderBtn = tools.querySelector("[data-act='order']");
  const online = () => store.nodes().some(n => n.id === p.node && n.online);
  const info = () => store.node(p.node)?.info || null;

  // ---------- the list ----------
  // keep: the same folder in another order or with another search (else a search typed for the last folder goes).
  async function load(path, { start = false, keep = false } = {}) {
    const my = ++gen;
    if (!keep && filter) { filter = ""; search.value = ""; }
    loading = true;
    draw();
    try {
      if (!online()) throw Object.assign(new Error("offline"), { code: "offline" });
      const f = await files.folder(path, { sort: order.sort, desc: order.desc, filter });
      if (left || my !== gen) return;
      folder = f;
      error = null;
    } catch (e) {
      if (left || my !== gen) return;
      // The folder it was opened for is gone (a session's folder deleted since): the home instead.
      if (start && path !== HOME && (e?.code === "fileMissing" || e?.code === "notFolder")) {
        ctx.toast(t("files.startMissing"));
        return load(HOME);
      }
      // A folder that could not be opened (no permission there): said, and the one shown stays.
      if (folder && !filesOutdated({ error: e }) && e?.code !== "offline") ctx.fail(e);
      else error = e;
    }
    loading = false;
    draw();
  }
  const reload = () => load(folder ? folder.path : p.path || HOME, { keep: true });

  function rowHtml(e, i) {
    const meta = [e.dir ? "" : bytesText(e.size), e.mtime ? when(e.mtime) : "", e.link ? t("files.link") : ""].filter(Boolean).join(" · ");
    const more = actionsFor(e, { canDownload: files.canDownload, atRoots: folder.path === "" }).length;
    return `<div class="frow${e.name.startsWith(".") ? " dotted" : ""}">
      <button class="frow-open" data-i="${i}">${icon(e.dir ? "folder" : "file", e.dir ? "dir" : "")}
        <span class="row-main"><span class="row-title">${esc(e.name)}</span>${meta ? `<span class="row-meta">${esc(meta)}</span>` : ""}</span></button>
      ${more ? iconBtn("more", t("files.actionsFor", { name: e.name }), `data-more="${i}"`) : ""}</div>`;
  }
  function draw() {
    if (left) return;
    const up = online();
    const outdated = filesOutdated({ info: info(), error });
    uploadBtn.hidden = !folder || !folder.path || !up || outdated;
    tools.hidden = !folder?.path || !folder.sortable || !up || outdated;
    orderBtn.querySelector("span").textContent = t(`files.order.${order.key}`);
    orderBtn.setAttribute("aria-label", t("files.orderNow", { order: t(`files.order.${order.key}`) }));
    unfilter.hidden = !search.value;
    nav.innerHTML = folder && !outdated
      ? [`<button class="crumb" data-path="" aria-label="${esc(t("files.drives"))}"${folder.path ? "" : ' aria-current="location"'}>${icon("computer")}</button>`,
        ...crumbs(folder.path, folder.sep).map((c, i, all) => `<i class="crumb-sep" aria-hidden="true">›</i><button class="crumb" data-path="${esc(c.path)}"${i === all.length - 1 ? ' aria-current="location"' : ""}>${esc(c.name)}</button>`)].join("")
      : "";
    nav.scrollLeft = nav.scrollWidth;
    const note = (text, buttons = "") => `<div class="note">${icon("alert")}<div class="note-text">${esc(text)}</div></div>${buttons}`;
    if (outdated) body.innerHTML = note(t("files.needsUpdate", { name }));
    else if (!up) body.innerHTML = note(t("files.offline", { name }));
    else if (loading) body.innerHTML = `<p class="empty"><i class="spinner accent"></i> ${esc(t("files.loading"))}</p>`;
    else if (!folder) body.innerHTML = note(errorText(error), `<div class="files-again"><button class="btn" data-act="retry">${esc(t("files.retry"))}</button><button class="btn" data-act="home">${icon("folder")}${esc(t("files.home"))}</button></div>`);
    else {
      const searched = folder.order?.filter;
      const head = searched && folder.entries.length ? `<p class="files-count">${esc(t("files.matches", { n: folder.total }))}</p>` : "";
      body.innerHTML = `${head}${folder.entries.length ? `<div class="rows">${folder.entries.map(rowHtml).join("")}</div>` : `<p class="empty">${esc(searched ? t("files.noMatch", { filter: searched }) : t("files.empty"))}</p>`}
        ${folder.next ? `<button class="more-row" data-act="more">${esc(t("files.more"))}</button>` : ""}`;
    }
  }
  async function more(b) {
    b.disabled = true;
    const at = folder;
    try {
      await at.more();
      if (folder === at) { const top = body.scrollTop; draw(); body.scrollTop = top; }
    } catch (e) { if (!left) ctx.fail(e); b.disabled = false; }
  }

  // ---------- the order and the search ----------
  orderBtn.onclick = async () => {
    const pick = await ctx.menu(ORDERS.map(o => ({ key: o.key, icon: o.key === order.key ? "check" : "sort", label: t(`files.order.${o.key}`), on: o.key === order.key })));
    if (!pick || left || pick === order.key) return;
    order = orderOf(pick);
    try { localStorage.setItem(ORDER_KEY, order.key); } catch {}
    if (folder) load(folder.path, { keep: true });
  };
  const searchNow = () => {
    clearTimeout(filterTimer);
    const next = search.value.trim();
    unfilter.hidden = !search.value;
    if (next === filter || !folder?.path) return;
    filter = next;
    load(folder.path, { keep: true });
  };
  search.addEventListener("input", () => { unfilter.hidden = !search.value; clearTimeout(filterTimer); filterTimer = setTimeout(searchNow, FILTER_MS); });
  search.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); searchNow(); search.blur(); }
    else if (e.key === "Escape" && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ""; searchNow(); }
  });
  unfilter.onclick = () => { search.value = ""; searchNow(); search.focus(); };

  // ---------- one transfer at a time ----------
  // work({ signal, detach, onProgress }) -> its result, or null when it failed or was stopped (said in a toast).
  // keep: leaving the screen stops following it, it goes on there (a copy); else leaving stops it.
  async function run(label, work, { keep = false } = {}) {
    if (task) { ctx.toast(t("files.busy")); return null; }
    const stop = new AbortController(), detach = new AbortController();
    task = { stop, detach, keep };
    progress(label, null);
    try {
      return await work({ signal: stop.signal, detach: detach.signal, onProgress: pr => progress(label, pr) });
    } catch (e) {
      if (!left && e?.code === "cancelled") ctx.toast(t("files.stopped"));
      else if (!left && e?.code !== "detached") ctx.fail(e);
      return null;
    } finally {
      task = null;
      if (!left) progress(null);
    }
  }
  function progress(label, pr) {
    taskEl.hidden = !label;
    if (!label) return;
    const total = pr?.total || 0, done = pr?.bytes || 0;
    taskEl.querySelector("b").textContent = label;
    taskEl.querySelector("small").textContent = total ? `${t("files.progress", { done: bytesText(done), total: bytesText(total) })} · ${Math.floor((done / total) * 100)} %` : t("files.starting");
    taskEl.querySelector(".task-bar > i").style.width = total ? `${Math.min(100, (done / total) * 100)}%` : "0";
  }
  taskEl.querySelector("[data-act='stop']").onclick = () => task?.stop.abort();

  // ---------- what a tap and the sheet do ----------
  async function tap(e) {
    const what = tapAction(e, { canDownload: files.canDownload });
    if (what === "open") return load(entryPath(folder, e));
    if (what === "view") return view(e);
    if (what === "pdf") return openPdf(e);
    if (what === "needsApp") return ctx.toast(t("files.needsApp"), 5000);
    if (await ctx.confirm(t("files.downloadAsk", { name: e.name, size: bytesText(e.size) }), t("files.download")) === true && !left) download(e);
  }
  const SHEET = {
    download: { icon: "download", label: () => t("files.download") },
    needsApp: { icon: "alert", label: () => t("files.needsAppShort") },
    copy: { icon: "copy", label: () => t("files.copyTo") },
    move: { icon: "move", label: () => t("files.moveTo") },
    rename: { icon: "pencil", label: () => t("files.rename") },
    delete: { icon: "trash", label: () => t("files.delete"), danger: true }
  };
  async function actions(e) {
    if (!folder || !online()) return;
    const keys = actionsFor(e, { canDownload: files.canDownload, atRoots: folder.path === "" });
    if (!keys.length) return;
    const pick = await ctx.menu(keys.map(key => ({ key, icon: SHEET[key].icon, label: SHEET[key].label(), danger: SHEET[key].danger })));
    if (left || !pick) return;
    if (pick === "download") download(e);
    else if (pick === "needsApp") ctx.toast(t("files.needsApp"), 5000);
    else if (pick === "copy" || pick === "move") transfer(e, pick === "move");
    else if (pick === "rename") rename(e);
    else if (pick === "delete") remove(e);
  }

  async function download(e) {
    const r = await run(t("files.downloading", { name: e.name }), opts => files.download(entryPath(folder, e), e.name, opts));
    if (r && !left) ctx.toast(t("files.downloaded", { name: r.shown }));
  }
  const openPdf = e => run(t("files.opening", { name: e.name }), opts => files.openFile(entryPath(folder, e), e.name, opts));

  async function transfer(e, move) {
    const from = folder;
    const to = await pickFolder(t(move ? "files.pickMove" : "files.pickCopy", { name: e.name }), t(move ? "files.moveHere" : "files.copyHere"), from.path);
    if (to == null || left) return;
    const r = await run(t(move ? "files.moving" : "files.copying", { name: e.name }),
      opts => files.transfer({ path: entryPath(from, e), name: e.name, dir: e.dir }, to, from.sep, { move, ...opts }), { keep: true });
    if (!r || left) return;
    ctx.toast(r.unchanged ? t("files.sameFolder") : t(move ? "files.moved" : "files.copied", { name: baseName(r.path) }));
    reload();
  }
  async function rename(e) {
    const next = await ctx.prompt(t("files.renameTitle", { name: e.name }), e.name, t("files.rename"), { maxLength: 255 });
    if (!next || next === e.name || left) return;
    try {
      const r = await files.rename(entryPath(folder, e), folder.path, folder.sep, next, {
        dir: e.dir,
        offer: async ({ taken, next: other }) => (await ctx.confirm(t("files.renameTaken", { name: taken, next: other }), t("files.rename"))) === true
      });
      if (r && !left) { ctx.toast(t("files.renamed", { name: baseName(r.path) })); reload(); }
    } catch (err) { if (!left) ctx.fail(err); }
  }
  async function remove(e) {
    // What happens there decides the words: into its bin, or - a host without one - for good. Not known: for good.
    const bin = info()?.trash === 1;
    const ask = t(bin ? "files.deleteAskBin" : "files.deleteAskForGood", { name: e.name, computer: name });
    if (await ctx.confirm(ask, t(bin ? "files.toBin" : "files.deleteForGood"), { danger: true }) !== true || left) return;
    try {
      const r = await files.remove(entryPath(folder, e));
      if (!left) { ctx.toast(t(r.trashed ? "files.binned" : "files.deleted", { name: e.name })); reload(); }
    } catch (err) { if (!left) ctx.fail(err); }
  }

  // ---------- upload ----------
  uploadBtn.onclick = () => {
    if (task) return ctx.toast(t("files.busy"));
    if (folder?.path) input.click();
  };
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file || !folder?.path || left) return;
    const dir = folder.path, sep = folder.sep;
    // Back from the system's picker the links are only just being made again.
    const r = await run(t("files.uploading", { name: file.name }), async opts => { await store.whenOnline(p.node); return files.upload(dir, sep, file, file.name, opts); });
    if (!r || left) return;
    ctx.toast(t("files.uploaded", { name, file: baseName(r.path) }));
    if (folder?.path === dir) reload();
  };

  // ---------- an overlay (the viewer, the folder dialog) ----------
  // A .sheet-backdrop of its own: Back and Escape close it (close() is also what main.js's click on it does).
  function overlay(cls, html, onClose) {
    const ov = document.createElement("div");
    ov.className = `sheet-backdrop ${cls}`;
    ov.innerHTML = html;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      overlays.delete(close);
      ov.remove();
      onClose?.();
    };
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close(); } });
    overlays.add(close);
    document.body.append(ov);
    return { ov, close, get closed() { return closed; } };
  }

  // A file looked at here: text, markdown or a picture, read whole (files.js caps them); closing stops the reading.
  // Not while a transfer runs: one piece at a time on the link (docs/FILES.md 3.3), the terminals beside it.
  async function view(e) {
    if (task) return ctx.toast(t("files.busy"));
    const stop = new AbortController();
    let url = "";
    const v = overlay("files-viewer", `<div class="viewer" role="dialog" aria-modal="true" aria-label="${esc(e.name)}">
      ${header(e.name, { back: true, sub: esc(`${bytesText(e.size)} · ${name}`), actions: files.canDownload ? iconBtn("download", t("files.download"), 'data-act="download"') : "" })}
      <div class="viewer-body"><p class="empty"><i class="spinner accent"></i> <span>${esc(t("files.loading"))}</span></p></div></div>`,
    () => { stop.abort(); if (url) URL.revokeObjectURL(url); });
    const out = v.ov.querySelector(".viewer-body");
    v.ov.querySelector("[data-act='back']").onclick = v.close;
    const dl = v.ov.querySelector("[data-act='download']");
    if (dl) dl.onclick = () => { v.close(); download(e); };
    v.ov.querySelector("[data-act='back']").focus();
    try {
      const r = await files.preview(entryPath(folder, e), e, {
        signal: stop.signal,
        onProgress: pr => { if (pr.total > 256 * 1024) out.querySelector("span").textContent = `${t("files.loading")} ${t("files.progress", { done: bytesText(pr.bytes), total: bytesText(pr.total) })}`; }
      });
      if (v.closed) return;
      if (r.kind === "image") {
        url = URL.createObjectURL(r.blob);
        out.innerHTML = `<div class="viewer-image"><img alt="${esc(e.name)}"></div>`;
        out.querySelector("img").src = url;
      } else if (r.kind === "markdown") out.innerHTML = `<div class="md viewer-md">${renderMarkdown(r.text)}</div>`;
      else {
        out.innerHTML = `<pre class="viewer-text"></pre>`;
        out.firstElementChild.textContent = r.text;
      }
    } catch (err) {
      if (!v.closed && err?.code !== "cancelled") out.innerHTML = `<p class="empty">${esc(errorText(err))}</p>`;
    }
  }

  // "Copy to…" / "Move to…": the computer's folders, starting in `start`; "New folder" makes one in the folder shown
  // and goes into it - its name typed in the dialog itself, not in a sheet over it (Back closes the first sheet).
  // -> the chosen folder's path, or null.
  function pickFolder(title, okLabel, start) {
    return new Promise(resolve => {
      let at = null, my = 0, chosen = null, naming = false;
      const d = overlay("files-pick-back", `<div class="sheet menu files-pick" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="pick-head">${icon("folder")}<b>${esc(title)}</b><small>${esc(name)}</small></div>
        <div class="pick-where"></div><div class="pick-body"></div>
        <div class="sheet-actions"><button class="btn" data-act="new">${icon("folderPlus")}<span>${esc(t("files.newFolder"))}</span></button>
          <button class="btn" data-act="cancel">${esc(t("common.cancel"))}</button><button class="btn primary" data-act="ok">${esc(okLabel)}</button></div></div>`,
      () => resolve(chosen));
      const where = d.ov.querySelector(".pick-where"), list = d.ov.querySelector(".pick-body");
      const ok = d.ov.querySelector("[data-act='ok']"), made = d.ov.querySelector("[data-act='new']"), foot = d.ov.querySelector(".sheet-actions");
      const folders = () => (at ? at.entries.filter(x => x.dir) : []);
      function paint(busy = false, err = null) {
        const here = at?.path || "";
        where.innerHTML = `${at && at.parent !== null && !naming ? iconBtn("back", t("files.up"), 'data-act="up"') : ""}<span class="pick-path">${esc(here ? crumbs(here, at.sep).at(-1).name : t("files.drives"))}</span>`;
        ok.disabled = made.disabled = busy || !here;
        foot.hidden = naming;
        if (naming) {
          list.innerHTML = `<form class="pick-new"><input class="sheet-input" maxlength="255" autocomplete="off" aria-label="${esc(t("files.newFolderName"))}" placeholder="${esc(t("files.newFolderName"))}">
            <div class="sheet-actions"><button class="btn" type="button" data-act="unname">${esc(t("common.cancel"))}</button><button class="btn primary" type="submit">${esc(t("files.newFolder"))}</button></div></form>`;
          const field = list.querySelector("input");
          list.querySelector("form").onsubmit = async ev => {
            ev.preventDefault();
            const typed = field.value.trim();
            if (!typed) return;
            try {
              const r = await files.mkdir(at.path, at.sep, typed);
              if (d.closed) return;
              naming = false;
              go(r.path);
            } catch (err2) { ctx.fail(err2); }
          };
          field.focus();
        } else if (busy) list.innerHTML = `<p class="empty small"><i class="spinner accent"></i> ${esc(t("files.loading"))}</p>`;
        else if (err) list.innerHTML = `<p class="empty small">${esc(errorText(err))}</p>`;
        else list.innerHTML = `${folders().map((x, i) => `<button class="menu-item" data-i="${i}">${icon("folder")}<span class="menu-label">${esc(x.name)}</span></button>`).join("")}
          ${folders().length ? "" : `<p class="empty small">${esc(t(here ? "files.noFolders" : "files.pickDrive"))}</p>`}
          ${at?.next ? `<button class="more-row" data-act="more">${esc(t("files.more"))}</button>` : ""}`;
      }
      async function go(path) {
        const mine = ++my;
        paint(true);
        try {
          const f = await files.folder(path);
          if (mine !== my || d.closed) return;
          at = f;
          paint();
        } catch (err) { if (mine === my && !d.closed) paint(false, err); }
      }
      d.ov.addEventListener("click", async ev => {
        const b = ev.target.closest("button");
        if (!b || b.disabled) return;
        const act = b.dataset.act;
        if (b.dataset.i != null) go(entryPath(at, folders()[b.dataset.i]));
        else if (act === "up") go(at.parent);
        else if (act === "more") { b.disabled = true; try { await at.more(); paint(); } catch (err) { ctx.fail(err); b.disabled = false; } }
        else if (act === "cancel") d.close();
        else if (act === "ok") { chosen = at.path; d.close(); }
        else if (act === "new") { naming = true; paint(); }
        else if (act === "unname") { naming = false; paint(); }
      });
      // Escape while naming goes back to the folders (overlay() closes the dialog on the next one).
      d.ov.addEventListener("keydown", ev => { if (ev.key === "Escape" && naming) { ev.stopImmediatePropagation(); naming = false; paint(); } }, true);
      go(start);
    });
  }
  // ---------- touches ----------
  // A long press opens the sheet (and the tap that ends it opens nothing); so does a right click or the system's own
  // long press (contextmenu). A finger that moves is scrolling.
  let press = null, quietUntil = 0;
  const entryAt = b => folder?.entries[Number(b.dataset.i)];
  const unpress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  const longPress = b => { unpress(); quietUntil = Date.now() + 700; const e = entryAt(b); if (e) actions(e); };
  // The finger that held the row is still down when the sheet comes up under it: the click its lift makes lands on
  // what is there now - an item of the sheet, or its backdrop, which closes it. That one click is swallowed.
  function swallowLift() {
    let timer = setTimeout(done, 5000);
    function eat(e) { e.preventDefault(); e.stopPropagation(); done(); }
    function lifted() { clearTimeout(timer); timer = setTimeout(done, 350); }
    function done() {
      clearTimeout(timer);
      window.removeEventListener("click", eat, true);
      window.removeEventListener("pointerup", lifted, true);
      window.removeEventListener("pointercancel", lifted, true);
    }
    window.addEventListener("click", eat, true);
    window.addEventListener("pointerup", lifted, true);
    window.addEventListener("pointercancel", lifted, true);
  }
  body.addEventListener("pointerdown", e => {
    const b = e.target.closest(".frow-open");
    if (!b) return;
    unpress();
    press = { x: e.clientX, y: e.clientY, timer: setTimeout(() => { swallowLift(); longPress(b); }, LONG_MS) };
  });
  body.addEventListener("pointermove", e => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_PX) unpress(); });
  for (const ev of ["pointerup", "pointercancel", "scroll"]) body.addEventListener(ev, unpress, { passive: true });
  body.addEventListener("contextmenu", e => {
    const b = e.target.closest(".frow-open");
    if (!b) return;
    e.preventDefault();
    if (Date.now() >= quietUntil) longPress(b);
  });
  body.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.classList.contains("frow-open")) {
      if (Date.now() < quietUntil) return;
      const x = entryAt(b);
      if (x) tap(x);
    } else if (b.dataset.more != null) actions(folder.entries[Number(b.dataset.more)]);
    else if (b.dataset.act === "more") more(b);
    else if (b.dataset.act === "retry") load(p.path || HOME, { start: true });
    else if (b.dataset.act === "home") load(HOME);
  });
  nav.addEventListener("click", e => {
    const b = e.target.closest(".crumb");
    if (b && !b.hasAttribute("aria-current")) load(b.dataset.path);
  });

  // The computer away and back: said, and the folder read again.
  const offChange = store.on("change", () => {
    const up = online();
    if (up === wasOnline) return;
    wasOnline = up;
    if (up) reload(); else draw();
  });
  wasOnline = online();
  load(p.path || HOME, { start: true });

  return () => {
    left = true;
    clearTimeout(filterTimer);
    offChange();
    unpress();
    for (const close of [...overlays]) close();
    if (task) {
      if (task.keep) { task.detach.abort(); ctx.toast(t("files.goesOn", { name })); }
      else task.stop.abort();
    }
  };
}
