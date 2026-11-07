// Write-then-rename, so a crash or a full disk mid-write leaves the previous file intact instead of a truncated one.
// Port of VoiceTray's AtomicFile, made asynchronous: operations on one path run one at a time and in order (a later
// write never lands under an earlier one, a delete never under a write still queued), and nothing blocks the main
// thread while antivirus or an indexer holds a freshly written file open.
const fs = require("node:fs");
const path = require("node:path");
const { sleep } = require("./util");

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const TRIES = 8;
const RETRY_MS = 50;
const tails = new Map(); // path -> the end of its chain of operations

// Runs fn once every operation queued before it on the same path has settled.
function serial(file, fn) {
  const run = (tails.get(file) || Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  tails.set(file, tail);
  tail.then(() => { if (tails.get(file) === tail) tails.delete(file); });
  return run;
}

// Retried while the file is briefly locked; any other error is thrown at once.
async function retry(fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= TRIES || !BUSY.has(e.code)) throw e;
      await sleep(RETRY_MS);
    }
  }
}

async function writeNow(file, contents) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  try {
    await retry(() => fs.promises.writeFile(temp, contents, "utf8"));
    await retry(() => fs.promises.rename(temp, file));
  } catch (e) {
    await fs.promises.unlink(temp).catch(() => {});
    throw e;
  }
}

// The file's text, or null when it does not exist.
const readText = file => retry(() => fs.promises.readFile(file, "utf8")).catch(e => { if (e.code === "ENOENT") return null; throw e; });

const write = (file, contents) => serial(file, () => writeNow(file, contents));
// Read-modify-write in one step of the chain: change(text|null) returns the new contents.
const update = (file, change) => serial(file, async () => writeNow(file, await change(await readText(file))));
const remove = file => serial(file, () => retry(() => fs.promises.unlink(file)).catch(e => { if (e.code !== "ENOENT") throw e; }));
// Settles once everything queued so far has (shutdown).
const flush = () => Promise.all([...tails.values()]);

module.exports = { write, update, remove, flush, readText };
