// The files of a computer for a paired one (src/host/files.js, docs/FILES.md): what must never happen is a file
// written over, a file put together from two versions, an unfinished file under its real name, a copy that never
// ends, and a drive or the home deleted. First the module by itself in a temporary folder (with a home that is a
// temporary folder too - nothing here can reach the real one), then the same through a real phone, relay and host,
// and a file of the host offered to a phone (src/host/file-offers.js) and answered by it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createFiles, CHUNK, PAGE, PART } = require("../src/host/files");
const { withPhone, waitFor } = require("./phone-test-rig");

const code = c => ({ code: c });
const b64 = b => b.toString("base64");
async function tree(dir) {
  const out = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(d.name + "/", ...(await tree(p)).map(x => d.name + "/" + x));
    else out.push(d.name);
  }
  return out.sort();
}
async function finished(files, peer, job) {
  let j;
  await waitFor(async () => { j = await files.job(peer, { job }); return j.state !== "running"; }, "the copy ends");
  return j;
}

async function alone(root) {
  const home = path.join(root, "home"), work = path.join(root, "work");
  await fsp.mkdir(home); await fsp.mkdir(work);
  const events = [];
  const files = createFiles({ home, notify: (peer, name, data) => events.push({ peer, name, data }) });
  const at = (...p) => path.join(work, ...p);

  // ---------- paths ----------
  for (const bad of [undefined, "", "   ", 5, "a\0b", "x".repeat(5000)]) await assert.rejects(files.stat({ path: bad }), code("invalidData"));
  await assert.rejects(files.stat({ path: "relative/one" }), code("folderNotAbsolute"));
  await assert.rejects(files.stat({ path: at("nothing") }), code("fileMissing"));
  assert.equal((await files.stat({ path: "~" })).path, home);
  assert.equal((await files.stat({ path: at("sub", "..") })).path, work, "a path is tidied, and means what it says");
  const roots = await files.list({ path: "" });
  assert.equal(roots.parent, null);
  assert.ok(roots.entries.length && roots.entries.every(e => e.dir), "the roots are folders");
  assert.ok(roots.entries.some(e => path.parse(work).root.toLowerCase() === e.name.toLowerCase()), "the drive of the test is among them");
  assert.equal((await files.list({ path: path.parse(work).root, limit: 1 })).parent, "", "above a root are the roots");
  console.log("ok: paths - whole only, tidied, the home, the roots");

  // ---------- a long folder, a page at a time ----------
  const many = at("many");
  await fsp.mkdir(many);
  const names = [];
  for (let i = 0; i < 1200; i++) names.push(i % 10 === 0 ? `Dir-${i}` : i % 7 === 0 ? `.hidden-${i}` : `file-${i}.txt`);
  await Promise.all(names.map(n => (n.startsWith("Dir") ? fsp.mkdir(path.join(many, n)) : fsp.writeFile(path.join(many, n), n))));
  const seen = [];
  let pages = 0;
  for (let after; ;) {
    const page = await files.list({ path: many, after });
    assert.ok(page.entries.length <= PAGE);
    seen.push(...page.entries);
    pages++;
    if (!page.next) break;
    after = page.next;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen.map(e => e.name).sort(), [...names].sort(), "every entry once, the hidden ones too");
  const firstFile = seen.findIndex(e => !e.dir);
  assert.ok(seen.slice(0, firstFile).every(e => e.dir) && seen.slice(firstFile).every(e => !e.dir), "folders first");
  assert.equal(seen.find(e => e.name === "file-1.txt").size, 10);
  await assert.rejects(files.list({ path: at("many", "file-1.txt") }), code("notFolder"));
  // Other orders and a search by name: folders stay first, pages still hold every entry once.
  const sorted = at("sorted");
  await fsp.mkdir(sorted); await fsp.mkdir(path.join(sorted, "zeta")); await fsp.mkdir(path.join(sorted, "Alpha"));
  for (const [name, bytes, day] of [["small-old.txt", 1, 1], ["Big-new.APK", 900, 3], ["middle.md", 50, 2]]) {
    await fsp.writeFile(path.join(sorted, name), Buffer.alloc(bytes));
    await fsp.utimes(path.join(sorted, name), new Date(2026, 0, day), new Date(2026, 0, day));
  }
  const namesOf = async q => (await files.list({ path: sorted, ...q })).entries.map(e => e.name);
  assert.deepEqual(await namesOf({}), ["Alpha", "zeta", "Big-new.APK", "middle.md", "small-old.txt"]);
  assert.deepEqual(await namesOf({ desc: true }), ["zeta", "Alpha", "small-old.txt", "middle.md", "Big-new.APK"]);
  assert.deepEqual((await namesOf({ sort: "mtime", desc: true })).slice(2), ["Big-new.APK", "middle.md", "small-old.txt"], "the newest first");
  assert.deepEqual((await namesOf({ sort: "size" })).slice(2), ["small-old.txt", "middle.md", "Big-new.APK"]);
  assert.deepEqual((await namesOf({ sort: "size", desc: true })).slice(0, 2).sort(), ["Alpha", "zeta"], "folders first in every order");
  assert.deepEqual(await namesOf({ filter: "APK" }), ["Big-new.APK"]);
  assert.deepEqual(await namesOf({ filter: "a", sort: "size", desc: true }), ["zeta", "Alpha", "Big-new.APK", "small-old.txt"]);
  assert.equal((await files.list({ path: sorted, filter: "md" })).total, 1);
  await assert.rejects(files.list({ path: sorted, sort: "colour" }), code("invalidData"));
  const bySize = [];
  for (let after; ;) {
    const page = await files.list({ path: many, sort: "size", desc: true, after, limit: 400 });
    bySize.push(...page.entries.map(e => e.name));
    if (!page.next) break;
    after = page.next;
  }
  assert.deepEqual([...bySize].sort(), [...names].sort(), "another order in pages: every entry once");
  assert.equal((await files.list({ path: many, filter: "file-11" })).entries.length, names.filter(n => n.includes("file-11")).length);
  await assert.rejects(files.list({ path: many, limit: PAGE + 1 }), code("invalidData"));
  console.log("ok: 1200 entries in three pages, none twice, none left out");

  // ---------- reading a piece at a time ----------
  const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
  await fsp.writeFile(at("big.bin"), big);
  const got = [];
  let first;
  for (let pos = 0; ;) {
    const r = await files.read({ path: at("big.bin"), pos, len: CHUNK, size: first?.size, mtime: first?.mtime });
    first ||= r;
    const piece = Buffer.from(r.data, "base64");
    got.push(piece);
    pos += piece.length;
    if (r.eof) break;
    assert.equal(piece.length, CHUNK);
  }
  assert.ok(Buffer.concat(got).equals(big), "the pieces are the file");
  await assert.rejects(files.read({ path: at("big.bin"), pos: 0, len: CHUNK + 1 }), code("invalidData"));
  await assert.rejects(files.read({ path: many, pos: 0, len: 10 }), code("notFile"));
  assert.deepEqual({ ...(await files.read({ path: at("big.bin"), pos: big.length, len: 10 })), size: 0, mtime: 0 }, { data: "", size: 0, mtime: 0, eof: true });
  await fsp.appendFile(at("big.bin"), "more");
  await assert.rejects(files.read({ path: at("big.bin"), pos: CHUNK, len: CHUNK, size: first.size, mtime: first.mtime }), code("changed"));
  console.log("ok: 5 MB read in pieces is the same bytes; a file that changed meanwhile is refused");

  // ---------- new folders and names ----------
  assert.equal((await files.mkdir({ path: at("new") })).path, at("new"));
  await assert.rejects(files.mkdir({ path: at("new") }), code("exists"));
  assert.equal((await files.mkdir({ path: at("new"), keep: true })).path, at("new (2)"));
  assert.equal((await files.mkdir({ path: at("new"), keep: true })).path, at("new (3)"));
  await assert.rejects(files.mkdir({ path: at("no", "such", "parent") }), code("folderMissing"));
  await fsp.writeFile(at("a.txt"), "A"); await fsp.writeFile(at("b.txt"), "B");
  await assert.rejects(files.rename({ from: at("a.txt"), to: at("b.txt") }), code("exists"));
  assert.equal(await fsp.readFile(at("b.txt"), "utf8"), "B", "nothing was written over");
  await files.rename({ from: at("a.txt"), to: at("new", "moved.txt") });
  assert.equal(await fsp.readFile(at("new", "moved.txt"), "utf8"), "A");
  await assert.rejects(files.rename({ from: at("new"), to: at("new", "inside") }), code("intoItself"));
  await assert.rejects(files.rename({ from: path.parse(work).root, to: at("drive") }), code("rootRefused"));
  console.log("ok: a new folder, a rename, a move - a taken name is refused or numbered, never written over");

  // ---------- copying a tree ----------
  const src = at("src");
  await fsp.mkdir(path.join(src, "deep", "er"), { recursive: true });
  await fsp.writeFile(path.join(src, "one.txt"), "1");
  await fsp.writeFile(path.join(src, "deep", "two.bin"), crypto.randomBytes(3 * 1024 * 1024));
  await fsp.writeFile(path.join(src, "deep", "er", ".three"), "3");
  let links = false;
  try {
    await fsp.symlink(src, path.join(src, "deep", "up"), "junction");          // a link to a folder it is inside
    await fsp.symlink(path.parse(src).root, path.join(src, "drive"), "junction"); // a link to the whole drive
    links = true;
  } catch { console.log("   (no links can be made here: the link checks are left out)"); }
  const before = (await tree(src)).filter(x => !x.startsWith("deep/up") && !x.startsWith("drive"));
  const c1 = await files.copy("A", { from: src, to: at("copy") });
  assert.equal(c1.to, at("copy"));
  const d1 = await finished(files, "A", c1.job);
  assert.equal(d1.state, "done", d1.error);
  assert.deepEqual(await tree(at("copy")), before, "the same tree, without what the links would have brought");
  assert.equal(d1.files, 3); assert.equal(d1.bytes, d1.total);
  if (links) assert.equal(d1.skipped, 2, "the link to its own parent and the link to the drive were not gone into");
  assert.ok(Buffer.compare(await fsp.readFile(at("copy", "deep", "two.bin")), await fsp.readFile(path.join(src, "deep", "two.bin"))) === 0);
  assert.deepEqual(events.map(e => [e.peer, e.name, e.data.state]), [["A", "files.job", "done"]], "its end is told to the one that began it");
  const c2 = await files.copy("A", { from: src, to: at("copy") });
  assert.equal(c2.to, at("copy (2)"), "a taken name is numbered");
  assert.equal((await finished(files, "A", c2.job)).state, "done");
  const c3 = await files.copy("A", { from: path.join(src, "one.txt"), to: at("copy", "one.txt") });
  assert.equal(c3.to, at("copy", "one (2).txt"), "a file keeps its extension");
  await finished(files, "A", c3.job);
  await assert.rejects(files.copy("A", { from: src, to: path.join(src, "deep", "again") }), code("intoItself"));
  const beside = await files.copy("A", { from: at("copy"), to: at("copy") });
  assert.equal(beside.to, at("copy (3)"), "a folder copied where it is gets a numbered name, as a file does");
  assert.equal((await finished(files, "A", beside.job)).state, "done");
  await files.remove({ path: at("copy (3)") });
  await assert.rejects(files.copy("A", { from: path.parse(src).root, to: at("drive-copy") }), code("rootRefused"));
  await assert.rejects(files.job("B", { job: c1.job }), code("jobMissing"), "a job is its peer's");
  assert.ok(!(await tree(work)).some(x => x.endsWith(PART)), "no unfinished file is left");
  console.log("ok: a tree copied whole, numbered beside a taken name, never into itself, a link never followed round");

  // ---------- a move across "volumes" is a copy and then the source goes ----------
  const m = await files.copy("A", { from: at("copy (2)"), to: at("moved"), move: true });
  assert.equal((await finished(files, "A", m.job)).state, "done");
  assert.deepEqual(await tree(at("moved")), before);
  assert.equal(fs.existsSync(at("copy (2)")), false);

  // ---------- a copy stopped ----------
  const heavy = at("heavy");
  await fsp.mkdir(heavy);
  for (let i = 0; i < 40; i++) await fsp.writeFile(path.join(heavy, `f${i}.bin`), Buffer.alloc(2 * 1024 * 1024, i));
  const c4 = await files.copy("A", { from: heavy, to: at("heavy-copy") });
  const c5 = await files.copy("A", { from: heavy, to: at("heavy-copy-b") });
  await assert.rejects(files.copy("A", { from: heavy, to: at("heavy-copy-c") }), code("tooManyJobs"));
  const stoppedJob = await files.cancel("A", { job: c4.job });
  assert.equal(stoppedJob.state, "cancelled");
  assert.equal(fs.existsSync(at("heavy-copy")), false, "a stopped copy leaves nothing where it was going");
  assert.equal((await tree(heavy)).length, 40, "and its source as it was");
  await files.cancel("A", { job: c5.job });
  console.log("ok: a stopped copy leaves nothing behind and does not touch its source; two at a time for a peer");

  // ---------- an upload ----------
  const body = crypto.randomBytes(CHUNK * 2 + 77);
  const up = await files.begin("A", { path: at("b.txt"), size: body.length });
  assert.equal(up.path, at("b (2).txt"), "a taken name is numbered");
  assert.equal(fs.existsSync(at("b (2).txt")), false, "it has no name until it is whole");
  await assert.rejects(files.write("A", { upload: up.upload, pos: 5, data: b64(body.subarray(0, 10)) }), code("invalidData"));
  await assert.rejects(files.write("B", { upload: up.upload, pos: 0, data: b64(body.subarray(0, 10)) }), code("jobMissing"));
  for (let pos = 0; pos < body.length; pos += CHUNK) await files.write("A", { upload: up.upload, pos, data: b64(body.subarray(pos, pos + CHUNK)) });
  assert.equal((await files.commit("A", { upload: up.upload })).path, at("b (2).txt"));
  assert.ok((await fsp.readFile(at("b (2).txt"))).equals(body));
  assert.equal(await fsp.readFile(at("b.txt"), "utf8"), "B");
  const short = await files.begin("A", { path: at("short.bin"), size: 100 });
  await files.write("A", { upload: short.upload, pos: 0, data: b64(Buffer.alloc(40)) });
  await assert.rejects(files.commit("A", { upload: short.upload }), code("invalidData"), "a file that is not whole is not named");
  await assert.rejects(files.write("A", { upload: short.upload, pos: 40, data: b64(Buffer.alloc(61)) }), code("invalidData"), "nor one longer than was said");
  const other = await files.begin("A", { path: at("other.bin"), size: 5 });
  await assert.rejects(files.begin("A", { path: at("third.bin"), size: 5 }), code("tooManyJobs"));
  await files.drop("A");                                            // the link dropped
  await assert.rejects(files.write("A", { upload: other.upload, pos: 0, data: b64(Buffer.alloc(5)) }), code("jobMissing"));
  assert.ok(!(await tree(work)).some(x => x.endsWith(PART) || x === "short.bin" || x === "other.bin"), "a dropped link leaves no unfinished file");
  console.log("ok: an upload is named only when whole; a dropped link takes its unfinished files");

  // ---------- deleting ----------
  await assert.rejects(files.remove({ path: path.parse(work).root }), code("rootRefused"));
  await assert.rejects(files.remove({ path: "~" }), code("rootRefused"));
  await assert.rejects(files.remove({ path: home }), code("rootRefused"));
  assert.equal(fs.existsSync(home), true);
  await assert.rejects(files.remove({ path: at("nothing") }), code("fileMissing"));
  assert.deepEqual(await files.remove({ path: at("moved") }), { trashed: false });
  assert.equal(fs.existsSync(at("moved")), false);
  if (links) {
    await files.remove({ path: path.join(src, "deep", "up") });
    assert.equal(fs.existsSync(path.join(src, "one.txt")), true, "a link goes, not what it leads to");
  }
  const binned = [];
  const withBin = createFiles({ home, trash: async f => { binned.push(f); } });
  assert.deepEqual(await withBin.remove({ path: at("b.txt") }), { trashed: true });
  assert.deepEqual(binned, [at("b.txt")]);
  assert.equal(fs.existsSync(at("b.txt")), true, "with a bin the file is the bin's to take");
  const noBin = createFiles({ home, trash: async () => { throw new Error("no bin on this drive"); } });
  await assert.rejects(noBin.remove({ path: at("b.txt") }), code("fileFailed"));
  assert.equal(fs.existsSync(at("b.txt")), true, "a bin that refuses is not a reason to delete for good");
  console.log("ok: a drive and the home are never deleted; the bin where there is one, and never past a bin that refused");
  await files.dispose();
}

