// What is asked before anything goes to a provider: who transcribes and who summarizes this meeting, in what language,
// and what that costs. The choice is this meeting's; Settings -> Models has the task's. The language is detected
// unless chosen, and the last one is remembered by this window (localStorage), as the recording's choices are.
const meetingsProcess = (() => {
  const { call, dialog, openSettings } = meetingsShared;
  const LANGUAGE_KEY = "agentdeck.meetingLanguages";
  const PAIR = "bg,en"; // a Bulgarian meeting with English terms in it

  function readLanguages() {
    try { return localStorage.getItem(LANGUAGE_KEY) || ""; } catch { return ""; }
  }
  function saveLanguages(value) {
    try { localStorage.setItem(LANGUAGE_KEY, value); } catch { /* only the next dialog's default */ }
  }
  // codes: what the main process takes. "" detects; a value is the codes joined by commas.
  function languageOptions(codes) {
    const names = new Intl.DisplayNames([I18N.locale()], { type: "language" });
    const name = code => { const text = names.of(code) || code; return text.charAt(0).toLocaleUpperCase(I18N.locale()) + text.slice(1); };
    return [["", t("meetings.language.auto")], [PAIR, t("meetings.language.bgEn")], ...codes.map(code => [code, name(code)])];
  }

  function money(value) {
    return I18N.formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: value < 0.1 ? 3 : 2 });
  }
  function costText(cost) {
    if (!cost) return t("meetings.cost.unknown");
    const min = money(cost.min), max = money(cost.max);
    return min === max ? t("meetings.cost.one", { cost: max }) : t("meetings.cost.range", { min, max });
  }

  function fieldset(task) {
    const name = esc(t(task === "transcription" ? "voice.task.meetingTranscription" : "voice.task.meetingSummary"));
    return `<fieldset class="mr-task" data-task="${task}"><legend>${name}</legend>
      <div class="modal-row">
        <label><span>${esc(t("voice.settings.provider"))}</span><select class="select" data-part="provider" aria-label="${name}: ${esc(t("voice.settings.provider"))}"></select></label>
        <label><span>${esc(t("voice.settings.model"))}</span><select class="select" data-part="model" aria-label="${name}: ${esc(t("voice.settings.model"))}"></select></label>
      </div>
      ${task === "transcription" ? `<label class="mr-language"><span>${esc(t("meetings.language.label"))}</span><select class="select" data-part="languages"></select></label>` : ""}
      <div class="modal-note" data-part="note"></div>
      <div class="mr-cost" data-part="cost"></div></fieldset>`;
  }

  // summaryOnly: the summary alone. again: a new run, which is paid again. run(choices): what the confirm does.
  function open({ project, id, title, summaryOnly = false, again = false, run }) {
    const tasks = summaryOnly ? ["summary"] : ["transcription", "summary"];
    const action = summaryOnly ? (again ? "meetings.action.summarizeAgain" : "meetings.action.summarize")
      : again ? "meetings.action.again" : "meetings.action.transcribe";
    const d = dialog("modal meeting-process", `<form method="dialog" class="modal-form">
      <h2 id="meetingProcessTitle">${icon("bolt")}<span>${esc(t(action))}</span></h2>
      <p class="mr-sub">${esc(title)}</p>
      ${again ? `<p class="mr-notice warn">${icon("alert")}<span>${esc(t("meetings.cost.again"))}</span></p>` : ""}
      ${tasks.map(fieldset).join("")}
      <div class="mr-total" role="status"><span>${esc(t("meetings.cost.label"))}</span><b data-part="total"></b></div>
      <p class="modal-note">${esc(t("meetings.cost.note"))}</p>
      <p class="mr-notice warn" data-part="nokey" role="alert" hidden>${icon("key")}<span></span><button type="button" class="btn sm" data-part="settings">${esc(t("meetings.openSettings"))}</button></p>
      <p class="modal-hint err" data-part="error" role="alert"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-part="cancel">${esc(t("common.cancel"))}</button>
        <button type="submit" class="btn primary" data-part="go" disabled>${esc(t(action))}</button>
      </div></form>`);
    const part = name => d.querySelector(`[data-part="${name}"]`);
    const within = (task, name) => d.querySelector(`[data-task="${task}"] [data-part="${name}"]`);
    let options = null, asked = 0;

    const chosen = () => Object.fromEntries(tasks.map(task => [task, { provider: within(task, "provider").value, model: within(task, "model").value }]));
    const providerOf = task => options[task].providers.find(p => p.name === within(task, "provider").value);

    function fillModels(task, model) {
      const provider = providerOf(task), select = within(task, "model");
      select.innerHTML = provider.models.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
      select.value = model || provider.model;
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }
    function fill() {
      const languages = part("languages");
      if (languages) {
        const list = languageOptions(options.languages);
        languages.innerHTML = list.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
        languages.value = readLanguages();
        if (languages.selectedIndex < 0) languages.value = "";
      }
      for (const task of tasks) {
        const { providers, provider, model } = options[task], select = within(task, "provider");
        select.innerHTML = providers.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
        select.value = provider;
        if (select.selectedIndex < 0) select.selectedIndex = 0;
        fillModels(task, select.value === provider ? model : "");
      }
    }

    async function update() {
      const choices = chosen(), turn = ++asked;
      const missing = [...new Set(tasks.map(task => choices[task].provider).filter(provider => !options.keys[provider]))];
      part("nokey").hidden = !missing.length;
      part("nokey").querySelector("span").textContent = t("meetings.noKey", { providers: missing.join(", ") });
      part("go").disabled = Boolean(missing.length);
      if (!summaryOnly) {
        const model = providerOf("transcription").models.find(m => m.id === choices.transcription.model);
        within("transcription", "note").textContent = model?.approximate ? t("voice.settings.models.approximateTimes") : "";
      }
      let estimate = null;
      try {
        estimate = await call("estimate", project, id, choices);
        if (turn === asked) part("error").textContent = "";
      } catch (error) {
        if (turn === asked) part("error").textContent = error.message;
      }
      if (turn !== asked) return;
      for (const task of tasks) within(task, "cost").textContent = costText(estimate?.[task].cost);
      // The language costs nothing more: it is said beside the transcript's cost as it was chosen.
      const languages = part("languages");
      if (languages) within("transcription", "cost").textContent += ` · ${languages.selectedOptions[0]?.textContent || ""}`;
      part("total").textContent = costText(summaryOnly ? estimate?.summary.cost : estimate?.cost);
    }

    d.addEventListener("change", e => {
      const task = e.target.closest("[data-task]")?.dataset.task;
      if (!task || !options) return;
      if (e.target.dataset.part === "provider") fillModels(task);
      update();
    });
    part("cancel").addEventListener("click", () => d.close());
    part("settings").addEventListener("click", () => openSettings().catch(error => { part("error").textContent = error.message; }));
    d.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      if (!options || part("go").disabled) return;
      const choices = chosen(), languages = part("languages")?.value;
      d.close();
      if (languages === undefined) return run({ ...choices, again });
      saveLanguages(languages);
      run({ ...choices, languages: languages ? languages.split(",") : [], again });
    });
    // Back from Settings: the key may be there now.
    const recheck = async () => {
      if (!options) return;
      try {
        options.keys = (await call("options")).keys;
        update();
      } catch (error) {
        part("error").textContent = error.message;
      }
    };
    window.addEventListener("focus", recheck);
    d.addEventListener("close", () => window.removeEventListener("focus", recheck));

    call("options").then(value => {
      options = value;
      fill();
      within(tasks[0], "provider").focus();
      return update();
    }).catch(error => { part("error").textContent = error.message; });
  }

  return { open };
})();
