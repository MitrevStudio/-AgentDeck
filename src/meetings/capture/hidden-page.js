// A hidden, sandboxed page of the meetings (capture.html, codec.html): commands with an answer in, events and
// requests out. Its IPC is the page's own (webContents.ipc), so nothing global is left when it is closed.
const path = require("node:path");

const PRELOAD = path.join(__dirname, "preload.js");
const CALL_TIMEOUT_MS = 15_000;

// configure(session, webContents): the session's permissions. on: { <event>(payload) }, handle: { <request>(args) };
// onGone(): the page died.
function openPage({ html, partition, configure, on = {}, handle = {}, onGone, preload = PRELOAD }) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow({
    show: false, width: 200, height: 100, skipTaskbar: true, focusable: false, title: "Meetings",
    webPreferences: { preload, partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false }
  });
  const contents = win.webContents;
  configure(contents.session, contents);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", e => e.preventDefault());

  const calls = new Map();
  let nextCall = 1, closed = false;

  function close(error = new Error("the page was closed")) {
    if (closed) return;
    closed = true;
    for (const call of calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    calls.clear();
    if (!win.isDestroyed()) win.destroy();
  }
  function died(reason) {
    if (closed) return;
    close(new Error(`the page died: ${reason}`));
    onGone?.();
  }
  contents.on("render-process-gone", (_e, details) => died(details.reason));
  win.on("closed", () => died("closed"));

  contents.ipc.on("meetings:reply", (_e, id, ok, value) => {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    clearTimeout(call.timer);
    if (ok) call.resolve(value);
    else call.reject(Object.assign(new Error(value?.message || "the page failed"), { name: value?.name || "Error" }));
  });
  contents.ipc.on("meetings:event", (_e, type, payload) => {
    if (!closed && Object.hasOwn(on, type)) on[type](payload);
  });
  contents.ipc.handle("meetings:request", (_e, type, args) => {
    if (closed || !Object.hasOwn(handle, type)) throw new Error(`unknown request: ${type}`);
    return handle[type](args);
  });

  const ready = win.loadFile(path.join(__dirname, html));
  ready.catch(error => close(error));

  // timeoutMs 0: as long as it takes.
  async function call(cmd, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    await ready;
    if (closed) throw new Error("the page was closed");
    const id = nextCall++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        calls.delete(id);
        reject(new Error(`${cmd}: no answer`));
      }, timeoutMs) : null;
      calls.set(id, { resolve, reject, timer });
      contents.send("meetings:command", { id, cmd, args });
    });
  }
  return { call, close };
}

module.exports = { openPage };
