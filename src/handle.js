// The edge handle's page: reports the pointer to main (edge-handle.js), which opens the menu or moves the window.
// A press that travels less than DRAG_PX is a click; further, and it is a drag - sideways only, main keeps the
// handle on the top edge. Screen coordinates, so the window moving under the pointer does not matter.
const api = window.edgeHandle;
const tab = document.getElementById("tab");
const DRAG_PX = 4;
let press = null; // { x, dragging }

tab.addEventListener("pointerenter", () => api.send("over", true));
tab.addEventListener("pointerleave", () => { if (!press) api.send("over", false); });
tab.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  tab.setPointerCapture(e.pointerId);
  press = { x: e.screenX, dragging: false };
  api.send("press");
});
tab.addEventListener("pointermove", e => {
  if (!press) return;
  if (!press.dragging) {
    if (Math.abs(e.screenX - press.x) < DRAG_PX) return;
    press.dragging = true;
    api.send("drag-start", press.x);
  }
  api.send("drag", e.screenX);
});
function release(e, cancelled) {
  const p = press;
  press = null;
  if (!p) return;
  if (p.dragging) api.send("drag-end", e.screenX);
  else if (!cancelled) api.send("click");
}
tab.addEventListener("pointerup", e => release(e, false));
tab.addEventListener("pointercancel", e => release(e, true));

// open: the menu is out and the handle sits on it as its grip. motion: main's verdict on animations (desktop.js).
api.onState(s => {
  document.body.classList.toggle("open", s.open);
  document.body.classList.toggle("drag", s.drag);
  document.documentElement.toggleAttribute("data-motion", s.motion);
});
