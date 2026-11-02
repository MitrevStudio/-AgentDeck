const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("manager", {
  getData: opts => ipcRenderer.invoke("app:get-data", opts),
  addProject: () => ipcRenderer.invoke("project:add"),
  removeProject: p => ipcRenderer.invoke("project:remove", p),
  renameProject: (p, name) => ipcRenderer.invoke("project:rename", p, name),
  launchFolder: p => ipcRenderer.invoke("launch:folder", p),
  launchAgent: (agent, id, cwd) => ipcRenderer.invoke("launch:agent", agent, id, cwd),
  launchNew: (agent, cwd) => ipcRenderer.invoke("launch:new", agent, cwd),
  launchFresh: (cwd, handoff) => ipcRenderer.invoke("launch:fresh", cwd, handoff),
  openPath: p => ipcRenderer.invoke("open:path", p),
  copyText: text => ipcRenderer.invoke("clipboard:write", text),
  getLive: () => ipcRenderer.invoke("live:get"),
  getUsage: () => ipcRenderer.invoke("usage:get"),
  getShortcuts: () => ipcRenderer.invoke("app:shortcuts"),
  getDay: date => ipcRenderer.invoke("day:get", date),
  summarizeDay: (date, skip) => ipcRenderer.invoke("day:summary", date, skip),
  searchText: q => ipcRenderer.invoke("search:text", q),
  getLimits: () => ipcRenderer.invoke("limits:get"),
  onLimitsChanged: cb => ipcRenderer.on("limits:changed", (_e, l) => cb(l)),
  refreshUsage: () => ipcRenderer.invoke("usage:refresh"),
  onUsageChanged: cb => ipcRenderer.on("usage:changed", (_e, u) => cb(u)),
  getPreview: (agent, id) => ipcRenderer.invoke("session:preview", agent, id),
  getGit: () => ipcRenderer.invoke("git:get"),
  refreshGit: () => ipcRenderer.invoke("git:refresh"),
  onGitChanged: cb => ipcRenderer.on("git:changed", (_e, g) => cb(g)),
  focusTerminal: (agent, id) => ipcRenderer.invoke("terminal:focus", agent, id),
  // The voice question's answer window only.
  onAnswer: cb => ipcRenderer.on("answer:show", (_e, a) => cb(a)),
  answerAction: a => ipcRenderer.send("answer:action", a),
  deleteSession: (agent, id) => ipcRenderer.invoke("session:delete", agent, id),
  isDir: p => ipcRenderer.invoke("fs:is-dir", p),
  openVoiceHistory: () => ipcRenderer.invoke("voice:open-history"),
  openSettings: () => ipcRenderer.invoke("voice:open-settings"),
  onDataChanged: cb => ipcRenderer.on("data:changed", (_e, data) => cb(data)),
  // Edge menu only.
  onBarEvent: cb => ipcRenderer.on("bar:event", (_e, ev) => cb(ev)),
  barCommand: (cmd, arg) => ipcRenderer.send("bar:command", cmd, arg),
  // Voice commands (edge menu): the microphone button, and {enabled, state} or {select: folder} from main.
  voiceCommand: () => ipcRenderer.invoke("voice:command"),
  voiceCommandState: () => ipcRenderer.invoke("voice:command-state"),
  onVoiceCommand: cb => ipcRenderer.on("voice:command-state", (_e, s) => cb(s))
});
// AgentDeck's own terminal tabs (manager window; terminals.js in main).
contextBridge.exposeInMainWorld("terminals", {
  getTabs: () => ipcRenderer.invoke("terminals:list"),
  attach: id => ipcRenderer.invoke("terminal:attach", id),
  close: id => ipcRenderer.invoke("terminal:close", id),
  move: (agent, id) => ipcRenderer.invoke("terminal:move", agent, id),
  input: (id, data) => ipcRenderer.send("terminal:input", id, data),
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
  onData: cb => ipcRenderer.on("terminal:data", (_e, d) => cb(d)),
  onExit: cb => ipcRenderer.on("terminal:exit", (_e, d) => cb(d)),
  onChanged: cb => ipcRenderer.on("terminals:changed", (_e, list) => cb(list)),
  onActivate: cb => ipcRenderer.on("terminal:activate", (_e, id) => cb(id))
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
