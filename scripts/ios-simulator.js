// The iPhone app in the iOS simulator of a macOS runner (ci.yml, mobile-ios): nobody here has a Mac, so this is how
// the app is seen and checked before TestFlight. It boots a simulator, installs the app built for it
// (mobile: npm run ios:sim), pairs it with a throwaway relay and its invented computers (scripts/mobile-rig.js) and
// walks through the screens, taking a screenshot of each.
//
//   node scripts/ios-simulator.js <AgentDeck.app> <folder for the screenshots>
//
// Nobody can touch that screen, so the page is driven from here: a simulator build of the app runs the scripts put
// into its Documents/drive folder (ios/App/App/ViewController.swift, simulator only) and writes back what they return.
//
// What must hold, or this fails (report.txt in the folder has every answer):
//   * the page loads from capacitor://localhost under its CSP, as "ios", with the app's two plugins;
//   * the Keychain store takes an entry, gives it back, and still has it after the app was closed and opened again;
//   * a plain ws:// to the relay by IP opens (App Transport Security), and the app pairs through it with the relay
//     and the three computers behind it, lists their sessions and attaches to a terminal;
//   * a tap on the terminal brings the keyboard up without the page being zoomed, and the app is then as tall as
//     what the keyboard leaves;
//   * started in Bulgarian, the app is in Bulgarian.
// What is only reported: ws:// to a public host name (needs the runner to resolve one), the camera (the simulator
// has none).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const [appPath, outDir] = process.argv.slice(2);
if (process.platform !== "darwin" || !appPath || !outDir) {
  console.error("usage (macOS only): node scripts/ios-simulator.js <AgentDeck.app> <folder for the screenshots>");
  process.exit(2);
}
const BUNDLE = "com.mitrevstudio.agentdeck";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const simctl = (...args) => sh("xcrun", ["simctl", ...args]);
fs.mkdirSync(outDir, { recursive: true });
const report = [], failures = [];
const note = (name, value) => { const line = `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`; report.push(line); console.log(line); };
// A check that fails is kept for the end: the screenshots after it are still worth having.
const check = (name, fn) => { try { fn(); note(`ok   ${name}`, ""); } catch (e) { failures.push(name); note(`FAIL ${name}`, e.message.split("\n")[0]); } };

// ---------- the simulator ----------
// The newest iPhone the runner has (an iPhone, not an iPad: the app is iPhone only).
function pickDevice() {
  const all = JSON.parse(simctl("list", "devices", "available", "-j")).devices;
  const runtimes = Object.keys(all).filter(k => /SimRuntime\.iOS-/.test(k)).sort((a, b) => {
    const v = k => k.match(/iOS-(\d+)-(\d+)/).slice(1).map(Number);
    return v(b)[0] - v(a)[0] || v(b)[1] - v(a)[1];
  });
  for (const rt of runtimes) {
    const phones = all[rt].filter(d => /^iPhone/.test(d.name));
    const one = phones.find(d => /^iPhone \d+ Pro$/.test(d.name)) || phones.find(d => /^iPhone \d+$/.test(d.name)) || phones[0];
    if (one) return { ...one, runtime: rt.replace(/.*SimRuntime\./, "") };
  }
  throw new Error("no iPhone simulator on this machine");
}

