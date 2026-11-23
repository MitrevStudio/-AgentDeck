// Where a project's meetings are: <project>/.claude/meetings, and for a project in a linked worktree the same folder
// of the main checkout, so they do not go with the worktree. Read from the .git entries, without starting git: the
// count on the button asks whenever another project becomes active.
const fs = require("node:fs");
const path = require("node:path");
const { normPath } = require("../shared/util");
const { fail } = require("./errors");

const fsp = fs.promises;
const absent = e => { if (e.code === "ENOENT" || e.code === "ENOTDIR") return null; throw e; };
const lstat = file => fsp.lstat(file).catch(absent);

// A folder of this computer. Said before anything looks at it: a look at //server/share already goes to that server.
function local(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) fail("invalidData");
  if (/^[\\/]{2}/.test(value)) fail("meetingsNotLocal", value);
  return path.resolve(value);
}

// The last stat of `file`, null when it is not there. From `root` (trusted: a resolved folder) down to it nothing
// may be a link: what is written or removed there stays there.
async function checkPath(root, file) {
  const rel = path.relative(root, file);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) fail("invalidData");
  let at = root, st = await lstat(root);
  for (const part of rel.split(path.sep).filter(Boolean)) {
    if (!st) return null;
    if (!st.isDirectory()) fail("meetingsForeignFiles", at);
    at = path.join(at, part);
    st = await lstat(at);
    if (st?.isSymbolicLink()) fail("meetingsLinkedPath", at);
  }
  return st;
}

// The repository that holds a folder (which need not exist yet): { root, common }, common being "" unless the root
// is a linked worktree. null outside git.
async function findRepo(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, ".git"), st = await fsp.stat(dotGit).catch(absent);
    // As git does: a .git folder without a HEAD is no repository.
    if (st?.isDirectory() && await lstat(path.join(dotGit, "HEAD"))) return { root: at, common: "" };
    if (st?.isFile()) {
      const named = /^gitdir:\s*(.+?)\s*$/m.exec(await fsp.readFile(dotGit, "utf8"))?.[1];
      if (!named) fail("meetingsGitFailed", dotGit);
      const gitDir = local(path.resolve(at, named));
      if (!await lstat(gitDir)) fail("meetingsGitFailed", dotGit);
      const common = await fsp.readFile(path.join(gitDir, "commondir"), "utf8").catch(absent); // only a worktree has one
      return { root: at, common: common ? local(path.resolve(gitDir, common.trim())) : "" };
    }
    if (path.dirname(at) === at) return null;
  }
}

// The main checkout, by the folder its worktrees share; a bare repository has none.
async function findMainRoot(common) {
  if (path.basename(common).toLowerCase() !== ".git") fail("meetingsNoMainCheckout", common);
  for (const name of ["config", "config.worktree"]) {
    const config = await fsp.readFile(path.join(common, name), "utf8").catch(absent);
    if (/^\s*bare\s*=\s*true\s*$/im.test(config || "")) fail("meetingsNoMainCheckout", common);
  }
  const main = await fsp.realpath(path.dirname(common)).catch(absent);
  if (!main) fail("meetingsNoMainCheckout", common);
  return local(main);
}

// -> { project, base, dir, linked }: the project's folder as the file system names it, the folder that holds its
// meetings' .claude (the project, or its place in the main checkout), the meetings' folder.
async function resolveLocation(value, home) {
  const found = await fsp.realpath(local(value)).catch(absent);
  if (!found || !(await fsp.stat(found)).isDirectory()) fail("folderMissing");
  const project = local(found), repo = await findRepo(project);
  let base = project;
  const linked = Boolean(repo?.common);
  if (linked) {
    const main = await findMainRoot(repo.common);
    base = path.join(main, path.relative(repo.root, project));
    if (await checkPath(main, base)) base = await fsp.realpath(base);
  }
  const homeKey = normPath(await fsp.realpath(home).catch(() => home));
  if ([project, base].some(p => normPath(p) === homeKey)) fail("meetingsHomeFolder", base);
  return { project, base, dir: path.join(base, ".claude", "meetings"), linked };
}

module.exports = { resolveLocation, findRepo, checkPath, lstat };
