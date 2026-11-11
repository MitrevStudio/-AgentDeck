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
// - a pair.start counts against its source when it comes, as a wrong code would (each one costs this node a CPace
//   computation, and a start that is never finished would otherwise cost nothing to repeat); a right code clears it,
//   and the wrong code that may follow it is not counted twice;
// - at most MAX_PER_SOURCE connections of one source, and MAX_PENDING in all, waiting to pair at a time - only those
//   that showed a key or certificate this node does not know. Before that (createAdmission below) a connection is
//   nobody yet, and a paired phone looks like any stranger until its Noise handshake is through: those take a place
//   in a budget of their own, which strangers cannot fill to keep paired nodes out.
// The wrong tries are counted for Settings -> Computers (stats()).
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const GLOBAL_PER_MINUTE = 10;
const GLOBAL_LOCK_MS = 60 * 1000;
const MAX_PENDING = 64;
const MAX_PER_SOURCE = 4;
const MAX_SOURCES = 1000;
const FORGET_MS = 60 * 60 * 1000;

// ---------- sources ----------
// An IPv6 address's /64 ("2001:db8:1:2::/64"): one network, which may hold any number of addresses. "" for IPv4.
function ipv6Net(a) {
  if (!a.includes(":")) return "";
  const [head, tail = ""] = a.split("::");
  const h = head ? head.split(":") : [], tl = a.includes("::") && tail ? tail.split(":") : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill("0"), ...tl];
  return `${groups.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(":")}::/64`;
}
// A connection's remote address as a source: { address, key, loopback }. An IPv4 address is itself, also when a
// server listening on "::" shows it IPv4-mapped ("::ffff:a.b.c.d"); an IPv6 address counts as its /64. loopback: it
// came from this machine (127.0.0.1, ::1) - where a relay tunnel's last hop comes from (relay.js).
function addressSource(address) {
  const a = String(address || "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return { address: a, key: ipv6Net(a) || a || "?", loopback: a === "127.0.0.1" || a === "::1" };
}

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
  // { ok } or { ok: false, waitMs }: whether `source` may try a code now. started: the try began already (its
  // pair.start passed here and was counted): only the lock for everyone holds it back, not the wait its own start set.
  function allowed(source, { started = false } = {}) {
    const t = now();
    prune(t);
    const wait = Math.max(lockedUntil - t, started ? 0 : (sources.get(source)?.nextAt || 0) - t, 0);
    return wait > 0 ? { ok: false, waitMs: wait } : { ok: true };
  }
  // One more try of `source`: its next one waits twice as long as the last.
  function count(source, t) {
    const s = sources.get(source) || { fails: 0, nextAt: 0, lastAt: 0 };
    s.fails++;
    s.lastAt = t;
    s.nextAt = t + Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (s.fails - 1));
    sources.delete(source); // to the end: the newest stay when there are too many
    sources.set(source, s);
  }
  // A pair.start: counted as a wrong code is, until a right one clears it (succeeded).
  function started(source) {
    const t = now();
    prune(t);
    count(source, t);
  }
  // label: how the source is shown (Settings, the log). started: the try's pair.start was counted already (started()),
  // so the source's wait does not double again; the wrong code still counts for the lock and for Settings.
  function failed(source, label = source, { started: counted = false } = {}) {
    const t = now();
    prune(t);
    if (!counted) count(source, t);
    recent.push(t);
    if (globalLock && recent.length >= GLOBAL_PER_MINUTE) lockedUntil = t + GLOBAL_LOCK_MS;
    stats.failures++;
    stats.lastSource = label;
    stats.lastAt = t;
  }
  const succeeded = source => { sources.delete(source); };

  return { admit, allowed, started, failed, succeeded, stats: () => ({ ...stats }) };
}

// ---------- before a connection is somebody ----------
// From its first moment (server.js: the TCP accept; a relay tunnel: relay.open) until it shows who it is (a TLS
// certificate, a Noise key - links.js), a connection is nobody: a paired phone and a stranger look the same. Each takes
// a place here, for at most ADMIT_MS (then it is closed), and the places are never refused, only taken back:
// - one more of a source that has ADMIT_PER_SOURCE already: that source's oldest goes - a source crowds out only
//   itself (and whoever shares its address, who then needs only a handshake's time between two of its connections);
// - one more when ADMIT_TOTAL wait in all: the oldest of the source with the most in the group with the most goes.
//   A group is where connections come from (an address; a relay tunnel's neighbour), a source what can be told apart
//   inside it (an address; the node that opened the tunnel, as that neighbour says) - so a node that only gets one
//   place is pushed out only when ADMIT_TOTAL groups have a place each at the same time, and one neighbour's tunnels
//   cannot crowd out the others' connections.
// So holding connections open keeps nobody out, and a paired phone is through its handshake, and out of here, long
// before anyone can push it out. fds stay bounded: at most ADMIT_TOTAL of these at a time.
const ADMIT_MS = 10000;
const ADMIT_PER_SOURCE = 16;
const ADMIT_TOTAL = 256;

function createAdmission({ perSource = ADMIT_PER_SOURCE, total = ADMIT_TOTAL, deadlineMs = ADMIT_MS } = {}) {
  const groups = new Map(); // group -> { size, sources: Map(source -> its entries, oldest first) }
  let size = 0, seq = 0;

  function drop(e) {
    if (e.gone) return false;
    e.gone = true;
    clearTimeout(e.timer);
    size--;
    const g = groups.get(e.group), list = g.sources.get(e.source);
    list.splice(list.indexOf(e), 1);
    if (!list.length) g.sources.delete(e.source);
    if (!--g.size) groups.delete(e.group);
    return true;
  }
  function evict(e) {
    if (!drop(e)) return;
    try { e.kill(); } catch {}
  }
  const oldestOf = lists => Math.min(...[...lists].map(l => l[0].seq));
  // The one to go when all places are taken: the largest group, the largest source in it, its oldest (ties: oldest).
  function victim() {
    let g = null;
    for (const x of groups.values()) if (!g || x.size > g.size || (x.size === g.size && oldestOf(x.sources.values()) < oldestOf(g.sources.values()))) g = x;
    let list = null;
    for (const l of g.sources.values()) if (!list || l.length > list.length || (l.length === list.length && l[0].seq < list[0].seq)) list = l;
    return list[0];
  }
  // { group, source } (group: defaults to the source); kill(): closes the connection. -> release(): it is somebody
  // now, or gone (once is enough; more do nothing).
  function admit({ group, source }, kill) {
    group = group || source;
    const mine = groups.get(group)?.sources.get(source);
    if (mine && mine.length >= perSource) evict(mine[0]);
    else if (size >= total) evict(victim());
    const e = { group, source, kill, seq: ++seq, gone: false, timer: null };
    if (!groups.has(group)) groups.set(group, { size: 0, sources: new Map() });
    const g = groups.get(group);
    if (!g.sources.has(source)) g.sources.set(source, []);
    g.sources.get(source).push(e);
    g.size++;
    size++;
    e.timer = setTimeout(() => evict(e), deadlineMs);
    e.timer.unref?.();
    return () => { drop(e); };
  }
  return { admit, size: () => size, of: source => [...groups.values()].reduce((n, g) => n + (g.sources.get(source)?.length || 0), 0) };
}

module.exports = { createPairGuard, createAdmission, addressSource, ipv6Net, BASE_DELAY_MS, MAX_DELAY_MS, GLOBAL_PER_MINUTE, GLOBAL_LOCK_MS, MAX_PENDING, MAX_PER_SOURCE,
  ADMIT_MS, ADMIT_PER_SOURCE, ADMIT_TOTAL };
