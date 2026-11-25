// The phone's half of a computer's files (mobile/src/files.js, docs/FILES.md 5), without a phone: the app's logic runs
// in Node over the real phone provider (provider-relay.js with `ws`), through an encrypted relay, to a real host
// serving src/host/files.js (scripts/phone-test-rig.js) - its home and everything it touches in a temporary folder.
//
// The native side is a FAKE `Files` plugin over a temporary "phone" folder, behind exactly the contract of
// FILES.md 5.1: begin({ name, size, keep }) -> { file } (keep: Downloads, a taken name gets " (2)"; else a temporary
// file), write({ file, data }) (base64, at most 256 KB, appended, one at a time), finish({ file }) -> { shown },
// open({ file, type }) for a finished temporary file, cancel({ file }) removes an unfinished one (a file it does not
// know resolves; a finished one in Downloads is only forgotten). As the real plugin, the size is strict (a write past
// it and a short finish are refused: `sizeMismatch`), and a dismissed iPhone export sheet makes finish answer
// `cancelled` with the file left to cancel. Every call answers later, as a bridge does. It notes every breach of the
// contract by the page (two writes at once, a piece too big, more than the size said, a write after finish or cancel,
// a short finish): none may be left at the end. It can be told that it keeps no files on this phone (`noKeep`, an
// Android older than 10) and that no viewer opens a file (`failOpen`). The provider is
// wrapped to see each request, to count the pieces in flight, to make the host answer `crossDevice` once, and to be a
// link that goes: a request that never reaches the host (once), one whose answer is lost on the way back (lose), one
// that is answered by nobody (stall); the real link is also closed and made again (phone.stop() / start()).
//
// Checked: a multi-megabyte download arrives byte for byte, one piece in flight, with the first piece's size and time
// handed back on every later one; a file changed mid-download (same size, another time) stops with `changed` and
// leaves nothing on the phone; an upload arrives byte for byte, one piece in flight, and never writes over (a taken
// name gets "name (2)"), an empty one too; an upload whose phone file fails midway, or that is stopped, leaves no
// `.agentdeck-part` and no file; rename (with "name (2)" offered on `exists`, and declined), copy and move of a tree as
// jobs, a move to another drive as a copy that removes the source, a move into its own folder changes nothing, a copy
// followed no longer goes on there, new folders, delete; a long folder a page at a time with every entry once, also
// when "load more" is pressed twice at once; text, markdown and a picture looked at, a text over the cap refused before
// a byte is read; a PDF opened through the plugin; without the plugin nothing is downloaded and the screen's choices
// say so; an older computer ("update it there"); the pure helpers (paths, names, kinds, the breadcrumb). A file the
// computer sends (docs/FILES.md 3.6, takeOffer): saved byte for byte with "accepted" told before anything is read and
// "done" after; Not now - "declined", nothing read; no plugin - "failed" needsApp, nothing read; a file that changed
// on the way, or since it was offered - "failed" changed, nothing on the phone; an offer taken back - nothing read;
// what the event may carry (checkOffer). The order and the search (files.list sort / desc / filter): the six orders
// with folders first, a search by name whatever the case, paging under another order (every entry once, the same order
// asked for each page), a new order starting from the first page, a computer without `total` not taken for sorting.
// A link that goes: a download and an upload go on from the piece that was lost (not reached, or its answer lost -
// nothing written twice), a link closed for real mid-download and mid-upload (the host forgets the upload: it begins
// again), a commit whose answer was lost, a link that never comes back gives up after a few tries, Stop on a request
// nobody answers ends at once. A computer that lies: a size that is no size, more bytes than the size, a size that
// changes, never "eof", another size than the offer's - nothing past the size reaches the plugin and nothing stays. A
// PDF no viewer opens leaves no temporary file. Names that turn the text round are no offer. A plugin that keeps no
// files: no download is read, a PDF opens, an offer hears "failed" and never "accepted".
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { withPhone, waitFor } = require("./phone-test-rig");
const { PART } = require("../src/host/files");

const KB = 1024, MB = 1024 * KB;
const code = c => ({ code: c });

// ---------- the fake plugin ----------
function fakePlugin(dir) {
  const files = new Map(), breaches = [], opened = [];
  let n = 0, writing = false;
  const later = () => new Promise(r => setImmediate(r));
  const breach = text => { breaches.push(text); throw Object.assign(new Error(text), { code: "breach" }); };
  const free = (where, name) => {
    const { name: base, ext } = path.parse(name);
    let file = path.join(where, name);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(where, `${base} (${i})${ext}`);
    return file;
  };
  const plugin = {
    files, breaches, opened, onWrite: null,
    async begin({ name, size, keep }) {
      await later();
      if (typeof name !== "string" || !name || /[\\/]/.test(name)) breach(`begin: the name ${JSON.stringify(name)}`);
      if (!Number.isSafeInteger(size) || size < 0) breach(`begin: the size ${size}`);
      const where = path.join(dir, keep ? "Downloads" : "tmp");
      fs.mkdirSync(where, { recursive: true });
      const file = keep ? free(where, name) : path.join(where, `${++n}-${name}`);
      fs.writeFileSync(file, Buffer.alloc(0));
      const id = `file-${++n}`;
      files.set(id, { id, path: file, size, keep, written: 0, state: "open" });
      return { file: id };
    },
    async write({ file, data }) {
      if (writing) breach("two writes at once");
      writing = true;
      try {
        await later();
        const f = files.get(file);
        if (!f || f.state !== "open") breach(`write to a file that is ${f?.state || "not there"}`);
        const buf = Buffer.from(data, "base64");
        if (!buf.length || buf.length > 256 * KB) breach(`a write of ${buf.length} bytes`);
        if (f.written + buf.length > f.size) { breaches.push("more bytes than begin said"); throw Object.assign(new Error("past the size"), { code: "sizeMismatch" }); }
        fs.appendFileSync(f.path, buf);
        f.written += buf.length;
        plugin.onWrite?.(f);
        return {};
      } finally { writing = false; }
    },
    async finish({ file }) {
      await later();
      const f = files.get(file);
      if (!f || f.state !== "open") breach(`finish of a file that is ${f?.state || "not there"}`);
      if (f.written !== f.size) { breaches.push(`finish after ${f.written} of ${f.size} bytes`); throw Object.assign(new Error("short"), { code: "sizeMismatch" }); }
      if (plugin.dismiss) { // the iPhone's export sheet put away: refused, and the file stays finished
        plugin.dismiss = false;
        f.state = "finished";
        f.dismissed = true;
        throw Object.assign(new Error("dismissed"), { code: "cancelled" });
      }
      f.state = "finished";
      return { shown: path.basename(f.path) };
    },
    async open({ file, type }) {
      await later();
      const f = files.get(file);
      if (!f || f.state !== "finished" || f.keep) breach("open of a file that is not a finished temporary one");
      if (plugin.failOpen) { // no app on the phone opens it
        const c = plugin.failOpen;
        plugin.failOpen = "";
        throw Object.assign(new Error(c), { code: c });
      }
      opened.push({ path: f.path, type });
      return {};
    },
    // As the real one: a file it does not know (or removed already) resolves; a finished one in Downloads is only
    // forgotten (it is the user's now), any other is removed.
    async cancel({ file }) {
      await later();
      const f = files.get(file);
      if (!f || f.state === "cancelled" || f.state === "forgotten") return {};
      if (f.state === "finished" && f.keep && !f.dismissed) { f.state = "forgotten"; return {}; }
      fs.rmSync(f.path, { force: true });
      f.state = "cancelled";
      return {};
    }
  };
  return plugin;
}