let udid = "", drive = "";
// Runs a script in the app's page (the body of an async function) and gives back what it returned, as text.
async function page(script, ms = 30000) {
  const result = path.join(drive, "result.txt");
  fs.rmSync(result, { force: true });
  fs.writeFileSync(path.join(drive, "next.tmp"), script);
  fs.renameSync(path.join(drive, "next.tmp"), path.join(drive, "next.js"));
  for (let waited = 0; waited < ms; waited += 100) {
    await sleep(100);
    if (!fs.existsSync(result)) continue;
    const text = fs.readFileSync(result, "utf8");
    fs.rmSync(result, { force: true });
    if (text.startsWith("ok ")) return text.slice(3);
    throw new Error(`the page: ${text.slice(0, 600)}`);
  }
  throw new Error(`the app did not answer in ${ms} ms`);
}
const json = async (script, ms) => JSON.parse(await page(script, ms));
// Waits until an expression is true in the page.
async function until(expr, what, ms = 30000) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await page(`return String(Boolean(${expr}))`) === "true") return;
    await sleep(500);
  }
  throw new Error(`timeout: ${what}`);
}
let shots = 0;
async function shot(name, { landscape = false } = {}) {
  await sleep(700); // what was just asked for is drawn
  const file = path.join(outDir, `${String(++shots).padStart(2, "0")}-${name}.png`);
  simctl("io", udid, "screenshot", file);
  // The screen's picture is the phone's, upright: one of a phone on its side is turned to be read.
  if (landscape) sh("sips", ["-r", "270", file]);
  console.log(`screenshot: ${path.basename(file)}`);
}
function launch(lang) {
  try { simctl("terminate", udid, BUNDLE); } catch {}
  simctl("launch", udid, BUNDLE, "-AppleLanguages", `(${lang})`, "-AppleLocale", lang === "bg" ? "bg_BG" : "en_US");
}
const get = url => new Promise((resolve, reject) => {
  http.get(url, res => { let s = ""; res.on("data", d => { s += d; }); res.on("end", () => resolve(s)); }).on("error", reject);
});

// A tap on the terminal, as a finger makes it (touch events): the app raises the keyboard itself, a moment later.
const TAP = `const w = document.querySelector(".term-wrap"), r = w.getBoundingClientRect();
  const t = new Touch({ identifier: 1, target: w, clientX: r.left + 60, clientY: r.top + 60 });
  w.dispatchEvent(new TouchEvent("touchstart", { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
  w.dispatchEvent(new TouchEvent("touchend", { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 2500));`;
const VIEW = `JSON.stringify({ active: document.activeElement?.className || document.activeElement?.tagName, inner: innerHeight, visible: Math.round(visualViewport.height), top: Math.round(visualViewport.offsetTop),
  scale: visualViewport.scale, app: Math.round(document.querySelector("#app").getBoundingClientRect().height), appTop: Math.round(document.querySelector("#app").getBoundingClientRect().top),
  classes: document.documentElement.className, wrap: Math.round(document.querySelector(".term-wrap")?.clientHeight || 0) })`;

