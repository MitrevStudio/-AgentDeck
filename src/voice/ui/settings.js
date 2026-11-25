// The app's Settings page. General (language, theme, edge menu, updates) applies at once through window.prefs; the
// voice settings - a port of VoiceTray's SettingsWindow plus the two hotkeys, the modes, the dictionary and the models
// - are one record over five tabs (Models, Dictation, Dictionary, Read aloud, Meetings) saved by one Save; Commands applies at once
// (settings-commands.js); Network (the proxy) has a Save of its own. Secrets never come here: the page knows only
// whether an API key or the proxy password is saved, and an empty field keeps it - removing one takes the explicit
// button.
// Uses $, esc, icon, t and tn from common.js.

const PSEUDO_DEVICES = ["default", "communications"];
const st = { data: null, devices: [] };

// Non-breaking around "+", so a combination never wraps in the middle of a hint.
const NB_PLUS = "\u00a0+\u00a0";
const pretty = acc => String(acc || "").replace(/Control/g, "Ctrl").replace(/Super/g, "Win").split("+").join(NB_PLUS);
const capLabel = k => ({ Control: "Ctrl", Super: "Win", Escape: "Esc", Plus: "+" }[k] || k);

function fillMics(s, devices) {
  st.devices = devices.length ? devices : [{ deviceId: "", label: t("voice.settings.micDefault"), fallback: true }];
  fillSelect($("mic"), st.devices.map((x, i) => [String(i), x.label]), resolveMic(st.devices, s.microphoneDeviceId, s.microphoneName));
}
function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("");
  sel.value = String(value);
  if (sel.selectedIndex < 0) sel.selectedIndex = 0;
}

// Keeps a hand-edited value that is not in the list rather than dropping it (VoiceTray's PopulateChoices).
const withCustom = (choices, value, label) => (value && !choices.some(([v]) => v === value) ? [...choices, [value, label(value)]] : choices);

// Browser deviceId first; then the stored name - exactly, or as the prefix WinMM cut it to (31 characters) for
// settings imported from VoiceTray; then the first device.
function resolveMic(devices, id, name) {
  const low = String(name || "").toLowerCase();
  let i = id ? devices.findIndex(d => d.deviceId === id) : -1;
  if (i < 0 && low) i = devices.findIndex(d => d.label.toLowerCase() === low);
  if (i < 0 && low) i = devices.findIndex(d => !PSEUDO_DEVICES.includes(d.deviceId) && d.label.toLowerCase().startsWith(low));
  return Math.max(0, i);
}

// The window is sized to its content: the tallest tab's height for all of them (settings-preload.js getPageHeight).
const fit = () => window.voiceSettings.fit();

// ---------- tabs ----------
// The last one shown comes back next time, and after the reload a language switch causes. body[data-pane] is the
// tab shown, body[data-tab] its group (general, voice, commands or network): the footer and Save go by the group.
const TAB_KEY = "settingsTab";
const VOICE_PANES = ["models", "dictation", "dictionary", "readaloud", "meetings"];
function showTab(name, focus = false) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const want = name === "voice" ? "dictation" : name; // remembered from before Voice was split
  const tab = tabs.find(b => b.dataset.value === want) || tabs[0];
  for (const b of tabs) {
    const on = b === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute("aria-controls")).classList.toggle("on", on);
  }
  const pane = $(tab.getAttribute("aria-controls"));
  document.body.dataset.pane = pane.id;
  document.body.dataset.tab = pane.dataset.group || pane.id;
  try { localStorage.setItem(TAB_KEY, pane.id); } catch {}
  if (focus) tab.focus();
  if (st.data) fit(); // before that, the first fit comes once the voice part is in
  if (pane.id === "general") queueMicrotask(measureScratchpads); // once the page's script has run to its end
}
// The tab `step` places after (or before) the one shown, round the end.
function nextTab(step) {
  const list = [...document.querySelectorAll('[role="tab"]:not([hidden])')].map(b => b.dataset.value);
  return list[(list.indexOf(document.body.dataset.pane) + step + list.length) % list.length];
}

// ---------- General ----------
const SESSIONS_IN = ["windows", "tabs"];
// The Claude plan (prefs:get's claudePlan) whose advice shows; "other" for Team, Enterprise, an API key or unknown.
// Max runs 1M-context models, so 300k keeps a session cheap and sharp; elsewhere about 75% of a 200k context.
const PLAN = ["pro", "max"].includes(window.prefs.claudePlan) ? window.prefs.claudePlan : "other";
const AUTO_COMPACT_RECOMMENDED = PLAN === "max" ? 300000 : 150000;
const CONTEXT_200K = 200000;
// prefs.js: the themes ({id, group}, "system" first), TERMINAL_FONT_SIZES, UI_SCALES and AUTO_COMPACT_TOKENS, as the
// prefs snapshot brings them.
const { themes: THEMES = [], terminalFontSizes: TERM_FONT_SIZES, uiScales: UI_SCALES, autoCompactSizes: AUTO_COMPACT_SIZES, editors: EDITORS = ["vscode"], gitScopes: GIT_SCOPES = ["open", "all"] } = window.prefs;
let general = { ...window.prefs };
const dirty = new Set(); // tabs with unsaved edits: a language switch reloads the window
function setDirty(tab, on) {
  if (on) dirty.add(tab); else dirty.delete(tab);
  const button = document.querySelector(`[role="tab"][data-value="${tab}"]`);
  button.classList.toggle("dirty", on);
  button.title = on ? t("settings.voice.unsaved") : "";
}

