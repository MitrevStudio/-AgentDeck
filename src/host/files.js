// The files of this computer for a paired one that may control it (mesh/serve.js "files.*"; docs/FILES.md): folders
// listed a page at a time, a file read a piece at a time, folders made, things renamed, copied, moved and deleted, and
// files taken from the other side a piece at a time. The same for the desktop's own side of its two panes, called
// without a link (peer "").
//
// Nothing is ever written over: a copy, a move across volumes and an upload whose name is taken get "name (2)", a
// rename and a new folder answer `exists` (the one asking offers "name (2)"). What is being written carries
// PART at its end and gets its name only when it is whole.
//
// A path is the other side's typing: a whole path of this computer, "~" for the home. "" is the list of roots (the
// drives on Windows, "/" elsewhere). A volume's root is neither copied, moved nor deleted, and the home and the folders
// that hold it are neither deleted, renamed nor moved away. On Windows a path begins with a drive's letter: a share
// (\\server\folder) is refused under any spelling (`networkPath`) - "\\localhost\C$\..." is this computer's own disk
// under a name the looks at what a path is would not know, and any other server is one this computer would sign in to
// because a peer said so. Nor is there a ":" after the drive's (a stream of another file), or a new name that is a
// device's (NUL, COM1, con.txt: a file the system's own file manager cannot remove).
//
// Copying a folder follows the links in it, as the system's file manager does - but not one to a volume's root or to
// a folder it is already inside (counted in `skipped`), so a link never copies a whole disk or goes round for ever.
//
// Errors are HostError codes the other side translates: invalidData, folderNotAbsolute, fileMissing, notFile,
// notFolder, exists, fileDenied, changed, crossDevice, rootRefused, networkPath, intoItself, tooManyJobs, jobMissing,
// diskFull, sourceLeft (a move that copied everything and could not remove all of the source: the copy stays),
// fileFailed (its message is the system's name for what went wrong - "EINVAL" - and never its text, which holds a path
// of this computer).
//
// createFiles({ home, trash, notify }) - trash(path): moves it to the system's bin (a promise), absent on a host
// without one: there a delete is for good; notify(peer, name, data): an event to that peer ("files.job" when a copy
// ends). For the tests, what the disk is asked can be replaced: rm(path), rootMs, and io: { link, lstat (of a rename's
// two names), realpath, probe (the look at a drive's letter) }.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { HostError } = require("./errors");
const { readAt } = require("./file-chunks");

const fsp = fs.promises;
const MAX_PATH = 4096;
const PAGE = 500;                      // entries in one files.list
const CHUNK = 256 * 1024;              // bytes in one files.read / files.write (docs/FILES.md 3.3)
const COPY_CHUNK = 1024 * 1024;
const MAX_JOBS = 2, MAX_UPLOADS = 2;   // per peer
const UPLOAD_IDLE_MS = 10 * 60 * 1000;
const JOB_KEEP_MS = 10 * 60 * 1000;    // a finished job can be asked about this long
const MAX_SIZE = 2 ** 40;              // an upload's size: a sanity bound, not a quota
const PART = ".agentdeck-part";
const BATCH = 64;                      // entries looked at together; the loop gets a turn between two batches
const LIST_KEEP_MS = 60 * 1000;        // a sorted folder is kept this long after a page of it was last asked for
const LISTS_KEPT = 8;                  // sorted folders kept, for all peers together
const ROOT_MS = 1500;                  // a drive's letter that has not answered by then is left out
const WIN = process.platform === "win32";
// The names Windows keeps for its devices, with or without an extension.
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]) *(?:\.|$)/i;
const ERRNO = {
  ENOENT: "fileMissing", EACCES: "fileDenied", EPERM: "fileDenied", EBUSY: "fileDenied", EEXIST: "exists",
  ENOTEMPTY: "exists", ENOSPC: "diskFull", EXDEV: "crossDevice", ENOTDIR: "notFolder", EISDIR: "notFile"
};

