// The recording in the top bar, whatever project is shown: the time, the two levels, the screenshots, what is wrong,
// stop and discard. Built once and changed in place: the levels come ten times a second.
const meetingsIndicator = (() => {
  const { live, call, report, errorText, clock } = meetingsShared;
  const METER_FLOOR_DB = 60; // below it a meter is empty
  const box = $("meetingRec");

  box.innerHTML = `<span class="rec-dot" aria-hidden="true"></span><b class="rec-state"></b><span class="rec-time" role="timer"></span><span class="rec-project"></span>
    <span class="rec-meters">${[["mic", "mic"], ["system", "speaker"]].map(([channel, mark]) =>
      `<span class="rec-meter" data-channel="${channel}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="${esc(t(`meetings.rec.${channel}`))}" aria-label="${esc(t(`meetings.rec.${channel}`))}">${icon(mark)}<span><i></i></span></span>`).join("")}</span>
    <button type="button" class="icon-btn rec-shot" data-rec="shot">${icon("camera")}<span class="rec-count">0</span></button>
    <button type="button" class="icon-btn rec-warn" data-rec="warnings" aria-haspopup="menu" hidden>${icon("alert")}<span class="rec-count"></span></button>
    <button type="button" class="icon-btn rec-stop" data-rec="stop" title="${esc(t("meetings.rec.stop"))}" aria-label="${esc(t("meetings.rec.stop"))}">${icon("stop")}</button>
    <button type="button" class="icon-btn danger" data-rec="discard" title="${esc(t("meetings.rec.discard"))}" aria-label="${esc(t("meetings.rec.discard"))}">${icon("trash")}</button>`;
  const part = selector => box.querySelector(selector);
  const meters = [...box.querySelectorAll(".rec-meter")];
  let elapsedMs = 0;

  function warningText({ code, monitor }) {
    return monitor ? `${t("meetings.monitor", { n: monitor })}: ${errorText(code)}` : errorText(code);
  }
  function label(button, text) {
    if (button.dataset.label === text) return;
    button.dataset.label = text;
    button.title = text;
    button.setAttribute("aria-label", text);
  }
  function drawTime() {
    const text = clock(elapsedMs), el = part(".rec-time");
    if (el.textContent !== text) el.textContent = text;
  }
  function setLevel(meter, peak) {
    const share = peak > 0 ? Math.round(Math.max(0, Math.min(1, 1 + 20 * Math.log10(peak) / METER_FLOOR_DB)) * 100) : 0;
    if (meter.getAttribute("aria-valuenow") === String(share)) return;
    meter.setAttribute("aria-valuenow", share);
    meter.querySelector("i").style.width = `${share}%`;
  }

  function render() {
    const { phase, recording: rec } = live.status, on = phase !== "idle" && Boolean(rec);
    document.body.classList.toggle("meeting-recording", on);
    if (!on) {
      const focused = box.contains(document.activeElement);
      box.hidden = true;
      if (focused) $("meetingsBtn").focus();
      elapsedMs = 0;
      meters.forEach(meter => setLevel(meter, 0));
      return;
    }
    box.hidden = false;
    box.dataset.phase = phase;
    const recording = phase === "recording";
    const about = [rec.title || t("meetings.untitled"), rec.name, rec.microphone].filter(Boolean).join(" · ");
    box.setAttribute("aria-label", `${t(`meetings.rec.${phase}`)}: ${about}`);
    part(".rec-state").textContent = recording ? t("meetings.rec.badge") : t(`meetings.rec.${phase}`);
    part(".rec-project").textContent = rec.name;
    part(".rec-project").title = about;
    if (recording || phase === "stopping") elapsedMs = Math.max(elapsedMs, rec.elapsedMs);
    else elapsedMs = 0;
    drawTime();

    const shot = part(".rec-shot");
    shot.querySelector(".rec-count").textContent = rec.screens;
    const key = rec.shortcut.registered ? ` (${rec.shortcut.accelerator.replace(/Control/g, "Ctrl")})` : "";
    label(shot, t("meetings.rec.shot", { n: rec.screens }) + key);
    const warn = part(".rec-warn");
    warn.hidden = !rec.warnings.length;
    warn.querySelector(".rec-count").textContent = rec.warnings.length;
    label(warn, [t("meetings.rec.warnings"), ...rec.warnings.map(warningText)].join("\n"));
    for (const name of ["shot", "stop", "discard"]) part(`[data-rec="${name}"]`).disabled = !recording;
  }

  function levels(event) {
    if (live.status.phase !== "recording") return;
    elapsedMs = event.elapsedMs;
    drawTime();
    for (const meter of meters) setLevel(meter, event[meter.dataset.channel]);
  }

  async function discard() {
    const sure = await confirmDialog({ title: t("meetings.rec.discardTitle"), body: t("meetings.rec.discardBody"), confirmLabel: t("meetings.rec.discard"), danger: true });
    if (sure) await call("discard");
  }
  function showWarnings(button) {
    const items = (live.status.recording?.warnings || []).map(warning => ({ label: warningText(warning), icon: "alert", disabled: true }));
    if (items.length) openMenu(button, "", items, "meetings-notes");
  }
  box.addEventListener("click", e => {
    const button = e.target.closest("[data-rec]");
    if (!button) return;
    const { rec } = button.dataset;
    if (rec === "warnings") showWarnings(button);
    else if (rec === "discard") discard().catch(report);
    else call(rec === "stop" ? "stop" : "screenshot").catch(report);
  });

  return { render, levels, warningText };
})();
