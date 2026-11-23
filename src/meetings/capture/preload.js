// Bridge for the meetings' hidden pages only (hidden-page.js).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingsPage", {
  onCommand: cb => ipcRenderer.on("meetings:command", (_e, msg) => cb(msg)),
  reply: (id, ok, value) => ipcRenderer.send("meetings:reply", id, ok, value),
  send: (type, payload) => ipcRenderer.send("meetings:event", type, payload),
  request: (type, args) => ipcRenderer.invoke("meetings:request", type, args)
});
