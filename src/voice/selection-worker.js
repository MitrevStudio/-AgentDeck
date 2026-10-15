// The selection capture's own thread (see selection.js): {id, hwnd} in, {id, result} out, one at a time.
const { parentPort } = require("node:worker_threads");
const { captureHere } = require("./selection");

parentPort.on("message", async ({ id, hwnd }) => {
  let result;
  try { result = await captureHere(hwnd); } catch (e) {
    result = { text: "", failure: "CopyFailed", message: e?.message || String(e), clipboardRestored: true };
  }
  parentPort.postMessage({ id, result });
});
