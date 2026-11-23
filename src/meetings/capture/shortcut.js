// The screenshot key, held only while a recording runs. RegisterHotKey through the voice's registry rather than
// globalShortcut, which fires again for as long as the key is held.
const DEFAULT_SHORTCUT = "Control+Shift+F9";
const MOD = { ALT: 1, CONTROL: 2, WIN: 8 };
const F1 = 0x70, F24 = 0x87;

// -> { close } or { code }: a key that another program or AgentDeck holds already is never taken quietly.
function registerShortcut(accelerator, onPress, { native = require("../../voice/native"), BrowserWindow = require("electron").BrowserWindow } = {}) {
  const parsed = native.parseAccelerator(accelerator);
  // As for the voice's keys: a bare key would swallow typing.
  const typing = parsed && !(parsed.mods & (MOD.ALT | MOD.CONTROL | MOD.WIN)) && (parsed.vk < F1 || parsed.vk > F24);
  if (!parsed || typing) return { code: "meetingsShortcutInvalid" };

  const win = new BrowserWindow({ show: false, width: 100, height: 100, skipTaskbar: true, focusable: false, title: "Meeting shortcut" });
  let hotkeys;
  try {
    hotkeys = native.createHotkeys(win);
    if (!hotkeys.register("screenshot", accelerator, onPress)) {
      win.destroy();
      return { code: "meetingsShortcutTaken" };
    }
  } catch (error) {
    win.destroy();
    throw error;
  }
  return {
    close() {
      hotkeys.unregisterAll();
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

module.exports = { DEFAULT_SHORTCUT, registerShortcut };
