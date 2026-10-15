// Bridge for the hidden capture window only: commands in, audio and replies out, plus the prefs every page gets.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceRec", {
  onCommand: cb => ipcRenderer.on("voice:rec-cmd", (_e, msg) => cb(msg)),
  reply: (id, ok, result) => ipcRenderer.send("voice:rec-reply", id, ok, result),
  chunk: (session, pcm, peak) => ipcRenderer.send("voice:rec-chunk", session, pcm, peak),
  event: (session, type) => ipcRenderer.send("voice:rec-event", session, type)
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