function segHtml(options, value) {
  return options.map(([v, label]) =>
    `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}" class="${v === value ? "on" : ""}">${esc(label)}</button>`).join("");
}
function renderGeneral() {
  const focused = document.activeElement?.closest(".seg")?.id; // re-rendering replaces the buttons
  $("uiLanguage").innerHTML = segHtml(Object.entries(I18N.LANGUAGES), general.language);
  renderThemes(general.theme);
  $("edgeHandle").checked = general.edgeHandle;
  $("autoUpdate").checked = general.autoUpdate;
  $("sessionsIn").innerHTML = segHtml(SESSIONS_IN.map(m => [m, t(`tray.sessionsIn.${m}`)]), general.sessionsIn || "tabs");
  const options = (list, value, label) => list.map(v => `<option value="${v}" ${v === value ? "selected" : ""}>${esc(label(v))}</option>`).join("");
  $("termFont").innerHTML = options(TERM_FONT_SIZES, general.terminalFontSize ?? 16, v => `${v} px${v === 16 ? ` · ${t("settings.general.default")}` : ""}`);
  $("editor").innerHTML = options(EDITORS, general.editor || "vscode", v => t(`settings.general.editor.${v}`));
  $("gitScope").innerHTML = options(GIT_SCOPES, general.gitScope || "open", v => t(`settings.git.scope.${v}`));
  $("uiScale").innerHTML = options(UI_SCALES, general.uiScale ?? 1, v => `${Math.round(v * 100)}%${v === 1 ? ` · ${t("settings.general.default")}` : ""}`);
  $("newWindow").checked = general.newWindow !== false;
  $("newWindow").disabled = general.sessionsIn === "tabs";
  $("autoCompact").checked = general.autoCompact;
  $("autoCompactTokens").innerHTML = AUTO_COMPACT_SIZES.map(n => buildAutoCompactOption(n, general.autoCompactTokens)).join("");
  $("autoCompactTokens").title = getAutoCompactTip(general.autoCompactTokens);
  $("autoCompactTokens").disabled = !general.autoCompact;
  $("dayView").checked = general.dayView === true;
  $("taskbarSection").hidden = general.windows !== true; // the Windows taskbar only
  $("taskbarMonitor").checked = general.taskbarMonitor === true;
  for (const id of ["taskbarNet", "taskbarCpu", "taskbarMemory"]) { $(id).checked = general[id] !== false; $(id).disabled = general.taskbarMonitor !== true; }
  $("notify").checked = general.notify !== false;
  if (["uiLanguage", "sessionsIn"].includes(focused)) $(focused).querySelector(".on")?.focus();
}
const buildAutoCompactOption = (n, value) =>
  `<option value="${n}" title="${esc(getAutoCompactTip(n))}" ${n === value ? "selected" : ""}>${esc(getAutoCompactLabel(n))}</option>`;
// What a threshold means on the user's plan, shown on hover.
function getAutoCompactTip(n) {
  if (n === AUTO_COMPACT_RECOMMENDED) return t(`settings.general.autoCompactTip.${PLAN}`);
  if (PLAN !== "max" && n >= CONTEXT_200K) return t("settings.general.autoCompactTip.beyond");
  return t(n < AUTO_COMPACT_RECOMMENDED ? "settings.general.autoCompactTip.earlier" : "settings.general.autoCompactTip.later");
}
function getAutoCompactLabel(n) {
  const label = t("tray.autoCompact.from", { n: `${n / 1000}k` });
  return n === AUTO_COMPACT_RECOMMENDED ? `${label} · ${t("settings.general.recommended")}` : label;
}
// Too many themes for a segmented control: a select, AgentDeck's own first, then those from VS Code. Built once (a
// language change reloads the page); the arrow keys on it switch the theme at once, so one can step through them.
function renderThemes(value) {
  const sel = $("uiTheme");
  if (!sel.options.length) {
    const groups = [...new Set(THEMES.map(th => th.group))];
    sel.innerHTML = groups.map(g => `<optgroup label="${esc(t(`theme.group.${g}`))}">${THEMES.filter(th => th.group === g)
      .map(th => `<option value="${esc(th.id)}">${esc(t(`theme.${th.id}`))}</option>`).join("")}</optgroup>`).join("");
  }
  sel.value = value;
}
async function setPref(key, value) {
  if (value === undefined || value === general[key]) return;
  if (key === "language" && dirty.size && !confirm(t("settings.general.languageReload"))) return;
  general = { ...general, [key]: value };
  renderGeneral();
  await window.voiceSettings.setPrefs({ [key]: value });
}
async function showEdgeHotkey() {
  const h = await window.voiceSettings.edgeHotkey();
  if (!h) return;
  const list = h.candidates.map(c => c.replace(/ \+ /g, NB_PLUS)).join(", ");
  $("edgeHotkey").innerHTML = h.current
    ? h.current.split(" + ").map(k => `<kbd>${esc(k)}</kbd>`).join('<span class="plus">+</span>')
    : '<span class="none">—</span>';
  $("edgeHotkeyHint").textContent = t(h.current ? "settings.general.hotkeyFixed" : "settings.general.hotkeyNone", { list });
  if (st.data) fit(); // otherwise the first fit, once the voice part is in, includes it
}

