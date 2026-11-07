// Settings -> Commands: voice commands on or off, and whether holding the edge menu's hotkey speaks one or only its
// microphone does. What is said goes to the command centre (orchestrator.js). Applied at once, like General; main
// checks every value (command-options.js). Loaded before settings.js, which switches tabs and sizes the window. Uses
// $, esc, icon and t from common.js.
(() => {
  const pane = $("commands");
  let data = null; // {commands, hotkey}

  pane.innerHTML = `
    <section class="vs-sec">
      <h2>${icon("mic")}<span>${esc(t("settings.commands.title"))}</span></h2>
      <div class="vs-grid">
        <span class="vs-label">${esc(t("settings.commands.label"))}</span>
        <div class="vs-field">
          <label class="vs-toggle" for="cmdEnabled"><span><b>${esc(t("settings.commands.enabled"))}</b></span><input type="checkbox" id="cmdEnabled" class="switch"></label>
          <div class="vs-hint" id="cmdExamples"></div>
        </div>
        <span class="vs-label" id="cmdTriggerLabel">${esc(t("settings.commands.trigger"))}</span>
        <div class="vs-field"><div class="seg" id="cmdTrigger" role="radiogroup" aria-labelledby="cmdTriggerLabel"></div><div class="vs-hint" id="cmdTriggerHint"></div></div>
      </div>
      <div class="vs-err" data-err="commands"></div>
      <p class="vs-hint vs-privacy">${esc(t("settings.commands.privacy"))}</p>
    </section>`;

  const TRIGGERS = ["hold", "off"];

  function renderTrigger() {
    const value = data.commands.trigger, off = !data.commands.enabled;
    const focused = document.activeElement?.closest(".seg")?.id === "cmdTrigger"; // re-rendering replaces the buttons
    $("cmdTrigger").innerHTML = TRIGGERS.map(v => `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${v === value}" ` +
      `tabindex="${v === value ? 0 : -1}" class="${v === value ? "on" : ""}"${off ? " disabled" : ""}>${esc(t(`settings.commands.trigger.${v}`, { key: data.hotkey || "—" }))}</button>`).join("");
    if (focused) $("cmdTrigger").querySelector(".on")?.focus();
  }

  function render() {
    const c = data.commands, key = data.hotkey;
    $("cmdEnabled").checked = c.enabled;
    $("cmdExamples").textContent = t(key ? "settings.commands.examples" : "settings.commands.examplesNoKey", { key });
    renderTrigger();
    $("cmdTriggerHint").textContent = t(`settings.commands.triggerHint.${c.trigger}`, { key: key || "—" });
    if (document.body.dataset.tab === "commands") window.voiceSettings.fit();
  }

  async function set(patch) {
    const slot = pane.querySelector('[data-err="commands"]');
    slot.textContent = "";
    data.commands = { ...data.commands, ...patch }; // at once; main's answer is what stays
    render();
    try {
      const r = await window.voiceSettings.commands.set(patch);
      if (r?.ok) data.commands = r.commands;
      else slot.textContent = t("voice.settings.err.value");
    } catch (e) { slot.textContent = e?.message || String(e); }
    render();
  }

  $("cmdTrigger").addEventListener("click", e => {
    const v = e.target.closest("[data-value]")?.dataset.value;
    if (v && v !== data.commands.trigger) set({ trigger: v });
  });
  // Arrow keys, Home and End, as in a radio group.
  $("cmdTrigger").addEventListener("keydown", e => {
    const i = TRIGGERS.indexOf(data.commands.trigger);
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: TRIGGERS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    set({ trigger: TRIGGERS[(to + TRIGGERS.length) % TRIGGERS.length] });
  });
  $("cmdEnabled").addEventListener("change", e => set({ enabled: e.target.checked }));
  $("cmdClose").addEventListener("click", () => window.close());

  window.voiceSettings.commands.get().then(d => {
    if (!d) { $("tabCommands").hidden = true; return; }
    data = d;
    render();
  }).catch(() => { $("tabCommands").hidden = true; });
})();
