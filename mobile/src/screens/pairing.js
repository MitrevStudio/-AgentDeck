// Pairing with everything in one code (scanned or pasted): the relay, then each computer through it (or each
// directly when the code has no relay), with a row per node - pairing… / paired / already paired / not paired and why.
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon } from "../icons.js";
import { header, wireBack } from "./parts.js";

export function render(el, ctx, p) {
  el.innerHTML = `${header(t("pairing.title"), { back: true })}<main class="body pairing"></main>`;
  wireBack(el, ctx);
  const body = el.querySelector(".pairing");
  let gone = false;

  function draw(run) {
    if (gone) return;
    if (run.error) {
      body.innerHTML = `<div class="note warn">${icon("alert")}<div class="note-text">${esc(t("pair.notCode", { why: errorText(run.error) }))}</div></div>
        <div class="foot-actions"><button class="btn sm" data-act="again">${esc(t("pairing.again"))}</button></div>`;
      return;
    }
    const rows = run.rows || [];
    const ok = rows.filter(r => r.state === "paired" || r.state === "already").length;
    // Each row: what it is, then how it went in words; at the end the mark (spinner, check, alert).
    const word = r => r.state === "failed" ? `<span class="bad">${esc(t("pairing.failed", { reason: errorText(r.error) }))}</span>`
      : esc(t(r.state === "pending" ? "pairing.pending" : r.state === "already" ? "pairing.already" : "pairing.paired"));
    const mark = r => r.state === "pending" ? '<i class="mark spinner"></i>'
      : `<span class="end-ic ${r.state === "failed" ? "bad" : "ok"}">${icon(r.state === "failed" ? "alert" : "check")}</span>`;
    body.innerHTML = `<div class="cards">${rows.map(r => `<div class="node-row">
        <span class="node-ic">${icon(r.kind === "relay" ? "wifi" : r.kind === "host" ? "server" : "computer")}</span>
        <div class="row-main"><div class="row-title"><span class="name">${esc(r.name || r.id.slice(0, 8))}</span></div>
          <div class="row-sub">${esc(t(`pairing.kind.${r.kind}`))} · ${word(r)}</div></div>
        ${mark(r)}
      </div>`).join("")}</div>
      ${run.done ? `<p class="summary">${esc(ok ? t("pairing.done", { ok, all: rows.length }) : t("pairing.none"))}</p>
        <div class="foot-actions">
        ${ok < rows.length ? `<button class="btn sm" data-act="again">${esc(t("pairing.again"))}</button>` : ""}
        ${ok ? `<button class="btn sm primary" data-act="continue">${esc(t("pairing.continue"))}</button>` : ""}</div>` : ""}`;
  }

  body.onclick = e => {
    const b = e.target.closest("button");
    if (b?.dataset.act === "continue") ctx.go("inbox", {}, { root: true });
    else if (b?.dataset.act === "again") ctx.back();
  };

  // One run per screen entry (kept on the params, so a redraw does not pair again).
  if (!p.run) {
    const run = p.run = { rows: null, done: false, error: null, listeners: new Set() };
    const update = () => { for (const fn of run.listeners) fn(run); };
    (async () => {
      try {
        const link = await ctx.relay();
        link.decode(p.text); // a bad code is said at once, before anything is dialled
        await link.pairAll(p.text, rows => { run.rows = rows; update(); });
      } catch (err) {
        run.error = err;
      }
      run.done = true;
      update();
    })();
  }
  p.run.listeners.add(draw);
  draw(p.run);
  return () => { gone = true; p.run.listeners.delete(draw); };
}