// Arrow keys, Home and End move the choice of a segmented control, as in a radio group.
function segKey(e, choose) {
  const values = [...e.currentTarget.querySelectorAll("[data-value]")].map(b => b.dataset.value);
  const i = values.indexOf(e.currentTarget.querySelector(".on")?.dataset.value);
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: values.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  choose(values[(to + values.length) % values.length]);
}
$("uiTheme").addEventListener("change", e => setPref("theme", e.target.value));
for (const [id, key] of [["uiLanguage", "language"], ["sessionsIn", "sessionsIn"]]) {
  $(id).addEventListener("click", e => setPref(key, e.target.closest("[data-value]")?.dataset.value));
  $(id).addEventListener("keydown", e => segKey(e, v => setPref(key, v)));
}
$("edgeHandle").addEventListener("change", e => setPref("edgeHandle", e.target.checked));
$("autoUpdate").addEventListener("change", e => setPref("autoUpdate", e.target.checked));
$("newWindow").addEventListener("change", e => setPref("newWindow", e.target.checked));
// Switched on before any threshold was picked: the plan's recommended one.
$("autoCompact").addEventListener("change", async e => {
  if (e.target.checked && !general.autoCompactChosen) await setPref("autoCompactTokens", AUTO_COMPACT_RECOMMENDED);
  setPref("autoCompact", e.target.checked);
});
$("autoCompactTokens").addEventListener("change", e => setPref("autoCompactTokens", Number(e.target.value)));
$("termFont").addEventListener("change", e => setPref("terminalFontSize", Number(e.target.value)));
$("editor").addEventListener("change", e => setPref("editor", e.target.value));
$("gitScope").addEventListener("change", e => setPref("gitScope", e.target.value));
$("uiScale").addEventListener("change", e => setPref("uiScale", Number(e.target.value)));
$("dayView").addEventListener("change", e => setPref("dayView", e.target.checked));
$("taskbarMonitor").addEventListener("change", e => setPref("taskbarMonitor", e.target.checked));
for (const id of ["taskbarNet", "taskbarCpu", "taskbarMemory"]) $(id).addEventListener("change", e => setPref(id, e.target.checked));
$("notify").addEventListener("change", e => setPref("notify", e.target.checked));
// Start with Windows, applied at once: the installed app only - a copy run from source shows it off and says why.
function renderAutostart(a) {
  if (!a) return;
  $("autostart").checked = a.enabled;
  $("autostart").disabled = !a.supported;
  $("autostartHint").textContent = t(a.supported ? "settings.general.autostartHint" : "settings.general.autostartSource");
}
$("autostart").addEventListener("change", async e => renderAutostart(await window.voiceSettings.autostart(e.target.checked)));
window.voiceSettings.autostart().then(renderAutostart).catch(() => {});
// The tray changes the same settings; a language change reloads this page anyway.
window.prefs.onChanged(p => { general = p; renderGeneral(); });
// Each voice tab marks its own edits; Save stores all four.
for (const id of VOICE_PANES) {
  for (const type of ["input", "change"]) $(id).addEventListener(type, () => setDirty(id, true));
  $(id).addEventListener("click", e => { if (e.target.closest("button")) setDirty(id, true); });
}
$("tabs").addEventListener("click", e => { const b = e.target.closest('[role="tab"]'); if (b) showTab(b.dataset.value); });
$("tabs").addEventListener("keydown", e => segKey(e, v => showTab(v, true)));
// Ctrl+Tab, as in any tabbed dialog. A focused hotkey field records it instead (its handler stops the event).
document.addEventListener("keydown", e => {
  if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); showTab(nextTab(e.shiftKey ? -1 : 1), true); }
});
$("logo").innerHTML = icon("sliders");
// Meetings are recorded on Windows only.
if (window.prefs.windows === false) $("tabMeetings").hidden = true;
// The tab asked for (windows.js openSettings), else the one shown last.
showTab(location.hash.slice(1) || (() => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } })());
if (location.hash) location.hash = ""; // a reload (a language switch) comes back to the one shown then
window.voiceSettings.onShow?.(pane => showTab(pane, true));
renderGeneral();
showEdgeHotkey().catch(() => {});

