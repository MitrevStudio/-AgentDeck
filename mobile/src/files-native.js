// The app's own `Files` plugin (docs/FILES.md 5.1; android/.../FilesPlugin.java, ios/App/App/FilesPlugin.swift): a file
// of the phone's that receives a download's bytes - in Downloads (Android) or through the system's "Save to Files /
// Share" sheet (iOS), or a temporary one for the system's viewer (a PDF) - so that 50 MB never sit in the page's
// memory. In the repository like Forward, SecureStore and Phone - no dependency. Apart from files.js, which is written
// against the plugin's contract and nothing of Capacitor, so that it runs in Node against a fake
// (scripts/test-mobile-files.js).
//
// nativeFiles() -> the plugin, or null where there is none: a browser (npm run dev), or an app whose native part is
// older than the page. With null nothing is downloaded and no PDF opened ("update the app"); text and pictures are
// still looked at, and uploading works.
import { Capacitor, registerPlugin } from "@capacitor/core";

const Files = registerPlugin("Files");
export const nativeFiles = () => (Capacitor.isNativePlatform?.() && Capacitor.isPluginAvailable?.("Files") ? Files : null);
