// Typing a message into an agent running in a terminal of the host's own and submitting it, as the user would: the
// text first, Enter a moment later (as autopilot.js types), and only while the agent waits for input - idle, or
// waiting on the user. The command centre's send_to_session (orchestrator.js) and a peer's terminals.send
// (mesh/serve.js) both go through here.
//
// A tab knows its session by `sessionId`: given when a session is resumed, linked by tab-links.js (Claude) or
// codex-live.js (Codex) once a new one runs. OpenCode reports no live status, so its tabs are never "ready" here.
const { HostError } = require("./errors");

const ENTER_DELAY_MS = 400;
const TEXT_MAX = 20000;

// terminals: terminals.js; liveSessions(): live.js and codex-live.js.
function createSendText({ terminals, liveSessions }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // The running tab a session is in, or null.
  const tabOfSession = id => terminals.getTabs().find(x => x.sessionId === id && !x.exited) || null;
  // Whether the agent in the tab reads its input now. A Windows tab started by a version that did not mark agent
  // terminals (agentOnly) could fall back to a shell that would run the text: refused.
  async function isReady(tabId) {
    const tab = terminals.getTabs().find(x => x.id === tabId);
    if (!tab || tab.exited) return false;
    if (process.platform === "win32" && !tab.agentOnly) throw new HostError("terminalTooOld");
    if (!tab.sessionId) return false;
    const l = (await liveSessions()).find(x => x.id === tab.sessionId);
    return Boolean(l && ["idle", "waiting"].includes(l.status));
  }
  // One line (line breaks become spaces: an Enter inside would submit half of it), at most TEXT_MAX characters.
  const toLine = text => (typeof text === "string" ? text.trim().slice(0, TEXT_MAX) : "").replace(/\s*\n\s*/g, " ");
  async function typeLine(tabId, text) {
    const line = toLine(text);
    if (!line) throw new HostError("invalidData");
    if (!await isReady(tabId)) throw new HostError("agentNotReady");
    terminals.type(tabId, line);
    await sleep(ENTER_DELAY_MS);
    if (!await isReady(tabId)) throw new HostError("agentStopped");
    terminals.type(tabId, "\r");
  }
  return { tabOfSession, isReady, toLine, typeLine };
}

module.exports = { createSendText, TEXT_MAX };
