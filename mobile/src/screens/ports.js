// "Ports", from a terminal's "More" (docs/PORT-FORWARDING.md 4): a sheet with what listens on the terminal's computer
// - the terminal's own ports first, then the rest, each "port · process" - the ports typed by hand for its folder,
// and "Other port…". A tap on a port forwards it and opens the page in the app's own view over the app (forward.js
// show: http://127.0.0.1:<the port here>); the button at a row's end has the rest: open as https, copy the address,
// stop forwarding, forget. The sheet says "Loading…" at once - reading the ports there takes a moment - and gets its
// rows when the answer comes. A port nothing answers on, a computer that is away or too old: said in words, in a row
// or a toast, never a blank page.
//
// One sheet with three faces (the list, one port's actions, the field for a number) rather than sheets over one
// another: the phone's Back and a tap beside it close it as they close every sheet (main.js).
// The rows and the list are ports.js's (no DOM there); nothing here is asked on a timer.
import { t } from "../i18n.js";
import { esc } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { copyText } from "../phone.js";
import { loadPorts, portRows, portError, portsKey, savedPorts, rememberPort, forgetPort, readPort } from "../ports.js";

// openPorts(ctx, { node, term, cwd }): node, term - the terminal and its computer; cwd - its folder there ("" when
// not known: the ports typed by hand are then the computer's).
export function openPorts(ctx, { node, term, cwd = "" }) {
  const { store, forwards } = ctx;
  if (!forwards?.available || document.querySelector(".sheet.ports")) return;
  const name = store.nodeName(node), key = portsKey(node, cwd);
  const el = document.createElement("div");
  el.className = "sheet-backdrop";
  el.innerHTML = `<div class="sheet menu ports" role="dialog" aria-modal="true" aria-label="${esc(`${t("ports.title")} · ${name}`)}">
    <div class="ports-head">${icon("globe")}<b>${esc(t("ports.title"))}</b><small>${esc(name)}</small></div>
    <div class="ports-body"></div><p class="fine ports-fine">${esc(t("ports.foreground"))}</p></div>`;
  const body = el.querySelector(".ports-body");
  let data = null;             // loadPorts' answer; null while it is on its way
  let face = { kind: "list" }; // | { kind: "port", port } | { kind: "ask" }
  let busy = 0;                // the port being forwarded and opened now
  let closed = false;

  const rowOf = port => portRows(data).find(r => r.kind === "port" && r.port === port) || null;
  const item = (act, ic, label, cls = "") => `<button class="menu-item${cls ? ` ${cls}` : ""}" data-act="${act}">${icon(ic)}<span class="menu-label">${esc(label)}</span></button>`;
  const noteRow = (text, mark) => `<div class="menu-item port-note" role="status">${mark}<span class="menu-label">${esc(text)}</span></div>`;
  function listHtml() {
    if (!data) return noteRow(t("ports.loading"), '<i class="spinner accent"></i>');
    return portRows(data).map(r => {
      if (r.kind === "note") return noteRow(r.text, icon("alert"));
      if (r.kind === "group") return `<div class="group">${esc(r.text)}</div>`;
      if (r.kind === "other") return item("other", "plus", t("ports.other"));
      const label = [r.title, r.meta].filter(Boolean).join(" · ");
      return `<div class="port-row${r.active ? " on" : ""}">
        <button class="menu-item port-open" data-port="${r.port}" aria-label="${esc(label)}"${busy ? " disabled" : ""}>${busy === r.port ? '<i class="spinner accent"></i>' : icon("globe")}
          <span class="row-main"><span class="row-title">${esc(r.title)}</span>${r.meta ? `<span class="row-meta">${esc(r.meta)}</span>` : ""}</span></button>
        ${iconBtn("more", t("ports.more", { port: r.port }), `data-more="${r.port}"${busy ? " disabled" : ""}`)}</div>`;
    }).join("");
  }
  function portHtml(r) {
    return `<div class="ports-sub">${iconBtn("back", t("common.back"), 'data-act="list"')}<b>${esc([r.title, r.process].filter(Boolean).join(" · "))}</b></div>
      ${item("open", "globe", t("ports.open"))}${item("https", "lock", t("ports.openHttps"))}${item("copy", "copy", t("ports.copy"))}
      ${r.active ? item("stop", "stop", t("ports.stop"), "danger") : ""}${r.saved ? item("forget", "trash", t("ports.forget")) : ""}`;
  }
  const askHtml = () => `<form class="ports-ask"><div class="ports-sub">${iconBtn("back", t("common.back"), 'type="button" data-act="list"')}<b>${esc(t("ports.askTitle"))}</b></div>
    <p>${esc(t("ports.askBody", { name }))}</p>
    <input class="sheet-input" inputmode="numeric" pattern="[0-9]*" maxlength="5" autocomplete="off" spellcheck="false" placeholder="3000" aria-label="${esc(t("ports.askTitle"))}">
    <div class="sheet-actions"><button class="btn" type="button" data-act="list">${esc(t("common.cancel"))}</button>
    <button class="btn primary" type="submit" disabled>${esc(t("ports.open"))}</button></div></form>`;
  function draw() {
    if (closed) return;
    const r = face.kind === "port" ? rowOf(face.port) : null;
    if (face.kind === "port" && !r) face = { kind: "list" };
    body.innerHTML = face.kind === "port" ? portHtml(r) : face.kind === "ask" ? askHtml() : listHtml();
    if (face.kind === "ask") {
      const field = body.querySelector("input"), ok = body.querySelector("[type='submit']");
      field.oninput = () => { ok.disabled = !readPort(field.value); };
      body.querySelector("form").onsubmit = e => { e.preventDefault(); const port = readPort(field.value); if (port) openPort(port, { remember: true }); };
      field.focus();
    } else body.querySelector("button:not(:disabled)")?.focus();
  }
  const show = next => { face = next; draw(); };
  function close() {
    if (closed) return;
    closed = true;
    offChange();
    el.remove();
  }
  // The forwards of this computer as they are now, in the rows (one was made, stopped, or went with the link).
  const refresh = () => { if (data) { data.forwards = forwards.list().filter(f => f.node === node); data.saved = savedPorts(key); } };
  const offChange = forwards.on("change", () => { refresh(); if (face.kind !== "ask") draw(); });

  // Forwards the port and opens its page; the sheet goes once the page is up. remember: typed by hand - kept for the
  // folder once it opened.
  async function openPort(port, { https = false, remember = false } = {}) {
    if (busy) return;
    busy = port;
    show({ kind: "list" });
    try {
      await forwards.show(node, port, { https, title: `${port} · ${name}` });
      if (remember) rememberPort(key, port);
      close();
    } catch (e) {
      ctx.toast(portError(e, { port, name }), 5000);
    } finally {
      busy = 0;
      refresh();
      draw();
    }
  }
  async function copyAddress(port) {
    try {
      const { url } = await forwards.address(node, port);
      try {
        await copyText(url);
        ctx.toast(t("ports.copied", { address: url }));
      } catch {
        await ctx.prompt(t("term.copyByHand"), url, t("common.done"));
      }
    } catch (e) {
      ctx.toast(portError(e, { port, name }), 5000);
    }
  }
  el.addEventListener("click", async e => {
    if (e.target === el) return close();
    const more = e.target.closest("[data-more]"), open = e.target.closest("[data-port]"), act = e.target.closest("[data-act]")?.dataset.act;
    if (more) return show({ kind: "port", port: Number(more.dataset.more) });
    if (open) return openPort(Number(open.dataset.port));
    if (act === "list") return show({ kind: "list" });
    if (act === "other") return show({ kind: "ask" });
    if (face.kind !== "port" || !act) return;
    const port = face.port;
    if (act === "open") openPort(port);
    else if (act === "https") openPort(port, { https: true });
    else if (act === "copy") { show({ kind: "list" }); copyAddress(port); }
    else if (act === "stop") {
      await forwards.close(node, port);
      ctx.toast(t("ports.stopped", { port }));
      refresh();
      show({ kind: "list" });
    } else if (act === "forget") {
      forgetPort(key, port);
      refresh();
      show({ kind: "list" });
    }
  });
  // Escape goes a face back, then closes; Tab stays in the sheet.
  el.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); return face.kind === "list" ? close() : show({ kind: "list" }); }
    if (e.key !== "Tab") return;
    const stops = [...el.querySelectorAll("button, input")].filter(x => !x.disabled);
    const first = stops[0], last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  document.body.append(el);
  draw();
  loadPorts({ store, forwards, node, term, cwd })
    .catch(e => ({ node, name, ports: [], forwards: [], saved: savedPorts(key), error: "failed", message: e?.message || "" }))
    .then(d => { data = d; refresh(); draw(); });
}
