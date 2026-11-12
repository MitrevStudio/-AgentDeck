// The editors a file can be opened in from the Git screens, besides VS Code (which has a URI handler of its own).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Where IntelliJ IDEA is installed, per platform: the program's names on PATH, the folders that hold its installs
// (the installer's and JetBrains Toolbox's) and the program inside an install. Only the program itself: a launcher
// script for a shell (Toolbox's idea.cmd on Windows) is left out, since a file's name must never reach a shell.
function getIdeaPlaces(platform, env, home) {
  if (platform === "win32") {
    return {
      names: ["idea64.exe"],
      dirs: [path.join(env.ProgramFiles || "C:\Program Files", "JetBrains"), env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : ""],
      inside: [path.join("bin", "idea64.exe")]
    };
  }
  if (platform === "darwin") {
    return { names: ["idea"], dirs: ["/Applications", path.join(home, "Applications")], inside: [path.join("Contents", "MacOS", "idea")] };
  }
  return {
    names: ["idea", "idea.sh", "intellij-idea-ultimate", "intellij-idea-community"],
    dirs: ["/opt", path.join(home, ".local", "share", "JetBrains", "Toolbox", "apps")],
    inside: [path.join("bin", "idea"), path.join("bin", "idea.sh")]
  };
}
const IDEA_INSTALL = /^(IntelliJ IDEA|intellij-idea|idea)/i;

// An install's version: as its product-info.json states it, else the number in its folder's name ("IntelliJ IDEA
// 2025.1"; Toolbox's folders carry none), else "0".
function getIdeaVersion(install) {
  for (const file of [path.join(install.dir, "product-info.json"), path.join(install.dir, "Contents", "Resources", "product-info.json")]) {
    try {
      const version = JSON.parse(fs.readFileSync(file, "utf8")).version;
      if (typeof version === "string" && version) return version;
    } catch { /* not there, or not readable: the folder's name */ }
  }
  return /\d+(\.\d+)+/.exec(install.name)?.[0] || "0";
}

// IntelliJ IDEA's program: the one on PATH, else the newest install, whichever folder and edition it is; "" if there
// is none.
function findIdea({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const places = getIdeaPlaces(platform, env, home);
  const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  const onPath = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)
    .flatMap(dir => places.names.map(name => path.join(dir, name)))
    .find(isFile);
  if (onPath) return onPath;
  const installs = places.dirs.filter(Boolean).flatMap(dir => {
    try {
      return fs.readdirSync(dir).filter(name => IDEA_INSTALL.test(name)).map(name => ({ name, dir: path.join(dir, name) }))
        .map(install => ({ ...install, version: getIdeaVersion(install) }));
    } catch {
      return [];
    }
  });
  installs.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  for (const install of installs) {
    const program = places.inside.map(rel => path.join(install.dir, rel)).find(isFile);
    if (program) return program;
  }
  return "";
}

module.exports = { findIdea };
