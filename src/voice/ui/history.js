// Voice History page: port of VoiceTray's HistoryWindow, in the manager's look. Every dictation and every reading,
// newest first and grouped by day: play the recording, copy the text, transcribe again (dictation) or read again
// (reading), delete one, clear all. Uses $, esc, hl, icon, t, tn and dayGroup from common.js.
const PREVIEW_CHARS = 160;
const WORKING = ["Transcribing", "Delivering"];
const IN_FLIGHT = [...WORKING, "Pending", "ReadyForDelivery"];
// The kind filter: value and label key.
const KINDS = [["", "common.all"], ["Dictation", "voice.history.kind.dictation"], ["ReadAloud", "voice.history.kind.readAloud"],
  ["Command", "voice.history.kind.command"], ["Failed", "voice.history.kind.failed"]];
const TAG = { done: "ok", failed: "danger", work: "warn", read: "read", quiet: "" };
// A voice command's outcome -> its tag's tone (the label is voice.history.command.<outcome>).
const COMMAND_TONE = { launched: "done", resumed: "done", focused: "done", shown: "done", cancelled: "quiet", unclear: "work", failed: "failed" };
const KIND_LOOK = { Dictation: ["mic", ""], ReadAloud: ["speaker", " read"], Command: ["terminal", " cmd"] }; // icon, class
const num = n => I18N.formatNumber(n);

// all: every record matching the search; views: those that also pass the kind filter (what the list shows).
const st = { all: [], views: [], total: 0, query: "", kind: "", sel: null, playing: null, version: "result" };
const MODES = VOICE_MODES;
const list = $("list"), player = $("player"), dText = $("dText");

// ---------- rows (VoiceTray's HistoryRow.From) ----------
// The locale's compact date for the list ("Thu 15 Oct  09:05", "чт, 15.10  09:05"), the full one for the detail
// ("Thursday 15 October  09:05"); the year only when it is not this one.
function timeText(s, full = false) {
  const ms = Date.parse(s);
  if (isNaN(ms)) return t("time.unknownDate");
  const year = new Date(ms).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {};
  const date = I18N.formatDate(ms, { weekday: full ? "long" : "short", day: "numeric", month: full ? "long" : "short", ...year });
  return `${date}  ${I18N.formatTime(ms)}`;
}

// "42 s", "5 min 12 s"; at least a second.
function durationText(sec) {
  const s = Math.max(1, Math.round(sec));
  return s < 60 ? t("voice.history.duration.sec", { s: num(s) })
    : t("voice.history.duration.min", { m: num(Math.floor(s / 60)), s: num(s % 60) });
}