// ---------- updates ----------
// The state is main's (updater.js), pushed on every change; the buttons only ask main to act.
const updates = window.voiceSettings.updates;
const UPDATE_TAG = { // status -> tag colour and icon (none: a spinner)
  unsupported: ["", "window"], idle: ["", "clock"], checking: ["accent", null], none: ["ok", "check"],
  available: ["accent", "download"], downloading: ["accent", null], ready: ["ok", "check"], error: ["danger", "alert"]
};
let fittedHeight = 0;
// Lines come and go with a state (the progress bar, a longer reason): the window follows.
function refit() {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (st.data && height !== fittedHeight) { fittedHeight = height; fit(); }
}
function checkedAt(ms) {
  const today = new Date(ms).toDateString() === new Date().toDateString();
  return today ? I18N.formatTime(ms) : I18N.formatDateTime(ms, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function updateTexts(u) {
  const version = u.next;
  switch (u.status) {
    case "unsupported": return [t("settings.updates.tag.unsupported"), t("settings.updates.hint.unsupported")];
    case "checking": return [t("settings.updates.tag.checking"), t("settings.updates.hint.checking")];
    case "none": return [t("settings.updates.tag.none"), t("settings.updates.hint.none", { time: checkedAt(u.checkedAt) })];
    case "available": return [t("settings.updates.tag.available", { version }), t("settings.updates.hint.available")];
    case "downloading": return [t("settings.updates.tag.downloading", { percent: I18N.formatNumber(u.percent / 100, { style: "percent" }) }),
      t("settings.updates.hint.downloading", { version })];
    case "ready": return [t("settings.updates.tag.ready", { version }), t("settings.updates.hint.ready")];
    case "error": return [t(u.error.during === "download" ? "settings.updates.tag.downloadFailed" : "settings.updates.tag.checkFailed"),
      t(`settings.updates.error.${u.error.reason}`, { message: u.error.message })];
    default: return [t("settings.updates.tag.idle"), t("settings.updates.hint.idle")];
  }
}
function renderUpdates(u) {
  if (!u) return;
  const [cls, ic] = UPDATE_TAG[u.status] || UPDATE_TAG.idle;
  const [tag, hint] = updateTexts(u);
  $("appVersion").textContent = u.version;
  $("updateTag").className = `tag ${cls}`;
  $("updateTag").innerHTML = `${ic ? icon(ic) : '<span class="spinner"></span>'}<span class="t">${esc(tag)}</span>`;
  $("updateHint").textContent = hint;
  $("updateProgress").hidden = u.status !== "downloading";
  $("updateProgress").firstElementChild.style.width = `${u.percent}%`;
  $("updateCheck").hidden = ["available", "ready"].includes(u.status); // the update's own button takes its place
  $("updateCheck").disabled = !u.supported || ["checking", "downloading"].includes(u.status);
  $("updateCheck").classList.toggle("spin", u.status === "checking");
  $("updateDownload").hidden = u.status !== "available";
  $("updateInstall").hidden = u.status !== "ready";
  refit();
}
$("updateCheck").addEventListener("click", () => updates.check());
$("updateDownload").addEventListener("click", () => updates.download());
$("updateInstall").addEventListener("click", () => updates.install());
updates.onChanged(renderUpdates);
updates.get().then(renderUpdates).catch(() => {});

// ---------- disk space ----------
// Claude Code's scratchpad folders on this computer (host/scratchpads.js). Measuring them can take seconds, so it
// happens the first time General is shown and on Refresh; nothing is removed before the user confirms.
// busy: "" | "scan" | "clear"; data: the last measurement; failed: the last one did not come; note: what the last
// clearing did.
const scratch = { supported: false, asked: false, busy: "", data: null, failed: false, note: "" };
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];
function formatBytes(n) {
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
  return `${I18N.formatNumber(n, { maximumFractionDigits: i < 2 || n >= 100 ? 0 : n >= 10 ? 1 : 2 })} ${BYTE_UNITS[i]}`;
}
const sizeAndFolders = part => ({ size: formatBytes(part.bytes), folders: tn("settings.storage.folders", part.folders) });
function renderScratchpads() {
  const d = scratch.data;
  $("scratchSection").hidden = !scratch.supported;
  if (!scratch.supported) return refit();
  let tag = ["", "folder", d ? tn("settings.storage.folders", d.total.folders) : ""];
  if (scratch.busy) tag = ["accent", null, t(scratch.busy === "scan" ? "settings.storage.tag.scanning" : "settings.storage.tag.clearing")];
  else if (scratch.failed) tag = ["danger", "alert", t("settings.storage.tag.failed")];
  $("scratchSize").textContent = d ? formatBytes(d.total.bytes) : "";
  $("scratchTag").className = `tag ${tag[0]}`;
  $("scratchTag").innerHTML = `${tag[1] ? icon(tag[1]) : '<span class="spinner"></span>'}<span class="t">${esc(tag[2])}</span>`;
  $("scratchTag").hidden = !tag[2];
  const lines = [scratch.note];
  if (d) {
    lines.push(t("settings.storage.about", { dir: d.dir }));
    lines.push(d.finished.folders ? t("settings.storage.finished", sizeAndFolders(d.finished)) : t("settings.storage.nothing"));
    if (d.running.folders) lines.push(t("settings.storage.kept", sizeAndFolders(d.running)));
  }
  if (scratch.failed) lines.push(t("settings.storage.scanFailed"));
  $("scratchHint").textContent = lines.filter(Boolean).join("\n");
  $("scratchRefresh").disabled = Boolean(scratch.busy);
  $("scratchRefresh").classList.toggle("spin", scratch.busy === "scan");
  $("scratchClear").disabled = Boolean(scratch.busy) || scratch.failed || !d?.finished.folders;
  refit();
}
// again: asked for by Refresh or after a clearing; otherwise only the first call measures.
async function measureScratchpads(again = false) {
  if (scratch.busy || (scratch.asked && again !== true)) return;
  scratch.asked = true;
  const api = window.voiceSettings.scratchpads;
  if (!scratch.supported) scratch.supported = Boolean((await api.info().catch(() => null))?.supported);
  if (!scratch.supported) return;
  scratch.busy = "scan";
  renderScratchpads();
  const d = await api.scan().catch(() => null);
  scratch.busy = "";
  scratch.failed = !d;
  if (d) { scratch.data = d.supported ? d : null; scratch.supported = d.supported; } // the folder itself may be gone
  renderScratchpads();
}
async function clearScratchpads() {
  const d = scratch.data;
  if (scratch.busy || !d?.finished.folders) return;
  const confirmed = await confirmDialog({ title: t("settings.storage.clearTitle"), body: t("settings.storage.clearConfirm", sizeAndFolders(d.finished)),
    confirmLabel: t("settings.storage.clear"), danger: true });
  if (!confirmed || scratch.busy) return;
  scratch.busy = "clear";
  scratch.note = "";
  renderScratchpads();
  const r = await window.voiceSettings.scratchpads.clear().catch(() => null);
  scratch.note = !r ? t("settings.storage.clearFailed")
    : [t("settings.storage.cleared", sizeAndFolders({ bytes: r.bytes, folders: r.removed })), r.failed ? tn("settings.storage.notRemoved", r.failed) : ""].filter(Boolean).join(" ");
  scratch.busy = "";
  await measureScratchpads(true);
}
$("scratchRefresh").addEventListener("click", () => { scratch.note = ""; measureScratchpads(true); });
$("scratchClear").addEventListener("click", clearScratchpads);

// ---------- what follows the Models tab ----------
// The provider's own ceiling, which is where the surprise used to be: 30 minutes means nothing if Gemini stops
// accepting audio after 7.
function renderLengthHint() {
  const { provider } = modelsUi.target("dictation");
  $("lengthHint").textContent = t("voice.settings.lengthHint", { provider, n: I18N.formatNumber(st.data.providerMinutes[provider]) });
}
function modelsChanged() {
  renderLengthHint();
  dictationUi.modelsChanged();
  renderVoices();
  renderReadAloudHint();
}

// ---------- read aloud ----------
// The voice of each provider that reads; the list shows those of the one chosen for reading (Models). Shown with what
// tells each voice apart; only the name is stored.
const voices = {};
const reader = () => modelsUi.target("readAloud").provider;
function renderVoices() {
  const voice = voices[reader()];
  const label = (name, style) => (style ? `${name}  —  ${style}` : name);
  fillSelect($("raVoice"), withCustom(st.data.voices[reader()].map(([n, style]) => [n, label(n, style)]), voice,
    v => label(v, t("voice.settings.customVoice"))), voice);
}
$("raVoice").addEventListener("change", () => { voices[reader()] = $("raVoice").value; });

function renderReadAloudHint() {
  const hk = $("hkRead").value.trim() || st.data.settings.hotkeys.readAloud;
  $("raHint").textContent = t("voice.settings.readAloudHint", { hotkey: pretty(hk), provider: reader() });
}

// ---------- errors ----------
function clearErrors() {
  for (const el of document.querySelectorAll("[data-err]")) { el.textContent = ""; el.classList.remove("warn"); }
  for (const el of document.querySelectorAll(".invalid, .warned")) el.classList.remove("invalid", "warned");
}

const FIELD_OF = { "hotkeys.dictate": "hkDictate", "hotkeys.readAloud": "hkRead", "hotkeys.meetingScreenshot": "hkMeetingShot",
  "net.pacUrl": "netPac", "net.proxy": "netProxy", "net.bypass": "netBypass", "net.username": "netUser", "net.password": "netPass" };
// `form`: the footer slot for what belongs to no field - the voice tab's or the network tab's.
function showErrors(errors, warn = false, form = "form") {
  const loose = [];
  for (const [k, msg] of Object.entries(errors || {})) {
    const slot = document.querySelector(`[data-err="${CSS.escape(k)}"]`);
    if (!slot || k === form) { loose.push(msg); continue; }
    slot.textContent = msg;
    slot.classList.toggle("warn", warn);
    $(FIELD_OF[k] || k)?.classList.add(warn ? "warned" : "invalid"); // the Models fields go by their error's name
  }
  if (loose.length) {
    const slot = document.querySelector(`[data-err="${form}"]`);
    slot.textContent = loose.join(" ");
    slot.classList.toggle("warn", warn);
  }
  // Save covers five tabs: the first message on another one brings that tab up.
  const first = [...document.querySelectorAll(".vs-pane [data-err]")].find(el => el.textContent)?.closest(".vs-pane");
  if (first && !first.classList.contains("on")) showTab(first.id);
  fit(); // messages add lines; the window grows with them
}

// ---------- hotkey capture ----------
const CODE_KEYS = {
  Space: "Space", Tab: "Tab", Enter: "Enter", NumpadEnter: "Enter", Backspace: "Backspace", Delete: "Delete",
  Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down",
  ArrowLeft: "Left", ArrowRight: "Right", Escape: "Escape", PrintScreen: "PrintScreen", Backquote: "`", Minus: "-",
  Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",",
  Period: ".", Slash: "/", NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult",
  NumpadDivide: "numdiv", NumpadDecimal: "numdec"
};
// The physical key (e.code), so a Cyrillic layout still records Ctrl+A rather than Ctrl+Ф.
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return "num" + code.slice(6);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] || "";
}

