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
// offered and say "needsApp"; looking at text and pictures and uploading work all the same.
//
// What must never happen: a file on the phone put together from two versions (the size and time the first piece of a
// download answered go back with every later one, and the host refuses a file that is no longer that one: `changed`;
// the phone's unfinished file is then cancelled), a piece asked for before the last one came (one request in flight:
// a piece is up to 256 KB, the link also carries the terminals), and an upload left half there (it is aborted, which
// removes the host's `.agentdeck-part`). Nothing is written over: the host gives a copy, an upload and a moved thing
// whose name is taken "name (2)"; a rename whose name is taken is offered "name (2)" here.
//
// createRemoteFiles({ provider, node, plugin }) - provider: request(node, method, params, { timeout }) and
//   on("notify", fn) (provider-relay.js); plugin: the `Files` plugin, or null ->
//   canDownload; folder(path, order?) -> a Folder (below; order: { sort, desc, filter } - ORDERS); download(path, name, opts) -> { file, shown, size } (opts.expect:
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

export const failure = (code, message = code) => Object.assign(new Error(message), { code });
const stopped = signal => { if (signal?.aborted) throw failure("cancelled"); };

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
export function tapAction(entry, { canDownload = false } = {}) {
  if (entry.dir) return "open";
  const kind = kindOf(entry.name);
  if ((kind === "text" || kind === "markdown") && entry.size <= TEXT_MAX) return "view";
  if (kind === "image" && entry.size <= IMAGE_MAX) return "view";
  if (!canDownload) return "needsApp";
  return kind === "pdf" ? "pdf" : "download";
}
// What the sheet of an entry offers, in order. Only files come to the phone (docs/FILES.md 1: no folders through the
// system's picker or Downloads); in the list of the roots (the drives) nothing is offered - a drive is neither copied,
// moved, renamed nor deleted.
export function actionsFor(entry, { canDownload = false, atRoots = false } = {}) {
  if (atRoots) return [];
  return [entry.dir ? "" : canDownload ? "download" : "needsApp", "copy", "move", "rename", "delete"].filter(Boolean);
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
export function createRemoteFiles({ provider, node, plugin = null }) {
  const call = (method, params, timeout = 30000) => provider.request(node, method, params, { timeout });

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
  async function readPieces(path, take, { onProgress, signal, max = Infinity, first, expect } = {}) {
    let pos = 0, size, mtime, begun = false;
    for (;;) {
      stopped(signal);
      const known = begun ? { size, mtime } : expect ? { size: expect.size, mtime: expect.mtime } : null;
      const r = await call("files.read", known ? { path, pos, len: CHUNK, ...known } : { path, pos, len: CHUNK }, PIECE_MS);
      stopped(signal);
      if (!begun) {
        begun = true;
        ({ size, mtime } = r);
        if (size > max) throw failure("tooBigToView");
        await first?.(r);
      }
      const n = base64Bytes(r.data);
      if (n > CHUNK || (!n && !r.eof)) throw failure("fileFailed");
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
  // A PDF (or another file the system has a viewer for): a temporary file, then the system's viewer on it.
  async function openFile(path, name, { type = "application/pdf", ...opts } = {}) {
    const r = await download(path, name, { ...opts, keep: false });
    await plugin.open({ file: r.file, type });
    return r;
  }

  // A file read whole for a look at it here: text and markdown up to TEXT_MAX (decoded as UTF-8), a picture up to
  // IMAGE_MAX (a Blob of its type, for a blob: URL). A file over the cap is refused before anything is read.
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
  async function upload(dir, sep, blob, name, { onProgress, signal } = {}) {
    if (!dir) throw failure("invalidData");
    const size = blob.size;
    stopped(signal);
    const up = await call("files.begin", { path: join(dir, sep, checkName(name)), size });
    try {
      for (let pos = 0; pos < size;) {
        stopped(signal);
        const bytes = new Uint8Array(await blob.slice(pos, Math.min(size, pos + CHUNK)).arrayBuffer());
        if (!bytes.length) throw failure("fileFailed"); // the phone's file is shorter than it said
        stopped(signal);
        await call("files.write", { upload: up.upload, pos, data: toBase64(bytes) }, PIECE_MS);
        pos += bytes.length;
        onProgress?.({ bytes: pos, total: size });
      }
      stopped(signal);
      return await call("files.commit", { upload: up.upload });
    } catch (e) {
      await call("files.abort", { upload: up.upload }).catch(() => {});
      throw e;
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

  return { canDownload: Boolean(plugin), folder, download, openFile, preview, upload, rename, mkdir, remove, transfer };
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
  if (name !== p.name || /[\x00-\x1f\x7f]/.test(name)) return null;
  return { offer: p.offer, path: p.path, name, size: p.size, mtime: p.mtime };
}

// The user's choice on an offer of computer `node`: save false - "declined", nothing read; no plugin - "failed" with
// needsApp, nothing read (and needsApp thrown); else "accepted", and only when the computer took it (an offer withdrawn
// or expired there is refused: that is thrown, nothing read) the download into Downloads, with the size and time the
// offer named - a file that changed since is refused - then "done", or "failed" with the code of what went wrong (Stop:
// cancelled). The answers after the choice are best effort: a link that went meanwhile loses them, the computer's
// row then says the phone went away.
// -> { state: "declined" } | { state: "done", file, shown, size }
export async function takeOffer({ provider, node, plugin = null, offer, save, onProgress, signal }) {
  const answer = (state, error) => provider.request(node, "files.answer", error ? { offer: offer.offer, state, error } : { offer: offer.offer, state }, { timeout: ANSWER_MS });
  if (!save) {
    await answer("declined").catch(() => {});
    return { state: "declined" };
  }
  if (!plugin) {
    await answer("failed", "needsApp").catch(() => {});
    throw failure("needsApp");
  }
  await answer("accepted");
  try {
    const got = await createRemoteFiles({ provider, node, plugin }).download(offer.path, offer.name, { onProgress, signal, expect: { size: offer.size, mtime: offer.mtime } });
    await answer("done").catch(() => {});
    return { state: "done", ...got };
  } catch (e) {
    await answer("failed", typeof e?.code === "string" && /^[A-Za-z0-9]{1,40}$/.test(e.code) ? e.code : "fileFailed").catch(() => {});
    throw e;
  }
}
