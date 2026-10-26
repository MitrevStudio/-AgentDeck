// Tells when a Claude Code session stops working - it finished, or it waits for an answer or a permission - with a
// tray balloon that brings its terminal up, and keeps the list of such sessions for the tray (badge, tooltip, menu).
//
// Fed by the live registry (live.js), polled here every few seconds whether or not a window is open. A session only
// counts after it worked for a while, so a quick reply does not ring; a balloon is skipped while the edge menu is
// out (the user is looking at the sessions already). A waiting session leaves the list when it works again, when it
// is brought up from here, or when its process ends.
const fs = require("node:fs");
const path = require("node:path");

const POLL_MS = 3000;
const MIN_BUSY_MS = 15000;

// liveSessions() -> [{agent, id, cwd, status, ...}]; describe(agent, id, cwd) -> {title, project}; balloon(text,
// {title, onClick}); focus({agent, id}); quiet() -> true while balloons should wait; onChange() when the list changed;
// t/tn: i18n; file: where "enabled" is kept.
function createNotifier({ liveSessions, describe, balloon, focus, quiet = () => false, onChange = () => {}, t, tn, file }) {
  const prev = new Map();    // key -> {status, since}
  const waiting = new Map(); // key -> {key, agent, id, cwd, title, project, at}
  let enabled = true, timer = null, polling = false;
  try { enabled = JSON.parse(fs.readFileSync(file, "utf8")).enabled !== false; } catch {}

  function save() {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ enabled })); }
    catch (e) { console.error("Could not save the notification setting:", e.message); }
  }

  function announce(fresh) {
    if (!enabled || !fresh.length || quiet()) return;
    if (fresh.length === 1) {
      const w = fresh[0];
      balloon(t("notify.body", { project: w.project }), { title: t("notify.title", { title: w.title }), onClick: () => bringUp(w.key) });
    } else {
      balloon(fresh.map(w => `• ${w.title}`).join("\n"), { title: tn("notify.many", fresh.length), onClick: () => bringUp(fresh[0].key) });
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      let list;
      try { list = await liveSessions(); } catch { return; }
      const now = Date.now(), seen = new Set(), fresh = [];
      let changed = false;
      for (const l of list) {
        const key = `${l.agent}:${l.id}`;
        seen.add(key);
        const p = prev.get(key);
        if (l.status === "busy") {
          if (p?.status !== "busy") prev.set(key, { status: "busy", since: now });
          if (waiting.delete(key)) changed = true;
          continue;
        }
        if (p?.status === "busy" && now - p.since >= MIN_BUSY_MS && !waiting.has(key)) {
          const d = describe(l.agent, l.id, l.cwd) || {};
          const w = { key, agent: l.agent, id: l.id, cwd: l.cwd, title: d.title || l.id.slice(0, 8), project: d.project || path.basename(l.cwd || ""), at: now };
          waiting.set(key, w);
          fresh.push(w);
          changed = true;
        }
        if (p?.status !== l.status) prev.set(key, { status: l.status, since: now });
      }
      for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k);
      for (const k of [...waiting.keys()]) if (!seen.has(k)) { waiting.delete(k); changed = true; }
      announce(fresh);
      if (changed) onChange();
    } finally { polling = false; }
  }

  function bringUp(key) {
    const w = waiting.get(key);
    if (!w) return;
    waiting.delete(key);
    onChange();
    Promise.resolve(focus({ agent: w.agent, id: w.id })).catch(e => console.error("Could not bring the session up:", e.message));
  }

  return {
    start() { if (!timer) { timer = setInterval(poll, POLL_MS); poll(); } },
    stop() { clearInterval(timer); timer = null; },
    // Newest first.
    list: () => [...waiting.values()].sort((a, b) => b.at - a.at),
    bringUp,
    clear() { if (waiting.size) { waiting.clear(); onChange(); } },
    // A session brought up some other way (the menu's "show terminal") is no longer waiting for the user.
    seen(agent, id) { if (waiting.delete(`${agent}:${id}`)) onChange(); },
    enabled: () => enabled,
    setEnabled(on) { enabled = Boolean(on); save(); onChange(); }
  };
}

module.exports = { createNotifier, POLL_MS, MIN_BUSY_MS };
