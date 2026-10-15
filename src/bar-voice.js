// The edge menu's part in voice commands (voice/command-runner.js): a microphone in the header that starts a command
// by click and finishes it with the next click (or a click on the voice panel), and the project a command asked to
// see. Loaded after bar.js, whose selectTile() and toast() it uses; main pushes {enabled, state, error?} and
// {select: folder} on "voice:command-state".
(() => {
  const btn = $("voiceCmd");
  let shown = { enabled: false, state: "idle" };

  function paint() {
    btn.hidden = !shown.enabled;
    btn.classList.toggle("rec", shown.state === "recording");
    btn.classList.toggle("busy", shown.state === "working");
    btn.title = t(shown.state === "recording" ? "voice.command.menu.finish" : shown.state === "working" ? "voice.command.menu.cancel" : "voice.command.menu.start");
    btn.setAttribute("aria-label", btn.title);
  }

  function apply(s) {
    if (!s) return;
    if (s.select) return selectTile("p:" + normPath(s.select));
    if (s.error) toast(s.error, true); // the hotkey held while a dictation records
    shown = { enabled: Boolean(s.enabled), state: s.state || "idle" };
    paint();
  }

  // Instant: the button changes at once, main confirms with a push.
  btn.addEventListener("click", async e => {
    e.stopPropagation();
    if (shown.state === "idle") { shown.state = "recording"; paint(); }
    try {
      const r = await window.manager.voiceCommand();
      if (r?.error) toast(r.error, true);
    } catch (err) { toast(err.message, true); }
    apply(await window.manager.voiceCommandState().catch(() => null));
  });

  window.manager.onVoiceCommand(apply);
  window.manager.voiceCommandState().then(apply).catch(() => {});
})();
