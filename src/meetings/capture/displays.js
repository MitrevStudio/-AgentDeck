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

// sourcesMs: for tests.
function createDisplays({ sourcesMs = SOURCES_MS } = {}) {
  function current() {
    const { screen } = require("electron");
    const primary = String(screen.getPrimaryDisplay().id);
    const at = m => screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: m.x + Math.floor(m.width / 2), y: m.y + Math.floor(m.height / 2) }));
    return matchDisplays(listMonitors(), screen.getAllDisplays(), at).map(d => ({ ...d, primary: d.id === primary }));
  }
  const getSources = thumbnailSize => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the screens did not answer")), sourcesMs);
    Promise.resolve()
      .then(() => require("electron").desktopCapturer.getSources({ types: ["screen"], thumbnailSize }))
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });

  async function list({ thumbnails = false } = {}) {
    const displays = current();
    // Pictures are extra: without them the displays can still be chosen.
    const sources = thumbnails ? await getSources(THUMBNAIL).catch(() => []) : [];
    return displays.map(({ sourceId, ...display }) => {
      const image = sourceOf(sources, { ...display, sourceId })?.thumbnail;
      return { ...display, thumbnail: image && !image.isEmpty() ? image.toDataURL() : null };
    });
  }

  // -> for each id: { id, width, height, bgra } or { id, code }. A size at a time: a thumbnail is scaled to fit the
  // box that was asked for, up as well as down.
  async function capture(ids) {
    const displays = current(), results = new Map(), bySize = new Map();
    for (const id of ids) {
      const display = displays.find(d => d.id === id);
      if (!display) {
        results.set(id, { id, code: "meetingsScreenMissing" });
        continue;
      }
      const size = `${display.width}x${display.height}`;
      if (!bySize.has(size)) bySize.set(size, []);
      bySize.get(size).push(display);
    }
    for (const group of bySize.values()) {
      const sources = await getSources({ width: group[0].width, height: group[0].height });
      for (const display of group) {
        const image = sourceOf(sources, display)?.thumbnail, id = display.id;
        const bgra = image && !image.isEmpty() ? image.toBitmap() : null;
        results.set(id, !bgra || isBlank(bgra) ? { id, code: "meetingsScreenBlank" } : { id, ...image.getSize(), bgra });
      }
    }
    return ids.map(id => results.get(id));
  }
  return { list, capture };
}

module.exports = { createDisplays, matchDisplays, sourceOf, isBlank };
