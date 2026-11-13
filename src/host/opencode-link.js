// OpenCode 2 starts a new session under the id it is given - `--session <id>`: "Session ID to continue, or to create
// if it does not exist" - which ties a new session to its terminal from the launch on, with no guessing by folder or
// time. A release whose help does not say so only continues a session with it: there no id is given, and the terminal
// stays without a session (host/index.js liveAgents lists it all the same).
// An id is made as OpenCode makes its own (checked against 2.2.7): "ses_", the inverted time in 12 hex digits - so
// newer sessions sort first -, then 14 letters and digits.
const crypto = require("node:crypto");

const CREATES = /--session\b.*\bcreate\b/i;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastAt = 0, counter = 0;
function newSessionId(now = Date.now()) {
  if (now !== lastAt) { lastAt = now; counter = 0; }
  const time = ~(BigInt(now) * 0x1000n + BigInt(++counter));
  const hex = Array.from({ length: 6 }, (_, i) => Number((time >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")).join("");
  return `ses_${hex}${Array.from(crypto.randomBytes(14), b => ALPHABET[b % ALPHABET.length]).join("")}`;
}

// help(): the text of `opencode --help` (a promise). Asked once - check(), or the first launch -; until the answer is
// in, and when it cannot be had, no id is given.
function createOpenCodeLink({ help }) {
  let creates = null, asking = null;
  function check() {
    asking ||= Promise.resolve().then(help).then(text => { creates = CREATES.test(String(text ?? "")); }, () => { asking = null; });
    return asking;
  }
  // What a new session's command takes: { args, sessionId }, or no args when the CLI would not create the session.
  function launchIdentity() {
    if (creates === null) check();
    if (!creates) return { args: [] };
    const sessionId = newSessionId();
    return { args: ["--session", sessionId], sessionId };
  }
  return { check, launchIdentity };
}

module.exports = { createOpenCodeLink, newSessionId };
