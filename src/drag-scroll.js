// A list that scrolls by itself while something is dragged near its top or bottom edge, so a row can be taken to a
// place that is out of view (the projects list, renderer.js). The nearer the edge, the faster.
//
// The browser reports a drag only now and then while the pointer rests (dragover), so the scrolling runs on its own,
// a frame at a time, from the last place the pointer was reported at. It ends when told to (the drop, the drag's
// end, the pointer leaving the list) - and by itself when no report came for DRAG_SCROLL_QUIET_MS: a dragend can be
// lost with its row (the list redraws while a row is dragged), and nothing may scroll on after that.
const DRAG_SCROLL_ZONE = 36;        // px from an edge where the scrolling starts
const DRAG_SCROLL_MIN = 90;         // px a second at the zone's inner end,
const DRAG_SCROLL_MAX = 900;        // and at the edge itself
const DRAG_SCROLL_QUIET_MS = 1000;

// How fast a list between `top` and `bottom` scrolls with the pointer at `y`, in px a second: negative is up, 0
// outside the zones. A short list has smaller zones (a third of it each), so its middle stays still.
function dragScrollSpeed(y, top, bottom) {
  const zone = Math.min(DRAG_SCROLL_ZONE, (bottom - top) / 3);
  if (!(zone > 0)) return 0;
  const up = top + zone - y, down = y - (bottom - zone);
  const depth = Math.min(1, Math.max(up, down) / zone);
  if (depth <= 0) return 0;
  return (up > down ? -1 : 1) * (DRAG_SCROLL_MIN + (DRAG_SCROLL_MAX - DRAG_SCROLL_MIN) * depth);
}

// box: the element that scrolls. -> at(clientY): where the pointer is now (every dragover); stop().
// frame / cancel / now: the page's own, given by tests.
function createDragScroll(box, { frame = cb => requestAnimationFrame(cb), cancel = id => cancelAnimationFrame(id), now = () => performance.now() } = {}) {
  let y = 0, heardAt = 0, last = 0, carry = 0, timer = 0;
  function step() {
    timer = 0;
    const t = now(), r = box.getBoundingClientRect();
    const speed = t - heardAt > DRAG_SCROLL_QUIET_MS ? 0 : dragScrollSpeed(y, r.top, r.bottom);
    if (!speed) return;
    // Whole pixels only: the rest waits for the next frame, so a slow scroll is not rounded away.
    const px = speed * Math.min(t - last, 100) / 1000 + carry, whole = Math.trunc(px);
    carry = px - whole;
    last = t;
    if (whole) box.scrollTop += whole;
    timer = frame(step);
  }
  return {
    at(clientY) {
      y = clientY;
      heardAt = now();
      if (timer) return;
      last = heardAt;
      carry = 0;
      timer = frame(step);
    },
    stop() {
      if (timer) cancel(timer);
      timer = 0;
    }
  };
}

if (typeof module === "object" && module.exports) {
  module.exports = { dragScrollSpeed, createDragScroll, DRAG_SCROLL_ZONE, DRAG_SCROLL_MIN, DRAG_SCROLL_MAX, DRAG_SCROLL_QUIET_MS };
}
