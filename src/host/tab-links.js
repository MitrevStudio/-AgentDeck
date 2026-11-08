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

// terminals: terminals.js; liveSessions(): live.js.
function createTabLinks({ terminals, liveSessions }) {
  // A session resumed again runs in a new process, which is checked anew: the key holds the pid.
  const checked = new Map(); // `${agent}:${id}:${pid}` -> the tab set it was checked against
  const checkKey = l => `${l.agent}:${l.id}:${l.pid}`;
  let timer = null, polling = false;

  async function linkTabs() {
    const tabs = terminals.getUnlinkedTabs();
    if (!tabs.length) {
      return;
    }
    const tabSet = tabs.map(tab => tab.pid).sort().join(",");
    const linked = new Set(terminals.getTabs().filter(tab => tab.sessionId).map(tab => `${tab.agent}:${tab.sessionId}`));
    const live = await liveSessions();
    // Processes that ended are forgotten.
    const running = new Set(live.map(checkKey));
    for (const key of checked.keys()) {
      if (!running.has(key)) {
        checked.delete(key);
      }
    }
    const candidates = live.filter(l => !linked.has(`${l.agent}:${l.id}`) && checked.get(checkKey(l)) !== tabSet);
    if (!candidates.length) {
      return;
    }
    const parents = await getParentMap();
    if (!parents) {
      return;
    }
    const tabByPid = new Map(tabs.map(tab => [tab.pid, tab.id]));
    for (const l of candidates) {
      checked.set(checkKey(l), tabSet);
      const tabPid = findTabPid(l.pid, parents, tabByPid);
      if (tabPid) {
        terminals.link(tabByPid.get(tabPid), l.agent, l.id);
        tabByPid.delete(tabPid);
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