// A combination with Ctrl/Alt/Win (or an F-key) is recorded; anything else is ordinary typing in the field.
function captureHotkey(e) {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
  const key = keyFromCode(e.code);
  if (!key || (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F\d+$/.test(key))) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget;
  el.value = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", key].filter(Boolean).join("+");
  el.dispatchEvent(new Event("input", { bubbles: true })); // as typing would: #voice counts it as an unsaved edit
}

// The combination as key caps; whatever is typed by hand shows up the same way.
function renderCaps(input) {
  const caps = input.parentElement.querySelector(".hk-caps");
  const parts = input.value.trim().replace(/\+\+$/, "+Plus").split("+").map(s => s.trim()).filter(Boolean);
  caps.innerHTML = parts.length
    ? parts.map(k => `<kbd>${esc(capLabel(k))}</kbd>`).join('<span class="plus">+</span>')
    : `<span class="none">${esc(t("voice.settings.hotkey.none"))}</span>`;
}

for (const id of ["hkDictate", "hkRead", "hkMeetingShot"]) {
  $(id).addEventListener("keydown", captureHotkey);
  // Pressing the current combination here must record it, not start a dictation or a reading.
  $(id).addEventListener("focus", () => window.voiceSettings.capture(true));
  $(id).addEventListener("blur", () => window.voiceSettings.capture(false));
  $(id).addEventListener("input", e => {
    renderCaps(e.target);
    e.target.classList.remove("invalid", "warned");
    const slot = e.target.closest(".vs-field").querySelector("[data-err]");
    slot.textContent = "";
    if (id === "hkRead") renderReadAloudHint();
  });
}
for (const btn of document.querySelectorAll("[data-reset]")) {
  btn.innerHTML = icon("undo");
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    input.value = st.data.hotkeyDefaults[btn.dataset.reset];
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// ---------- events ----------
for (const id of ["cancel", "close"]) $(id).addEventListener("click", () => window.close());
// Escape in a question (confirmDialog) answers the question only.
document.addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]")) window.close(); });

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  // Enter in any field submits the one form that holds every tab (through its first Save, whichever tab is shown):
  // only Enter in a field of the tab shown, or that tab's own Save, saves - and General and Commands have nothing to
  // save, they apply at once.
  const tab = document.body.dataset.tab;
  if (!$(document.body.dataset.pane)?.contains(document.activeElement) && e.submitter?.dataset.for !== tab) return;
  if (tab === "network") return saveNetwork();
  if (tab !== "voice") return;
  clearErrors();
  const dev = st.devices[Number($("mic").value)] || st.devices[0];
  const payload = {
    ...modelsUi.payload(), // each task's provider and model, the API keys (settings-models.js)
    language: $("language").value,
    useClipboardPaste: $("clipboard").checked,
    microphoneDeviceId: dev.deviceId,
    microphoneName: dev.fallback ? "" : dev.label,
    maxRecordingMinutes: Number($("maxLen").value),
    readAloudVoice: voices.Gemini,
    readAloudVoices: Object.fromEntries(Object.entries(voices).filter(([provider]) => provider !== "Gemini")),
    hotkeys: {
      dictate: $("hkDictate").value.trim(), readAloud: $("hkRead").value.trim(),
      ...(!$("tabMeetings").hidden && { meetingScreenshot: $("hkMeetingShot").value.trim() })
    },
    ...dictationUi.payload() // mode, prompt language, key behaviour, dictionary (settings-dictation.js)
  };
  $("save").disabled = true;
  try {
    const r = await window.voiceSettings.save(payload);
    if (!r?.ok) return showErrors(r?.errors || { form: t("voice.settings.notSaved") });
    // Saved. The typed keys are gone from the page; only whether one exists remains.
    for (const id of VOICE_PANES) setDirty(id, false);
    st.data.settings = r.settings;
    modelsUi.saved(r.hasKey);
    $("hkDictate").value = r.settings.hotkeys.dictate;
    $("hkRead").value = r.settings.hotkeys.readAloud;
    renderCaps($("hkDictate")); renderCaps($("hkRead"));
    $("hkMeetingShot").value = r.settings.hotkeys.meetingScreenshot || "";
    renderCaps($("hkMeetingShot"));
    if (!Object.keys(r.warnings || {}).length) return window.close();
    showErrors({ ...r.warnings, form: r.warnings.form || t("voice.settings.savedWithWarnings") }, true);
  } catch (err) {
    showErrors({ form: err?.message || String(err) });
  } finally {
    $("save").disabled = false;
  }
});