// A real phone -> relay -> host: the methods are served, to a peer with control only, and a 1 MB file comes whole.
// What a review found and a test did not: two things going for one name, a move whose source cannot all go, another
// spelling of a path, and requests sent together.
async function hard(root) {
  const home = path.join(root, "users", "me"), work = path.join(root, "work");
  await fsp.mkdir(home, { recursive: true }); await fsp.mkdir(work);
  const at = (...p) => path.join(work, ...p);
  const files = createFiles({ home });
  const done = async (f, job) => finished(f, "A", job);

  // ---------- a move whose source cannot be removed ----------
  const src = at("src");
  await fsp.mkdir(path.join(src, "busy"), { recursive: true });
  for (const n of ["a.txt", "busy/x.txt", "z.txt"]) await fsp.writeFile(path.join(src, n), n);
  // The first file goes, then the removal fails - as with a folder some program still works in.
  const stubborn = createFiles({ home, rm: async p => { await fsp.rm(path.join(p, "a.txt")); throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });
  const m = await stubborn.copy("A", { from: src, to: at("moved"), move: true });
  const mEnd = await finished(stubborn, "A", m.job);
  assert.deepEqual([mEnd.state, mEnd.error], ["failed", "sourceLeft"]);
  assert.deepEqual(await tree(at("moved")), ["a.txt", "busy/", "busy/x.txt", "z.txt"], "the copy stays whole: part of the source is already gone");
  assert.equal(await fsp.readFile(at("moved", "a.txt"), "utf8"), "a.txt");
  await fsp.rm(at("moved"), { recursive: true }); await fsp.rm(src, { recursive: true });

  // What a copy skips is not copied, so a move must not take the source with it.
  let links = true;
  await fsp.mkdir(at("holed"));
  await fsp.writeFile(at("holed", "kept.txt"), "kept");
  try { await fsp.symlink(at("nowhere"), at("holed", "dangling"), "junction"); } catch { links = false; }
  if (links) {
    const h = await files.copy("A", { from: at("holed"), to: at("holed-moved"), move: true });
    const hEnd = await done(files, h.job);
    assert.deepEqual([hEnd.state, hEnd.error, hEnd.skipped], ["failed", "sourceLeft", 1]);
    assert.equal(fs.existsSync(at("holed", "dangling")) || fs.lstatSync(at("holed", "dangling")).isSymbolicLink(), true, "the source is whole");
    assert.equal(await fsp.readFile(at("holed", "kept.txt"), "utf8"), "kept");
    assert.equal(await fsp.readFile(at("holed-moved", "kept.txt"), "utf8"), "kept", "and what was copied stays too");
  }
  console.log("ok: a move that cannot remove all of its source keeps the copy; one that skipped something keeps the source");

  // ---------- two for one name ----------
  await fsp.mkdir(at("a")); await fsp.mkdir(at("b")); await fsp.mkdir(at("dst"));
  await fsp.writeFile(at("a", "report.txt"), "AAAA from a"); await fsp.writeFile(at("b", "report.txt"), "BBBB from b");
  const [ja, jb] = await Promise.all([
    files.copy("A", { from: at("a", "report.txt"), to: at("dst", "report.txt"), move: true }),
    files.copy("A", { from: at("b", "report.txt"), to: at("dst", "report.txt"), move: true })
  ]);
  assert.notEqual(ja.to, jb.to, "each got a name of its own at once");
  assert.equal((await done(files, ja.job)).state, "done"); assert.equal((await done(files, jb.job)).state, "done");
  assert.deepEqual((await Promise.all((await tree(at("dst"))).map(n => fsp.readFile(at("dst", n), "utf8")))).sort(), ["AAAA from a", "BBBB from b"], "both files are there");
  // A big copy is under way; someone makes a folder of its name, and a small one is moved to it.
  await fsp.mkdir(at("big"));
  for (let i = 0; i < 30; i++) await fsp.writeFile(at("big", `f${i}.bin`), Buffer.alloc(1024 * 1024, i));
  await fsp.mkdir(at("small", "big"), { recursive: true }); await fsp.writeFile(at("small", "big", "precious.txt"), "precious");
  const big = await files.copy("A", { from: at("big"), to: at("dst", "big") });
  await assert.rejects(files.mkdir({ path: at("dst", "big") }), code("exists"), "the name is the copy's from the start");
  const small = await files.copy("A", { from: at("small", "big"), to: at("dst", "big"), move: true });
  assert.equal(small.to, at("dst", "big (2)"));
  assert.equal((await done(files, small.job)).state, "done");
  await files.cancel("A", { job: big.job });
  assert.equal(await fsp.readFile(at("dst", "big (2)", "precious.txt"), "utf8"), "precious", "a stopped copy removes only what it made");
  // A name taken while an upload was coming is not written over when it is whole.
  const up = await files.begin("A", { path: at("dst", "up.txt"), size: 3 });
  await files.write("A", { upload: up.upload, pos: 0, data: Buffer.from("new").toString("base64") });
  await fsp.writeFile(at("dst", "up.txt"), "theirs");
  assert.equal((await files.commit("A", { upload: up.upload })).path, at("dst", "up (2).txt"));
  assert.equal(await fsp.readFile(at("dst", "up.txt"), "utf8"), "theirs");
  console.log("ok: two for one name both keep theirs; a stopped copy removes only its own; a late name is not written over");

  // ---------- limits, with requests sent together ----------
  const begun = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => files.begin("L", { path: at("dst", `u${i}.bin`), size: 1 })));
  assert.equal(begun.filter(x => x.status === "fulfilled").length, 2, "two uploads for a peer, however they are asked for");
  assert.ok(begun.filter(x => x.status === "rejected").every(x => x.reason.code === "tooManyJobs"));
  await files.drop("L");
  const copies = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => files.copy("L", { from: at("big"), to: at("dst", `c${i}`) })));
  assert.equal(copies.filter(x => x.status === "fulfilled").length, 2, "and two copies");
  for (const c of copies) if (c.status === "fulfilled") await files.cancel("L", { job: c.value.job });
  const again = await files.begin("L", { path: at("dst", "after.bin"), size: 1 });
  await files.abort("L", { upload: again.upload });
  console.log("ok: a peer's two uploads and two copies hold for requests sent together, and come free again");

  // ---------- other spellings of a path ----------
  await fsp.writeFile(at("foo"), "plain");
  let blank = true;
  try { await fsp.writeFile(at("foo "), "with a blank"); blank = (await fsp.readdir(work)).includes("foo "); } catch { blank = false; }
  if (blank) {
    assert.equal(Buffer.from((await files.read({ path: at("foo "), pos: 0, len: 100 })).data, "base64").toString(), "with a blank");
    await files.remove({ path: at("foo ") });
    assert.equal(await fsp.readFile(at("foo"), "utf8"), "plain", "a name that ends in a blank is not the name without it");
  } else console.log("   (no name can end in a blank here: that check is left out)");
  if (process.platform === "win32") {
    await assert.rejects(files.remove({ path: "\\\\?\\" + home }), code("invalidData"));
    await assert.rejects(files.stat({ path: "\\\\.\\" + work }), code("invalidData"));
  }
  await assert.rejects(files.remove({ path: path.dirname(home) }), code("rootRefused"), "what holds the home is not deleted either");
  assert.equal(fs.existsSync(home), true);
  if (links) {
    await fsp.symlink(home, at("home-link"), "junction");
    await files.remove({ path: at("home-link") });
    assert.equal(fs.existsSync(home), true, "a link to the home goes; the home stays");
    await fsp.mkdir(at("p")); await fsp.writeFile(at("p", "f.txt"), "f");
    await fsp.symlink(at("p"), at("p-link"), "junction");
    await assert.rejects(files.copy("A", { from: at("p-link"), to: at("p", "sub") }), code("intoItself"), "a folder under another spelling is still itself");
  }
  // Letters' case: the same file may be renamed; another file with that name may not be written over.
  await fsp.writeFile(at("notes.txt"), "lower");
  let twoCases = true;
  try { await fsp.writeFile(at("Notes.txt"), "upper", { flag: "wx" }); } catch { twoCases = false; }
  if (twoCases) {
    await assert.rejects(files.rename({ from: at("notes.txt"), to: at("Notes.txt") }), code("exists"));
    assert.equal(await fsp.readFile(at("Notes.txt"), "utf8"), "upper");
  } else {
    await files.rename({ from: at("notes.txt"), to: at("Notes.txt") });
    assert.ok((await fsp.readdir(work)).includes("Notes.txt"), "only the letters' case changed");
    assert.equal(await fsp.readFile(at("Notes.txt"), "utf8"), "lower");
  }
  await fsp.writeFile(at("r1.txt"), "one"); await fsp.writeFile(at("r2.txt"), "two");
  await assert.rejects(files.rename({ from: at("r1.txt"), to: at("r2.txt") }), code("exists"));
  await files.rename({ from: at("r1.txt"), to: at("r3.txt") });
  assert.deepEqual([fs.existsSync(at("r1.txt")), await fsp.readFile(at("r3.txt"), "utf8"), await fsp.readFile(at("r2.txt"), "utf8")], [false, "one", "two"]);
  assert.ok(!(await tree(work)).some(x => x.endsWith(PART)), "no unfinished file is left");
  console.log("ok: a blank at a name's end, a path round the names' rules, what holds the home, a link's other spelling, letters' case");
  await files.dispose(); await stubborn.dispose();
}

