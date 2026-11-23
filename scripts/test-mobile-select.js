// Selecting a terminal's text with a finger on the phone (mobile/src/select.js): the arithmetic between a touch and
// xterm's own selection. What this pins:
//   * cellAt: the cell under a point of the view - with the view scrolled, its padding, the history in view; a point
//     outside the terminal is the nearest cell, never one off it;
//   * wordAt: a long press takes the run of cells with something in them - a path, an address, a word with a wide
//     character in it (two cells, the second empty) - and stops at blanks and at the line's ends; a blank cell or a
//     line that is not there is a selection of that one cell;
//   * whole: a selection never begins or ends in the middle of a wide character - xterm copies a blank for one cut at
//     its second half - so what is copied is every character the finger touched;
//   * grow: the word first selected stays whole whichever way the finger goes on, also across lines;
//   * between: a handle dragged past the other end changes places with it;
//   * moved: a full history drops its oldest lines - the selection keeps to its text, cut where its beginning is
//     gone, over once all of it is;
//   * wholeLines and cellCount: what xterm's select(col, row, length) is given - checked against a model of how xterm
//     counts a length over the lines;
//   * handleAt: a handle hangs under its end of the selection, is hidden with its line, and never reaches out of the
//     terminal's box - at the first column, the last one, the last row, a terminal smaller than a handle.
//
// The lines are xterm's own: a terminal that is written to and never opened (it needs no page for that), with the
// character widths the app gives it (Unicode 11). A model of a line here would only hold what its author knows of
// xterm - and what xterm copies from half a wide character is not what one would guess.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

globalThis.self = globalThis; // xterm's bundle asks for the page's global
const { Terminal } = require("@xterm/xterm");
const { Unicode11Addon } = require("@xterm/addon-unicode11");

const src = p => pathToFileURL(path.join(__dirname, "../mobile/src", p)).href;

