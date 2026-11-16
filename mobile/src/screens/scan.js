// The QR scanner: the camera through getUserMedia in the WebView, frames decoded by jsQR (pure JS, nothing native,
// nothing from Google). The text found goes to the pairing screen. A camera with a light gets a button for it in the
// header. With no camera (or no access to it) there is no viewfinder: a note says so and offers pairing by hand.
// params: from - "pair" when the pairing screen opened it (pairing by hand is then one step back).
import jsQR from "jsqr";
import { t } from "../i18n.js";
import { esc, buzz } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { looksLikePayload } from "../pairing.js";

const MAX_SIDE = 720; // frames are scaled down to this before decoding

export function render(el, ctx, p) {
  el.innerHTML = `${header(t("scan.title"), { back: true, actions: iconBtn("bolt", t("scan.torch"), 'data-act="torch" aria-pressed="false" hidden') })}
    <main class="body scan">
      <div class="viewfinder"><video playsinline muted></video><div class="frame"></div></div>
      <p class="hint" data-state role="status">${esc(t("scan.starting"))}</p>
    </main>`;
  wireBack(el, ctx);
  const video = el.querySelector("video");
  const state = el.querySelector("[data-state]");
  const torch = el.querySelector("[data-act='torch']");
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, raf = 0, done = false;

  function stop() {
    done = true;
    cancelAnimationFrame(raf);
    for (const tr of stream?.getTracks() || []) tr.stop();
    stream = null;
  }

  // Nothing to scan with: why, and the way to pair by hand.
  function noCamera(key) {
    el.querySelector(".viewfinder").hidden = true;
    state.hidden = true;
    const note = document.createElement("div");
    note.innerHTML = `<div class="note warn" role="status">${icon("alert")}<div class="note-text">${esc(t(key))}</div></div>
      <div class="foot-actions center"><button class="btn sm primary" data-act="hand">${esc(t("pair.byHand"))}</button></div>`;
    el.querySelector(".scan").append(...note.children);
    el.querySelector("[data-act='hand']").onclick = () => {
      if (p.from === "pair") ctx.back();
      else ctx.go("pair", { add: true }, { replace: true });
    };
  }

  // A pairing code goes to pairing (pairing.js screen); any other QR code is said to be none and scanning goes on.
  let lastWrong = "";
  function found(text) {
    if (!looksLikePayload(text)) {
      if (text !== lastWrong) { lastWrong = text; state.textContent = t("pair.notCode", { why: text.slice(0, 40) }); }
      raf = requestAnimationFrame(tick);
      return;
    }
    stop();
    buzz(40);
    state.textContent = t("scan.found");
    ctx.go("pairing", { text }, { replace: true });
  }

  function tick() {
    if (done) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const k = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code?.data) return found(code.data);
    }
    raf = requestAnimationFrame(tick);
  }

  (async () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return noCamera(window.isSecureContext ? "scan.noCamera" : "scan.insecure");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (done) return stop();
      video.srcObject = stream;
      await video.play();
      state.innerHTML = `${icon("scan")} ${esc(t("scan.hint"))}`;
      // The camera's light, where it has one (a code on a dim screen, a dark room).
      const track = stream.getVideoTracks()[0];
      if (track?.getCapabilities?.().torch) {
        let on = false;
        torch.hidden = false;
        torch.onclick = async () => {
          try {
            await track.applyConstraints({ advanced: [{ torch: !on }] });
            on = !on;
            torch.classList.toggle("on", on);
            torch.setAttribute("aria-pressed", String(on));
          } catch (e) { console.warn("torch", e); }
        };
      }
      tick();
    } catch (e) {
      console.warn("camera", e);
      noCamera("scan.noCamera");
    }
  })();

  return stop;
}
