// The colour themes agree everywhere: shared/themes.js (the list prefs.js offers, each theme's base and window
// colour), the CSS blocks of theme.css and themes.css, every page linking themes.css, and the names in both
// languages. Every theme block in themes.css swaps the whole colour token set theme.css's dark block defines, and
// keeps text readable (4.5:1 for body text). Plain Node: no Electron.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const themes = require("../src/shared/themes");
const i18n = require("../src/i18n");

const src = f => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8");
const themeCss = src("theme.css"), themesCss = src("themes.css"), i18nText = src("i18n.js");

// :root { ... } and :root[data-theme="id"] { ... } blocks, comments dropped: id ("" for the bare :root) -> Map of
// declarations.
function blocks(css, file) {
  const out = new Map();
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of plain.matchAll(/(^|\n):root(?:\[data-theme="([a-z0-9-]+)"\])?\s*\{([^}]*)\}/g)) {
    const id = m[2] || "";
    assert.ok(!out.has(id), `${file}: one block for "${id || ":root"}"`);
    const decls = new Map();
    for (const d of m[3].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
      assert.ok(!decls.has(d[1]), `${file} "${id}": ${d[1]} declared once`);
      decls.set(d[1], d[2].trim());
    }
    out.set(id, decls);
  }
  return out;
}
const core = blocks(themeCss, "theme.css"), extra = blocks(themesCss, "themes.css");
const dark = core.get("");
assert.ok(dark && core.get("light"), "theme.css has its dark :root and light blocks");
assert.ok(!extra.has(""), "themes.css leaves :root to theme.css");
for (const id of extra.keys()) assert.ok(!core.has(id), `"${id}" is defined in one file only`);
const blockOf = id => (id === "dark" ? dark : core.get(id) || extra.get(id));

// ---------- the list ----------
assert.equal(themes.THEMES[0], "system", "system comes first");
assert.deepEqual(themes.THEMES.slice(1), themes.LIST.map(th => th.id), "THEMES is system + the list");
assert.equal(new Set(themes.THEMES).size, themes.THEMES.length, "no theme twice");
assert.ok(themes.get(themes.DEFAULT), "the default is a theme");
assert.equal(themes.get("system"), null, "system is not a theme of its own");
assert.equal(themes.get("no-such-theme"), null, "an unknown theme has no entry (prefs falls back to the default)");
assert.equal(themes.baseOf("no-such-theme"), null);
for (const th of themes.LIST) {
  assert.ok(["dark", "light"].includes(th.base), `${th.id}: base is dark or light`);
  assert.ok(["app", "vscode"].includes(th.group), `${th.id}: group`);
  assert.match(th.bg, /^#[0-9a-f]{6}$/, `${th.id}: window colour is opaque #rrggbb`);
  const b = blockOf(th.id);
  assert.ok(b, `${th.id}: has a CSS block`);
  assert.equal(b.get("--bg"), th.bg, `${th.id}: window colour is the block's --bg`);
  assert.equal(b.get("color-scheme"), th.base, `${th.id}: color-scheme matches the base`);
}
const listed = new Set(themes.LIST.map(th => th.id));
for (const id of [...core.keys(), ...extra.keys()]) if (id) assert.ok(listed.has(id), `CSS block "${id}" is in shared/themes.js`);

// ---------- the token set ----------
// Type, radii, the focus ring and motion are shared by every theme; everything else in the dark block is a colour
// (or a shadow) a theme has to set.
const SHARED = /^--(sans|display|mono|r-[a-z]+|ring|dur(-\w+)?|ease-\w+)$/;
const required = [...dark.keys()].filter(k => !SHARED.test(k));
assert.ok(required.length > 90, "the dark block's colour tokens were found");
for (const [id, b] of extra) {
  const missing = required.filter(k => !b.has(k));
  assert.deepEqual(missing, [], `${id}: defines every colour token`);
  const unknown = [...b.keys()].filter(k => !dark.has(k));
  assert.deepEqual(unknown, [], `${id}: no token theme.css does not have`);
  assert.ok(b.get("--chevron").includes(`stroke='%23${b.get("--muted").slice(1)}'`), `${id}: the select arrow is drawn in --muted`);
}
assert.deepEqual([...core.get("light").keys()].filter(k => !dark.has(k)), [], "light: no token the dark block does not have");

// ---------- contrast ----------
function value(b, name, depth = 0) {
  const v = b.get(name) ?? dark.get(name);
  const ref = /^var\((--[\w-]+)\)$/.exec(v || "");
  return ref && depth < 5 ? value(b, ref[1], depth + 1) : v;
}
const lum = h => {
  const [r, g, bl] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const CHECKS = [
  // [foreground, backgrounds, minimum]
  ["--text", ["--bg", "--panel", "--panel-2", "--card", "--raised"], 4.5],
  ["--muted", ["--bg", "--panel"], 4.5],
  ["--term-fg", ["--term-bg"], 4.5],
  ["--on-accent", ["--accent"], 4.5],
  ["--accent", ["--bg", "--panel"], 3],
  ["--danger", ["--bg", "--panel"], 3],
  ["--on-solid", ["--danger-solid"], 4] // a bold button label; theme.css's own dark sits at 4.35:1
];
let checked = 0;
for (const th of themes.LIST) {
  const b = blockOf(th.id);
  for (const [fg, bgs, min] of CHECKS) {
    for (const bg of bgs) {
      const a = value(b, fg), c = value(b, bg);
      assert.match(a, /^#[0-9a-f]{6}$/, `${th.id}: ${fg} is an opaque colour`);
      assert.match(c, /^#[0-9a-f]{6}$/, `${th.id}: ${bg} is an opaque colour`);
      const r = ratio(a, c);
      assert.ok(r >= min, `${th.id}: ${fg} on ${bg} is ${r.toFixed(2)}:1, under ${min}:1`);
      checked++;
    }
  }
}

// ---------- every page that links theme.css links themes.css right after ----------
const pages = fs.readdirSync(path.join(__dirname, "..", "src"), { recursive: true }).filter(f => f.endsWith(".html"));
let linked = 0;
for (const f of pages) {
  const html = src(f);
  const m = /<link rel="stylesheet" href="((?:\.\.\/)*)theme\.css">\s*<link rel="stylesheet" href="([^"]+)">/.exec(html);
  if (!html.includes("theme.css\"")) continue;
  assert.ok(m && m[2] === `${m[1]}themes.css`, `${f}: links themes.css right after theme.css`);
  linked++;
}
assert.ok(linked >= 7, "the pages were found");

// ---------- names in both languages ----------
for (const id of [...themes.THEMES, "group.app", "group.vscode"]) {
  const key = `theme.${id}`;
  const count = i18nText.split(`"${key}":`).length - 1;
  assert.equal(count, 2, `${key}: one string in English and one in Bulgarian`);
  for (const lang of ["en", "bg"]) {
    i18n.setLanguage(lang);
    assert.notEqual(i18n.t(key), key, `${key} (${lang})`);
  }
}
i18n.setLanguage("bg");
assert.equal(i18n.t("theme.black"), "Черна");
assert.equal(i18n.t("theme.dracula"), "Dracula", "proper names stay as they are");

console.log(`themes passed: ${themes.LIST.length} themes + system, ${required.length} colour tokens each, ${checked} contrast pairs, ${linked} pages`);
