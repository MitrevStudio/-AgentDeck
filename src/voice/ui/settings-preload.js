// Bridge for the voice Settings page. Only these calls; main answers them for this window alone.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceSettings", {
  get: () => ipcRenderer.invoke("voice:settings:get"),
  save: payload => ipcRenderer.invoke("voice:settings:save", payload),
  // true while a hotkey field has the focus: main lets go of the voice hotkeys so they reach the field.
  capture: on => ipcRenderer.invoke("voice:settings:capture", on === true),
  fit: height => ipcRenderer.invoke("voice:settings:fit", Number(height)),
  // General section: applied at once ({language}, {theme} or {hoverEdge}); the edge menu's hotkey, read-only.
  setPrefs: patch => ipcRenderer.invoke("prefs:set", patch),
  edgeHotkey: () => ipcRenderer.invoke("app:edge-hotkey")
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
