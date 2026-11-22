// The computers (and relays): which are online, how they are reached or why not; a computer's row opens its own
// screen (node.js: its projects, sessions and terminals, and Forget); a relay's row has the way to the computers
// behind it and Forget. In the header: scan a code, add by hand, ask everything again. Under the list this phone:
// its name, where its key is kept, the app's version; then the connection check and Unpair.
import { t, tn, ago, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, connNote, wireConn } from "./parts.js";

export function render(el, ctx) {
  const store = ctx.store;
  const tools = iconBtn("scan", t("computers.scan"), 'data-act="scan"') + iconBtn("plus", t("computers.add"), 'data-act="add"')
    + iconBtn("refresh", t("computers.refresh"), 'data-act="refresh"');
  el.innerHTML = `${header(t("computers.title"), { actions: tools })}<main class="body computers"></main>`;
  const body = el.querySelector(".computers");
  let name = "";
  ctx.phoneName().then(n => { name = n; draw(); });

  // The mark beside the name: online, connecting (no error yet), offline.
  function mark(n) {
    const [cls, key] = n.online ? ["dot st-idle", "computers.online"] : !n.error ? ["spinner", "computers.connecting"] : ["dot st-stopped", "computers.offline"];
    return `<i class="mark ${cls}" role="img" aria-label="${esc(t(key))}" title="${esc(t(key))}"></i>`;
  }
  // How it is reached; away: why (unless the note above says it for all of them - the relay is not there) and when
  // it was seen last.
  function how(n, relayAway) {
    if (n.kind === "relay") return esc(t("computers.relayNote"));
    if (n.online) return esc(n.via?.length ? t("computers.via", { via: n.via.map(store.nodeName).join(" → ") }) : t("computers.direct"));
    const seen = n.lastSeen ? esc(t("computers.lastSeen", { when: ago(n.lastSeen) })) : "";
    const why = n.error && !(relayAway && !store.lost(n.id)) ? `<span class="bad">${esc(errorText(n.error))}</span>` : "";
    return [why, seen].filter(Boolean).join(" · ") || esc(t("computers.offline"));
  }

  function draw() {
    const nodes = store.nodes().sort((a, b) => Number(b.kind === "relay") - Number(a.kind === "relay") || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    const conn = connNote(store, { add: false });
    const relayAway = ["down", "connecting"].includes(store.connection().state);
    const note = conn || (!nodes.some(n => n.online && n.kind !== "relay") && nodes.length ? `<div class="note warn">${icon("alert")}<div class="note-text">${esc(t("computers.notConnected"))}</div></div>` : "");
    // What runs there: sessions and terminals, on one line.
    const load = n => {
      const terms = n.online ? store.terminals({ node: n.id, running: true }).length : 0;
      return [n.online && n.running ? tn("computers.sessions", n.running) : "", terms ? tn("computers.terminals", terms) : ""].filter(Boolean).join(" · ");
    };
    // An AgentDeck there that lacks something the app asks for, or that says it is behind this app (a relay too:
    // provider-relay.js `outdated`, protocol.js LEVEL) - it works, but not with everything.
    const outdated = n => n.online && (n.outdated || (n.kind !== "relay" && store.node(n.id)?.missing.size > 0));
    // A computer's row opens its screen; a relay's is only text, with its tools at the end.
    const row = n => {
      const inner = `<span class="row-title"><span class="name">${esc(n.name)}</span>${mark(n)}${outdated(n) ? `<span class="tag">${esc(t("computers.outdated"))}</span>` : ""}</span>
          <span class="row-sub">${esc(t(`computers.kind.${n.kind}`))}${n.version ? ` ${esc(n.version)}` : ""} · ${how(n, relayAway)}</span>
          ${load(n) ? `<span class="row-sub">${esc(load(n))}</span>` : ""}`;
      const lead = `<span class="node-ic">${icon(n.kind === "relay" ? "wifi" : n.kind === "headless" ? "server" : "computer")}</span>`;
      if (n.kind !== "relay") return `<button class="node-row node-open${n.online ? "" : " off"}" data-open="${esc(n.id)}">${lead}<span class="row-main">${inner}</span><span class="end-ic go">${icon("right")}</span></button>`;
      return `<div class="node-row${n.online ? "" : " off"}">${lead}<div class="row-main">${inner}</div>
        <div class="row-tools">
          ${n.hub && n.online ? iconBtn("link", t("computers.addBehind", { name: n.name }), `data-behind="${esc(n.id)}"`) : ""}
          ${iconBtn("trash", t("computers.forgetName", { name: n.name }), `data-forget="${esc(n.id)}"`, "danger")}
        </div></div>`;
    };
    body.innerHTML = `${note}
      <div class="cards">${nodes.map(row).join("")}</div>
      <h2 class="group">${esc(t("computers.phone"))}</h2>
      <div class="cards"><div class="node-row"><span class="node-ic">${icon("phone")}</span>
        <div class="row-main"><div class="row-title"><span class="name">${esc(name)}</span></div>
          <div class="row-sub">${esc(t("pair.nameHint"))}</div>
          <div class="row-sub${ctx.secure() ? "" : " bad"}">${esc(t(ctx.secure() ? "computers.secure" : "computers.insecure"))}</div>
          <div class="row-sub">${esc(t("computers.version", { version: ctx.version }))}</div></div>
        <div class="row-tools">${iconBtn("pencil", t("computers.rename"), 'data-act="rename"')}</div></div></div>
      <div class="foot-actions">
        <button class="btn sm ghost" data-act="diag">${icon("pulse")}<span>${esc(t("computers.diag"))}</span></button>
        <button class="btn sm ghost danger" data-act="unpair">${icon("power")}<span>${esc(t("computers.unpair"))}</span></button>
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
    else if (b.dataset.act === "refresh") {
      // What is not linked is dialled now, and every computer that is linked is asked for its lists again.
      store.wake();
      for (const n of store.computers()) if (n.online) store.refresh(n.id);
      ctx.toast(t("computers.refreshed"));
    } else if (b.dataset.act === "rename") {
      const next = await ctx.prompt(t("pair.name"), name, t("computers.rename"));
      if (!next || next === name) return;
      try { await ctx.rename(next); name = next; ctx.toast(t("computers.renamed", { name: next })); draw(); } catch (err) { ctx.fail(err); }
    } else if (b.dataset.act === "diag") ctx.go("diag");
    else if (b.dataset.act === "unpair") {
      if (await ctx.confirm(t("computers.unpairAsk"), t("computers.unpair"), { danger: true })) ctx.unpair();
    }
  };

  draw();
  const off = store.on("change", draw);
  return off;
}
