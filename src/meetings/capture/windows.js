// The windows to choose from and their screenshots, through desktopCapturer: a window is taken whole also while
// another covers it, and not at all while it is minimised. The pixels go to whoever asked and nowhere else.
// Windows only; koffi loads on first use.
const { isBlank } = require("./displays");

const THUMBNAIL = { width: 320, height: 200 };
const NO_PICTURE = { width: 0, height: 0 };
const SOURCES_MS = 10_000;
const SOURCE = /^window:(\d{1,20}):\d{1,10}$/; // desktopCapturer's id: the HWND, then a number of its own
const TITLE_MAX = 200;
const EXTENDED_FRAME_BOUNDS = 9; // without the invisible border GetWindowRect counts in

const isWindowId = id => typeof id === "string" && SOURCE.test(id);

let api = null;
function load() {
  if (api) return api;
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll"), dwmapi = koffi.load("dwmapi.dll");
  const rect = koffi.struct({ left: "int32", top: "int32", right: "int32", bottom: "int32" });
  api = {
    isWindow: user32.func("__stdcall", "IsWindow", "bool", ["intptr_t"]),
    isIconic: user32.func("__stdcall", "IsIconic", "bool", ["intptr_t"]),
    processOf: user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", ["intptr_t", koffi.out(koffi.pointer("uint32"))]),
    windowRect: user32.func("__stdcall", "GetWindowRect", "bool", ["intptr_t", koffi.out(koffi.pointer(rect))]),
    frameBounds: dwmapi.func("__stdcall", "DwmGetWindowAttribute", "int32", ["intptr_t", "uint32", koffi.out(koffi.pointer(rect)), "uint32"]),
    rectSize: koffi.sizeof(rect)
  };
  return api;
}

// -> null when the window is gone, { minimized: true }, or { width, height } in physical pixels.
function windowSize(id) {
  const handle = Number(SOURCE.exec(id)?.[1]);
  if (!Number.isSafeInteger(handle) || !handle) return null;
  const { isWindow, isIconic, windowRect, frameBounds, rectSize } = load();
  if (!isWindow(handle)) return null;
  if (isIconic(handle)) return { minimized: true };
  const rect = {};
  if (frameBounds(handle, EXTENDED_FRAME_BOUNDS, rect, rectSize) !== 0 && !windowRect(handle, rect)) return null;
  const width = rect.right - rect.left, height = rect.bottom - rect.top;
  return width > 0 && height > 0 ? { width, height } : { minimized: true };
}

// -> the id of the process the window belongs to, 0 when it is gone. A handle is given out again once its window
// is closed: the same handle of another process is another window.
function windowOwner(id) {
  const handle = Number(SOURCE.exec(id)?.[1]);
  if (!Number.isSafeInteger(handle) || !handle) return 0;
  const owner = [0];
  return load().processOf(handle, owner) ? owner[0] : 0;
}

// Our own windows are not offered: the meeting is not in them.
function ownWindows() {
  return require("electron").BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => w.getMediaSourceId());
}

const titleOf = source => Array.from(String(source.name || "").replace(/[\p{Cc}‪-‮⁦-⁩]/gu, " ").trim()).slice(0, TITLE_MAX).join("");

// The rest of the options: for tests.
function createWindows({ sourcesMs = SOURCES_MS, sizeOf = windowSize, ownerOf = sizeOf === windowSize ? windowOwner : () => 0, own = ownWindows, sources: read } = {}) {
  const owners = new Map(); // whose each window was when it was last offered
  const getSources = read || (thumbnailSize => require("electron").desktopCapturer.getSources({ types: ["window"], thumbnailSize }));
  const sources = thumbnailSize => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the windows did not answer")), sourcesMs);
    Promise.resolve().then(() => getSources(thumbnailSize)).then(resolve, reject).finally(() => clearTimeout(timer));
  });

  // A minimised window gives no picture, so it is not offered; one whose size cannot be asked for is.
  function owner(id) {
    try {
      return ownerOf(id);
    } catch {
      return 0;
    }
  }
  function takable(id) {
    try {
      const size = sizeOf(id);
      return Boolean(size) && !size.minimized;
    } catch {
      return true;
    }
  }

  // -> [{ id, title, thumbnail }], as the system orders them (the front one first).
  async function list({ thumbnails = false } = {}) {
    const ours = new Set(own());
    const open = (await sources(thumbnails ? THUMBNAIL : NO_PICTURE))
      .filter(source => isWindowId(source.id) && !ours.has(source.id) && titleOf(source) && takable(source.id));
    owners.clear();
    for (const source of open) owners.set(source.id, owner(source.id));
    return open
      .map(source => ({
        id: source.id, title: titleOf(source),
        thumbnail: thumbnails && source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null
      }));
  }

  // -> for each id: { id, width, height, bgra } or { id, code }. A window at a time: a thumbnail is scaled to fit the
  // box that was asked for, so each is asked for at its own size. What one window fails with is its own.
  async function capture(ids) {
    const results = [];
    for (const id of ids) {
      try {
        results.push(await captureOne(id));
      } catch (error) {
        console.error("A window could not be taken:", error.message);
        results.push({ id, code: "meetingsScreenFailed" });
      }
    }
    return results;
  }
  async function captureOne(id) {
    const size = isWindowId(id) ? sizeOf(id) : null;
    // Whose it was when it was offered; the handle may pass to another process while the picture is waited for too.
    const whose = owners.has(id) ? owners.get(id) : owner(id);
    if (!size || owner(id) !== whose) return { id, code: "meetingsWindowMissing" };
    if (size.minimized) return { id, code: "meetingsWindowBlank" };
    const source = (await sources({ width: size.width, height: size.height })).find(s => s.id === id);
    if (!source || owner(id) !== whose) return { id, code: "meetingsWindowMissing" };
    const image = source.thumbnail, bgra = image && !image.isEmpty() ? image.toBitmap() : null;
    if (!bgra || isBlank(bgra)) return { id, code: "meetingsWindowBlank" };
    return { id, ...image.getSize(), bgra };
  }
  return { list, capture };
}

module.exports = { createWindows, isWindowId, TITLE_MAX };
