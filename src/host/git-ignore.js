// Whether git ignores a path of a repository, answered in this process: git-status.js asks for every change its
// watchers report, and a process per change (`git check-ignore`) would cost more than the `git status` it saves.
// The rules are git's, read from where git reads them, lowest precedence first: the user's excludes file
// (core.excludesFile), <git dir>/info/exclude (a linked worktree's is its main checkout's), the .gitignore of the
// repository's folder and those of the folders below it down to the path's own, each matching relative to its folder.
// A folder that is ignored ends the question: nothing under it can be included again, and no .gitignore in it is read.
// The patterns are matched by the `ignore` package, one matcher per folder that has a .gitignore.
//
// It errs on the side of "not ignored", which only costs a `git status`: a file that cannot be read or parsed, a
// path it cannot make sense of, a deleted path that only a folder pattern ("bin/") would match. What it does not
// know: core.excludesFile set in the repository's own config, and files that are tracked although a pattern matches
// them - git reports changes of those, this says "ignored" (see git-status.js).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ignore = require("ignore");

const RELOAD_MS = 5 * 60 * 1000; // rules are read again after this: the files a watcher does not report on (the user's
                                 // excludes file, a worktree's info/exclude) and whatever a watcher missed
const MAX_TESTS = 50000;         // and after this many paths: the matchers remember every path they were asked about

// Where git looks for the user's excludes file when core.excludesFile is not set.
function getDefaultExcludesFile(env = process.env, home = os.homedir()) {
  return env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, "git", "ignore") : path.join(home, ".config", "git", "ignore");
}

// A rules file's text: "" when there is none, null when it is there and cannot be read.
async function readRules(file) {
  try {
    return (await fs.promises.readFile(file, "utf8")).replace(/^﻿/, "");
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? "" : null;
  }
}
// The folder with the repository's config and info/exclude: .git, or for a linked worktree (its .git is a file naming
// <main>/.git/worktrees/<name>, which names the common folder in "commondir") the main checkout's.
async function findGitDir(root) {
  const dotGit = path.join(root, ".git");
  let gitdir = "";
  try { gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, "utf8"))?.[1] || ""; } catch { /* a folder */ }
  if (!gitdir) return dotGit;
  const dir = path.resolve(root, gitdir);
  try { return path.resolve(dir, (await fs.promises.readFile(path.join(dir, "commondir"), "utf8")).trim()); } catch { return dir; }
}

