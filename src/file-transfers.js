// The desktop's two panes of files (docs/FILES.md 6): this computer on the left, a terminal's computer on the right,
// and the queue of what goes between them. Pure Node (Electron's main requires it).
//
// Both sides answer the same requests (host/files.js): this computer's own instance is called directly, as the peer
// "", and another computer's over the mesh link ("files.*" of mesh/serve.js). So a download is the other side's
// files.read written here with this side's files.begin/write/commit, and an upload the other way round - one rule for
// "name (2)" and for the unfinished file (it carries .agentdeck-part until it is whole), whichever way a file goes.
//
// One transfer runs at a time, and one request of it is under way at a time: the link also carries the terminals.
// A file is read with the size and time it was listed with, so one that changes meanwhile stops the transfer
// ("changed") instead of being put together from two versions. Stop finishes the piece under way, removes the
// unfinished file and keeps what already arrived. Nothing is ever written over.
//
// A folder is walked here, a page of its list at a time, before anything is written: its total is the progress's.
// Links to folders inside it are not followed - this side cannot see where one leads, so one to a parent would go
// round for ever - and are counted as skipped, with names the target's file system cannot hold.
//
// A file of this computer sent to a phone is a row too, but nothing moves from here: the phone is offered the file and
// pulls it itself (host/file-offers.js, docs/FILES.md 3.6). Its row follows the phone's answers: waiting for it, no
// answer (yet), saving on the phone, done, declined, failed, or expired; Stop takes back an offer not taken yet.
//
// createFileTransfers({ links, local, offers, nameOf, onChange }) - links: mesh/links.js; local: this computer's files
// (host/files.js); offers: this computer's offers to phones (mesh/serve.js offers); nameOf(node): a computer's or a
// phone's name ("" this one); onChange(list): the queue changed (called at most every CHANGE_MS while bytes move).
//   side(node) -> { call(method, params) }: one side's files.* ("delete" is host/files.js remove).
//   send({ from: { node, path }, to: { node, folder } }) -> the row: a file or a folder (with all in it) into a folder.
//   copy({ node, from, to, move }) -> the row: a copy (or a move across volumes) on one computer, done there.
//   offer({ node, path }) -> the row: a file of this computer offered to the phone `node` (linked now).
//   readAll(node, path, max, write?) -> Buffer, or the bytes handed to write(buf) a piece at a time: a whole file,
//     refused ("tooBig") above max bytes.
//   stop(id), clear() (the finished rows go), list(), linkDown(node), dispose().
const crypto = require("node:crypto");
const { HostError } = require("./host/errors");

