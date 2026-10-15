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
  isDir: p => ipcRenderer.invoke("fs:is-dir", p),
  openVoiceHistory: () => ipcRenderer.invoke("voice:open-history"),
  openSettings: () => ipcRenderer.invoke("voice:open-settings"),
  onDataChanged: cb => ipcRenderer.on("data:changed", (_e, data) => cb(data)),
  // Edge menu only.
  onBarEvent: cb => ipcRenderer.on("bar:event", (_e, ev) => cb(ev)),
  barCommand: (cmd, arg) => ipcRenderer.send("bar:command", cmd, arg)
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