function shorten(text) {
  const flat = String(text).replace(/\r\n|\r|\n/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : flat.slice(0, PREVIEW_CHARS) + "…";
}

// A voice command: what it was taken to mean, what was said, and the prompt a new session got.
const CARD = { new: "voice.command.card.new", resume: "voice.command.card.resume", show: "voice.command.card.show", project: "voice.command.card.project" };
function commandView(j) {
  const c = j.Command || {};
  const outcome = COMMAND_TONE[c.outcome] ? c.outcome : j.Status === "Failed" ? "failed" : "unclear";
  const summary = CARD[c.kind] ? t(CARD[c.kind], { agent: c.agent || "", project: c.project || t("voice.command.noProject") }) : c.summary;
  const body = [[summary, c.session].filter(Boolean).join("\n"), t("voice.history.command.said", { text: j.ResultText || "" }), c.note,
    c.prompt ? `${t("voice.history.command.prompt")}\n${c.prompt}` : "",
    c.rewriteError ? t("voice.history.command.rewriteFailed", { reason: c.rewriteError }) : ""].filter(Boolean).join("\n\n");
  return {
    status: outcome === "failed" ? t("voice.history.status.failedWith", { reason: j.LastErrorShort || t("voice.history.status.error") })
      : t(`voice.history.command.${outcome}`),
    tone: COMMAND_TONE[outcome], body,
    preview: summary ? `${summary} · ${t("voice.command.quoted", { text: j.ResultText || "" })}` : j.ResultText || ""
  };
}

function view(j) {
  const readAloud = j.Kind === "ReadAloud";
  const command = j.Kind === "Command";
  const working = WORKING.includes(j.Status);
  // A saved error message stays in the language it was written in.
  const [status, tone] =
    j.Status === "Done" ? (readAloud ? [t("voice.history.status.read"), "read"] : [t("voice.history.status.done"), "done"])
    : j.Status === "Failed" ? [t("voice.history.status.failedWith", { reason: j.LastErrorShort || t("voice.history.status.error") }), "failed"]
    : j.Status === "Transcribing" ? [t("voice.history.status.transcribing"), "work"]
    : j.Status === "Delivering" ? [t("voice.history.status.delivering"), "work"]
    : [t("voice.history.status.pending"), "work"];
  const text = j.ResultText || "";
  const body = j.HasText ? text
    : j.LastError || t(IN_FLIGHT.includes(j.Status) ? "voice.history.body.processing" : "voice.history.body.noText");
  // A reading's duration is only known once its audio has been saved.
  const length = j.DurationSeconds > 0 ? durationText(j.DurationSeconds) : "";
  const parts = [length, `${j.Provider || ""} ${j.Model || ""}`.trim(),
    readAloud ? t("voice.history.meta.voice", { name: j.Voice || "—" })
    : j.Language && j.Language !== "auto" ? j.Language : t("voice.history.meta.autoLanguage"),
    // Only a rewriting mode is worth a word; verbatim is what every older record was.
    !readAloud && MODES.includes(j.Mode) && j.Mode !== "verbatim" ? t(`voice.mode.${j.Mode}`) : ""].filter(Boolean);
  const created = Date.parse(j.CreatedAt);
  return {
    ...j, readAloud, status, tone, body, text, working,
    time: timeText(j.CreatedAt),
    fullTime: timeText(j.CreatedAt, true),
    group: dayGroup(isNaN(created) ? 0 : created),
    meta: [...parts, ...(j.HasAudio ? [] : [t("voice.history.meta.noAudio")])].join("  ·  "),
    // Wraps only between the parts, never leaving one word of a part alone on the next line.
    detailMeta: [...parts, ...(j.HasAudio ? [] : [t("voice.history.meta.audioGone")])].map(p => p.replace(/ /g, "\u00a0")).join("  ·  "),
    preview: shorten(body),
    // A reading needs only its text, which outlives the audio; retention trimming the audio is exactly when
    // "read again" is wanted.
    canRedo: readAloud ? j.HasText : j.HasAudio && !working,
    canDelete: !working,
    // A voice command is kept to be looked at, never redone (it would act on the sessions again).
    ...(command ? { ...commandView(j), canRedo: false } : {})
  };
}

const ofKind = (v, kind) => !kind || (kind === "Failed" ? v.Status === "Failed" : v.Kind === kind);
const selected = () => st.views.find(v => v.Id === st.sel) || null;
// In the list a failure says just that; the reason is in its preview and in the detail.
const statusTag = v => `<span class="tag ${TAG[v.tone]}" title="${esc(v.status)}">${v.working ? '<span class="spinner"></span>' : ""}<span class="t">${esc(v.tone === "failed" ? t("voice.history.status.failed") : v.status)}</span></span>`;
const look = v => KIND_LOOK[v.Kind] || KIND_LOOK.Dictation;
const BADGE = { Dictation: "voice.history.badge.dictation", ReadAloud: "voice.history.badge.read", Command: "voice.history.badge.command" };
const kindBadge = v => `<span class="vh-kind${look(v)[1]}">${icon(look(v)[0])}${esc(t(BADGE[v.Kind] || BADGE.Dictation))}</span>`;

// ---------- rendering ----------
function render() {
  const toks = st.query ? [st.query.toLowerCase().replace(/\\/g, "/")] : [];
  const shown = st.views.length;
  $("status").textContent = !st.total ? t("voice.history.count.none")
    : shown === st.total ? tn("voice.history.count", st.total)
    : t("voice.history.count.filtered", { shown: num(shown), total: num(st.total) });
  $("kinds").innerHTML = KINDS.map(([key, label]) => {
    const n = st.all.filter(v => ofKind(v, key)).length;
    return `<button class="chip ${st.kind === key ? "on" : ""}" data-kind="${key}" ${n || st.kind === key || !key ? "" : "disabled"}>${esc(t(label))}<span class="n">${num(n)}</span></button>`;
  }).join("");

  if (!st.total) {
    list.innerHTML = `<div class="empty"><div class="empty-ico">${icon("history")}</div><h3>${esc(t("voice.history.empty.none"))}</h3>
      <p>${esc(t("voice.history.empty.noneBody"))}</p></div>`;
  } else if (!shown) {
    list.innerHTML = st.query
      ? `<div class="empty"><div class="empty-ico">${icon("search")}</div><h3>${esc(t("voice.history.empty.noMatch"))}</h3>
          <p>${esc(t(st.kind ? "voice.history.empty.noMatchKindBody" : "voice.history.empty.noMatchBody", { q: st.query }))}</p></div>`
      : `<div class="empty"><div class="empty-ico">${icon("history")}</div><h3>${esc(t("voice.history.empty.kind"))}</h3>
          <div class="actions"><button class="btn sm" data-kind="">${esc(t("voice.history.empty.showAll"))}</button></div></div>`;
  } else {
    const groups = new Map();
    for (const v of st.views) {
      if (!groups.has(v.group)) groups.set(v.group, []);
      const on = v.Id === st.sel;
      groups.get(v.group).push(`<div class="card vh-row ${v.tone}${on ? " active" : ""}" role="option" aria-selected="${on}" data-id="${esc(v.Id)}">
        <div class="vh-r1">${kindBadge(v)}<span class="vh-time">${esc(v.time)}</span>${statusTag(v)}</div>
        <div class="vh-prev${v.HasText ? "" : " muted"}">${hl(v.preview, toks)}</div>
        <div class="vh-meta">${esc(v.meta)}</div>
      </div>`);
    }
    list.innerHTML = [...groups].map(([g, items]) =>
      `<div class="vh-group group-title">${esc(g)}<span class="n">${num(items.length)}</span></div>${items.join("")}`).join("");
  }
  renderDetail();
  updateButtons();
}

let shownId = null;
function renderDetail() {
  const v = selected();
  $("detail").hidden = !v;
  $("detailEmpty").hidden = Boolean(v);
  if (!v) {
    shownId = null;
    $("detailEmpty").innerHTML = st.total
      ? `<div class="empty-ico">${icon("history")}</div><p>${esc(t("voice.history.detail.pick"))}</p>`
      : `<div class="empty-ico">${icon("mic")}</div><h3>${esc(t("voice.history.detail.start"))}</h3><p>${esc(t("voice.history.detail.startBody"))}</p>`;
    return;
  }
  $("dKind").className = `vh-dkind${look(v)[1]}`;
  $("dKind").innerHTML = icon(look(v)[0]);
  $("dKind").title = t({ ReadAloud: "voice.history.detail.read", Command: "voice.history.detail.command" }[v.Kind] || "voice.history.detail.dictation");
  $("dTime").textContent = v.fullTime;
  $("dStatus").className = `tag ${TAG[v.tone]}`;
  $("dStatus").innerHTML = `${v.working ? '<span class="spinner"></span>' : ""}<span class="t">${esc(v.status)}</span>`;
  $("dStatus").title = v.status;
  $("dMeta").textContent = v.detailMeta;
  // A failure that still has text (it failed on delivery) would otherwise show no reason at all.
  const err = v.Status === "Failed" && v.HasText && v.LastError ? v.LastError : "";
  $("dErr").innerHTML = err ? `${icon("alert")}<span>${esc(err)}</span>` : "";
  $("dErr").hidden = !err;
  const note = v.RewriteError && v.HasText ? t("voice.history.rewriteFailed", { mode: t(`voice.mode.${MODES.includes(v.Mode) ? v.Mode : "clean"}`), reason: v.RewriteError }) : "";
  $("dNote").innerHTML = note ? `${icon("alert")}<span>${esc(note)}</span>` : "";
  $("dNote").hidden = !note;
  if (shownId !== v.Id) st.version = "result";
  const raw = Boolean(v.RawText) && v.HasText;
  if (!raw) st.version = "result";
  $("dVersions").hidden = !raw;
  for (const b of $("dVersion").querySelectorAll("[data-version]")) {
    const on = b.dataset.version === st.version;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
  const shown = st.version === "raw" ? v.RawText : v.body;
  // Live updates must not reset the user's own text selection or scroll.
  if (dText.value !== shown) dText.value = shown;
  dText.classList.toggle("muted", !v.HasText);
  if (shownId !== v.Id) { dText.scrollTop = 0; shownId = v.Id; }
}

function updateButtons() {
  const v = selected();
  const playingThis = Boolean(v) && st.playing === v.Id;
  $("play").innerHTML = playingThis ? `${icon("stop")}<span>${esc(t("voice.history.stop"))}</span>`
    : `${icon("play")}<span>${esc(t("voice.history.play"))}</span>`;
  $("play").classList.toggle("playing", playingThis);
  $("play").disabled = !v?.HasAudio;
  $("copy").disabled = !v?.HasText;
  $("redo").innerHTML = v?.readAloud ? `${icon("speaker")}<span>${esc(t("voice.history.readAgain"))}</span>`
    : `${icon("refresh")}<span>${esc(t("voice.history.transcribeAgain"))}</span>`;
  $("redo").disabled = !v?.canRedo;
  $("del").disabled = !v?.canDelete;
  $("clear").disabled = st.total === 0;
}

function applyFilter() {
  st.views = st.all.filter(v => ofKind(v, st.kind));
  if (!st.views.some(v => v.Id === st.sel)) st.sel = st.views[0]?.Id ?? null;
}

let seq = 0;
async function refresh() {
  const n = ++seq;
  const res = await window.voiceHistory.list(st.query);
  if (n !== seq) return; // a newer refresh overtook this one
  st.total = res.total;
  st.all = res.items.map(view);
  applyFilter();
  const playing = st.all.find(v => v.Id === st.playing);
  if (playing && !playing.HasAudio) stopAudio();
  render();
}

function setKind(kind) {
  if (kind === st.kind) return;
  st.kind = kind;
  applyFilter();
  render();
  list.scrollTop = 0;
}

function select(id, reveal = false) {
  if (!id || id === st.sel) return;
  st.sel = id;
  for (const el of list.querySelectorAll(".vh-row")) {
    const on = el.dataset.id === id;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on);
    if (on && reveal) el.scrollIntoView({ block: "nearest" });
  }
  renderDetail();
  updateButtons();
}

// ---------- feedback ----------
let toastTimer;
function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 5000 : 2200);
}

