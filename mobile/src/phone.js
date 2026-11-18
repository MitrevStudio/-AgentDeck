// What an iPhone needs done differently, in one place. The page is the same on both systems; where Android's WebView
// and iOS's WKWebView part ways the answer is here (or named here, where it had to go into another file):
//
//   * no navigator.vibrate: buzz() (util.js) goes to the Taptic Engine through the app's own Phone plugin
//     (ios/App/App/PhonePlugin.swift);
//   * the clipboard: the page's own (navigator.clipboard) wants the touch to be on the very button and shows a
//     bubble to press before it reads - Copy and Paste in a terminal go through the plugin (the system pasteboard);
//   * a field with text smaller than 16 px is zoomed into when it takes the keyboard: the viewport says it may not;
//   * the keyboard does not make the page lower, it covers it: main.js trackViewport, style.css (.ios);
//   * the keyboard turns typing into print (curly quotes, long dashes): plainKeys, for what goes to a terminal;
//   * there is no Back button: a swipe from the left edge goes back in the page's history (ViewController.swift),
//     which is where main.js keeps its screens;
//   * the page is served from capacitor://localhost (Android: https://localhost); nothing in the app names either.
import { Capacitor, registerPlugin } from "@capacitor/core";
import { setHaptic } from "./util.js";

const Phone = registerPlugin("Phone");
export const isIos = Capacitor.getPlatform?.() === "ios";
const own = () => isIos && Boolean(Capacitor.isPluginAvailable?.("Phone"));

// Copy / Paste of a terminal: a failure is the caller's to show another way (a field to copy from or paste into).
export async function copyText(text) {
  if (own()) await Phone.copy({ text });
  else await navigator.clipboard.writeText(text);
}
export async function pasteText() {
  if (own()) return (await Phone.paste())?.text || "";
  return navigator.clipboard.readText();
}

// What the iPhone's keyboard made of the keys, as the keys were: straight quotes, hyphens, three dots.
const PRINT = { "‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"', "—": "--", "–": "-", "…": "..." };
export const plainKeys = text => text.replace(/[‘’‚“”„—–…]/g, c => PRINT[c]);

// Once, before anything is drawn. Nothing happens on Android or in a browser.
export function setupPhone() {
  if (!isIos) return;
  document.documentElement.classList.add("ios");
  const viewport = document.querySelector("meta[name='viewport']");
  if (viewport) viewport.content += ", maximum-scale=1";
  // A pattern (a session waits) is the notification's knock, a single short buzz a light tap.
  if (own()) setHaptic(pattern => { Phone.buzz({ strong: Array.isArray(pattern) }).catch(() => {}); });
}
