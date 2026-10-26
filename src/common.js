// Helpers shared by the manager window (renderer.js), the edge menu (bar.js) and the voice pages. Loaded as a classic
// script after i18n.js and before the page's own script, so its top-level declarations are visible to it.
const { t, tn } = I18N;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const normPath = p => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const AGENTS = ["Claude", "OpenCode", "Codex"];
const VOICE_MODES = Object.freeze(["verbatim", "clean", "prompt"]); // the dictation modes, as voice/dictation-options.js has them

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  open: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 5v14l11-7z" fill="currentColor"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  raise: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="m9 16 3-3 3 3"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/>',
  // voice pages
  speaker: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a7.5 7.5 0 0 1 0 11"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19"/><path d="M9 7.5h6"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  undo: '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v5h5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14.5 8.5l2 2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.5a8 8 0 1 0 10.8 0"/>'
};
const icon = name => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
I18N.applyI18n(); // the body is parsed by now, and the page's own script has not written into it yet
document.querySelectorAll("[data-icon]").forEach(el => { el.outerHTML = icon(el.dataset.icon); });

// ---------- live status ----------
const sessionKey = s => `${s.agent}:${s.id}`;
const STALE_MS = 10 * 60 * 1000;
const lastSign = l => Math.max(l.activityAt || 0, l.statusAt || 0);
const isStale = l => l.status === "busy" && Date.now() - lastSign(l) > STALE_MS;
const liveRank = l => (l.status === "busy" ? (isStale(l) ? 1 : 0) : 2);
function shortAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return t("time.short.sec", { n: s });
  if (s < 3600) return t("time.short.min", { n: Math.round(s / 60) });
  return t("time.short.hour", { n: Math.round(s / 3600) });
}
function liveText(l) {
  if (l.status === "busy") return t(isStale(l) ? "live.staleFor" : "live.busyFor", { t: shortAgo(lastSign(l)) });
  if (l.status === "idle") return t("live.idleFor", { t: shortAgo(lastSign(l)) });
  return "";
}
// What to say after "show terminal" (terminal-focus.js): nothing when the session's own tab or window came up.
const focusNote = r => (r.ok && !r.reason ? "" : t(`term.focus.${r.reason}`, { app: r.app || "" }));

// ---------- formatting ----------
function ago(ms) {
  if (!ms) return t("time.noDate");
  const sec = (ms - Date.now()) / 1000, abs = Math.abs(sec);
  if (abs < 45) return t("time.justNow");
  if (abs < 3600) return I18N.formatRelative(Math.round(sec / 60), "minute");
  if (abs < 86400) return I18N.formatRelative(Math.round(sec / 3600), "hour");
  if (abs < 7 * 86400) return I18N.formatRelative(Math.round(sec / 86400), "day");
  return I18N.formatDate(ms, { day: "numeric", month: "short", year: "numeric" });
}
const fullDate = ms => (ms ? I18N.formatDateTime(ms) : t("time.unknownDate"));
function dayGroup(ms) {
  if (!ms) return t("time.group.none");
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(ms); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return t("time.group.today");
  if (diff === 1) return t("time.group.yesterday");
  if (diff < 7) return t("time.group.week");
  if (diff < 30) return t("time.group.month");
  return t("time.group.older");
}

// ---------- search ----------
// Every word must match somewhere; "\" and "/" are interchangeable so pasted Windows paths work.
const tokenize = q => q.toLowerCase().replace(/\\/g, "/").split(/\s+/).filter(Boolean);
const matches = (hay, toks) => toks.every(t => hay.includes(t));
const searchable = (...parts) => parts.filter(Boolean).join(" \u0001 ").toLowerCase().replace(/\\/g, "/");

