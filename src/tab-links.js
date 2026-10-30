// Links an AgentDeck tab to the session started in it: the running Claude Code process whose parent chain reaches the
// tab's DockPty. One process snapshot answers all tabs; a session already checked against the same tabs is not
// looked at again, so sessions in other terminals cost nothing on later polls.
const { execFile } = require("node:child_process");

const POLL_MS = 3000;
const MAX_DEPTH = 6;
const SNAPSHOT = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

function getParentMap() {
  return new Promise(resolve => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SNAPSHOT], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : new Map(String(stdout).trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))));
    });
  });
}
function findTabPid(pid, parents, tabPids) {
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH && parents.has(current); depth++) {
    current = parents.get(current);
    if (tabPids.has(current)) {
      return current;
    }
  }
  return 0;
}

// terminals: terminals.js; liveSessions(): live.js.
function createTabLinks({ terminals, liveSessions }) {
  const checked = new Map(); // `${agent}:${id}` -> the tab set it was checked against
  let timer = null, polling = false;

  async function linkTabs() {
    const tabs = terminals.getUnlinkedTabs();
    if (!tabs.length) {
      return;
    }
    const tabSet = tabs.map(tab => tab.pid).sort().join(",");
    const linked = new Set(terminals.getTabs().filter(tab => tab.sessionId).map(tab => `${tab.agent}:${tab.sessionId}`));
    const candidates = (await liveSessions()).filter(l => !linked.has(`${l.agent}:${l.id}`) && checked.get(`${l.agent}:${l.id}`) !== tabSet);
    if (!candidates.length) {
      return;
    }
    const parents = await getParentMap();
    if (!parents) {
      return;
    }
    const tabByPid = new Map(tabs.map(tab => [tab.pid, tab.id]));
    for (const l of candidates) {
      checked.set(`${l.agent}:${l.id}`, tabSet);
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

module.exports = { createTabLinks };
