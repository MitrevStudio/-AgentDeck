// Errors the host answers with: a code, never a translated text. The host runs without the pages' language (and,
// as a headless host, without i18n.js at all); whoever shows the error - main.js for the windows, a peer for its
// own - translates `errors.<code>`. The message is a plain English fallback for logs.
const MESSAGES = {
  folderMissing: "The folder does not exist.",
  // A folder a paired computer names as a project here (project-folder.js).
  folderNotAbsolute: "Give the folder's whole path there (it may start with ~).",
  notFolder: "That path is a file, not a folder.",
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
  // Shared terminals (viewers.js, launch.js, mesh/serve.js; docs/SHARED-SESSIONS.md 4).
  tooManyViewers: "Too many devices have this terminal open.",
  tooManyTerminals: "Too many terminals run on this computer. Stop some first.",
  sessionRunningOutside: "The session runs outside AgentDeck there.",
  notViewing: "This device does not have the terminal open (yet). Try again in a moment.",
  // Forwarded ports (port-streams.js; docs/PORT-FORWARDING.md).
  refused: "Nothing listens on that port there.",
  tooManyStreams: "Too many connections are open through forwarded ports there.",
  // The files of this computer for a paired one (files.js; docs/FILES.md).
  fileMissing: "That file or folder is no longer there.",
  notFile: "That is a folder, not a file.",
  exists: "Something with that name is already there.",
  fileDenied: "That computer does not allow it (no permission, or the file is in use).",
  changed: "The file changed while it was being read.",
  crossDevice: "That is on another drive there.",
  rootRefused: "A whole drive, the home folder or a folder that holds it is not copied, moved, renamed or deleted.",
  networkPath: "A network share (\\\\server\\folder) is not opened from another computer. Use a folder on that computer's own drives.",
  intoItself: "A folder cannot go into itself.",
  tooManyJobs: "Too many copies or uploads run there. Wait for one to finish.",
  jobMissing: "That copy or upload is no longer known there.",
  diskFull: "The disk there is full.",
  sourceLeft: "It was copied, but the original could not be removed and was left where it was.",
  fileFailed: "The file system there refused it.",
  tooBig: "That is too big.",
  tooManyFiles: "The folder holds too many files and folders to send in one go. Send its folders one by one.",
  cancelled: "Stopped.",
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
