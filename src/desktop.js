// What the desktop is up to, for the edge handle, the edge menu and the taskbar strip: whether a full-screen app or a
// presentation has the screen, whether the menu may animate, where the taskbar is and how it looks, and when another
// window comes to the front. Main process only. koffi loads on first use; without it nothing is ever reported full
// screen, the session counts as local and there is no taskbar to speak of.
const { systemPreferences } = require("electron");

const SM_REMOTESESSION = 0x1000;
// SHQueryUserNotificationState: QUNS_BUSY (a full-screen app, or presentation settings), QUNS_RUNNING_D3D_FULL_SCREEN,
// QUNS_PRESENTATION_MODE.
const FULL_SCREEN = new Set([2, 3, 4]);
// SHAppBarMessage: the taskbar's state; APPBARDATA is 48 bytes on x64, its size first.
const ABM_GETSTATE = 4, ABS_AUTOHIDE = 1, APPBARDATA = 48;
// RegGetValueW: HKEY_CURRENT_USER, a DWORD only.
const HKCU = -2147483647, RRF_RT_REG_DWORD = 0x10;
const PERSONALIZE = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
// SetWinEventHook: the foreground window changed; delivered through this thread's own message loop, from other
// processes only.
const EVENT_SYSTEM_FOREGROUND = 3, WINEVENT_OUTOFCONTEXT = 0, WINEVENT_SKIPOWNPROCESS = 2;

let api;
function native() {
  if (api !== undefined) return api;
  // shell32/user32: Windows only. Elsewhere nothing is reported full screen and the session counts as local.
  if (process.platform !== "win32") return (api = null);
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const shell32 = koffi.load("shell32.dll");
    const WINEVENTPROC = koffi.proto("void __stdcall WINEVENTPROC(uintptr_t hook, uint32_t event, uintptr_t hwnd, int32_t object, int32_t child, uint32_t thread, uint32_t time)");
    api = {
      koffi, WINEVENTPROC,
      notificationState: shell32.func("long __stdcall SHQueryUserNotificationState(_Out_ int *state)"),
      systemMetrics: user32.func("int __stdcall GetSystemMetrics(int index)"),
      findWindow: user32.func("uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)"),
      windowRect: user32.func("bool __stdcall GetWindowRect(uintptr_t hwnd, _Out_ int32_t *rect)"),
      windowVisible: user32.func("bool __stdcall IsWindowVisible(uintptr_t hwnd)"),
      appBarMessage: shell32.func("uintptr_t __stdcall SHAppBarMessage(uint32_t message, void *data)"),
      regGetValue: koffi.load("advapi32.dll").func("int32_t __stdcall RegGetValueW(intptr_t key, str16 subKey, str16 value, uint32_t flags, void *type, _Out_ uint32_t *data, _Inout_ uint32_t *size)"),
      setWinEventHook: user32.func("uintptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, uintptr_t module, WINEVENTPROC *proc, uint32_t process, uint32_t thread, uint32_t flags)"),
      unhookWinEvent: user32.func("bool __stdcall UnhookWinEvent(uintptr_t hook)")
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

// Windows' main taskbar and its notification area (the tray icons and the clock), in screen pixels:
// { bar, tray, autoHide } with tray null when Windows has none to show, autoHide: the taskbar is set to hide itself
// (it then slides in and out; Windows 10 keeps its window two pixels on the screen meanwhile, so its place says
// little). null without a taskbar to see: Explorer is not running (or restarting), or the taskbar is not shown.
function taskbar() {
  const f = native();
  if (!f) return null;
  const rect = hwnd => {
    const r = [0, 0, 0, 0];
    return hwnd && f.windowRect(hwnd, r) && r[2] > r[0] && r[3] > r[1] ? { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] } : null;
  };
  const shell = f.findWindow(0, 0, "Shell_TrayWnd", null);
  const bar = shell && f.windowVisible(shell) ? rect(shell) : null;
  if (!bar) return null;
  const data = Buffer.alloc(APPBARDATA);
  data.writeUInt32LE(APPBARDATA, 0);
  return { bar, tray: rect(f.findWindow(shell, 0, "TrayNotifyWnd", null)), autoHide: Boolean(Number(f.appBarMessage(ABM_GETSTATE, data)) & ABS_AUTOHIDE) };
}

// Whether Windows itself (the taskbar, Start) is in light mode - its own switch, apart from the apps' mode that
// Electron reports (nativeTheme). Dark when the registry does not say.
function taskbarLight() {
  const f = native();
  if (!f) return false;
  const value = [0], size = [4];
  return f.regGetValue(HKCU, PERSONALIZE, "SystemUsesLightTheme", RRF_RT_REG_DWORD, null, value, size) === 0 && value[0] === 1;
}

// cb() whenever a window of another program comes to the front: a click on the taskbar, a switch of apps, an app
// going full screen. -> stop(), or null when Windows cannot be asked. A WinEvent hook, out of context: Windows queues
// the event for this thread, which runs the callback from its message loop - nothing waits for this process, and
// unlike a low-level input hook Windows never drops it when the thread was busy. One callback serves every listener,
// registered for the life of the process (Windows may still deliver an event queued before the unhook).
const foregroundListeners = new Set();
let foregroundProc = null;
function onForeground(cb) {
  const f = native();
  if (!f) return null;
  foregroundProc ??= f.koffi.register(() => { for (const fn of [...foregroundListeners]) try { fn(); } catch (e) { console.error(e); } }, f.koffi.pointer(f.WINEVENTPROC));
  const hook = f.setWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, foregroundProc, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
  if (!Number(hook)) return null;
  foregroundListeners.add(cb);
  return () => { foregroundListeners.delete(cb); f.unhookWinEvent(hook); };
}

const remoteSession = () => Boolean(native()?.systemMetrics(SM_REMOTESESSION));

// Windows' "animation effects", except over Remote Desktop: there the switch follows the connection's experience
// settings (off unless the client asks for "menu and window animation"), not a choice of the user's, and the open
// effect is short enough to be worth its few frames.
const motionAllowed = () => !systemPreferences.getAnimationSettings().prefersReducedMotion || remoteSession();

module.exports = { fullScreenApp, taskbar, taskbarLight, onForeground, remoteSession, motionAllowed };
