// The monitors as GDI numbers them, with their real sizes. desktopCapturer leaves display_id empty whenever it
// captures through GDI (Remote Desktop), and then its "screen:<n>:0" is this number; and an Electron display's
// bounds times its scale can be a pixel or two off. Windows only; koffi loads on first use.
const ATTACHED_TO_DESKTOP = 0x1;
const CURRENT_SETTINGS = 0xffffffff;
const DEVICES_MAX = 256;

let api = null;
function load() {
  if (api) return api;
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const device = koffi.struct({
    cb: "uint32", name: koffi.array("char16", 32), text: koffi.array("char16", 128),
    flags: "uint32", id: koffi.array("char16", 128), key: koffi.array("char16", 128)
  });
  // DEVMODEW as a display has it.
  const mode = koffi.struct({
    deviceName: koffi.array("char16", 32), specVersion: "uint16", driverVersion: "uint16", size: "uint16", driverExtra: "uint16",
    fields: "uint32", x: "int32", y: "int32", orientation: "uint32", fixedOutput: "uint32",
    color: "int16", duplex: "int16", yResolution: "int16", ttOption: "int16", collate: "int16",
    formName: koffi.array("char16", 32), logPixels: "uint16", bitsPerPel: "uint32",
    width: "uint32", height: "uint32", displayFlags: "uint32", frequency: "uint32", reserved: koffi.array("uint32", 8)
  });
  api = {
    enumDevices: user32.func("__stdcall", "EnumDisplayDevicesW", "bool", ["str16", "uint32", koffi.inout(koffi.pointer(device)), "uint32"]),
    enumSettings: user32.func("__stdcall", "EnumDisplaySettingsW", "bool", ["str16", "uint32", koffi.inout(koffi.pointer(mode))]),
    deviceSize: koffi.sizeof(device),
    modeSize: koffi.sizeof(mode)
  };
  return api;
}

// -> [{ sourceId, x, y, width, height }] in physical pixels.
function listMonitors() {
  const { enumDevices, enumSettings, deviceSize, modeSize } = load();
  const found = [];
  for (let n = 0; n < DEVICES_MAX; n++) {
    const device = { cb: deviceSize, name: "", text: "", flags: 0, id: "", key: "" };
    if (!enumDevices(null, n, device, 0)) break;
    if (!(device.flags & ATTACHED_TO_DESKTOP)) continue;
    const mode = {
      deviceName: "", specVersion: 0, driverVersion: 0, size: modeSize, driverExtra: 0, fields: 0, x: 0, y: 0,
      orientation: 0, fixedOutput: 0, color: 0, duplex: 0, yResolution: 0, ttOption: 0, collate: 0, formName: "",
      logPixels: 0, bitsPerPel: 0, width: 0, height: 0, displayFlags: 0, frequency: 0, reserved: new Array(8).fill(0)
    };
    if (enumSettings(device.name, CURRENT_SETTINGS, mode)) {
      found.push({ sourceId: `screen:${n}:0`, x: mode.x, y: mode.y, width: mode.width, height: mode.height });
    }
  }
  return found;
}

module.exports = { listMonitors };
