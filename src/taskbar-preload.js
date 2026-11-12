// Bridge for the taskbar monitor only: the measurements in, its width out.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("taskbarMonitor", {
  send: (type, value) => ipcRenderer.send("taskbar:event", type, value),
  onData: cb => ipcRenderer.on("taskbar:data", (_e, d) => cb(d))
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
