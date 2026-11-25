// Inline SVG icons (stroke, currentColor). Where the desktop has the icon (src/common.js ICONS) it is the same
// drawing; the rest are drawn in the same line style (24 grid, 2px stroke, round ends).
import { esc } from "./util.js";

const P = {
  back: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  computer: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5"/><path d="M13 6h8M13 12h6M13 18h3"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/>',
  // A new terminal (a shell in a folder): the terminal with a plus where its cursor line is.
  termPlus: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6.5 9.5 2.5 2.5-2.5 2.5"/><path d="M15 9.5v5M12.5 12h5"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  // The terminal's tools.
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>',
  chat: '<path d="M4 5h16v11H9.5L4 20z"/><path d="M8 9h8M8 12.5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 18 5.5-5.5 4 4 2.5-2.5 4 4"/>',
  camera: '<path d="M4 8h3.2l1.8-3h6l1.8 3H20v11H4z"/><circle cx="12" cy="13" r="3.4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  swap: '<path d="M4 8h13"/><path d="m14 5 3 3-3 3"/><path d="M20 16H7"/><path d="m10 13-3 3 3 3"/>',
  insert: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  minus: '<path d="M5 12h14"/>',
  textSize: '<path d="m3 18 5-12 5 12"/><path d="M5 14h6"/><path d="m14 18 3.5-8 3.5 8"/><path d="M15.2 15.5h4.6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  send: '<path d="M21 3 10.5 13.5M21 3l-6.5 18-4-7.5L3 9.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  play: '<path d="M7 5v14l11-7z" fill="currentColor"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7.5" y="7.5" width="3.5" height="3.5" rx=".5"/><rect x="13" y="7.5" width="3.5" height="3.5" rx=".5"/><rect x="7.5" y="13" width="3.5" height="3.5" rx=".5"/><path d="M13 13h3.5v3.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  power: '<path d="M12 3v8"/><path d="M6.6 6.5a8 8 0 1 0 10.8 0"/>',
  // A forwarded port and its page (the desktop's globe); a page opened as https.
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  // A computer's files (screens/files.js): a folder, a file, the way in and out, a move, a new folder.
  folder: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2.5 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  upload: '<path d="M12 16V5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M5 20h14"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  move: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2.5 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M8.5 13.5h7"/><path d="m12.5 10.5 3 3-3 3"/>',
  folderPlus: '<path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H9l2.5 2.5h7A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M12 10.5v6M9 13.5h6"/>',
  // The quick keys (session dock, terminal key row).
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  rightArrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  enter: '<path d="M19 5v7a3 3 0 0 1-3 3H6"/><path d="m10 11-4 4 4 4"/>',
  tab: '<path d="M4 12h12"/><path d="m12 8 4 4-4 4"/><path d="M20 6v12"/>',
  shiftTab: '<path d="M20 12H8"/><path d="m12 8-4 4 4 4"/><path d="M4 6v12"/>',
  paste: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 11h6M9 15h4"/>',
  // The agents' glyphs, coloured per agent by CSS (.glyph-*), as on the desktop.
  agentClaude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  agentOpenCode: '<path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/>',
  agentCodex: '<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/>'
};

export const icon = (name, cls = "") => `<svg class="ic${name.startsWith("agent") ? ` glyph-${name.slice(5).toLowerCase()}` : ""}${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;

// An agent's glyph (Claude, Codex, OpenCode), or nothing for one the app does not know.
export const agentIcon = agent => {
  const name = `agent${{ claude: "Claude", codex: "Codex", opencode: "OpenCode" }[String(agent).toLowerCase()] || ""}`;
  return P[name] ? icon(name) : "";
};

// A small icon-only button: the label goes to aria-label and title (the long-press tooltip). attrs: extra HTML
// attributes (data-act, type, disabled). cls: "danger", "accent", "on".
export const iconBtn = (name, label, attrs = "", cls = "") =>
  `<button class="icon-btn${cls ? ` ${cls}` : ""}" aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name)}</button>`;