// excludesFile(): the user's excludes file (a path, or a promise of one); asked at every reload.
function createGitIgnores({ excludesFile = getDefaultExcludesFile } = {}) {
  // root -> { at, tests, own, dirs, isDir }. own.get("base"): the matcher of the rules that apply from the root (the
  // user's, info/exclude, the root's .gitignore), null when one of them cannot be read; dirs: a folder below the root
  // ("a/b") -> the matcher of its .gitignore, null without one, false when it cannot be read; isDir: a path -> whether
  // it is a folder. A value still being read is the promise of it.
  const repos = new Map();

  async function loadBase(root) {
    const gitDir = await findGitDir(root);
    const [config, user, exclude, own] = await Promise.all([
      readRules(path.join(gitDir, "config")),
      Promise.resolve().then(excludesFile).then(file => (file ? readRules(file) : ""), () => ""),
      readRules(path.join(gitDir, "info", "exclude")),
      readRules(path.join(root, ".gitignore"))
    ]);
    if (user === null || exclude === null || own === null) return null;
    // core.ignorecase as `git init` wrote it for this file system; without it, what git assumes there.
    const set = /^\s*ignorecase\s*=\s*(\w+)/im.exec(config || "")?.[1].toLowerCase();
    const ignorecase = set ? ["true", "yes", "on", "1"].includes(set) : process.platform === "win32" || process.platform === "darwin";
    return { ignorecase, ig: ignore({ ignorecase }).add(user).add(exclude).add(own) };
  }
  async function loadDir(root, dir, ignorecase) {
    const text = await readRules(path.join(root, dir, ".gitignore"));
    if (text === null) return false;
    return text.trim() ? ignore({ ignorecase }).add(text) : null;
  }
  // map.get(key) once loaded (`failed` when the load threw); until then the promise of the load, which never rejects.
  function loaded(map, key, load, failed) {
    if (!map.has(key)) {
      const pending = load().catch(() => failed).then(value => { map.set(key, value); });
      map.set(key, pending);
    }
    return map.get(key);
  }

  // true or false when everything it takes is loaded, else a promise that settles when the next piece is.
  function decide(repo, root, parts, skipFolders) {
    const base = loaded(repo.own, "base", () => loadBase(root), null);
    if (base instanceof Promise) return base;
    if (!base) return false;
    // The matchers that apply, by rising precedence; from: how many of the path's parts lead to the matcher's folder.
    const chain = [{ ig: base.ig, from: 0 }];
    // What the rules say about the first `count` parts, taken as a folder or as a file: the closest matcher with a
    // rule for it decides. undefined: one included it again while one further up ignores it - `ignore` would go on
    // ignoring everything below on that one's behalf, so nothing more can be told.
    const test = (count, asDir) => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const r = chain[i].ig.test(parts.slice(chain[i].from, count).join("/") + (asDir ? "/" : ""));
        if (r.ignored) return true;
        if (r.unignored) return chain.slice(0, i).some(m => m.ig.ignores(parts.slice(m.from, count).join("/") + (asDir ? "/" : ""))) ? undefined : false;
      }
      return false;
    };
    for (let count = 1; count < parts.length; count++) {
      const ignored = test(count, true);
      if (ignored !== false) return ignored === true;
      const dir = parts.slice(0, count).join("/");
      const rules = loaded(repo.dirs, dir, () => loadDir(root, dir, base.ignorecase), false);
      if (rules instanceof Promise) return rules;
      if (rules === false) return false;
      if (rules) chain.push({ ig: rules, from: count });
    }
    const asFile = test(parts.length, false);
    if (asFile !== false) return asFile === true;
    if (!skipFolders && test(parts.length, true) !== true) return false;
    // Only as a folder ("bin/"), or any folder for a caller that skips them: a watcher does not say what the path is.
    const name = parts.join("/");
    return loaded(repo.isDir, name, async () => (await fs.promises.lstat(path.join(root, name))).isDirectory(), false);
  }

  // Whether git ignores `name` (relative to root, either slash). At once when the rules it takes are loaded, else a
  // promise of it - so a caller that must not wait can go on and still not lose the change.
  // renamed: the path was created, deleted or renamed, so what it was (a file, a folder) no longer holds.
  // skipFolders: a folder counts as ignored whatever the rules say - for a watcher's report that a folder itself
  // changed, which says nothing that the report on the file added to it does not.
  function isIgnored(root, name, { renamed = false, skipFolders = false } = {}) {
    const parts = String(name || "").replaceAll("\\", "/").split("/").filter(Boolean);
    if (!parts.length || parts.some(p => p === "." || p === "..")) return false;
    let repo = repos.get(root);
    if (!repo || Date.now() - repo.at > RELOAD_MS || repo.tests > MAX_TESTS) repos.set(root, repo = { at: Date.now(), tests: 0, own: new Map(), dirs: new Map(), isDir: new Map() });
    repo.tests++;
    if (renamed) repo.isDir.delete(parts.join("/"));
    const settle = left => {
      let result;
      try { result = decide(repo, root, parts, skipFolders); } catch { return false; }
      if (!(result instanceof Promise)) return result;
      return left > 0 ? result.then(() => settle(left - 1), () => false) : false;
    };
    return settle(parts.length + 4);
  }
  // The rules of `root` changed, or may have: they are read again when next asked for.
  function reload(root) { repos.delete(root); }

  return { isIgnored, reload, clear: () => repos.clear() };
}

module.exports = { createGitIgnores, getDefaultExcludesFile };
