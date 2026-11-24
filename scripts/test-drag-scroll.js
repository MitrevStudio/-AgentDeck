// A list scrolling by itself under a drag near its edge (src/drag-scroll.js): where the zones are and how fast each
// place scrolls, and the loop - it runs between the pointer's reports, and ends when told or when the reports stop.
const assert = require('node:assert/strict');
const { dragScrollSpeed, createDragScroll, DRAG_SCROLL_ZONE: ZONE, DRAG_SCROLL_MIN: MIN, DRAG_SCROLL_MAX: MAX, DRAG_SCROLL_QUIET_MS: QUIET } = require('../src/drag-scroll');

// ---------- the zones and the speed ----------
const TOP = 100, BOTTOM = 500;
assert.equal(dragScrollSpeed(300, TOP, BOTTOM), 0, 'the middle stays still');
assert.equal(dragScrollSpeed(TOP + ZONE, TOP, BOTTOM), 0, 'the zone starts inside its border');
assert.equal(dragScrollSpeed(BOTTOM - ZONE, TOP, BOTTOM), 0);
assert.equal(dragScrollSpeed(TOP, TOP, BOTTOM), -MAX, 'up at the top edge, at full speed');
assert.equal(dragScrollSpeed(BOTTOM, TOP, BOTTOM), MAX, 'down at the bottom edge');
assert.equal(dragScrollSpeed(TOP - 40, TOP, BOTTOM), -MAX, 'no faster beyond the edge');
assert.equal(dragScrollSpeed(BOTTOM + 40, TOP, BOTTOM), MAX);
assert.equal(dragScrollSpeed(TOP + ZONE / 2, TOP, BOTTOM), -(MIN + (MAX - MIN) / 2), 'half way in, half way between the speeds');
assert.ok(dragScrollSpeed(BOTTOM - 1, TOP, BOTTOM) > dragScrollSpeed(BOTTOM - ZONE + 1, TOP, BOTTOM), 'faster nearer the edge');
assert.ok(dragScrollSpeed(BOTTOM - ZONE + 1, TOP, BOTTOM) >= MIN, 'never slower than the least');
// A list shorter than three zones: a third of it each, the middle third still.
assert.equal(dragScrollSpeed(130, 100, 160), 0);
assert.ok(dragScrollSpeed(105, 100, 160) < 0);
assert.ok(dragScrollSpeed(155, 100, 160) > 0);
assert.equal(dragScrollSpeed(100, 100, 100), 0, 'a list of no height does not scroll');

// ---------- the loop ----------
// The page's frames and clock by hand: tick(ms) lets that much time pass and runs the frame that was asked for.
function rig() {
  const box = { scrollTop: 1000, getBoundingClientRect: () => ({ top: TOP, bottom: BOTTOM }) };
  let clock = 5000, asked = null, id = 0;
  const scroll = createDragScroll(box, {
    frame: cb => { asked = cb; return ++id; }, cancel: () => { asked = null; }, now: () => clock
  });
  const tick = ms => { clock += ms; const cb = asked; asked = null; if (cb) cb(); return Boolean(cb); };
  return { box, scroll, tick, pending: () => Boolean(asked) };
}
{
  // Resting at the bottom edge: it scrolls on, frame after frame, with no further report for a while.
  const { box, scroll, tick, pending } = rig();
  scroll.at(BOTTOM);
  assert.equal(box.scrollTop, 1000, 'nothing before the first frame');
  for (let i = 0; i < 10; i++) tick(16);
  assert.equal(box.scrollTop, 1000 + Math.trunc(MAX * 0.16), '160 ms at full speed, to the pixel');
  assert.ok(pending(), 'and it goes on');
  // The pointer goes to the middle: the next frame ends it.
  scroll.at(300);
  const at = box.scrollTop;
  tick(16);
  assert.equal(box.scrollTop, at);
  assert.equal(pending(), false, 'no frame is asked for outside the zones');
  // Back at the top edge: up.
  scroll.at(TOP);
  tick(16); tick(16);
  assert.ok(box.scrollTop < at, 'up near the top edge');
  assert.ok(pending());
  // The drop (or the drag's end, or leaving the list) ends it there and then.
  scroll.stop();
  const stopped = box.scrollTop;
  assert.equal(tick(16), false, 'the frame asked for is taken back');
  assert.equal(box.scrollTop, stopped);
  scroll.stop(); // twice is fine
}
{
  // Slow, at the zone's inner end: less than a pixel a frame is kept for the next one, not rounded away.
  const { box, scroll, tick } = rig();
  scroll.at(BOTTOM - ZONE + 1);
  const speed = dragScrollSpeed(BOTTOM - ZONE + 1, TOP, BOTTOM);
  assert.ok(speed * 0.004 < 1, 'under a pixel a 4 ms frame');
  for (let i = 0; i < 100; i++) { tick(4); if (i % 50 === 49) scroll.at(BOTTOM - ZONE + 1); }
  assert.ok(Math.abs(box.scrollTop - 1000 - speed * 0.4) <= 1, '400 ms of it, within a pixel');
}
{
  // The reports stop (a dragend lost with its row): it ends by itself.
  const { box, scroll, tick, pending } = rig();
  scroll.at(BOTTOM);
  tick(16);
  assert.ok(pending());
  tick(QUIET + 1);
  const at = box.scrollTop;
  assert.equal(pending(), false, 'no report for too long: no more frames');
  tick(16);
  assert.equal(box.scrollTop, at);
  // A page that slept between two frames does not jump: a frame counts for 100 ms at most.
  scroll.at(BOTTOM);
  tick(16);
  const before = box.scrollTop;
  tick(900);
  assert.ok(box.scrollTop - before <= MAX * 0.1 + 1, 'a long gap is no long jump');
}
console.log('Drag scroll: zones, speed and the loop OK');
