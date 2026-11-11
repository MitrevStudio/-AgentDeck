// The computers a paired relay (or a computer that relays) reaches: each paired here with its own code (pairVia) - an
// AgentDeck's six digits, a headless host's long code (the route says which kind it is).
// params: hub - the node they are behind; first - the first pairing (Done goes to the inbox).
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { cleanCode } from "../pairing.js";

export function render(el, ctx, p) {
  const store = ctx.store, link = store.provider;
  const hubName = () => store.nodeName(p.hub);
  el.innerHTML = `<div class="routes-head"></div><main class="body routes"></main>`;
  const head = el.querySelector(".routes-head"), body = el.querySelector(".routes");
  const drafts = new Map(); // id -> the code being typed (kept across redraws)
  const errors = new Map();
  const busy = new Set();

  function draw() {
    head.innerHTML = header(t("routes.title", { name: hubName() }), {
      back: true,
      actions: `<button class="btn sm primary" data-act="done">${esc(t("routes.done"))}</button>`
    });
    wireBack(head, ctx);
    head.querySelector("[data-act='done']").onclick = done;
    const hubOnline = store.nodes().some(n => n.id === p.hub && n.online);
    const list = (link.routes?.() || []).filter(r => r.via === p.hub || !p.hub);
    const focused = document.activeElement?.dataset?.code;
    // A computer not paired yet: its code and Pair at the row's end.
    body.innerHTML = `<p class="lead">${esc(t("routes.hint"))}</p>
      ${!hubOnline ? `<p class="empty">${esc(t("routes.waiting"))}</p>` : !list.length ? `<p class="empty">${esc(t("routes.none"))}</p>` : ""}
      <div class="cards">${list.map(r => `<div class="node-row">
        <span class="node-ic">${icon(r.kind === "host" ? "server" : "computer")}</span>
        <div class="row-main"><div class="row-title"><span class="name">${esc(r.name || r.id.slice(0, 8))}</span></div>
          ${r.paired ? `<div class="row-sub">${esc(t("routes.paired"))}</div>`
            : !r.web ? `<div class="row-sub">${esc(t("routes.outdated"))}</div>`
            : errors.get(r.id) ? `<div class="row-sub bad">${esc(errors.get(r.id))}</div>` : ""}
        </div>
        ${r.paired ? `<span class="end-ic ok">${icon("check")}</span>`
          : r.web ? `<form class="route-pair" data-id="${esc(r.id)}"><input data-code="${esc(r.id)}"${r.kind === "host" ? ' class="long"' : ""} inputmode="${r.kind === "host" ? "text" : "numeric"}" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="40" placeholder="${esc(t(r.kind === "host" ? "routes.codePhHost" : "routes.codePh"))}" aria-label="${esc(t("routes.codeFor", { name: r.name || r.id.slice(0, 8) }))}" value="${esc(drafts.get(r.id) || "")}">
            ${iconBtn("link", t("pair.pair"), `type="submit" ${busy.has(r.id) ? "disabled" : ""}`, "accent")}</form>` : ""}
      </div>`).join("")}</div>`;
    if (focused) body.querySelector(`[data-code="${CSS.escape(focused)}"]`)?.focus();
  }
  function done() {
    if (p.first) ctx.go("inbox", {}, { root: true });
    else ctx.back();
  }

  body.oninput = e => { if (e.target.dataset.code) drafts.set(e.target.dataset.code, e.target.value); };
  body.onsubmit = async e => {
    e.preventDefault();
    const id = e.target.dataset.id, code = cleanCode(drafts.get(id));
    if (!id || !code) return;
    busy.add(id);
    errors.delete(id);
    draw();
    try {
      const peer = await link.pairVia(id, code);
      drafts.delete(id);
      ctx.toast(t("routes.ok", { name: peer.name || id.slice(0, 8) }));
    } catch (err) {
      errors.set(id, errorText(err));
    }
    busy.delete(id);
    draw();
  };
  draw();
  const offs = [link.on("routes", draw), store.on("change", why => { if (why === "nodes") draw(); })];
  return () => { for (const off of offs) off(); };
}