// ---------- network ----------
// The proxy settings as main keeps them (network.js), and the password as typed or marked for removal.
const NET_MODES = ["system", "pac", "manual", "direct"];
const net = { data: null, mode: "system", clearPassword: false };

function renderNetMode() {
  const focused = document.activeElement?.closest("#netMode"); // re-rendering replaces the buttons
  $("netMode").innerHTML = segHtml(NET_MODES.map(m => [m, t(`settings.network.mode.${m}`)]), net.mode);
  $("netModeHint").textContent = t(`settings.network.hint.${net.mode}`);
  for (const el of $("network").querySelectorAll("[data-show]")) el.hidden = !el.dataset.show.split(" ").includes(net.mode);
  if (focused) $("netMode").querySelector(".on")?.focus();
}
function setNetMode(mode) {
  if (!NET_MODES.includes(mode) || mode === net.mode) return;
  net.mode = mode;
  renderNetMode();
  setDirty("network", true);
  renderTest(null); // a result for other settings would mislead
  if (st.data) fit();
}

function renderNetPassword() {
  const saved = Boolean(net.data?.hasPassword), typed = $("netPass").value;
  const text = key => `<span>${esc(t(key))}</span>`;
  const link = (key, action, cls = "") => `<button type="button" class="vs-link${cls}" data-pass="${action}">${esc(t(key))}</button>`;
  let tag, html = "";
  if (typed) { tag = ["accent", "key", "settings.network.password.tag.new"]; html = text(saved ? "settings.network.password.replaces" : "settings.network.password.willEncrypt"); }
  else if (saved && net.clearPassword) { tag = ["warn", "trash", "settings.network.password.tag.removing"]; html = text("settings.network.password.removeOnSave") + link("voice.settings.key.undo", "undo"); }
  else if (saved) { tag = ["ok", "check", "settings.network.password.tag.saved"]; html = text("settings.network.password.savedInfo") + link("settings.network.password.remove", "clear", " danger"); }
  else tag = ["", "key", "settings.network.password.tag.none"];
  $("netPassTag").className = `tag ${tag[0]}`;
  $("netPassTag").innerHTML = `${icon(tag[1])}${esc(t(tag[2]))}`;
  $("netPassState").innerHTML = html;
  $("netPassState").hidden = !html;
  $("netPass").placeholder = saved && !net.clearPassword ? "••••••••" : "";
}