const fail = (code, message) => { throw new HostError(code, message); };
// What the file system said, as a code of ours.
// The system's name for what went wrong ("EINVAL"), where it has one: its text is not sent, it holds the whole path.
const errno = e => (typeof e?.code === "string" && /^E[A-Z0-9]{1,30}$/.test(e.code) ? e.code : undefined);
function failed(e) {
  if (e instanceof HostError) throw e;
  throw new HostError(ERRNO[e?.code] || "fileFailed", ERRNO[e?.code] ? undefined : errno(e));
}
const int = (v, min, max) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail("invalidData");
  return v;
};
const isRoot = p => path.parse(p).root === p;
// A share of another computer - or of this one, under its network name.
const isShare = p => WIN && /^[\\/]{2}/.test(p);
const same = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
// b is a or inside it.
const inside = (a, b) => same(a, b) || (WIN ? b.toLowerCase() : b).startsWith((WIN ? a.toLowerCase() : a) + (a.endsWith(path.sep) ? "" : path.sep));
const lstat = p => fsp.lstat(p).catch(() => null);
// fn(item) for each of them, BATCH at a time: a folder of thousands asks the disk a bounded number of things at once,
// and whatever else the process does (the terminals, in the desktop's main process) gets a turn between two batches.
async function each(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) {
    out.push(...await Promise.all(items.slice(i, i + BATCH).map(fn)));
    if (i + BATCH < items.length) await new Promise(setImmediate);
  }
  return out;
}

