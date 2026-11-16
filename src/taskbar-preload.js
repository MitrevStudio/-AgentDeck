// Bridge for the taskbar monitor only: the measurements in, its width out.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("taskbarMonitor", {
  send: (type, value) => ipcRenderer.send("taskbar:event", type, value),
  onData: cb => ipcRenderer.on("taskbar:data", (_e, d) => cb(d))
});
