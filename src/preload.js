const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("manager", {
  getData: opts => ipcRenderer.invoke("app:get-data", opts),
  addProject: () => ipcRenderer.invoke("project:add"),
  removeProject: p => ipcRenderer.invoke("project:remove", p),
  renameProject: (p, name) => ipcRenderer.invoke("project:rename", p, name),
  launchFolder: p => ipcRenderer.invoke("launch:folder", p),
  launchAgent: (agent, id, cwd) => ipcRenderer.invoke("launch:agent", agent, id, cwd),
  launchNew: (agent, cwd) => ipcRenderer.invoke("launch:new", agent, cwd),
  openPath: p => ipcRenderer.invoke("open:path", p),
  copyText: text => ipcRenderer.invoke("clipboard:write", text),
  getLive: () => ipcRenderer.invoke("live:get"),
  getUsage: () => ipcRenderer.invoke("usage:get"),
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
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
