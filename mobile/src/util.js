// Small helpers shared by the screens: DOM lookup and escaping, a tiny event emitter, keys, vibration.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Text going into HTML (innerHTML templates): always through esc().
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ESC[c]);

// on(event, fn) -> off(); emit(event, payload).
export function emitter() {
  const subs = new Map();
  return {
    on(event, fn) {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(subs.get(event) || [])]) {
        try { fn(payload); } catch (e) { console.error(`${event} handler failed`, e); }
      }
    }
  };
}

// A session's key across computers, as common.js sessionKey() builds it for remote sessions.
export const sessionKey = (node, agent, id) => `node:${node}:${agent}:${id}`;

// The project's folder name from a path (Windows or POSIX).
export const baseName = p => String(p || "").split(/[\\/]/).filter(Boolean).at(-1) || String(p || "");
export const normPath = p => String(p || "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

// The hue for a name, as the desktop colours projects (stable per name).
export function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

// Vibration where the WebView has it (Android); iOS has none (a haptics plugin later).
export function buzz(pattern = [60, 60, 120]) {
  try { navigator.vibrate?.(pattern); } catch {}
}

// Keys as the terminal wants them (xterm sends the same sequences).
export const KEYS = {
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  ctrlC: "\x03",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f"
};

export const debounce = (fn, ms) => {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
