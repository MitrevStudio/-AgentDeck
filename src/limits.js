// Claude plan limits as claude.ai counts them for the account Claude Code is logged in with: the 5-hour session
// window and the weekly one (plus any model-scoped weekly limit), with how far into each window we are and, from the
// recent burn, whether the limit runs out before the window resets.
//
// The figures come from the endpoint Claude Code's own /usage reads, called with the access token Claude Code keeps in
// ~/.claude/.credentials.json. The token is only read, never refreshed here: refreshing would rotate it under Claude
// Code. When it has expired, nothing is asked again until Claude Code writes a new one (the file changes).
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");
const URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 5 * 60 * 1000;
const FRESH_MS = 60 * 1000;
const HOUR = 3600 * 1000;
const WINDOWS = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR };
// The burn is measured over the recent past (a quiet morning should not hide a busy last hour), at least this long.
const RATE_SPAN = { five_hour: HOUR, seven_day: 24 * HOUR };
// A week judged by twenty busy minutes would always look about to run out.
const MIN_SPAN = { five_hour: 10 * 60 * 1000, seven_day: 2 * HOUR };

const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// fetch(url, init) -> Response (network.js, so the user's proxy applies); onChange(state).
function createLimits({ fetch, onChange = () => {} }) {
  let state = { at: 0, error: "", windows: [], scoped: [] };
  const samples = { five_hour: [], seven_day: [] }; // [{at, u, reset}]
  let refusedAt = 0; // credentials mtime when the token was refused
  let timer = null, inFlight = null;

  function token() {
    if (refusedAt && mtime(CREDENTIALS) === refusedAt) return { error: "expired" };
    try {
      const o = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"))?.claudeAiOauth;
      return o?.accessToken ? { value: o.accessToken } : { error: "noLogin" };
    } catch { return { error: "noLogin" }; }
  }

  function forecast(key, w, now) {
    const u = Number(w.utilization) || 0, reset = Date.parse(w.resets_at) || 0, len = WINDOWS[key];
    const list = samples[key];
    if (list.length && list.at(-1).reset !== reset) list.length = 0; // a new window began
    list.push({ at: now, u, reset });
    while (list.length > 400 || (list.length && now - list[0].at > RATE_SPAN[key] * 2)) list.shift();
    const start = reset ? reset - len : now;
    const elapsed = Math.max(0, Math.min(len, now - start));
    // Burn: across the recent samples when they span long enough, otherwise the average since the window began.
    const recent = list.filter(s => now - s.at <= RATE_SPAN[key]);
    let rate = 0;
    if (recent.length > 1 && now - recent[0].at >= MIN_SPAN[key]) rate = Math.max(0, (u - recent[0].u) / (now - recent[0].at));
    else if (elapsed > MIN_SPAN.five_hour) rate = u / elapsed;
    const fullAt = u >= 100 ? now : rate > 0 ? now + (100 - u) / rate : 0;
    return { key, util: u, resetsAt: reset, elapsedPct: Math.round(elapsed / len * 100), fullAt, runsOut: Boolean(fullAt && reset && fullAt < reset) };
  }

  async function poll() {
    const tk = token();
    if (tk.error) { state = { ...state, at: Date.now(), error: tk.error }; return; }
    let res;
    try {
      res = await fetch(URL, { headers: { Authorization: `Bearer ${tk.value}`, "anthropic-beta": "oauth-2025-04-20" } });
    } catch (e) { state = { ...state, at: Date.now(), error: "network", detail: e.message }; return; }
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) { refusedAt = mtime(CREDENTIALS); state = { ...state, at: Date.now(), error: "expired" }; return; }
    if (!res.ok) { state = { ...state, at: Date.now(), error: "http", detail: String(res.status) }; return; }
    let data;
    try { data = JSON.parse(body); } catch { state = { ...state, at: Date.now(), error: "http", detail: "JSON" }; return; }
    refusedAt = 0;
    const now = Date.now();
    const windows = Object.keys(WINDOWS).filter(k => data?.[k]).map(k => forecast(k, data[k], now));
    // Weekly limits of one model ("Fable"), from the newer `limits` list.
    const scoped = (Array.isArray(data?.limits) ? data.limits : [])
      .filter(l => l?.kind === "weekly_scoped" && l.scope?.model?.display_name)
      .map(l => ({ name: l.scope.model.display_name, util: Number(l.percent) || 0, resetsAt: Date.parse(l.resets_at) || 0 }));
    state = { at: now, error: "", windows, scoped };
  }

  function refresh(force = false) {
    if (!force && Date.now() - state.at < FRESH_MS) return Promise.resolve(state);
    if (!inFlight) {
      const before = JSON.stringify(state);
      inFlight = poll()
        .catch(e => { state = { ...state, at: Date.now(), error: "network", detail: e.message }; })
        .then(() => { if (JSON.stringify(state) !== before) onChange(state); return state; })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  return {
    start() { if (!timer) { timer = setInterval(() => refresh(true), POLL_MS); refresh(true); } },
    stop() { clearInterval(timer); timer = null; },
    refresh,
    get: () => state
  };
}

module.exports = { createLimits };
