// What the desktop is up to, for the edge handle and the edge menu: whether a full-screen app or a presentation has
// the screen, and whether the menu may animate. Main process only. koffi loads on first use; without it nothing is
// ever reported full screen and the session counts as local.
const { systemPreferences } = require("electron");

const SM_REMOTESESSION = 0x1000;
// SHQueryUserNotificationState: QUNS_BUSY (a full-screen app, or presentation settings), QUNS_RUNNING_D3D_FULL_SCREEN,
// QUNS_PRESENTATION_MODE.
const FULL_SCREEN = new Set([2, 3, 4]);

let api;
function native() {
  if (api !== undefined) return api;
  try {
    const koffi = require("koffi");
    api = {
      notificationState: koffi.load("shell32.dll").func("long __stdcall SHQueryUserNotificationState(_Out_ int *state)"),
      systemMetrics: koffi.load("user32.dll").func("int __stdcall GetSystemMetrics(int index)")
    };
  } catch (e) {
    console.error("Desktop state is not available:", e.message);
    api = null;
  }
  return api;
}

function fullScreenApp() {
  const f = native();
  if (!f) return false;
  const state = [0];
  return f.notificationState(state) === 0 && FULL_SCREEN.has(state[0]);
}

const remoteSession = () => Boolean(native()?.systemMetrics(SM_REMOTESESSION));

// Windows' "animation effects", except over Remote Desktop: there the switch follows the connection's experience
// settings (off unless the client asks for "menu and window animation"), not a choice of the user's, and the open
// effect is short enough to be worth its few frames.
const motionAllowed = () => !systemPreferences.getAnimationSettings().prefersReducedMotion || remoteSession();

module.exports = { fullScreenApp, remoteSession, motionAllowed };
