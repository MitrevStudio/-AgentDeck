// The computers (and relays): which are online, how they are reached or why not, Forget; a computer opens its own
// screen (node.js: its terminals); adding more (a code from AgentDeck, or a computer behind a relay with its own
// code); this phone's name and where its key is kept; the Demo's way out, and the connection check.
import { t, tn, ago, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, connNote, wireConn } from "./parts.js";

export function render(el, ctx) {
  const store = ctx.store;
  // Header tools: scan a code, add by hand (paste / address), the connection check.
  const tools = (store.demo ? "" : iconBtn("scan", t("computers.scan"), 'data-act="scan"') + iconBtn("plus", t("computers.add"), 'data-act="add"'))
    + iconBtn("pulse", t("computers.diag"), 'data-act="diag"');
  el.innerHTML = `${header(t("computers.title"), { actions: tools })}<main class="body computers"></main>`;
  const body = el.querySelector(".computers");
  let name = "";
  ctx.phoneName().then(n => { name = n; draw(); });

  // The mark beside the name: online, connecting (no error yet), offline.
  function mark(n) {
    const [cls, key] = n.online ? ["dot st-idle", "computers.online"] : !n.error ? ["spinner", "computers.connecting"] : ["dot st-stopped", "computers.offline"];
    return `<i class="mark ${cls}" role="img" aria-label="${esc(t(key))}" title="${esc(t(key))}"></i>`;
  }
  function how(n) {
    if (n.kind === "relay") return esc(t("computers.relayNote"));
    if (!n.online) return n.error ? `<span class="bad">${esc(errorText(n.error))}</span>` : esc(t("computers.lastSeen", { when: ago(n.lastSeen) }));
    return esc(n.via?.length ? t("computers.via", { via: n.via.map(store.nodeName).join(" → ") }) : t("computers.direct"));
  }

  function draw() {
    const nodes = store.nodes().sort((a, b) => Number(b.kind === "relay") - Number(a.kind === "relay") || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const conn = store.demo ? "" : connNote(store, { add: false });
    const note = store.demo ? `<div class="note">${icon("play")}<div class="note-text">${esc(t("computers.demo"))}</div></div>`
      : conn || (!nodes.some(n => n.online && n.kind !== "relay") && nodes.length ? `<div class="note warn">${icon("alert")}<div class="note-text">${esc(t("computers.notConnected"))}</div></div>` : "");
    // What runs there: sessions and terminals, on one line.
    const load = n => {
      const terms = n.online ? store.terminals({ node: n.id, running: true }).length : 0;
      return [n.online && n.running ? tn("computers.sessions", n.running) : "", terms ? tn("computers.terminals", terms) : ""].filter(Boolean).join(" · ");
    };
    // A computer's main part opens its screen; a relay's is only text.
    const main = n => {
      const inner = `<span class="row-title"><span class="name">${esc(n.name)}</span>${mark(n)}</span>
          <span class="row-sub">${esc(t(`computers.kind.${n.kind}`))}${n.version ? ` ${esc(n.version)}` : ""} · ${how(n)}</span>
          ${load(n) ? `<span class="row-sub">${esc(load(n))}</span>` : ""}`;
      return n.kind === "relay" ? `<div class="row-main">${inner}</div>` : `<button class="row-main node-open" data-open="${esc(n.id)}">${inner}</button>`;
    };
    body.innerHTML = `${note}
      <div class="cards">${nodes.map(n => `<div class="node-row${n.online ? "" : " off"}">
        <span class="node-ic">${icon(n.kind === "relay" ? "wifi" : n.kind === "headless" ? "server" : "computer")}</span>
        ${main(n)}
        <div class="row-tools">
          ${!store.demo && n.hub && n.online ? iconBtn("plus", t("computers.addBehind", { name: n.name }), `data-behind="${esc(n.id)}"`) : ""}
          ${iconBtn("trash", t("computers.forgetName", { name: n.name }), `data-forget="${esc(n.id)}"`, "danger")}
        </div>
      </div>`).join("")}</div>
      ${store.demo ? "" : `<h2 class="group">${esc(t("computers.phone"))}</h2>
      <div class="cards"><div class="node-row"><span class="node-ic">${icon("phone")}</span>
        <div class="row-main"><div class="row-title"><span class="name">${esc(name)}</span></div>
          <div class="row-sub">${esc(t("pair.nameHint"))}</div>
          <div class="row-sub${ctx.secure() ? "" : " bad"}">${esc(t(ctx.secure() ? "computers.secure" : "computers.insecure"))}</div></div>
        <div class="row-tools">${iconBtn("pencil", t("computers.rename"), 'data-act="rename"')}</div></div></div>`}
      <div class="foot-actions">
        ${store.demo ? `<button class="btn sm ghost" data-act="leave">${icon("power")}<span>${esc(t("computers.leaveDemo"))}</span></button>`
          : `<button class="btn sm ghost danger" data-act="unpair">${icon("power")}<span>${esc(t("computers.unpair"))}</span></button>`}
      </div>`;
    wireConn(body, store, ctx);
  }

  el.onclick = async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.open) ctx.go("node", { node: b.dataset.open });
    else if (b.dataset.forget) {
      const who = store.nodeName(b.dataset.forget);
      if (!await ctx.confirm(t("computers.forgetAsk", { name: who }), t("computers.forget"), { danger: true })) return;
      try { await store.forget(b.dataset.forget); ctx.toast(t("computers.forgotten", { name: who })); } catch (err) { ctx.fail(err); }
    } else if (b.dataset.behind) ctx.go("routes", { hub: b.dataset.behind });
    else if (b.dataset.act === "scan") ctx.go("scan");
    else if (b.dataset.act === "add") ctx.go("pair", { add: true });
    else if (b.dataset.act === "rename") {
      const next = await ctx.prompt(t("pair.name"), name, t("computers.rename"));
      if (!next || next === name) return;
      try { await ctx.rename(next); name = next; ctx.toast(t("computers.renamed", { name: next })); draw(); } catch (err) { ctx.fail(err); }
    } else if (b.dataset.act === "diag") ctx.go("diag");
    else if (b.dataset.act === "leave") ctx.leaveDemo();
    else if (b.dataset.act === "unpair") {
      if (await ctx.confirm(t("computers.unpairAsk"), t("computers.unpair"), { danger: true })) ctx.unpair();
    }
  };

  draw();
  const off = store.on("change", draw);
  return off;
}
