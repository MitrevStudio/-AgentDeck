// Bridge for the voice Settings page. Only these calls; main answers them for this window alone.
const { contextBridge, ipcRenderer } = require("electron");

// The page's height with its tallest tab shown, so switching tabs does not resize the window. Each hidden tab is shown
// alone for a moment to be measured; no frame is painted in between.
function getPageHeight() {
  const body = document.body.getBoundingClientRect().height;
  const shown = document.querySelector(".vs-pane.on");
  if (!shown) {
    return Math.ceil(body);
  }
  const shownHeight = shown.getBoundingClientRect().height;
  let tallest = shownHeight;
  shown.classList.remove("on");
  for (const pane of document.querySelectorAll(".vs-pane")) {
    if (pane === shown) {
      continue;
    }
    pane.classList.add("on");
    tallest = Math.max(tallest, pane.getBoundingClientRect().height);
    pane.classList.remove("on");
  }
  shown.classList.add("on");
  return Math.ceil(body - shownHeight + tallest);
}

contextBridge.exposeInMainWorld("voiceSettings", {
  get: () => ipcRenderer.invoke("voice:settings:get"),
  save: payload => ipcRenderer.invoke("voice:settings:save", payload),
  // true while a hotkey field has the focus: main lets go of the voice hotkeys so they reach the field.
  capture: on => ipcRenderer.invoke("voice:settings:capture", on === true),
  // The window takes the page's height (measured here when not given, by the tallest tab), as every tab's own script asks.
  fit: height => ipcRenderer.invoke("voice:settings:fit", Number(height ?? getPageHeight())),
  // General section: applied at once ({language}, {theme}, {edgeHandle} or {autoUpdate}); the edge menu's hotkey,
  // read-only.
  setPrefs: patch => ipcRenderer.invoke("prefs:set", patch),
  edgeHotkey: () => ipcRenderer.invoke("app:edge-hotkey"),
  // Start with Windows: autostart() reads {supported, enabled}, autostart(true|false) switches it at once.
  autostart: on => ipcRenderer.invoke("app:autostart", typeof on === "boolean" ? on : null),
  // Updates: the state now and on every change; check, download and install act at once.
  updates: {
    get: () => ipcRenderer.invoke("updates:get"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    onChanged: cb => ipcRenderer.on("updates:changed", (_e, state) => cb(state))
  },
  // Voice commands: get() -> {commands, agents, hotkey}; set(patch) applies at once -> {ok, commands} or {ok: false, error}.
  commands: {
    get: () => ipcRenderer.invoke("voice:commands:get"),
    set: patch => ipcRenderer.invoke("voice:commands:set", patch)
  },
  // Network: the proxy settings (a password goes in, never out), saved on their own; test() uses what is entered.
  network: {
    get: () => ipcRenderer.invoke("network:get"),
    save: payload => ipcRenderer.invoke("network:save", payload),
    test: payload => ipcRenderer.invoke("network:test", payload)
  },
  // Computers (the mesh): this node, the paired ones and those found on the network; set() applies at once; pair()
  // and forget() answer {ok} or {ok: false, error}; the whole picture comes again on every change.
  mesh: {
    get: () => ipcRenderer.invoke("mesh:get"),
    set: patch => ipcRenderer.invoke("mesh:set", patch),
    newCode: () => ipcRenderer.invoke("mesh:new-code"),
    pair: (address, code) => ipcRenderer.invoke("mesh:pair", address, code),
    forget: id => ipcRenderer.invoke("mesh:forget", id),
    // Phones: invitePhone({ relay, address, nodes }) -> { ok, text, expires, included, skipped } or { ok: false, error };
    // forgetPhone(id) -> { still: [names of computers that may still know it], state }.
    invitePhone: args => ipcRenderer.invoke("mesh:invite-phone", args),
    forgetPhone: id => ipcRenderer.invoke("mesh:forget-phone", id),
    // A node's readiness (git, SSH key, agents) and its fixes: generateKey | addKnownHost {host} | setGitIdentity {name, email}.
    setup: id => ipcRenderer.invoke("mesh:setup", id),
    setupAction: (id, action, args) => ipcRenderer.invoke("mesh:setup-action", id, action, args),
    onChanged: cb => ipcRenderer.on("mesh:changed", (_e, state) => cb(state))
  }
});
// UI language and theme, read before the page renders; i18n.js applies them.
contextBridge.exposeInMainWorld("prefs", {
  ...ipcRenderer.sendSync("prefs:get"),
  onChanged: cb => ipcRenderer.on("prefs:changed", (_e, p) => cb(p))
});
