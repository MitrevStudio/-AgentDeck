// The selection capture's own thread (see selection.js): {id, hwnd} or {id, op: "text", max} in, {id, result} out,
// one at a time.
const { parentPort } = require("node:worker_threads");
const { captureHere } = require("./selection");
const { readClipboardText } = require("./win32");

parentPort.on("message", async ({ id, hwnd, op, max }) => {
  let result;
  try { result = op === "text" ? { text: await readClipboardText(max) } : await captureHere(hwnd); } catch (e) {
    result = { text: "", failure: "CopyFailed", message: e?.message || String(e), clipboardRestored: true };
  }
  parentPort.postMessage({ id, result });
});
