// Small diagnostic logs under userData/logs, rotated to <name>.1 past 200 KB. They describe what happened, never user
// content (no selected text, no transcripts).
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 200 * 1024;

function createLog(name) {
  let file = null, chain = Promise.resolve();
  async function append(line) {
    file ??= path.join(require("electron").app.getPath("userData"), "logs", name);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const size = await fs.promises.stat(file).then(s => s.size, () => 0);
    if (size > MAX_BYTES) await fs.promises.rename(file, `${file}.1`);
    await fs.promises.appendFile(file, line + "\n");
  }
  return line => { chain = chain.then(() => append(line)).catch(e => console.error(`Writing ${name} failed:`, e.message)); };
}

module.exports = { createLog };
