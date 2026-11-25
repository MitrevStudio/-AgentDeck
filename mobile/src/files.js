// The files of one of the user's computers, from the phone (docs/FILES.md 5): its folders a page at a time, a file
// brought to the phone a piece at a time into the app's native `Files` plugin (FILES.md 5.1), a file of the phone put
// there a piece at a time, a file read whole for a look at it here (text, markdown, a picture), and what is done to
// them there - rename, copy, move, delete, a new folder. The host's side is src/host/files.js; its methods are
// src/mesh/serve.js "files.*".
//
// No DOM and no Capacitor in here: the provider and the plugin are handed in (the store's provider and
// files-native.js on a phone; the real phone provider and a fake plugin over a temporary folder in
// scripts/test-mobile-files.js), so all of it runs in Node. Without the plugin (a browser, an app whose native part
// is older than the page) nothing is brought to the phone as a file: `canDownload` is false, download and PDF are not
// offered and say "needsApp"; looking at text and pictures and uploading work all the same. A plugin that cannot keep
// a file on this phone (`noKeep`: the code of why - an Android older than 10 has no Downloads an app may write to
// without a permission) opens a PDF all the same; Download says why instead, before anything is read.
//
// What must never happen: a file on the phone put together from two versions (the size and time the first piece of a
// download answered go back with every later one, and the host refuses a file that is no longer that one: `changed`;
// the phone's unfinished file is then cancelled), a piece asked for before the last one came (one request in flight:
// a piece is up to 256 KB, the link also carries the terminals), and an upload left half there (it is aborted, which
// removes the host's `.agentdeck-part`). Nothing is written over: the host gives a copy, an upload and a moved thing
// whose name is taken "name (2)"; a rename whose name is taken is offered "name (2)" here.
//
// A link that goes while a file comes or goes ("offline", "timeout", "closed") is waited for and the same piece asked
// again, a few times (RETRIES, each wait at most ONLINE_MS): a read is by its place and the host checks the size and
// time again; a write is taken by the host only at the place where its last one ended, so a piece is never written
// twice - one whose answer was lost is refused the second time and counted as there. The host forgets an upload whose
// link dropped: that one starts again from its first byte (RESTARTS). Stop does not wait for an answer on a link that
// stalled: every request for a piece is given up the moment it is pressed.
//
// createRemoteFiles({ provider, node, plugin, whenOnline }) - provider: request(node, method, params, { timeout }),
//   on("notify", fn) and online(node) (provider-relay.js); plugin: the `Files` plugin (files-native.js), or null;
//   whenOnline(ms): settles once the computer is linked again, rejects after ms (the store's; without it the
//   provider's online() is asked) ->
//   canDownload, noKeep ("" or the code of why nothing is kept on this phone); folder(path, order?) -> a Folder (below; order: { sort, desc, filter } - ORDERS); download(path, name, opts) -> { file, shown, size } (opts.expect:
//   { size, mtime } the file must still have - a file offered to the phone is the one its user agreed to take);
//   openFile(path, name, opts) -> the same, opened in the system's viewer; preview(path, entry, opts) ->
//   { kind: "text" | "markdown", text } | { kind: "image", type, blob }; upload(dir, sep, blob, name, opts) -> { path };
//   rename(from, dir, sep, name, { dir, offer }) -> { path } | null; transfer(item, toDir, sep, opts) -> { path };
//   mkdir(dir, sep, name) -> { path }; remove(path) -> { trashed }.
//   opts: onProgress({ bytes, total, files? }), signal (an AbortSignal: Stop - "cancelled"). A copy also takes detach
//   (an AbortSignal: stop following it, it goes on there - "detached").
// A Folder: { path, parent, sep, home, entries, next, total, sortable } as files.list answers it ("" is the list of the
//   roots, whose entries' names are their paths), and more() -> the entries of the next page in the same order and
//   filter; one page at a time, and an entry already listed is not listed again. total: the entries that match (null
//   from a computer whose AgentDeck has no sorting yet - it answers name order whatever is asked: sortable false).
//
// A file a computer sends (docs/FILES.md 3.6): the computer can push nothing onto a phone, so it offers the file
// ("files.offer" { offer, path, name, size, mtime }) and the phone pulls it with the same download. checkOffer(payload)
// -> the offer as the phone shows it, or null; takeOffer({ provider, node, plugin, offer, save, onProgress, signal })
// answers it ("files.answer") as the user chose and, on save, downloads it into Downloads - "accepted" first and nothing
// read unless the computer took that, then "done" or "failed" with the code.
import { toBase64, fromBase64 } from "./forward.js";