// In-page confirmation, so it matches the window and its buttons speak the UI language.
function ask(text, yes) {
  const d = $("ask");
  $("askText").textContent = text;
  $("askYes").innerHTML = `${icon("trash")}<span>${esc(yes)}</span>`;
  $("askIcon").innerHTML = icon("alert");
  d.returnValue = "";
  d.showModal();
  $("askNo").focus(); // destructive: the safe answer is the default
  return new Promise(resolve => d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true }));
}

// ---------- playback ----------
function stopAudio() {
  st.playing = null;
  // Dropping the source releases the file, so the recording can be deleted right after.
  if (player.getAttribute("src")) { player.pause(); player.removeAttribute("src"); player.load(); }
  updateButtons();
}

function playFailed() {
  stopAudio();
  toast(t("voice.history.toast.playFailed"), true);
  refresh();
}

async function togglePlay() {
  const v = selected();
  if (!v?.HasAudio) return;
  if (st.playing === v.Id) return stopAudio();
  stopAudio();
  st.playing = v.Id;
  player.src = v.audioUrl;
  updateButtons();
  try { await player.play(); } catch { if (st.playing === v.Id) playFailed(); }
}

player.addEventListener("ended", stopAudio);
player.addEventListener("error", () => { if (st.playing && player.getAttribute("src")) playFailed(); });

