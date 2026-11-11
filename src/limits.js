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
const { createCodexLimits } = require("./codex-limits");

const CREDENTIALS = path.join(os.homedir(), ".claude", ".credentials.json");
const URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 5 * 60 * 1000;
const FRESH_MS = 60 * 1000;
const HOUR = 3600 * 1000;
const WEEK = 7 * 24 * HOUR;
const WINDOWS = { five_hour: 5 * HOUR, seven_day: WEEK };
// The burn is measured over the recent past (a quiet morning should not hide a busy last hour), at least this long.
const rateSpan = len => Math.min(len, len >= WEEK ? 24 * HOUR : HOUR);
// A week judged by twenty busy minutes would always look about to run out.
const minSpan = len => Math.min(rateSpan(len) / 2, len >= WEEK ? 2 * HOUR : 10 * 60 * 1000);
const MIN_ELAPSED = 10 * 60 * 1000;

const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// One window of `len` ms, `u` % used, resetting at `reset` (0 = unknown): how far into it we are and, from the burn
// over the recent samples (`list`, [{at, u, reset}], kept here), when it would be full.
function forecast(list, len, u, reset, now) {
  if (list.length && (list.at(-1).reset !== reset || list.at(-1).u > u)) list.length = 0; // a new window began
  list.push({ at: now, u, reset });
  while (list.length > 400 || (list.length && now - list[0].at > rateSpan(len) * 2)) list.shift();
  const elapsed = reset ? Math.max(0, Math.min(len, now - (reset - len))) : 0;
  // Burn: across the recent samples when they span long enough, otherwise the average since the window began.
  const recent = list.filter(s => now - s.at <= rateSpan(len));
  let rate = 0;
  if (recent.length > 1 && now - recent[0].at >= minSpan(len)) rate = Math.max(0, (u - recent[0].u) / (now - recent[0].at));
  else if (elapsed > MIN_ELAPSED) rate = u / elapsed;
  const fullAt = u >= 100 ? now : rate > 0 ? now + (100 - u) / rate : 0;
  return { util: u, resetsAt: reset, elapsedPct: reset ? Math.round(elapsed / len * 100) : null, fullAt,
    runsOut: Boolean(fullAt && reset && fullAt < reset) };
}

