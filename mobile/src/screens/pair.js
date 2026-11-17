// Pairing: scan the code from AgentDeck; or by hand, each way a card that opens when chosen - paste the code's
// text, or connect to a relay (or a computer on the same network) by its address and code, then the computers behind
// it, each with its own code (routes.js). First run and "Add computers" (params.add: from the Computers screen, with
// a way back).
import { t, errorText } from "../i18n.js";
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
    <details class="card fold relay" name="pair-way">
      <summary>${icon("wifi")}<span class="fold-title"><b data-i18n="pair.manual"></b><small data-i18n="pair.manualHint"></small></span>${icon("chevDown", "fold-ic")}</summary>
      <form class="form" data-form="manual" novalidate>
        <label><span data-i18n="pair.relay"></span>
          <input name="relay" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" data-i18n-placeholder="pair.relayPh"></label>
        <label><span data-i18n="pair.code"></span>
          <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" data-i18n-placeholder="pair.codePh">
          <span class="field-hint" data-i18n="pair.codeHint"></span></label>
        <p class="form-state" role="status" hidden></p>
        <div class="form-foot"><button class="btn sm primary" type="submit" data-i18n="pair.connect"></button></div>
      </form>
    </details>
    <details class="card fold paste" name="pair-way">
      <summary>${icon("paste")}<span class="fold-title"><b data-i18n="pair.paste"></b></span>${icon("chevDown", "fold-ic")}</summary>
      <form class="form" data-form="paste" novalidate>
        <textarea name="text" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" data-i18n-placeholder="pair.pastePh" data-i18n-aria-label="pair.paste"></textarea>
        <div class="form-foot"><button class="btn sm primary" type="submit" data-i18n="pair.pair"></button></div>
      </form>
    </details>
    <button class="link" data-act="diag">${icon("pulse")}<span data-i18n="pair.diag"></span></button>
  </main>`;
  if (add) wireBack(el, ctx);

  el.querySelector("[data-act='scan']").onclick = () => ctx.go("scan", { from: "pair" });
  el.querySelector("[data-act='diag']").onclick = () => ctx.go("diag");
  // A card that opens shuts the other (also where <details name> does not do it yet) and takes the first field.
  const folds = [...el.querySelectorAll("details.fold")];
  for (const d of folds) {
    d.addEventListener("toggle", () => {
      if (!d.open) return;
      for (const other of folds) if (other !== d) other.open = false;
      d.querySelector("input, textarea")?.focus({ preventScroll: true });
      d.scrollIntoView({ block: "nearest" });
    });
  }

  el.querySelector("[data-form='paste']").onsubmit = e => {
    e.preventDefault();
    const text = e.target.text.value.trim();
    if (!text) return;
    if (!looksLikePayload(text)) return ctx.toast(t("pair.badCode"));
    ctx.go("pairing", { text });
  };

  const manual = el.querySelector("[data-form='manual']");
  const state = manual.querySelector(".form-state");
  // What the form says under its fields: what is missing, the progress, or why it failed (in the error's colour).
  const say = (text, bad = false) => { state.hidden = !text; state.textContent = text; state.classList.toggle("bad", bad); };
  manual.onsubmit = async e => {
    e.preventDefault();
    const where = parseAddress(manual.relay.value), code = cleanCode(manual.code.value);
    if (!where) return say(t(manual.relay.value.trim() ? "pair.badAddress" : "pair.badInput"), true);
    if (!code) return say(t("pair.badInput"), true);
    const button = manual.querySelector("button");
    button.disabled = true;
    say(t("pair.connecting", { addr: `${where.address}:${where.port}` }));
    try {
      const link = await ctx.relay();
      const peer = await link.pairDirect(where.address, where.port, code);
      ctx.toast(t("routes.ok", { name: peer.name || where.address }));
      // A relay: on to the computers behind it. A computer paired directly may relay to others too.
      ctx.go("routes", { hub: peer.id, first: !add }, { replace: true });
    } catch (err) {
      say(errorText(err), true);
      button.disabled = false;
    }
  };
}
