// How the dictation key behaves. "toggle": a press starts a recording, the next press ends it. "hold" (push-to-talk):
// the recording lasts while the key is held. "hybrid": the first press decides - let go within HOLD_MS and it was a
// tap (toggle), held longer and letting go ends the recording.
//
// RegisterHotKey reports presses only, so the release is found by polling the key state. Anything other than "still
// held" counts as let go - a failed read, or a key-up that never arrived because the focus moved to a secure desktop
// - so a missed release cannot keep a recording running. A further press always ends the recording, too.
const HOLD_MS = 300;
const POLL_MS = 25;

// isHeld() -> whether the hotkey's key and modifiers are all still down; onRelease({heldMs}) ends the recording.
// now and timers are injectable for tests.
function createTalkKey({ isHeld, onRelease, holdMs = HOLD_MS, pollMs = POLL_MS, now = Date.now, timers = globalThis }) {
  let watch = null; // {since, mode, timer} while a press is being watched for its release

  function stopWatching() {
    if (!watch) return;
    timers.clearInterval(watch.timer);
    watch = null;
  }

  function released(w) {
    if (watch !== w) return;
    const heldMs = now() - w.since;
    stopWatching();
    if (w.mode === "hold" || heldMs >= holdMs) onRelease({ heldMs });
  }

  function tick(w) {
    let held = false;
    try { held = Boolean(isHeld()); } catch {}
    if (!held) released(w);
  }

  // A press of the dictation key, which starts a recording (recording false) or ends it. mode: hybrid | toggle | hold.
  function press({ recording, mode }) {
    stopWatching();
    if (recording || (mode !== "hold" && mode !== "hybrid")) return;
    const w = watch = { since: now(), mode, timer: null };
    w.timer = timers.setInterval(() => tick(w), pollMs);
  }

  return {
    press,
    // The recording ended some other way (Esc, the limit, the tray): nothing left to watch.
    cancel: stopWatching,
    // Treat the key as let go now (the session was locked, say).
    release: () => { if (watch) released(watch); },
    get watching() { return Boolean(watch); }
  };
}

// The edge menu's hotkey. Main opens (or closes) the menu at once, inside the shortcut's callback - instant, and the
// moment Windows lets the menu take the keyboard focus - and then hands the press over here with `armed`: whether
// holding it may speak a voice command (voice commands on, held to speak, and this press opened the menu). Still down
// holdMs later, it becomes one while the menu stays open: onHold() then, onRelease() when the key is let go. The
// global shortcut repeats while the key is down, so a press while one is being watched is the same press: the
// controller checks `watching` before it toggles the menu, and press() ignores it (returns false).
function createEdgeHold({ isHeld, onHold, onRelease, holdMs = HOLD_MS, pollMs = POLL_MS, now = Date.now, timers = globalThis }) {
  let watch = null; // {since, armed, holding, timer}

  function stop() {
    if (!watch) return null;
    const w = watch;
    timers.clearInterval(w.timer);
    watch = null;
    return w;
  }

  function tick(w) {
    if (watch !== w) return;
    let down = false;
    try { down = Boolean(isHeld()); } catch {}
    if (!down) {
      stop();
      if (w.holding) onRelease();
      return;
    }
    if (w.armed && !w.holding && now() - w.since >= holdMs) {
      w.holding = true;
      onHold();
    }
  }

  return {
    press(armed) {
      if (watch) return false; // the key repeating while it is held
      const w = watch = { since: now(), armed: Boolean(armed), holding: false, timer: null };
      w.timer = timers.setInterval(() => tick(w), pollMs);
      return true;
    },
    // Treat the key as let go now (the session was locked): a hold ends, an undecided press is dropped.
    release() { const w = stop(); if (w?.holding) onRelease(); },
    get watching() { return Boolean(watch); },
    get holding() { return Boolean(watch?.holding); }
  };
}

module.exports = { createTalkKey, createEdgeHold, HOLD_MS, POLL_MS };