// ---------- the provider, watched ----------
// Every request noted; the pieces (files.read / files.write) in flight counted; once(method, code): that method's next
// request is answered with that code without reaching the host. lose(method, code): that method's next request
// reaches the host, which does what it asks, and its answer is lost - the phone gets that code. stall(method): that
// method's next request reaches nobody and is not answered - -> { asked (a promise: it was sent), release() (it
// ends with "timeout", as the link's own timer would end it) }.
function watched(phone) {
  const calls = [], once = new Map(), lost = new Map(), stalled = new Map();
  const gone = c => Object.assign(new Error(c), { code: c });
  let inFlight = 0, most = 0;
  return {
    calls, once,
    get most() { return most; },
    reset() { calls.length = 0; most = 0; },
    lose(method, c = "timeout") { lost.set(method, c); },
    stall(method) {
      const s = { release: () => {} };
      s.asked = new Promise(resolve => { s.sent = resolve; });
      stalled.set(method, s);
      return s;
    },
    request(node, method, params, opts) {
      calls.push({ method, params });
      if (once.has(method)) {
        const c = once.get(method);
        once.delete(method);
        return Promise.reject(gone(c));
      }
      if (stalled.has(method)) {
        const s = stalled.get(method);
        stalled.delete(method);
        return new Promise((_, reject) => { s.release = () => reject(gone("timeout")); s.sent(); });
      }
      const piece = method === "files.read" || method === "files.write";
      if (piece) most = Math.max(most, ++inFlight);
      const sent = phone.request(node, method, params, opts).finally(() => { if (piece) inFlight--; });
      if (!lost.has(method)) return sent;
      const c = lost.get(method);
      lost.delete(method);
      return sent.then(() => { throw gone(c); }, () => { throw gone(c); });
    },
    on: (...a) => phone.on(...a),
    online: id => phone.online(id)
  };
}

async function partsIn(dir) {
  const out = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    if (d.name.endsWith(PART)) out.push(path.join(dir, d.name));
    if (d.isDirectory()) out.push(...(await partsIn(path.join(dir, d.name))));
  }
  return out;
}

