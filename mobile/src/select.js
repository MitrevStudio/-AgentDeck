// Selecting a terminal's text with a finger (screens/terminal.js): the arithmetic, apart from the touches and from
// xterm, so it can be tested (scripts/test-mobile-select.js). A cell is { col, row }: col from 0, row a line of the
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
// selection as xterm keeps its own then - on the same text, cut at the buffer's first cell where its beginning is
// gone, null once all of it is.
export function moved(sel, by) {
  const b = { col: sel.b.col, row: sel.b.row + by };
  if (b.row < 0) return null;
  const row = sel.a.row + by;
  return { a: row < 0 ? { col: 0, row: 0 } : { col: sel.a.col, row }, b };
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
