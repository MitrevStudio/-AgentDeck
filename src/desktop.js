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
  // shell32/user32: Windows only. Elsewhere nothing is reported full screen and the session counts as local.
  if (process.platform !== "win32") return (api = null);
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    api = {
      notificationState: koffi.load("shell32.dll").func("long __stdcall SHQueryUserNotificationState(_Out_ int *state)"),
      systemMetrics: user32.func("int __stdcall GetSystemMetrics(int index)"),
      findWindow: user32.func("uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)"),
      windowRect: user32.func("bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t *rect)")
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

// The taskbar of the primary display and its notification area (the tray icons and the clock), in screen pixels:
// { bar, tray } with tray null when Windows has none to show; null without a taskbar.
function taskbar() {
  const f = native();
  if (!f) return null;
  const rect = hwnd => {
    const r = [0, 0, 0, 0];
    return hwnd && f.windowRect(hwnd, r) && r[2] > r[0] && r[3] > r[1] ? { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] } : null;
  };
  const shell = f.findWindow(0, 0, "Shell_TrayWnd", null);
  const bar = rect(shell);
  return bar ? { bar, tray: rect(f.findWindow(shell, 0, "TrayNotifyWnd", null)) } : null;
}

const remoteSession = () => Boolean(native()?.systemMetrics(SM_REMOTESESSION));

// Windows' "animation effects", except over Remote Desktop: there the switch follows the connection's experience
// settings (off unless the client asks for "menu and window animation"), not a choice of the user's, and the open
// effect is short enough to be worth its few frames.
const motionAllowed = () => !systemPreferences.getAnimationSettings().prefersReducedMotion || remoteSession();

module.exports = { fullScreenApp, taskbar, remoteSession, motionAllowed };
