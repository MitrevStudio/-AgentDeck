// Clicks on windows that never take focus. Before Windows delivers a press to a window that is not active, it asks
// that window (WM_MOUSEACTIVATE) whether to activate it, and whether to keep the press. Chromium answers for a
// `focusable: false` window "do not activate, and throw the press away" (MA_NOACTIVATEANDEAT), unless the widget asks
// for mouse events while inactive - which Electron gives no way to ask. Moves still arrive, so such a window shows
// hover and nothing else: no click, no drag.
//
// acceptClicks(win) subclasses the window to answer "do not activate" only (MA_NOACTIVATE): the press goes through,
// and the window still never takes focus from the one the user is working in. Main process only; the subclass goes
// with the window. koffi loads on first use; without it the window stays as it was.
const WM_MOUSEACTIVATE = 0x21;
const WM_NCDESTROY = 0x82;
const MA_NOACTIVATE = 3;
const SUBCLASS_ID = 0xadec;

let api; // undefined: not loaded yet; null: not available
function load() {
  if (api !== undefined) return api;
  try {
    const koffi = require("koffi");
    const comctl32 = koffi.load("comctl32.dll");
    const SUBCLASSPROC = koffi.proto("intptr_t __stdcall SUBCLASSPROC(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uintptr_t id, uintptr_t data)");
    const SetWindowSubclass = comctl32.func("bool __stdcall SetWindowSubclass(uintptr_t hwnd, SUBCLASSPROC *proc, uintptr_t id, uintptr_t data)");
    const RemoveWindowSubclass = comctl32.func("bool __stdcall RemoveWindowSubclass(uintptr_t hwnd, SUBCLASSPROC *proc, uintptr_t id)");
    const DefSubclassProc = comctl32.func("intptr_t __stdcall DefSubclassProc(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)");
    // One procedure for every window, registered for the life of the process (it must outlive each window).
    const proc = koffi.register((hwnd, msg, wParam, lParam) => {
      if (msg === WM_MOUSEACTIVATE) return MA_NOACTIVATE;
      if (msg === WM_NCDESTROY) RemoveWindowSubclass(hwnd, proc, SUBCLASS_ID);
      return DefSubclassProc(hwnd, msg, wParam, lParam);
    }, koffi.pointer(SUBCLASSPROC));
    api = { add: hwnd => SetWindowSubclass(hwnd, proc, SUBCLASS_ID, 0) };
  } catch (e) {
    console.error("Clicks on non-focusable windows are unavailable:", e.message);
    api = null;
  }
  return api;
}

// True when the window now takes clicks without taking focus.
function acceptClicks(win) {
  if (process.platform !== "win32" || !load()) return false;
  return Boolean(api.add(win.getNativeWindowHandle().readBigUInt64LE(0)));
}

module.exports = { acceptClicks };