// ---------- actions ----------
async function copyText() {
  const v = selected();
  if (!v?.HasText) return;
  if (await window.voiceHistory.copy(v.Id, st.version)) toast(t("voice.history.toast.copied"));
  else toast(t("voice.history.toast.clipboardBusy"), true);
}

async function redo() {
  const v = selected();
  if (!v?.canRedo) return;
  if (v.readAloud) stopAudio(); // never two voices at once
  const r = await window.voiceHistory.redo(v.Id);
  if (r?.ok) return toast(t(v.readAloud ? "voice.history.toast.reading" : "voice.history.toast.transcribing"));
  if (v.readAloud) return toast(r?.message || t("voice.history.toast.readFailed"), true);
  toast(t("voice.history.toast.noAudio"), true);
  refresh();
}

async function removeOne() {
  const v = selected();
  if (!v?.canDelete) return;
  if (!(await ask(t("voice.history.ask.deleteOne"), t("voice.history.delete")))) return;
  if (st.playing === v.Id) stopAudio();
  await window.voiceHistory.remove(v.Id);
  refresh();
}

async function clearAll() {
  if (!st.total) return;
  if (!(await ask(t("voice.history.ask.clearAll"), t("voice.history.ask.deleteAll")))) return;
  stopAudio();
  await window.voiceHistory.clear();
  refresh();
}

