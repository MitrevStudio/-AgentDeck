// What a running session is doing, as it counts for the user. Claude Code writes "idle" when the main turn ends,
// also when a subagent it started still works in the background: such a session is not done, so it counts as "busy"
// until its last subagent stops (a subagent that crashed stops writing, and host/live.js ends its `working` by
// itself). Only "idle" is overridden - "waiting" still needs the user, whatever its subagents do.
//
// Everything that asks "does this session work?" asks here: the lists and marks (common.js), the notifier (notify.js),
// the command centre, the phone (mobile/src/data.js). `l.status` itself stays what the agent reported, for those who
// ask whether the prompt is free (send-text.js, autopilot.js's steps).
// A page loads this file as a script, before common.js; Node and the phone's bundle take it as a module.
const hasWorkingSubagent = l => Array.isArray(l?.subagents) && l.subagents.some(a => a?.working);
function liveStatus(l) {
  return l?.status === "idle" && hasWorkingSubagent(l) ? "busy" : l?.status;
}

if (typeof module === "object" && module.exports) {
  module.exports = { liveStatus, hasWorkingSubagent };
}
