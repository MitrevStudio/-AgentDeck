// The capture pages' session, the recorder's own: what it allows, no other window gets.
const { openPage } = require("./hidden-page");

// Persistent, so that Chromium's device-id salt is kept and a remembered microphone still matches after a restart.
const PARTITION = "persist:meetings-recorder";

// The pages that are open: the device list can have one while another records, and the session is theirs together.
const pages = new Set();

function configure(session, contents) {
  pages.add(contents);
  contents.once("destroyed", () => pages.delete(contents));
  // getDisplayMedia asks for "media" with no media types at all, the microphone for "audio".
  session.setPermissionRequestHandler((wc, permission, answer, details) =>
    answer(pages.has(wc) && permission === "media" && (details?.mediaTypes || []).every(type => type === "audio")));
  session.setPermissionCheckHandler((_wc, permission, _origin, details) => permission === "media" && details?.mediaType !== "video");
  session.setDisplayMediaRequestHandler((request, answer) => {
    const ours = [...pages].some(page => !page.isDestroyed() && request.frame === page.mainFrame);
    answer(ours && request.audioRequested && !request.videoRequested ? { audio: "loopback" } : null);
  });
}

const openCapturePage = options => openPage({ html: "capture.html", partition: PARTITION, configure, ...options });

module.exports = { openCapturePage };
