// A strip of small keys for a terminal (the session's quick keys, the terminal's key row): one scrollable row of
// keycaps as the desktop draws its <kbd>, an icon where one says it better (arrows, Enter, Tab, Paste). Its right
// edge fades while there are more keys that way (wireStrip).
import { t } from "../i18n.js";
import { esc } from "../util.js";
import { icon } from "../icons.js";

// The keys drawn as an icon: the icon, and the i18n key of the name a screen reader says.
const ICON_KEYS = {
  enter: ["enter", "key.enter"], tab: ["tab", "key.tab"], shiftTab: ["shiftTab", "key.shiftTab"], paste: ["paste", "key.paste"],
  up: ["up", "key.up"], down: ["down", "key.down"], left: ["left", "key.left"], right: ["rightArrow", "key.right"]
};

// keys: [[label or one of ICON_KEYS, ...], ...]; the button's data-k is the key's index.
export function keyStrip(keys, cls) {
  return `<div class="${cls} keystrip" role="toolbar" aria-label="${esc(t("key.strip"))}">${keys.map(([label], i) => {
    const ic = ICON_KEYS[label];
    return ic
      ? `<button class="key" type="button" data-k="${i}" aria-label="${esc(t(ic[1]))}" title="${esc(t(ic[1]))}"><span>${icon(ic[0])}</span></button>`
      : `<button class="key" type="button" data-k="${i}"><span>${esc(label)}</span></button>`;
  }).join("")}</div>`;
}
// Marks the strip while it has keys out of sight to the right ("more": its edge fades), as it is scrolled and resized.
export function wireStrip(el) {
  const set = () => el.classList.toggle("more", el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  el.addEventListener("scroll", set, { passive: true });
  new ResizeObserver(set).observe(el);
  set();
}