const run = fn => () => fn().catch(e => toast(e?.message || String(e), true));
$("play").addEventListener("click", run(togglePlay));
$("copy").addEventListener("click", run(copyText));
$("redo").addEventListener("click", run(redo));
$("del").addEventListener("click", run(removeOne));
$("clear").addEventListener("click", run(clearAll));
$("close").addEventListener("click", () => window.close());
$("dVersion").addEventListener("click", e => {
  const b = e.target.closest("[data-version]");
  if (!b || b.dataset.version === st.version) return;
  st.version = b.dataset.version;
  renderDetail();
});
$("kinds").addEventListener("click", e => {
  const chip = e.target.closest("[data-kind]");
  if (chip && !chip.disabled) setKind(chip.dataset.kind);
});

// ---------- search ----------
let searchTimer;
const search = $("search");
search.addEventListener("input", () => {
  $("clearSearch").hidden = !search.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { st.query = search.value.trim(); refresh(); }, 120);
});
$("clearSearch").addEventListener("click", () => {
  search.value = "";
  search.dispatchEvent(new Event("input"));
  search.focus();
});

// ---------- list & keyboard ----------
list.addEventListener("click", e => {
  const kind = e.target.closest("[data-kind]");
  if (kind) return setKind(kind.dataset.kind);
  const row = e.target.closest(".vh-row");
  if (row) select(row.dataset.id);
});
list.addEventListener("keydown", e => {
  const i = st.views.findIndex(v => v.Id === st.sel);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: st.views.length - 1, PageDown: i + 8, PageUp: i - 8 }[e.key];
  if (to !== undefined && st.views.length) {
    e.preventDefault();
    select(st.views[Math.max(0, Math.min(st.views.length - 1, to))].Id, true);
  } else if (e.key === "Delete") {
    e.preventDefault();
    run(removeOne)();
  }
});
document.addEventListener("keydown", e => {
  if ($("ask").open) return;
  if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); search.focus(); search.select(); return; }
  if (e.key !== "Escape") return;
  if (document.activeElement === search && search.value) { $("clearSearch").click(); return; }
  window.close();
});

// The divider between list and detail (VoiceTray's GridSplitter).
$("splitter").addEventListener("pointerdown", e => {
  const bar = e.currentTarget, main = $("main");
  bar.setPointerCapture(e.pointerId);
  const left = list.parentElement.getBoundingClientRect().left;
  const move = ev => main.style.setProperty("--list-w", `${Math.max(300, Math.min(ev.clientX - left, main.clientWidth - 380))}px`);
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", () => bar.removeEventListener("pointermove", move), { once: true });
});

window.voiceHistory.onChanged(refresh);
refresh().then(() => list.focus());
