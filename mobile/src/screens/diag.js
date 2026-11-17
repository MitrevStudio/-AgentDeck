// The connection check: a plain WebSocket from the app to ws://host:port and what came of it - to prove on a real
// device that the WebView lets an https app page open ws:// to an IP (mixed content, cleartext; MOBILE.md §3.4).
import { t, formatTime } from "../i18n.js";
import { esc } from "../util.js";
import { header, wireBack } from "./parts.js";

const LAST_KEY = "agentdeck.diag.url";
const TIMEOUT_MS = 8000;

export function render(el, ctx) {
  // The address tried last, else the relay the phone dials (a computer's own address when there is no relay).
  let last = "";
  try { last = localStorage.getItem(LAST_KEY) || ""; } catch {}
  if (!last) {
    const hub = ctx.store?.nodes().find(n => n.hub && n.address);
    if (hub) last = `ws://${hub.address}:${hub.port}`;
  }
  el.innerHTML = `${header(t("diag.title"), { back: true })}
    <main class="body diag">
      <p class="lead" data-i18n="diag.hint"></p>
      <form class="card form" novalidate>
        <label><span data-i18n="diag.addr"></span>
          <span class="inline-field"><input name="url" value="${esc(last)}" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${esc(t("diag.addrPh"))}">
          <button class="btn sm primary" type="submit" data-i18n="diag.try"></button></span></label>
      </form>
      <ol class="log" aria-live="polite"></ol>
      <p class="fine">${esc(t("diag.env", { origin: location.origin, secure: t(window.isSecureContext ? "common.yes" : "common.no") }))}</p>
    </main>`;
  wireBack(el, ctx);
  const log = el.querySelector(".log");
  let ws = null, timer = 0;
  const line = (text, cls = "") => {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = `<time>${esc(formatTime(Date.now()))}</time> ${esc(text)}`;
    log.prepend(li);
  };
  const close = () => { clearTimeout(timer); try { ws?.close(); } catch {} ws = null; };

  el.querySelector("form").onsubmit = e => {
    e.preventDefault();
    close();
    let url = e.target.url.value.trim();
    if (!url) return line(t("diag.bad"), "bad");
    if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
    try { new URL(url); } catch { return line(t("diag.bad"), "bad"); }
    if (!/^wss?:$/i.test(new URL(url).protocol)) return line(t("diag.bad"), "bad");
    try { localStorage.setItem(LAST_KEY, url); } catch {}
    line(t("diag.trying", { url }));
    const from = performance.now(), ms = () => Math.round(performance.now() - from);
    let opened = false;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      return line(`${t("diag.bad")}: ${err.message}`, "bad");
    }
    const sock = ws;
    timer = setTimeout(() => { if (!opened) { line(t("diag.timeout", { s: TIMEOUT_MS / 1000 }), "bad"); close(); } }, TIMEOUT_MS);
    sock.onopen = () => {
      opened = true;
      clearTimeout(timer);
      line(t("diag.ok", { ms: ms() }), "ok");
      try { sock.send("agentdeck-diag ping"); } catch {}
    };
    sock.onmessage = m => line(t("diag.message", { text: String(typeof m.data === "string" ? m.data : `[${m.data?.size ?? m.data?.byteLength ?? "?"} bytes]`).slice(0, 200) }));
    // A failure is said once, by the close that follows it (with the code).
    sock.onclose = ev => {
      clearTimeout(timer);
      if (opened) line(t("diag.okClosed", { code: ev.code }));
      else line(t("diag.fail", { ms: ms(), code: ev.code }), "bad");
    };
  };
  return close;
}
