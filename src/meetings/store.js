// The meetings of the local projects, kept in their folders (location.js) as files that git does not see and agents
// read (agent-skill.js):
//   .claude/meetings/.gitignore, INDEX.md
//   .claude/meetings/<id>/meeting.json, summary.md, transcript.md, screens/<h-m-s-mN>.png, audio/{mic,system}.webm
// A list is always what is in the folder now: entries deleted by hand are gone, others' entries are not meetings, one
// whose meeting.json cannot be used is listed as broken, so that it can still be deleted.
// Whatever changes meetings runs one operation after another, in the order it was asked for, so two updates of a
// meeting both stay and nothing written late brings a deleted meeting back. One queue for all projects: which folder
// a project's meetings are in takes a look at the disk to know, and the order must not wait for that.
// Every function rejects with a HostError (errors.js).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const atomic = require("../shared/atomic-file");
const { measure } = require("../host/scratchpads");
const { fail, fromFs } = require("./errors");
const { resolveLocation, checkPath, lstat } = require("./location");
const { inspect, ignoreItself, writeFile, writeChanged, createGitCheck } = require("./managed-folder");
const { skillFolders, writeSkills } = require("./agent-skill");
const { indexText } = require("./index-file");
const { checkPatch, newMeeting, parse, folderName, isId, isScreen, isFileName } = require("./meeting");

const fsp = fs.promises;
const READ_PARALLEL = 16; // meetings read at a time for a list
const INDEXED = ["title", "state", "brief", "durationMs", "transcription", "summary"];
// What is asked of git besides the files that are there: the kinds of file a meeting will have.
const FUTURE_FILES = ["probe/meeting.json", "probe/transcript.md", "probe/audio/mic.webm", "probe/screens/00-00-00-m1.png"];
const meetingsFolder = ({ base, dir }) => ({ root: base, dir, key: "INDEX.md", files: FUTURE_FILES });

const shown = (meeting, id, dir) => ({ ...meeting, id, dir, broken: false }); // as callers get one
async function readMeeting(base, dir) {
  const file = path.join(dir, "meeting.json"), st = await checkPath(base, file);
  return st?.isFile() ? parse(await atomic.readText(file)) : null;
}
async function meetingIds({ base, dir }) {
  if (!(await checkPath(base, dir))?.isDirectory()) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && isId(e.name)).map(e => e.name); // a link is not a folder here
}
async function readAll(location) {
  const ids = await meetingIds(location), found = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(READ_PARALLEL, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++], dir = path.join(location.dir, id);
      let meeting = null;
      try {
        meeting = await readMeeting(location.base, dir);
        if (!meeting && !await lstat(dir)) continue; // deleted meanwhile
      } catch { /* unreadable, or a link: broken like any other */ }
      found.push(meeting ? shown(meeting, id, dir) : { id, dir, broken: true });
    }
  }));
  // By the local minute in the folder's name, which a broken one has too; within a minute by the exact start.
  const order = m => `${m.id.slice(0, 15)} ${m.startedAt || ""} ${m.id}`;
  return found.sort((a, b) => (order(a) < order(b) ? 1 : -1));
}
async function writeIndex(location) {
  await writeChanged(location.base, path.join(location.dir, "INDEX.md"), indexText(await readAll(location)));
}
// A delete takes the folder and what is in it, so nothing in it may lead out.
async function assertNoLinks(dir) {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail("meetingsLinkedPath", file);
    if (entry.isDirectory()) await assertNoLinks(file);
  }
}

