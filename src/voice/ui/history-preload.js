// Bridge for the voice History page. Only these calls; main answers them for this window alone.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voiceHistory", {
  list: query => ipcRenderer.invoke("voice:history:list", String(query ?? "")),
  // which: "raw" copies the transcript as recognised (a rewritten dictation keeps both), anything else the result.
  copy: (id, which) => ipcRenderer.invoke("voice:history:copy", String(id), which === "raw" ? "raw" : "result"),
  redo: id => ipcRenderer.invoke("voice:history:redo", String(id)),
  remove: id => ipcRenderer.invoke("voice:history:delete", String(id)),
  clear: () => ipcRenderer.invoke("voice:history:clear"),
  onChanged: cb => ipcRenderer.on("voice:history:changed", () => cb())
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