export const CHUNK = 256 * 1024;              // bytes of one files.read / files.write (src/host/files.js CHUNK)
export const TEXT_MAX = 1024 * 1024;          // text and markdown looked at here (docs/FILES.md 1)
export const IMAGE_MAX = 20 * 1024 * 1024;    // a picture looked at here
const PIECE_MS = 60000;                       // one piece through the relay on a slow link, with the terminals beside it
const POLL_MS = 700;                          // how often a running copy is asked about
const TRIES = 100;                            // "name (2)" ... "name (99)"
const LINK_GONE = new Set(["offline", "timeout", "closed"]);
const RETRIES = 4;                            // how many times one piece is asked again after the link went
const RESTARTS = 2;                           // how many times an upload the host forgot begins again
const ONLINE_MS = 30000;                      // how long the computer is waited for before one of those
const RETRY_MS = 400;                         // a breath before asking again (a link that is up but answers nothing)
const ONLINE_POLL_MS = 250;
const SOON_MS = 2000;                         // what is told the computer after Stop is not waited for longer

export const failure = (code, message = code) => Object.assign(new Error(message), { code });
const stopped = signal => { if (signal?.aborted) throw failure("cancelled"); };
// The promise's own end, or `cancelled` the moment the signal fires: Stop does not wait for an answer that may take
// a minute on a stalled link. What the promise ends with afterwards is nobody's.
function raced(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(failure("cancelled")); }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(failure("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
const pause = (ms, signal) => raced(new Promise(resolve => setTimeout(resolve, ms)), signal);
// Best effort and at most SOON_MS: what the computer is told once the user has already stopped.
const soon = promise => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, SOON_MS); timer.unref?.(); })]);

