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

// The run of cells with something in them around a cell of a line (xterm's IBufferLine): the second half of a wide
// character counts as its first. An empty cell, or one off the line, is a selection of its own.
export function wordAt(line, pos, cols) {
  const full = col => {
    const c = line?.getCell(col);
    return Boolean(c) && (c.getWidth() === 0 || c.getChars().trim() !== "");
  };
  let s = pos.col, e = pos.col;
  if (full(s)) {
    while (s > 0 && full(s - 1)) s--;
    while (e < cols - 1 && full(e + 1)) e++;
  }
  return { a: { col: s, row: pos.row }, b: { col: e, row: pos.row } };
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

// The lines of a selection from their first cell to their last.
export const wholeLines = (sel, cols) => ({ a: { col: 0, row: sel.a.row }, b: { col: cols - 1, row: sel.b.row } });

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
