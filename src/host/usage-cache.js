// The usage worker's cache on disk (usage-worker.js): what every transcript and OpenCode's database yielded, so a
// restart reads only what was added since. Two files in userData:
// - usage-cache.json, the base: { v, gen, files: { path: entry }, openCode }, written whole and atomically;
// - usage-cache.journal beside it, append-only: a header line { v, gen } and then one JSON line per change since the
//   base - { f: path, e: entry } (the file's entry replaced), { f: path, e: null } (the file is gone) or { oc: {…} }
//   (the OpenCode part replaced).
// A save appends only what changed, so a working session costs one line (its own entry) instead of a rewrite of
// everything. Loading reads the base and then the journal's lines in order. The journal is folded into a new base
// (compact) once it has grown past a share of the base; the base is written first and the journal removed after, and
// each base carries a generation the journal must name - one left over from before a newer base is ignored. A line
// replaces an entry whole, so applying one twice changes nothing, and a last line cut short by a crash is dropped.
const fs = require("node:fs");
const atomic = require("../shared/atomic-file");

const JOURNAL_MIN = 4 * 1024 * 1024;   // the journal may always grow to this…
const JOURNAL_MAX = 64 * 1024 * 1024;  // …and never past this, however large the base
const FLUSH_MAX = 1024 * 1024;         // quitting folds a journal larger than this into the base

const recMap = list => new Map((list || []).map(r => [r[0], r]));
const emptyOpenCode = () => ({ stamp: "", since: 0, sessions: [], contexts: {}, msgs: new Map() });
const emptyCache = () => ({ files: new Map(), openCode: emptyOpenCode() });
// As read from disk (records in a list) -> as kept in memory (records by key), and back.
const fileIn = e => ({ ...e, msgs: recMap(e.msgs) });
const fileOut = e => ({ ...e, msgs: [...e.msgs.values()] });
const openCodeIn = (oc = {}) => ({ stamp: oc.stamp || "", since: oc.since || 0, sessions: oc.sessions || [], contexts: oc.contexts || {}, msgs: recMap(oc.msgs) });
const openCodeOut = oc => ({ ...oc, msgs: [...oc.msgs.values()] });

// file: the base's path; version: of the entries' format - a cache of another version is not read.
// tuning (the tests): { journalMin, journalMax, flushMax }.
function createStore(file, version, tuning = {}) {
  const journalFile = file.replace(/\.json$/, "") + ".journal";
  const journalMin = tuning.journalMin ?? JOURNAL_MIN, journalMax = tuning.journalMax ?? JOURNAL_MAX, flushMax = tuning.flushMax ?? FLUSH_MAX;
  // gen: the base's generation; journal: its size once it is known to continue this base and to end with a whole
  // line (it can be appended to), null otherwise (the next save starts it anew).
  // usable: the base on disk can be continued by a journal; otherwise the next save writes a new one.
  let gen = 0, baseSize = 0, journal = null, usable = false;

  function load() {
    const cache = emptyCache();
    gen = 0; baseSize = 0; journal = null; usable = false;
    try {
      const text = fs.readFileSync(file, "utf8");
      const raw = JSON.parse(text);
      if (raw.v !== version) return cache;
      for (const [f, e] of Object.entries(raw.files || {})) cache.files.set(f, fileIn(e));
      cache.openCode = openCodeIn(raw.openCode);
      gen = Number.isSafeInteger(raw.gen) && raw.gen > 0 ? raw.gen : 0;
      baseSize = Buffer.byteLength(text);
      // A base written before there were generations has none: the first save replaces it, and no journal names 0.
      usable = gen > 0;
    } catch { return emptyCache(); }
    let lines;
    try { lines = fs.readFileSync(journalFile, "utf8").split("\n"); } catch { return cache; }
    // Whole lines end with a newline, so the last piece is empty - or the start of a line that was never finished.
    const torn = lines.pop() !== "";
    let good = 0;
    try {
      const head = JSON.parse(lines[0]);
      if (head.v !== version || !gen || head.gen !== gen) return cache;
      for (good = 1; good < lines.length; good++) {
        const x = JSON.parse(lines[good]);
        if (x.oc) cache.openCode = openCodeIn(x.oc);
        else if (typeof x.f !== "string") throw Error("Not a journal line");
        else if (x.e) cache.files.set(x.f, fileIn(x.e));
        else cache.files.delete(x.f);
      }
    } catch { /* what follows a line that cannot be read is not applied; the files it was about are checked anyway */ }
    if (!torn && good === lines.length) journal = lines.reduce((sum, l) => sum + Buffer.byteLength(l) + 1, 0);
    // Lines were applied but nothing can be appended after them: the next save writes a new base instead.
    else if (good > 1) usable = false;
    return cache;
  }

  // The whole cache as a new base; the journal it replaces goes after it. A crash in between leaves a journal of the
  // previous generation, which load() ignores.
  async function compact(cache) {
    const files = Object.fromEntries([...cache.files].map(([f, e]) => [f, fileOut(e)]));
    const text = JSON.stringify({ v: version, gen: gen + 1, files, openCode: openCodeOut(cache.openCode) });
    await atomic.write(file, text);
    gen++; baseSize = Buffer.byteLength(text); usable = true;
    journal = null;
    await atomic.remove(journalFile).catch(() => {}); // still there (held open by a scanner): overwritten by the next save
  }

  // What changed since the last save: changed - the paths whose entry was replaced or removed; openCode - whether
  // that part changed. whole: write a new base whatever the journal's size. Returns "base", "journal" or "" (nothing
  // to write).
  async function save(cache, changed, openCode, { whole = false } = {}) {
    if (!changed.size && !openCode && !whole) return "";
    if (whole || !usable) { await compact(cache); return "base"; }
    let text = journal == null ? JSON.stringify({ v: version, gen }) + "\n" : "";
    for (const f of changed) {
      const e = cache.files.get(f);
      text += JSON.stringify({ f, e: e ? fileOut(e) : null }) + "\n";
    }
    if (openCode) text += JSON.stringify({ oc: openCodeOut(cache.openCode) }) + "\n";
    const size = (journal || 0) + Buffer.byteLength(text);
    if (size > Math.min(journalMax, Math.max(journalMin, baseSize))) { await compact(cache); return "base"; }
    const was = journal;
    journal = null; // unknown while it is being written: a failed append may leave half a line
    try { await fs.promises.writeFile(journalFile, text, { encoding: "utf8", flag: was == null ? "w" : "a" }); }
    catch (e) { usable = false; throw e; } // the next save writes a new base, which needs no journal
    journal = size;
    return "journal";
  }

  // Quitting: a journal that is not small is folded in, so the next start reads one file.
  async function tidy(cache) {
    if (journal != null && journal > flushMax) await compact(cache);
  }

  return { load, save, compact, tidy, journalFile, state: () => ({ gen, baseSize, journal }) };
}

module.exports = { createStore, emptyCache, emptyOpenCode };
