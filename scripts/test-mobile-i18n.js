// The phone app's strings and times (mobile/src/i18n.js). What this pins:
//   * every key has a text in both languages, and no text is left empty;
//   * every key the app's sources name literally (t("..."), tn("..."), data-i18n*) is in the table;
//   * agoShort: "now", minutes, hours, days, then a date - in a few characters, in both languages;
//   * an error's code is read as its text where there is one, else as the error's own message.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const src = path.join(__dirname, "../mobile/src");

(async () => {
  const i18n = await import(pathToFileURL(path.join(src, "i18n.js")).href);

  // ---------- the table ----------
  const text = fs.readFileSync(path.join(src, "i18n.js"), "utf8");
  const [en, bg] = text.split(/\n  bg: \{/);
  const table = part => new Map([...part.matchAll(/^\s+"([\w.]+)":\s*"((?:[^"\\]|\\.)*)"/gm)].map(m => [m[1], m[2]]));
  const EN = table(en), BG = table(bg);
  assert.ok(EN.size > 200, "the English table was read");
  assert.deepEqual([...EN.keys()].filter(k => !BG.has(k)), [], "every English key has a Bulgarian text");
  assert.deepEqual([...BG.keys()].filter(k => !EN.has(k)), [], "every Bulgarian key has an English text");
  assert.deepEqual([...EN, ...BG].filter(([, v]) => !v.trim()).map(([k]) => k), [], "no text is empty");

  const used = new Set();
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else if (name.endsWith(".js") && name !== "i18n.js") {
        const s = fs.readFileSync(file, "utf8");
        for (const m of s.matchAll(/\btn?\(\s*"([\w.]+)"/g)) used.add(m[1]);
        for (const m of s.matchAll(/data-i18n(?:-[a-z-]+)?="([\w.]+)"/g)) used.add(m[1]);
      }
    }
  };
  walk(src);
  // A plural's key is its stem: "session.prompts" stands for "session.prompts.one" and ".other".
  assert.deepEqual([...used].filter(k => !EN.has(k) && !EN.has(`${k}.other`)), [], "every key the sources name is in the table");

  // ---------- short times ----------
  const now = Date.UTC(2031, 4, 20, 12, 0, 0), s = 1000, min = 60 * s, h = 60 * min, d = 24 * h;
  const short = ms => i18n.agoShort(now - ms, now);
  i18n.setLanguage("en");
  assert.equal(i18n.agoShort(0, now), "", "no time, no text");
  assert.deepEqual([10 * s, 44 * s, 50 * s, 11 * min, 59 * min, 61 * min, 5 * h, 23 * h, 26 * h, 6 * d].map(short),
    ["now", "now", "1m", "11m", "59m", "1h", "5h", "23h", "1d", "6d"]);
  assert.match(short(9 * d), /11/, "older than a week: the date");
  assert.equal(i18n.agoShort(now + 5 * min, now), "now", "a clock ahead of the phone's is not a negative time");
  i18n.setLanguage("bg");
  assert.deepEqual([10 * s, 11 * min, 5 * h, 6 * d].map(short), ["сега", "11 мин", "5 ч", "6 д"]);
  assert.ok([11 * min, 5 * h, 6 * d].every(ms => short(ms).length <= 7), "short in Bulgarian too");

  // ---------- errors ----------
  i18n.setLanguage("en");
  for (const code of ["pairOutdated", "tooBig", "unreadable", "offline"]) {
    assert.equal(i18n.errorText({ code, message: "raw" }), EN.get(`err.${code}`).replace(/\\"/g, '"'), `${code} has a text`);
  }
  assert.equal(i18n.errorText({ code: "noSuchCode", message: "as the host said it" }), "as the host said it");
  i18n.setLanguage("bg");
  assert.notEqual(i18n.errorText({ code: "pairOutdated", message: "raw" }), "raw");

  console.log("mobile i18n: both languages complete, every key in use known, short times, error texts - passed");
})().catch(e => { console.error(e); process.exit(1); });
