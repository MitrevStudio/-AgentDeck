// Errors the host answers with: a code, never a translated text. The host runs without the pages' language (and,
// as a headless host, without i18n.js at all); whoever shows the error - main.js for the windows, a peer for its
// own - translates `errors.<code>`. The message is a plain English fallback for logs.
const MESSAGES = {
  folderMissing: "The folder does not exist.",
  unknownAgent: "Unknown agent.",
  invalidSession: "Invalid session.",
  invalidData: "Invalid data.",
  sessionFolderUnknown: "The session's folder is unknown.",
  conversationMissing: "The session's conversation is no longer saved.",
  sessionRunning: "The session is open in a terminal.",
  sessionNoFile: "The session's file was not found.",
  moveNotRunning: "The session is no longer running.",
  moveBusy: "The agent is still working in this session.",
  moveStopFailed: "The session could not be closed in its terminal.",
  moveNoConversation: "The session has no conversation saved yet.",
  moveHostsAgentDeck: "AgentDeck itself runs inside this session.",
  stopUnsupported: "Only Claude sessions can be stopped from here.",
  stopFailed: "The session could not be stopped.",
  // Typing into a session (send-text.js); the command centre shows these texts as they are.
  agentNotReady: "The agent is not ready; nothing was sent.",
  agentStopped: "The agent stopped before the message could be submitted.",
  terminalTooOld: "Reopen this agent terminal before sending automatically; it was started by an older version."
};

class HostError extends Error {
  constructor(code, message = MESSAGES[code] || code) {
    super(message);
    this.code = code;
  }
}
const fail = code => { throw new HostError(code); };

module.exports = { HostError, fail, MESSAGES };
