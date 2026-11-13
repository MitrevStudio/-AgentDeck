// Links an AgentDeck tab to the session started in it: the running Claude Code process whose parent chain reaches the
// tab's DockPty. One process snapshot answers all tabs; a session already checked against the same tabs is not
// looked at again, so sessions in other terminals cost nothing on later polls.
const { execFile } = require("node:child_process");

const POLL_MS = 3000;
const MAX_DEPTH = 6;
const SNAPSHOT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

function getParentMap() {
  const [file, args] = process.platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT]]
    : ["ps", ["-e", "-o", "pid=,ppid="]];
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : new Map(String(stdout).trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))));
    });
  });
}
function findTabPid(pid, parents, tabPids) {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH && current; depth++) {
    if (tabPids.has(current)) {
      return current;
    }
    current = parents.get(current);
  }
  return 0;
}

// A tab linked already is looked at again once its session is no longer live while the tab runs: Claude Code's /clear
// (and the like) starts a new session id in the same process, and the tab takes it over (link with replace), so the
// session shows in its terminal and a restart resumes the newest conversation (docs/SHARED-SESSIONS.md 4.8). Only a
// session of the tab's own agent replaces its session, and only Claude's does: Codex tabs are linked by their log
// (codex-live.js), OpenCode tabs have their session from the launch (opencode-link.js), and neither names a process.
//
// terminals: terminals.js; liveSessions(): live.js.
function createTabLinks({ terminals, liveSessions, parentMap = getParentMap }) {
  // A session resumed again runs in a new process, which is checked anew: the key holds the pid.
  const checked = new Map(); // `${agent}:${id}:${pid}` -> the tab set it was checked against
  const checkKey = l => `${l.agent}:${l.id}:${l.pid}`;
  let timer = null, polling = false;

  async function linkTabs() {
    const running = terminals.getTabs().filter(tab => !tab.exited);
    if (!running.length) {
      return;
    }
    const live = await liveSessions();
    const liveKeys = new Set(live.map(l => `${l.agent}:${l.id}`));
    // Unlinked tabs, and linked ones whose session is gone while they run (stale).
    const tabs = running.filter(tab => !tab.sessionId || (tab.agent === "Claude" && !liveKeys.has(`${tab.agent}:${tab.sessionId}`)));
    if (!tabs.length) {
      return;
    }
    const tabSet = tabs.map(tab => `${tab.pid}:${tab.sessionId}`).sort().join(",");
    const linked = new Set(running.filter(tab => tab.sessionId).map(tab => `${tab.agent}:${tab.sessionId}`));
    // Processes that ended are forgotten.
    const alive = new Set(live.map(checkKey));
    for (const key of checked.keys()) {
      if (!alive.has(key)) {
        checked.delete(key);
      }
    }
    const candidates = live.filter(l => !linked.has(`${l.agent}:${l.id}`) && checked.get(checkKey(l)) !== tabSet);
    if (!candidates.length) {
      return;
    }
    const parents = await parentMap();
    if (!parents) {
      return;
    }
    const tabByPid = new Map(tabs.map(tab => [tab.pid, tab]));
    for (const l of candidates) {
      checked.set(checkKey(l), tabSet);
      const tabPid = findTabPid(l.pid, parents, tabByPid);
      const tab = tabPid && tabByPid.get(tabPid);
      if (!tab) {
        continue;
      }
      if (!tab.sessionId) {
        terminals.link(tab.id, l.agent, l.id);
      } else if (tab.agent === l.agent && l.agent === "Claude") {
        terminals.link(tab.id, l.agent, l.id, { replace: true });
      } else {
        continue;
      }
      tabByPid.delete(tabPid);
    }
  }

  return {
    linkTabs,
    start() {
      timer ||= setInterval(async () => {
        if (polling) {
          return;
        }
        polling = true;
        try {
          await linkTabs();
        } catch (e) {
          console.error("Linking tabs failed:", e.message);
        } finally {
          polling = false;
        }
      }, POLL_MS);
    }
  };
}

module.exports = { createTabLinks, findTabPid };
