// Starts git for a read - a status, a diff, a value of its config - and gives back what it printed.
//
// On Windows every console program started the usual way gets a console host of its own (conhost.exe), hidden or not:
// a second process a start, which security software inspects like the first. Started detached, git has no console at
// all and so no host for one; its output comes through the pipes as before.
// What git starts in turn shows no window either: Git for Windows starts its children without a console when it has
// none itself. A clean or smudge filter it runs through its shell (Git LFS, say) is the one case that costs more this
// way: that shell makes itself a hidden console (a helper process and a console host), where it would have shared
// git's. Filters run for a file whose timestamp changed, not on every status, so the usual start is one process
// instead of two.
// Elsewhere there is no console host, and git is started as a plain child.
const childProcess = require("node:child_process");

const STDERR_MAX = 64 * 1024;

// -> { err, stdout, stderr }: err is null when git ended with 0; else an Error with code - "ENOENT" (no such
// program), "ETIMEDOUT" (still running after `timeout` ms: killed), "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" (more than
// `maxBuffer` bytes of output: killed) or git's own exit code.
function runGit(exe, args, { timeout = 0, maxBuffer = 1024 * 1024, env = process.env } = {}) {
  return new Promise(resolve => {
    const out = [], errOut = [];
    let size = 0, errSize = 0, done = false, timer = null, child = null;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ err: err || null, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errOut).toString("utf8") });
    };
    // Killed, the answer is given at once: a filter git started may hold the pipes open long after git is gone.
    const abort = (code, message) => {
      const err = Object.assign(new Error(message), { code, killed: true });
      try { child.kill(); } catch { /* gone already */ }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(err);
    };
    try {
      // Through the module, not a reference taken at load: the tests count every start there.
      child = childProcess.spawn(exe, args, { env, windowsHide: true, detached: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return finish(err);
    }
    child.on("error", finish);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > maxBuffer) abort("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "git printed more than is read");
      else out.push(chunk);
    });
    child.stderr.on("data", chunk => {
      if (errSize < STDERR_MAX) errOut.push(chunk);
      errSize += chunk.length;
    });
    child.on("close", (code, signal) => finish(code === 0 ? null : Object.assign(new Error(`git ended with ${code ?? signal}`), { code })));
    if (timeout > 0) {
      timer = setTimeout(() => abort("ETIMEDOUT", `git did not answer in ${Math.round(timeout / 1000)} s`), timeout);
      timer.unref?.();
    }
  });
}

module.exports = { runGit };
