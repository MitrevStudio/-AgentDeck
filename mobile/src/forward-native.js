// The app's own `Forward` plugin (docs/PORT-FORWARDING.md 4.1; android/.../ForwardPlugin.java, ios/App/App/
// ForwardPlugin.swift): TCP listeners on the phone's 127.0.0.1 and the web view a forwarded page opens in. In the
// repository like SecureStore and Phone - no dependency. Apart from forward.js, which is written against the plugin's
// contract and nothing of Capacitor, so that it runs in Node against a fake (scripts/test-mobile-forward.js).
//
// nativeForward() -> the plugin, or null where there is none: a browser (npm run dev), or an app whose native part
// is older than the page. With null nothing of forwarded ports is offered.
import { Capacitor, registerPlugin } from "@capacitor/core";

const Forward = registerPlugin("Forward");
export const nativeForward = () => (Capacitor.isNativePlatform?.() && Capacitor.isPluginAvailable?.("Forward") ? Forward : null);