// Escapes `text`, wraps search hits in <mark>, and (for paths) wraps the last segment from `leafAt` in .leaf.
function hl(text, toks, leafAt = -1) {
  text = String(text ?? "");
  if (!toks.length && leafAt < 0) return esc(text);
  const marks = new Uint8Array(text.length);
  const low = text.toLowerCase().replace(/\\/g, "/");
  if (low.length === text.length)
    for (const t of toks) for (let i = low.indexOf(t); i !== -1; i = low.indexOf(t, i + t.length)) marks.fill(1, i, i + t.length);
  let out = "", on = 0;
  for (let i = 0; i < text.length; i++) {
    if (i === leafAt) { if (on) out += "</mark>"; out += '<span class="leaf">'; on = 0; }
    if (marks[i] !== on) { out += marks[i] ? "<mark>" : "</mark>"; on = marks[i]; }
    out += esc(text[i]);
  }
  if (on) out += "</mark>";
  if (leafAt >= 0 && leafAt < text.length) out += "</span>";
  return out;
}
function leafStart(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  return Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/")) + 1;
}
const pathHtml = (p, toks) => `<span class="path">${hl(p, toks, leafStart(p))}</span>`;
const inProject = (s, p) => s.cwdN === p.n || s.cwdN.startsWith(p.n + "/");

// ---------- hidden items ----------
// Projects (by normalized path) and sessions (by sessionKey) tagged as hidden, and whether they are revealed. Kept in
// localStorage, which the edge menu and the manager window share; a change in one reaches the other as "storage".
const HIDDEN_KEY = "agentdeck.hidden";
function readHidden() {
  let h = {};
  try { h = JSON.parse(localStorage.getItem(HIDDEN_KEY)) || {}; } catch {}
  return { reveal: h.reveal === true, projects: new Set(h.projects || []), sessions: new Set(h.sessions || []) };
}
function writeHidden(h) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify({ reveal: h.reveal, projects: [...h.projects], sessions: [...h.sessions] })); } catch {}
}
// Marks what is hidden (.concealed) and, unless revealed, leaves it out. A session is hidden when tagged itself, or when
// every project it belongs to is hidden - so a hidden project's sessions do not turn up in search or the live tile.
function conceal(data, h) {
  const hid = p => h.projects.has(p.n);
  for (const p of data.projects) p.concealed = hid(p);
  for (const s of data.sessions) {
    const owners = data.projects.filter(p => inProject(s, p));
    s.concealed = h.sessions.has(sessionKey(s)) || (owners.length > 0 && owners.every(hid));
  }
  if (h.reveal) return data;
  return {
    projects: data.projects.filter(p => !p.concealed).map(p => ({ ...p, sessions: p.sessions.filter(s => !s.concealed) })),
    sessions: data.sessions.filter(s => !s.concealed)
  };
}

// ---------- data ----------
// Turns the scan result into searchable projects and sessions. `live` maps sessionKey -> live state.
function buildData(raw, live) {
  // A running session that has no transcript yet (nothing sent so far) is still worth showing.
  const known = new Set((raw.sessions || []).map(sessionKey));
  const fresh = [...live.values()].filter(l => !known.has(sessionKey(l)))
    .map(l => ({ agent: l.agent, id: l.id, cwd: l.cwd, title: t("session.new"), prompt: "", updatedAt: l.startedAt }));
  const sessions = [...(raw.sessions || []), ...fresh].map(s => ({
    ...s, cwdN: normPath(s.cwd), hay: searchable(s.title, s.prompt, s.id, s.cwd, s.projectName, s.agent)
  }));
  const projects = (raw.registry?.projects || []).map(p => {
    const proj = { ...p, n: normPath(p.path), hay: searchable(p.name, p.path) };
    proj.sessions = sessions.filter(s => inProject(s, proj));
    proj.last = proj.sessions.reduce((m, s) => Math.max(m, s.updatedAt || 0), 0);
    // A session can be found by the (possibly renamed) name of any project it belongs to.
    for (const s of proj.sessions) s.hay += " \u0001 " + p.name.toLowerCase();
    return proj;
  }).sort((a, b) => b.last - a.last || a.name.localeCompare(b.name, I18N.locale()));
  return { projects, sessions };
}
