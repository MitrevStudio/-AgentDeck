// The platform layer voice runs on: win32.js (koffi, Win32) on Windows, wayland.js (Hyprland, wtype, wl-clipboard)
// on Linux under Hyprland. Both have the same interface; `supported()` tells whether voice can run here at all.
const platform = process.platform === "win32" ? "win32" : process.platform === "linux" ? "wayland" : null;
// Loaded on first use: win32.js loads user32.dll as it is required.
let mod;
const load = () => (mod ??= require(platform === "win32" ? "./win32" : "./wayland"));

function supported() {
  if (platform === "win32") return true;
  if (platform !== "wayland") return false;
  return require("../shared/hyprland").available();
}

module.exports = new Proxy({}, { get: (_, key) => (key === "supported" ? supported : key === "platform" ? platform : load()[key]) });