function fillNetwork(s) {
  net.data = s;
  net.mode = s.mode;
  net.clearPassword = false;
  $("netPac").value = s.pacUrl;
  $("netProxy").value = s.proxy;
  $("netBypass").value = s.bypass;
  $("netUser").value = s.username;
  $("netPass").value = "";
  $("netTerminals").checked = s.terminals;
  renderNetMode();
  renderNetPassword();
}

// What is entered, for Save and for the test alike. An empty password field keeps the saved password.
function netPayload() {
  const typed = $("netPass").value;
  return {
    mode: net.mode, pacUrl: $("netPac").value, proxy: $("netProxy").value, bypass: $("netBypass").value,
    username: $("netUser").value, terminals: $("netTerminals").checked,
    password: typed ? { set: typed } : net.clearPassword ? { clear: true } : undefined
  };
}

// The route Chromium resolved ("PROXY host:port; DIRECT"), in words: [first, ...fallbacks].
function routeLabels(route) {
  return String(route || "").split(";").map(s => s.trim()).filter(Boolean).map(entry => {
    const [kind, where = ""] = entry.split(/\s+/);
    if (kind === "DIRECT") return t("settings.network.test.direct");
    return kind === "PROXY" ? where : `${kind.toLowerCase()}://${where}`;
  });
}

// r: null (not run yet), {checking}, {reachable, ms, route} or {reachable: false, short, long, route}.
function renderTest(r) {
  let cls = "", ic = "clock", tag = t("settings.network.test.tag.idle"), hint = t("settings.network.test.hint.idle");
  const labels = routeLabels(r?.route);
  if (r?.checking) { cls = "accent"; ic = null; tag = t("settings.network.test.tag.checking"); hint = t("settings.network.test.hint.checking"); }
  else if (r?.reachable) {
    const ms = I18N.formatNumber(r.ms);
    cls = "ok"; ic = "check"; tag = t("settings.network.test.tag.ok");
    const direct = !labels.length || /^DIRECT/.test(String(r.route).trim());
    hint = direct ? t("settings.network.test.okDirect", { ms }) : t("settings.network.test.okProxy", { proxy: labels[0], ms });
    if (labels.length > 1) hint += ` ${t("settings.network.test.fallback", { list: labels.slice(1).join(", ") })}`;
  } else if (r) {
    cls = "danger"; ic = "alert"; tag = r.short;
    const route = labels.length ? labels.join(" → ") : t("settings.network.test.routeUnknown");
    hint = r.route == null ? r.long : `${r.long}\n${t("settings.network.test.route", { route })}`;
  }
  $("netTestTag").className = `tag ${cls}`;
  $("netTestTag").innerHTML = `${ic ? icon(ic) : '<span class="spinner"></span>'}<span class="t">${esc(tag)}</span>`;
  $("netTestHint").textContent = hint;
  $("netTest").disabled = Boolean(r?.checking);
  $("netTest").classList.toggle("spin", Boolean(r?.checking));
  refit();
}

