// The QR scanner: the camera through getUserMedia in the WebView, frames decoded by jsQR (pure JS, nothing native,
// nothing from Google). The text found goes to the pairing screen.
import jsQR from "jsqr";
import { t } from "../i18n.js";
import { esc, buzz } from "../util.js";
import { icon } from "../icons.js";
import { header, wireBack } from "./parts.js";
import { looksLikePayload } from "../pairing.js";

const MAX_SIDE = 720; // frames are scaled down to this before decoding

export function render(el, ctx) {
  el.innerHTML = `${header(t("scan.title"), { back: true })}
    <main class="body scan">
      <div class="viewfinder"><video playsinline muted></video><div class="frame"></div></div>
      <p class="hint" data-state>${esc(t("scan.starting"))}</p>
      <div class="foot-actions center"><button class="btn sm" data-act="cancel" data-i18n="common.cancel"></button></div>
    </main>`;
  wireBack(el, ctx);
  el.querySelector("[data-act='cancel']").onclick = () => ctx.back();
  const video = el.querySelector("video");
  const state = el.querySelector("[data-state]");
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d", { willReadFrequently: true });
  let stream = null, raf = 0, done = false;

  function stop() {
    done = true;
    cancelAnimationFrame(raf);
    for (const tr of stream?.getTracks() || []) tr.stop();
    stream = null;
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
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      state.textContent = t(window.isSecureContext ? "scan.noCamera" : "scan.insecure");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (done) return stop();
      video.srcObject = stream;
      await video.play();
      state.innerHTML = `${icon("scan")} ${esc(t("scan.hint"))}`;
      tick();
    } catch (e) {
      console.warn("camera", e);
      state.textContent = t("scan.noCamera");
    }
  })();

  return stop;
}