const CHUNK = 256 * 1024;        // a files.read / files.write piece (host/files.js CHUNK)
const CHANGE_MS = 200;
const JOB_POLL_MS = 500;         // a copy's progress is asked, not pushed (docs/FILES.md 3.2)
const MAX_DEPTH = 64;            // folders inside folders, in one transfer
const ROWS_KEPT = 50;            // finished rows the queue keeps
const TIMEOUT_MS = { delete: 120000, cancel: 120000 }; // the rest: the link's own 30 s
// Each request of host/files.js, called on this computer's own instance as the peer "".
const LOCAL = {
  list: (f, p) => f.list(p), stat: (f, p) => f.stat(p), read: (f, p) => f.read(p), mkdir: (f, p) => f.mkdir(p),
  rename: (f, p) => f.rename(p), delete: (f, p) => f.remove(p), copy: (f, p) => f.copy("", p), job: (f, p) => f.job("", p),
  cancel: (f, p) => f.cancel("", p), begin: (f, p) => f.begin("", p), write: (f, p) => f.write("", p),
  commit: (f, p) => f.commit("", p), abort: (f, p) => f.abort("", p)
};
const fail = code => { throw new HostError(code); };
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
// A row that has not ended: it is not cleared, and Stop applies to it.
const LIVE = new Set(["queued", "running", "waiting", "noAnswer"]);
// An offer's state (host/file-offers.js) as its row's: noAnswer is still waiting, only the words differ.
const OFFER_STATE = { accepted: "running", done: "done", declined: "declined", failed: "failed", expired: "expired", withdrawn: "stopped" };
// A path on that side: its own separator, whatever this computer's is (the other one may be Linux).
const join = (sep, dir, name) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
// A name the other side listed, as a name inside a folder here: never a path, never one that leaves the folder. On a
// Windows target also none it cannot hold (a ":" there would write into a stream of another file).
function goodName(name, sep) {
  if (typeof name !== "string" || !name || name.length > 255 || name === "." || name === ".." || /[\\/\0]/.test(name)) return false;
  return sep !== "\\" || !/[<>:"|?*\x00-\x1f]|[. ]$/.test(name);
}

function createFileTransfers({ links, local, offers = null, nameOf = () => "", onChange = () => {} }) {
  const rows = new Map(); // id -> row, in the order they were made
  const waiting = [];     // transfers not begun yet
  let running = null, disposed = false, changeTimer = null;

  function side(node) {
    if (!node) return { call: async (method, p) => (LOCAL[method] ? LOCAL[method](local, p) : fail("unknownMethod")) };
    return { call: (method, p) => links.call(node, `files.${method}`, p, TIMEOUT_MS[method] ? { timeout: TIMEOUT_MS[method] } : undefined) };
  }

  // ---------- the queue as the window sees it ----------
  const view = r => ({
    id: r.id, kind: r.kind, move: r.move, name: r.name, state: r.state, error: r.error, message: r.message,
    from: { node: r.from.node, name: nameOf(r.from.node) }, to: { node: r.to.node, name: nameOf(r.to.node) },
    path: r.path, bytes: r.bytes, total: r.total, files: r.files, count: r.count, skipped: r.skipped, current: r.current
  });
  const list = () => [...rows.values()].map(view);
  function changed(now = false) {
    if (disposed) return;
    if (now) { clearTimeout(changeTimer); changeTimer = null; }
    else if (changeTimer) return;
    const tell = () => { changeTimer = null; try { onChange(list()); } catch {} };
    if (now) tell(); else changeTimer = setTimeout(tell, CHANGE_MS);
  }
  function addRow(r) {
    rows.set(r.id, r);
    // The oldest finished rows go when there are too many.
    const done = [...rows.values()].filter(x => !LIVE.has(x.state));
    for (const x of done.slice(0, Math.max(0, rows.size - ROWS_KEPT))) rows.delete(x.id);
  }
  function end(r, state, e) {
    r.state = state;
    if (e) { r.error = e.code || "fileFailed"; r.message = e.code ? "" : String(e.message || e); }
    r.current = "";
    changed(true);
  }
  const newRow = (kind, from, to, name) => ({ id: crypto.randomUUID(), kind, move: false, name, state: "queued", error: "", message: "", from, to, path: "", bytes: 0, total: 0, files: 0, count: 0, skipped: 0, current: "", stopping: false });

  // ---------- one file ----------
  // src: { path, size, mtime } on side S; into: the path it is to have on side D (or "name (2)" there).
  async function sendFile(r, S, D, src, into) {
    const { upload, path: target } = await D.call("begin", { path: into, size: src.size });
    let done = false;
    try {
      for (let pos = 0; pos < src.size;) {
        if (r.stopping) fail("stopped");
        const piece = await S.call("read", { path: src.path, pos, len: Math.min(CHUNK, src.size - pos), size: src.size, mtime: src.mtime });
        // What the other side answered is checked, not trusted: a piece that is not one ends the transfer.
        const bytes = isObj(piece) && typeof piece.data === "string" ? Buffer.byteLength(piece.data, "base64") : 0;
        if (!bytes || pos + bytes > src.size) fail("changed");
        await D.call("write", { upload, pos, data: piece.data });
        pos += bytes;
        r.bytes += bytes;
        changed();
      }
      const out = await D.call("commit", { upload });
      done = true;
      r.files++;
      return isObj(out) && typeof out.path === "string" ? out.path : target;
    } finally {
      if (!done) await D.call("abort", { upload }).catch(() => {});
    }
  }

  // ---------- a folder: what is in it, then the folders, then file by file ----------
  async function walk(r, S, dir, rel, out, depth) {
    if (depth > MAX_DEPTH) { r.skipped++; return; }
    for (let after = ""; ;) {
      if (r.stopping) fail("stopped");
      const page = await S.call("list", after ? { path: dir, after } : { path: dir });
      if (!isObj(page) || !Array.isArray(page.entries) || typeof page.sep !== "string" || typeof page.path !== "string") fail("invalidData");
      for (const e of page.entries) {
        if (!isObj(e) || !goodName(e.name, page.sep) || !goodName(e.name, r.toSep)) { r.skipped++; continue; }
        const src = join(page.sep, page.path, e.name), at = [...rel, e.name];
        if (e.dir) {
          if (e.link) { r.skipped++; continue; }
          out.push({ dir: true, rel: at });
          await walk(r, S, src, at, out, depth + 1);
        } else if (Number.isSafeInteger(e.size) && e.size >= 0) {
          out.push({ dir: false, rel: at, path: src, size: e.size, mtime: e.mtime });
          r.total += e.size;
          r.count++;
        } else r.skipped++;
      }
      changed();
      if (!page.next || typeof page.next !== "string") return;
      after = page.next;
    }
  }

  async function runTransfer(r) {
    const S = side(r.from.node), D = side(r.to.node);
    // The target folder, and its computer's separator: asked of it, as the window's word is not enough.
    const into = await D.call("list", { path: r.to.folder, limit: 1 });
    if (!isObj(into) || typeof into.sep !== "string" || typeof into.path !== "string") fail("invalidData");
    r.toSep = into.sep;
    const st = await S.call("stat", { path: r.from.path });
    if (!isObj(st)) fail("invalidData");
    // A whole drive is no file or folder to send (its name is its path).
    if (!goodName(st.name, into.sep)) fail(st.dir ? "rootRefused" : "invalidData");
    if (!st.dir) {
      r.total = st.size;
      r.count = 1;
      r.current = st.name;
      changed(true);
      r.path = await sendFile(r, S, D, { path: r.from.path, size: st.size, mtime: st.mtime }, join(into.sep, into.path, st.name));
      return;
    }
    const plan = [];
    await walk(r, S, r.from.path, [], plan, 0);
    // The folder itself under a name that is free there; its folders as they were made (one may have needed a number:
    // two names that differ only in case, from a computer that tells them apart).
    const top = (await D.call("mkdir", { path: join(into.sep, into.path, st.name), keep: true })).path;
    r.path = top;
    const made = new Map([["", top]]);
    const parentOf = rel => made.get(rel.slice(0, -1).join("\0"));
    for (const x of plan) {
      if (r.stopping) fail("stopped");
      if (x.dir) {
        made.set(x.rel.join("\0"), (await D.call("mkdir", { path: join(into.sep, parentOf(x.rel), x.rel.at(-1)), keep: true })).path);
        continue;
      }
      r.current = x.rel.join("/");
      changed();
      await sendFile(r, S, D, x, join(into.sep, parentOf(x.rel), x.rel.at(-1)));
    }
  }

  async function pump() {
    if (running || disposed) return;
    const r = waiting.shift();
    if (!r) return;
    running = r;
    r.state = "running";
    changed(true);
    try {
      await runTransfer(r);
      end(r, "done");
    } catch (e) {
      if (r.stopping) end(r, "stopped");
      else end(r, "failed", e?.code === "closed" ? new HostError("offline") : e);
    }
    running = null;
    pump();
  }
  function send({ from, to }) {
    const r = newRow("transfer", { node: from.node, path: from.path }, { node: to.node, folder: to.folder }, "");
    r.name = from.path.split(/[\\/]/).filter(Boolean).pop() || from.path;
    addRow(r);
    waiting.push(r);
    changed(true);
    pump();
    return view(r);
  }

  // ---------- a copy on one computer: a job there, asked how it goes ----------
  async function runCopy(r, p) {
    const S = side(r.from.node);
    let j = await S.call("copy", p);
    if (!isObj(j) || typeof j.job !== "string") fail("invalidData");
    r.job = j.job;
    r.path = typeof j.to === "string" ? j.to : "";
    r.state = "running";
    changed(true);
    while (j.state === "running") {
      await new Promise(res => setTimeout(res, JOB_POLL_MS));
      if (disposed) return;
      if (r.stopping) { j = await S.call("cancel", { job: r.job }); break; }
      j = await S.call("job", { job: r.job });
      Object.assign(r, { bytes: Number(j.bytes) || 0, total: Number(j.total) || 0, files: Number(j.files) || 0, skipped: Number(j.skipped) || 0 });
      changed();
    }
    Object.assign(r, { bytes: Number(j.bytes) || 0, total: Number(j.total) || 0, files: Number(j.files) || 0, skipped: Number(j.skipped) || 0 });
    if (j.state === "done") end(r, "done");
    else if (j.state === "cancelled") end(r, "stopped");
    else end(r, "failed", new HostError(typeof j.error === "string" && j.error ? j.error : "fileFailed"));
  }
  function copy({ node, from, to, move = false }) {
    const r = newRow("copy", { node, path: from }, { node, folder: "" }, from.split(/[\\/]/).filter(Boolean).pop() || from);
    r.move = Boolean(move);
    addRow(r);
    changed(true);
    // A copy on the other computer goes on there when the link drops (docs/FILES.md 1); here it is only no longer seen.
    runCopy(r, { from, to, move: r.move }).catch(e => end(r, r.stopping ? "stopped" : "failed", e?.code === "closed" ? new HostError("offline") : e));
    return view(r);
  }

  // ---------- reading a whole file (a preview) ----------
  async function readAll(node, file, max, write = null) {
    const S = side(node);
    const st = await S.call("stat", { path: file });
    if (!isObj(st) || st.dir) fail("notFile");
    if (st.size > max) fail("tooBig");
    const parts = [];
    for (let pos = 0; pos < st.size;) {
      const piece = await S.call("read", { path: file, pos, len: Math.min(CHUNK, st.size - pos), size: st.size, mtime: st.mtime });
      const buf = isObj(piece) && typeof piece.data === "string" ? Buffer.from(piece.data, "base64") : Buffer.alloc(0);
      if (!buf.length || pos + buf.length > st.size) fail("changed");
      if (write) await write(buf); else parts.push(buf);
      pos += buf.length;
    }
    return write ? st.size : Buffer.concat(parts);
  }

  // ---------- a file offered to a phone ----------
  async function offer({ node, path }) {
    if (!offers) fail("unknownMethod");
    const o = await offers.make(node, { path });
    const r = newRow("offer", { node: "", path: o.path }, { node, folder: "" }, o.name);
    Object.assign(r, { offer: o.offer, state: "waiting", total: o.size, count: 1 });
    addRow(r);
    changed(true);
    return view(r);
  }
  offers?.on("change", o => {
    const r = [...rows.values()].find(x => x.offer === o.offer);
    if (!r) return;
    r.state = o.state === "waiting" ? (o.noAnswer ? "noAnswer" : "waiting") : OFFER_STATE[o.state] || "failed";
    r.error = o.state === "failed" ? o.error || "fileFailed" : "";
    if (r.state === "done") { r.bytes = r.total; r.files = 1; }
    changed(true);
  });

  // ---------- stopping ----------
  function stop(id) {
    const r = rows.get(id);
    if (!r) return false;
    // An offer is taken back while the phone has not taken it; once it has, the phone's own Stop is the one.
    if (r.kind === "offer") return offers.withdraw(r.offer);
    if (r.state === "queued" && r.kind === "transfer") {
      waiting.splice(waiting.indexOf(r), 1);
      end(r, "stopped");
    } else if (r.state === "running" || r.state === "queued") {
      r.stopping = true;
      changed(true);
    }
    return true;
  }
  function clear() {
    for (const r of [...rows.values()]) if (!LIVE.has(r.state)) rows.delete(r.id);
    changed(true);
    return list();
  }
  // A link that dropped: that computer's transfers fail - those waiting at once, the one under way as its request
  // fails (a request on a closed link does at once). Copies there go on there.
  function linkDown(node) {
    for (const r of [...waiting]) {
      if (r.from.node !== node && r.to.node !== node) continue;
      waiting.splice(waiting.indexOf(r), 1);
      end(r, "failed", new HostError("offline"));
    }
    for (const r of rows.values()) if (r.kind === "copy" && r.from.node === node && r.state === "running") { r.stopping = false; end(r, "failed", new HostError("offline")); }
  }
  // Quitting: what waits is dropped, the transfer under way stops after its piece and removes its unfinished file.
  async function dispose() {
    for (const r of waiting.splice(0)) r.state = "stopped";
    const r = running;
    if (r) {
      r.stopping = true;
      await new Promise(res => { const tick = () => (running === r ? setTimeout(tick, 20) : res()); tick(); });
    }
    disposed = true;
    clearTimeout(changeTimer);
  }

  return { side, send, copy, offer, readAll, stop, clear, list, linkDown, dispose };
}

module.exports = { createFileTransfers, goodName, join, CHUNK };
