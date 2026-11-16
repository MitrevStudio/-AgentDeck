// One read for everyone who asks. The live status (live.js, codex-live.js) is asked for by many at once - each window
// every 2 s, the notifier, the tab links and the peers every 3 s, the command centre, the autopilot - and a read costs
// a file operation per session and per subagent. Where something slows those down (an endpoint agent that inspects
// every file that is opened), the cost must not grow with the number of askers:
//   * askers that come while a read is under way share it;
//   * a finished read answers for keepMs more (KEEP_MS: shorter than the fastest poll, so whoever polls every 2 s or
//     3 s still gets a new read each time, while those that come together get one between them);
//   * a read that failed is not kept: the next asker reads again.
//
// The rule for callers: the kept answer is right for everything that shows or watches the status (lists, the tray,
// notifications, pushes to peers, loops that wait for a change - they ask again anyway). Whoever acts on the answer
// right away and must not act on an old one - refusing to delete or resume a running session, stopping one by its
// PID, typing into an agent that must be waiting for input - asks with { fresh: true }: answered by a read begun
// after the question. A read already under way began before it and may have missed the change, so it is waited for
// and a new one follows, which everyone who asked for a fresh one meanwhile shares, and which is kept like any other.
//
// Every asker gets a copy of its own: nothing a caller does to its list reaches the kept one or another caller's.
const KEEP_MS = 1000;

// read(): a promise of the value (plain data). key(): what the value depends on besides what read() looks at, as a
// string - a kept value is only given out while it is the same (codex-live.js: the open terminals). now, copy: for
// tests. -> get({ fresh }) -> a promise of a copy of the value.
function createSharedRead(read, { keepMs = KEEP_MS, key = () => "", now = Date.now, copy = structuredClone } = {}) {
  let flight = null; // the read under way
  let queued = null; // the read that follows it, for those who asked for a fresh one meanwhile
  let last = null;   // { value, at, key }: the last finished read
  function start() {
    const readFor = key();
    const mine = flight = Promise.resolve().then(read).then(value => {
      last = { value, at: now(), key: readFor }; // kept from its end: a slow read is not followed by another at once
      return value;
    });
    const done = () => { if (flight === mine) flight = null; };
    mine.then(done, done);
    return mine;
  }
  const isKept = () => {
    if (!last || last.key !== key()) return false;
    const age = now() - last.at;
    return age >= 0 && age < keepMs; // a clock set back keeps nothing
  };
  return function get({ fresh = false } = {}) {
    let value;
    if (fresh) {
      if (flight) queued ||= flight.then(() => {}, () => {}).then(() => { queued = null; return start(); });
      value = flight ? queued : start();
    } else if (flight || queued) value = flight || queued;
    else if (isKept()) value = Promise.resolve(last.value);
    else value = start();
    return value.then(copy);
  };
}

module.exports = { createSharedRead, KEEP_MS };