async function served(root) {
  const work = path.join(root, "served");
  await fsp.mkdir(work);
  const body = crypto.randomBytes(1024 * 1024 + 5);
  await fsp.writeFile(path.join(work, "app.apk"), body);
  await withPhone(async ({ call, phone, host, node }) => {
    const info = await phone.request(host.self().id, "host.info", {});
    assert.equal(info.files, 1); assert.equal(info.trash, 0);
    const listed = await call("files.list", { path: work });
    assert.deepEqual(listed.entries.map(e => [e.name, e.size]), [["app.apk", body.length]]);
    const got = [];
    let first;
    for (let pos = 0; ;) {
      const r = await call("files.read", { path: path.join(work, "app.apk"), pos, len: CHUNK, size: first?.size, mtime: first?.mtime });
      first ||= r;
      got.push(Buffer.from(r.data, "base64"));
      pos += got.at(-1).length;
      if (r.eof) break;
    }
    assert.ok(Buffer.concat(got).equals(body), "through the relay the pieces are the file");
    const up = await call("files.begin", { path: path.join(work, "from-phone.bin"), size: body.length });
    for (let pos = 0; pos < body.length; pos += CHUNK) await call("files.write", { upload: up.upload, pos, data: b64(body.subarray(pos, pos + CHUNK)) });
    await call("files.commit", { upload: up.upload });
    assert.ok((await fsp.readFile(path.join(work, "from-phone.bin"))).equals(body));
    await assert.rejects(call("files.read", { path: path.join(work, "gone"), pos: 0, len: 10 }), code("fileMissing"));
    await call("files.mkdir", { path: path.join(work, "made") });
    await call("files.rename", { from: path.join(work, "made"), to: path.join(work, "named") });
    const job = await call("files.copy", { from: path.join(work, "named"), to: path.join(work, "copied") });
    await waitFor(async () => (await call("files.job", { job: job.job })).state === "done", "the copy ends on the host");
    assert.deepEqual(await call("files.delete", { path: path.join(work, "copied") }), { trashed: false });
    assert.equal(fs.existsSync(path.join(work, "copied")), false);

    // An upload left unfinished goes with the phone's link.
    const left = await call("files.begin", { path: path.join(work, "left.bin"), size: 10 });
    assert.equal(fs.existsSync(left.path + PART), true);
    phone.stop();
    await waitFor(() => !fs.existsSync(left.path + PART), "the unfinished upload goes with the link");

    // A host that only holds resources is paired, and is not served the files.
    const resource = await node("resource", { kind: "host" });
    await resource.pair("127.0.0.1", host.self().port, host.self().code);
    await waitFor(() => resource.online(host.self().id), "resource host -> desktop");
    await assert.rejects(resource.call(host.self().id, "files.list", { path: work }));
  }, { host: { home: path.join(root, "home") } });
  console.log("ok: real phone -> relay -> host: listed, read whole, uploaded, changed; cleaned up with the link; refused to a resource host");
}