// ---------- paths, names, kinds ----------
// A child of a folder there: dir + sep + name, without a second sep after a root ("C:\", "/"). In the list of the
// roots ("") an entry's name is its path.
export function join(dir, sep, name) {
  if (!dir) return name;
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
export const entryPath = (folder, entry) => join(folder.path, folder.sep, entry.name);

// "name.ext" -> "name (2).ext", as the host numbers a name that is taken; a folder's whole name is numbered, as is a
// name with no extension or one that is only an extension (".gitignore").
export function numbered(name, n, dir = false) {
  const dot = dir ? -1 : name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// A name typed on the phone for something there: one name, not a path.
export function checkName(name) {
  const s = String(name ?? "").trim();
  if (!s || s === "." || s === ".." || /[\\/\0]/.test(s) || s.length > 255) throw failure("badName");
  return s;
}

// The folders a path goes through, for the breadcrumb: [{ name, path }] from its root ("C:" / "/" / "\\server\share")
// to itself. The roots ("") have none.
export function crumbs(path, sep) {
  if (!path) return [];
  const win = sep === "\\";
  const root = (win ? path.match(/^(\\\\[^\\]+\\[^\\]+\\?|[A-Za-z]:\\?)/)?.[0] : path.startsWith("/") ? "/" : "") || "";
  const out = [];
  let at = root ? (root.endsWith(sep) ? root : root + sep) : "";
  if (root) out.push({ name: root === "/" ? "/" : root.replace(/\\$/, ""), path: at });
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    at = at ? join(at, sep, part) : part;
    out.push({ name: part, path: at });
  }
  return out;
}

const TEXT = new Set(("txt text log csv tsv json jsonc json5 jsonl ndjson yml yaml toml ini cfg conf config env properties xml html htm " +
  "css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi rb go rs java kt kts gradle groovy scala swift m mm c h cc " +
  "cpp cxx hpp hh cs fs vb php pl pm lua r dart ex exs erl hs clj sql graphql gql proto sh bash zsh fish ps1 psm1 psd1 bat cmd " +
  "gitignore gitattributes gitmodules editorconfig npmrc nvmrc yarnrc prettierrc eslintrc babelrc bashrc zshrc profile " +
  "dockerfile dockerignore makefile cmake mk lock patch diff tex rst adoc org srt vtt plist manifest pro").split(" "));
const BARE_TEXT = new Set(["readme", "license", "licence", "copying", "authors", "contributors", "changelog", "notice", "makefile",
  "dockerfile", "procfile", "gemfile", "rakefile", "vagrantfile", "jenkinsfile", "brewfile", "podfile", "codeowners"]);
const IMAGES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml" };
const extOf = name => {
  const s = String(name).toLowerCase(), dot = s.lastIndexOf(".");
  return dot >= 0 ? s.slice(dot + 1) : "";
};
// What a file is to the phone: "markdown", "text", "image", "pdf" or "other" - by its name, never by its bytes.
export function kindOf(name) {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (IMAGES[ext]) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT.has(ext) || (!ext && BARE_TEXT.has(String(name).toLowerCase()))) return "text";
  return "other";
}

