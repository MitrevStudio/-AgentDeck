// Selecting a terminal's text with a finger (screens/terminal.js): the arithmetic, apart from the touches and from
// the page, so it can be tested (scripts/test-mobile-select.js). A cell is { col, row }: col from 0, row a line of the
// buffer (the history's lines included). A selection is { a, b }, its first and last cell, a not after b.
// The order here is the order of use: a touch's cell, the word there, the selection grown or moved, then - whatever
// made it - whole characters (whole), and what xterm and the handles are given.

// The cell under a point of the view. at: { x, y } in the view; scroll: how far the view is scrolled { left, top };
// cell: one cell's size { w, h }; pad: the view's padding; top: the buffer line the terminal's first row shows.
export function cellAt(at, { scroll, cell, pad, cols, rows, top }) {
  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));
  return {
    col: clamp(Math.floor((at.x + scroll.left - pad) / cell.w), cols - 1),
    row: top + clamp(Math.floor((at.y + scroll.top - pad) / cell.h), rows - 1)
  };
}

// a is b or comes before it, reading the lines left to right, top to bottom.
export const notAfter = (a, b) => a.row < b.row || (a.row === b.row && a.col <= b.col);

// The run of cells with something in them around a cell: the second half of a wide character counts as its first.
// An empty cell, or one off the buffer, is a selection of its own. lineAt: the buffer's line of a row (xterm's
// IBufferLine), if it has one.
// A line too long for the terminal is on several rows (the ones after the first say so: isWrapped), and a path or
// an address that runs over a row's end is still one word - so the run goes on from a row's last cell to the first
// of the row its line continues on, and back the same way. Where a wide character did not fit in a row's last cell
// xterm left that cell empty and put the character on the next row: no blank of the text, and stepped over.
export function wordAt(lineAt, pos, cols) {
  const cellOf = p => lineAt(p.row)?.getCell(p.col);
  const full = p => {
    const c = cellOf(p);
    return Boolean(c) && (c.getWidth() === 0 || c.getChars().trim() !== "");
  };
  const goesOn = row => Boolean(lineAt(row + 1)?.isWrapped); // the row's line continues on the next one
  // The row's last cell is the one left empty before a wide character that begins the next row.
  const padded = row => cols > 1 && goesOn(row) && cellOf({ col: cols - 1, row })?.getChars() === "" && cellOf({ col: 0, row: row + 1 })?.getWidth() === 2;
  // The cell before and the cell after in the line, or null at the line's ends.
  const before = p => {
    if (p.col > 0) return { col: p.col - 1, row: p.row };
    if (p.row < 1 || !goesOn(p.row - 1)) return null;
    return { col: padded(p.row - 1) ? cols - 2 : cols - 1, row: p.row - 1 };
  };
  const after = p => {
    const last = padded(p.row) ? cols - 2 : cols - 1;
    if (p.col < last) return { col: p.col + 1, row: p.row };
    return p.col === last && goesOn(p.row) ? { col: 0, row: p.row + 1 } : null;
  };
  let a = pos, b = pos;
  if (full(pos)) {
    for (let p = before(a); p && full(p); p = before(a)) a = p;
    for (let p = after(b); p && full(p); p = after(b)) b = p;
  }
  return { a: { col: a.col, row: a.row }, b: { col: b.col, row: b.row } };
}

// The word a long press takes: the one at the cell, or - the cell is blank - the nearest one in its row within
// `reach` cells, the one before at the same distance. A fingertip covers several cells of a terminal shown small,
// and its middle is as often on the blank beside a word as on the word: one blank cell selected is next to nothing
// to see, and nothing to copy. Further from any text it is that one cell still: a place to drag a selection on from.
export function wordNear(lineAt, pos, cols, reach) {
  const line = lineAt(pos.row);
  const full = col => {
    const c = col >= 0 && col < cols ? line?.getCell(col) : undefined;
    return Boolean(c) && (c.getWidth() === 0 || c.getChars().trim() !== "");
  };
  if (full(pos.col)) return wordAt(lineAt, pos, cols);
  for (let d = 1; d <= reach; d++) {
    for (const col of [pos.col - d, pos.col + d]) if (full(col)) return wordAt(lineAt, { col, row: pos.row }, cols);
  }
  return wordAt(lineAt, pos, cols);
}

