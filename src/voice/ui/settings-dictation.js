// Settings -> Dictation and Dictionary: the dictation mode, the language of a prompt, how the dictation key behaves,
// and the dictionary (terms, replacements, project names). Loaded before settings.js, which calls dictationUi.fill()
// once the settings are in and spreads dictationUi.payload() into what it saves; edits inside those tabs already
// count as unsaved there.
// Uses $, esc, icon, t and tn from common.js.
const dictationUi = (() => {
  // As dictation-options.js has them (the modes: VOICE_MODES in common.js).
  const MODES = VOICE_MODES;
  const PROMPT_LANGUAGES = ["spoken", "en"];
  const TALK_MODES = ["hybrid", "toggle", "hold"];
  const TERM_CHARS = 80;
  const SHOWN_PROJECTS = 6;

  const st = { mode: "verbatim", promptLanguage: "spoken", talk: "hybrid", terms: [], reps: [], data: null };
  const fold = s => s.toLocaleLowerCase();
  // The window follows the page's height: chips and rows add lines.
  const refit = () => window.voiceSettings.fit();

  // ---------- segmented controls ----------
  const SEGS = {
    dictMode: { values: MODES, label: v => t(`voice.mode.${v}`), get: () => st.mode, set: v => { st.mode = v; modeHint(); } },
    promptLang: { values: PROMPT_LANGUAGES, label: v => t(`voice.settings.promptLanguage.${v}`), get: () => st.promptLanguage, set: v => { st.promptLanguage = v; } },
    talkMode: { values: TALK_MODES, label: v => t(`voice.settings.talk.${v}`), get: () => st.talk, set: v => { st.talk = v; talkHint(); } }
  };
  function renderSeg(id) {
    const { values, label, get } = SEGS[id], value = get();
    const focused = document.activeElement?.closest(".seg")?.id === id; // re-rendering replaces the buttons
    $(id).innerHTML = values.map(v =>
      `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${v === value}" tabindex="${v === value ? 0 : -1}" class="${v === value ? "on" : ""}">${esc(label(v))}</button>`).join("");
    if (focused) $(id).querySelector(".on")?.focus();
  }
  function choose(id, v) {
    const seg = SEGS[id];
    if (!seg.values.includes(v) || v === seg.get()) return;
    seg.set(v);
    renderSeg(id);
    refit();
  }
  for (const id of Object.keys(SEGS)) {
    $(id).addEventListener("click", e => choose(id, e.target.closest("[data-value]")?.dataset.value));
    // Arrow keys, Home and End, as in a radio group.
    $(id).addEventListener("keydown", e => {
      const { values, get } = SEGS[id], i = values.indexOf(get());
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: values.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      choose(id, values[(to + values.length) % values.length]);
      $(id).dispatchEvent(new Event("change", { bubbles: true })); // an unsaved edit, as a click would be
    });
  }

  function modeHint() {
    const d = st.data, provider = d?.settings.provider;
    const extra = st.mode === "verbatim" ? "" : ` ${t("voice.settings.modeRewrite", { provider, model: d?.rewriteModels?.[provider] || "" })}`;
    $("dictModeHint").textContent = `${t(`voice.settings.modeHint.${st.mode}`)}${extra} ${t("voice.settings.modeChip")}`;
  }
  const talkHint = () => { $("talkModeHint").textContent = t(`voice.settings.talkHint.${st.talk}`); };

  // ---------- terms: chips in front of a text field ----------
  const termInput = $("termInput");
  function renderTerms() {
    for (const el of [...$("terms").querySelectorAll(".vd-chip")]) el.remove();
    termInput.insertAdjacentHTML("beforebegin", st.terms.map((term, i) =>
      `<span class="vd-chip"><span class="vd-chip-t">${esc(term)}</span><button type="button" data-term="${i}" title="${esc(t("voice.settings.dict.remove"))}" aria-label="${esc(t("voice.settings.dict.removeTerm", { term }))}">${icon("x")}</button></span>`).join(""));
    termInput.placeholder = st.terms.length ? t("voice.settings.dict.more") : t("voice.settings.dict.termsPlaceholder");
  }
  // Commas, semicolons and line breaks separate several terms (a pasted list); one already there is not added again.
  function addTerms(text) {
    let added = false;
    for (const part of String(text).split(/[,;\n\r]+/)) {
      const term = part.replace(/\s+/g, " ").trim().slice(0, TERM_CHARS);
      if (!term || st.terms.some(x => fold(x) === fold(term))) continue;
      st.terms.push(term);
      added = true;
    }
    if (added) { renderTerms(); refit(); }
    return added;
  }
  function commitInput() {
    const text = termInput.value;
    termInput.value = "";
    return text.trim() ? addTerms(text) : false;
  }
  termInput.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault(); // Enter would submit the form
      commitInput();
    } else if (e.key === "Backspace" && !termInput.value && st.terms.length) {
      st.terms.pop();
      renderTerms();
      refit();
      termInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  termInput.addEventListener("paste", e => {
    const text = e.clipboardData?.getData("text") || "";
    if (!/[,;\n]/.test(text)) return;
    e.preventDefault();
    addTerms(termInput.value + text);
    termInput.value = "";
  });
  termInput.addEventListener("blur", commitInput);
  $("terms").addEventListener("click", e => {
    const b = e.target.closest("[data-term]");
    if (!b) return termInput.focus();
    st.terms.splice(Number(b.dataset.term), 1);
    renderTerms();
    refit();
    termInput.focus();
  });

  // ---------- replacements: "spoken -> written" rows ----------
  function renderReps() {
    $("reps").innerHTML = st.reps.map((r, i) => `<div class="vd-rep" data-rep="${i}">
      <input class="input" data-side="from" type="text" spellcheck="false" autocomplete="off" maxlength="200" value="${esc(r.from)}" placeholder="${esc(t("voice.settings.dict.spoken"))}" aria-label="${esc(t("voice.settings.dict.spoken"))}">
      <span class="vd-arrow" aria-hidden="true">${icon("right")}</span>
      <input class="input" data-side="to" type="text" spellcheck="false" autocomplete="off" maxlength="200" value="${esc(r.to)}" placeholder="${esc(t("voice.settings.dict.written"))}" aria-label="${esc(t("voice.settings.dict.written"))}">
      <button type="button" class="icon-btn" data-remove-rep="${i}" title="${esc(t("voice.settings.dict.remove"))}">${icon("trash")}</button>
    </div>`).join("");
    $("reps").hidden = !st.reps.length;
  }
  $("reps").addEventListener("input", e => {
    const row = e.target.closest("[data-rep]");
    if (!row) return;
    st.reps[Number(row.dataset.rep)][e.target.dataset.side] = e.target.value;
    e.target.classList.remove("invalid");
    document.querySelector('[data-err="dictionary.replacements"]').textContent = "";
  });
  $("reps").addEventListener("click", e => {
    const b = e.target.closest("[data-remove-rep]");
    if (!b) return;
    st.reps.splice(Number(b.dataset.removeRep), 1);
    renderReps();
    refit();
  });
  $("repAdd").innerHTML = `${icon("plus")}<span>${esc(t("voice.settings.dict.add"))}</span>`;
  $("repAdd").addEventListener("click", () => {
    st.reps.push({ from: "", to: "" });
    renderReps();
    refit();
    $("reps").lastElementChild?.querySelector("input")?.focus();
  });

  // ---------- project names ----------
  function renderProjects() {
    const names = st.data?.projectNames || [];
    $("dictProjectsCount").textContent = tn("voice.settings.dict.projectsCount", names.length);
    const shown = names.slice(0, SHOWN_PROJECTS).join(", ");
    $("dictProjectsHint").textContent = !names.length ? t("voice.settings.dict.projectsNone")
      : t(names.length > SHOWN_PROJECTS ? "voice.settings.dict.projectsSomeOf" : "voice.settings.dict.projectsAll", { list: shown });
  }

  // ---------- in and out ----------
  function fill(s, d) {
    st.data = d;
    st.mode = s.dictationMode;
    st.promptLanguage = s.promptLanguage;
    st.talk = s.pushToTalk;
    st.terms = [...(s.dictionary?.terms || [])];
    st.reps = (s.dictionary?.replacements || []).map(r => ({ ...r }));
    $("dictProjects").checked = s.dictionary?.projectNames !== false;
    for (const id of Object.keys(SEGS)) renderSeg(id);
    modeHint();
    talkHint();
    renderTerms();
    renderReps();
    renderProjects();
  }

  // What Save sends. A term still being typed counts; an empty replacement row is dropped, a half-filled one is
  // sent so that main can say what is missing.
  function payload() {
    commitInput();
    return {
      dictationMode: st.mode,
      promptLanguage: st.promptLanguage,
      pushToTalk: st.talk,
      dictionary: {
        terms: [...st.terms],
        replacements: st.reps.filter(r => r.from.trim() || r.to.trim()).map(r => ({ from: r.from, to: r.to })),
        projectNames: $("dictProjects").checked
      }
    };
  }

  // A provider switched on the page changes what the hint names (settings.js re-renders the control first).
  for (const type of ["click", "keydown"]) $("provider").addEventListener(type, () => setTimeout(() => {
    const on = $("provider").querySelector(".on")?.dataset.provider;
    if (!st.data || !on || on === st.data.settings.provider) return;
    st.data = { ...st.data, settings: { ...st.data.settings, provider: on } };
    modeHint();
  }));

  return { fill, payload };
})();