(async () => {
  const F = await import(pathToFileURL(path.join(__dirname, "../mobile/src/files.js")).href);
  const { createRemoteFiles, entryPath, CHUNK, TEXT_MAX } = F;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentdeck-mobile-files-"));
  const home = path.join(root, "home"), work = path.join(root, "work"), phoneDir = path.join(root, "phone");
  for (const d of [home, work, phoneDir]) await fsp.mkdir(d);
  const at = (...p) => path.join(work, ...p);

  try {
    // ---------- the pure helpers ----------
    assert.equal(F.join("", "\\", "C:\\"), "C:\\", "in the roots an entry's name is its path");
    assert.equal(F.join("C:\\", "\\", "Work"), "C:\\Work");
    assert.equal(F.join("/", "/", "home"), "/home");
    assert.equal(F.join("/home/a", "/", "b.txt"), "/home/a/b.txt");
    assert.equal(F.numbered("app.apk", 2), "app (2).apk");
    assert.equal(F.numbered("archive.tar.gz", 3), "archive.tar (3).gz");
    assert.equal(F.numbered("my.folder", 2, true), "my.folder (2)", "a folder's name has no extension to keep");
    assert.equal(F.numbered(".gitignore", 2), ".gitignore (2)");
    assert.deepEqual(F.crumbs("D:\\Work\\AgentDeck", "\\"), [{ name: "D:", path: "D:\\" }, { name: "Work", path: "D:\\Work" }, { name: "AgentDeck", path: "D:\\Work\\AgentDeck" }]);
    assert.deepEqual(F.crumbs("C:\\", "\\"), [{ name: "C:", path: "C:\\" }]);
    assert.deepEqual(F.crumbs("/home/a", "/"), [{ name: "/", path: "/" }, { name: "home", path: "/home" }, { name: "a", path: "/home/a" }]);
    assert.deepEqual(F.crumbs("\\\\srv\\share\\x", "\\").map(c => c.path), ["\\\\srv\\share\\", "\\\\srv\\share\\x"]);
    assert.deepEqual(F.crumbs("", "\\"), []);
    assert.deepEqual(["README.md", "notes.TXT", "Makefile", ".env", "a.png", "b.pdf", "app.apk", "LICENSE"].map(F.kindOf),
      ["markdown", "text", "text", "text", "image", "pdf", "other", "text"]);
    for (const bad of ["", " ", ".", "..", "a/b", "a\\b"]) assert.throws(() => F.checkName(bad), code("badName"));
    assert.equal(F.bytesText(412), "412 B");
    assert.equal(F.bytesText(48.2 * MB), "48 MB");
    assert.equal(F.bytesText(3.4 * KB), "3.4 KB");
    assert.equal(F.filesOutdated({ error: { code: "unknownMethod" } }), true);
    assert.equal(F.filesOutdated({ info: { terminals: 2 } }), true, "a host.info without files: an older AgentDeck");
    assert.equal(F.filesOutdated({ info: { files: 1 } }), false);
    assert.equal(F.filesOutdated({}), false, "not known yet is not outdated");
    console.log("ok: paths, names, kinds, the breadcrumb, sizes, an older computer");

    await withPhone(async ({ phone, host, served }) => {
      const id = host.self().id;
      const net = watched(phone);
      const plugin = fakePlugin(phoneDir);
      const files = createRemoteFiles({ provider: net, node: id, plugin });
      const reads = (file = null) => net.calls.filter(c => c.method === "files.read" && (!file || c.params.path === file));
      assert.equal(files.canDownload, true);
      assert.equal((await phone.request(id, "host.info", {})).files, 1);
      const home0 = await files.folder("~");
      assert.equal(home0.path, home, "~ is the host's home - the temporary one");

      // ---------- a download, byte for byte ----------
      const big = crypto.randomBytes(5 * MB + 123);
      await fsp.writeFile(at("app.apk"), big);
      const listing = await files.folder(work);
      const apk = listing.entries.find(e => e.name === "app.apk");
      const progress = [];
      net.reset();
      const got = await files.download(entryPath(listing, apk), apk.name, { onProgress: p => progress.push(p) });
      assert.equal(got.shown, "app.apk");
      assert.ok((await fsp.readFile(path.join(phoneDir, "Downloads", "app.apk"))).equals(big), "the download is the file, byte for byte");
      const r = reads();
      assert.equal(r.length, Math.ceil(big.length / CHUNK));
      assert.equal(r[0].params.size, undefined, "the first piece is asked for without a size");
      assert.ok(r.slice(1).every(c => c.params.size === big.length && c.params.mtime === apk.mtime), "every later piece hands back the first one's size and time");
      assert.deepEqual(r.map(c => c.params.pos), r.map((_, i) => i * CHUNK), "piece after piece, none twice");
      assert.equal(net.most, 1, "one piece in flight");
      assert.deepEqual(progress.at(-1), { bytes: big.length, total: big.length });
      const again = await files.download(entryPath(listing, apk), apk.name);
      assert.equal(again.shown, "app (2).apk", "a name taken in Downloads is the plugin's to number");
      const empty = at("empty.log");
      await fsp.writeFile(empty, "");
      assert.equal((await files.download(empty, "empty.log")).size, 0);
      assert.equal((await fsp.stat(path.join(phoneDir, "Downloads", "empty.log"))).size, 0, "an empty file comes as an empty file");
      console.log(`ok: ${(big.length / MB).toFixed(1)} MB downloaded byte for byte in ${r.length} pieces, one in flight, size and time handed back`);

      // ---------- a file that changes while it comes ----------
      // The same size and another time, made from inside the plugin's write - so only the host, told the first size
      // and time, can tell.
      const changing = at("changing.bin");
      await fsp.writeFile(changing, crypto.randomBytes(2 * MB));
      let changed = false;
      plugin.onWrite = f => {
        if (changed || f.written < 2 * CHUNK) return;
        changed = true;
        fs.writeFileSync(changing, crypto.randomBytes(2 * MB));
        const later = new Date(Date.now() + 120000);
        fs.utimesSync(changing, later, later);
      };
      await assert.rejects(files.download(changing, "changing.bin"), code("changed"));
      plugin.onWrite = null;
      assert.ok(changed);
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "changing.bin")), false, "nothing of a changed file stays on the phone");
      assert.equal([...plugin.files.values()].find(f => f.path.endsWith("changing.bin"))?.state, "cancelled");
      // A file that is not there leaves nothing either: the plugin's file is begun only once the first piece came.
      const before = plugin.files.size;
      await assert.rejects(files.download(at("nothing.bin"), "nothing.bin"), code("fileMissing"));
      assert.equal(plugin.files.size, before);
      // Stop: the unfinished file goes.
      const stop = new AbortController();
      await assert.rejects(files.download(entryPath(listing, apk), "stopped.apk", { signal: stop.signal, onProgress: p => { if (p.bytes >= CHUNK) stop.abort(); } }), code("cancelled"));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "stopped.apk")), false, "a stopped download leaves nothing");
      // An iPhone's "Save to Files" sheet put away: finish answers `cancelled`, and the finished file is cancelled.
      plugin.dismiss = true;
      await assert.rejects(files.download(empty, "dismissed.log"), code("cancelled"));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "dismissed.log")), false, "a dismissed save leaves nothing");
      console.log("ok: a file changed mid-download stops with `changed` and leaves nothing; so do a missing file and Stop");

      // ---------- a link that goes while a file comes ----------
      const downloaded = name => fsp.readFile(path.join(phoneDir, "Downloads", name));
      const stateOf = name => [...plugin.files.values()].filter(f => path.basename(f.path) === name).at(-1)?.state;
      // A piece that never reached the computer, and one whose answer was lost: each is asked for again at the same
      // place, with the same size and time, and is written on the phone once.
      let cut = 0;
      plugin.onWrite = f => {
        if (f.written === 2 * CHUNK && cut === 0) { cut = 1; net.once.set("files.read", "offline"); }
        if (f.written === 4 * CHUNK && cut === 1) { cut = 2; net.lose("files.read", "timeout"); }
      };
      net.reset();
      await files.download(entryPath(listing, apk), "resumed.apk");
      plugin.onWrite = null;
      assert.equal(cut, 2);
      assert.ok((await downloaded("resumed.apk")).equals(big), "a download whose link went twice is the file, byte for byte");
      const asked = reads().map(c => c.params.pos);
      assert.equal(asked.filter(x => x === 2 * CHUNK).length, 2, "the piece that did not reach the computer is asked for again");
      assert.equal(asked.filter(x => x === 4 * CHUNK).length, 2, "and so is the one whose answer was lost");
      assert.equal(asked.length, Math.ceil(big.length / CHUNK) + 2, "no other piece is asked for twice");
      assert.ok(reads().slice(1).every(c => c.params.size === big.length && c.params.mtime === apk.mtime), "a piece asked again names the same file");
      assert.equal(net.most, 1, "one piece in flight, also when one is asked again");
      // The link closed for real and made again, in the middle.
      let dropped = false;
      await files.download(entryPath(listing, apk), "relinked.apk", { onProgress: p => { if (!dropped && p.bytes >= 3 * CHUNK) { dropped = true; phone.stop(); phone.start(); } } });
      assert.ok(dropped);
      assert.ok((await downloaded("relinked.apk")).equals(big), "a download goes on once the link is made again");
      // A link that stays gone: a few tries, then the failure the piece had, and nothing on the phone.
      const dead = { ...net, request: (n, m, p, o) => (m === "files.read" && p.pos >= CHUNK ? Promise.reject(Object.assign(new Error("closed"), { code: "closed" })) : net.request(n, m, p, o)) };
      net.reset();
      await assert.rejects(createRemoteFiles({ provider: dead, node: id, plugin }).download(entryPath(listing, apk), "never.apk"), code("closed"));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "never.apk")), false, "a download that gave up leaves nothing");
      assert.equal(stateOf("never.apk"), "cancelled");
      // The store's way of waiting for the computer is used when it is handed in, and "not back in time" ends the wait.
      const waits = [];
      const waited = createRemoteFiles({ provider: dead, node: id, plugin, whenOnline: ms => { waits.push(ms); return Promise.reject(Object.assign(new Error("offline"), { code: "offline" })); } });
      await assert.rejects(waited.download(entryPath(listing, apk), "waited.apk"), code("closed"), "the failure is the piece's, not the wait's");
      assert.equal(waits.length, 1, "a computer that did not come back is not asked again");
      assert.ok(waits[0] > 0);
      // Stop while a piece is asked for and nobody answers: at once, not after the link's minute.
      let hung = net.stall("files.read");
      let halting = new AbortController();
      let stalledAt = 0;
      const stuck = files.download(entryPath(listing, apk), "stalled.apk", { signal: halting.signal });
      hung.asked.then(() => { stalledAt = Date.now(); halting.abort(); });
      await assert.rejects(stuck, code("cancelled"));
      assert.ok(stalledAt && Date.now() - stalledAt < 1000, "Stop does not wait for the answer");
      hung.release();
      plugin.onWrite = f => { if (f.written === CHUNK && path.basename(f.path) === "stalled-mid.apk") hung = net.stall("files.read"); };
      halting = new AbortController();
      const stuckMid = files.download(entryPath(listing, apk), "stalled-mid.apk", { signal: halting.signal, onProgress: p => { if (p.bytes === CHUNK) hung.asked.then(() => { stalledAt = Date.now(); halting.abort(); }); } });
      await assert.rejects(stuckMid, code("cancelled"));
      plugin.onWrite = null;
      assert.ok(Date.now() - stalledAt < 1000, "nor in the middle of a file");
      hung.release();
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "stalled-mid.apk")), false, "what had come of it is removed");
      assert.equal(stateOf("stalled-mid.apk"), "cancelled");
      console.log("ok: a download goes on after a piece that was lost, after its answer was lost and after the link was made again; gives up after a few tries; Stop does not wait for a stalled piece");

      // ---------- a computer that lies about the file ----------
      // What the first answer says is checked, and nothing past the size it gave is handed to the plugin.
      const lying = answer => createRemoteFiles({ provider: { request: (n, m, p, o) => (m === "files.read" ? Promise.resolve(answer(p)) : phone.request(n, m, p, o)), on: () => () => {}, online: () => true }, node: id, plugin });
      const piece = Buffer.alloc(CHUNK, 7).toString("base64");
      const filesBefore = plugin.files.size;
      for (const size of [1.5, -1, "5", 2 ** 60, undefined, null]) {
        await assert.rejects(lying(() => ({ data: "", size, mtime: 1, eof: true })).download("/x/liar.bin", "liar.bin"), code("fileFailed"), `a size of ${size}`);
      }
      assert.equal(plugin.files.size, filesBefore, "a size that is no size begins no file on the phone");
      // Never "eof", and more than it said.
      let fed = 0;
      await assert.rejects(lying(() => { fed++; return { data: piece, size: CHUNK + 10, mtime: 1, eof: false }; }).download("/x/endless.bin", "endless.bin"), code("changed"));
      assert.equal(fed, 2, "a computer that never says eof is asked no more once the size is passed");
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "endless.bin")), false, "and nothing of it stays");
      assert.equal(stateOf("endless.bin"), "cancelled");
      // Another size in a later answer.
      await assert.rejects(lying(p => ({ data: piece, size: p.pos ? 9 * CHUNK : 3 * CHUNK, mtime: 1, eof: false })).download("/x/growing.bin", "growing.bin"), code("changed"));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "growing.bin")), false);
      // "eof" before the size was reached.
      await assert.rejects(lying(() => ({ data: piece, size: 3 * CHUNK, mtime: 1, eof: true })).download("/x/short.bin", "short.bin"), code("changed"));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "short.bin")), false);
      // Looked at here: no more than the cap is ever held, whatever comes.
      fed = 0;
      await assert.rejects(lying(() => { fed++; return { data: piece, size: TEXT_MAX, mtime: 1, eof: false }; }).preview("/x/endless.txt", { name: "endless.txt", size: 10 }), code("tooBigToView"));
      assert.equal(fed, TEXT_MAX / CHUNK + 1, "the reading stops at the cap");
      fed = 0;
      await assert.rejects(lying(() => { fed++; return { data: piece, size: 100, mtime: 1, eof: false }; }).preview("/x/small.txt", { name: "small.txt", size: 100 }), code("changed"));
      assert.equal(fed, 1, "a piece bigger than the file is not kept");
      assert.equal(plugin.breaches.length, 0, "nothing past a size reached the plugin");
      console.log("ok: a computer that lies about a size, never ends the file or changes it midway is stopped, and nothing stays");

      // ---------- uploads ----------
      const up = at("up");
      await fsp.mkdir(up);
      await fsp.writeFile(path.join(up, "photo.jpg"), "the one that was there");
      const body = crypto.randomBytes(MB + 300 * KB + 7);
      net.reset();
      const sent = [];
      const put = await files.upload(up, listing.sep, new Blob([body]), "photo.jpg", { onProgress: p => sent.push(p) });
      assert.equal(put.path, path.join(up, "photo (2).jpg"), "a taken name is not written over: name (2)");
      assert.ok((await fsp.readFile(put.path)).equals(body), "the upload is the file, byte for byte");
      assert.equal(await fsp.readFile(path.join(up, "photo.jpg"), "utf8"), "the one that was there", "the file that was there is as it was");
      assert.equal(net.most, 1, "one piece in flight");
      assert.equal(net.calls.filter(c => c.method === "files.write").length, Math.ceil(body.length / CHUNK));
      assert.deepEqual(sent.at(-1), { bytes: body.length, total: body.length });
      assert.equal((await files.upload(up, listing.sep, new Blob([]), "empty.txt")).path, path.join(up, "empty.txt"));
      assert.equal((await fsp.stat(path.join(up, "empty.txt"))).size, 0, "an empty file is begun and committed");
      await assert.rejects(files.upload("", listing.sep, new Blob(["x"]), "x.txt"), code("invalidData"), "nothing goes into the list of the drives");

      // The phone's file fails midway.
      const real = new Blob([crypto.randomBytes(4 * CHUNK)]);
      let slices = 0;
      const broken = { size: real.size, slice: (a, b) => (++slices > 2 ? { arrayBuffer: () => Promise.reject(new Error("the phone's file went away")) } : real.slice(a, b)) };
      net.reset();
      await assert.rejects(files.upload(up, listing.sep, broken, "broken.bin"), /went away/);
      assert.equal(net.calls.filter(c => c.method === "files.abort").length, 1, "the upload is aborted there");
      assert.equal(fs.existsSync(path.join(up, "broken.bin")), false);
      assert.deepEqual(await partsIn(work), [], "no .agentdeck-part is left");
      // Stop midway.
      const halt = new AbortController();
      await assert.rejects(files.upload(up, listing.sep, real, "halted.bin", { signal: halt.signal, onProgress: () => halt.abort() }), code("cancelled"));
      assert.equal(fs.existsSync(path.join(up, "halted.bin")), false);
      assert.deepEqual(await partsIn(work), [], "no .agentdeck-part after Stop either");
      console.log("ok: uploads byte for byte, one piece in flight, never over a file; a failed or stopped one leaves no part");

      // ---------- a link that goes while a file goes ----------
      const writes = () => net.calls.filter(c => c.method === "files.write");
      const tall = crypto.randomBytes(5 * CHUNK + 99);
      // A piece that never reached the computer is sent again and taken.
      let sentPieces = 0;
      net.reset();
      let back = await files.upload(up, listing.sep, new Blob([tall]), "unreached.bin", { onProgress: () => { if (++sentPieces === 2) net.once.set("files.write", "offline"); } });
      assert.ok((await fsp.readFile(back.path)).equals(tall), "an upload whose piece did not arrive is the file, byte for byte");
      assert.equal(path.basename(back.path), "unreached.bin");
      assert.deepEqual(writes().map(c => c.params.pos), [0, 1, 2, 2, 3, 4, 5].map(i => i * CHUNK), "the same piece again, at the same place");
      // A piece the computer took while its answer was lost: sent again it is refused there (it is past that place),
      // which the phone takes as "it has it" - written once.
      sentPieces = 0;
      net.reset();
      back = await files.upload(up, listing.sep, new Blob([tall]), "unanswered.bin", { onProgress: () => { if (++sentPieces === 2) net.lose("files.write", "timeout"); } });
      assert.ok((await fsp.readFile(back.path)).equals(tall), "an upload whose answer was lost is the file, byte for byte - no piece twice");
      assert.deepEqual(writes().map(c => c.params.pos), [0, 1, 2, 2, 3, 4, 5].map(i => i * CHUNK));
      assert.equal(net.most, 1, "one piece in flight");
      // The commit's answer lost: the file is there under the name it was begun with, once.
      net.reset();
      net.lose("files.commit", "closed");
      back = await files.upload(up, listing.sep, new Blob([tall]), "committed.bin");
      assert.equal(back.path, path.join(up, "committed.bin"));
      assert.ok((await fsp.readFile(back.path)).equals(tall));
      assert.equal(fs.existsSync(path.join(up, "committed (2).bin")), false, "an upload that was committed is not sent a second time");
      assert.equal(net.calls.filter(c => c.method === "files.begin").length, 1);
      // The link closed for real in the middle: the host forgets what that phone was sending, so it begins again.
      sentPieces = 0;
      net.reset();
      const goes = [];
      back = await files.upload(up, listing.sep, new Blob([tall]), "relinked.bin", { onProgress: p => { goes.push(p.bytes); if (++sentPieces === 3) { phone.stop(); phone.start(); } } });
      assert.ok((await fsp.readFile(back.path)).equals(tall), "an upload goes through once the link is made again");
      assert.match(path.basename(back.path), /^relinked( \(2\))?\.bin$/);
      assert.equal(net.calls.filter(c => c.method === "files.begin").length, 2, "begun again from its first byte");
      assert.ok(goes.indexOf(CHUNK, 3) > 0, "and the progress says so");
      assert.equal((await fsp.readdir(up)).filter(n => n.startsWith("relinked")).length, 1, "one file of it there");
      assert.deepEqual(await partsIn(work), [], "no .agentdeck-part is left by any of them");
      // A link that stays gone: the upload gives up with the piece's failure and leaves no part.
      const deadUp = { ...net, request: (n, m, p, o) => (m === "files.write" && p.pos >= CHUNK ? Promise.reject(Object.assign(new Error("timeout"), { code: "timeout" })) : net.request(n, m, p, o)) };
      await assert.rejects(createRemoteFiles({ provider: deadUp, node: id, plugin }).upload(up, listing.sep, new Blob([tall]), "never.bin"), code("timeout"));
      assert.equal(fs.existsSync(path.join(up, "never.bin")), false);
      assert.deepEqual(await partsIn(work), [], "an upload that gave up leaves no part");
      // Stop while a piece is on its way and nobody answers.
      const hungUp = net.stall("files.write");
      const haltUp = new AbortController();
      let stalledUp = 0;
      const stuckUp = files.upload(up, listing.sep, new Blob([tall]), "stalled.bin", { signal: haltUp.signal });
      hungUp.asked.then(() => { stalledUp = Date.now(); haltUp.abort(); });
      await assert.rejects(stuckUp, code("cancelled"));
      assert.ok(stalledUp && Date.now() - stalledUp < 1500, "Stop does not wait for the piece's answer");
      hungUp.release();
      await waitFor(async () => !(await partsIn(work)).length && !fs.existsSync(path.join(up, "stalled.bin")), "a stopped upload leaves nothing there");
      console.log("ok: an upload goes on after a piece that was lost and after an answer that was lost (nothing twice), begins again when the link was made anew, gives up after a few tries; Stop does not wait");

      // ---------- rename, copy, move, new folders, delete ----------
      const act = at("act");
      await fsp.mkdir(act);
      await fsp.writeFile(path.join(act, "a.txt"), "a");
      await fsp.writeFile(path.join(act, "b.txt"), "b");
      const offers = [];
      const renamed = await files.rename(path.join(act, "a.txt"), act, listing.sep, "b.txt", { offer: async o => { offers.push(o); return true; } });
      assert.deepEqual(offers, [{ taken: "b.txt", next: "b (2).txt" }], "a taken name is offered as name (2)");
      assert.equal(renamed.path, path.join(act, "b (2).txt"));
      assert.equal(await fsp.readFile(path.join(act, "b.txt"), "utf8"), "b", "the file with that name is as it was");
      assert.equal(await fsp.readFile(path.join(act, "b (2).txt"), "utf8"), "a");
      assert.equal(await files.rename(path.join(act, "b (2).txt"), act, listing.sep, "b.txt", { offer: async () => false }), null, "declined: nothing is renamed");
      assert.equal(fs.existsSync(path.join(act, "b (2).txt")), true);
      await assert.rejects(files.rename(path.join(act, "b.txt"), act, listing.sep, "x/y.txt"), code("badName"));

      assert.equal((await files.mkdir(act, listing.sep, "dest")).path, path.join(act, "dest"));
      assert.equal((await files.mkdir(act, listing.sep, "dest")).path, path.join(act, "dest (2)"), "a new folder's taken name: name (2)");
      const tree = path.join(act, "tree");
      await fsp.mkdir(path.join(tree, "sub"), { recursive: true });
      await fsp.writeFile(path.join(tree, "x.txt"), "x");
      await fsp.writeFile(path.join(tree, "sub", "y.bin"), crypto.randomBytes(3 * MB));
      const seenJob = [];
      const copied = await files.transfer({ path: tree, name: "tree", dir: true }, path.join(act, "dest"), listing.sep, { onProgress: j => seenJob.push(j) });
      assert.equal(copied.path, path.join(act, "dest", "tree"));
      assert.ok((await fsp.readFile(path.join(act, "dest", "tree", "sub", "y.bin"))).equals(await fsp.readFile(path.join(tree, "sub", "y.bin"))), "a tree copied as a job");
      assert.equal(seenJob.at(-1).state, "done");
      assert.equal(seenJob.at(-1).files, 2);
      assert.equal((await files.transfer({ path: path.join(act, "b.txt"), name: "b.txt", dir: false }, act, listing.sep)).path, path.join(act, "b (3).txt"), "a copy into its own folder: the next free name");
      assert.equal(await fsp.readFile(path.join(act, "b (3).txt"), "utf8"), "b");
      // (A folder copied into the folder it is in is refused by the host as intoItself - src/host/files.js copy.)
      await files.transfer({ path: tree, name: "tree", dir: true }, path.join(act, "dest (2)"), listing.sep);
      // A move on the same drive is a rename, into a free name.
      net.reset();
      const moved = await files.transfer({ path: path.join(act, "dest (2)", "tree"), name: "tree", dir: true }, act, listing.sep, { move: true });
      assert.equal(moved.path, path.join(act, "tree (2)"), "a move to a taken name: name (2)");
      assert.equal(net.calls.some(c => c.method === "files.copy"), false, "on one drive a move copies nothing");
      const moved2 = await files.transfer({ path: path.join(act, "tree (2)"), name: "tree (2)", dir: true }, path.join(act, "dest (2)"), listing.sep, { move: true });
      assert.equal(moved2.path, path.join(act, "dest (2)", "tree (2)"));
      await fsp.writeFile(path.join(act, "dest", "x.txt"), "taken");
      const into = await files.transfer({ path: path.join(tree, "x.txt"), name: "x.txt", dir: false }, path.join(act, "dest"), listing.sep, { move: true });
      assert.equal(into.path, path.join(act, "dest", "x (2).txt"), "a move to a taken name: name (2)");
      assert.equal(await fsp.readFile(path.join(act, "dest", "x.txt"), "utf8"), "taken");
      // To another drive: the host says crossDevice, and the move is a copy that removes the source.
      net.reset();
      net.once.set("files.rename", "crossDevice");
      const across = await files.transfer({ path: path.join(act, "dest (2)", "tree (2)"), name: "tree (2)", dir: true }, act, listing.sep, { move: true });
      assert.equal(across.path, path.join(act, "tree (2)"));
      assert.deepEqual(net.calls.filter(c => c.method === "files.copy").map(c => c.params.move), [true], "crossDevice: files.copy with move");
      assert.equal(fs.existsSync(path.join(act, "dest (2)", "tree (2)")), false, "the source goes once all of it is there");
      assert.equal(fs.existsSync(path.join(act, "tree (2)", "sub", "y.bin")), true);
      assert.deepEqual(await files.transfer({ path: path.join(act, "b.txt"), name: "b.txt", dir: false }, act, listing.sep, { move: true }), { path: path.join(act, "b.txt"), unchanged: true });
      // A copy the phone stops following goes on there.
      const detach = new AbortController();
      const following = files.transfer({ path: tree, name: "tree", dir: true }, path.join(act, "dest (2)"), listing.sep, { detach: detach.signal });
      detach.abort();
      await assert.rejects(following, code("detached"));
      await waitFor(() => fs.existsSync(path.join(act, "dest (2)", "tree", "sub", "y.bin")) && fs.statSync(path.join(act, "dest (2)", "tree", "sub", "y.bin")).size === 3 * MB, "the copy goes on there");
      await assert.rejects(files.transfer({ path: tree, name: "tree", dir: true }, tree, listing.sep), code("intoItself"));
      assert.deepEqual(await files.remove(path.join(act, "dest")), { trashed: false }, "this host has no bin: for good");
      assert.equal(fs.existsSync(path.join(act, "dest")), false);
      await assert.rejects(files.remove(home), code("rootRefused"), "the home is not deleted");
      console.log("ok: rename (name (2) offered, or declined), copy and move as jobs, across drives, new folders, delete");

      // ---------- a long folder, a page at a time ----------
      const many = at("many");
      await fsp.mkdir(many);
      const names = [];
      for (let i = 0; i < 1120; i++) names.push(i < 20 ? `Dir-${i}` : i % 9 === 0 ? `.hidden-${i}` : `file-${i}.txt`);
      await Promise.all(names.map(n => (n.startsWith("Dir") ? fsp.mkdir(path.join(many, n)) : fsp.writeFile(path.join(many, n), n))));
      const long = await files.folder(many);
      assert.ok(long.entries.length < names.length && long.next, "the first page is a page");
      const [a, b] = await Promise.all([long.more(), long.more()]);
      assert.equal(a, b, "load more pressed twice at once asks once");
      while (long.next) await long.more();
      const listed = long.entries.map(e => e.name);
      assert.equal(new Set(listed).size, listed.length, "no entry twice");
      assert.deepEqual([...listed].sort(), [...names].sort(), "every entry, the hidden ones too");
      assert.ok(long.entries.slice(0, 20).every(e => e.dir), "folders first");
      console.log(`ok: ${names.length} entries a page at a time, none twice, none left out`);

      // ---------- the order and the search (files.list sort / desc / filter) ----------
      const ord = at("ordered");
      await fsp.mkdir(path.join(ord, "Zeta"), { recursive: true });
      await fsp.mkdir(path.join(ord, "alpha"));
      const day = 86400000, base = Date.now() - 30 * day;
      const made = [["b-middle.txt", 300, 2], ["A-old.log", 10, 1], ["c-new.bin", 2000, 5], ["Lab notes.md", 50, 3], ["d-tiny.txt", 1, 4]];
      for (const [n, size, d] of made) {
        await fsp.writeFile(path.join(ord, n), Buffer.alloc(size, 65));
        const when = new Date(base + d * day);
        await fsp.utimes(path.join(ord, n), when, when);
      }
      const namesOf = async key => (await files.folder(ord, F.orderOf(key))).entries.map(e => e.name);
      const dirsFirst = ["alpha", "Zeta"];
      assert.deepEqual(await namesOf("nameAsc"), [...dirsFirst, "A-old.log", "b-middle.txt", "c-new.bin", "d-tiny.txt", "Lab notes.md"], "name A-Z, folders first");
      assert.deepEqual((await namesOf("nameDesc")).slice(2), ["Lab notes.md", "d-tiny.txt", "c-new.bin", "b-middle.txt", "A-old.log"], "name Z-A");
      assert.deepEqual((await namesOf("nameDesc")).slice(0, 2).every(n => dirsFirst.includes(n)), true, "folders first in every order");
      assert.deepEqual((await namesOf("newest")).slice(2), ["c-new.bin", "d-tiny.txt", "Lab notes.md", "b-middle.txt", "A-old.log"], "newest first");
      assert.deepEqual((await namesOf("oldest")).slice(2), ["A-old.log", "b-middle.txt", "Lab notes.md", "d-tiny.txt", "c-new.bin"], "oldest first");
      assert.deepEqual((await namesOf("largest")).slice(2), ["c-new.bin", "b-middle.txt", "Lab notes.md", "A-old.log", "d-tiny.txt"], "largest first");
      assert.deepEqual((await namesOf("smallest")).slice(2), ["d-tiny.txt", "A-old.log", "Lab notes.md", "b-middle.txt", "c-new.bin"], "smallest first");
      const found = await files.folder(ord, { ...F.orderOf("newest"), filter: "LA" });
      assert.deepEqual(found.entries.map(e => e.name), ["Lab notes.md"], "only the names that hold the text, whatever the case");
      assert.equal(found.total, 1);
      assert.deepEqual((await files.folder(ord, { filter: "zE" })).entries.map(e => e.name), ["Zeta"], "a folder is found too");
      assert.equal(found.sortable, true);
      assert.deepEqual((await files.folder(ord, { filter: "nothing-like-it" })).entries, [], "a search that matches nothing lists nothing");
      assert.deepEqual(F.listParams({ sort: "name", desc: false, filter: "  " }), {}, "the default order asks for nothing new");
      // Paging under another order: every entry once, in that order, the same order and filter asked for each page.
      net.reset();
      const bySize = await files.folder(many, F.orderOf("largest"));
      assert.ok(bySize.next.startsWith("#") && bySize.entries.length < names.length, "a page, with the host's count cursor");
      while (bySize.next) await bySize.more();
      const lists = net.calls.filter(c => c.method === "files.list");
      assert.ok(lists.every(c => c.params.sort === "size" && c.params.desc === true), "every page asks for the same order");
      assert.equal(lists[0].params.after, undefined, "a new order starts at the first page");
      assert.deepEqual(lists.slice(1).map(c => c.params.after), lists.slice(1).map((_, i) => `#${(i + 1) * 500}`), "and each next page goes on from the last");
      assert.equal(new Set(bySize.entries.map(e => e.name)).size, names.length, "no entry twice");
      const filesOnly = bySize.entries.filter(e => !e.dir);
      assert.ok(bySize.entries.slice(0, 20).every(e => e.dir), "folders first");
      assert.ok(filesOnly.every((e, i) => !i || filesOnly[i - 1].size >= e.size), "largest first across the pages");
      const filtered = await files.folder(many, { ...F.orderOf("nameDesc"), filter: "hidden" });
      while (filtered.next) await filtered.more();
      assert.equal(filtered.entries.length, names.filter(n => n.includes("hidden")).length);
      assert.equal(filtered.total, filtered.entries.length, "the total is the matching entries");
      // Changing the order mid-way starts again: the page after the first is not asked with the old cursor.
      net.reset();
      const byName = await files.folder(many, F.orderOf("nameAsc"));
      assert.equal(net.calls.at(-1).params.after, undefined);
      await byName.more();
      assert.ok(!net.calls.at(-1).params.after.startsWith("#"), "the name order keeps the host's name cursor");
      // A computer that cannot sort yet answers name order and no total: no sorting is offered there.
      const oldList = createRemoteFiles({ provider: { request: (n, m, p) => phone.request(n, m, { path: p.path }).then(r => { delete r.total; return r; }), on: () => () => {} }, node: id, plugin });
      const plain = await oldList.folder(ord, F.orderOf("newest"));
      assert.equal(plain.sortable, false);
      assert.equal(plain.total, null);
      console.log("ok: six orders (folders first), a search by name, paging under another order, a new order restarts, a computer that cannot sort");

      // Stop on a copy: cancelled there, nothing of it left, the source as it was.
      const halted = new AbortController();
      await assert.rejects(files.transfer({ path: many, name: "many", dir: true }, act, listing.sep, { signal: halted.signal, onProgress: () => halted.abort() }), code("cancelled"));
      assert.equal(fs.existsSync(path.join(act, "many")), false, "a stopped copy leaves nothing");
      assert.equal((await fsp.readdir(many)).length, names.length, "the source is as it was");
      console.log("ok: Stop on a copy cancels it there and leaves nothing");

      // ---------- looking at a file here ----------
      const text = "Здравей, свят\nline two\n".repeat(50);
      await fsp.writeFile(at("notes.txt"), text);
      await fsp.writeFile(at("README.md"), "# Title\n\nbody");
      const png = crypto.randomBytes(3 * MB);
      await fsp.writeFile(at("shot.png"), png);
      await fsp.writeFile(at("huge.log"), Buffer.alloc(TEXT_MAX + 1, 97));
      const view = await files.folder(work);
      const entry = n => view.entries.find(e => e.name === n);
      assert.deepEqual(await files.preview(at("notes.txt"), entry("notes.txt")), { kind: "text", text });
      assert.equal((await files.preview(at("README.md"), entry("README.md"))).kind, "markdown");
      const pic = await files.preview(at("shot.png"), entry("shot.png"));
      assert.equal(pic.type, "image/png");
      assert.ok(Buffer.from(await pic.blob.arrayBuffer()).equals(png), "a picture comes whole");
      net.reset();
      await assert.rejects(files.preview(at("huge.log"), entry("huge.log")), code("tooBigToView"));
      assert.equal(reads(at("huge.log")).length, 0, "a text over the cap is refused before a byte is read");
      assert.equal(F.tapAction(entry("huge.log"), { canDownload: true }), "download");
      // A PDF: a temporary file, finished, then the system's viewer on it.
      const pdf = crypto.randomBytes(300 * KB);
      await fsp.writeFile(at("doc.pdf"), pdf);
      await files.openFile(at("doc.pdf"), "doc.pdf");
      assert.equal(plugin.opened.length, 1);
      assert.equal(plugin.opened[0].type, "application/pdf");
      assert.ok((await fsp.readFile(plugin.opened[0].path)).equals(pdf));
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "doc.pdf")), false, "a PDF to look at is not put in Downloads");
      // No app opens it: the temporary file is of no use and goes.
      plugin.failOpen = "noViewer";
      await assert.rejects(files.openFile(at("doc.pdf"), "unopened.pdf"), code("noViewer"));
      const unopened = [...plugin.files.values()].find(f => f.path.endsWith("unopened.pdf"));
      assert.equal(unopened.state, "cancelled", "a file no viewer took is cancelled");
      assert.equal(fs.existsSync(unopened.path), false, "and is not left in the phone's temporary folder");
      assert.equal(plugin.opened.length, 1);
      console.log("ok: text, markdown and a picture looked at; the cap holds; a PDF opened through the plugin");

      // ---------- without the plugin ----------
      const bare = createRemoteFiles({ provider: net, node: id, plugin: null });
      assert.equal(bare.canDownload, false);
      net.reset();
      await assert.rejects(bare.download(at("app.apk"), "app.apk"), code("needsApp"));
      await assert.rejects(bare.openFile(at("doc.pdf"), "doc.pdf"), code("needsApp"));
      assert.equal(reads().length, 0, "nothing is read for a download that cannot be kept");
      const opts = { canDownload: bare.canDownload };
      const now = await bare.folder(work);
      assert.deepEqual(["app.apk", "doc.pdf", "notes.txt", "shot.png"].map(n => F.tapAction(now.entries.find(e => e.name === n), opts)), ["needsApp", "needsApp", "view", "view"]);
      assert.deepEqual(F.actionsFor(entry("app.apk"), opts), ["needsApp", "copy", "move", "rename", "delete"], "no Download: an update note in its place");
      assert.deepEqual(F.actionsFor(entry("app.apk"), { canDownload: true }), ["download", "copy", "move", "rename", "delete"]);
      assert.deepEqual(F.actionsFor({ name: "up", dir: true }, { canDownload: true }), ["copy", "move", "rename", "delete"], "a folder is not downloaded");
      assert.deepEqual(F.actionsFor({ name: "C:\\", dir: true }, { canDownload: true, atRoots: true }), [], "nothing is done to a drive");
      assert.equal((await bare.preview(at("notes.txt"), entry("notes.txt"))).text, text, "text is looked at without the plugin");
      assert.ok((await fsp.readFile((await bare.upload(up, view.sep, new Blob([body]), "bare.bin")).path)).equals(body), "and uploads work");
      console.log("ok: without the plugin nothing is downloaded and the choices say so; text and uploads still work");

      // ---------- a plugin that keeps no files on this phone (an Android older than 10) ----------
      plugin.noKeep = "needsAndroid10";
      assert.equal(files.canDownload, true, "the plugin is there");
      assert.equal(files.noKeep, "needsAndroid10");
      const old10 = { canDownload: files.canDownload, noKeep: files.noKeep };
      assert.deepEqual(["app.apk", "doc.pdf", "notes.txt", "shot.png", "huge.log"].map(n => F.tapAction(n === "doc.pdf" ? { name: n, size: pdf.length } : entry(n), old10)), ["noKeep", "pdf", "view", "view", "noKeep"], "a download says why not; a PDF still opens");
      assert.deepEqual(F.actionsFor(entry("app.apk"), old10), ["noKeep", "copy", "move", "rename", "delete"], "no Download: the reason in its place");
      const begunBefore = plugin.files.size;
      net.reset();
      await assert.rejects(files.download(at("app.apk"), "app.apk"), code("needsAndroid10"));
      assert.equal(reads().length, 0, "nothing is read for a file that cannot be kept");
      assert.equal(plugin.files.size, begunBefore, "and nothing is begun");
      await files.openFile(at("doc.pdf"), "doc.pdf");
      assert.equal(plugin.opened.length, 2, "a PDF is a temporary file: it opens all the same");
      plugin.noKeep = "";
      assert.equal(files.noKeep, "");
      console.log("ok: a plugin that keeps no files - nothing is read for a download, the choices say why, a PDF still opens");

      // ---------- a file the computer sends (docs/FILES.md 3.6) ----------
      // The host offers (served.offers.make), the phone hears it as a "notify", and takeOffer answers and pulls it.
      const heard = [];
      const offOffers = phone.on("notify", n => { if (n.event === "files.offer") heard.push(n); });
      const answers = () => net.calls.filter(c => c.method === "files.answer").map(c => c.params.error ? `${c.params.state}:${c.params.error}` : c.params.state);
      const offer = async file => {
        const before = heard.length;
        const made = await served.offers.make(phone.id, { path: file });
        await waitFor(() => heard.length > before, "the offer reaches the phone");
        const o = F.checkOffer(heard.at(-1).payload);
        assert.ok(o, "the offer the host sends passes the phone's check");
        assert.equal(o.offer, made.offer);
        assert.equal(heard.at(-1).node, id, "from the computer it was made on");
        net.reset();
        return o;
      };
      const sentBytes = crypto.randomBytes(MB + 200 * KB + 3);
      const report = at("report.bin");
      await fsp.writeFile(report, sentBytes);
      // Saved: accepted, the file whole into Downloads, then done.
      let o = await offer(report);
      const seenOffer = [];
      const kept = await F.takeOffer({ provider: net, node: id, plugin, offer: o, save: true, onProgress: p => seenOffer.push(p) });
      assert.equal(kept.state, "done");
      assert.ok((await fsp.readFile(path.join(phoneDir, "Downloads", kept.shown))).equals(sentBytes), "the offered file is in Downloads, byte for byte");
      assert.deepEqual(answers(), ["accepted", "done"], "accepted before anything is read, done after");
      assert.ok(net.calls.findIndex(c => c.method === "files.answer") < net.calls.findIndex(c => c.method === "files.read"), "nothing is read before the computer took the answer");
      assert.ok(reads(report).every(c => c.params.size === sentBytes.length && c.params.mtime === o.mtime), "every piece asks for the file the offer named");
      assert.deepEqual(seenOffer.at(-1), { bytes: sentBytes.length, total: sentBytes.length });
      assert.equal(served.offers.get(o.offer).state, "done", "the computer's row says done");
      // The computer ended the offer while the file came (Stop there, or its idle limit) and did not say so: the
      // phone's "done" is answered jobMissing, which changes nothing here - the file is saved and stays.
      o = await offer(report);
      const ended = { ...net, request: (n, m, p, x) => (m === "files.answer" && p.state === "done" ? Promise.reject(Object.assign(new Error("jobMissing"), { code: "jobMissing" })) : net.request(n, m, p, x)) };
      const keptAnyway = await F.takeOffer({ provider: ended, node: id, plugin, offer: o, save: true });
      assert.equal(keptAnyway.state, "done", "an offer the computer ended meanwhile is still a saved file");
      assert.ok((await fsp.readFile(path.join(phoneDir, "Downloads", keptAnyway.shown))).equals(sentBytes));
      // Not now: declined, nothing read.
      o = await offer(report);
      assert.deepEqual(await F.takeOffer({ provider: net, node: id, plugin, offer: o, save: false }), { state: "declined" });
      assert.deepEqual(answers(), ["declined"]);
      assert.equal(reads().length, 0, "a declined offer reads nothing");
      assert.equal(served.offers.get(o.offer).state, "declined");
      // No plugin (a browser, an older app): failed with needsApp, nothing read.
      o = await offer(report);
      await assert.rejects(F.takeOffer({ provider: net, node: id, plugin: null, offer: o, save: true }), code("needsApp"));
      assert.deepEqual(answers(), ["failed:needsApp"]);
      assert.equal(reads().length, 0, "without the plugin nothing is read");
      assert.equal(served.offers.get(o.offer).error, "needsApp");
      // A plugin that keeps no files: failed with its reason before anything, never "accepted".
      o = await offer(report);
      plugin.noKeep = "needsAndroid10";
      await assert.rejects(F.takeOffer({ provider: net, node: id, plugin, offer: o, save: true }), code("needsAndroid10"));
      assert.deepEqual(answers(), ["failed:needsAndroid10"], "the computer is not told accepted and then failed");
      assert.equal(reads().length, 0, "nothing is read");
      assert.equal(served.offers.get(o.offer).error, "needsAndroid10");
      plugin.noKeep = "";
      // The offer's size is the one the user agreed to: a first answer with another is refused before a file is begun.
      o = await offer(report);
      const otherSize = { ...net, request: (n, m, p, x) => (m === "files.read" ? Promise.resolve({ data: "", size: o.size + 1, mtime: o.mtime, eof: false }) : net.request(n, m, p, x)) };
      const begunOffer = plugin.files.size;
      await assert.rejects(F.takeOffer({ provider: otherSize, node: id, plugin, offer: o, save: true }), code("changed"));
      assert.equal(plugin.files.size, begunOffer, "a file of another size than the offer's is not begun");
      assert.deepEqual(answers(), ["accepted", "failed:changed"]);
      // The file changes while it comes: failed with changed, nothing left on the phone.
      const changingOffer = at("changing-offer.bin");
      await fsp.writeFile(changingOffer, crypto.randomBytes(2 * MB));
      o = await offer(changingOffer);
      let touched = false;
      plugin.onWrite = f => {
        if (touched || f.written < 2 * CHUNK) return;
        touched = true;
        fs.writeFileSync(changingOffer, crypto.randomBytes(2 * MB));
        const later = new Date(Date.now() + 240000);
        fs.utimesSync(changingOffer, later, later);
      };
      await assert.rejects(F.takeOffer({ provider: net, node: id, plugin, offer: o, save: true }), code("changed"));
      plugin.onWrite = null;
      assert.ok(touched);
      assert.deepEqual(answers(), ["accepted", "failed:changed"]);
      assert.equal(fs.existsSync(path.join(phoneDir, "Downloads", "changing-offer.bin")), false, "nothing of a changed file stays on the phone");
      assert.equal(served.offers.get(o.offer).error, "changed");
      // Changed after it was offered, before Save: the first piece is refused, the plugin never begins a file.
      o = await offer(report);
      await fsp.appendFile(report, "more");
      const begun = plugin.files.size;
      await assert.rejects(F.takeOffer({ provider: net, node: id, plugin, offer: o, save: true }), code("changed"));
      assert.equal(plugin.files.size, begun, "a file that is not the one offered is not begun on the phone");
      // Withdrawn (or expired) there: the answer is refused and nothing is read.
      o = await offer(report);
      served.offers.withdraw(o.offer);
      await assert.rejects(F.takeOffer({ provider: net, node: id, plugin, offer: o, save: true }), code("jobMissing"));
      assert.equal(reads().length, 0, "an offer the computer no longer has reads nothing");
      offOffers();
      // What the phone shows must be a plain name and a real size.
      const good = { offer: crypto.randomUUID(), path: report, name: "a.txt", size: 1, mtime: 1 };
      assert.ok(F.checkOffer(good));
      for (const bad of [null, { ...good, offer: "x" }, { ...good, name: "../a.txt" }, { ...good, name: "a/b" }, { ...good, name: "a\u0007b" }, { ...good, name: " a.txt" },
        { ...good, size: -1 }, { ...good, size: 1.5 }, { ...good, path: "" }, { ...good, mtime: "x" }]) assert.equal(F.checkOffer(bad), null, JSON.stringify(bad));
      // Nor a name with a character that is not seen: one that turns the text round shows another extension.
      for (const name of ["photo\u202Egpj.exe", "a\u202Db.txt", "a\u2066b\u2069.txt", "a\u200Fb.txt", "a\u200Bb.txt", "\uFEFFa.txt", "a\u2028b.txt", "a\u00ADb.txt"]) {
        assert.equal(F.checkOffer({ ...good, name }), null, `a name with U+${name.replace(/[ -~]/g, "").codePointAt(0).toString(16)}`);
      }
      for (const name of ["бележки за изданието.txt", "résumé (2).pdf", ".env", "日本語.txt"]) assert.ok(F.checkOffer({ ...good, name }), name);
      console.log("ok: a file the computer sends - saved byte for byte (accepted, then done), declined, no plugin, a plugin that keeps no files, another size than offered, changed on the way or before Save, withdrawn; every answer told; names that turn the text round refused");

      // ---------- an older computer ----------
      const old = createRemoteFiles({ provider: { request: () => Promise.reject(Object.assign(new Error("unknown"), { code: "unknownMethod" })), on: () => () => {} }, node: id, plugin });
      const err = await old.folder("~").catch(e => e);
      assert.equal(F.filesOutdated({ error: err }), true);
      console.log("ok: an AgentDeck without files.* is told apart");

      assert.deepEqual(plugin.breaches, [], "the page kept to the plugin's contract");
      assert.deepEqual(await partsIn(work), [], "no .agentdeck-part anywhere");
    }, { host: { home } });
    console.log("mobile files: all checks passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
