// A meeting's work outside its project: <userData>/meetings-work/<key>/, so that nothing written every few seconds
// wakes the watchers of git and of the agents. The recorder's raw PCM and the pipeline's
//   job.json                        what was chosen last, for a resume
//   uploads.json                    parts still uploaded at the provider
//   runs/<run>/plan.json            the parts
//   runs/<run>/parts/<part>.json    each answer exactly as it came: what is there is never paid for again
//   runs/<run>/merged.json          the merged transcript, echoes included
//   summary/<request>.json          the summary model's answers
// share that folder.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const atomic = require("../shared/atomic-file");
const { normPath } = require("../shared/util");

const digest = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

// meeting: the store's. The folder tells projects apart (a worktree and its main checkout have one), the exact start
// a meeting from a deleted one of the same minute and title.
const workKey = meeting => digest(`${normPath(meeting.dir)}\0${meeting.startedAt}`);

function createWork(root, meeting) {
  const dir = path.join(root, workKey(meeting)), file = name => path.join(dir, name);
  const readText = name => atomic.readText(file(name));
  return {
    dir,
    readText,
    async read(name) {
      const text = await readText(name);
      if (text === null) return null;
      try { return JSON.parse(text); } catch { return null; } // torn by a crash of the machine: made again
    },
    writeText: (name, text) => atomic.write(file(name), text),
    write: (name, value) => atomic.write(file(name), JSON.stringify(value)),
    // An answer that cannot be used: kept to look at, out of the way of a retry.
    async setAside(name) {
      const text = await readText(name);
      if (text === null) return;
      await atomic.write(file(`${name}.unusable-${Date.now()}`), text);
      await atomic.remove(file(name));
    },
    remove: () => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  };
}

module.exports = { digest, workKey, createWork };
