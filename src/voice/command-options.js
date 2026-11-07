// The voice-command settings (`commands` in the voice settings): on or off, and whether holding the edge menu's
// hotkey speaks one (the menu's microphone always does). What a command does is the command centre's business
// (orchestrator.js). normalize() repairs whatever settings.json holds; validate() checks what the Settings page sends.
const { isObj } = require("./util");

const TRIGGERS = Object.freeze(["hold", "off"]); // hold: the edge menu's hotkey held down; off: the menu's microphone only

const DEFAULTS = Object.freeze({
  commands: Object.freeze({ enabled: true, trigger: "hold" })
});

const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);

function normalizeCommands(c) {
  c = isObj(c) ? c : {};
  const d = DEFAULTS.commands;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
    trigger: oneOf(TRIGGERS, c.trigger, d.trigger)
  };
}

const normalize = v => ({ commands: normalizeCommands(isObj(v) ? v.commands : null) });

// A partial patch from the page, on top of `current` -> {value} or {error: field}.
function validate(patch, current) {
  if (!isObj(patch)) return { error: "form" };
  const next = { ...normalizeCommands(current) };
  for (const [k, v] of Object.entries(patch)) {
    const ok = k === "enabled" ? typeof v === "boolean" : k === "trigger" ? TRIGGERS.includes(v) : false;
    if (!ok) return { error: k };
    next[k] = v;
  }
  return { value: next };
}

module.exports = { TRIGGERS, DEFAULTS, normalize, normalizeCommands, validate };
