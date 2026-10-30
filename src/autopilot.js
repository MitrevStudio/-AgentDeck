// Keeps big Claude Code sessions in AgentDeck's own tabs cheap: once a session's context passes the threshold
// (prefs autoCompact), right after a finished turn - while the prompt cache is still warm - it types
// `/remember:remember` and then `/compact` into the tab. Only after a turn the user has not started typing into, so the
// input box is empty; a session is not compacted again until its context fell below the threshold.
const fs = require("node:fs");

const POLL_MS = 5000;
const QUIET_AFTER_TURN_MS = 15000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const ENTER_DELAY_MS = 500;
const TAIL_BYTES = 512 * 1024;
const STEPS = ["/remember:remember", "/compact"];

// terminals: terminals.js; liveSessions(); findTranscript(id); getPrefs() -> {autoCompact, autoCompactTokens};
// t: i18n for the tab notes.
function createAutopilot({ terminals, liveSessions, findTranscript, getPrefs, t }) {
  const runs = new Map();       // tab id -> { step, sentAt }
  const disarmed = new Set();   // tab ids compacted, until their context is small again
  const contexts = new Map();   // transcript -> { mtime, tokens }
  let timer = null, polling = false;

  // What the session's next reply re-reads: its own last reply's prompt, cache and answer.
  function readContextTokens(file) {
    const stat = fs.statSync(file);
    const cached = contexts.get(file);
    if (cached && cached.mtime === stat.mtimeMs) {
      return cached.tokens;
    }
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(stat.size - start);
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    let tokens = 0;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"usage":{') || !line.includes('"type":"assistant"')) {
        continue;
      }
      let x;
      try {
        x = JSON.parse(line);
      } catch {
        continue;
      }
      const u = x.message?.usage;
      if (u && !x.isSidechain) {
        tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
      }
    }
    contexts.set(file, { mtime: stat.mtimeMs, tokens });
    return tokens;
  }
  function getContextTokens(sessionId) {
    const file = findTranscript(sessionId);
    try {
      return file ? readContextTokens(file) : 0;
    } catch {
      return 0;
    }
  }

  function sendCommand(tabId, command) {
    terminals.type(tabId, command);
    setTimeout(() => terminals.type(tabId, "\r"), ENTER_DELAY_MS);
  }
  function setStepNote(tabId, step) {
    terminals.setNote(tabId, step < STEPS.length ? t(step === 0 ? "autopilot.remembering" : "autopilot.compacting") : "");
  }
  function startRun(tabId) {
    runs.set(tabId, { step: 0, sentAt: Date.now() });
    setStepNote(tabId, 0);
    sendCommand(tabId, STEPS[0]);
  }
  function finishRun(tabId) {
    runs.delete(tabId);
    disarmed.add(tabId);
    setStepNote(tabId, STEPS.length);
  }
  // A step is done once the session went back to waiting for input after the command was typed.
  function advanceRun(tabId, run, l) {
    if (Date.now() - run.sentAt > STEP_TIMEOUT_MS) {
      finishRun(tabId);
      return;
    }
    if (l.status !== "idle" || l.statusAt <= run.sentAt) {
      return;
    }
    run.step++;
    run.sentAt = Date.now();
    if (run.step < STEPS.length) {
      setStepNote(tabId, run.step);
      sendCommand(tabId, STEPS[run.step]);
    } else {
      finishRun(tabId);
    }
  }
  function isReadyToStart(tab, l, tokens, threshold) {
    return l.status === "idle"
      && tokens >= threshold
      && !disarmed.has(tab.id)
      && Date.now() - l.statusAt >= QUIET_AFTER_TURN_MS
      && terminals.getLastInputAt(tab.id) < l.statusAt;
  }

  function updateTab(tab, l, threshold) {
    const run = runs.get(tab.id);
    if (run) {
      advanceRun(tab.id, run, l);
      return;
    }
    const tokens = getContextTokens(tab.sessionId);
    if (tokens < threshold) {
      disarmed.delete(tab.id);
    } else if (isReadyToStart(tab, l, tokens, threshold)) {
      startRun(tab.id);
    }
  }
  async function poll() {
    const p = getPrefs();
    if (polling || !p.autoCompact) {
      return;
    }
    const tabs = terminals.list().filter(tab => tab.agent === "Claude" && tab.sessionId && !tab.exited);
    if (!tabs.length) {
      return;
    }
    polling = true;
    try {
      const live = new Map((await liveSessions()).map(l => [`${l.agent}:${l.id}`, l]));
      for (const tab of tabs) {
        const l = live.get(`${tab.agent}:${tab.sessionId}`);
        if (l) {
          updateTab(tab, l, p.autoCompactTokens);
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (!timer) {
        timer = setInterval(() => poll().catch(e => console.error("Autopilot failed:", e.message)), POLL_MS);
      }
    },
    stop() {
      clearInterval(timer);
      timer = null;
    }
  };
}

module.exports = { createAutopilot };
