// The folder a paired computer names to be a project here (mesh/serve.js "projects.add"): typed there by hand, since
// nothing of this computer's folders is shown to it. It may start with ~ (the home here), must then be a whole path -
// one that is not would be read against wherever this process happens to run - and must be a folder that exists.
// Throws a HostError the other side translates: invalidData, folderNotAbsolute, folderMissing, notFolder.
const fs = require("node:fs");
const path = require("node:path");
const { HostError } = require("./errors");

const MAX_PATH = 4096;

// input: the path as typed; home: this computer's home folder. -> the folder, whole and tidied.
function resolveFolder(input, { home }) {
  if (typeof input !== "string" || input.length > MAX_PATH || input.includes("\0")) throw new HostError("invalidData");
  const typed = input.trim();
  if (!typed) throw new HostError("invalidData");
  const tilde = typed === "~" || typed.startsWith("~/") || typed.startsWith("~\\");
  if (tilde && !home) throw new HostError("folderMissing");
  const whole = tilde ? path.join(home, typed.slice(2)) : typed;
  if (!path.isAbsolute(whole)) throw new HostError("folderNotAbsolute");
  const dir = path.resolve(whole);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new HostError("folderMissing"); }
  if (!stat.isDirectory()) throw new HostError("notFolder");
  return dir;
}

module.exports = { resolveFolder, MAX_PATH };
