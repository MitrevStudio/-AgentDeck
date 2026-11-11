// Pairing: scan the code from AgentDeck, or paste its text; or by hand - the address of a relay (or of a computer on
// the same network) and its code, then the computers behind it, each with its own code (routes.js). First run and
// "Add computers" (params.add: from the Computers screen, with a way back).
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { parseAddress, cleanCode, looksLikePayload } from "../pairing.js";

export function render(el, ctx, params) {
  const add = Boolean(params.add);
  el.innerHTML = `${add ? header(t("pair.addTitle"), { back: true }) : ""}<main class="body pair">
    ${add ? "" : `<div class="hero">
      <img src="icon.svg" alt="" class="logo">
      <h1 data-i18n="app.name"></h1>
      <p class="muted" data-i18n="pair.tagline"></p>
    </div>`}
    <button class="btn primary big" data-act="scan">${icon("scan")}<span data-i18n="pair.scan"></span></button>
    <p class="hint" data-i18n="pair.scanHint"></p>
    <h2 class="group" data-i18n="pair.or"></h2>
    <form class="card form" data-form="paste" novalidate>
      <label><span data-i18n="pair.paste"></span>
        <textarea name="text" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" data-i18n-placeholder="pair.pastePh"></textarea></label>
      <div class="form-foot"><button class="btn sm primary" type="submit" data-i18n="pair.pair"></button></div>
    </form>
    <form class="card form" data-form="manual" novalidate>
      <p class="form-title" data-i18n="pair.manual"></p>
      <label><span data-i18n="pair.relay"></span>
        <input name="relay" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" data-i18n-placeholder="pair.relayPh"></label>
      <label><span data-i18n="pair.code"></span>
        <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" data-i18n-placeholder="pair.codePh"></label>
      <p class="form-state" hidden></p>
      <div class="form-foot"><button class="btn sm" type="submit" data-i18n="pair.connect"></button></div>
    </form>
    <button class="link" data-act="diag">${icon("pulse")}<span data-i18n="pair.diag"></span></button>
  </main>`;
  if (add) wireBack(el, ctx);

  el.querySelector("[data-act='scan']").onclick = () => ctx.go("scan");
  el.querySelector("[data-act='diag']").onclick = () => ctx.go("diag");

  el.querySelector("[data-form='paste']").onsubmit = e => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    if (!looksLikePayload(text)) return ctx.toast(t("pair.notCode", { why: "AGENTDECK-PAIR:…" }));
    ctx.go("pairing", { text });
  };

  const manual = el.querySelector("[data-form='manual']");
  const state = manual.querySelector(".form-state");
  manual.onsubmit = async e => {
    e.preventDefault();
    const where = parseAddress(manual.relay.value), code = cleanCode(manual.code.value);
    if (!where) return ctx.toast(t(manual.relay.value.trim() ? "pair.badAddress" : "pair.badInput"));
    if (!code) return ctx.toast(t("pair.badInput"));
    const button = manual.querySelector("button");
    button.disabled = true;
    state.hidden = false;
    state.textContent = t("pair.connecting", { addr: `${where.address}:${where.port}` });
    try {
      const link = await ctx.relay();
      const peer = await link.pairDirect(where.address, where.port, code);
      ctx.toast(t("routes.ok", { name: peer.name || where.address }));
      // A relay: on to the computers behind it. A computer paired directly may relay to others too.
      ctx.go("routes", { hub: peer.id, first: !add }, { replace: true });
    } catch (err) {
      state.textContent = errorText(err);
      button.disabled = false;
    }
  };
}
