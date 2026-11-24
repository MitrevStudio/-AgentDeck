// The windows to choose from and their screenshots, through desktopCapturer: a window is taken whole also while
// another covers it, and not at all while it is minimised. The pixels go to whoever asked and nowhere else.
// Windows only; koffi loads on first use.
const { HIDDEN } = require("../text");
const { sourcesWithin, bySize, pixelsOf } = require("./displays");

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

const titleOf = source => Array.from(String(source.name || "").replace(HIDDEN, " ").trim()).slice(0, TITLE_MAX).join("");

// The rest of the options: for tests.
function createWindows({ sourcesMs = SOURCES_MS, sizeOf = windowSize, ownerOf = sizeOf === windowSize ? windowOwner : () => 0, own = ownWindows, sources: read } = {}) {
  const getSources = read || (thumbnailSize => require("electron").desktopCapturer.getSources({ types: ["window"], thumbnailSize }));
  const sources = thumbnailSize => sourcesWithin(getSources, thumbnailSize, sourcesMs, "windows");

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

  // -> [{ id, title, thumbnail, owner }], as the system orders them (the front one first). owner: the process a
  // window belongs to now, which is for whoever chooses it to keep and give back to capture().
  async function list({ thumbnails = false } = {}) {
    const ours = new Set(own());
    return (await sources(thumbnails ? THUMBNAIL : NO_PICTURE))
      .filter(source => isWindowId(source.id) && !ours.has(source.id) && titleOf(source) && takable(source.id))
      .map(source => ({
        id: source.id, title: titleOf(source), owner: owner(source.id),
        thumbnail: thumbnails && source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : null
      }));
  }

  // chosen: [{ id, owner }], the owner as list() gave it when the window was chosen; nothing here remembers it, so no
  // later list() can loosen it. Yields for each, as it is known, { id, width, height, bgra } or { id, code }.
  //
  // An enumeration brings every open window at the one size it was asked for, so the windows of a press are asked for
  // a size at a time (bySize): once when they share one. What can be said without a picture is said first. Whoever
  // reads this is handed a size's pictures before the next size is asked for, so what has come is never held back by
  // what has not. A size that fails fails alone; after one that did not answer no other is asked for, so a press
  // waits for at most one unanswered enumeration (sourcesMs).
  //
  // A handle is the chosen window only in its owner's hands: before the picture is asked for, and again when it has
  // come, as the handle may pass on while it is waited for.
  async function* capture(chosen) {
    const taken = [];
    for (const { id, owner: whose } of chosen) {
      let size = null;
      try {
        size = isWindowId(id) ? sizeOf(id) : null;
      } catch (error) {
        console.error("A window could not be taken:", error.message);
        yield { id, code: "meetingsScreenFailed" };
        continue;
      }
      if (!size || owner(id) !== whose) yield { id, code: "meetingsWindowMissing" };
      else if (size.minimized) yield { id, code: "meetingsWindowBlank" };
      else taken.push({ id, whose, width: size.width, height: size.height });
    }
    let unanswered = false;
    for (const group of bySize(taken)) {
      let found = null;
      if (!unanswered) {
        try {
          found = await sources({ width: group[0].width, height: group[0].height });
        } catch (error) {
          console.error("Windows could not be taken:", error.message);
          unanswered = error.unanswered === true;
        }
      }
      // Whose each is, all of them now: the next one is only come to when this one's picture is saved.
      const theirs = found ? group.map(({ id, whose }) => (owner(id) === whose ? found.find(s => s.id === id) : null)) : [];
      for (const [i, { id }] of group.entries()) {
        if (!found) yield { id, code: "meetingsScreenFailed" };
        else if (!theirs[i]) yield { id, code: "meetingsWindowMissing" };
        else yield pictured(id, theirs[i].thumbnail);
      }
    }
  }
  function pictured(id, image) {
    try {
      const picture = pixelsOf(image);
      return picture ? { id, ...picture } : { id, code: "meetingsWindowBlank" };
    } catch (error) {
      console.error("A window could not be taken:", error.message);
      return { id, code: "meetingsScreenFailed" };
    }
  }
  return { list, capture };
}

module.exports = { createWindows, isWindowId, TITLE_MAX };
