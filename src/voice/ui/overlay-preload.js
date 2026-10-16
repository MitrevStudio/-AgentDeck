// Bridge for the floating voice panel only: state and audio in, button actions, pointer and player events out.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceOverlay", {
  onState: cb => ipcRenderer.on("voice:overlay-state", (_e, msg) => cb(msg)),
  onUpdate: cb => ipcRenderer.on("voice:overlay-update", (_e, msg) => cb(msg)),
  onAudio: cb => ipcRenderer.on("voice:overlay-audio", (_e, msg) => cb(msg)),
  action: (type, arg) => ipcRenderer.send("voice:overlay-action", type, arg),
  size: (seq, height) => ipcRenderer.send("voice:overlay-size", seq, height),
  pill: box => ipcRenderer.send("voice:overlay-pill", box),
  onHover: cb => ipcRenderer.on("voice:overlay-hover", (_e, on) => cb(on)),
  player: msg => ipcRenderer.send("voice:overlay-player", msg)
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