(async () => {
  let rig = null, control = 0;
  try {
    // ---------- boot, install ----------
    const device = pickDevice();
    udid = device.udid;
    note("simulator", `${device.name}, ${device.runtime}`);
    note("xcode", sh("xcodebuild", ["-version"]).replace(/\n/g, ", "));
    // The on-screen keyboard, as on a phone (a simulator otherwise takes the Mac's).
    try { sh("defaults", ["write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"]); } catch {}
    try { simctl("boot", udid); } catch (e) { if (!/current state: Booted/.test(String(e.stderr))) throw e; }
    simctl("bootstatus", udid, "-b");
    try { simctl("status_bar", udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100", "--cellularBars", "4", "--wifiBars", "3"); } catch {}
    simctl("install", udid, path.resolve(appPath));
    drive = path.join(simctl("get_app_container", udid, BUNDLE, "data"), "Documents", "drive");
    fs.mkdirSync(drive, { recursive: true });

    // ---------- the relay and its computers ----------
    rig = spawn(process.execPath, [path.join(__dirname, "mobile-rig.js")], { stdio: ["ignore", "pipe", "inherit"] });
    const ready = await new Promise((resolve, reject) => {
      let text = "";
      rig.stdout.on("data", d => { text += d; const m = text.match(/RIG READY (\{.*\})/); if (m) resolve(JSON.parse(m[1])); });
      rig.on("exit", code => reject(new Error(`the rig stopped (${code})`)));
      setTimeout(() => reject(new Error("the rig did not start")), 90000);
    });
    control = ready.control;

    // ---------- first run ----------
    launch("en");
    await until(`document.querySelector(".pair [data-act='scan']")`, "the first screen", 90000);
    const env = await json(`return JSON.stringify({ platform: window.Capacitor?.getPlatform?.(), origin: location.origin, secure: window.isSecureContext,
      camera: Boolean(navigator.mediaDevices?.getUserMedia), language: navigator.language, lang: document.documentElement.lang, classes: document.documentElement.className,
      viewport: document.querySelector("meta[name='viewport']").content, store: Capacitor.isPluginAvailable("SecureStore"), phone: Capacitor.isPluginAvailable("Phone"),
      styled: getComputedStyle(document.body).backgroundColor, safeTop: getComputedStyle(document.querySelector("#app")).paddingTop,
      inner: [innerWidth, innerHeight], screen: [screen.width, screen.height], vibrate: typeof navigator.vibrate, ua: navigator.userAgent })`);
    note("page", env);
    check("the page is the iOS app's, from capacitor://localhost", () => { assert.equal(env.platform, "ios"); assert.equal(env.origin, "capacitor://localhost"); });
    check("the stylesheet and the script passed the CSP", () => assert.equal(env.styled, "rgb(13, 16, 21)"));
    check("both local plugins are there", () => { assert.equal(env.store, true); assert.equal(env.phone, true); });
    check("the page knows it is on an iPhone", () => { assert.match(env.classes, /\bios\b/); assert.match(env.viewport, /maximum-scale=1/); });
    check("the notch is left free", () => assert.ok(parseFloat(env.safeTop) >= 20, env.safeTop));
    await shot("first-run");

    // ---------- the Keychain ----------
    const P = `Capacitor.Plugins.SecureStore`;
    const store = await json(`const S = ${P}; const out = {};
      await S.set({ key: "ci-probe", value: "kept \\u2713" });
      out.read = (await S.get({ key: "ci-probe" })).value;
      out.missing = (await S.get({ key: "ci-nothing" })).value;
      await S.set({ key: "ci-gone", value: "x" }); await S.remove({ key: "ci-gone" });
      out.removed = (await S.get({ key: "ci-gone" })).value;
      try { await S.get({ key: "../bad key" }); out.bad = "taken"; } catch (e) { out.bad = e.code; }
      out.device = await S.device();
      try { await Capacitor.Plugins.Phone.buzz({}); await Capacitor.Plugins.Phone.copy({ text: "from the app" }); out.paste = (await Capacitor.Plugins.Phone.paste()).text; } catch (e) { out.phone = String(e); }
      return JSON.stringify(out);`);
    note("keychain", store);
    check("the Keychain store keeps, misses, removes and refuses as the Android one", () => assert.deepEqual([store.read, store.missing, store.removed, store.bad], ["kept ✓", null, null, "invalidData"]));
    check("the phone names itself and the pasteboard works", () => { assert.equal(store.device.model, "iPhone"); assert.equal(store.paste, "from the app"); });

    // ---------- pairing by hand: a field, the keyboard ----------
    await page(`document.querySelector("details.relay").open = true; await new Promise(r => setTimeout(r, 1500)); return "open"`);
    const typing = await json(`return JSON.stringify({ active: document.activeElement?.name, inner: innerHeight, visible: Math.round(visualViewport.height), scale: visualViewport.scale, classes: document.documentElement.className })`);
    note("a field with the keyboard", typing);
    check("a field that takes the keyboard is not zoomed into", () => assert.equal(typing.scale, 1));
    await shot("pair-by-hand-keyboard");
    await page(`document.activeElement?.blur(); document.querySelector("details.relay").open = false; return "closed"`);

    // ---------- the network: plain ws:// ----------
    const WS = (host, ms = 8000) => `return await new Promise(resolve => { let ws; const t = setTimeout(() => { try { ws.close(); } catch {} resolve("timeout"); }, ${ms});
      try { ws = new WebSocket("ws://${host}:${ready.relayPort}/"); } catch (e) { clearTimeout(t); return resolve("threw: " + e.message); }
      ws.onopen = () => { clearTimeout(t); ws.close(); resolve("open"); }; ws.onerror = () => { clearTimeout(t); resolve("error"); }; })`;
    const byIp = await page(WS("127.0.0.1"));
    note("ws:// by IP", byIp);
    check("a plain WebSocket to an IP address opens", () => assert.equal(byIp, "open"));
    // A public name that resolves to this machine: the case of a relay on the internet. Reported, not required - it
    // needs a DNS answer from outside.
    for (const name of ["localhost", "127.0.0.1.nip.io", "localtest.me"]) {
      try { note(`ws:// by name (${name})`, await page(WS(name))); } catch (e) { note(`ws:// by name (${name})`, e.message); }
    }

    // ---------- pairing with the code's text ----------
    const payload = await get(`http://127.0.0.1:${control}/payload`);
    assert.match(payload, /^AGENTDECK-PAIR:/);
    await page(`const d = document.querySelector("details.paste"); d.open = true; const f = d.querySelector("form"); f.text.value = ${JSON.stringify(payload)}; f.requestSubmit(); return "sent"`);
    await until(`document.querySelector(".pairing .summary")`, "the pairing to end", 90000);
    const paired = await json(`return JSON.stringify([...document.querySelectorAll(".pairing .node-row")].map(r => r.querySelector(".name").textContent + (r.querySelector(".end-ic.ok") ? " +" : " -")))`);
    note("paired", paired);
    check("the relay and its three computers are paired", () => assert.deepEqual(paired, ["relay-home +", "ATLAS-DESK +", "build-server.lan +", "old-laptop +"]));
    await shot("pairing");
    await page(`document.querySelector(".pairing [data-act='continue']").click(); return "on"`);
    await until(`document.querySelector(".inbox .row[data-id='s-wait']") && document.querySelector(".inbox .row[data-id='b-2']")`, "the sessions in the inbox", 60000);
    await shot("inbox");

    // ---------- a session waits: the banner ----------
    await get(`http://127.0.0.1:${control}/wait?id=s-busy`);
    try { await until(`!document.querySelector("#banner").hidden`, "the banner", 30000); await shot("banner"); } catch (e) { note("banner", e.message); }
    await page(`document.querySelector("#banner").hidden = true; return "away"`);

    // ---------- a session's terminal ----------
    await page(`document.querySelector(".inbox .row[data-id='s-wait']").click(); return "open"`);
    await until(`document.querySelector(".term-host .xterm-rows")?.textContent.replace(/\\u00a0/g, " ").includes("line 40")`, "the terminal's text", 60000);
    await shot("terminal");
    const before = await json(`return ${VIEW}`);
    const after = await json(`${TAP} return ${VIEW}`);
    note("terminal, no keyboard", before);
    note("terminal, tapped", after);
    check("a tap on the terminal gives the keyboard to its field", () => assert.match(String(after.active), /term-input/));
    check("the keyboard is up, the page not zoomed, the app as tall as what is left and at its top", () => {
      assert.ok(after.inner - after.visible > 120, "no keyboard in sight");
      assert.equal(after.scale, 1);
      assert.match(after.classes, /kb-open/);
      assert.ok(Math.abs(after.app - after.visible) <= 1, `app ${after.app}, visible ${after.visible}`);
      assert.ok(Math.abs(after.appTop - after.top) <= 1, `app at ${after.appTop}, the view at ${after.top}`);
      assert.ok(after.wrap > 80, `the terminal has ${after.wrap} px`);
    });
    await shot("terminal-keyboard");
    // Typing, as the keyboard does it: the field's text changes, the difference goes out as keys. With what an
    // iPhone's keyboard makes of quotes and two hyphens.
    await page(`const i = document.querySelector(".term-input"); for (const v of ["e", "ec", "ech", "echo", "echo ", "echo \\u201c", "echo \\u201ciphone", "echo \\u201ciphone \\u2014", "echo \\u201ciphone \\u2014ok", "echo \\u201ciphone \\u2014ok\\u201d", "echo \\u201ciphone \\u2014ok\\u201d\\n"]) { i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); await new Promise(r => setTimeout(r, 60)); } return "typed"`);
    try {
      await until(`[...document.querySelectorAll(".term-host .xterm-rows > div")].some(d => d.textContent.replace(/\\u00a0/g, " ").trim() === "iphone --ok")`, "what was typed to come back", 20000);
      note("ok   typing reaches the shell with plain quotes and hyphens", "");
    } catch (e) { failures.push("typing"); note("FAIL typing reaches the shell with plain quotes and hyphens", e.message); }
    await shot("terminal-typed");

    // ---------- the phone on its side ----------
    try {
      await page("landscape");
      await sleep(2500);
      const side = await json(`return ${VIEW}`);
      note("on its side, the keyboard up", side);
      await shot("terminal-landscape-keyboard", { landscape: true });
      await page(`document.activeElement?.blur(); await new Promise(r => setTimeout(r, 1500)); return "down"`);
      note("on its side", await json(`return ${VIEW}`));
      await shot("terminal-landscape", { landscape: true });
      await page("portrait");
      await sleep(2500);
    } catch (e) { note("landscape", e.message); }

    // ---------- the chat view, the computers ----------
    await page(`document.activeElement?.blur(); document.querySelector(".term-head [data-act='chat']").click(); return "chat"`);
    await until(`document.querySelector(".msgs")?.textContent.includes("Release plan")`, "the session's messages", 30000);
    await shot("session-chat");
    await page(`history.back(); await new Promise(r => setTimeout(r, 800)); history.back(); await new Promise(r => setTimeout(r, 800)); document.querySelector(".tabbar [data-tab='computers']").click(); return "computers"`);
    await until(`document.querySelector(".computers")?.textContent.includes("ATLAS-DESK")`, "the computers", 30000);
    const secure = await page(`return document.querySelector(".computers").textContent.includes("localStorage") ? "insecure" : "secure"`);
    check("the Computers screen does not say the key is in localStorage", () => assert.equal(secure, "secure"));
    await shot("computers");

    // ---------- closed and opened again, in Bulgarian ----------
    launch("bg");
    await until(`document.querySelector(".inbox .row[data-id='s-wait']")`, "the inbox after a restart", 90000);
    const again = await json(`return JSON.stringify({ lang: document.documentElement.lang, language: navigator.language, probe: (await ${P}.get({ key: "ci-probe" })).value, title: document.querySelector(".top h1")?.textContent })`);
    note("after a restart, in Bulgarian", again);
    check("the pairing and the Keychain entry outlive the app's process", () => assert.equal(again.probe, "kept ✓"));
    check("a phone in Bulgarian gets the app in Bulgarian", () => assert.equal(again.lang, "bg"));
    await shot("inbox-bg");
    await page(`await ${P}.remove({ key: "ci-probe" }); return "clean"`);
  } catch (e) {
    failures.push("the run itself");
    note("FAILED", e.stack || String(e));
    try { await shot("failed"); } catch {}
  } finally {
    if (control) { try { await get(`http://127.0.0.1:${control}/quit`); } catch {} }
    else rig?.kill();
    fs.writeFileSync(path.join(outDir, "report.txt"), `${report.join("\n")}\n`);
    try { simctl("shutdown", udid); } catch {}
  }
  if (failures.length) { console.error(`\niOS simulator: ${failures.length} failed - ${failures.join("; ")}`); process.exit(1); }
  console.log("\niOS simulator: the app starts, stores, pairs, lists, attaches and types - passed");
})();