// A selection with no wide character cut in two: a first cell on a character's second half goes back to its first, a
// last cell on its first half on to its second. xterm selects cells and knows nothing of the characters in them: from
// a second half on it copies a blank for the character, and it would highlight half of one. lineAt: the buffer's
// line of a row (xterm's IBufferLine), if it has one.
export function whole({ a, b }, lineAt, cols) {
  const width = pos => lineAt(pos.row)?.getCell(pos.col)?.getWidth();
  return {
    a: a.col > 0 && width(a) === 0 ? { col: a.col - 1, row: a.row } : a,
    b: b.col < cols - 1 && width(b) === 2 ? { col: b.col + 1, row: b.row } : b
  };
}

// The finger went on from the word a long press selected: the word stays whole, the selection grows from it to the
// cell under the finger, on either side.
export function grow(word, pos) {
  if (notAfter(pos, word.a)) return { a: pos, b: word.b };
  if (notAfter(word.b, pos)) return { a: word.a, b: pos };
  return { a: word.a, b: word.b };
}

// A handle was moved: from the selection's other end (fixed) to the cell under the finger; past that end the two
// change places.
export const between = (fixed, pos) => (notAfter(pos, fixed) ? { a: pos, b: fixed } : { a: fixed, b: pos });

// The lines of a selection from their first cell to their last - the lines as they were written, not the rows: one
// that the terminal put on several rows is taken with all of them (a row after a line's first says so: isWrapped),
// and copied as the one line it is.
export function wholeLines(sel, cols, lineAt) {
  let first = sel.a.row, last = sel.b.row;
  while (first > 0 && lineAt(first)?.isWrapped) first--;
  while (lineAt(last + 1)?.isWrapped) last++;
  return { a: { col: 0, row: first }, b: { col: cols - 1, row: last } };
}

// The buffer's lines moved by so many (negative: a full history dropped its oldest lines as new ones came): the
// selection on the same text - cut at the buffer's first cell where its beginning is gone, null once all of it is.
export function moved(sel, by) {
  const b = { col: sel.b.col, row: sel.b.row + by };
  if (b.row < 0) return null;
  const row = sel.a.row + by;
  return { a: row < 0 ? { col: 0, row: 0 } : { col: sel.a.col, row }, b };
}

// xterm's own selection (getSelectionPosition) as a selection here. Its range is { start, end }, each { x, y }: x a
// column and y a line of the buffer, both from 0 (its typings say from 1; xterm 6 does not), the end one cell past
// the last - x is the number of columns for a selection that ends with its line.
export function fromRange({ start, end }, cols) {
  return { a: { col: start.x, row: start.y }, b: end.x > 0 ? { col: end.x - 1, row: end.y } : { col: cols - 1, row: end.y - 1 } };
}

// Tells fn how many lines the buffer on screen dropped from its top, each time it does; returns what ends the
// telling. xterm moves its selection by that many and says the number to no one, and from the selection itself it
// cannot be read once the first line is among those dropped (settle) - but the buffer's list of lines announces it:
// a private field of xterm 6. Where it is not there, null: nothing is counted.
export function onDropped(term, fn) {
  try {
    const listening = term._core.buffer.lines.onTrim(fn);
    return () => listening.dispose();
  } catch {
    return null;
  }
}

// Where a selection is now. It is xterm's to keep - the highlight and what is copied are xterm's - and only xterm
// knows what became of it, so it is read back from there before its cells are used. sel: as it was last given to
// xterm; range: xterm's own now (none: xterm dropped it - another screen, another size); dropped: the lines the
// buffer dropped from its top since (onDropped). Gives { sel, by, cut }: by - how many lines it moved (what began
// with it moves along); or null: it is over.
// A program that moves lines about (scrolls them up, inserts or deletes one) moves no selection of xterm's, and so
// none here: the selection is of cells, and the two stay one. Lines dropped from a full history move it up - right
// until its first line is among them: xterm then keeps it whole and puts it on the buffer's first line, over text
// that was never selected. That is the one thing not taken from xterm: such a selection is cut at the buffer's
// first cell (cut: xterm is to be given it again), and over once its last line is gone too.
export function settle(sel, range, dropped, cols) {
  if (!range) return null;
  if (dropped > sel.a.row) {
    const left = moved(sel, -dropped);
    return left && { sel: left, by: -dropped, cut: true };
  }
  const now = fromRange(range, cols);
  return { sel: now, by: now.a.row - sel.a.row, cut: false };
}

