// The app's own `Files` plugin (docs/FILES.md 5.1; android/.../FilesPlugin.java, ios/App/App/FilesPlugin.swift): a file
// of the phone's that receives a download's bytes - in Downloads (Android) or through the system's "Save to Files /
// Share" sheet (iOS), or a temporary one for the system's viewer (a PDF) - so that 50 MB never sit in the page's
// memory. In the repository like Forward, SecureStore and Phone - no dependency. Apart from files.js, which is written
// against the plugin's contract and nothing of Capacitor, so that it runs in Node against a fake
// (scripts/test-mobile-files.js).
//
// nativeFiles() -> the plugin as files.js takes it, or null where there is none: a browser (npm run dev), or an app
// whose native part is older than the page. With null nothing is downloaded and no PDF opened ("update the app"); text
// and pictures are still looked at, and uploading works.
// What files.js takes: the plugin's five calls and `noKeep` - "" while a file can be kept on this phone, else the code
// of why not ("needsAndroid10": an Android older than 10, where Downloads takes a permission the app does not ask
// for). The plugin is asked once (canKeep() -> { keep, reason }), the first time it is wanted - main.js wants it as
// the app starts, so the answer is there long before a file is. A native part without canKeep keeps files as before.
import { Capacitor, registerPlugin } from "@capacitor/core";

const Files = registerPlugin("Files");
const native = {
  begin: args => Files.begin(args),
  write: args => Files.write(args),
  finish: args => Files.finish(args),
  open: args => Files.open(args),
  cancel: args => Files.cancel(args),
  noKeep: ""
};
let asked = false;
function ask() {
  if (asked) return;
  asked = true;
  Promise.resolve().then(() => Files.canKeep()).then(r => {
    if (r?.keep === false) native.noKeep = typeof r.reason === "string" && r.reason ? r.reason : "needsAndroid10";
  }).catch(() => {});
}
export function nativeFiles() {
  if (!Capacitor.isNativePlatform?.() || !Capacitor.isPluginAvailable?.("Files")) return null;
  ask();
  return native;
}
