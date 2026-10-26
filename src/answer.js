// The answer window of a voice question (answer-popup.js in main): question, answer, "copied". It goes after
// SHOW_MS, the countdown paused while the pointer rests on it; Esc or the cross close it at once.
const SHOW_MS = 30000;
let timer = 0, left = SHOW_MS, since = 0, hovering = false;

function stop() { clearTimeout(timer); timer = 0; }
function arm() {
  stop();
  if (hovering) return;
  since = Date.now();
  $("timer").style.animation = "none";
  void $("timer").offsetWidth; // restart the bar's animation from where the time is
  $("timer").style.animation = `ans-timer ${left}ms linear forwards`;
  timer = setTimeout(close, left);
}
function close() { stop(); window.manager.answerAction({ type: "close" }); }

window.manager.onAnswer(a => {
  $("question").textContent = a.question || "";
  $("answer").textContent = a.answer || "";
  $("answer").scrollTop = 0;
  $("note").textContent = t(a.copied ? "voice.ask.copied" : "voice.ask.notCopied");
  left = SHOW_MS;
  hovering = false;
  arm();
  // The window takes the height its text needs (main keeps it within limits).
  requestAnimationFrame(() => {
    const part = sel => document.querySelector(sel).offsetHeight;
    window.manager.answerAction({ type: "height", height: part(".ans-head") + $("answer").scrollHeight + part(".ans-foot") + 4 });
  });
});

$("close").addEventListener("click", close);
$("copy").addEventListener("click", () => {
  window.manager.answerAction({ type: "copy" });
  $("note").textContent = t("voice.ask.copied");
});
document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
document.addEventListener("mouseenter", () => {
  hovering = true;
  if (timer) { left = Math.max(1500, left - (Date.now() - since)); stop(); }
  $("timer").style.animationPlayState = "paused";
});
document.addEventListener("mouseleave", () => { hovering = false; $("timer").style.animationPlayState = "running"; arm(); });
