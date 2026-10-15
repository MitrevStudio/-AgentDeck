// Settings -> Commands: voice commands on or off, holding the edge menu's hotkey or only its microphone, and how a new
// session starts (agent, prompt mode, countdown). Applied at once, like General; main checks every value
// (command-options.js). Loaded before settings.js, which switches tabs and sizes the window. Uses $, esc, icon, t and
// tn from common.js.
(() => {
  const MODES = [...VOICE_MODES].reverse(); // the prompt first: what a new session usually wants
  const COUNTDOWNS = [0, 1, 2, 3, 4, 5, 7, 10];
  const pane = $("commands");
  let data = null; // {commands, agents, hotkey}

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
    </section>
    <section class="vs-sec">
      <h2>${icon("terminal")}<span>${esc(t("settings.commands.newSessions"))}</span></h2>
      <div class="vs-grid">
        <span class="vs-label" id="cmdAgentLabel">${esc(t("settings.commands.agent"))}</span>
        <div class="vs-field"><div class="seg" id="cmdAgent" role="radiogroup" aria-labelledby="cmdAgentLabel"></div><div class="vs-hint">${esc(t("settings.commands.agentHint"))}</div></div>
        <span class="vs-label" id="cmdModeLabel">${esc(t("settings.commands.mode"))}</span>
        <div class="vs-field"><div class="seg" id="cmdMode" role="radiogroup" aria-labelledby="cmdModeLabel"></div><div class="vs-hint" id="cmdModeHint"></div></div>
        <label class="vs-label" for="cmdCountdown">${esc(t("settings.commands.countdown"))}</label>
        <div class="vs-field"><select id="cmdCountdown" class="select"></select><div class="vs-hint">${esc(t("settings.commands.countdownHint"))}</div></div>
      </div>
      <div class="vs-err" data-err="commands"></div>
      <p class="vs-hint vs-privacy">${esc(t("settings.commands.privacy"))}</p>
    </section>`;

  const SEGS = {
    cmdTrigger: { key: "trigger", values: () => ["hold", "off"], label: v => t(`settings.commands.trigger.${v}`, { key: data.hotkey || "—" }) },
    cmdAgent: { key: "agent", values: () => data.agents, label: v => v },
    cmdMode: { key: "promptMode", values: () => MODES, label: v => t(`voice.mode.${v}`) }
  };

  function renderSeg(id) {
    const { key, values, label } = SEGS[id], value = data.commands[key], off = !data.commands.enabled;
    const focused = document.activeElement?.closest(".seg")?.id === id; // re-rendering replaces the buttons
    $(id).innerHTML = values().map(v => `<button type="button" role="radio" data-value="${esc(v)}" aria-checked="${v === value}" ` +
      `tabindex="${v === value ? 0 : -1}" class="${v === value ? "on" : ""}"${off ? " disabled" : ""}>${esc(label(v))}</button>`).join("");
    if (focused) $(id).querySelector(".on")?.focus();
  }

  function render() {
    const c = data.commands, key = data.hotkey;
    $("cmdEnabled").checked = c.enabled;
    $("cmdExamples").textContent = t(key ? "settings.commands.examples" : "settings.commands.examplesNoKey", { key });
    for (const id of Object.keys(SEGS)) renderSeg(id);
    $("cmdTriggerHint").textContent = t(`settings.commands.triggerHint.${c.trigger}`, { key: key || "—" });
    $("cmdModeHint").textContent = t(`settings.commands.modeHint.${c.promptMode}`);
    const sel = $("cmdCountdown");
    sel.innerHTML = COUNTDOWNS.map(n => `<option value="${n}">${esc(n ? tn("settings.commands.seconds", n) : t("settings.commands.atOnce"))}</option>`).join("");
    sel.value = String(c.countdown);
    sel.disabled = !c.enabled;
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

  for (const id of Object.keys(SEGS)) {
    const seg = SEGS[id];
    $(id).addEventListener("click", e => {
      const v = e.target.closest("[data-value]")?.dataset.value;
      if (v && v !== data.commands[seg.key]) set({ [seg.key]: v });
    });
    // Arrow keys, Home and End, as in a radio group.
    $(id).addEventListener("keydown", e => {
      const values = seg.values(), i = values.indexOf(data.commands[seg.key]);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: values.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      set({ [seg.key]: values[(to + values.length) % values.length] });
    });
  }
  $("cmdEnabled").addEventListener("change", e => set({ enabled: e.target.checked }));
  $("cmdCountdown").addEventListener("change", e => set({ countdown: Number(e.target.value) }));
  $("cmdClose").addEventListener("click", () => window.close());

  window.voiceSettings.commands.get().then(d => {
    if (!d) { $("tabCommands").hidden = true; return; }
    data = d;
    render();
  }).catch(() => { $("tabCommands").hidden = true; });
})();
