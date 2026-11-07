// Files put into a terminal: a picture pasted from the clipboard, or a file dropped on a pane, saved under the
// system temp folder so the program in the terminal (Claude Code, Codex) can read it by the path typed in. The
// same on a host for a peer whose terminal runs here: the bytes come over the link (serve.js files.put) and the
// path answered is the one here. Files older than a week go.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fail } = require("./errors");

const DIR = path.join(os.tmpdir(), "agentdeck-paste");
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_BYTES = 10 * 1024 * 1024; // base64 and the JSON around it stay under the link's 16 MB frame

// A file name as it may be used here: its base name, odd characters replaced, with the time in front.
function safeName(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/[^\w.() -]+/g, "_").slice(-80) || "file";
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${base}`;
}
async function sweep() {
  await fs.promises.mkdir(DIR, { recursive: true });
  for (const name of await fs.promises.readdir(DIR).catch(() => [])) {
    const file = path.join(DIR, name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > KEEP_MS) await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}
// -> the saved file's path.
async function savePaste(name, bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail("invalidData");
  if (bytes.length > MAX_BYTES) fail("tooBig", `A file of ${bytes.length} bytes; up to ${MAX_BYTES} are taken.`);
  await sweep();
  const file = path.join(DIR, safeName(name));
  await fs.promises.writeFile(file, bytes);
  return file;
}

module.exports = { savePaste, MAX_BYTES, DIR };
