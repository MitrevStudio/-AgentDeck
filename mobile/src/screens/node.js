// One computer: how it is reached (or why not) and every terminal running there - its own (a shell pane on its
// desktop, an agent's terminal), those this phone opened, those other devices opened - each to open or close; a new
// terminal in its home folder, and Forget. params: node.
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack, terminalRow, connNote, wireConn, wireTerminals } from "./parts.js";

export function render(el, ctx, p) {
  const store = ctx.store;
  el.innerHTML = `<div class="node-head"></div><main class="body node"></main>`;
  const head = el.querySelector(".node-head"), body = el.querySelector(".node");
  const nodeOf = () => store.nodes().find(n => n.id === p.node) || null;

  function how(n) {
    if (!n.online) return n.error ? errorText(n.error) : t("computers.offline");
    return n.via?.length ? t("computers.via", { via: n.via.map(store.nodeName).join(" → ") }) : t("computers.direct");
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
      actions: (n.online && home ? iconBtn("plus", t("node.newShell"), 'data-act="shell"') : "")
        + iconBtn("trash", t("computers.forgetName", { name: n.name }), 'data-act="forget"', "danger")
    });
    wireBack(head, ctx);
    const terms = n.online ? store.terminals({ node: p.node }) : [];
    body.innerHTML = `${connNote(store)}
      ${!n.online ? `<div class="note${store.lost(p.node) ? " down" : ""}">${icon("computer")}<div class="note-text">${esc(store.lost(p.node) ? errorText(n.error) : t("node.offline", { name: n.name }))}</div></div>` : ""}
      ${n.online ? `<h2 class="group">${esc(t("terms.title"))}<span class="count">${terms.length}</span></h2>
        ${terms.length ? `<div class="rows">${terms.map(x => terminalRow(x, { showNode: false })).join("")}</div>`
          : `<p class="empty">${esc(store.node(p.node)?.loaded ? t("terms.none", { name: n.name }) : t("session.loading"))}</p>`}` : ""}`;
    wireConn(body, store, ctx);
  }

  head.onclick = async e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const n = nodeOf();
    if (b.dataset.act === "shell") {
      try {
        const tab = await store.launch(p.node, { cwd: store.node(p.node)?.info?.home, kind: "shell" });
        if (tab?.id) ctx.go("terminal", { node: p.node, term: tab.id, title: tab.title || n?.name });
      } catch (err) { ctx.fail(err); }
    } else if (b.dataset.act === "forget" && n) {
      if (!await ctx.confirm(t("computers.forgetAsk", { name: n.name }), t("computers.forget"), { danger: true })) return;
      try { await store.forget(p.node); ctx.toast(t("computers.forgotten", { name: n.name })); } catch (err) { ctx.fail(err); }
    }
  };
  wireTerminals(body, ctx);
  draw();
  return store.on("change", draw);
}
