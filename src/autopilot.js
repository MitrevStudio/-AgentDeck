// Big Claude Code sessions in AgentDeck tabs: once the context passes the threshold, right after a finished turn
// (the cache still warm) and with nothing typed since, `/remember:remember` and then `/compact` are typed in. Not
// again until the context fell below the threshold.
const POLL_MS = 5000;
const QUIET_AFTER_TURN_MS = 15000;
// A command that does not get the session working within this time is taken as not available, and skipped.
const START_TIMEOUT_MS = 60000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const ENTER_DELAY_MS = 500;
const STEPS = ["/remember:remember", "/compact"];
const STEP_NOTES = ["autopilot.remembering", "autopilot.compacting"];

// terminals: terminals.js; liveSessions(): live.js; getContext(key) -> {tokens} from usage-scan.js;
// getPrefs() -> {autoCompact, autoCompactTokens}; t: i18n.
function createAutopilot({ terminals, liveSessions, getContext, getPrefs, t }) {
  const runs = new Map();     // tab id -> { step, sentAt, started, enterTimer }
  const disarmed = new Set(); // tab ids compacted, until their context is small again
  let timer = null, polling = false;

  // The command goes in first and Enter a moment later. Anything typed in between makes the line the user's: it is not
  // sent, and the run ends on the next poll.
  function sendStep(tabId, run) {
    run.sentAt = Date.now();
    run.started = false;
    terminals.setNote(tabId, t(STEP_NOTES[run.step]));
    terminals.type(tabId, STEPS[run.step]);
    run.enterTimer = setTimeout(() => {
      run.enterTimer = null;
      if (runs.get(tabId) === run && getPrefs().autoCompact && terminals.getLastInputAt(tabId) <= run.sentAt) {
        terminals.type(tabId, "\r");
      }
    }, ENTER_DELAY_MS);
  }
  function stopRun(tabId) {
    clearTimeout(runs.get(tabId)?.enterTimer);
    runs.delete(tabId);
    terminals.setNote(tabId, "");
  }
  function finishRun(tabId) {
    stopRun(tabId);
    disarmed.add(tabId);
  }
  function nextStep(tabId, run) {
    run.step++;
    if (run.step < STEPS.length) {
      sendStep(tabId, run);
    } else {
      finishRun(tabId);
    }
  }
  // A step is done once the session went back to waiting for input after the command had started it.
  function advanceRun(tabId, run, l) {
    const waited = Date.now() - run.sentAt;
    if (terminals.getLastInputAt(tabId) > run.sentAt || waited > STEP_TIMEOUT_MS) {
      finishRun(tabId);
      return;
    }
    run.started ||= l.status !== "idle" || l.statusAt > run.sentAt;
    if (run.started ? l.status === "idle" && l.statusAt > run.sentAt : waited > START_TIMEOUT_MS) {
      nextStep(tabId, run);
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
    const tokens = getContext(`${tab.agent}:${tab.sessionId}`)?.tokens || 0;
    if (tokens < threshold) {
      disarmed.delete(tab.id);
    } else if (isReadyToStart(tab, l, tokens, threshold)) {
      const started = { step: 0 };
      runs.set(tab.id, started);
      sendStep(tab.id, started);
    }
  }
  // Closed tabs leave nothing behind.
  function forgetClosedTabs(tabIds) {
    for (const id of [...runs.keys(), ...disarmed]) {
      if (!tabIds.has(id)) {
        stopRun(id);
        disarmed.delete(id);
      }
    }
  }
  async function poll() {
    const tabs = terminals.getTabs().filter(tab => tab.agent === "Claude" && tab.sessionId && !tab.exited);
    forgetClosedTabs(new Set(tabs.map(tab => tab.id)));
    const p = getPrefs();
    // Switched off: a run under way stops too (a command already sent finishes by itself), and nothing more is typed.
    if (!p.autoCompact) {
      [...runs.keys()].forEach(stopRun);
      return;
    }
    if (!tabs.length) {
      return;
    }
    const live = new Map((await liveSessions()).map(l => [`${l.agent}:${l.id}`, l]));
    for (const tab of tabs) {
      const l = live.get(`${tab.agent}:${tab.sessionId}`);
      if (l) {
        updateTab(tab, l, p.autoCompactTokens);
      }
    }
  }

  return {
    start() {
      timer ||= setInterval(async () => {
        if (polling) {
          return;
        }
        polling = true;
        try {
          await poll();
        } catch (e) {
          console.error("Autopilot failed:", e.message);
        } finally {
          polling = false;
        }
      }, POLL_MS);
    }
  };
}

module.exports = { createAutopilot };