// "name.ext" -> "name (2).ext", "name (3).ext"...; a folder's name has no extension to keep.
function numbered(file, n, dir) {
  const ext = dir ? "" : path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)} (${n})${ext}`);
}
// The unfinished files this process is writing (uploads, copies), by name. One that is on the disk and not here was
// left by a process that ended before it could remove it.
const writing = new Set();
const partKey = part => (WIN ? part.toLowerCase() : part);
const letGo = part => writing.delete(partKey(part));
// A PART nobody writes any more is in the way of its name for ever (every later upload of that name would be
// numbered), so it goes: one that is not this process's and was last written longer ago than an upload may stay idle.
// Kept in memory, not in the data folder: two hosts are not meant to write into one folder, and if they do, the age
// is what keeps one from taking the other's - all but a copy that measures its source for longer than that before
// its first byte.
async function abandoned(part) {
  const st = await lstat(part);
  if (!st) return true;
  if (!st.isFile() || Date.now() - st.mtimeMs <= UPLOAD_IDLE_MS) return false;
  return fsp.rm(part, { force: true }).then(() => true, () => false);
}
// A name that is free, taken at once so that no one else gets it between the look and the use: a folder is made, for
// a file its PART is - noted in `writing` until whoever asked lets go of it (letGo). -> the name: `wanted`, or the
// first numbered one.
async function reserve(wanted, dir) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? wanted : numbered(wanted, n, dir);
    const key = partKey(name + PART);
    // Noted before the disk is asked anything: two requests of this process never look at one PART together.
    if (writing.has(key)) continue;
    writing.add(key);
    let got = false;
    try {
      if (await lstat(name) || !(await abandoned(name + PART))) continue;
      if (dir) await fsp.mkdir(name);
      else await (await fsp.open(name + PART, "wx")).close();
      got = !dir;
      return name;
    } catch (e) { if (e?.code !== "EEXIST") failed(e); } finally { if (!got) writing.delete(key); }
  }
  return fail("exists");
}
// All of buf at pos. A write may take fewer bytes than it was given (a quota, a limit on a file's size) and only say
// how many: the rest is written again, and a write that takes none is a full disk - never a shorter file called whole.
async function writeAll(fh, buf, pos) {
  for (let done = 0; done < buf.length;) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, pos + done);
    if (!bytesWritten) throw Object.assign(new Error("no more of the file is taken"), { code: "ENOSPC" });
    done += bytesWritten;
  }
}
// A finished file gets its name without taking another's: a hard link fails when the name is there, where a rename
// would write over it. A volume without links gets a copy that refuses a name that is there. Throws EEXIST.
async function place(part, dst, link) {
  try { await link(part, dst); } catch (e) {
    if (e?.code === "EEXIST") throw e;
    await fsp.copyFile(part, dst, fs.constants.COPYFILE_EXCL);
  }
  await fsp.rm(part, { force: true }).catch(() => {});
}
// The same for a file whose name may have been taken since it was reserved: the next numbered one. -> the name.
async function settle(part, wanted, link) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? wanted : numbered(wanted, n, false);
    try { await place(part, name, link); return name; } catch (e) { if (e?.code !== "EEXIST") failed(e); }
  }
  return fail("exists");
}

// rm(path): how a moved thing's source is removed - the tests' way to make that fail.
function createFiles({ home = "", trash = null, notify = () => {}, rm = p => fsp.rm(p, { recursive: true }), rootMs = ROOT_MS, io = {} } = {}) {
  const link = io.link || ((a, b) => fsp.link(a, b));
  const lstatBoth = io.lstat || ((p, o) => fsp.lstat(p, o));
  const realpath = io.realpath || (p => fsp.realpath(p));
  const probe = io.probe || (p => fsp.stat(p));
  const jobs = new Map();     // id -> job
  const uploads = new Map();  // id -> upload
  // How many a peer has going, counted before anything is waited for: requests sent together must not all get in.
  const jobSlots = new Map(), uploadSlots = new Map();
  const take = (slots, peer, max) => { if ((slots.get(peer) || 0) >= max) fail("tooManyJobs"); slots.set(peer, (slots.get(peer) || 0) + 1); };
  const release = (slots, peer) => { const n = (slots.get(peer) || 1) - 1; if (n > 0) slots.set(peer, n); else slots.delete(peer); };

  // ---------- paths ----------
  // The other side's path, whole and tidied. Nothing is looked at on the disk.
  function whole(input) {
    if (typeof input !== "string" || input.length > MAX_PATH || input.includes("\0")) fail("invalidData");
    // As it was typed: a name may end in a blank, and "foo " is not "foo". A path that goes round the names' rules
    // (\\?\, \\.\) is not taken: the same folder under it would pass every look at what it is.
    const typed = input;
    if (!typed.trim() || (WIN && /^[\\/]{2}[?.][\\/]/.test(typed))) fail("invalidData");
    const tilde = typed === "~" || typed.startsWith("~/") || typed.startsWith("~\\");
    if (tilde && !home) fail("fileMissing");
    const full = tilde ? path.join(home, typed.slice(2)) : typed;
    if (isShare(full)) fail("networkPath");
    if (!path.isAbsolute(full)) fail("folderNotAbsolute");
    if (WIN) {
      // "\Windows" and "/x" are whole paths to Node, on whatever drive this process happens to stand - which the
      // other side cannot know. A ":" after the drive's names a stream inside another file.
      if (!/^[a-zA-Z]:[\\/]/.test(full)) fail("folderNotAbsolute");
      if (full.includes(":", 2)) fail("invalidData");
    }
    const tidy = path.resolve(full);
    if (isShare(tidy)) fail("networkPath");
    return tidy;
  }
  // The same for a name that is to be made: not one of a device's.
  function fresh(input) {
    const file = whole(input);
    if (WIN && DEVICE.test(path.basename(file))) fail("invalidData");
    return file;
  }
  // The folder a new thing goes into: it must be one.
  async function folderOf(file) {
    const parent = path.dirname(file);
    const st = await fsp.stat(parent).catch(() => null);
    if (!st) fail("folderMissing");
    if (!st.isDirectory()) fail("notFolder");
    return parent;
  }
  async function roots() {
    if (process.platform !== "win32") return ["/"];
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(l => `${l}:\\`);
    const there = await Promise.all(letters.map(answers));
    return letters.filter((_, i) => there[i]);
  }
  // Whether a drive's letter is there, said within rootMs: a mapped drive whose server is gone answers after tens of
  // seconds, and holds one of the few threads the disk is asked on until then. So a look that was late is not begun
  // again while it is still out - its letter is left out at once - and is made anew once it has answered.
  const looks = new Map(); // a root -> { look, late }
  function answers(root) {
    let l = looks.get(root);
    if (l?.late) return false;
    if (!l) {
      l = { late: false };
      l.look = Promise.resolve().then(() => probe(root)).then(() => true, () => false).finally(() => looks.delete(root));
      looks.set(root, l);
    }
    let timer;
    const late = new Promise(res => { timer = setTimeout(() => { l.late = true; res(false); }, rootMs); });
    return Promise.race([l.look, late]).finally(() => clearTimeout(timer));
  }

  // ---------- reading ----------
  // One entry as the other side sees it. A link says what it leads to (dir, size), and that it is a link.
  async function entry(file, name = path.basename(file) || file) {
    const own = await fsp.lstat(file).catch(failed);
    const link = own.isSymbolicLink();
    const st = link ? await fsp.stat(file).catch(() => own) : own;
    return { name, dir: st.isDirectory(), link, size: st.isFile() ? st.size : 0, mtime: Math.round(st.mtimeMs) };
  }
  const order = (a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  // {path, after?, limit?, sort?, desc?, filter?} -> { path, parent, sep, home, entries, next, total }: folders first, then by name; `next` is
  // given back as `after` for the page that follows ("" when this was the last). parent: "" above a root (the roots
  // themselves), null for the roots.
  // A folder in an order that needed every entry looked at, kept for the pages that follow: the look is made once, when
  // the folder is opened, not again for each page (30 000 entries are half a second of the disk and of this process
  // each time). The first page always looks anew; a page after it is cut from what that look found, for as long as
  // pages are asked for within LIST_KEEP_MS of each other. Few are kept, the oldest goes first.
  const lists = new Map(); // peer + folder + order + search -> { peer, seen, timer }
  function forget(key) {
    clearTimeout(lists.get(key)?.timer);
    lists.delete(key);
  }
  function keep(key, peer, seen) {
    forget(key);
    const timer = setTimeout(() => lists.delete(key), LIST_KEEP_MS);
    timer.unref?.();
    lists.set(key, { peer, seen, timer });
    for (const old of lists.keys()) { if (lists.size <= LISTS_KEPT) break; forget(old); }
    return seen;
  }
  // peer: who asks ("" this computer's own window) - a kept order is its own.
  async function list(p, peer = "") {
    const limit = p?.limit === undefined ? PAGE : int(p.limit, 1, PAGE);
    if (p?.path === "" || p?.path === undefined) {
      const entries = (await roots()).map(name => ({ name, dir: true, link: false, size: 0, mtime: 0 }));
      return { path: "", parent: null, sep: path.sep, home, entries, next: "" };
    }
    const dir = whole(p.path);
    const after = p?.after === undefined || p.after === "" ? null : String(p.after).slice(0, 600);
    // sort: "name" (as it always was), "mtime" or "size"; desc: the other way round; filter: only names that hold
    // that text, whatever the letters' case. Folders stay first in every order.
    const sort = p?.sort === undefined ? "name" : p.sort, desc = Boolean(p?.desc);
    if (!["name", "mtime", "size"].includes(sort)) fail("invalidData");
    const filter = p?.filter === undefined ? "" : String(p.filter).slice(0, 200).toLowerCase();
    const sorted = sort !== "name" || desc;
    if (sorted && after !== null && after[0] !== "#") fail("invalidData");
    const key = JSON.stringify([peer, dir, sort, desc, filter]);
    const kept = sorted && after !== null ? lists.get(key) : null;
    const found = kept ? [] : await fsp.readdir(dir, { withFileTypes: true }).catch(failed);
    let all = found.map(d => ({ name: d.name, dir: d.isDirectory(), link: d.isSymbolicLink(), key: d.name.toLowerCase() }));
    if (filter) all = all.filter(x => x.key.includes(filter));
    if (sorted) {
      // Any other order needs every entry looked at before the first page can be cut; the place in it is a count,
      // given as "#n" (a folder that changes between two pages is then not seen to: the pages are of the look the
      // first one made, or - once that is no longer kept - may repeat or miss a row. The name order does neither).
      let seen = kept?.seen;
      if (kept) keep(key, peer, seen);
      else {
        seen = (await each(all, x => entry(path.join(dir, x.name), x.name).catch(() => null))).filter(Boolean);
        const by = sort === "name" ? (a, b) => order({ ...a, key: a.name.toLowerCase() }, { ...b, key: b.name.toLowerCase() }) : (a, b) => a[sort] - b[sort] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        seen.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : desc ? by(b, a) : by(a, b)));
        keep(key, peer, seen);
      }
      const start = after === null ? 0 : int(Number(after.slice(1)), 0, seen.length);
      return {
        path: dir, parent: isRoot(dir) ? "" : path.dirname(dir), sep: path.sep, home, entries: seen.slice(start, start + limit),
        next: start + limit < seen.length ? "#" + (start + limit) : "", total: seen.length
      };
    }
    // Whether a link leads to a folder decides where it is sorted; only links are looked at for it.
    await each(all.filter(x => x.link), async x => { x.dir = await fsp.stat(path.join(dir, x.name)).then(s => s.isDirectory(), () => false); });
    all.sort(order);
    let from = 0;
    if (after !== null) {
      const cut = { dir: after[0] === "d", name: after.slice(1), key: after.slice(1).toLowerCase() };
      from = all.findIndex(x => order(x, cut) > 0);
      if (from < 0) from = all.length;
    }
    const page = all.slice(from, from + limit);
    // One that went between the listing and the look at it is left out.
    const entries = (await each(page, x => entry(path.join(dir, x.name), x.name).catch(() => null))).filter(Boolean);
    const last = page[page.length - 1];
    return {
      path: dir, parent: isRoot(dir) ? "" : path.dirname(dir), sep: path.sep, home, entries,
      next: from + limit < all.length && last ? (last.dir ? "d" : "f") + last.name : "", total: all.length
    };
  }
  const stat = async p => { const file = whole(p?.path); return { path: file, ...(await entry(file)) }; };

  // {path, pos, len, size?, mtime?} -> { data (base64), size, mtime, eof }. With the size and time a first piece
  // answered, a file that is no longer that one is refused (`changed`): its pieces must not be put together.
  async function read(p) {
    const file = whole(p?.path), pos = int(p?.pos, 0, MAX_SIZE), len = int(p?.len, 1, CHUNK);
    // Looked at before it is opened: opening a pipe would wait for its other end.
    const pre = await fsp.stat(file).catch(failed);
    if (!pre.isFile()) fail(pre.isDirectory() ? "notFile" : "fileDenied");
    const fh = await fsp.open(file, "r").catch(failed);
    try {
      const st = await fh.stat();
      if (!st.isFile()) fail(st.isDirectory() ? "notFile" : "fileDenied");
      const size = st.size, mtime = Math.round(st.mtimeMs);
      if ((p.size !== undefined && p.size !== size) || (p.mtime !== undefined && p.mtime !== mtime)) fail("changed");
      const buf = pos < size ? await readAt(fh, pos, Math.min(len, size - pos)) : Buffer.alloc(0);
      return { data: buf.toString("base64"), size, mtime, eof: pos + buf.length >= size };
    } catch (e) { return failed(e); } finally { await fh.close().catch(() => {}); }
  }

  // ---------- changing ----------
  // {path, keep?} -> { path }: one new folder in a folder that is there.
  async function mkdir(p) {
    let dir = fresh(p?.path);
    await folderOf(dir);
    for (let n = 2; ; n++) {
      try { await fsp.mkdir(dir); return { path: dir }; } catch (e) {
        if (e?.code !== "EEXIST" || !p?.keep || n >= 1000) failed(e);
        dir = numbered(whole(p.path), n, true);
      }
    }
  }
  // What a path leads to, for the looks that must not be passed with another spelling of it (a short name, a link).
  const realOf = p => Promise.resolve().then(() => realpath(p)).catch(() => p);
  // What must stay where it is: a volume, the home, and whatever holds the home - under any spelling, so by the path
  // and by what it leads to. A link is only itself: it goes, not what it leads to. Asked before anything is deleted,
  // renamed or moved away. st: the path's own lstat.
  async function staysPut(file, st) {
    const real = st.isSymbolicLink() ? file : await realOf(file);
    // What leads to a share cannot be told from the home by its path (the home may be shared), so it is not judged.
    if (isShare(real)) fail("networkPath");
    const homes = home ? [path.resolve(home), await realOf(home)] : [];
    if (isRoot(file) || isRoot(real) || homes.some(h => inside(file, h) || inside(real, h))) fail("rootRefused");
  }
  // {from, to} -> { path }: a new name, or another folder of the same volume.
  async function rename(p) {
    const from = whole(p?.from), to = fresh(p?.to);
    const st = await lstatBoth(from, { bigint: true }).catch(failed);
    await staysPut(from, st);
    if (st.isDirectory() && !same(from, to) && inside(from, to)) fail("intoItself");
    await folderOf(to);
    // The same file under another spelling - only the letters' case changed, where names are told apart without it -
    // is no one else's. Told by what the disk says the two are, not by the names: a folder may tell them apart. A
    // volume that numbers nothing (ino 0: some network and FAT ones) is asked the other way: the two names differ
    // only in case, and their folder holds one entry of that name in any case.
    const mine = async there => {
      if (there.ino && st.ino) return there.ino === st.ino && there.dev === st.dev;
      if (from === to || from.toLowerCase() !== to.toLowerCase()) return false;
      const name = path.basename(to).toLowerCase();
      return (await fsp.readdir(path.dirname(to)).catch(() => [])).filter(n => n.toLowerCase() === name).length === 1;
    };
    // -> the name is free (true), or this very file's (false); anyone else's is `exists`.
    const free = async () => {
      const there = await lstatBoth(to, { bigint: true }).catch(() => null);
      if (there && !(await mine(there))) fail("exists");
      return !there;
    };
    if (await free() && st.isFile()) {
      // A file gets its new name as a link first: that fails on a name which appeared since the look, a rename would
      // write over it.
      let linked = false;
      try { await link(from, to); linked = true; } catch (e) { if (e?.code === "EEXIST") fail("exists"); }
      if (linked) {
        try { await fsp.unlink(from); } catch (e) { await fsp.unlink(to).catch(() => {}); failed(e); }
        return { path: to };
      }
    }
    // A folder, and a file on a volume without links, have only the rename, and no system Node reaches has one that
    // refuses a taken name. So the name is looked at once more, right before: what remains is a file (or, outside
    // Windows, an empty folder) that appears under it between this look and the rename - that one is written over.
    await free();
    await fsp.rename(from, to).catch(failed);
    return { path: to };
  }
  // {path} -> { trashed }: into the bin where this computer has one, else for good. A link goes, not what it leads to.
  async function remove(p) {
    const file = whole(p?.path);
    await staysPut(file, await fsp.lstat(file).catch(failed));
    if (trash) {
      // The bin's own words are not passed on either: they name the path.
      await Promise.resolve().then(() => trash(file)).catch(e => fail("fileFailed", errno(e)));
      return { trashed: true };
    }
    await fsp.rm(file, { recursive: true }).catch(failed);
    return { trashed: false };
  }

  // ---------- copies ----------
  const jobOut = j => ({ job: j.id, state: j.state, to: j.to, move: j.move, files: j.files, bytes: j.bytes, total: j.total, skipped: j.skipped, error: j.error });
  const stopped = j => { if (j.cancel) fail("cancelled"); };
  // What a tree holds, following its links as the copy will: the bytes, for the progress.
  async function measure(j, src, chain) {
    stopped(j);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) return;
    if (st.isFile()) { j.total += st.size; return; }
    if (!st.isDirectory()) return;
    const real = await realOf(src);
    if (isRoot(real) || isShare(real) || chain.some(x => same(x, real))) return;
    for (const name of await fsp.readdir(src).catch(() => [])) await measure(j, path.join(src, name), [...chain, real]);
  }
  // top: the job's own target, whose PART was reserved when the job began and whose name may be numbered again.
  async function copyFile(j, src, dst, top) {
    const part = dst + PART;
    const from = await fsp.open(src, "r").catch(failed);
    let to;
    try { to = await fsp.open(part, top ? "r+" : "wx"); } catch (e) { await from.close().catch(() => {}); return failed(e); }
    try {
      for (let pos = 0; ;) {
        stopped(j);
        const buf = await readAt(from, pos, COPY_CHUNK);
        if (!buf.length) break;
        await writeAll(to, buf, pos);
        pos += buf.length;
        j.bytes += buf.length;
      }
      // The copy is the file it was copied from: a program stays one and a private file private (the new file was
      // made with the defaults), and its time is the file's, not the copy's. A volume that keeps neither is no failure.
      const st = await from.stat();
      if (process.platform !== "win32") await to.chmod(st.mode & 0o777).catch(() => {});
      await to.utimes(st.atime, st.mtime).catch(() => {});
    } catch (e) {
      await Promise.all([from.close(), to.close()].map(x => x.catch(() => {})));
      await fsp.rm(part, { force: true }).catch(() => {});
      return failed(e);
    }
    await Promise.all([from.close(), to.close()].map(x => x.catch(() => {})));
    try {
      if (top) { j.to = await settle(part, dst, link); j.placed = true; }
      else await place(part, dst, link);
    } catch (e) {
      await fsp.rm(part, { force: true }).catch(() => {});
      return failed(e);
    }
    j.files++;
  }
  async function copyTree(j, src, dst, chain, top) {
    stopped(j);
    const st = await fsp.stat(src).catch(() => null);
    if (!st) { j.skipped++; return; }                     // a link that leads nowhere, or one that went meanwhile
    if (st.isFile()) return copyFile(j, src, dst, top);
    if (!st.isDirectory()) { j.skipped++; return; }
    const real = await realOf(src);
    // Not a volume, not a share (a link in the tree would choose the server), not a folder it is already inside, and
    // not the copy itself (reached by a link, it would never end).
    if (isRoot(real) || isShare(real) || chain.some(x => same(x, real)) || (j.toReal && same(real, j.toReal))) { j.skipped++; return; }
    if (!top) await fsp.mkdir(dst).catch(failed);         // the job's own folder was made when its name was taken
    for (const name of await fsp.readdir(src).catch(failed)) await copyTree(j, path.join(src, name), path.join(dst, name), [...chain, real], false);
    // A folder's permissions after what is in it: one that may not be written to could not have been filled.
    if (process.platform !== "win32") await fsp.chmod(dst, st.mode & 0o777).catch(() => {});
  }
  async function runJob(j) {
    // Once the source of a move begins to go, the copy is all there is of what went: it stays, whatever happens.
    let kept = false;
    try {
      await measure(j, j.from, []);
      await copyTree(j, j.from, j.to, [], true);
      if (j.move) {
        stopped(j);
        // What was skipped was not copied: the source stays, it is the only place that has it. So does the copy.
        if (j.skipped) { kept = true; fail("sourceLeft"); }
        kept = true;
        await Promise.resolve().then(() => rm(j.from)).catch(() => fail("sourceLeft"));
      }
      j.state = "done";
    } catch (e) {
      j.state = j.cancel && !kept ? "cancelled" : "failed";
      j.error = j.state === "cancelled" ? "" : e?.code || "fileFailed";
      // Only what the job itself made: its folder (made, not found, when the name was taken), its unfinished file, or
      // the file it gave a name to.
      if (!kept) {
        if (j.dir) await fsp.rm(j.to, { recursive: true, force: true }).catch(() => {});
        else {
          await fsp.rm(j.to + PART, { force: true }).catch(() => {});
          if (j.placed) await fsp.rm(j.to, { force: true }).catch(() => {});
        }
      }
    }
    j.done = true;
    if (!j.dir) letGo(j.part);
    release(jobSlots, j.peer);
    try { notify(j.peer, "files.job", jobOut(j)); } catch {}
    setTimeout(() => jobs.delete(j.id), JOB_KEEP_MS).unref?.();
  }
  // {from, to, move?} -> the job, begun: a file or a folder with all in it, to a name that is free.
  async function copy(peer, p) {
    const from = whole(p?.from), wanted = fresh(p?.to);
    take(jobSlots, peer, MAX_JOBS);
    let j;
    try {
      const st = await fsp.stat(from).catch(failed);
      const real = await realOf(from);
      // What the looks below compare are paths of this computer's disks; one that leads to a share is not one.
      if (isShare(real)) fail("networkPath");
      if (isRoot(from) || isRoot(real)) fail("rootRefused");
      // A move takes its source away for good, as a delete does.
      if (p?.move) await staysPut(from, await fsp.lstat(from).catch(failed));
      const parent = await folderOf(wanted);
      // Beside itself is not into itself: a folder copied where it is gets the numbered name. By what the paths lead
      // to as well, so that another spelling of the folder does not pass.
      const into = await realOf(parent);
      if (isShare(into)) fail("networkPath");
      const target = path.join(into, path.basename(wanted));
      if (st.isDirectory() && ((!same(real, target) && inside(real, target)) || (!same(from, wanted) && inside(from, wanted)))) fail("intoItself");
      const dir = st.isDirectory();
      const to = await reserve(wanted, dir);
      j = { id: crypto.randomUUID(), peer, from, to, part: to + PART, dir, toReal: dir ? await realOf(to) : "", placed: false, move: Boolean(p?.move), state: "running", files: 0, bytes: 0, total: 0, skipped: 0, error: "", cancel: false, done: false };
    } catch (e) { release(jobSlots, peer); throw e; }
    jobs.set(j.id, j);
    j.run = runJob(j);
    return jobOut(j);
  }
  function jobOf(peer, id) {
    const j = typeof id === "string" ? jobs.get(id) : null;
    if (!j || j.peer !== peer) fail("jobMissing");
    return j;
  }
  const job = async (peer, p) => jobOut(jobOf(peer, p?.job));
  async function cancel(peer, p) {
    const j = jobOf(peer, p?.job);
    if (!j.done) { j.cancel = true; await j.run; }
    return jobOut(j);
  }

  // ---------- uploads ----------
  function uploadOf(peer, id) {
    const u = typeof id === "string" ? uploads.get(id) : null;
    if (!u || u.peer !== peer) fail("jobMissing");
    return u;
  }
  async function drop(u) {
    if (!uploads.delete(u.id)) return;
    release(uploadSlots, u.peer);
    clearTimeout(u.timer);
    await u.busy.catch(() => {});
    await u.fh.close().catch(() => {});
    await fsp.rm(u.part, { force: true }).catch(() => {});
    letGo(u.part);
  }
  const touch = u => { clearTimeout(u.timer); u.timer = setTimeout(() => drop(u), UPLOAD_IDLE_MS); u.timer.unref?.(); };
  // {path, size} -> { upload, path }: a file of that many bytes is coming; the path is the name it will get.
  async function begin(peer, p) {
    const wanted = fresh(p?.path), size = int(p?.size, 0, MAX_SIZE);
    take(uploadSlots, peer, MAX_UPLOADS);
    let file, fh;
    try {
      await folderOf(wanted);
      file = await reserve(wanted, false);
      fh = await fsp.open(file + PART, "r+").catch(failed);
    } catch (e) {
      release(uploadSlots, peer);
      if (file) { await fsp.rm(file + PART, { force: true }).catch(() => {}); letGo(file + PART); }
      throw e;
    }
    const u = { id: crypto.randomUUID(), peer, file, part: file + PART, fh, size, written: 0, busy: Promise.resolve(), writing: false };
    uploads.set(u.id, u);
    touch(u);
    return { upload: u.id, path: file };
  }
  // {upload, pos, data (base64)} -> { written }: the next piece; pos is where the last one ended.
  async function write(peer, p) {
    const u = uploadOf(peer, p?.upload);
    if (typeof p?.data !== "string" || p.data.length > Math.ceil(CHUNK * 4 / 3) + 4) fail("tooBig");
    const buf = Buffer.from(p.data, "base64");
    if (u.writing || !buf.length || buf.length > CHUNK || p.pos !== u.written || u.written + buf.length > u.size) fail("invalidData");
    u.writing = true;
    u.busy = writeAll(u.fh, buf, u.written);
    try { await u.busy; } catch (e) { await drop(u); return failed(e); } finally { u.writing = false; }
    u.written += buf.length;
    touch(u);
    return { written: u.written };
  }
  // {upload} -> { path }: all of it came; the file gets its name.
  async function commit(peer, p) {
    const u = uploadOf(peer, p?.upload);
    if (u.writing || u.written !== u.size) fail("invalidData");
    uploads.delete(u.id);
    release(uploadSlots, u.peer);
    clearTimeout(u.timer);
    await u.fh.close().catch(() => {});
    try {
      // A name taken since the upload began is not written over either: the next numbered one.
      u.file = await settle(u.part, u.file, link);
    } catch (e) {
      await fsp.rm(u.part, { force: true }).catch(() => {});
      return failed(e);
    } finally { letGo(u.part); }
    return { path: u.file };
  }
  async function abort(peer, p) { await drop(uploadOf(peer, p?.upload)); return true; }

  // A link that dropped: what that peer was sending is left unfinished and goes. Its copies go on (docs/FILES.md 3.5).
  function dropPeer(peer) {
    for (const [key, l] of lists) if (l.peer === peer) forget(key);
    return Promise.all([...uploads.values()].filter(u => u.peer === peer).map(drop));
  }
  async function dispose() {
    for (const key of [...lists.keys()]) forget(key);
    for (const j of jobs.values()) j.cancel = true;
    await Promise.all([...jobs.values()].map(j => j.run));
    await Promise.all([...uploads.values()].map(drop));
  }

  return { list, stat, read, mkdir, rename, remove, copy, job, cancel, begin, write, commit, abort, drop: dropPeer, dispose, hasTrash: Boolean(trash) };
}

module.exports = { createFiles, writeAll, CHUNK, PAGE, PART, LISTS_KEPT };
