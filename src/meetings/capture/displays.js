// The displays to choose from and their screenshots, through desktopCapturer. The pixels go to whoever asked and
// nowhere else.
const { listMonitors } = require("./monitors");

const THUMBNAIL = { width: 320, height: 200 };
const BLACK = 12; // of 255 in every colour
const SAMPLE_EVERY = 97; // pixels, not a divisor of the usual widths
const SOURCES_MS = 10_000; // a desktopCapturer that does not answer fails a screenshot or the pictures, nothing more

// monitors: monitors.js's; displays: Electron's; displayAt(monitor) -> the display a monitor is.
// Numbered left to right, then top to bottom.
function matchDisplays(monitors, displays, displayAt) {
  const byId = new Map(monitors.map(monitor => [String(displayAt(monitor)?.id), monitor]));
  return [...displays]
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((display, i) => {
      const monitor = byId.get(String(display.id));
      return {
        id: String(display.id), monitor: i + 1, label: display.label || "", bounds: { ...display.bounds },
        width: monitor?.width ?? Math.round(display.bounds.width * display.scaleFactor),
        height: monitor?.height ?? Math.round(display.bounds.height * display.scaleFactor),
        sourceId: monitor?.sourceId ?? null
      };
    });
}
// display_id is there with the DirectX capturer, the source's number is GDI's.
const sourceOf = (sources, display) =>
  sources.find(s => (s.display_id ? s.display_id === display.id : s.id === display.sourceId)) || null;

// A desktop that is not drawn comes as no picture at all or as a black one.
function isBlank(bgra) {
  for (let i = 0; i + 3 < bgra.length; i += SAMPLE_EVERY * 4) {
    if (bgra[i] > BLACK || bgra[i + 1] > BLACK || bgra[i + 2] > BLACK) return false;
  }
  return true;
}

// One enumeration by desktopCapturer, given up after ms: read(thumbnailSize) -> its sources. The error of one that
// did not answer says so (unanswered).
function sourcesWithin(read, thumbnailSize, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`the ${what} did not answer`), { unanswered: true })), ms);
    Promise.resolve().then(() => read(thumbnailSize)).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
// A thumbnail is scaled to fit the box that was asked for, up as well as down, so a picture is exact only when it is
// asked for at its own size. What shares a size shares one enumeration: -> [[{ width, height, ... }]].
function bySize(items) {
  const groups = new Map();
  for (const item of items) {
    const size = `${item.width}x${item.height}`;
    if (!groups.has(size)) groups.set(size, []);
    groups.get(size).push(item);
  }
  return [...groups.values()];
}
// -> { width, height, bgra }, null for no picture or a black one.
function pixelsOf(image) {
  const bgra = image && !image.isEmpty() ? image.toBitmap() : null;
  return !bgra || isBlank(bgra) ? null : { ...image.getSize(), bgra };
}

// sourcesMs: for tests.
function createDisplays({ sourcesMs = SOURCES_MS } = {}) {
  function current() {
    const { screen } = require("electron");
    const primary = String(screen.getPrimaryDisplay().id);
    const at = m => screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: m.x + Math.floor(m.width / 2), y: m.y + Math.floor(m.height / 2) }));
    return matchDisplays(listMonitors(), screen.getAllDisplays(), at).map(d => ({ ...d, primary: d.id === primary }));
  }
  const read = thumbnailSize => require("electron").desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
  const getSources = thumbnailSize => sourcesWithin(read, thumbnailSize, sourcesMs, "screens");

  async function list({ thumbnails = false } = {}) {
    const displays = current();
    // Pictures are extra: without them the displays can still be chosen.
    const sources = thumbnails ? await getSources(THUMBNAIL).catch(() => []) : [];
    return displays.map(({ sourceId, ...display }) => {
      const image = sourceOf(sources, { ...display, sourceId })?.thumbnail;
      return { ...display, thumbnail: image && !image.isEmpty() ? image.toDataURL() : null };
    });
  }

  // -> for each id: { id, width, height, bgra } or { id, code }. A size at a time (bySize).
  async function capture(ids) {
    const displays = current(), results = new Map(), connected = [];
    for (const id of ids) {
      const display = displays.find(d => d.id === id);
      if (display) connected.push(display);
      else results.set(id, { id, code: "meetingsScreenMissing" });
    }
    for (const group of bySize(connected)) {
      const sources = await getSources({ width: group[0].width, height: group[0].height });
      for (const display of group) {
        const id = display.id, picture = pixelsOf(sourceOf(sources, display)?.thumbnail);
        results.set(id, picture ? { id, ...picture } : { id, code: "meetingsScreenBlank" });
      }
    }
    return ids.map(id => results.get(id));
  }
  return { list, capture };
}

module.exports = { createDisplays, matchDisplays, sourceOf, isBlank, sourcesWithin, bySize, pixelsOf };