// "412 B", "3.4 KB", "48 MB".
export function bytesText(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = Math.max(0, Number(n) || 0), u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${u && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

// ---------- what the screen offers ----------
// The computer's AgentDeck has no files.* (host.info without `files`, or a method it does not know): "update it there".
export const filesOutdated = ({ info = null, error = null } = {}) => error?.code === "unknownMethod" || Boolean(info && !info.files);

// What a tap on an entry does: "open" (a folder), "view" (text, markdown, a picture small enough to look at here),
// "pdf" (the system's viewer), "download" (asked first), "needsApp" (that takes the plugin, and there is none).
// "noKeep": the plugin is there but keeps no file on this phone (noKeep: why) - said instead of asking; a PDF is a
// temporary file and opens all the same.
export function tapAction(entry, { canDownload = false, noKeep = "" } = {}) {
  if (entry.dir) return "open";
  const kind = kindOf(entry.name);
  if ((kind === "text" || kind === "markdown") && entry.size <= TEXT_MAX) return "view";
  if (kind === "image" && entry.size <= IMAGE_MAX) return "view";
  if (!canDownload) return "needsApp";
  if (kind === "pdf") return "pdf";
  return noKeep ? "noKeep" : "download";
}
// What the sheet of an entry offers, in order. Only files come to the phone (docs/FILES.md 1: no folders through the
// system's picker or Downloads); in the list of the roots (the drives) nothing is offered - a drive is neither copied,
// moved, renamed nor deleted.
export function actionsFor(entry, { canDownload = false, noKeep = "", atRoots = false } = {}) {
  if (atRoots) return [];
  return [entry.dir ? "" : !canDownload ? "needsApp" : noKeep ? "noKeep" : "download", "copy", "move", "rename", "delete"].filter(Boolean);
}

// The bytes a base64 text stands for, without decoding it.
export function base64Bytes(data) {
  if (typeof data !== "string" || data.length % 4) throw failure("invalidData");
  return data.length ? (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) : 0;
}

// ---------- the order of a list ----------
// The orders the phone offers (files.list sort / desc). Folders stay first in each; the name order is the host's own
// and the only one that does not make it look at every entry before the first page.
export const ORDERS = [
  { key: "nameAsc", sort: "name", desc: false },
  { key: "nameDesc", sort: "name", desc: true },
  { key: "newest", sort: "mtime", desc: true },
  { key: "oldest", sort: "mtime", desc: false },
  { key: "largest", sort: "size", desc: true },
  { key: "smallest", sort: "size", desc: false }
];
export const orderOf = key => ORDERS.find(o => o.key === key) || ORDERS[0];
// What files.list is asked for besides the path: only what differs from the host's default (an older host sees no
// field it does not know), never a filter longer than the host takes.
export function listParams({ sort = "name", desc = false, filter = "" } = {}) {
  const out = {};
  if (sort !== "name") out.sort = sort;
  if (desc) out.desc = true;
  const f = String(filter || "").trim().slice(0, 200);
  if (f) out.filter = f;
  return out;
}

// ---------- the computer ----------
export function createRemoteFiles({ provider, node, plugin = null, whenOnline = null }) {
  const call = (method, params, timeout = 30000) => provider.request(node, method, params, { timeout });
  const noKeep = () => (plugin && typeof plugin.noKeep === "string" ? plugin.noKeep : "");

  // The computer linked again, or "offline" after ONLINE_MS - "cancelled" at once when Stop is pressed meanwhile.
  async function linked(signal) {
    if (whenOnline) return raced(Promise.resolve().then(() => whenOnline(ONLINE_MS)), signal);
    for (const until = Date.now() + ONLINE_MS; provider.online && !provider.online(node);) {
      if (Date.now() >= until) throw failure("offline");
      await pause(ONLINE_POLL_MS, signal);
    }
  }
  // Before a piece is asked again after `error` (the link went): a breath, then the computer is waited for. Not back
  // in time - the failure is the one the piece had.
  async function again(error, signal) {
    await pause(RETRY_MS, signal);
    await linked(signal).catch(e => { throw e?.code === "cancelled" ? e : error; });
    stopped(signal);
  }

  // ---------- folders ----------
  // order: { sort, desc, filter } (listParams). A page's `next` is valid only with the same order and filter: a new
  // order is a new folder() from the first page.
  async function folder(path, order = {}) {
    const asked = path ? listParams(order) : {};
    const first = await call("files.list", { path, ...asked });
    const seen = new Set(first.entries.map(e => e.name));
    let busy = null;
    const sortable = Number.isInteger(first.total);
    const f = { path: first.path, parent: first.parent, sep: first.sep, home: first.home, entries: [...first.entries], next: first.next, total: sortable ? first.total : null, sortable, order: asked };
    // The next page; a second tap while one is on its way gets the same answer, not the page twice.
    f.more = () => (busy ||= (async () => {
      if (!f.next) return [];
      const page = await call("files.list", { path: f.path, after: f.next, ...asked });
      const fresh = page.entries.filter(e => !seen.has(e.name));
      for (const e of fresh) seen.add(e.name);
      f.entries.push(...fresh);
      f.next = page.next;
      return fresh;
    })().finally(() => { busy = null; }));
    return f;
  }

  // ---------- bytes from there ----------
  // The file a piece at a time, one request in flight, each piece (base64, as it came) handed to take() before the
  // next is asked for. The first answer's size and time go back with every later request: the host refuses a file that
  // changed meanwhile (`changed`). first(answer): before the first piece is taken (a plugin file is begun with the
  // size). max: a file bigger than this is refused before anything is taken.
  // expect: { size, mtime } the first piece already asks with (a file that is no longer that one: `changed`).
  // The size is the first answer's and nothing is taken on trust after it: a size that is no size, another size than
  // the one expected or answered before, and a piece that would go past the size (or past max) stop the reading - a
  // computer that never says "eof" cannot fill the phone. A piece whose link went is asked for again (again()).
  async function readPieces(path, take, { onProgress, signal, max = Infinity, first, expect } = {}) {
    let pos = 0, size, mtime, begun = false;
    for (let tries = 0; ;) {
      stopped(signal);
      const known = begun ? { size, mtime } : expect ? { size: expect.size, mtime: expect.mtime } : null;
      let r;
      try {
        r = await raced(call("files.read", known ? { path, pos, len: CHUNK, ...known } : { path, pos, len: CHUNK }, PIECE_MS), signal);
      } catch (e) {
        if (!LINK_GONE.has(e?.code) || tries >= RETRIES) throw e;
        tries++;
        await again(e, signal);
        continue;
      }
      tries = 0;
      if (!r || !Number.isSafeInteger(r.size) || r.size < 0) throw failure("fileFailed");
      if (!begun) {
        if (expect && (r.size !== expect.size || (expect.mtime !== undefined && r.mtime !== expect.mtime))) throw failure("changed");
        if (r.size > max) throw failure("tooBigToView");
        begun = true;
        ({ size, mtime } = r);
        await first?.(r);
      } else if (r.size !== size) throw failure("changed");
      const n = base64Bytes(r.data);
      if (n > CHUNK || (!n && !r.eof)) throw failure("fileFailed");
      if (pos + n > max) throw failure("tooBigToView");
      if (pos + n > size) throw failure("changed");
      if (n) await take(r.data, n);
      pos += n;
      onProgress?.({ bytes: pos, total: size });
      if (r.eof) break;
    }
    // The pieces end where the size said: anything else is not the file whose size was handed back.
    if (pos !== size) throw failure("changed");
    return { size, mtime };
  }

  // A file there into a file of the plugin's: keep - Downloads (a file the user keeps), else a temporary one (for
  // open()). The plugin's file is begun once the first piece came, with that piece's size - the plugin takes exactly
  // that many bytes - so a file that is not there leaves nothing here; it is cancelled when anything fails or Stop is
  // pressed, also when finish itself is refused (an iPhone's "Save to Files" sheet dismissed answers `cancelled`, with
  // the file still there to remove).
  async function download(path, name, { keep = true, onProgress, signal, expect } = {}) {
    if (!plugin) throw failure("needsApp");
    if (keep && noKeep()) throw failure(noKeep());
    let file = null;
    try {
      const { size } = await readPieces(path, data => plugin.write({ file, data }), {
        onProgress, signal, expect,
        first: async r => { file = (await plugin.begin({ name, size: r.size, keep })).file; }
      });
      stopped(signal);
      const done = await plugin.finish({ file });
      return { file, shown: done?.shown || name, size };
    } catch (e) {
      if (file) await Promise.resolve().then(() => plugin.cancel({ file })).catch(() => {});
      throw e;
    }
  }
  // A PDF (or another file the system has a viewer for): a temporary file, then the system's viewer on it. A file
  // no viewer took (none for its kind, or it could not be started) is of no use on the phone and goes.
  async function openFile(path, name, { type = "application/pdf", ...opts } = {}) {
    const r = await download(path, name, { ...opts, keep: false });
    try {
      await plugin.open({ file: r.file, type });
    } catch (e) {
      await Promise.resolve().then(() => plugin.cancel({ file: r.file })).catch(() => {});
      throw e;
    }
    return r;
  }

  // A file read whole for a look at it here: text and markdown up to TEXT_MAX (decoded as UTF-8), a picture up to
  // IMAGE_MAX (a Blob of its type, for a blob: URL). A file over the cap is refused before anything is read, and
  // no more than the cap is ever held, whatever the computer answers (readPieces' max).
  async function preview(path, entry, { onProgress, signal } = {}) {
    const kind = kindOf(entry.name);
    const max = kind === "image" ? IMAGE_MAX : kind === "text" || kind === "markdown" ? TEXT_MAX : 0;
    if (!max) throw failure("invalidData");
    if (entry.size > max) throw failure("tooBigToView");
    const parts = [];
    const { size } = await readPieces(path, data => { parts.push(fromBase64(data)); }, { onProgress, signal, max });
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    if (kind === "image") {
      const type = IMAGES[extOf(entry.name)];
      return { kind, type, blob: new Blob([bytes], { type }) };
    }
    return { kind, text: new TextDecoder().decode(bytes) };
  }

  // ---------- bytes to there ----------
  // A file of the phone (a File from <input type="file">, or any Blob) into a folder there, read a piece at a time with
  // slice(), one piece in flight. The host writes it under `.agentdeck-part` and gives it its name - "name (2)" when
  // that is taken - only once it is whole; anything that fails here, or Stop, aborts it, which removes the part.
  // A link that went: the same piece again (sendPiece), and an upload the host forgot with its link from the first
  // byte again, under a new files.begin.
  async function upload(dir, sep, blob, name, { onProgress, signal } = {}) {
    if (!dir) throw failure("invalidData");
    const size = blob.size, target = join(dir, sep, checkName(name));
    for (let restarts = 0; ; restarts++) {
      stopped(signal);
      const beginning = call("files.begin", { path: target, size });
      let up;
      try {
        up = await raced(beginning, signal);
      } catch (e) {
        // Stopped while it was being begun: an upload the host began all the same is not left to its idle time.
        if (e?.code === "cancelled") beginning.then(u => call("files.abort", { upload: u.upload })).catch(() => {});
        throw e;
      }
      try {
        const done = await sendAll(up, blob, size, { onProgress, signal });
        if (done) return done;
        if (restarts >= RESTARTS) throw failure("jobMissing");
      } catch (e) {
        const aborting = call("files.abort", { upload: up.upload }).catch(() => {});
        await (signal?.aborted ? soon(aborting) : aborting);
        throw e;
      }
    }
  }
  // The pieces of an upload the host began, then its commit -> { path }, or null when the host no longer knows the
  // upload (its link dropped: what had come is gone there).
  async function sendAll(up, blob, size, { onProgress, signal }) {
    for (let pos = 0; pos < size;) {
      stopped(signal);
      const bytes = new Uint8Array(await blob.slice(pos, Math.min(size, pos + CHUNK)).arrayBuffer());
      if (!bytes.length) throw failure("fileFailed"); // the phone's file is shorter than it said
      stopped(signal);
      if (!(await sendPiece(up, pos, toBase64(bytes), signal))) return null;
      pos += bytes.length;
      onProgress?.({ bytes: pos, total: size });
    }
    stopped(signal);
    return commit(up, size, signal);
  }
  // One piece at `pos` -> true once the host has it, false when the host no longer knows the upload. Asked again
  // after a link that went, the host answers one of three things: it takes the piece (the first never arrived);
  // `invalidData` - the first did arrive and only its answer was lost, the host is past `pos` and writes nothing
  // twice (were that guess wrong, the next piece or the commit is refused the same way and the upload fails whole);
  // `jobMissing` - the upload went with the link.
  async function sendPiece(up, pos, data, signal) {
    for (let tries = 0; ; tries++) {
      try {
        await raced(call("files.write", { upload: up.upload, pos, data }, PIECE_MS), signal);
        return true;
      } catch (e) {
        if (tries && e?.code === "invalidData") return true;
        if (tries && e?.code === "jobMissing") return false;
        if (!LINK_GONE.has(e?.code) || tries >= RETRIES) throw e;
        await again(e, signal);
      }
    }
  }
  // The file gets its name there. Not given up on Stop while it is asked: past this point the file may be there, and
  // "stopped" must not be said of a file that stays. Asked again after a link that went, `jobMissing` is either a
  // commit that was taken with its answer lost - then the name files.begin gave is a file of that size now - or an
  // upload that went with the link (null).
  async function commit(up, size, signal) {
    for (let tries = 0; ; tries++) {
      try {
        return await call("files.commit", { upload: up.upload });
      } catch (e) {
        if (tries && e?.code === "jobMissing") {
          const there = await call("files.stat", { path: up.path }).catch(() => null);
          return there && !there.dir && there.size === size ? { path: up.path } : null;
        }
        if (!LINK_GONE.has(e?.code) || tries >= RETRIES) throw e;
        await again(e, signal);
      }
    }
  }

  // ---------- changes there ----------
  // A new name in the same folder. A name that is taken: offer({ taken, next }) -> true takes "name (2)" (then (3)...),
  // false leaves it as it was (-> null).
  async function rename(from, dir, sep, name, { dir: isDir = false, offer = async () => false } = {}) {
    const wanted = checkName(name);
    let to = wanted;
    for (let n = 2; ; n++) {
      try {
        return await call("files.rename", { from, to: join(dir, sep, to) });
      } catch (e) {
        if (e?.code !== "exists" || n > TRIES) throw e;
        const next = numbered(wanted, n, isDir);
        if (!(await offer({ taken: to, next }))) return null;
        to = next;
      }
    }
  }
  // A new folder in a folder there; a name that is taken gets "name (2)" (the host's keep).
  const mkdir = (dir, sep, name) => call("files.mkdir", { path: join(dir, sep, checkName(name)), keep: true });
  // Into the bin there where it has one, else for good (host.info `trash` says which before).
  const remove = path => call("files.delete", { path });

  // A copy there, followed to its end: asked about every POLL_MS, sooner when the host says it ended ("files.job").
  // A lost link is waited out - the copy goes on there. signal: Stop - the copy is cancelled there (what it made is
  // removed, the source stays); detach: the phone stops following, the copy goes on.
  async function follow(start, { onProgress, signal, detach } = {}) {
    let job = start, wake = () => {};
    const off = provider.on("notify", ({ node: from, event, payload }) => {
      if (from === node && event === "files.job" && payload?.job === start.job) { job = payload; wake(); }
    });
    const onAbort = () => wake();
    signal?.addEventListener("abort", onAbort);
    detach?.addEventListener("abort", onAbort);
    try {
      while (job.state === "running") {
        onProgress?.(job);
        if (!signal?.aborted && !detach?.aborted) {
          await new Promise(resolve => { const timer = setTimeout(resolve, POLL_MS); wake = () => { clearTimeout(timer); resolve(); }; });
        }
        if (detach?.aborted) throw failure("detached");
        if (signal?.aborted) {
          // A cancel that does not reach the host (the link went) fails as such: the copy goes on there.
          job = await call("files.cancel", { job: start.job });
          if (job.state !== "done") throw failure("cancelled");
          break;
        }
        if (job.state !== "running") break;
        try {
          job = await call("files.job", { job: start.job });
        } catch (e) {
          if (!LINK_GONE.has(e?.code)) throw e;
        }
      }
    } finally {
      off();
      signal?.removeEventListener("abort", onAbort);
      detach?.removeEventListener("abort", onAbort);
    }
    onProgress?.(job);
    if (job.state === "failed") throw failure(job.error || "fileFailed");
    if (job.state === "cancelled") throw failure("cancelled");
    return { path: job.to, job };
  }

  // item { path, name, dir } copied (or moved: move) into the folder toDir there. A move is a rename where it can be -
  // at once, whatever the size - into a free name ("name (2)" when taken); to another drive (`crossDevice`) it is a
  // copy that removes the source once all of it is there. A move into the folder it is in changes nothing
  // ({ path, unchanged: true }); a copy there is "name (2)".
  async function transfer(item, toDir, sep, { move = false, ...opts } = {}) {
    if (!toDir) throw failure("invalidData");
    const to = join(toDir, sep, item.name);
    if (move) {
      const same = sep === "\\" ? to.toLowerCase() === item.path.toLowerCase() : to === item.path;
      if (same) return { path: item.path, unchanged: true };
      let target = to;
      for (let n = 2; ; n++) {
        try {
          return await call("files.rename", { from: item.path, to: target });
        } catch (e) {
          if (e?.code === "crossDevice") break;
          if (e?.code !== "exists" || n > TRIES) throw e;
          target = join(toDir, sep, numbered(item.name, n, item.dir));
        }
      }
    }
    stopped(opts.signal);
    const job = await call("files.copy", { from: item.path, to, move });
    return follow(job, opts);
  }

  return { canDownload: Boolean(plugin), get noKeep() { return noKeep(); }, folder, download, openFile, preview, upload, rename, mkdir, remove, transfer };
}

// ---------- a file a computer sends ----------
const OFFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWER_MS = 15000;
// The event's payload, checked: what the prompt shows must be a plain name and a real size, whatever a computer sent.
// The computer's name is not in it - the phone takes that from its own link. -> { offer, path, name, size, mtime } | null
export function checkOffer(p) {
  if (!p || typeof p !== "object") return null;
  if (typeof p.offer !== "string" || !OFFER_ID.test(p.offer)) return null;
  if (typeof p.path !== "string" || !p.path || p.path.length > 4096 || p.path.includes("\0")) return null;
  if (!Number.isSafeInteger(p.size) || p.size < 0 || (p.mtime !== undefined && !Number.isSafeInteger(p.mtime))) return null;
  let name;
  try { name = checkName(p.name); } catch { return null; }
  // Nor a character that is not seen but changes what is: one that turns the text round (U+202E) shows "gpj.exe" as
  // "exe.jpg", and the user is asked about a name the file does not have.
  if (name !== p.name || /[\x00-\x1f\x7f]/.test(name) || /[\p{Cf}\u2028\u2029]/u.test(name)) return null;
  return { offer: p.offer, path: p.path, name, size: p.size, mtime: p.mtime };
}

// The user's choice on an offer of computer `node`: save false - "declined", nothing read; no plugin - "failed" with
// needsApp, nothing read (and needsApp thrown); a plugin that keeps no file on this phone - "failed" with its reason
// the same way, the computer is never told "accepted" first; else "accepted", and only when the computer took it (an offer withdrawn
// or expired there is refused: that is thrown, nothing read) the download into Downloads, with the size and time the
// offer named - a file that changed since is refused - then "done", or "failed" with the code of what went wrong (Stop:
// cancelled). The answers after the choice are best effort: a link that went meanwhile loses them, the computer's
// row then says the phone went away.
// -> { state: "declined" } | { state: "done", file, shown, size }
export async function takeOffer({ provider, node, plugin = null, whenOnline = null, offer, save, onProgress, signal }) {
  const answer = (state, error) => provider.request(node, "files.answer", error ? { offer: offer.offer, state, error } : { offer: offer.offer, state }, { timeout: ANSWER_MS });
  if (!save) {
    await answer("declined").catch(() => {});
    return { state: "declined" };
  }
  const cannot = !plugin ? "needsApp" : typeof plugin.noKeep === "string" ? plugin.noKeep : "";
  if (cannot) {
    await answer("failed", cannot).catch(() => {});
    throw failure(cannot);
  }
  await answer("accepted");
  try {
    const got = await createRemoteFiles({ provider, node, plugin, whenOnline }).download(offer.path, offer.name, { onProgress, signal, expect: { size: offer.size, mtime: offer.mtime } });
    await answer("done").catch(() => {});
    return { state: "done", ...got };
  } catch (e) {
    const told = answer("failed", typeof e?.code === "string" && /^[A-Za-z0-9]{1,40}$/.test(e.code) ? e.code : "fileFailed").catch(() => {});
    // After Stop the user is not kept waiting for a link that stalled to carry the answer.
    await (e?.code === "cancelled" ? soon(told) : told);
    throw e;
  }
}
