// Selecting a terminal's text with a finger on the phone (mobile/src/select.js): the arithmetic between a touch and
// xterm's own selection. What this pins:
//   * cellAt: the cell under a point of the view - with the view scrolled, its padding, the history in view; a point
//     outside the terminal is the nearest cell, never one off it;
//   * wordAt: a long press takes the run of cells with something in them - a path, an address, a word with a wide
//     character in it (two cells, the second empty) - and stops at blanks and at the line's ends; a blank cell or a
//     line that is not there is a selection of that one cell; a word that the terminal's width broke over two rows
//     or more is taken whole, from any of them;
//   * wordNear: a long press on a blank within two cells of a word in its row takes that word - a fingertip is
//     wider than a cell; further from any text it is the one blank cell;
//   * whole: a selection never begins or ends in the middle of a wide character - xterm copies a blank for one cut at
//     its second half - so what is copied is every character the finger touched;
//   * grow: the word first selected stays whole whichever way the finger goes on, also across lines;
//   * between: a handle dragged past the other end changes places with it;
//   * moved: a full history drops its oldest lines - the selection keeps to its text, cut where its beginning is
//     gone, over once all of it is;
//   * fromRange, onDropped, settle: the selection is where xterm has its own - moved up with the lines a full history
//     drops, left alone when a program scrolls, inserts or deletes lines - except that one whose first line was
//     dropped is cut there, where xterm would keep it whole over other text; what xterm drops is counted by xterm;
//   * wholeLines and cellCount: what xterm's select(col, row, length) is given - checked against a model of how xterm
//     counts a length over the lines; a line on several rows is taken with all of them;
//   * handleAt: a handle hangs under its end of the selection, is hidden with its line, and never reaches out of the
//     terminal's box - at the first column, the last one, the last row, a terminal smaller than a handle;
//   * reachOf and edgeScroll: near an edge of the view the terminal scrolls under a finger that came towards that
//     edge - never under one that rests where it pressed, goes along the edge or trembles;
//   * barAt: the bar with Copy is never over an end of the selection that is in view - it leaves the top of the view
//     for the bottom, or for the middle when there is an end at each;
//   * ofTouch: the mouse events a browser makes of a finger - while one is down however long it has been, just
//     after it, or marked as a touch's by the browser - are told from a real mouse's, which stay xterm's.
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
  const { cellAt, notAfter, wordAt, wordNear, whole, grow, between, moved, fromRange, onDropped, settle, wholeLines, cellCount, handleAt, reachOf, edgeScroll, barAt, ofTouch } = await import(src("select.js"));
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
  // A buffer of one line at a row, of none, and a terminal's own.
  const on = (l, row = 0) => r => (r === row ? l : undefined);
  const none = () => undefined;
  const linesOf = term => row => term.buffer.active.getLine(row);
  const COLS = 40;
  const line = await lineOf("  cd /srv/app  && npm run build", COLS);
  const word = col => { const w = wordAt(on(line, 7), at(col, 7), COLS); assert.equal(w.a.row, 7); assert.equal(w.b.row, 7); return textOf(line, w); };
  assert.equal(word(2), "cd");
  assert.equal(word(3), "cd");
  assert.equal(word(5), "/srv/app", "a path is one run: only blanks end it");
  assert.equal(word(12), "/srv/app");
  assert.equal(word(15), "&&");
  assert.equal(word(30), "build", "the run ends with the text");
  assert.deepEqual(wordAt(on(line, 7), at(0, 7), COLS), { a: at(0, 7), b: at(0, 7) }, "a blank cell: itself");
  assert.deepEqual(wordAt(on(line, 7), at(4, 7), COLS), { a: at(4, 7), b: at(4, 7) });
  assert.deepEqual(wordAt(on(line, 7), at(39, 7), COLS), { a: at(39, 7), b: at(39, 7) });
  // ---------- wordNear ----------
  // What a long press takes. A fingertip covers several cells and its middle is easily on the blank beside the
  // word it is put on: within two cells of a word in the row, that word - the nearer one, the one before at the
  // same distance.
  const near = col => { const w = wordNear(on(line, 7), at(col, 7), COLS, 2); return w.a.col === w.b.col && textOf(line, w) === "" ? col : textOf(line, w); };
  assert.equal(near(3), "cd", "on a word: that word");
  assert.equal(near(0), "cd", "two cells before the line's first word");
  assert.equal(near(4), "cd", "between two words, one cell from each: the one before");
  assert.equal(near(13), "/srv/app", "one cell after a word, two before the next");
  assert.equal(near(14), "&&");
  assert.equal(near(31), "build", "just past the line's end");
  assert.equal(near(32), "build");
  // Further from any text the press is on that one blank cell: a place to drag a selection on from.
  assert.deepEqual(wordNear(on(line, 7), at(33, 7), COLS, 2), { a: at(33, 7), b: at(33, 7) }, "three cells past the end");
  assert.deepEqual(wordNear(on(line, 7), at(39, 7), COLS, 2), { a: at(39, 7), b: at(39, 7) });
  assert.deepEqual(wordNear(on(await lineOf("", COLS)), at(5, 0), COLS, 2), { a: at(5, 0), b: at(5, 0) }, "a blank line");
  assert.deepEqual(wordNear(none, at(5, 3), COLS, 2), { a: at(5, 3), b: at(5, 3) }, "a line the buffer does not have");
  assert.deepEqual(wordNear(on(line, 7), at(4, 7), COLS, 0), { a: at(4, 7), b: at(4, 7) }, "no reach: the cell itself");
  // The first and the last column: nothing is looked for off the row.
  const ends = await lineOf("a" + " ".repeat(COLS - 2) + "z", COLS);
  assert.deepEqual(wordNear(on(ends), at(1, 0), COLS, 2), { a: at(0, 0), b: at(0, 0) });
  assert.deepEqual(wordNear(on(ends), at(COLS - 2, 0), COLS, 2), { a: at(COLS - 1, 0), b: at(COLS - 1, 0) });
  assert.deepEqual(wordNear(on(ends), at(3, 0), COLS, 2), { a: at(3, 0), b: at(3, 0) });

  // A line full to both ends.
  const full = await lineOf("x".repeat(COLS), COLS);
  assert.deepEqual(wordAt(on(full), at(17, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  assert.deepEqual(wordAt(on(full), at(0, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  assert.deepEqual(wordAt(on(full), at(COLS - 1, 0), COLS), { a: at(0, 0), b: at(COLS - 1, 0) });
  // Wide characters: both halves are the word's, pressed on either.
  const wide = await lineOf("ok 日本語.txt ✅ done", COLS);
  const widthAt = (l, col) => l.getCell(col).getWidth();
  assert.deepEqual([3, 4, 14, 15].map(col => widthAt(wide, col)), [2, 0, 2, 0], "the fixture: a wide character is two cells, the second with no width");
  for (const col of [3, 4, 5, 8, 9, 12]) assert.deepEqual(wordAt(on(wide), at(col, 0), COLS), { a: at(3, 0), b: at(12, 0) }, `pressed at column ${col}`);
  assert.equal(textOf(wide, wordAt(on(wide), at(4, 0), COLS)), "日本語.txt");
  assert.deepEqual(wordAt(on(wide), at(15, 0), COLS), { a: at(14, 0), b: at(15, 0) }, "an emoji alone: its two cells");
  // A line the buffer does not have.
  assert.deepEqual(wordAt(none, at(5, 3), COLS), { a: at(5, 3), b: at(5, 3) });
  // A terminal 20 wide puts a long line on as many rows as it takes: a path that runs over three of them is one
  // word, pressed on any of the rows. What a new line began is another.
  const wrapped = await termOf("see /srv/app/releases/2024-11/build/output.log now\r\nabcdefghijklmnopqrst\r\nuvw\r\nabcdefghijklmnopqrst xyz", 20, 8);
  const rowsOf = linesOf(wrapped);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(r => rowsOf(r).isWrapped), [false, true, true, false, false, false, true], "the fixture: rows 1, 2 and 6 go on from the row above");
  // What xterm copies of a selection: its rows' text, a row that goes on from the one above joined to it.
  const copiedOf = (lineAt, s, cols) => {
    let out = "";
    for (let r = s.a.row; r <= s.b.row; r++) out += (r > s.a.row && !lineAt(r).isWrapped ? "\n" : "") + lineAt(r).translateToString(true, r === s.a.row ? s.a.col : 0, r === s.b.row ? s.b.col + 1 : cols);
    return out;
  };
  const longPath = { a: at(4, 0), b: at(5, 2) };
  for (const [col, row] of [[4, 0], [12, 0], [19, 0], [0, 1], [10, 1], [19, 1], [0, 2], [5, 2]]) assert.deepEqual(wordAt(rowsOf, at(col, row), 20), longPath, `pressed at ${col}, ${row}`);
  assert.equal(copiedOf(rowsOf, longPath, 20), "/srv/app/releases/2024-11/build/output.log");
  assert.deepEqual(wordAt(rowsOf, at(1, 0), 20), { a: at(0, 0), b: at(2, 0) }, "the word before it");
  assert.deepEqual(wordAt(rowsOf, at(8, 2), 20), { a: at(7, 2), b: at(9, 2) }, "and the one after");
  assert.deepEqual(wordAt(rowsOf, at(6, 2), 20), { a: at(6, 2), b: at(6, 2) }, "the blank between");
  // A row full to its end, the next one a line of its own: the word ends with the row.
  assert.deepEqual(wordAt(rowsOf, at(7, 3), 20), { a: at(0, 3), b: at(19, 3) });
  assert.deepEqual(wordAt(rowsOf, at(1, 4), 20), { a: at(0, 4), b: at(2, 4) });
  // A row full to its end and the line going on with a blank: the word ends there too.
  assert.deepEqual(wordAt(rowsOf, at(7, 5), 20), { a: at(0, 5), b: at(19, 5) });
  assert.deepEqual(wordAt(rowsOf, at(2, 6), 20), { a: at(1, 6), b: at(3, 6) });
  // A wide character that did not fit at a row's end is put on the next row, and the last cell left empty: the word
  // goes on over it, both ways.
  const split = await termOf("abcdefghi日本x y", 10);
  const splitAt = linesOf(split);
  assert.deepEqual([splitAt(0).getCell(9).getChars(), splitAt(1).isWrapped, splitAt(1).getCell(0).getWidth()], ["", true, 2], "the fixture");
  for (const [col, row] of [[0, 0], [8, 0], [0, 1], [1, 1], [3, 1], [4, 1]]) assert.deepEqual(wordAt(splitAt, at(col, row), 10), { a: at(0, 0), b: at(4, 1) }, `pressed at ${col}, ${row}`);
  assert.equal(copiedOf(splitAt, wordAt(splitAt, at(3, 0), 10), 10), "abcdefghi日本x");
  assert.deepEqual(wordAt(splitAt, at(9, 0), 10), { a: at(9, 0), b: at(9, 0) }, "the empty cell itself: a blank");
  assert.deepEqual(wordAt(splitAt, at(6, 1), 10), { a: at(6, 1), b: at(6, 1) });
  // A row left with an empty last cell by something else - the line does not go on with a wide character: no word
  // crosses it.
  const erased = await termOf("abcdefghijklm\x1b[1;10H\x1b[X", 10);
  const erasedAt = linesOf(erased);
  assert.deepEqual([erasedAt(0).getCell(9).getChars(), erasedAt(1).isWrapped, erasedAt(1).getCell(0).getWidth()], ["", true, 1], "the fixture");
  assert.deepEqual(wordAt(erasedAt, at(3, 0), 10), { a: at(0, 0), b: at(8, 0) });
  assert.deepEqual(wordAt(erasedAt, at(1, 1), 10), { a: at(0, 1), b: at(2, 1) });
  // A line whose beginning the history dropped: its first row left goes on from a row that is no more.
  const cutLine = { isWrapped: true, getCell: col => rowsOf(1).getCell(col) };
  assert.deepEqual(wordAt(on(cutLine), at(3, 0), 20), { a: at(0, 0), b: at(19, 0) });

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
  const done = wordAt(on(wide), at(18, 0), COLS), ok = wordAt(on(wide), at(0, 0), COLS);
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
  assert.deepEqual(wholeLines({ a: at(10, 5), b: at(2, 8) }, 80, none), { a: at(0, 5), b: at(79, 8) });
  assert.deepEqual(wholeLines({ a: at(10, 5), b: at(14, 5) }, 80, none), { a: at(0, 5), b: at(79, 5) });
  assert.equal(cellCount({ a: at(10, 5), b: at(10, 5) }, 80), 1);
  assert.equal(cellCount({ a: at(10, 5), b: at(14, 5) }, 80), 5);
  assert.equal(cellCount({ a: at(0, 5), b: at(79, 5) }, 80), 80);
  assert.equal(cellCount(wholeLines({ a: at(10, 5), b: at(2, 8) }, 80, none), 80), 320);
  // A line the terminal put on several rows is one line: all its rows, from whichever of them the selection is on.
  const pathRows = { a: at(0, 0), b: at(19, 2) };
  for (const s of [{ a: at(4, 0), b: at(6, 0) }, { a: at(3, 1), b: at(9, 1) }, { a: at(7, 2), b: at(9, 2) }, longPath, { a: at(19, 0), b: at(0, 1) }]) {
    assert.deepEqual(wholeLines(s, 20, rowsOf), pathRows, JSON.stringify(s));
  }
  assert.equal(copiedOf(rowsOf, pathRows, 20), "see /srv/app/releases/2024-11/build/output.log now");
  assert.deepEqual(wholeLines({ a: at(5, 3), b: at(9, 3) }, 20, rowsOf), { a: at(0, 3), b: at(19, 3) }, "a full row that is a line of its own");
  assert.deepEqual(wholeLines({ a: at(1, 4), b: at(1, 4) }, 20, rowsOf), { a: at(0, 4), b: at(19, 4) });
  assert.deepEqual(wholeLines({ a: at(3, 1), b: at(2, 6) }, 20, rowsOf), { a: at(0, 0), b: at(19, 6) }, "from inside one line to inside another");
  assert.deepEqual(wholeLines({ a: at(3, 4), b: at(2, 5) }, 20, rowsOf), { a: at(0, 4), b: at(19, 6) });
  assert.equal(copiedOf(rowsOf, wholeLines({ a: at(3, 4), b: at(2, 5) }, 20, rowsOf), 20), "uvw\nabcdefghijklmnopqrst xyz");
  assert.deepEqual(wholeLines({ a: at(3, 0), b: at(5, 0) }, 20, on(cutLine)), { a: at(0, 0), b: at(19, 0) }, "a line with its beginning dropped: from the buffer's first row");
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
  // A full history drops lines from its top: the selection keeps to its text.
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
  // Whatever is left has its ends in order and holds the cells that are still there, no more.
  for (let by = 0; by >= -12; by--) {
    const m = moved(s, by);
    if (!m) continue;
    assert.ok(notAfter(m.a, m.b) && m.a.row >= 0, `by ${by}: ${JSON.stringify(m)}`);
    assert.equal(cellCount(m, 80), Math.min(cellCount(s, 80), m.b.row * 80 + m.b.col + 1), `by ${by}: cut at the buffer's first cell`);
  }

  // ---------- fromRange ----------
  // xterm's range for a selection, as the app saw it in a page: a word at columns 13-17 of line 21, and that whole
  // line of a terminal 120 wide. Columns and lines from 0, the end one past the last cell.
  assert.deepEqual(fromRange({ start: { x: 13, y: 21 }, end: { x: 18, y: 21 } }, 120), { a: at(13, 21), b: at(17, 21) });
  assert.deepEqual(fromRange({ start: { x: 0, y: 21 }, end: { x: 120, y: 21 } }, 120), { a: at(0, 21), b: at(119, 21) }, "to its line's end: the number of columns");
  assert.deepEqual(fromRange({ start: { x: 0, y: 2 }, end: { x: 4, y: 4 } }, 120), { a: at(0, 2), b: at(3, 4) });
  assert.deepEqual(fromRange({ start: { x: 5, y: 2 }, end: { x: 0, y: 4 } }, 120), { a: at(5, 2), b: at(119, 3) }, "an end before a line's first cell: the last of the line above");
  // A terminal that was never opened has no selection to ask, so here is how xterm 6 keeps one made with
  // select(col, row, length) (its SelectionModel): the first cell and the length - the end is counted from them -
  // and for lines dropped the first cell goes up, no further than the buffer's first line.
  const xtermRange = (sel, cols, dropped = 0) => {
    const start = { x: sel.a.col, y: Math.max(0, sel.a.row - dropped) }, upTo = start.x + cellCount(sel, cols);
    if (upTo <= cols) return { start, end: { x: upTo, y: start.y } };
    return { start, end: upTo % cols ? { x: upTo % cols, y: start.y + Math.floor(upTo / cols) } : { x: cols, y: start.y + upTo / cols - 1 } };
  };
  assert.deepEqual(xtermRange({ a: at(13, 21), b: at(17, 21) }, 120), { start: { x: 13, y: 21 }, end: { x: 18, y: 21 } }, "the model gives what the page showed");
  assert.deepEqual(xtermRange({ a: at(0, 21), b: at(119, 21) }, 120), { start: { x: 0, y: 21 }, end: { x: 120, y: 21 } });
  assert.deepEqual(xtermRange({ a: at(0, 2), b: at(3, 4) }, 120), { start: { x: 0, y: 2 }, end: { x: 4, y: 4 } });
  // What is given to xterm comes back the same, whatever the two ends.
  for (const cols of [1, 2, 7, 80, 213]) {
    for (let n = 0; n < 300; n++) {
      const sel = between(at((n * 31) % cols, 100 + (n % 5)), at((n * 17 + 3) % cols, 100 + (n % 5) + (n % 4)));
      assert.deepEqual(fromRange(xtermRange(sel, cols), cols), sel, `${cols} columns, ${JSON.stringify(sel)}`);
    }
  }

  // ---------- onDropped ----------
  // xterm's own buffer says how many lines it dropped: 4 rows and a history of 50, so 54 lines before the first goes.
  const hist = await termOf(Array.from({ length: 30 }, (_, i) => `note ${i}`).join("\r\n"), 20);
  const put = data => new Promise(done => hist.write(data, done));
  const rowOf = text => { for (let r = 0; r < hist.buffer.active.length; r++) if (hist.buffer.active.getLine(r).translateToString(true) === text) return r; return -1; };
  let dropped = 0;
  const stop = onDropped(hist, n => { dropped += n; });
  assert.equal(typeof stop, "function", "the installed xterm has the field this reads");
  // A program moving lines about drops none: scrolling up, inserting a line, deleting one.
  await put("\x1b[S\x1b[2;1H\x1b[L\x1b[M\x1b[4;1H");
  assert.equal(dropped, 0);
  await put("\r\nnote 30\r\nnote 31");
  assert.equal(dropped, 0, "a history not yet full grows");
  const was = rowOf("note 28");
  assert.ok(was > 0);
  await put(Array.from({ length: 40 }, (_, i) => `\r\nmore ${i}`).join(""));
  assert.equal(hist.buffer.active.length, 54);
  assert.ok(dropped > 0 && dropped < was, `some of it dropped: ${dropped}`);
  assert.equal(rowOf("note 28"), was - dropped, "a line is as many rows up as were dropped");
  await put("\r\nlast 0\r\nlast 1\r\nlast 2");
  assert.equal(rowOf("note 28"), was - dropped);
  // The other screen is a buffer of its own; what it drops is not this one's.
  const before = dropped;
  await put("\x1b[?1049h");
  let other = 0;
  const stopOther = onDropped(hist, n => { other += n; });
  await put("\x1b[4;1Hone\r\ntwo\r\nthree");
  assert.deepEqual([dropped, other], [before, 2]);
  stopOther();
  await put("\r\nfour\x1b[?1049l");
  assert.equal(other, 2, "told no more once stopped");
  stop();
  await put("\r\nlast 3");
  assert.equal(dropped, before);
  assert.equal(onDropped({}, () => {}), null, "an xterm without the field: nothing to stop, nothing counted");

  // ---------- settle ----------
  const S = { a: at(10, 5), b: at(2, 8) };
  assert.equal(settle(S, undefined, 0, 80), null, "xterm has no selection: it is over");
  assert.equal(settle(S, undefined, 3, 80), null);
  assert.deepEqual(settle(S, xtermRange(S, 80), 0, 80), { sel: S, by: 0, cut: false }, "nothing happened: as it was");
  // Lines moved about by a program are no lines dropped: xterm's selection stays on its cells, and so does this.
  assert.deepEqual(settle(S, xtermRange(S, 80), 0, 80).sel, S);
  // Lines dropped: xterm moved it, and it is where xterm has it.
  assert.deepEqual(settle(S, xtermRange(S, 80, 3), 3, 80), { sel: { a: at(10, 2), b: at(2, 5) }, by: -3, cut: false });
  assert.deepEqual(settle(S, xtermRange(S, 80, 5), 5, 80), { sel: { a: at(10, 0), b: at(2, 3) }, by: -5, cut: false }, "its first line is the buffer's first now");
  // An xterm that does not say what it dropped: the selection is still where xterm has it.
  assert.deepEqual(settle(S, xtermRange(S, 80, 3), 0, 80), { sel: { a: at(10, 2), b: at(2, 5) }, by: -3, cut: false });
  // Its first line is among the dropped: xterm keeps all of its length, from the buffer's first line - over text
  // that was not selected. Here it is cut, and xterm is to be given what is left.
  assert.deepEqual(fromRange(xtermRange(S, 80, 6), 80), { a: at(10, 0), b: at(2, 3) }, "xterm's own: as long as ever");
  assert.deepEqual(settle(S, xtermRange(S, 80, 6), 6, 80), { sel: { a: at(0, 0), b: at(2, 2) }, by: -6, cut: true });
  assert.deepEqual(settle(S, xtermRange(S, 80, 8), 8, 80), { sel: { a: at(0, 0), b: at(2, 0) }, by: -8, cut: true }, "only its last line is left");
  assert.equal(settle(S, xtermRange(S, 80, 9), 9, 80), null, "all of it dropped, though xterm still has one");
  assert.equal(settle(S, xtermRange(S, 80, 5000), 5000, 80), null);
  // Step by step, a few lines at a time, it ends where it would have in one go.
  for (const step of [1, 2, 3, 7]) {
    let cur = S, total = 0;
    while (cur) {
      assert.deepEqual(cur, moved(S, -total), `${total} dropped, ${step} at a time`);
      const next = settle(cur, xtermRange(cur, 80, step), step, 80);
      total += step;
      assert.deepEqual(next?.sel ?? null, moved(S, -total), `${total} dropped, ${step} at a time`);
      cur = next?.sel;
    }
    assert.ok(total > 8);
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

  // ---------- reachOf, edgeScroll ----------
  // A view of 360 by 556 px, as a phone's; the terminal scrolls within 28 px of an edge, for a finger that came at
  // least 8 px towards it.
  const port = { w: 360, h: 556 }, edges = { near: 28, towards: 8 };
  // The finger's way as points; which way the terminal scrolls at its last one.
  const scrollAfter = (...way) => {
    let reach = null;
    for (const [x, y] of way) reach = reachOf({ x, y }, reach);
    const [x, y] = way.at(-1);
    return edgeScroll({ x, y }, reach, port, edges);
  };
  const still = { dx: 0, dy: 0 };
  assert.deepEqual(reachOf({ x: 50, y: 11 }, null), { left: 50, right: 50, top: 11, bottom: 11 });
  assert.deepEqual(reachOf({ x: 70, y: 5 }, reachOf({ x: 50, y: 11 }, null)), { left: 50, right: 70, top: 5, bottom: 11 });
  assert.deepEqual(reachOf({ x: 60, y: 8 }, { left: 50, right: 70, top: 5, bottom: 11 }), { left: 50, right: 70, top: 5, bottom: 11 }, "where it has been stays");
  // A long press on a word of the first rows, of the last ones, at a side: the finger rests where it pressed.
  for (const [x, y] of [[50, 11], [50, 25], [50, 0], [180, 550], [5, 300], [350, 300], [3, 3], [357, 553], [180, 278]]) {
    assert.deepEqual(scrollAfter([x, y]), still, `resting at ${x}, ${y}`);
  }
  // It goes on along the edge, to take more of the line - and trembles as a finger does.
  assert.deepEqual(scrollAfter([50, 11], [66, 11], [120, 12], [200, 10]), still, "along the top edge");
  assert.deepEqual(scrollAfter([50, 11], [62, 23]), still, "away from the edge, still near it");
  assert.deepEqual(scrollAfter([50, 11], [65, 11], [65, 9], [65, 12], [66, 9], [65, 13], [65, 6]), still, "trembling: never 8 px towards the edge");
  assert.deepEqual(scrollAfter([345, 151], [345, 171], [346, 181], [344, 181]), still, "down along the right edge");
  // Towards the edge by less than counts, then by as much.
  assert.deepEqual(scrollAfter([50, 11], [50, 4]), still, "7 px up");
  assert.deepEqual(scrollAfter([50, 11], [50, 3]), { dx: 0, dy: -1 }, "8 px up: the history comes");
  assert.deepEqual(scrollAfter([50, 11], [50, -7]), { dx: 0, dy: -1 }, "over what is above the view");
  // From elsewhere into the edge.
  assert.deepEqual(scrollAfter([50, 179], [50, 100], [50, 28]), still, "not yet near");
  assert.deepEqual(scrollAfter([50, 179], [50, 100], [50, 27]), { dx: 0, dy: -1 });
  assert.deepEqual(scrollAfter([50, 30], [50, 27]), still, "3 px into the edge from just outside it: a tremble");
  assert.deepEqual(scrollAfter([50, 30], [50, 22]), { dx: 0, dy: -1 });
  // Away from the edge and back to where it pressed.
  assert.deepEqual(scrollAfter([50, 11], [50, 18], [50, 11]), still, "7 px away and back");
  assert.deepEqual(scrollAfter([50, 11], [50, 81], [50, 11]), { dx: 0, dy: -1 }, "five rows down and back up");
  // Once it scrolls it goes on while the finger stays near the edge, whatever it does there; away from it, it stops.
  assert.deepEqual(scrollAfter([50, 179], [50, 10], [50, 20], [60, 26]), { dx: 0, dy: -1 });
  assert.deepEqual(scrollAfter([50, 179], [50, 10], [50, 40]), still);
  // The other edges the same way.
  assert.deepEqual(scrollAfter([180, 300], [180, 529]), { dx: 0, dy: 1 }, "the bottom");
  assert.deepEqual(scrollAfter([180, 300], [180, 528]), still);
  assert.deepEqual(scrollAfter([180, 545], [260, 545]), still, "along the bottom edge");
  assert.deepEqual(scrollAfter([180, 545], [180, 553]), { dx: 0, dy: 1 });
  assert.deepEqual(scrollAfter([148, 179], [333, 179]), { dx: 1, dy: 0 }, "the right");
  assert.deepEqual(scrollAfter([148, 179], [332, 179]), still);
  assert.deepEqual(scrollAfter([345, 151], [265, 151], [345, 151]), { dx: 1, dy: 0 }, "left and back to the right edge");
  assert.deepEqual(scrollAfter([148, 179], [27, 179]), { dx: -1, dy: 0 }, "the left");
  assert.deepEqual(scrollAfter([10, 179], [10, 300]), still, "down along the left edge");
  assert.deepEqual(scrollAfter([10, 179], [2, 300]), { dx: -1, dy: 0 });
  // Into a corner: both ways; towards one edge along the other: only that one.
  assert.deepEqual(scrollAfter([180, 278], [350, 550]), { dx: 1, dy: 1 });
  assert.deepEqual(scrollAfter([180, 278], [5, 5]), { dx: -1, dy: -1 });
  assert.deepEqual(scrollAfter([50, 11], [350, 11]), { dx: 1, dy: 0 }, "along the top edge to the right one");

  // ---------- barAt ----------
  // A view 556 px high showing a terminal of 32 rows of 14 px from line 100 on; the bar takes 72 px at the edge it is
  // put at, a handle 18 px under its cell.
  const room = { cell: { w: 7, h: 14 }, pad: 4, rows: 32, top: 100, scrollTop: 0, height: 556, band: 72, handle: 18 };
  const one = (col, row) => ({ a: at(col, row), b: at(col + 4, row) });
  assert.equal(barAt(one(20, 115), room), "top", "a word in the middle: over the terminal's top");
  // The first rows are where the bar is: there it would lie on the word and on both handles.
  for (const row of [100, 101, 102, 103, 104]) assert.equal(barAt(one(20, row), room), "bottom", `a word of row ${row - 100}`);
  assert.equal(barAt(one(20, 105), room), "top", "the first row clear of it: 74 px down");
  assert.equal(barAt({ a: at(3, 102), b: at(9, 120) }, room), "bottom", "only its first end is up there");
  assert.equal(barAt({ a: at(3, 90), b: at(9, 101) }, room), "bottom", "its beginning is above the view, its last end in the first rows");
  // An end out of sight has no handle to cover.
  assert.equal(barAt({ a: at(3, 90), b: at(9, 115) }, room), "top");
  assert.equal(barAt({ a: at(3, 90), b: at(9, 99) }, room), "top", "all of it above the view");
  assert.equal(barAt({ a: at(3, 80), b: at(9, 300) }, room), "top", "the whole view selected, both ends out of sight");
  // Rows 0-31 end at 452 px, well above the view's last 72: nothing is ever down there in this view.
  assert.equal(barAt(one(20, 131), room), "top");
  // A view that the terminal fills or overflows (the keyboard up: 236 px, scrolled to the terminal's end).
  const low = { ...room, height: 236, scrollTop: 32 * 14 + 8 - 236 };
  assert.equal(barAt(one(20, 131), low), "top", "a word of the last row: the bar is out of its way already");
  assert.equal(barAt(one(20, 116), low), "bottom", "the first row in view now");
  assert.equal(barAt(one(20, 113), low), "top", "a row scrolled out above, handle and all");
  assert.equal(barAt(one(20, 124), low), "top", "the middle of it");
  // An end at each edge: between them, where there is selected text and no handle.
  assert.equal(barAt({ a: at(3, 117), b: at(9, 131) }, low), "middle");
  assert.equal(barAt({ a: at(3, 117), b: at(9, 124) }, low), "bottom", "the last end and its handle clear of the last 72 px");
  assert.equal(barAt({ a: at(3, 117), b: at(9, 125) }, low), "middle", "its handle reaches into them");
  // The history scrolled into view: the rows are the buffer's lines.
  assert.equal(barAt(one(20, 100), { ...room, top: 95 }), "top", "row 5 of the view now");
  assert.equal(barAt(one(20, 96), { ...room, top: 95 }), "bottom");

  // ---- a mouse event made of a touch ----
  // A finger that rests: Android's own long press comes when the phone is set to (half a second, a second and a
  // half), with a mouse move and a button's press at the finger's place - however long the finger has been down.
  assert.equal(ofTouch({ fingers: 1, since: 500 }), true);
  assert.equal(ofTouch({ fingers: 1, since: 1500 }), true, "a finger down for longer than the time after a touch");
  assert.equal(ofTouch({ fingers: 2, since: 4000 }), true);
  // After the lift: the mouse events of a tap follow it at once.
  assert.equal(ofTouch({ fingers: 0, since: 0 }), true);
  assert.equal(ofTouch({ fingers: 0, since: 1000 }), true);
  assert.equal(ofTouch({ fingers: 0, since: 1001 }), false, "a mouse, a while after the screen was last touched");
  assert.equal(ofTouch({ fingers: 0, since: Infinity }), false, "a mouse, the screen never touched");
  // Where the browser says what the event was made of, that is taken.
  assert.equal(ofTouch({ fingers: 0, since: 5000, source: { firesTouchEvents: true } }), true);
  assert.equal(ofTouch({ fingers: 0, since: 5000, source: { firesTouchEvents: false } }), false);
  assert.equal(ofTouch({ fingers: 0, since: 5000, source: null }), false);
  assert.equal(ofTouch({ fingers: 1, since: 5000, source: { firesTouchEvents: false } }), true, "a finger is down all the same");

  console.log("mobile select: the cell under a point, a long press's word and the word beside a blank, growing it, whole wide characters, a handle past the other end, the selection where xterm has it, whole lines, the handles' places, scrolling at an edge, the bar's place, a touch's mouse events - passed");
})().catch(e => { console.error(e); process.exit(1); });