// trash(path): moves a file or a folder to the Recycle Bin (shell.trashItem); runGit, home: for tests;
// log: hears of an INDEX.md that could not be rebuilt after a change that itself was saved.
function createMeetingStore({ trash, runGit, home = os.homedir(), log = e => console.error("The meetings' index could not be written:", e.message) } = {}) {
  const git = createGitCheck(runGit);
  let tail = Promise.resolve(); // the end of the chain of changes

  const at = project => resolveLocation(project, home);
  // Takes its place at once: whoever calls it must not have waited for anything since its own caller called.
  function serial(project, fn) {
    const run = tail.then(async () => fn(await at(project)));
    tail = run.then(() => {}, () => {});
    return run;
  }
  // Called within the caller's own call, so that the order of the calls is the order in the queue.
  const api = fn => (...args) => new Promise(done => done(fn(...args))).catch(fromFs);

  async function meetingDir(location, id) {
    if (!isId(id)) fail("invalidData", "id");
    const dir = path.join(location.dir, id);
    if (!(await checkPath(location.base, dir))?.isDirectory()) fail("meetingsNotFound", dir);
    return dir;
  }
  // Runs fn(location, dir) as the next change of these meetings, in a folder that is ours and still ignores itself.
  function change(project, id, fn) {
    return serial(project, async location => {
      const dir = await meetingDir(location, id);
      const folder = meetingsFolder(location);
      await inspect(folder);
      await ignoreItself(folder);
      return fn(location, dir);
    });
  }
  // meeting.json is the truth: a change that is saved does not fail for the index, which the next one builds again.
  const refreshIndex = location => writeIndex(location).catch(log);

  async function setUp(location) {
    const folders = [meetingsFolder(location), ...skillFolders(location)];
    // All that can refuse is asked before the first write.
    for (const folder of folders) await inspect(folder);
    await git.assertUntracked(folders);
    for (const folder of folders) await ignoreItself(folder);
    await writeSkills(location);
    await writeIndex(location);
    await git.assertIgnored(folders);
    return location;
  }

  async function saveChanges(location, dir, id, changes) {
    const current = await readMeeting(location.base, dir);
    if (!current) fail("meetingsBroken", dir);
    const raw = typeof changes === "function" ? await changes(structuredClone(current)) : changes;
    if (raw === null) return shown(current, id, dir);
    const patch = checkPatch(raw);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(location.base, path.join(dir, "meeting.json"), JSON.stringify(next, null, 2) + "\n");
    if (INDEXED.some(key => key in patch)) await refreshIndex(location);
    return shown(next, id, dir);
  }
  async function moveToTrash(target) {
    try { await trash(target); } catch (e) { fail("meetingsTrashFailed", e.message); }
  }

  // -> { project, base, dir, linked }, see location.js. Starts no process and writes nothing.
  const resolve = api(at);
  // Before a recording: the folders, the skills, the index - and git's word that none of it can be committed.
  const prepare = api(project => serial(project, setUp));

  // fields: { title, startedAt (ms, ISO or Date; now), and any of meeting.js FIELDS }. Prepares again: a recording
  // is hours long and the folder may have changed under it.
  const create = api((project, fields = {}) => {
    const meeting = newMeeting(fields);
    return serial(project, async location => {
      await setUp(location);
      let id, dir;
      for (let n = 1; !dir; n++) {
        id = folderName(meeting, n);
        if (!isId(id)) fail("invalidData", id);
        try {
          await fsp.mkdir(path.join(location.dir, id)); // not recursive: this is what settles a collision
          dir = path.join(location.dir, id);
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      try {
        await writeFile(location.base, path.join(dir, "meeting.json"), JSON.stringify(meeting, null, 2) + "\n");
      } catch (e) {
        await fsp.rmdir(dir).catch(() => {}); // only as empty as it was made
        throw e;
      }
      await refreshIndex(location);
      return shown(meeting, id, dir);
    });
  });

  const read = api(async (project, id) => {
    const location = await at(project), dir = await meetingDir(location, id);
    const meeting = await readMeeting(location.base, dir);
    if (!meeting) fail("meetingsBroken", dir);
    return shown(meeting, id, dir);
  });
  const list = api(async project => readAll(await at(project)));
  const count = api(async project => (await meetingIds(await at(project))).length);

  // changes: the fields to replace, or a function of the meeting as it is now that returns them (null: none) - the
  // only safe way to add to a list. That function must not wait for this store: it runs inside the queue.
  const update = api((project, id, changes) => change(project, id, (location, dir) => saveChanges(location, dir, id, changes)));
  const rename = api((project, id, title) => update(project, id, { title }));

  // name: "summary.md", "transcript.md", "audio/mic.webm", "audio/system.webm" or a screen's. Text or bytes.
  const write = api((project, id, name, contents) => {
    if (!isFileName(name) || !(typeof contents === "string" || ArrayBuffer.isView(contents))) fail("invalidData", name);
    return change(project, id, async (location, dir) => {
      const file = path.join(dir, name);
      await writeFile(location.base, file, contents);
      return file;
    });
  });
  // The path of such a file that is there: to read, play or show it.
  const filePath = api(async (project, id, name) => {
    if (!isFileName(name)) fail("invalidData", name);
    const location = await at(project), file = path.join(await meetingDir(location, id), name);
    if (!(await checkPath(location.base, file))?.isFile()) fail("meetingsNotFound", file);
    return file;
  });

  const size = api(async (project, id) => {
    const dir = await meetingDir(await at(project), id);
    const part = async name => ((await lstat(path.join(dir, name)))?.isDirectory() ? (await measure(path.join(dir, name))).bytes : 0);
    const [whole, audio, screens] = await Promise.all([measure(dir), part("audio"), part("screens")]);
    return { bytes: whole.bytes, audio, screens };
  });

  const remove = api((project, id) => change(project, id, async (location, dir) => {
    await assertNoLinks(dir);
    await moveToTrash(dir);
    await refreshIndex(location);
  }));
  const removeAudio = api((project, id) => change(project, id, async (location, dir) => {
    if (!await readMeeting(location.base, dir)) fail("meetingsBroken", dir);
    const audio = path.join(dir, "audio"), st = await checkPath(location.base, audio);
    if (st) {
      if (!st.isDirectory()) fail("meetingsForeignFiles", audio);
      await assertNoLinks(audio);
      await moveToTrash(audio);
    }
    return saveChanges(location, dir, id, { audio: { mic: null, system: null } });
  }));
  const removeScreen = api((project, id, name) => {
    if (!isScreen(name)) fail("invalidData", name);
    return change(project, id, async (location, dir) => {
      if (!await readMeeting(location.base, dir)) fail("meetingsBroken", dir);
      const file = path.join(dir, name), st = await checkPath(location.base, file);
      if (st) {
        if (!st.isFile()) fail("meetingsForeignFiles", file);
        await moveToTrash(file);
      }
      return saveChanges(location, dir, id, m => ({ screens: m.screens.filter(s => s.file !== name) }));
    });
  });

  const rebuildIndex = api(project => serial(project, async location => {
    const folder = meetingsFolder(location);
    if (!await inspect(folder)) fail("meetingsNotFound", location.dir);
    await ignoreItself(folder);
    await writeIndex(location);
  }));

  return { resolve, prepare, create, read, list, count, update, rename, write, filePath, size, remove, removeAudio, removeScreen, rebuildIndex };
}

module.exports = { createMeetingStore };
