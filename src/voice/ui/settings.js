// The app's Settings page, in two tabs. General (language, theme, edge menu, updates) applies at once through
// window.prefs; Voice is a port of VoiceTray's SettingsWindow plus the two hotkeys, saved with Save. The API keys
// never come here: the page knows only whether one is saved, and an empty field keeps it - removing a key takes the
// explicit button.
// Uses $, esc, icon, t and tn from common.js.

const PSEUDO_DEVICES = ["default", "communications"];
// Working copies, so switching provider keeps each provider's typed key and model (as VoiceTray did).
const st = { data: null, provider: "", models: {}, keys: {}, devices: [] };

// Non-breaking around "+", so a combination never wraps in the middle of a hint.
const NB_PLUS = "\u00a0+\u00a0";
const pretty = acc => String(acc || "").replace(/Control/g, "Ctrl").replace(/Super/g, "Win").split("+").join(NB_PLUS);
const capLabel = k => ({ Control: "Ctrl", Super: "Win", Escape: "Esc", Plus: "+" }[k] || k);

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

// The window is sized to what is shown (VoiceTray: SizeToContent), so each tab gets its own height.
const fit = () => window.voiceSettings.fit(Math.ceil(document.body.getBoundingClientRect().height));

// ---------- tabs ----------
// The last one shown comes back next time, and after the reload a language switch causes.
const TAB_KEY = "settingsTab";
function showTab(name, focus = false) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const tab = tabs.find(b => b.dataset.value === name) || tabs[0];
  for (const b of tabs) {
    const on = b === tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute("aria-controls")).classList.toggle("on", on);
  }
  document.body.dataset.tab = tab.dataset.value;
  try { localStorage.setItem(TAB_KEY, tab.dataset.value); } catch {}
  if (focus) tab.focus();
  if (st.data) fit(); // before that, the first fit comes once the voice part is in
}
const otherTab = () => (document.body.dataset.tab === "voice" ? "general" : "voice");

// ---------- General ----------
const THEMES = ["system", "dark", "light"];
let general = { ...window.prefs };
let voiceDirty = false; // unsaved voice edits: a language switch reloads the window
function setVoiceDirty(on) {
  voiceDirty = on;
  $("tabVoice").classList.toggle("dirty", on);
  $("tabVoice").title = on ? t("settings.voice.unsaved") : "";
}

function segHtml(options, value) {
  return options.map(([v, label]) =>
    `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}" class="${v === value ? "on" : ""}">${esc(label)}</button>`).join("");
}
function renderGeneral() {
  const focused = document.activeElement?.closest(".seg")?.id; // re-rendering replaces the buttons
  $("uiLanguage").innerHTML = segHtml(Object.entries(I18N.LANGUAGES), general.language);
  $("uiTheme").innerHTML = segHtml(THEMES.map(th => [th, t(`theme.${th}`)]), general.theme);
  $("hoverEdge").checked = general.hoverEdge;
  $("autoUpdate").checked = general.autoUpdate;
  if (focused === "uiLanguage" || focused === "uiTheme") $(focused).querySelector(".on")?.focus();
}
async function setPref(key, value) {
  if (value === undefined || value === general[key]) return;
  if (key === "language" && voiceDirty && !confirm(t("settings.general.languageReload"))) return;
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
for (const [id, key] of [["uiLanguage", "language"], ["uiTheme", "theme"]]) {
  $(id).addEventListener("click", e => setPref(key, e.target.closest("[data-value]")?.dataset.value));
  $(id).addEventListener("keydown", e => segKey(e, v => setPref(key, v)));
}
$("hoverEdge").addEventListener("change", e => setPref("hoverEdge", e.target.checked));
$("autoUpdate").addEventListener("change", e => setPref("autoUpdate", e.target.checked));
// The tray changes the same settings; a language change reloads this page anyway.
window.prefs.onChanged(p => { general = p; renderGeneral(); });
for (const type of ["input", "change"]) $("voice").addEventListener(type, () => setVoiceDirty(true));
$("voice").addEventListener("click", e => { if (e.target.closest("button")) setVoiceDirty(true); });
$("tabs").addEventListener("click", e => { const b = e.target.closest('[role="tab"]'); if (b) showTab(b.dataset.value); });
$("tabs").addEventListener("keydown", e => segKey(e, v => showTab(v, true)));
// Ctrl+Tab, as in any tabbed dialog. A focused hotkey field records it instead (its handler stops the event).
document.addEventListener("keydown", e => {
  if (e.ctrlKey && e.key === "Tab") { e.preventDefault(); showTab(otherTab(), true); }
});
$("logo").innerHTML = icon("sliders");
showTab((() => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } })());
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
  // Lines come and go with the state (the progress bar, a longer reason): the window follows.
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (st.data && height !== fittedHeight) { fittedHeight = height; fit(); }
}
$("updateCheck").addEventListener("click", () => updates.check());
$("updateDownload").addEventListener("click", () => updates.download());
$("updateInstall").addEventListener("click", () => updates.install());
updates.onChanged(renderUpdates);
updates.get().then(renderUpdates).catch(() => {});