// A file of the host offered to a phone (src/host/file-offers.js, docs/FILES.md 3.6), through the same real phone ->
// relay -> host: the offer reaches the phone it was made to as a "files.offer" event; its answers are taken, in order
// only; another phone's, and one for an offer that is unknown, withdrawn or expired, are refused (jobMissing); an
// offer nobody answers says "noAnswer" yet stays answerable until it expires; an accepted one fails with the link.
async function offered(root) {
  const work = path.join(root, "offered");
  await fsp.mkdir(work);
  const body = crypto.randomBytes(300 * 1024 + 9);
  const file = path.join(work, "report.pdf");
  await fsp.writeFile(file, body);
  const ANSWER_MS = 300, EXPIRE_MS = 1200;
  await withPhone(async ({ phone, host, served, pairPhone, relay }) => {
    const hostId = host.self().id;
    const heard = [], seen = [];
    phone.on("notify", n => { if (n.event === "files.offer") heard.push(n); });
    served.offers.on("change", v => seen.push(`${v.name}:${v.state}${v.noAnswer ? "/noAnswer" : ""}${v.error ? `/${v.error}` : ""}`));
    const other = await pairPhone("Another phone");
    const otherHeard = [];
    other.on("notify", n => { if (n.event === "files.offer") otherHeard.push(n); });
    const answer = (p, offer, state, extra = {}) => p.request(hostId, "files.answer", { offer, state, ...extra }, { timeout: 10000 });
    const phoneId = phone.id;

    // ---------- the offer reaches the phone it was made to ----------
    const o = await served.offers.make(phoneId, { path: file });
    assert.equal(o.state, "waiting");
    await waitFor(() => heard.length === 1, "the offer reaches the phone");
    assert.equal(heard[0].node, hostId, "from the host");
    assert.deepEqual({ ...heard[0].payload, mtime: 0 }, { offer: o.offer, path: file, name: "report.pdf", size: body.length, mtime: 0 });
    assert.ok(heard[0].payload.mtime > 0, "with the file's time, for the download's first piece");
    assert.equal(otherHeard.length, 0, "the other phone hears nothing of it");

    // ---------- answers: only the phone's, only in order ----------
    await assert.rejects(answer(other, o.offer, "accepted"), code("jobMissing"), "another phone's answer is refused");
    await assert.rejects(answer(phone, "no-such-offer", "accepted"), code("jobMissing"), "an unknown offer is refused");
    await assert.rejects(answer(phone, o.offer, "done"), code("invalidData"), "done before accepted is refused");
    await assert.rejects(answer(phone, o.offer, "maybe"), code("invalidData"));
    assert.equal(await answer(phone, o.offer, "accepted"), true);
    await assert.rejects(answer(phone, o.offer, "declined"), code("invalidData"), "an accepted offer is not declined");
    // The phone pulls it with the existing download (here: by hand), then says so.
    const first = await phone.request(hostId, "files.read", { path: file, pos: 0, len: CHUNK, size: heard[0].payload.size, mtime: heard[0].payload.mtime });
    assert.equal(first.size, body.length);
    assert.equal(await answer(phone, o.offer, "done"), true);
    await assert.rejects(answer(phone, o.offer, "done"), code("jobMissing"), "an offer that ended is not answered again");
    assert.equal(served.offers.get(o.offer).state, "done");

    // ---------- declined, failed with a code, a folder, a computer ----------
    const d = await served.offers.make(phoneId, { path: file });
    await answer(phone, d.offer, "declined");
    const f = await served.offers.make(phoneId, { path: file });
    await answer(phone, f.offer, "failed", { error: "needsApp" });
    assert.equal(served.offers.get(f.offer).error, "needsApp");
    const g = await served.offers.make(phoneId, { path: file });
    await answer(phone, g.offer, "failed", { error: "<script>" });
    assert.equal(served.offers.get(g.offer).error, "fileFailed", "an error that is not a plain code is not passed on");
    await assert.rejects(served.offers.make(phoneId, { path: work }), code("notFile"), "a folder is not offered");
    await assert.rejects(served.offers.make(phoneId, { path: path.join(work, "gone.bin") }), code("fileMissing"));
    await assert.rejects(served.offers.make(relay.self().id, { path: file }), code("offline"), "only a phone is offered files");
    await assert.rejects(served.offers.make("someone-unknown", { path: file }), code("offline"));
    const w = await served.offers.make(phoneId, { path: file });
    assert.equal(served.offers.withdraw(w.offer), true);
    await assert.rejects(answer(phone, w.offer, "accepted"), code("jobMissing"), "a withdrawn offer is not taken");
    console.log("ok: an offer reaches the phone it was made to; its answers are taken in order; another phone's, an unknown and a withdrawn one are refused");

    // ---------- nobody answers ----------
    const quiet = await served.offers.make(phoneId, { path: file });
    await waitFor(() => served.offers.get(quiet.offer)?.noAnswer, "no answer within answerMs", 3000);
    assert.equal(served.offers.get(quiet.offer).state, "waiting", "no answer yet is not an end");
    const late = await served.offers.make(phoneId, { path: file });
    await waitFor(() => served.offers.get(late.offer)?.noAnswer, "the late one says no answer too", 3000);
    assert.equal(await answer(phone, late.offer, "accepted"), true, "a late answer before the offer expires is taken");
    assert.equal(served.offers.get(late.offer).noAnswer, false);
    await waitFor(() => served.offers.get(quiet.offer)?.state === "expired", "the unanswered offer expires", 5000);
    await assert.rejects(answer(phone, quiet.offer, "accepted"), code("jobMissing"), "an expired offer is not taken");
    await new Promise(r => setTimeout(r, EXPIRE_MS + 200));
    assert.equal(served.offers.get(late.offer).state, "accepted", "an accepted offer does not expire while it downloads");

    // ---------- the phone's link drops ----------
    phone.stop();
    await waitFor(() => served.offers.get(late.offer)?.state === "failed", "an accepted offer fails with the link");
    assert.equal(served.offers.get(late.offer).error, "offline");
    await assert.rejects(served.offers.make(phoneId, { path: file }), code("offline"), "a phone that is not linked is not offered anything");
    assert.deepEqual(seen.filter(x => !x.startsWith("report.pdf:waiting")).slice(0, 6), ["report.pdf:accepted", "report.pdf:done", "report.pdf:declined", "report.pdf:failed/needsApp", "report.pdf:failed/fileFailed", "report.pdf:withdrawn"], "every step is told to the computer");
    console.log("ok: no answer is said after a while yet stays answerable; an unanswered offer expires; an accepted one fails with the link");
  }, { host: { home: path.join(root, "home") }, served: { offerTimes: { answerMs: ANSWER_MS, expireMs: EXPIRE_MS } } });
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdeck-files-"));
  try {
    await alone(root);
    await hard(path.join(root, "hard"));
    await served(root);
    await offered(root);
    console.log("files: all checks passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
