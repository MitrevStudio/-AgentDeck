// A press of the key as files in the meeting: a PNG a display, named and stamped by the recording's clock.
const { pad } = require("../../shared/util");
const { encodePng } = require("./png");

function screenName(atMs, monitor, taken) {
  const s = Math.floor(atMs / 1000);
  const stem = `screens/${pad(Math.floor(s / 3600))}-${pad(Math.floor(s / 60) % 60)}-${pad(s % 60)}-m${monitor}`;
  let name = `${stem}.png`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.png`; // twice in one second
  taken.add(name);
  return name;
}

// monitors: [{ id, monitor }]; taken: the names this recording has used; late() -> true once the recording was saved
// without it, and nothing more is written. Never rejects: -> { screens, failed }.
async function takeScreenshot({ store, displays, project, id, monitors, atMs, taken, late = () => false }) {
  const screens = [], failed = [];
  let pictures;
  try {
    pictures = await displays.capture(monitors.map(m => m.id));
  } catch (error) {
    console.error("A screenshot could not be taken:", error);
    return { screens, failed: monitors.map(({ monitor }) => ({ monitor, code: "meetingsScreenFailed" })) };
  }
  for (const [i, { monitor }] of monitors.entries()) {
    const picture = pictures[i];
    if (picture.code || late()) {
      failed.push({ monitor, code: picture.code || "meetingsScreenFailed" });
      continue;
    }
    try {
      const file = screenName(atMs, monitor, taken);
      await store.write(project, id, file, await encodePng(picture));
      await store.update(project, id, m => ({
        screens: [...m.screens, { file, atMs, monitor }].sort((a, b) => a.atMs - b.atMs || a.monitor - b.monitor)
      }));
      screens.push({ file, atMs, monitor });
    } catch (error) {
      console.error("A screenshot could not be saved:", error.message);
      failed.push({ monitor, code: error.code === "meetingsDiskFull" ? error.code : "meetingsScreenFailed" });
    }
  }
  return { screens, failed };
}

module.exports = { screenName, takeScreenshot };