// ---------- provider: segmented control ----------
function renderProviders() {
  $("provider").innerHTML = st.data.providers.map(p =>
    `<button type="button" role="radio" data-provider="${esc(p)}" aria-checked="${p === st.provider}" tabindex="${p === st.provider ? 0 : -1}" class="${p === st.provider ? "on" : ""}">${esc(p)}</button>`).join("");
}
function selectProvider(p, focus = false) {
  if (!p || p === st.provider) return;
  stash(); // edits for the provider we are leaving
  st.provider = p;
  renderProviders();
  showProvider();
  if (focus) $("provider").querySelector(".on")?.focus();
}

// ---------- provider-dependent part ----------
function showProvider() {
  const p = st.provider, d = st.data, models = d.models[p] || [];
  // Like VoiceTray: a model that is not in the list falls back to the provider's first (default) one.
  fillSelect($("model"), models.map(m => [m, m]), models.includes(st.models[p]) ? st.models[p] : models[0]);
  $("apiKey").value = st.keys[p].typed;
  renderKeyState();
  // The provider's own ceiling, which is where the surprise used to be: 30 minutes means nothing if Gemini stops
  // accepting audio after 7.
  $("lengthHint").textContent = t("voice.settings.lengthHint", { provider: p, n: I18N.formatNumber(d.providerMinutes[p]) });
}

function stash() {
  st.keys[st.provider].typed = $("apiKey").value;
  st.models[st.provider] = $("model").value;
}

function renderKeyState() {
  const p = st.provider, k = st.keys[p], saved = Boolean(st.data.hasKey[p]);
  const typed = $("apiKey").value.trim();
  const text = key => `<span>${esc(t(key))}</span>`;
  const link = (key, action, cls = "") => `<button type="button" class="vs-link${cls}" data-key="${action}">${esc(t(key))}</button>`;
  let html, tag;
  if (typed) { tag = ["accent", "key", "voice.settings.key.tag.new"]; html = text(saved ? "voice.settings.key.replaces" : "voice.settings.key.willEncrypt"); }
  else if (saved && k.clear) { tag = ["warn", "trash", "voice.settings.key.tag.removing"]; html = text("voice.settings.key.removeOnSave") + link("voice.settings.key.undo", "undo"); }
  else if (saved) { tag = ["ok", "check", "voice.settings.key.tag.saved"]; html = text("voice.settings.key.savedInfo") + link("voice.settings.key.remove", "clear", " danger"); }
  else { tag = ["warn", "alert", "voice.settings.key.tag.none"]; html = text("voice.settings.key.noneInfo"); }
  $("keyTag").className = `tag ${tag[0]}`;
  $("keyTag").innerHTML = `${icon(tag[1])}${esc(t(tag[2]))}`;
  $("keyState").innerHTML = html;
  $("apiKey").placeholder = saved && !k.clear ? "••••••••••••" : t("voice.settings.key.placeholder", { provider: p });
}

function renderReadAloudHint() {
  const hk = $("hkRead").value.trim() || st.data.settings.hotkeys.readAloud;
  $("raHint").textContent = t("voice.settings.readAloudHint", { hotkey: pretty(hk) });
}

// ---------- errors ----------
function clearErrors() {
  for (const el of document.querySelectorAll("[data-err]")) { el.textContent = ""; el.classList.remove("warn"); }
  for (const el of document.querySelectorAll(".invalid, .warned")) el.classList.remove("invalid", "warned");
}

const FIELD_OF = { apiKey: "apiKey", model: "model", "hotkeys.dictate": "hkDictate", "hotkeys.readAloud": "hkRead" };
function showErrors(errors, warn = false) {
  const loose = [];
  for (const [k, msg] of Object.entries(errors || {})) {
    const slot = document.querySelector(`[data-err="${CSS.escape(k)}"]`);
    if (!slot || k === "form") { loose.push(msg); continue; }
    slot.textContent = msg;
    slot.classList.toggle("warn", warn);
    if (FIELD_OF[k]) $(FIELD_OF[k]).classList.add(warn ? "warned" : "invalid");
  }
  if (loose.length) {
    const form = document.querySelector('[data-err="form"]');
    form.textContent = loose.join(" ");
    form.classList.toggle("warn", warn);
  }
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

for (const id of ["hkDictate", "hkRead"]) {
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
$("provider").addEventListener("click", e => selectProvider(e.target.closest("[data-provider]")?.dataset.provider));
$("provider").addEventListener("keydown", e => {
  const list = st.data.providers, i = list.indexOf(st.provider);
  const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  selectProvider(list[(to + list.length) % list.length], true);
});
$("apiKey").addEventListener("input", () => {
  if ($("apiKey").value.trim()) st.keys[st.provider].clear = false; // typing a new key supersedes "remove"
  $("apiKey").classList.remove("invalid", "warned");
  document.querySelector('[data-err="apiKey"]').textContent = "";
  renderKeyState();
});
$("keyState").addEventListener("click", e => {
  const btn = e.target.closest("[data-key]");
  if (!btn) return;
  st.keys[st.provider].clear = btn.dataset.key === "clear";
  renderKeyState();
});
for (const id of ["cancel", "close"]) $(id).addEventListener("click", () => window.close());
document.addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented) window.close(); });