// How many cells a selection holds, as xterm's select(col, row, length) counts them: row after row, each cols wide.
export const cellCount = (sel, cols) => (sel.b.row - sel.a.row) * cols + sel.b.col - sel.a.col + 1;

// Where a handle is drawn, in px from the terminal's top-left corner, or null while its line is out of sight. The
// first cell's handle hangs under that cell's left corner, to its left; the last cell's under its right corner, to
// its right - and both are kept inside the terminal's own box (size: the handle's, px).
export function handleAt(pos, last, { cell, cols, rows, top, size }) {
  const row = pos.row - top;
  if (row < 0 || row >= rows) return null;
  const clamp = (v, hi) => Math.max(0, Math.min(Math.max(0, hi), v));
  return {
    left: clamp(last ? (pos.col + 1) * cell.w : pos.col * cell.w - size, cols * cell.w - size),
    top: clamp((row + 1) * cell.h, rows * cell.h - size)
  };
}

// A mouse event is one the browser made of a touch, not a mouse's own. fingers: how many are on the terminal now;
// since: ms since one last came down or lifted; source: the event's sourceCapabilities, where the browser has them.
// A tap's mouse events follow its lift at once. A long press's do not: Android makes a mouse move, a button's press
// and the context menu of a finger that rests, when the phone's own "touch and hold" time is up - half a second on
// some phones, a second and a half where the user set it so - so a finger that is down counts for as long as it is.
export const ofTouch = ({ fingers, since, source = null }) => fingers > 0 || since <= 1000 || Boolean(source?.firesTouchEvents);

// How far the finger has been each way since it began a selection or took a handle, in px of the view: was, widened
// to the point it is at now (was null: it has just begun).
export function reachOf(at, was) {
  if (!was) return { left: at.x, right: at.x, top: at.y, bottom: at.y };
  return { left: Math.min(was.left, at.x), right: Math.max(was.right, at.x), top: Math.min(was.top, at.y), bottom: Math.max(was.bottom, at.y) };
}

// Which way the terminal scrolls under a finger near an edge of the view: { dx, dy }, each -1 (left, up), 0 or 1.
// Being within `near` px of an edge is not enough: a word of the first rows is pressed there, and the finger that
// rests on it, trembles, or goes on along the edge to take more of the line would send the terminal off into its
// history. The finger has to have come towards that edge, by `towards` px at least, from the furthest it has been
// from it (reach: reachOf) - from elsewhere in the view, on from where it pressed, or away and back.
export function edgeScroll(at, reach, view, { near, towards }) {
  const way = (v, least, most, size) => (v < near && most - v >= towards ? -1 : v > size - near && v - least >= towards ? 1 : 0);
  return { dx: way(at.x, reach.left, reach.right, view.w), dy: way(at.y, reach.top, reach.bottom, view.h) };
}

// Where the bar (Copy, whole lines, cancel) goes over the view: "top", where it is out of the way of the thumb that
// selects - unless an end of the selection is there in view: the bar would lie on the selected text and on the handle
// that moves it. Then "bottom", or "middle" when the other end is in view down there. band: the px the bar takes at
// the edge it is put at; handle: the px a handle hangs under its cell; height: the view's; rows, top and scrollTop:
// the terminal's rows, the buffer line its first row shows, and how far the view is scrolled down the terminal.
export function barAt(sel, { cell, pad, rows, top, scrollTop, height, band, handle }) {
  let up = false, down = false;
  for (const pos of [sel.a, sel.b]) {
    const from = pad + (pos.row - top) * cell.h - scrollTop, to = from + cell.h + handle;
    if (pos.row < top || pos.row >= top + rows || to <= 0 || from >= height) continue; // out of sight: nothing of it to cover
    if (from < band) up = true;
    if (to > height - band) down = true;
  }
  return up ? (down ? "middle" : "bottom") : "top";
}