// A terminal as the app makes it (screens/terminal.js), with this written to it.
async function termOf(data, cols, rows = 4) {
  const term = new Terminal({ cols, rows, scrollback: 50, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  await new Promise(done => term.write(data, done));
  return term;
}
const lineOf = async (text, cols) => (await termOf(text, cols)).buffer.active.getLine(0);
// The text of a selection's cells in one line, as xterm copies it (its selection's text is this call, from the first
// cell to the one after the last).
const textOf = (line, sel) => line.translateToString(true, sel.a.col, sel.b.col + 1);
// The cells xterm selects for select(col, row, length): from the cell on, row after row.
function cellsOf(col, row, length, cols) {
  const out = [];
  for (let i = 0; i < length; i++) out.push(`${row + Math.floor((col + i) / cols)}:${(col + i) % cols}`);
  return out;
}

(async () => {
  const { cellAt, notAfter, wordAt, whole, grow, between, moved, wholeLines, cellCount, handleAt } = await import(src("select.js"));
  const at = (col, row) => ({ col, row });

  // ---------- cellAt ----------
  const view = { scroll: { left: 0, top: 0 }, cell: { w: 8, h: 16 }, pad: 4, cols: 80, rows: 24, top: 0 };
  assert.deepEqual(cellAt({ x: 4, y: 4 }, view), at(0, 0), "the first cell begins after the padding");
  assert.deepEqual(cellAt({ x: 11.9, y: 19.9 }, view), at(0, 0));
  assert.deepEqual(cellAt({ x: 12, y: 20 }, view), at(1, 1));
  assert.deepEqual(cellAt({ x: 4 + 8 * 79 + 3, y: 4 + 16 * 23 + 3 }, view), at(79, 23));
  assert.deepEqual(cellAt({ x: 0, y: 0 }, view), at(0, 0), "in the padding: the nearest cell");
  assert.deepEqual(cellAt({ x: -50, y: -50 }, view), at(0, 0));
  assert.deepEqual(cellAt({ x: 5000, y: 5000 }, view), at(79, 23), "past the terminal: its last cell");
  // The view scrolled sideways and down (a terminal wider and taller than the screen).
  assert.deepEqual(cellAt({ x: 4, y: 4 }, { ...view, scroll: { left: 80, top: 32 } }), at(10, 2));
  // The history in view: the rows are the buffer's lines.
  assert.deepEqual(cellAt({ x: 12, y: 20 }, { ...view, top: 500 }), at(1, 501));
  assert.deepEqual(cellAt({ x: 5000, y: 5000 }, { ...view, top: 500 }), at(79, 523));
  // A font that gives cells of a fraction of a pixel (the terminal zoomed out to its whole width).
  assert.deepEqual(cellAt({ x: 4 + 2.4 * 7 + 0.1, y: 4 + 4.8 * 3 + 0.1 }, { ...view, cell: { w: 2.4, h: 4.8 } }), at(7, 3));

  // ---------- notAfter ----------
  assert.ok(notAfter(at(3, 1), at(3, 1)), "a cell is not after itself");
  assert.ok(notAfter(at(3, 1), at(4, 1)));
  assert.ok(!notAfter(at(4, 1), at(3, 1)));
  assert.ok(notAfter(at(70, 1), at(0, 2)), "an earlier line comes first whatever the columns");
  assert.ok(!notAfter(at(0, 2), at(70, 1)));

  // ---------- wordAt ----------
  const COLS = 40;
  const line = await lineOf("  cd /srv/app  && npm run build", COLS);
  const word = col => { const w = wordAt(line, at(col, 7), COLS); assert.equal(w.a.row, 7); assert.equal(w.b.row, 7); return textOf(line, w); };
  assert.equal(word(2), "cd");
  assert.equal(word(3), "cd");
  assert.equal(word(5), "/srv/app", "a path is one run: only blanks end it");
  assert.equal(word(12), "/srv/app");
  assert.equal(word(15), "&&");
  assert.equal(word(30), "build", "the run ends with the text");
  assert.deepEqual(wordAt(line, at(0, 7), COLS), { a: at(0, 7), b: at(0, 7) }, "a blank cell: itself");
  assert.deepEqual(wordAt(line, at(4, 7), COLS), { a: at(4, 7), b: at(4, 7) });
  assert.deepEqual(wordAt(line, at(39, 7), COLS), { a: at(39, 7), b: at(39, 7) });
  // A line full to both ends.
  const full = await lineOf("x".repeat(COLS), COLS);
  assert.deepEqual(wordAt(full, at(17, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  assert.deepEqual(wordAt(full, at(0, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  assert.deepEqual(wordAt(full, at(COLS - 1, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  // Wide characters: both halves are the word's, pressed on either.
  const wide = await lineOf("ok 日本語.txt ✅ done", COLS);
  const widthAt = (l, col) => l.getCell(col).getWidth();
  assert.deepEqual([3, 4, 14, 15].map(col => widthAt(wide, col)), [2, 0, 2, 0], "the fixture: a wide character is two cells, the second with no width");
  for (const col of [3, 4, 5, 8, 9, 12]) assert.deepEqual(wordAt(wide, at(col, 0), COLS), { a: at(3, 0), b: at(12, 0) }, `pressed at column ${col}`);
  assert.equal(textOf(wide, wordAt(wide, at(4, 0), COLS)), "日本語.txt");
  assert.deepEqual(wordAt(wide, at(15, 0), COLS), { a: at(14, 0), b: at(15, 0) }, "an emoji alone: its two cells");
  // A line the buffer does not have.
  assert.deepEqual(wordAt(undefined, at(5, 3), COLS), { a: at(5, 3), b: at(5, 3) });

  // ---------- whole ----------
  // What xterm copies from the second half of a wide character on: a blank where the character was.
  assert.equal(wide.translateToString(true, 4, 13), " 本語.txt");
  const wideAt = row => (row === 0 ? wide : undefined);
  const copied = s => textOf(wide, whole(s, wideAt, COLS));
  // A handle put down on the second half of the first character: the character is the selection's.
  assert.equal(copied(between(at(12, 0), at(4, 0))), "日本語.txt");
  assert.deepEqual(whole(between(at(12, 0), at(4, 0)), wideAt, COLS), { a: at(3, 0), b: at(12, 0) });
  assert.equal(copied(between(at(12, 0), at(6, 0))), "本語.txt");
  // The finger went back from "done" onto the second half of the emoji, and on from "ok" onto the first half of 日.
  const done = wordAt(wide, at(18, 0), COLS), ok = wordAt(wide, at(0, 0), COLS);
  assert.equal(copied(grow(done, at(15, 0))), "✅ done");
  assert.deepEqual(whole(grow(ok, at(3, 0)), wideAt, COLS), { a: at(0, 0), b: at(4, 0) }, "the last cell: on to the character's second half");
  assert.equal(copied(grow(ok, at(3, 0))), "ok 日");
  assert.deepEqual(whole({ a: at(4, 0), b: at(4, 0) }, wideAt, COLS), { a: at(3, 0), b: at(4, 0) }, "one cell of a wide character: both");
  assert.deepEqual(whole({ a: at(9, 0), b: at(12, 0) }, wideAt, COLS), { a: at(9, 0), b: at(12, 0) }, "narrow characters: as it was");
  assert.deepEqual(whole({ a: at(4, 7), b: at(3, 9) }, wideAt, COLS), { a: at(4, 7), b: at(3, 9) }, "lines the buffer does not have: as it was");
  // Whatever the two ends: no character is cut, none is added that the ends did not touch, and what is copied is
  // those characters - the line's text between them (it ends at column 20: xterm copies nothing for what is after).
  const chars = [...Array(COLS).keys()].filter(col => widthAt(wide, col) > 0).map(col => ({ col, end: col + widthAt(wide, col) - 1, text: wide.getCell(col).getChars() || " " }));
  for (let a = 0; a < 24; a++) {
    for (let b = a; b < 24; b++) {
      const w = whole({ a: at(a, 0), b: at(b, 0) }, wideAt, COLS), touched = chars.filter(c => c.end >= a && c.col <= b);
      assert.deepEqual([w.a.col, w.b.col], [touched[0].col, touched.at(-1).end], `from ${a} to ${b}`);
      assert.equal(textOf(wide, w), touched.filter(c => c.col <= 20).map(c => c.text).join(""), `from ${a} to ${b}`);
    }
  }
  // A wide character in the line's last two cells, and one that did not fit there (xterm leaves the cell empty and
  // puts it on the next row): the ends stay on the line.
  const edge = await termOf("12345678日\r\n123456789日", 10);
  const edgeAt = row => edge.buffer.active.getLine(row);
  assert.deepEqual([8, 9].map(col => widthAt(edgeAt(0), col)), [2, 0]);
  assert.deepEqual(whole({ a: at(9, 0), b: at(9, 0) }, edgeAt, 10), { a: at(8, 0), b: at(9, 0) });
  assert.deepEqual(whole({ a: at(0, 0), b: at(8, 0) }, edgeAt, 10), { a: at(0, 0), b: at(9, 0) });
  assert.deepEqual([widthAt(edgeAt(1), 9), widthAt(edgeAt(2), 0), widthAt(edgeAt(2), 1)], [1, 2, 0]);
  assert.deepEqual(whole({ a: at(1, 2), b: at(1, 2) }, edgeAt, 10), { a: at(0, 2), b: at(1, 2) });
  assert.deepEqual(whole({ a: at(9, 1), b: at(0, 2) }, edgeAt, 10), { a: at(9, 1), b: at(1, 2) });

  // ---------- grow ----------
  const w = { a: at(10, 5), b: at(14, 5) };
  assert.deepEqual(grow(w, at(12, 5)), w, "inside the word: the word");
  assert.deepEqual(grow(w, at(10, 5)), w);
  assert.deepEqual(grow(w, at(14, 5)), w);
  assert.deepEqual(grow(w, at(20, 5)), { a: at(10, 5), b: at(20, 5) }, "on to the right");
  assert.deepEqual(grow(w, at(3, 5)), { a: at(3, 5), b: at(14, 5) }, "back to the left: the word's end stays");
  assert.deepEqual(grow(w, at(2, 8)), { a: at(10, 5), b: at(2, 8) }, "a line below, further left: still after the word");
  assert.deepEqual(grow(w, at(30, 2)), { a: at(30, 2), b: at(14, 5) }, "a line above, further right: still before it");
  assert.notEqual(grow(w, at(12, 5)), w, "a selection of its own, not the word's object");

  // ---------- between ----------
  assert.deepEqual(between(at(10, 5), at(20, 5)), { a: at(10, 5), b: at(20, 5) });
  assert.deepEqual(between(at(10, 5), at(4, 5)), { a: at(4, 5), b: at(10, 5) }, "past the other end: they change places");
  assert.deepEqual(between(at(10, 5), at(10, 5)), { a: at(10, 5), b: at(10, 5) }, "onto the other end: one cell");
  assert.deepEqual(between(at(10, 5), at(60, 4)), { a: at(60, 4), b: at(10, 5) });
  assert.deepEqual(between(at(10, 5), at(0, 6)), { a: at(10, 5), b: at(0, 6) });

  // ---------- wholeLines, cellCount ----------
  assert.deepEqual(wholeLines({ a: at(10, 5), b: at(2, 8) }, 80), { a: at(0, 5), b: at(79, 8) });
  assert.deepEqual(wholeLines({ a: at(10, 5), b: at(14, 5) }, 80), { a: at(0, 5), b: at(79, 5) });
  assert.equal(cellCount({ a: at(10, 5), b: at(10, 5) }, 80), 1);
  assert.equal(cellCount({ a: at(10, 5), b: at(14, 5) }, 80), 5);
  assert.equal(cellCount({ a: at(0, 5), b: at(79, 5) }, 80), 80);
  assert.equal(cellCount(wholeLines({ a: at(10, 5), b: at(2, 8) }, 80), 80), 320);
  // The length reaches the selection's last cell and not one more, whatever the two ends.
  for (const cols of [1, 2, 7, 80, 213]) {
    for (let n = 0; n < 300; n++) {
      const a = at((n * 31) % cols, 100 + (n % 5)), b = at((n * 17 + 3) % cols, 100 + (n % 5) + (n % 4));
      const sel = between(a, b);
      const cells = cellsOf(sel.a.col, sel.a.row, cellCount(sel, cols), cols);
      assert.equal(cells[0], `${sel.a.row}:${sel.a.col}`);
      assert.equal(cells.at(-1), `${sel.b.row}:${sel.b.col}`, `${cols} columns, ${JSON.stringify(sel)}`);
    }
  }

  // ---------- moved ----------
  // A full history drops lines from its top: the selection keeps to its text, as xterm's own does.
  const s = { a: at(10, 5), b: at(2, 8) };
  assert.deepEqual(moved(s, 0), s);
  assert.deepEqual(moved(s, -3), { a: at(10, 2), b: at(2, 5) });
  assert.deepEqual(moved(s, -5), { a: at(10, 0), b: at(2, 3) }, "its first line is the buffer's first now");
  assert.deepEqual(moved(s, -6), { a: at(0, 0), b: at(2, 2) }, "its beginning is gone: from the buffer's first cell");
  assert.deepEqual(moved(s, -8), { a: at(0, 0), b: at(2, 0) }, "only its last line is left");
  assert.equal(moved(s, -9), null, "all of it is gone");
  assert.equal(moved(s, -5000), null);
  assert.deepEqual(moved({ a: at(4, 0), b: at(4, 0) }, -1), null, "one cell on the line that went");
  assert.notEqual(moved(s, 0).a, s.a, "new cells, not the selection's own");
  // Whatever is left has its ends in order and is as long as xterm would have it.
  for (let by = 0; by >= -12; by--) {
    const m = moved(s, by);
    if (!m) continue;
    assert.ok(notAfter(m.a, m.b) && m.a.row >= 0, `by ${by}: ${JSON.stringify(m)}`);
    assert.equal(cellCount(m, 80), Math.min(cellCount(s, 80), m.b.row * 80 + m.b.col + 1), `by ${by}: cut at the buffer's first cell`);
  }

  // ---------- handleAt ----------
  const box = { cell: { w: 8, h: 16 }, cols: 80, rows: 24, top: 100, size: 18 };
  assert.deepEqual(handleAt(at(10, 105), false, box), { left: 10 * 8 - 18, top: 6 * 16 }, "the first cell's: left of its bottom-left corner");
  assert.deepEqual(handleAt(at(10, 105), true, box), { left: 11 * 8, top: 6 * 16 }, "the last cell's: right of its bottom-right corner");
  assert.equal(handleAt(at(10, 99), false, box), null, "its line scrolled away above");
  assert.equal(handleAt(at(10, 124), true, box), null, "and below");
  assert.notEqual(handleAt(at(10, 100), false, box), null);
  assert.notEqual(handleAt(at(10, 123), true, box), null);
  // Never out of the terminal's box.
  for (const b of [box, { ...box, cell: { w: 2.4, h: 4.8 } }, { ...box, cols: 1, rows: 1 }, { ...box, top: 0 }]) {
    const W = b.cols * b.cell.w, H = b.rows * b.cell.h;
    for (const col of [0, 1, 2, b.cols - 2, b.cols - 1].filter(c => c >= 0 && c < b.cols)) {
      for (const row of [0, 1, b.rows - 2, b.rows - 1].filter(r => r >= 0 && r < b.rows)) {
        for (const last of [false, true]) {
          const h = handleAt(at(col, b.top + row), last, b);
          assert.ok(h, "a line in view has its handle");
          assert.ok(h.left >= 0 && h.top >= 0, `not before the box: ${JSON.stringify({ col, row, last, h })}`);
          assert.ok(h.left + b.size <= Math.max(W, b.size) + 1e-9 && h.top + b.size <= Math.max(H, b.size) + 1e-9, `not past the box: ${JSON.stringify({ col, row, last, h, W, H })}`);
        }
      }
    }
  }
  assert.deepEqual(handleAt(at(0, 100), false, box), { left: 0, top: 16 }, "at the first column it stays in");
  assert.deepEqual(handleAt(at(79, 123), true, box), { left: 80 * 8 - 18, top: 24 * 16 - 18 }, "at the last cell of all too");

  console.log("mobile select: the cell under a point, a long press's word, growing it, whole wide characters, a handle past the other end, whole lines, the handles' places - passed");
})().catch(e => { console.error(e); process.exit(1); });
