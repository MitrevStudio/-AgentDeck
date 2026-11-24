// A press of the key as files in the meeting: a PNG a display and a PNG a chosen window, named and stamped by the
// recording's clock.
const { pad } = require("../../shared/util");
const { encodePng } = require("./png");

// kind: "m" a monitor, "w" a window.
function screenName(atMs, number, taken, kind = "m") {
  const s = Math.floor(atMs / 1000);
  const stem = `screens/${pad(Math.floor(s / 3600))}-${pad(Math.floor(s / 60) % 60)}-${pad(s % 60)}-${kind}${number}`;
  let name = `${stem}.png`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.png`; // twice in one second
  taken.add(name);
  return name;
}

// A monitor before a window, each by its number.
const order = screen => (screen.monitor ?? 1000 + screen.window);
const byTime = (a, b) => a.atMs - b.atMs || order(a) - order(b);

// What one source is in meeting.json.
const about = ({ monitor, window, title }) => (monitor ? { monitor } : { window, title });

// One kind's pictures: -> for each source a picture or { code }. Never rejects. ask(source): what the capturer takes
// for it.
async function pictures(capturer, sources, ask) {
  if (!sources.length) return [];
  try {
    return await capturer.capture(sources.map(ask));
  } catch (error) {
    console.error("A screenshot could not be taken:", error);
    return sources.map(() => ({ code: "meetingsScreenFailed" }));
  }
}

// monitors: [{ id, monitor }] for displays (displays.js); chosen: [{ id, window, title, owner }] for windows (windows.js);
// taken: the names this recording has used; late() -> true once the recording was saved without it, and nothing more
// is written. Never rejects: -> { screens, failed }, failed: [{ monitor | window, code }].
async function takeScreenshot({ store, displays, windows, project, id, monitors = [], chosen = [], atMs, taken, late = () => false }) {
  const screens = [], failed = [];
  async function save(source, picture) {
    const what = about(source), where = source.monitor ? { monitor: source.monitor } : { window: source.window };
    if (!picture || picture.code || late()) {
      failed.push({ ...where, code: picture?.code || "meetingsScreenFailed" });
      return;
    }
    try {
      const file = source.monitor ? screenName(atMs, source.monitor, taken) : screenName(atMs, source.window, taken, "w");
      const screen = { file, atMs, ...what };
      const png = await encodePng(picture);
      if (late()) {
        taken.delete(file);
        failed.push({ ...where, code: "meetingsScreenFailed" });
        return;
      }
      await store.write(project, id, file, png);
      await store.update(project, id, m => ({ screens: [...m.screens, screen].sort(byTime) }));
      screens.push(screen);
    } catch (error) {
      console.error("A screenshot could not be saved:", error.message);
      failed.push({ ...where, code: error.code === "meetingsDiskFull" ? error.code : "meetingsScreenFailed" });
    }
  }
  // Each picture is saved before the next is waited for: a window that does not answer costs the ones before it
  // nothing, also when the recording ends meanwhile.
  const shown = await pictures(displays, monitors, source => source.id);
  for (const [i, source] of monitors.entries()) await save(source, shown[i]);
  for (const source of chosen) await save(source, (await pictures(windows, [source], ({ id, owner }) => ({ id, owner })))[0]);
  return { screens, failed };
}

module.exports = { screenName, takeScreenshot, byTime };