$("form").addEventListener("submit", async e => {
  e.preventDefault();
  stash();
  clearErrors();
  const dev = st.devices[Number($("mic").value)] || st.devices[0];
  const apiKeys = {};
  for (const p of st.data.providers) {
    const k = st.keys[p];
    if (k.typed.trim()) apiKeys[p] = { set: k.typed.trim() };
    else if (k.clear) apiKeys[p] = { clear: true };
  }
  const payload = {
    provider: st.provider,
    models: { ...st.models },
    language: $("language").value,
    useClipboardPaste: $("clipboard").checked,
    microphoneDeviceId: dev.deviceId,
    microphoneName: dev.fallback ? "" : dev.label,
    maxRecordingMinutes: Number($("maxLen").value),
    readAloudModel: $("raModel").value,
    readAloudVoice: $("raVoice").value,
    hotkeys: { dictate: $("hkDictate").value.trim(), readAloud: $("hkRead").value.trim() },
    apiKeys
  };
  $("save").disabled = true;
  try {
    const r = await window.voiceSettings.save(payload);
    if (!r?.ok) return showErrors(r?.errors || { form: t("voice.settings.notSaved") });
    // Saved. The typed keys are gone from the page; only whether one exists remains.
    setVoiceDirty(false);
    st.data.hasKey = r.hasKey;
    st.data.settings = r.settings;
    for (const p of st.data.providers) st.keys[p] = { typed: "", clear: false };
    $("apiKey").value = "";
    $("hkDictate").value = r.settings.hotkeys.dictate;
    $("hkRead").value = r.settings.hotkeys.readAloud;
    renderCaps($("hkDictate")); renderCaps($("hkRead"));
    renderKeyState();
    if (!Object.keys(r.warnings || {}).length) return window.close();
    showErrors({ ...r.warnings, form: r.warnings.form || t("voice.settings.savedWithWarnings") }, true);
  } catch (err) {
    showErrors({ form: err?.message || String(err) });
  } finally {
    $("save").disabled = false;
  }
});

// ---------- load ----------
async function init() {
  const d = st.data = await window.voiceSettings.get();
  const s = d.settings;

  for (const p of d.providers) {
    st.models[p] = s.models?.[p] || d.models[p][0];
    st.keys[p] = { typed: "", clear: false };
  }
  st.provider = d.providers.includes(s.provider) ? s.provider : d.providers[0];
  renderProviders();
  showProvider();

  fillSelect($("language"), d.languages, s.language); // an unknown code falls back to auto-detect, as in VoiceTray
  $("clipboard").checked = s.useClipboardPaste;

  st.devices = d.devices.length ? d.devices : [{ deviceId: "", label: t("voice.settings.micDefault"), fallback: true }];
  fillSelect($("mic"), st.devices.map((x, i) => [String(i), x.label]), resolveMic(st.devices, s.microphoneDeviceId, s.microphoneName));

  // Keep a hand-edited length from settings.json rather than silently rounding it away.
  const lengths = [...new Set([...d.lengths, s.maxRecordingMinutes])].sort((a, b) => a - b);
  fillSelect($("maxLen"), lengths.map(m => [String(m), tn("voice.settings.minutes", m)]), s.maxRecordingMinutes);

  const raModel = s.readAloudModel || d.readAloudModels[0];
  fillSelect($("raModel"), withCustom(d.readAloudModels.map(m => [m, m]), raModel, v => v), raModel);
  // Shown with the character of each voice; only the name is stored.
  const voice = s.readAloudVoice || d.defaultVoice;
  const voiceLabel = (name, style) => (style ? `${name}  —  ${style}` : name);
  fillSelect($("raVoice"), withCustom(d.voices.map(([n, style]) => [n, voiceLabel(n, style)]), voice,
    v => voiceLabel(v, t("voice.settings.customVoice"))), voice);

  $("hkDictate").value = s.hotkeys.dictate;
  $("hkRead").value = s.hotkeys.readAloud;
  renderCaps($("hkDictate")); renderCaps($("hkRead"));
  renderReadAloudHint();

  await fit();
  $(document.body.dataset.tab === "voice" ? "provider" : "uiLanguage").querySelector(".on")?.focus();
}

init().catch(err => showErrors({ form: t("voice.settings.loadFailed", { error: err?.message || err }) }));
