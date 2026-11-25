// Settings -> Models: the API key of each provider, and for every task the provider and model that do it. Loaded
// before settings.js, which calls modelsUi.fill() once the settings are in and spreads modelsUi.payload() into what it
// saves. What is offered, the defaults and what is known of each model come from main (catalog.js).
// Uses $, esc, icon and t from common.js.
const modelsUi = (() => {
  const OTHER = "*"; // the "other id" option: no model id can be that
  const DAY = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  // tasks: the working copy; other: "task|provider" where a typed id was asked for.
  const st = { data: null, specs: new Map(), tasks: {}, keys: {}, other: new Set(), onChange: () => {} };

  const options = list => list.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");

  // What does a task as the page stands: as catalog.js resolveTask(), plus the task whose model that is. A task that
  // follows the dictation to a provider with no model for it (Soniox writes no text) is done by its own first one.
  function target(id) {
    const spec = st.specs.get(id), own = st.tasks[id];
    let provider = own.provider || st.tasks.dictation.provider;
    if (!own.provider && !spec.models[provider]) provider = Object.keys(spec.models)[0];
    const from = spec.sameModel && !own.provider ? "dictation" : id;
    return { provider, from, model: st.tasks[from].models[provider] || spec.models[provider][0] };
  }

  // ---------- API keys ----------
  function buildKeys() {
    $("modelKeys").innerHTML = st.data.providers.map(p => `<label class="vs-label" for="apiKey.${esc(p)}">${esc(p)}</label>
      <div class="vs-field" role="group" aria-label="${esc(p)}" data-provider="${esc(p)}">
        <div class="vs-key">
          <input id="apiKey.${esc(p)}" class="input" type="password" spellcheck="false" autocomplete="new-password" aria-describedby="keyState.${esc(p)}">
          <span class="tag" data-part="tag"></span>
        </div>
        <div class="vs-keystate" id="keyState.${esc(p)}"></div>
        <div class="vs-err" data-err="apiKey.${esc(p)}"></div>
      </div>`).join("");
  }

  function renderKey(p) {
    const k = st.keys[p], saved = Boolean(st.data.hasKey[p]), input = $(`apiKey.${p}`);
    const text = key => `<span>${esc(t(key))}</span>`;
    const link = (key, action, cls = "") => `<button type="button" class="vs-link${cls}" data-key="${action}">${esc(t(key))}</button>`;
    let html, tag;
    if (input.value.trim()) { tag = ["accent", "key", "voice.settings.key.tag.new"]; html = text(saved ? "voice.settings.key.replaces" : "voice.settings.key.willEncrypt"); }
    else if (saved && k.clear) { tag = ["warn", "trash", "voice.settings.key.tag.removing"]; html = text("voice.settings.key.removeOnSave") + link("voice.settings.key.undo", "undo"); }
    else if (saved) { tag = ["ok", "check", "voice.settings.key.tag.saved"]; html = text("voice.settings.key.savedInfo") + link("voice.settings.key.remove", "clear", " danger"); }
    else { tag = ["warn", "alert", "voice.settings.key.tag.none"]; html = text("voice.settings.key.noneInfo"); }
    const tagEl = input.parentElement.querySelector('[data-part="tag"]');
    tagEl.className = `tag ${tag[0]}`;
    tagEl.innerHTML = `${icon(tag[1])}${esc(t(tag[2]))}`;
    $(`keyState.${p}`).innerHTML = html;
    input.placeholder = saved && !k.clear ? "••••••••••••" : t("voice.settings.key.placeholder", { provider: p });
  }

  function resetKeys(hasKey) {
    st.data.hasKey = hasKey;
    for (const p of st.data.providers) {
      st.keys[p] = { clear: false };
      $(`apiKey.${p}`).value = "";
      renderKey(p);
    }
  }

  // ---------- tasks ----------
  function buildTasks() {
    $("modelTasks").innerHTML = [...st.specs.values()].map(({ id, provider, models }) => {
      const name = esc(t(`voice.task.${id}`));
      const providers = [...(provider ? [] : [["", t("voice.settings.models.asDictation")]]), ...Object.keys(models).map(p => [p, p])];
      return `<span class="vs-label" id="task.${id}">${name}</span>
        <div class="vs-field" role="group" aria-labelledby="task.${id}" data-task="${id}">
          <div class="vm-row">
            <select class="select" data-part="provider" aria-label="${name}: ${esc(t("voice.settings.provider"))}"${providers.length < 2 ? " disabled" : ""}>${options(providers)}</select>
            <select class="select" data-part="model" aria-label="${name}: ${esc(t("voice.settings.model"))}"></select>
          </div>
          <input id="tasks.${id}" class="input mono vm-other" data-part="other" type="text" maxlength="100" spellcheck="false" autocomplete="off" aria-label="${name}: ${esc(t("voice.settings.models.otherId"))}" hidden>
          <div class="vs-hint vm-warn" data-part="warning" role="status" hidden></div>
          <div class="vs-err" data-err="tasks.${id}"></div>
        </div>`;
    }).join("");
  }
  const part = (id, name) => $("modelTasks").querySelector(`[data-task="${id}"] [data-part="${name}"]`);

  function renderTask(id) {
    const { provider, from, model } = target(id), offered = st.specs.get(id).models[provider], follows = from !== id;
    const other = !follows && (st.other.has(`${id}|${provider}`) || !offered.includes(model));
    const list = follows ? [[model, model]] : [...offered.map(m => [m, m]), [OTHER, t("voice.settings.models.other")]];
    const select = part(id, "model"), input = part(id, "other");
    part(id, "provider").value = st.tasks[id].provider;
    select.innerHTML = options(list);
    select.value = other ? OTHER : model;
    select.disabled = follows;
    input.hidden = !other;
    input.placeholder = offered[0];
    if (document.activeElement !== input) input.value = st.tasks[id].models[provider];
    renderWarning(id);
  }

  // A task done by another provider than the dictation it follows, a model that stops or is re-routed, and a meeting
  // transcript whose times will only be approximate.
  function warnings(id) {
    const { provider, from, model } = target(id);
    if (from !== id) return []; // the dictation's row says it
    const info = st.data.catalog[provider][model.toLowerCase()], out = [], dictation = st.tasks.dictation.provider;
    if (!st.tasks[id].provider && provider !== dictation) out.push(t("voice.settings.models.notAsDictation", { dictation, provider }));
    if (info?.rerouted) out.push(t("voice.settings.models.rerouted", { model, successor: info.successor }));
    else if (info?.shutdown) {
      out.push(t("voice.settings.models.stops", { model, successor: info.successor, date: I18N.formatDate(Date.parse(info.shutdown), DAY) }));
    }
    if (id === "meetingTranscription" && info?.timestamps !== "word") out.push(t("voice.settings.models.approximateTimes"));
    return out;
  }
  // True when the page's height may have changed with it.
  function renderWarning(id) {
    const el = part(id, "warning"), text = warnings(id).join(" ");
    if (el.textContent.trim() === text) return false;
    el.innerHTML = text ? `${icon("alert")}<span>${esc(text)}</span>` : "";
    el.hidden = !text;
    return true;
  }

  function renderTasks() {
    for (const id of st.specs.keys()) renderTask(id);
  }

  // ---------- events ----------
  $("modelKeys").addEventListener("input", e => {
    const p = e.target.closest("[data-provider]")?.dataset.provider;
    if (!p) return;
    if (e.target.value.trim()) st.keys[p].clear = false; // typing a new key supersedes "remove"
    e.target.classList.remove("invalid", "warned");
    document.querySelector(`[data-err="apiKey.${p}"]`).textContent = "";
    renderKey(p);
  });
  $("modelKeys").addEventListener("click", e => {
    const action = e.target.closest("[data-key]")?.dataset.key, field = e.target.closest("[data-provider]");
    if (!action) return;
    st.keys[field.dataset.provider].clear = action === "clear";
    renderKey(field.dataset.provider);
    field.querySelector("[data-key]")?.focus(); // the link that took its place
  });

  $("modelTasks").addEventListener("change", e => {
    const id = e.target.closest("[data-task]")?.dataset.task;
    if (!id) return;
    const own = st.tasks[id], name = e.target.dataset.part;
    if (name === "provider") own.provider = e.target.value;
    else if (name === "model") {
      const { provider, model } = target(id), typed = e.target.value === OTHER;
      if (typed) st.other.add(`${id}|${provider}`);
      else st.other.delete(`${id}|${provider}`);
      own.models[provider] = typed ? model : e.target.value;
    }
    document.querySelector(`[data-err="tasks.${id}"]`).textContent = "";
    part(id, "other").classList.remove("invalid");
    if (id === "dictation") renderTasks(); // the tasks that follow it
    else renderTask(id);
    st.onChange();
    window.voiceSettings.fit();
  });
  $("modelTasks").addEventListener("input", e => {
    if (e.target.dataset.part !== "other") return;
    const id = e.target.closest("[data-task]").dataset.task;
    st.tasks[id].models[target(id).provider] = e.target.value.trim();
    e.target.classList.remove("invalid");
    document.querySelector(`[data-err="tasks.${id}"]`).textContent = "";
    if (id === "dictation") renderTask("commands");
    st.onChange();
    if (renderWarning(id)) window.voiceSettings.fit();
  });

  // ---------- in and out ----------
  // onChange: a choice that other tabs name (the recording limit, the rewrite's model) has changed.
  function fill(d, onChange) {
    Object.assign(st, { data: d, onChange, tasks: structuredClone(d.settings.tasks), specs: new Map(d.tasks.map(task => [task.id, task])) });
    buildKeys();
    resetKeys(d.hasKey);
    buildTasks();
    renderTasks();
  }

  // What Save sends. An empty key field keeps the saved key: removing one takes the link.
  function payload() {
    const apiKeys = {};
    for (const p of st.data.providers) {
      const typed = $(`apiKey.${p}`).value.trim();
      if (typed) apiKeys[p] = { set: typed };
      else if (st.keys[p].clear) apiKeys[p] = { clear: true };
    }
    return { tasks: structuredClone(st.tasks), apiKeys };
  }

  return { fill, payload, target, saved: resetKeys };
})();
