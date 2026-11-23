// The folders AgentDeck makes in a project for meetings - the meetings' own and the skills'. Each ignores itself with
// a .gitignore of its own, so no file of the project changes, and each is known as ours by a marker in that file or
// in the folder's key file (INDEX.md, SKILL.md). What carries no marker is never written over.
//   A folder is { root, dir, key }: root is the trusted folder it is under, key the key file's name.
const fs = require("node:fs");
const path = require("node:path");
const { runGit } = require("../host/git-run");
const atomic = require("../shared/atomic-file");
const { fail } = require("./errors");
const { checkPath, findRepo } = require("./location");

const MARKER = "agentdeck-meetings:managed";
const IGNORE = `# ${MARKER} - written by AgentDeck to keep this folder out of git\n*\n`;
const GIT_TIMEOUT_MS = 15 * 1000;
const GIT_OUTPUT_MAX = 8 * 1024 * 1024;

// Replaced as a whole, through no link - the temporary file is one that a repository could bring along as well.
async function writeFile(root, file, contents) {
  for (const target of [file, file + ".tmp"]) {
    const st = await checkPath(root, target);
    if (st && !st.isFile()) fail("meetingsForeignFiles", target);
  }
  await atomic.write(file, contents);
}
// A write only where something changes: every write wakes the watchers of git and of the agents.
async function writeChanged(root, file, text) {
  const st = await checkPath(root, file);
  if (!st?.isFile() || await atomic.readText(file) !== text) await writeFile(root, file, text);
}

// true: ours; false: not there, or empty. Anything else is somebody's and fails.
async function inspect({ root, dir, key }) {
  const st = await checkPath(root, dir);
  if (!st) return false;
  if (!st.isDirectory()) fail("meetingsForeignFiles", dir);
  let ours = false;
  for (const file of [".gitignore", key].map(name => path.join(dir, name))) {
    const entry = await checkPath(root, file);
    if (!entry) continue;
    if (!entry.isFile() || !(await atomic.readText(file))?.includes(MARKER)) fail("meetingsForeignFiles", file);
    ours = true;
  }
  if (!ours && (await fs.promises.readdir(dir)).length) fail("meetingsForeignFiles", dir);
  return ours;
}
// The .gitignore first, so nothing that follows it into the folder is ever seen by git.
const ignoreItself = ({ root, dir }) => writeChanged(root, path.join(dir, ".gitignore"), IGNORE);

// The folders by the repository each is in: [{ root, folders: [{ ...folder, rel }] }]; outside git, none.
async function byRepository(folders) {
  const repos = new Map();
  for (const folder of folders) {
    const repo = await findRepo(folder.dir);
    if (!repo) continue;
    if (!repos.has(repo.root)) repos.set(repo.root, { root: repo.root, folders: [] });
    repos.get(repo.root).folders.push({ ...folder, rel: path.relative(repo.root, folder.dir).split(path.sep).join("/") || "." });
  }
  return [...repos.values()];
}

function createGitCheck(run = runGit) {
  // ok: the exit codes besides 0 that are an answer.
  async function git(root, args, ok = []) {
    const { err, stdout, stderr } = await run("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_MAX, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (err && !ok.includes(err.code)) fail("meetingsGitFailed", stderr.trim() || err.message);
    return stdout;
  }
  // icase: the index can name the folder in another case than the one the disk answers to.
  const pathspecs = repo => repo.folders.map(f => `:(top,icase,literal)${f.rel}`);

  // Asked before anything is written.
  async function assertUntracked(folders) {
    for (const repo of await byRepository(folders)) {
      const tracked = await git(repo.root, ["ls-files", "-z", "--cached", "--", ...pathspecs(repo)]);
      if (tracked) fail("meetingsTracked", path.join(repo.root, tracked.split("\0")[0]));
    }
  }
  // Asked once they are written: files: names within the folder, those still to come included.
  async function assertIgnored(folders) {
    for (const repo of await byRepository(folders)) {
      const probes = repo.folders.flatMap(f => [".gitignore", f.key, ...(f.files || [])].map(name => `./${f.rel}/${name}`));
      const ignored = (await git(repo.root, ["check-ignore", "--", ...probes], [1])).split("\n").filter(Boolean);
      if (ignored.length !== probes.length) fail("meetingsNotIgnored", repo.root);
      const seen = await git(repo.root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs(repo)]);
      if (seen) fail("meetingsNotIgnored", path.join(repo.root, seen.split("\0")[0]));
    }
  }
  return { assertUntracked, assertIgnored };
}

module.exports = { MARKER, inspect, ignoreItself, writeFile, writeChanged, createGitCheck };