// fetch(url, init) -> Response (network.js, so the user's proxy applies); onChange(state).
function createLimits({ fetch, onChange = () => {} }) {
  let state = { at: 0, checkedAt: 0, error: "", windows: [], scoped: [] };
  const samples = { five_hour: [], seven_day: [] }; // [{at, u, reset}]
  let refusedAt = 0; // credentials mtime when the token was refused
  let timer = null, inFlight = null;

  function token() {
    if (refusedAt && mtime(CREDENTIALS) === refusedAt) return { error: "expired" };
    try {
      const o = JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"))?.claudeAiOauth;
      return o?.accessToken ? { value: o.accessToken, plan: String(o.subscriptionType || "") } : { error: "noLogin" };
    } catch { return { error: "noLogin" }; }
  }

  async function poll() {
    const tk = token();
    if (tk.error) { state = { at: 0, checkedAt: Date.now(), error: tk.error, windows: [], scoped: [] }; return; }
    state = { ...state, plan: tk.plan };
    let res;
    try {
      res = await fetch(URL, { headers: { Authorization: `Bearer ${tk.value}`, "anthropic-beta": "oauth-2025-04-20" } });
    } catch (e) { state = { ...state, checkedAt: Date.now(), error: "network", detail: e.message }; return; }
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) { refusedAt = mtime(CREDENTIALS); state = { at: 0, checkedAt: Date.now(), error: "expired", windows: [], scoped: [] }; return; }
    if (!res.ok) { state = { ...state, checkedAt: Date.now(), error: "http", detail: String(res.status) }; return; }
    let data;
    try { data = JSON.parse(body); } catch { state = { ...state, checkedAt: Date.now(), error: "http", detail: "JSON" }; return; }
    refusedAt = 0;
    const now = Date.now();
    const windows = Object.keys(WINDOWS).filter(k => data?.[k]).map(k => ({ key: k,
      ...forecast(samples[k], WINDOWS[k], Number(data[k].utilization) || 0, Date.parse(data[k].resets_at) || 0, now) }));
    // Weekly limits of one model ("Fable"), from the newer `limits` list.
    const scoped = (Array.isArray(data?.limits) ? data.limits : [])
      .filter(l => l?.kind === "weekly_scoped" && l.scope?.model?.display_name)
      .map(l => ({ name: l.scope.model.display_name, util: Number(l.percent) || 0, resetsAt: Date.parse(l.resets_at) || 0 }));
    state = { at: now, checkedAt: now, error: "", windows, scoped, plan: tk.plan };
  }

  function refresh(force = false) {
    if (!force && Date.now() - state.checkedAt < FRESH_MS) return Promise.resolve(state);
    if (!inFlight) {
      const before = JSON.stringify(state);
      inFlight = poll()
        .catch(e => { state = { ...state, checkedAt: Date.now(), error: "network", detail: e.message }; })
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

// Claude keeps its own polling above; Codex gets its own clock, errors and samples, with the same forecast. A failure
// in one source does not affect the other.
function createAllLimits({ fetch, findExecutable, onChange = () => {} }) {
  const codex = createCodexLimits();
  const codexSamples = new Map();
  let codexState = { installed: false, at: 0, checkedAt: 0, error: "", windows: [] };
  let claudeState = { installed: false, at: 0, error: "", windows: [], scoped: [] };
  let timer = null, flight = null, stopped = false;
  const snapshot = () => ({ providers: { claude: claudeState, codex: codexState } });
  const publish = () => { if (!stopped) onChange(snapshot()); };
  const claude = createLimits({ fetch, onChange: state => { claudeState = { ...state, installed: true }; publish(); } });

  function codexForecast(w, now) {
    if (!codexSamples.has(w.key)) codexSamples.set(w.key, []);
    return { ...w, ...forecast(codexSamples.get(w.key), w.durationMins * 60000, w.util, w.resetsAt, now) };
  }

  async function refreshCodex(force, exe) {
    if (flight) return flight;
    if (!force && Date.now() - codexState.checkedAt < FRESH_MS) return;
    flight = (async () => {
      if (stopped) return;
      if (!exe) { codexState = { installed: false, at: 0, checkedAt: Date.now(), error: "", windows: [] }; codexSamples.clear(); publish(); return; }
      codexState = { ...codexState, installed: true, loading: true }; publish();
      try {
        const windows = await codex.read(exe);
        if (stopped) return;
        const at = Date.now();
        codexState = { installed: true, at, checkedAt: at, loading: false, error: "",
          windows: windows.map(w => codexForecast(w, at)) };
      } catch (e) {
        if (stopped) return;
        const error = ["noLogin", "accountType", "timeout", "unsupported", "unavailable"].includes(e.message) ? e.message : "network";
        if (["noLogin", "accountType"].includes(error)) { codexSamples.clear(); codexState.windows = []; codexState.at = 0; }
        codexState = { ...codexState, checkedAt: Date.now(), loading: false, error };
      }
      publish();
    })().finally(() => { flight = null; });
    return flight;
  }

  async function refresh(force = false) {
    const installed = await Promise.all(["claude", "codex"].map(name => findExecutable(name).catch(() => "")));
    if (stopped) return snapshot();
    if (!installed[0]) {
      claudeState = { installed: false, at: 0, error: "", windows: [], scoped: [] };
      publish();
    } else claudeState.installed = true;
    await Promise.all([installed[0] ? claude.refresh(force) : null, refreshCodex(force, installed[1])]);
    return snapshot();
  }
  return {
    start() { stopped = false; if (!timer) { timer = setInterval(() => refresh(true).catch(() => {}), POLL_MS); refresh(true).catch(() => {}); } },
    stop() { stopped = true; clearInterval(timer); timer = null; claude.stop(); codex.stop(); },
    refresh, get: snapshot
  };
}

module.exports = { createLimits, createAllLimits, forecast };
