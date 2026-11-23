// A meeting's sound and screenshots for the window: agentdeck-meeting://<token>/audio/mic.webm, .../screens/<name>.png.
// The token is handed out with the opened meeting (ipc.js) and stands for that one meeting: an address holds no path,
// and every request is looked up through the store again, which refuses links and any other name.
const fs = require("node:fs");
const crypto = require("node:crypto");
const { protocol } = require("electron");
const { isScreen } = require("./meeting");

const SCHEME = "agentdeck-meeting";
const CHUNK_BYTES = 256 * 1024;
const AUDIO = ["audio/mic.webm", "audio/system.webm"];

// Before app ready, and once: Electron takes one list of schemes.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, stream: true } }]);
}

// The bytes a Range header asks for of a file of `size`, inclusive; null for what cannot be answered.
function rangeOf(header, size) {
  if (!header) return { from: 0, to: size - 1 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  const from = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const to = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  return from <= to ? { from, to } : null;
}

// file(project, id, name) -> the path of a meeting's file, or a rejection.
function createMedia({ file }) {
  const shared = new Map(); // token -> { key, project, id, open: Map of streams' close() -> the file's name }
  const byKey = new Map();  // key -> token: one address for a meeting, so a page drawn again keeps its pictures

  function baseUrl(key, project, id) {
    let token = byKey.get(key);
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      byKey.set(key, token);
      shared.set(token, { key, project, id, open: new Map() });
    }
    return `${SCHEME}://${token}/`;
  }

  // Windows moves nothing to the Recycle Bin while it is being read. names: the files that go, all when left out;
  // the rest play on.
  async function release(key, names = null) {
    const entry = shared.get(byKey.get(key));
    if (entry) await Promise.all([...entry.open].filter(([, name]) => !names || names.includes(name)).map(([close]) => close()));
  }

  async function answer(request) {
    const { hostname, pathname } = new URL(request.url);
    const entry = shared.get(hostname), name = pathname.slice(1);
    if (!entry || request.method !== "GET" || !(AUDIO.includes(name) || isScreen(name))) return new Response(null, { status: 404 });
    const handle = await fs.promises.open(await file(entry.project, entry.id, name), "r");
    const close = () => {
      entry.open.delete(close);
      return handle.close().catch(() => {});
    };
    entry.open.set(close, name);
    try {
      const { size } = await handle.stat();
      const asked = request.headers.get("range"), range = size ? rangeOf(asked, size) : null;
      if (!range) {
        await close();
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      let at = range.from;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const buffer = new Uint8Array(Math.min(CHUNK_BYTES, range.to + 1 - at));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, at);
            at += bytesRead;
            if (bytesRead) controller.enqueue(buffer.subarray(0, bytesRead));
            if (!bytesRead || at > range.to) {
              await close();
              controller.close();
            }
          } catch (error) {
            await close();
            try { controller.error(error); } catch { /* cancelled meanwhile */ }
          }
        },
        cancel: close
      });
      return new Response(body, {
        status: asked ? 206 : 200,
        headers: {
          "content-type": name.endsWith(".png") ? "image/png" : "audio/webm",
          "content-length": String(range.to + 1 - range.from),
          "accept-ranges": "bytes",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          ...(asked && { "content-range": `bytes ${range.from}-${range.to}/${size}` })
        }
      });
    } catch (error) {
      await close();
      throw error;
    }
  }

  // Once the app is ready.
  function serve() {
    protocol.handle(SCHEME, request => answer(request).catch(() => new Response(null, { status: 404 })));
  }

  return { baseUrl, release, serve };
}

module.exports = { SCHEME, AUDIO, registerScheme, createMedia };
