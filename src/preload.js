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
  restoreProjectOrder: () => ipcRenderer.invoke("project:restore-order"),
  sortProjectsByActivity: () => ipcRenderer.invoke("project:sort-by-activity"),
  pinProject: (p, slot) => ipcRenderer.invoke("project:pin", p, slot),
  // place (optional, AgentDeck's own terminals): "tab" (default), "right" or "down" of the focused pane.
  launchFolder: (p, place) => ipcRenderer.invoke("launch:folder", p, place),
  launchAgent: (agent, id, cwd, place) => ipcRenderer.invoke("launch:agent", agent, id, cwd, place),
  launchNew: (agent, cwd, place) => ipcRenderer.invoke("launch:new", agent, cwd, place),
  launchFresh: (cwd, handoff, place) => ipcRenderer.invoke("launch:fresh", cwd, handoff, place),
  openPath: p => ipcRenderer.invoke("open:path", p),
  copyText: text => ipcRenderer.invoke("clipboard:write", text),
  readClipboardText: () => ipcRenderer.invoke("clipboard:read"),
  getLive: () => ipcRenderer.invoke("live:get"),
  // { "Claude:<id>": { cpu, mem, memShare, procs } } of the Claude sessions running here, or null: switched off, or
  // this window is not in view (main.js "proc:get").
  getSessionLoad: () => ipcRenderer.invoke("proc:get"),
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
  getGitDiff: (node, root, file) => ipcRenderer.invoke("git:diff", node, root, file),
  gitQuery: (node, params) => ipcRenderer.invoke('git:query', node, params),
  gitExecute: (node, params) => ipcRenderer.invoke('git:execute', node, params),
  gitOpenFile: (node, root, file) => ipcRenderer.invoke('git:open-file', node, root, file),
  getGit: () => ipcRenderer.invoke("git:get"),
  refreshGit: (force = false, shown = [], why = "page") => ipcRenderer.invoke("git:refresh", force, shown, why),
  onGitChanged: cb => ipcRenderer.on("git:changed", (_e, g) => cb(g)),
  focusTerminal: (agent, id) => ipcRenderer.invoke("terminal:focus", agent, id),
  // The command centre (orchestrator.js): its terminal, and a typed command for it.
  // The other computers (mesh): their projects, sessions and live status, pushed again on every change.
  getNodes: () => ipcRenderer.invoke("mesh:nodes"),
  // A terminal on another computer, in a pane here: {cwd, kind: "shell" | "new" | "resume" | "prompt", agent, sessionId, prompt}.
  remoteLaunch: (node, args) => ipcRenderer.invoke("mesh:launch", node, args),
  // The project's repository cloned on another computer, an agent started in it (clone-ui.js).
  remoteClone: (node, args) => ipcRenderer.invoke("mesh:clone", node, args),
  // A computer's own menu (renderer.js openDeviceMenu): a folder there listed as a project (the path typed, checked
  // there), and a terminal in its home folder - both work on a computer that lists nothing yet.
  remoteAddProject: (node, dir) => ipcRenderer.invoke("mesh:add-project", node, dir),
  remoteTerminal: node => ipcRenderer.invoke("mesh:terminal", node),
  gitInfo: p => ipcRenderer.invoke("project:git-info", p),
  onNodesChanged: cb => ipcRenderer.on("mesh:nodes", (_e, nodes) => cb(nodes)),
  centreStart: () => ipcRenderer.invoke("centre:start"),
  centreSend: text => ipcRenderer.invoke("centre:send", text),
  // The voice question's answer window only.
  onAnswer: cb => ipcRenderer.on("answer:show", (_e, a) => cb(a)),
  answerAction: a => ipcRenderer.send("answer:action", a),
  deleteSession: (agent, id) => ipcRenderer.invoke("session:delete", agent, id),
  stopSession: (node, agent, id) => ipcRenderer.invoke("session:stop", node || "", agent, id),
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
// AgentDeck's own terminals and their layout (manager window; terminals.js and workspace.js in main). A terminal
// belongs to the computer it runs on (docs/SHARED-SESSIONS.md 5.3): the window attaches those it has a pane of, a
// closed pane or tab only hides it, and stop() ends it for every device.
contextBridge.exposeInMainWorld("terminals", {
  getWorkspace: () => ipcRenderer.invoke("workspace:get"),
  setView: patch => ipcRenderer.invoke("prefs:set-view", patch),
  // Also "open-term" { term, place }: a terminal with no pane here in a new one.
  command: (cmd, args) => ipcRenderer.invoke("workspace:command", cmd, args),
  // -> { scrollback, end, exitCode, cols, rows, mine, by }: mine - this window sets the size; by - the name of the
  // device that does ("" for nobody: the pane fits itself).
  attach: id => ipcRenderer.invoke("terminal:attach", id),
  move: (agent, id) => ipcRenderer.invoke("terminal:move", agent, id),
  input: (id, data) => ipcRenderer.send("terminal:input", id, data),
  // The pane's fit: the size it wants (the terminal takes it while this window sets its size, or nobody does).
  resize: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
  // "Use my size": the pane's last fit for the terminal, on every device.
  takeSize: id => ipcRenderer.invoke("terminal:take-size", id),
  // Stop: the terminal ends on its computer, for every device (main finds the computer).
  stop: id => ipcRenderer.invoke("terminal:stop", id),
  // The "Ports" menu of a pane (docs/PORT-FORWARDING.md 3; main.js listPorts). The window names a terminal and a port
  // number only: main finds the computer and builds every address.
  // -> { node, name, ports: [{ port, process, own }], forwards: [{ node, port, localPort }], saved: [port], error?:
  // "offline" | "update" | "failed", message? }: what listens on the terminal's computer (its own ports first), that
  // computer's forwards here, the ports typed by hand for its project. Asked when the menu opens, never on a timer.
  listPorts: id => ipcRenderer.invoke("ports:list", id),
  // Opens the port in the browser - forwarded first for a terminal of another computer; opts: { https, remember }
  // (remember: typed by hand, kept for the project). copyPort puts the same address on the clipboard. Both -> the address.
  openPort: (id, port, opts) => ipcRenderer.invoke("ports:open", id, port, opts),
  copyPort: (id, port) => ipcRenderer.invoke("ports:copy", id, port),
  closePort: (id, port) => ipcRenderer.invoke("ports:close", id, port),
  forgetPort: (id, port) => ipcRenderer.invoke("ports:forget", id, port),
  // Every forward of this window's computer, [{ node, port, localPort }], and again when one starts or stops.
  getForwards: () => ipcRenderer.invoke("ports:forwards"),
  onForwards: cb => ipcRenderer.on("ports:changed", (_e, list) => cb(list)),
  // A clipboard picture saved as a PNG (its path, "" when the clipboard holds text or no picture), and a dropped
  // file's path.
  saveClipboardImage: id => ipcRenderer.invoke("clipboard:image-file", id),
  getPathForFile: file => webUtils.getPathForFile(file),
  // A dropped file for a terminal on another computer: its bytes go there, its path there comes back.
  uploadFile: (id, name, bytes) => ipcRenderer.invoke("terminal:upload", id, name, new Uint8Array(bytes)),
  onData: cb => ipcRenderer.on("terminal:data", (_e, d) => cb(d)),
  // A terminal whose size another viewer (a phone) set and gave back: its pane sends its own size again. Only from a
  // computer whose host does not share its terminals yet (no terminals: 2).
  onRefit: cb => ipcRenderer.on("terminal:refit", (_e, id) => cb(id)),
  // { id, cols, rows, mine, by }: the size of a terminal with a pane here, or who sets it, changed.
  onSize: cb => ipcRenderer.on("terminal:size", (_e, s) => cb(s)),
  // { id, title }: a terminal with a pane here ended, or was stopped from another device (its pane goes).
  onEnded: cb => ipcRenderer.on("terminal:ended", (_e, e) => cb(e)),
  onWorkspace: cb => ipcRenderer.on("workspace:changed", (_e, w) => cb(w))
});
// The "Files" dialog of a remote terminal's pane (docs/FILES.md 6; main.js "files:*", file-transfers.js). A side is a
// computer: "" this one, else a node id. Each answers { value } or { error: code, message } - but the queue's.
contextBridge.exposeInMainWorld("files", {
  // -> { left, right }: { node, name, start: the folder it opens in, trash, error?: "offline" | "update" }
  open: term => ipcRenderer.invoke("files:open", term),
  // list { path, after? } -> { path, parent, sep, home, entries: [{ name, dir, link, size, mtime }], next }; stat,
  // mkdir { path, keep? }, rename { from, to }, delete { path } -> { trashed } (host/files.js).
  call: (node, method, params) => ipcRenderer.invoke("files:call", node, method, params),
  // A file or a folder into a folder of the other side: from { node, path }, to { node, folder }.
  send: (from, to) => ipcRenderer.invoke("files:send", from, to),
  copy: (node, from, to, move) => ipcRenderer.invoke("files:copy", node, from, to, move),
  // -> { kind: "image", data } | { kind: "text" | "markdown", text } | { kind: "pdf" } (opened) | { kind: "binary" } |
  // { kind: "tooBig", max }
  preview: (node, file) => ipcRenderer.invoke("files:preview", node, file),
  // The queue: [{ id, kind: "transfer" | "copy", move, name, state: "queued" | "running" | "done" | "failed" |
  // "stopped", error, message, from: { node, name }, to: { node, name }, path, bytes, total, files, count, skipped,
  // current }], and again whenever it changes.
  transfers: () => ipcRenderer.invoke("files:transfers"),
  stop: id => ipcRenderer.invoke("files:stop", id),
  clear: () => ipcRenderer.invoke("files:clear"),
  onTransfers: cb => ipcRenderer.on("files:transfers", (_e, list) => cb(list)),
  // A file of this computer sent to a phone linked now (it is offered; the phone asks and pulls it): a row of the
  // queue (kind "offer", states "waiting" | "noAnswer" | "running" | "done" | "declined" | "failed" | "expired" |
  // "stopped"). phones() -> [{ id, name, online }], and again as they come and go.
  offer: (node, file) => ipcRenderer.invoke("files:offer", node, file),
  phones: () => ipcRenderer.invoke("files:phones"),
  onPhones: cb => ipcRenderer.on("files:phones", (_e, list) => cb(list))
});
// Meetings (meetings/ipc.js): the manager window's, refused to every other. A project by its folder, a meeting by its
// id. Each answers { ok: true, value } or { ok: false, code, message }.
contextBridge.exposeInMainWorld("meetings", {
  state: () => ipcRenderer.invoke("meetings:state"),
  count: project => ipcRenderer.invoke("meetings:count", project),
  list: project => ipcRenderer.invoke("meetings:list", project),
  sizes: project => ipcRenderer.invoke("meetings:sizes", project),
  devices: opts => ipcRenderer.invoke("meetings:devices", opts),
  windows: () => ipcRenderer.invoke("meetings:windows"),
  start: (project, opts) => ipcRenderer.invoke("meetings:start", project, opts),
  stop: () => ipcRenderer.invoke("meetings:stop"),
  discard: () => ipcRenderer.invoke("meetings:discard"),
  screenshot: () => ipcRenderer.invoke("meetings:screenshot"),
  recover: () => ipcRenderer.invoke("meetings:recover"),
  discardRecoverable: key => ipcRenderer.invoke("meetings:discard-recoverable", key),
  // -> { place, meeting, size, summary, transcript, raw, media: the address of its sound and screenshots }
  open: (project, id) => ipcRenderer.invoke("meetings:open", project, id),
  options: () => ipcRenderer.invoke("meetings:options"),
  estimate: (project, id, choices) => ipcRenderer.invoke("meetings:estimate", project, id, choices),
  transcribe: (project, id, choices) => ipcRenderer.invoke("meetings:transcribe", project, id, choices),
  retry: (project, id) => ipcRenderer.invoke("meetings:retry", project, id),
  summarize: (project, id, choices) => ipcRenderer.invoke("meetings:summarize", project, id, choices),
  cancel: (project, id) => ipcRenderer.invoke("meetings:cancel", project, id),
  compress: (project, id) => ipcRenderer.invoke("meetings:compress", project, id),
  rename: (project, id, title) => ipcRenderer.invoke("meetings:rename", project, id, title),
  remove: (project, id) => ipcRenderer.invoke("meetings:remove", project, id),
  removeAudio: (project, id) => ipcRenderer.invoke("meetings:remove-audio", project, id),
  removeScreen: (project, id, file) => ipcRenderer.invoke("meetings:remove-screen", project, id, file),
  copyPath: (project, id) => ipcRenderer.invoke("meetings:copy-path", project, id),
  settings: pane => ipcRenderer.invoke("meetings:settings", pane),
  // status, levels, warning, screenshot, ended, job, compression, changed
  onEvent: cb => ipcRenderer.on("meetings:event", (_e, name, data) => cb(name, data))
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
