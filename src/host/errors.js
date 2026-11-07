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
  moveHostsAgentDeck: "AgentDeck itself runs inside this session."
};

class HostError extends Error {
  constructor(code, message = MESSAGES[code] || code) {
    super(message);
    this.code = code;
  }
}
const fail = code => { throw new HostError(code); };

module.exports = { HostError, fail, MESSAGES };