async function testNetwork() {
  clearErrors();
  renderTest({ checking: true });
  try {
    const r = await window.voiceSettings.network.test(netPayload());
    if (r?.errors) { renderTest(null); showErrors(r.errors, false, "net.form"); return; }
    renderTest(r);
  } catch (err) {
    renderTest({ reachable: false, short: t("voice.errors.unexpected.short"), long: err?.message || String(err) });
  }
}

async function saveNetwork() {
  clearErrors();
  $("netSave").disabled = true;
  try {
    const r = await window.voiceSettings.network.save(netPayload());
    if (!r?.ok) return showErrors(r?.errors || { "net.form": t("voice.settings.notSaved") }, false, "net.form");
    // Saved and in effect. The typed password is gone from the page; only whether one exists remains.
    setDirty("network", false);
    fillNetwork(r.state);
    if (!Object.keys(r.warnings || {}).length) return window.close();
    showErrors(r.warnings, true, "net.form");
  } catch (err) {
    showErrors({ "net.form": err?.message || String(err) }, false, "net.form");
  } finally {
    $("netSave").disabled = false;
  }
}

$("netMode").addEventListener("click", e => setNetMode(e.target.closest("[data-value]")?.dataset.value));
$("netMode").addEventListener("keydown", e => segKey(e, setNetMode));
for (const type of ["input", "change"]) $("network").addEventListener(type, e => {
  setDirty("network", true);
  if (e.target.matches(".input") && type === "input" && !$("netTest").disabled) renderTest(null); // that result was for other values
  e.target.classList.remove("invalid", "warned");
  const slot = e.target.closest(".vs-field")?.querySelector("[data-err]");
  if (slot) slot.textContent = "";
});
$("netPass").addEventListener("input", () => {
  if ($("netPass").value) net.clearPassword = false; // typing a new password supersedes "remove"
  renderNetPassword();
});
$("netPassState").addEventListener("click", e => {
  const btn = e.target.closest("[data-pass]");
  if (!btn) return;
  net.clearPassword = btn.dataset.pass === "clear";
  setDirty("network", true);
  renderNetPassword();
});
$("netTest").addEventListener("click", testNetwork);
$("netCancel").addEventListener("click", () => window.close());

// ---------- load ----------
async function init() {
  const network = await window.voiceSettings.network.get().catch(() => null);
  if (network) { fillNetwork(network); renderTest(null); }
  else $("tabNetwork").hidden = true;
  const d = st.data = await window.voiceSettings.get();
  const s = d.settings;

  modelsUi.fill(d, modelsChanged);
  renderLengthHint();

  fillSelect($("language"), d.languages, s.language); // an unknown code falls back to auto-detect, as in VoiceTray
  $("clipboard").checked = s.useClipboardPaste;

  // Until the microphones are listed (that can take seconds), the saved one, so a save meanwhile keeps it.
  fillMics(s, s.microphoneName ? [{ deviceId: s.microphoneDeviceId || "", label: s.microphoneName }] : []);
  window.voiceSettings.devices().then(list => fillMics(s, list || [])).catch(() => {});

  // Keep a hand-edited length from settings.json rather than silently rounding it away.
  const lengths = [...new Set([...d.lengths, s.maxRecordingMinutes])].sort((a, b) => a - b);
  fillSelect($("maxLen"), lengths.map(m => [String(m), tn("voice.settings.minutes", m)]), s.maxRecordingMinutes);

  // Gemini's saved voice has a key of its own (settings.js); a provider with none saved has its first.
  for (const [provider, list] of Object.entries(d.voices)) {
    voices[provider] = (provider === "Gemini" ? s.readAloudVoice : s.readAloudVoices?.[provider]) || list[0][0];
  }
  renderVoices();

  $("hkDictate").value = s.hotkeys.dictate;
  $("hkRead").value = s.hotkeys.readAloud;
  renderCaps($("hkDictate")); renderCaps($("hkRead"));
  $("hkMeetingShot").value = s.hotkeys.meetingScreenshot || "";
  renderCaps($("hkMeetingShot"));
  renderReadAloudHint();
  dictationUi.fill(s, d);

  await fit();
  // The tab's first control where it has an obvious one, otherwise the tab itself.
  const first = { general: "#uiLanguage .on", models: "#models input", dictation: "#language", readaloud: "#raVoice", meetings: "#hkMeetingShot", network: "#netMode .on" }[document.body.dataset.pane];
  ((first && document.querySelector(first)) || document.querySelector('[role="tab"].on'))?.focus();
}

init().catch(err => showErrors({ form: t("voice.settings.loadFailed", { error: err?.message || err }) }));
