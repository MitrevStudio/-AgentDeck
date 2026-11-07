const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("manager", {
  getData: opts => ipcRenderer.invoke("app:get-data", opts),
  addProject: () => ipcRenderer.invoke("project:add"),
  removeProject: (p, remember) => ipcRenderer.invoke("project:remove", p, remember),
  setProjectGroup: (p, id) => ipcRenderer.invoke("project:set-group", p, id),
  renameProject: (p, name) => ipcRenderer.invoke("project:rename", p, name),
  arrangeProjects: (paths, groupOf) => ipcRenderer.invoke("project:arrange", paths, groupOf),
  createGroup: p => ipcRenderer.invoke("group:create", p),
  renameGroup: (id, name) => ipcRenderer.invoke("group:rename", id, name),
  pinGroup: (id, slot) => ipcRenderer.invoke("group:pin", id, slot),
  deleteGroup: id => ipcRenderer.invoke("group:delete", id),
  sortProjectsByActivity: () => ipcRenderer.invoke("project:sort-by-activity"),
  pinProject: (p, slot) => ipcRenderer.invoke("project:pin", p, slot),
  // place (optional, AgentDeck's own terminals): "tab" (default), "right" or "down" of the focused pane.
  launchFolder: (p, place) => ipcRenderer.invoke("launch:folder", p, place),
  launchAgent: (agent, id, cwd, place) => ipcRenderer.invoke("launch:agent", agent, id, cwd, place),
  launchNew: (agent, cwd, place) => ipcRenderer.invoke("launch:new", agent, cwd, place),
  launchFresh: (cwd, handoff, place) => ipcRenderer.invoke("launch:fresh", cwd, handoff, place),
  openPath: p => ipcRenderer.invoke("open:path", p),
  copyText: text => ipcRenderer.invoke("clipboard:write", text),
  getLive: () => ipcRenderer.invoke("live:get"),
  getUsage: () => ipcRenderer.invoke("usage:get"),
  getShortcuts: () => ipcRenderer.invoke("app:shortcuts"),
  getDay: date => ipcRenderer.invoke("day:get", date),
  summarizeDay: (date, skip) => ipcRenderer.invoke("day:summary", date, skip),
  searchText: q => ipcRenderer.invoke("search:text", q),
  getResources: () => ipcRenderer.invoke("resources:get"),
  onResourcesChanged: cb => ipcRenderer.on("resources:changed", (_e, r) => cb(r)),
  getLimits: () => ipcRenderer.invoke("limits:get"),
  refreshLimits: () => ipcRenderer.invoke("limits:refresh"),
  onLimitsChanged: cb => ipcRenderer.on("limits:changed", (_e, l) => cb(l)),
  refreshUsage: () => ipcRenderer.invoke("usage:refresh"),
  onUsageChanged: cb => ipcRenderer.on("usage:changed", (_e, u) => cb(u)),
  getPreview: (agent, id) => ipcRenderer.invoke("session:preview", agent, id),
  getGit: () => ipcRenderer.invoke("git:get"),
  refreshGit: () => ipcRenderer.invoke("git:refresh"),
  onGitChanged: cb => ipcRenderer.on("git:changed", (_e, g) => cb(g)),
  focusTerminal: (agent, id) => ipcRenderer.invoke("terminal:focus", agent, id),
  // The command centre (orchestrator.js): its terminal, and a typed command for it.
  // The other computers (mesh): their projects, sessions and live status, pushed again on every change.
  getNodes: () => ipcRenderer.invoke("mesh:nodes"),
  // A terminal on another computer, in a pane here: {cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt}.
  remoteLaunch: (node, args) => ipcRenderer.invoke("mesh:launch", node, args),
  // The project's repository cloned on another computer, an agent started in it (clone-ui.js).
  remoteClone: (node, args) => ipcRenderer.invoke("mesh:clone", node, args),
  gitInfo: p => ipcRenderer.invoke("project:git-info", p),
  onNodesChanged: cb => ipcRenderer.on("mesh:nodes", (_e, nodes) => cb(nodes)),
  centreStart: () => ipcRenderer.invoke("centre:start"),
  centreSend: text => ipcRenderer.invoke("centre:send", text),
  // The voice question's answer window only.
  onAnswer: cb => ipcRenderer.on("answer:show", (_e, a) => cb(a)),
  answerAction: a => ipcRenderer.send("answer:action", a),
  deleteSession: (agent, id) => ipcRenderer.invoke("session:delete", agent, id),
  isDir: p => ipcRenderer.invoke("fs:is-dir", p),
  openVoiceHistory: () => ipcRenderer.invoke("voice:open-history"),
  openSettings: () => ipcRenderer.invoke("voice:open-settings"),
  onDataChanged: cb => ipcRenderer.on("data:changed", (_e, data) => cb(data)),
  onLaunch: cb => ipcRenderer.on("launch:started", (_e, key) => cb(key)),
  // Edge menu only.
  onBarEvent: cb => ipcRenderer.on("bar:event", (_e, ev) => cb(ev)),
  barCommand: (cmd, arg) => ipcRenderer.send("bar:command", cmd, arg),
  // Voice commands (edge menu): the microphone button, and {enabled, state} or {select: folder} from main.
  voiceCommand: () => ipcRenderer.invoke("voice:command"),
  voiceCommandState: () => ipcRenderer.invoke("voice:command-state"),
  onVoiceCommand: cb => ipcRenderer.on("voice:command-state", (_e, s) => cb(s))
});
// AgentDeck's own terminals and their layout (manager window; terminals.js and workspace.js in main).
contextBridge.exposeInMainWorld("terminals", {
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  setView: patch => ipcRenderer.invoke("prefs:set-view", patch),
  command: (cmd, args) => ipcRenderer.invoke("workspace:command", cmd, args),
  attach: id => ipcRenderer.invoke("terminal:attach", id),
  move: (agent, id) => ipcRenderer.invoke("terminal:move", agent, id),
  input: (id, data) => ipcRenderer.send("terminal:input", id, data),
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
  // A clipboard picture saved as a PNG (its path, "" when the clipboard holds text or no picture), and a dropped
  // file's path.
  saveClipboardImage: id => ipcRenderer.invoke("clipboard:image-file", id),
  getPathForFile: file => webUtils.getPathForFile(file),
  // A dropped file for a terminal on another computer: its bytes go there, its path there comes back.
  uploadFile: (id, name, bytes) => ipcRenderer.invoke("terminal:upload", id, name, new Uint8Array(bytes)),
  onData: cb => ipcRenderer.on("terminal:data", (_e, d) => cb(d)),
  onWorkspace: cb => ipcRenderer.on("workspace:changed", (_e, w) => cb(w))
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
