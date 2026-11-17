// What is being written to a session and was not sent yet: kept per session - the chat view's reply box and the
// terminal's message field share it - across a lost link, leaving the screen and a restart of the app, until it is
// sent. { "node:agent:id": text } in localStorage (a shell's terminal: "node:term:id"); only on this phone.
const DRAFTS_KEY = "agentdeck.drafts";

function drafts() { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}") || {}; } catch { return {}; } }
export function getDraft(key) { return drafts()[key] || ""; }
export function setDraft(key, text) {
  const all = drafts();
  if (text) all[key] = text; else delete all[key];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(all)); } catch {}
}
