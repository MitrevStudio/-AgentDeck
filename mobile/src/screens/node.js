// One computer, as the desktop's sidebar shows it: how it is reached (or why not), its projects - each a heading
// that folds its sessions open and shut, those that need the user or run first, with "New session here" and
// "Terminal here" at its end - the sessions in folders that are no project, and every terminal running there (its
// own: a shell pane on its desktop, an agent's terminal; those this phone opened; those other devices opened), each
// to open or close. In the header: a new terminal in its home folder, its files (from its home), and Forget.
// params: node.
import { t, tn, errorText } from "../i18n.js";
import { esc, baseName, normPath } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack, sessionRow, terminalRow, projectMark, connNote, wireConn, wireTerminals, openSession } from "./parts.js";

// Kept while the app runs: which projects the user folded open or shut (`${node}:${path}` -> bool; one never
// touched is open while something runs in it), and those whose stopped sessions are all shown.
const folded = new Map();
const whole = new Set();
const STOPPED_SHOWN = 4;
const OTHER = ""; // the "path" of the sessions in folders that are no project
const RANK = { waiting: 0, busy: 1, idle: 2, other: 2 };

export function render(el, ctx, p) {
  const store = ctx.store;
  el.innerHTML = `<div class="node-head"></div><main class="body node"></main>`;
  const head = el.querySelector(".node-head"), body = el.querySelector(".node");
  const nodeOf = () => store.nodes().find(n => n.id === p.node) || null;

  function how(n) {
    if (!n.online) return n.error ? errorText(n.error) : t("computers.offline");
    return n.via?.length ? t("computers.via", { via: n.via.map(store.nodeName).join(" → ") }) : t("computers.direct");
  }

  // One project: its heading (the fold, the mark and name, what goes on in it, its two tools) and, open, its
  // sessions - the running ones whole, of the stopped ones the newest few until "Show all".
  function projectBlock(name, path, sessions) {
    const key = `${p.node}:${path}`;
    const active = sessions.filter(x => RANK[x.status] != null).sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt);
    const stopped = sessions.filter(x => RANK[x.status] == null);
    const waiting = active.filter(x => x.status === "waiting").length;
    const open = folded.has(key) ? folded.get(key) : active.length > 0;
    const shown = whole.has(key) ? stopped : stopped.slice(0, STOPPED_SHOWN);
    const count = waiting ? `<span class="count waiting" title="${esc(tn("node.waiting", waiting))}">${waiting}</span>`
      : active.length ? `<span class="count running" title="${esc(tn("node.running", active.length))}">${active.length}</span>`
        : sessions.length ? `<span class="count">${sessions.length}</span>` : "";
    return `<div class="proj-block">
      <div class="proj-head">
        <button class="proj-open" data-fold="${esc(path)}" aria-expanded="${open}">${icon("chevDown", "fold-ic")}${projectMark(name)}
          <span class="pick-main"><b>${esc(name)}</b>${path ? `<small class="path"><bdi>${esc(path)}</bdi></small>` : ""}</span>${count}</button>
        ${path ? iconBtn("plus", t("node.newIn", { name }), `data-new="${esc(path)}"`) + iconBtn("termPlus", t("node.shellIn", { name }), `data-shell="${esc(path)}"`) : ""}
      </div>
      ${open ? `<div class="rows proj-rows">${[...active, ...shown].map(x => sessionRow(x, { showNode: false, showProject: !path })).join("")}
        ${sessions.length ? "" : `<p class="empty small">${esc(t("node.noSessions"))}</p>`}
        ${shown.length < stopped.length ? `<button class="more-row" data-more="${esc(path)}">${esc(t("node.showAll", { n: sessions.length }))}</button>` : ""}</div>` : ""}
    </div>`;
  }

  let left = false;
  function draw() {
    if (left) return;
    const n = nodeOf();
    // Forgotten meanwhile (here, or by the computer itself).
    if (!n) { left = true; ctx.back(); return; }
    const home = store.node(p.node)?.info?.home;
    head.innerHTML = header(n.name, {
      back: true,
      sub: esc(`${t(`computers.kind.${n.kind}`)}${n.version ? ` ${n.version}` : ""} · ${how(n)}`),
      actions: (n.online && home ? iconBtn("termPlus", t("node.newShell"), 'data-act="shell"') : "")
        + (n.online ? iconBtn("folder", t("files.title"), 'data-act="files"') : "")
        + iconBtn("trash", t("computers.forgetName", { name: n.name }), 'data-act="forget"', "danger")
    });
    wireBack(head, ctx);
    const loaded = store.node(p.node)?.loaded;
    const terms = n.online ? store.terminals({ node: p.node }) : [];
    const projects = n.online ? store.projects(p.node) : [];
    const paths = new Set(projects.map(x => normPath(x.path)));
    const other = n.online ? store.sessions(p.node).filter(x => !paths.has(normPath(x.cwd))).sort((a, b) => b.updatedAt - a.updatedAt) : [];
    body.innerHTML = `${connNote(store)}
      ${!n.online ? `<div class="note${store.lost(p.node) ? " down" : ""}">${icon("computer")}<div class="note-text">${esc(store.lost(p.node) ? errorText(n.error) : t("node.offline", { name: n.name }))}</div></div>` : ""}
      ${n.online && !loaded ? `<p class="empty">${esc(t("session.loading"))}</p>` : ""}
      ${n.online && loaded ? `<h2 class="group">${esc(t("node.projects"))}<span class="count">${projects.length}</span></h2>
        ${projects.map(x => projectBlock(x.name || baseName(x.path), x.path, x.sessions)).join("")}
        ${other.length ? projectBlock(t("node.otherFolders"), OTHER, other) : ""}
        ${projects.length || other.length ? "" : `<p class="empty small">${esc(t("node.noProjects", { name: n.name }))}</p>`}
        <h2 class="group">${esc(t("terms.title"))}<span class="count">${terms.length}</span></h2>
        ${terms.length ? `<div class="rows">${terms.map(x => terminalRow(x, { showNode: false })).join("")}</div>`
          : `<p class="empty small">${esc(t("terms.none", { name: n.name }))}</p>`}` : ""}`;
    wireConn(body, store, ctx);
  }

  async function shell(cwd, title) {
    try {
      const tab = await store.launch(p.node, { cwd, kind: "shell" });
      if (tab?.id) ctx.go("terminal", { node: p.node, term: tab.id, title: tab.title || title });
    } catch (err) { ctx.fail(err); }
  }

  head.onclick = async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const n = nodeOf();
    if (b.dataset.act === "shell") shell(store.node(p.node)?.info?.home, n?.name);
    else if (b.dataset.act === "files") ctx.go("files", { node: p.node, path: "~" });
    else if (b.dataset.act === "forget" && n) {
      if (!await ctx.confirm(t("computers.forgetAsk", { name: n.name }), t("computers.forget"), { danger: true })) return;
      try { await store.forget(p.node); ctx.toast(t("computers.forgotten", { name: n.name })); } catch (err) { ctx.fail(err); }
    }
  };
  body.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.fold != null) {
      const key = `${p.node}:${d.fold}`;
      folded.set(key, b.getAttribute("aria-expanded") !== "true");
      draw();
    } else if (d.more != null) {
      whole.add(`${p.node}:${d.more}`);
      draw();
    } else if (d.new) ctx.go("new", { node: p.node, project: d.new });
    else if (d.shell) shell(d.shell, baseName(d.shell));
    else if (b.classList.contains("row")) openSession(ctx, d.node, d.agent, d.id);
  });
  wireTerminals(body, ctx);
  draw();
  return store.on("change", draw);
}
