// How fast pairing codes may be tried. A node that is not paired may only pair (links.js), and each wrong code makes
// the next try wait longer:
// - one try per connection: a wrong code closes it;
// - per source (an IPv4 address, an IPv6 /64, or the neighbour a relay tunnel came through - those all come from
//   127.0.0.1), each wrong code doubles the wait before its next try (1 s, 2 s, 4 s, ... up to 5 minutes); a right
//   one clears it;
// - on a node with a six-digit code (globalLock: a desktop), at most GLOBAL_PER_MINUTE wrong codes a minute from all
//   sources together; then pairing waits a minute, so many addresses at once do not help either (a six-digit code
//   would take about a month of trying on average). A host's long code cannot be guessed anyway, and there the lock
//   would only let anyone with a few addresses keep pairing shut, so a host has none;
// - at most MAX_PER_SOURCE connections of one source, and MAX_PENDING in all, waiting to pair at a time.
// The wrong tries are counted for Settings -> Computers (stats()).
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const GLOBAL_PER_MINUTE = 10;
const GLOBAL_LOCK_MS = 60 * 1000;
const MAX_PENDING = 64;
const MAX_PER_SOURCE = 4;
const MAX_SOURCES = 1000;
const FORGET_MS = 60 * 60 * 1000;

function createPairGuard({ now = Date.now, globalLock = true } = {}) {
  const sources = new Map(); // source -> { fails, nextAt, lastAt }
  let recent = [];           // the times of the wrong codes of the last minute, all sources
  let lockedUntil = 0, pending = 0;
  const pendingBy = new Map(); // source -> connections of it waiting to pair
  const stats = { failures: 0, lastSource: "", lastAt: 0 };

  function prune(t) {
    recent = recent.filter(at => t - at < 60 * 1000);
    for (const [k, s] of sources) if (t - s.lastAt > FORGET_MS) sources.delete(k);
    // Many sources at once: the oldest go (they could only wait less than they should).
    while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value);
  }
  // A connection of `source` that may pair takes a place: answers release(), which gives it back; null when too many
  // (of that source, or in all) wait already.
  function admit(source) {
    const mine = pendingBy.get(source) || 0;
    if (pending >= MAX_PENDING || mine >= MAX_PER_SOURCE) return null;
    pending++;
    pendingBy.set(source, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pending--;
      const left = (pendingBy.get(source) || 1) - 1;
      if (left) pendingBy.set(source, left); else pendingBy.delete(source);
    };
  }
  // { ok } or { ok: false, waitMs }: whether `source` may try a code now.
  function allowed(source) {
    const t = now();
    prune(t);
    const wait = Math.max(lockedUntil - t, (sources.get(source)?.nextAt || 0) - t, 0);
    return wait > 0 ? { ok: false, waitMs: wait } : { ok: true };
  }
  // label: how the source is shown (Settings, the log).
  function failed(source, label = source) {
    const t = now();
    prune(t);
    const s = sources.get(source) || { fails: 0, nextAt: 0, lastAt: 0 };
    s.fails++;
    s.lastAt = t;
    s.nextAt = t + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (s.fails - 1));
    sources.delete(source); // to the end: the newest stay when there are too many
    sources.set(source, s);
    recent.push(t);
    if (globalLock && recent.length >= GLOBAL_PER_MINUTE) lockedUntil = t + GLOBAL_LOCK_MS;
    stats.failures++;
    stats.lastSource = label;
    stats.lastAt = t;
  }
  const succeeded = source => { sources.delete(source); };

  return { admit, allowed, failed, succeeded, stats: () => ({ ...stats }) };
}

module.exports = { createPairGuard, BASE_DELAY_MS, MAX_DELAY_MS, GLOBAL_PER_MINUTE, GLOBAL_LOCK_MS, MAX_PENDING, MAX_PER_SOURCE };
