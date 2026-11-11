// The connection check: a plain WebSocket from the app to ws://host:port and what came of it - to prove on a real
// device that the WebView lets an https app page open ws:// to an IP (mixed content, cleartext; MOBILE.md §3.4).
import { t } from "../i18n.js";
import { esc } from "../util.js";
import { header, wireBack } from "./parts.js";

const LAST_KEY = "agentdeck.diag.url";
const TIMEOUT_MS = 8000;

export function render(el, ctx) {
  let last = "ws://10.0.2.2:7421";
  try { last = localStorage.getItem(LAST_KEY) || last; } catch {}
  el.innerHTML = `${header(t("diag.title"), { back: true })}
    <main class="body diag">
      <p class="lead" data-i18n="diag.hint"></p>
      <form class="card form" novalidate>
        <label><span data-i18n="diag.addr"></span>
          <span class="inline-field"><input name="url" value="${esc(last)}" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="btn sm primary" type="submit" data-i18n="diag.try"></button></span></label>
      </form>
      <ol class="log" aria-live="polite"></ol>
      <p class="fine">${esc(t("diag.env", { origin: location.origin, secure: String(window.isSecureContext) }))}</p>
    </main>`;
  wireBack(el, ctx);
  const log = el.querySelector(".log");
  let ws = null, timer = 0;
  const line = (text, cls = "") => {
    const li = document.createElement("li");
    li.className = cls;
    li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time> ${esc(text)}`;
    log.prepend(li);
  };
  const close = () => { clearTimeout(timer); try { ws?.close(); } catch {} ws = null; };

  el.querySelector("form").onsubmit = e => {
    e.preventDefault();
    close();
    let url = e.target.url.value.trim();
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
    sock.onerror = () => { if (!opened) line(t("diag.fail", { ms: ms(), code: "error" }), "bad"); };
    sock.onclose = ev => {
      clearTimeout(timer);
      if (opened) line(t("diag.okClosed", { code: ev.code }));
      else line(t("diag.fail", { ms: ms(), code: ev.code }), "bad");
    };
  };
  return close;
}
