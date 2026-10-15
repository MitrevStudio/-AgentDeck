// Bridge for the edge handle only: pointer events out, the menu's state in.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("edgeHandle", {
  send: (type, x) => ipcRenderer.send("handle:event", type, x),
  onState: cb => ipcRenderer.on("handle:state", (_e, s) => cb(s))
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
