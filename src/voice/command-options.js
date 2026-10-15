// The voice-command settings (`commands` in the voice settings): on or off, whether holding the edge menu's hotkey
// speaks one, the agent and prompt mode of a new session, and how long the card waits before a command runs.
// normalize() repairs whatever settings.json holds; validate() checks what the Settings page sends.
const { isObj } = require("./util");
const { MODES } = require("./dictation-options");

const TRIGGERS = Object.freeze(["hold", "off"]); // hold: the edge menu's hotkey held down; off: the menu's microphone only
const AGENTS = Object.freeze(["Claude", "OpenCode", "Codex"]);
const MAX_COUNTDOWN = 10;

const DEFAULTS = Object.freeze({
  commands: Object.freeze({ enabled: true, trigger: "hold", agent: "Claude", promptMode: "prompt", countdown: 3 })
});

const oneOf = (list, v, fallback) => (list.includes(v) ? v : fallback);
const seconds = v => (Number.isInteger(v) && v >= 0 && v <= MAX_COUNTDOWN ? v : null);

function normalizeCommands(c) {
  c = isObj(c) ? c : {};
  const d = DEFAULTS.commands;
  return {
    enabled: typeof c.enabled === "boolean" ? c.enabled : d.enabled,
    trigger: oneOf(TRIGGERS, c.trigger, d.trigger),
    agent: oneOf(AGENTS, c.agent, d.agent),
    promptMode: oneOf(MODES, c.promptMode, d.promptMode),
    countdown: seconds(c.countdown) ?? d.countdown
  };
}

const normalize = v => ({ commands: normalizeCommands(isObj(v) ? v.commands : null) });

// A partial patch from the page, on top of `current` -> {value} or {error: field}.
function validate(patch, current) {
  if (!isObj(patch)) return { error: "form" };
  const next = { ...normalizeCommands(current) };
  for (const [k, v] of Object.entries(patch)) {
    const ok = k === "enabled" ? typeof v === "boolean"
      : k === "trigger" ? TRIGGERS.includes(v)
      : k === "agent" ? AGENTS.includes(v)
      : k === "promptMode" ? MODES.includes(v)
      : k === "countdown" ? seconds(v) !== null
      : false;
    if (!ok) return { error: k };
    next[k] = v;
  }
  return { value: next };
}

module.exports = { TRIGGERS, AGENTS, MAX_COUNTDOWN, DEFAULTS, normalize, normalizeCommands, validate };
