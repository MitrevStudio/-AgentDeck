// Before a recording: the title, the microphone and what the screenshot key takes: monitors, windows that are open
// now, or both. The last choice is remembered by this window (localStorage), as its other conveniences are; a window
// is not, it is another one the next time.
const meetingsStart = (() => {
  const { live, call, dialog, accelerator } = meetingsShared;
  const CHOICE_KEY = "agentdeck.meetingRecording";
  const WINDOWS_MAX = 8; // as ipc.js takes
  const PSEUDO = ["default", "communications"]; // Chromium's entries for a device that is listed anyway

  function readChoice() {
    try {
      const saved = JSON.parse(localStorage.getItem(CHOICE_KEY));
      return { microphone: saved?.microphone || null, monitors: Array.isArray(saved?.monitors) ? saved.monitors : [], windowsOnly: saved?.windowsOnly === true };
    } catch {
      return { microphone: null, monitors: [], windowsOnly: false };
    }
  }
  function saveChoice(choice) {
    try { localStorage.setItem(CHOICE_KEY, JSON.stringify(choice)); } catch { /* only the next dialog's defaults */ }
  }

  function microphoneOptions(list, saved) {
    const system = list.find(m => m.isDefault), real = list.filter(m => !PSEUDO.includes(m.deviceId));
    const options = [
      ["default", system?.label ? t("meetings.start.micDefaultNamed", { name: system.label.replace(/^Default - /, "") }) : t("meetings.start.micDefault")],
      ...real.map((m, i) => [m.deviceId, m.label || t("meetings.start.micNumbered", { n: i + 1 })])
    ];
    const match = real.find(m => m.deviceId === saved?.deviceId) || (saved?.label && real.find(m => m.label === saved.label));
    return { html: options.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join(""), value: match ? match.deviceId : "default" };
  }
  function monitorHtml(display, chosen) {
    const name = t("meetings.monitor", { n: display.monitor });
    const about = [display.label, `${display.width}×${display.height}`, display.primary && t("meetings.start.primary")].filter(Boolean).join(" · ");
    return `<label class="mr-monitor">
      <span class="mr-thumb" data-thumb="${esc(display.id)}"><span class="spinner"></span></span>
      <span class="mr-pick"><input type="checkbox" class="check" value="${esc(display.id)}" ${chosen ? "checked" : ""}><b>${esc(name)}</b></span>
      <small>${esc(about)}</small></label>`;
  }

  const PICTURE = /^data:image\/(png|jpeg);base64,[\w+/=]+$/;
  function windowHtml(shown, chosen) {
    const picture = PICTURE.test(shown.thumbnail || "") ? `<img src="${shown.thumbnail}" alt="">` : `<span>${esc(t("meetings.start.noPicture"))}</span>`;
    return `<label class="mr-monitor mr-window">
      <span class="mr-thumb">${picture}</span>
      <span class="mr-pick"><input type="checkbox" class="check" value="${esc(shown.id)}" ${chosen ? "checked" : ""}><b>${esc(shown.title)}</b></span></label>`;
  }

  function open(project) {
    const saved = readChoice();
    const d = dialog("modal meeting-start", `<form method="dialog" class="modal-form">
      <h2 id="meetingStartTitle">${icon("record")}<span>${esc(t("meetings.start.title"))}</span></h2>
      <p class="mr-sub">${esc(t("meetings.start.project", { name: project.name }))}</p>
      <label><span>${esc(t("meetings.start.name"))}</span><input class="input" data-part="title" maxlength="200" autocomplete="off" autofocus placeholder="${esc(t("meetings.untitled"))}"></label>
      <label><span>${esc(t("meetings.start.microphone"))}</span><select class="select" data-part="mic" disabled><option>${esc(t("meetings.loading"))}</option></select></label>
      <fieldset class="mr-monitors"><legend>${esc(t("meetings.start.monitors"))}</legend>
        <div class="mr-grid" data-part="monitors"><p class="modal-note">${esc(t("meetings.loading"))}</p></div></fieldset>
      <fieldset class="mr-monitors"><legend>${esc(t("meetings.start.windows"))}<button type="button" class="mr-link" data-part="refresh">${esc(t("meetings.start.refresh"))}</button></legend>
        <div class="mr-grid" data-part="windows"><p class="modal-note">${esc(t("meetings.loading"))}</p></div>
        <p class="modal-note">${esc(t("meetings.start.windowsHint"))}</p></fieldset>
      <p class="modal-note mr-key"><span>${esc(t("meetings.start.shortcut"))}</span><span data-part="key">${accelerator(live.shortcut)}</span><button type="button" class="mr-link" data-part="change">${esc(t("meetings.start.change"))}</button></p>
      <p class="mr-notice warn" data-part="own">${icon("alert")}<span>${esc(t("meetings.start.ownAudio"))}</span></p>
      <p class="modal-hint err" data-part="error" role="alert"></p>
      <div class="modal-actions">
        <button type="button" class="btn" data-part="cancel">${esc(t("common.cancel"))}</button>
        <button type="submit" class="btn primary" data-part="go" disabled>${icon("record")}${esc(t("meetings.start.go"))}</button>
      </div></form>`);
    const part = name => d.querySelector(`[data-part="${name}"]`);
    const tickedIn = name => [...part(name).querySelectorAll("input:checked")].map(box => box.value);
    const ticked = () => tickedIn("monitors"), tickedWindows = () => tickedIn("windows");
    let displays = null, busy = false, listing = 0;

    function renderGo() {
      part("go").disabled = busy || !displays || !(ticked().length + tickedWindows().length);
      const full = tickedWindows().length >= WINDOWS_MAX;
      for (const box of part("windows").querySelectorAll("input")) box.disabled = full && !box.checked;
    }
    // The windows that are open now; one that was ticked stays ticked while it is still there.
    function showWindows(list) {
      const chosen = tickedWindows();
      part("windows").innerHTML = list.map(shown => windowHtml(shown, chosen.includes(shown.id))).join("")
        || `<p class="modal-note">${esc(t("meetings.start.noWindows"))}</p>`;
      renderGo();
    }
    // Asked for again whenever this window is come back to: the call's window may have been opened meanwhile. Only
    // the windows: the microphones and the monitors are as they were listed.
    async function refreshWindows() {
      const mine = ++listing;
      const windows = await call("windows");
      if (d.open && mine === listing) showWindows(windows || []);
    }
    function fail(error) {
      if (d.open) part("error").textContent = error.message;
      else toast(error.message, true);
    }
    function showDevices(devices) {
      displays = devices.displays;
      const { html, value } = microphoneOptions(devices.microphones, saved.microphone);
      const mic = part("mic");
      mic.innerHTML = html;
      mic.value = value;
      mic.disabled = false;
      const ids = displays.map(display => display.id), kept = saved.monitors.filter(id => ids.includes(id));
      const chosen = kept.length || saved.windowsOnly ? kept : [(displays.find(display => display.primary) || displays[0])?.id];
      part("monitors").innerHTML = displays.map(display => monitorHtml(display, chosen.includes(display.id))).join("")
        || `<p class="modal-note">${esc(t("meetings.start.noMonitors"))}</p>`;
      showWindows(devices.windows || []);
    }
    // The pixels can take seconds and may not come at all: the choice does not wait for them.
    function showThumbnails(list) {
      for (const slot of d.querySelectorAll("[data-thumb]")) {
        const picture = list.find(display => display.id === slot.dataset.thumb)?.thumbnail;
        slot.innerHTML = PICTURE.test(picture || "") ? `<img src="${picture}" alt="">`
          : `<span>${esc(t("meetings.start.noPicture"))}</span>`;
      }
    }
    async function load() {
      showDevices(await call("devices", { thumbnails: false }));
      if (!d.open) return;
      const mine = ++listing;
      try {
        const pictured = await call("devices", { thumbnails: true });
        showThumbnails(pictured.displays);
        if (d.open && mine === listing) showWindows(pictured.windows || []);
      } catch {
        showThumbnails([]);
      }
    }

    async function submit() {
      const mic = part("mic"), monitors = ticked(), windows = tickedWindows();
      busy = true;
      renderGo();
      part("error").textContent = "";
      try {
        await call("start", project.path, { title: part("title").value.trim(), microphone: mic.value, monitors, windows });
        saveChoice({ microphone: { deviceId: mic.value, label: mic.selectedOptions[0].textContent }, monitors, windowsOnly: !monitors.length });
        d.close();
      } catch (error) {
        fail(error);
        if (error.code === "meetingsWindowMissing") refreshWindows().catch(() => {});
      } finally {
        busy = false;
        renderGo();
      }
    }

    d.addEventListener("change", renderGo);
    part("cancel").addEventListener("click", () => d.close());
    part("change").addEventListener("click", () => meetingsShared.openSettings("meetings").catch(fail));
    part("refresh").addEventListener("click", () => refreshWindows().catch(fail));
    d.querySelector("form").addEventListener("submit", e => {
      e.preventDefault();
      if (!part("go").disabled) submit();
    });
    // The key may have been changed in Settings meanwhile.
    const readKey = () => call("state").then(state => {
      live.shortcut = state.shortcut;
      setHtml(part("key"), accelerator(state.shortcut));
    }).catch(fail);
    const cameBack = () => {
      readKey();
      if (displays) refreshWindows().catch(fail);
    };
    window.addEventListener("focus", cameBack);
    d.addEventListener("close", () => window.removeEventListener("focus", cameBack));
    readKey();
    load().catch(fail);
  }

  return { open };
})();
