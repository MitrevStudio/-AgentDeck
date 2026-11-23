const path = require("node:path");
const { Worker } = require("node:worker_threads");

// -> the PNG's bytes. bgra is copied, then the worker's.
function encodePng({ width, height, bgra }) {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bgra);
    const worker = new Worker(path.join(__dirname, "png-worker.js"), { workerData: { width, height, bgra: copy }, transferList: [copy.buffer] });
    worker.once("message", png => resolve(Buffer.from(png.buffer, png.byteOffset, png.byteLength)));
    worker.once("error", reject);
    worker.once("exit", code => reject(new Error(`the PNG worker ended (${code})`)));
  });
}

module.exports = { encodePng };
