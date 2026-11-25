// The phone's "Files" screen (docs/FILES.md 1, 5) run for real: the whole phone app (mobile/src/main.js bundled as
// mobile/scripts/build.mjs bundles it, served with its own index.html and CSP) in a headless test Chrome at a phone's
// size, paired through its own pair screen with a served desktop behind an encrypted relay, and driven with touches
// and typing (CDP) - from a computer's screen and from a session into the list, the folders, the viewer, the sheet, the
// folder dialog, rename, copy, move, delete and upload. Each step is checked on the screen and on the host's disk.
//
// Everything is in one new temporary folder, removed at the end: the test Chrome's profile, the host's home (its
// files) and the phone's file to upload. The test never goes above that folder except to look at the list of drives.
// The user's Chrome, profile, tabs and files are not touched. Screenshots go to .tmp/ (git-ignored).
//
// There is no native plugin in a browser: download and PDF must say "update the app" (files-native.js), while text,
// pictures and uploads work.
//
// Also what only the real page shows: the prompt for a sent file comes up with the focus on "Not now" and answers
// nothing in its first moment (a click or Escape that was on its way); Back closes the sheet on top when two lie one
// over the other; a finger held on a row while the list is read again opens no sheet, and a sheet names its file.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const esbuild = require("../mobile/node_modules/esbuild");
const pairCode = require("../src/mesh/pair-code");
const { withPhone, waitFor, sleep, chromePath, launch, session } = require("./phone-test-rig");

const MOBILE = path.join(__dirname, "../mobile");
const SHOTS = path.join(__dirname, "../.tmp");
const W = 390, H = 844;
const NODE_NAME = "desktop"; // what phone-test-rig.js calls the served computer
const LONG = "a-rather-long-file-name-without-any-spaces-that-a-build-tool-might-write-out-0123456789-abcdefghijklmnopqrstuv.txt";
const CYR = "бележки за изданието.txt";
// No hyphen, no space: nowhere for a line to break.
const SOLID = "Q4_release_candidate_build_output_for_the_harbor_application_with_every_symbol_kept_v2.txt";
const DEEP = ["level-one-with-a-rather-long-folder-name", "level-two", "level-three", "level-four"];

// A small real PNG (a gradient), so that the viewer has a picture to decode.
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set([Math.round((x / w) * 255), Math.round((y / h) * 255), 160], y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const README = ["# Release notes", "", "The build has **three** stages:", "", "1. Bundle the web code", "2. Copy `static/`", "3. Sync", "", "```js", "await esbuild.build(options);", "```", ""].join("\n");
const NOTES = "First line of the notes\nSecond line – with a dash and ünïcödé\n";

async function fixtures(root) {
  const home = path.join(root, "home"), project = path.join(home, "harbor-app");
  const put = async (rel, data) => { const f = path.join(project, rel); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.writeFile(f, data); };
  for (const d of [".cache", "docs", "src", "target", path.join("deep", ...DEEP)]) await fsp.mkdir(path.join(project, d), { recursive: true });
  await put(path.join("deep", ...DEEP, "inner.txt"), "deep inside\n");
  await put(path.join("old-build", "a.txt"), "a");
  await put(path.join("old-build", "sub", "b.txt"), "b");
  await put(".env", "SECRET=not-really\n");
  await put("notes.txt", NOTES);
  await put("README.md", README);
  await put("screenshot.png", png(240, 160));
  await put("manual.pdf", "%PDF-1.4\n% not a real document\n");
  await put("app-release.apk", crypto.randomBytes(300 * 1024));
  await put(LONG, "long name\n");
  await put(CYR, "на български\n");
  await put(SOLID, "solid\n");
  await put("rename-me.txt", "the one being renamed\n");
  await put("taken.txt", "already here\n");
  await fsp.mkdir(path.join(project, "many"));
  for (let i = 1; i <= 620; i++) await fsp.writeFile(path.join(project, "many", `entry-${String(i).padStart(4, "0")}.txt`), String(i));
  const upload = path.join(root, "phone", "upload-sample.bin");
  await fsp.mkdir(path.dirname(upload), { recursive: true });
  await fsp.writeFile(upload, crypto.randomBytes(6 * 1024 * 1024 + 123)); // 25 pieces of 256 KB: long enough to see it go
  return { home, project, upload };
}

async function bundle(out) {
  const r = await esbuild.build({
    absWorkingDir: MOBILE, entryPoints: { app: "src/main.js", style: "src/style.css" }, outdir: out,
    bundle: true, format: "iife", target: ["chrome100", "safari15"], minify: false, write: false, logLevel: "silent"
  });
  const files = { "/index.html": await fsp.readFile(path.join(MOBILE, "static/index.html")), "/icon.svg": await fsp.readFile(path.join(MOBILE, "static/icon.svg")) };
  for (const f of r.outputFiles) files["/" + path.basename(f.path)] = Buffer.from(f.contents);
  return files;
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// Helpers the test uses in the page (DOM only - the app's own code is not reachable from here).
const PAGE_HELPERS = `
  window.__row = name => [...document.querySelectorAll('#app .frow')].find(r => r.querySelector('.row-title')?.textContent === name) || null;
  window.__rows = () => [...document.querySelectorAll('#app .frow')].map(r => ({ name: r.querySelector('.row-title').textContent, dir: !!r.querySelector('.ic.dir'), dotted: r.classList.contains('dotted'), meta: r.querySelector('.row-meta')?.textContent || '', more: !!r.querySelector('[data-more]') }));
  window.__vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
`;

async function main() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "agentdeck-files-live-")));
  const browsers = [], errors = [], logs = [];
  let server, watching = false, current = null;
  try {
    const fx = await fixtures(root);
    const site = await bundle(path.join(root, "www"));
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x").pathname;
      const file = url === "/" ? "/index.html" : url, body = site[file];
      if (!body) { res.writeHead(404).end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    await fsp.mkdir(SHOTS, { recursive: true });

    const now = Date.now();
    const data = { registry: { projects: [{ name: "harbor-app", path: fx.project }] }, agents: ["Claude"], at: now,
      sessions: [{ agent: "Claude", id: "s-files", cwd: fx.project, title: "Build the release", updatedAt: now - 60000 }] };
    const hostOpts = { home: fx.home, preview: () => null, findTranscript: () => "",
      sessions: { get: () => data, data: async () => data, registry: { read: () => ({ projects: [], groups: [], removed: [] }), save() {} } } };

    const chrome = await launch(await chromePath(), path.join(root, "chrome")); browsers.push(chrome);
    await withPhone(async ({ host, relay, served, phone: rigPhone }) => {
      // The same pairing text the desktop's QR code carries: the relay and this computer.
      const entry = inv => ({ id: inv.id, k: pairCode.hexToKey(inv.key), c: inv.code, n: inv.name, t: inv.kind });
      const { t: _kind, ...r } = entry(await host.call(relay.self().id, "pair.invite"));
      const payload = pairCode.encode({ r: { ...r, a: "127.0.0.1", p: relay.self().port }, n: [entry(host.invite())] });

      // ---------- a phone page ----------
      async function phonePage(langs) {
        const page = await session(chrome.control, "about:blank");
        current = page;
        const onEvent = msg => {
          if (!watching || msg.sessionId !== page.sessionId) return;
          const p = msg.params;
          if (msg.method === "Runtime.consoleAPICalled") logs.push(`${new Date().toISOString().slice(11, 23)} ${p.type}: ${p.args.map(a => a.value ?? a.description).join(" ")}`);
          if (msg.method === "Runtime.exceptionThrown") errors.push(`page exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
          else if (msg.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) errors.push(`console.${p.type}: ${p.args.map(a => a.value ?? a.description).join(" ")}`);
          else if (msg.method === "Log.entryAdded" && p.entry.level === "error") errors.push(`log (${p.entry.source}): ${p.entry.text} ${p.entry.url || ""}`);
          else if (msg.method === "Page.fileChooserOpened") page.chooser?.(p);
        };
        chrome.control.on("event", onEvent);
        page.off = () => chrome.control.off("event", onEvent);
        for (const d of ["Runtime.enable", "Log.enable", "Page.enable", "DOM.enable"]) await page.send(d);
        await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: true });
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(langs)} }); Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(langs[0])} });${PAGE_HELPERS}` });
        await page.send("Page.setInterceptFileChooserDialog", { enabled: true });
        watching = true;
        const nav = await page.send("Page.navigate", { url: base });
        if (nav.errorText) throw new Error(`The app did not load: ${nav.errorText}`);
        const has = expr => page.eval(`!!(${expr})`);
        // A finger on the middle of an element (brought into view first); it must be the element there, not
        // something lying over it. A sheet that is still rising is waited for.
        page.at = async expr => {
          // The scroll's own event comes a frame later; it would end a press that began before it (as a finger
          // that scrolls does), so the touch waits for it.
          let pt;
          for (let i = 0; i < 20; i++) {
            pt = await page.eval(`(async () => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              for (let i = 0; i < 3; i++) await new Promise(r => requestAnimationFrame(r));
              if (document.getAnimations().some(a => a.playState === 'running' && !(a instanceof CSSTransition) && a.effect?.getTiming().iterations !== Infinity)) return { busy: true };
              const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
              return { x, y, ok: !!hit && (el === hit || el.contains(hit)), hit: hit ? hit.tagName + '.' + hit.className : '' }; })()`);
            if (pt && !pt.busy && pt.ok) return pt;
            await sleep(50);
          }
          if (!pt) throw new Error(`Not on the screen: ${expr}`);
          throw new Error(`Covered${pt.busy ? " (still moving)" : ` by ${pt.hit}`}: ${expr}`);
        };
        page.tap = async expr => {
          const { x, y } = await page.at(expr);
          await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await sleep(60);
        };
        page.hold = async (expr, ms = 800) => {
          const { x, y } = await page.at(expr);
          await page.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await sleep(ms);
          await page.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await sleep(60);
        };
        page.type = async text => { await page.send("Input.insertText", { text }); };
        page.text = expr => page.eval(`(${expr})?.innerText ?? null`);
        page.has = has;
        page.until = async (expr, label, ms) => { await waitFor(() => has(expr), label, ms); logs.push(`${new Date().toISOString().slice(11, 23)} test: ${label}`); };
        page.toast = async (want, label) => {
          await waitFor(() => page.eval(`(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes(${JSON.stringify(want)}); })()`), `${label}: toast "${want}"`);
          await page.eval("document.querySelector('#toast').hidden = true");
        };
        page.settle = () => waitFor(() => page.eval("!document.getAnimations().some(a => a.playState === 'running' && !(a instanceof CSSTransition) && a.effect?.getTiming().iterations !== Infinity)"), "animations end");
        page.shot = async name => {
          await page.settle();
          const { data: png64 } = await page.send("Page.captureScreenshot", { format: "png" });
          await fsp.writeFile(path.join(SHOTS, name), Buffer.from(png64, "base64"));
        };
        // Nothing wider than the phone, and nothing on the screen that reads as a translation key.
        page.fits = async label => {
          await page.settle();
          const bad = await page.eval(`(() => {
            const out = [];
            if (document.documentElement.scrollWidth > innerWidth + 1) out.push('page scrolls sideways: ' + document.documentElement.scrollWidth);
            for (const el of document.querySelectorAll('#app .frow, #app header.top, #app .files-crumbs, .sheet, .viewer, .files-task, .sheet-actions .btn, .menu-item')) {
              if (!__vis(el)) continue;
              const r = el.getBoundingClientRect();
              if (r.left < -1 || r.right > innerWidth + 1) out.push((el.className || el.tagName) + ' sticks out: ' + Math.round(r.left) + '..' + Math.round(r.right));
              if (el.matches('.sheet') && (r.top < -1 || r.bottom > innerHeight + 1)) out.push('sheet off the screen: ' + Math.round(r.top) + '..' + Math.round(r.bottom));
            }
            for (const b of document.querySelectorAll('#app header.top .top-actions button')) if (__vis(b) && b.getBoundingClientRect().width < 30) out.push('header button squeezed: ' + b.getAttribute('aria-label'));
            const words = document.body.innerText.match(/\\b(files|err|common|nav|node|session|term)\\.[a-z][A-Za-z]+\\b/g);
            if (words) out.push('raw keys: ' + words.join(', '));
            return out;
          })()`);
          assert.deepEqual(bad, [], `${label}: layout`);
        };
        return page;
      }

      const page = await phonePage(["en-US", "en"]);
      await page.until("document.querySelector('details.paste')", "pair screen");
      assert.equal(await page.eval("document.documentElement.lang"), "en");

      // ---------- pairing, as a user does it with the pasted text ----------
      await page.tap("document.querySelector('details.paste summary')");
      await page.until("document.activeElement?.name === 'text'", "paste field focused");
      await page.type(payload);
      await page.tap("document.querySelector('[data-form=paste] button[type=submit]')");
      await page.until("document.querySelector('[data-act=continue]')", "paired", 30000);
      await page.tap("document.querySelector('[data-act=continue]')");

      // ---------- in from a computer's screen ----------
      await page.until("document.querySelector('.tabbar [data-tab=computers]')", "inbox");
      await page.tap("document.querySelector('.tabbar [data-tab=computers]')");
      await page.until("[...document.querySelectorAll('[data-open]')].some(b => b.innerText.includes('desktop'))", "the computer listed and online");
      await page.tap("[...document.querySelectorAll('[data-open]')].find(b => b.innerText.includes('desktop'))");
      await page.until("document.querySelector('.node-head [data-act=files]')", "the computer's Files button");
      await page.fits("computer screen");
      await page.shot("files-live-node.png");

      // ---------- a file the computer sends, on a screen other than Files (docs/FILES.md 3.6) ----------
      // The page's phone is the mobile peer that is not the rig's own; the computer offers it a file of its project.
      const pagePhone = host.nodes().find(n => n.kind === "mobile" && n.id !== rigPhone.id && n.status === "online");
      assert.ok(pagePhone, "the page's phone is linked to the computer");
      const offerStates = new Map();
      served.offers.on("change", v => offerStates.set(v.offer, v));
      const notes = Buffer.byteLength(NOTES);
      // The prompt answers nothing in its first moment (main.js OFFER_QUIET_MS): a tap is made after it.
      const QUIET_MS = 450;
      const askOf = async () => { await page.until("document.querySelector('.offer-ask .sheet p')", "the prompt for the sent file"); await sleep(QUIET_MS); return page.text("document.querySelector('.offer-ask .sheet p')"); };
      // The moment the prompt is in the page: where the focus is, then a click on Save, a click beside the sheet and
      // Escape - what a tap or a key already on its way to the screen under it would do.
      await page.eval(`(() => {
        window.__early = null;
        const seen = new MutationObserver(() => {
          const sheet = document.querySelector('.offer-ask');
          if (!sheet || window.__early) return;
          seen.disconnect();
          window.__early = { focus: document.activeElement?.dataset.v ?? null };
          sheet.querySelector('[data-v="1"]').click();
          sheet.click();
          sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          window.__early.still = !!document.querySelector('.offer-ask');
        });
        seen.observe(document.body, { childList: true });
      })()`);
      let sentOffer = await served.offers.make(pagePhone.id, { path: path.join(fx.project, "notes.txt") });
      assert.equal(await askOf(), `${NODE_NAME} sends you “notes.txt” (${notes} B). Save it in Downloads on this phone?`, "the prompt names the computer, the file and its size");
      assert.deepEqual(await page.eval("window.__early"), { focus: "0", still: true }, "the prompt comes up with the focus on Not now, and a click or Escape in its first moment answers nothing");
      assert.equal(await page.eval("document.activeElement?.dataset.v"), "0", "Not now still has the focus");
      assert.equal(offerStates.get(sentOffer.offer)?.state ?? "waiting", "waiting", "the computer heard no answer from them");
      assert.ok(await page.has("document.querySelector('.node-head [data-act=files]')"), "over the computer's screen, not the Files screen");
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.offer-ask .sheet-actions .btn')].map(b => b.textContent.trim())"), ["Not now", "Save"]);
      await page.fits("sent file prompt");
      await page.shot("files-live-offer.png");
      await page.tap("document.querySelector('.offer-ask [data-v=\"0\"]')");
      await waitFor(() => offerStates.get(sentOffer.offer)?.state === "declined", "Not now tells the computer: declined");
      assert.equal(await page.has("document.querySelector('.offer-ask')"), false, "the prompt is gone");
      // Save in a browser: no Files plugin - the app must be updated, and the computer hears that it failed.
      sentOffer = await served.offers.make(pagePhone.id, { path: path.join(fx.project, "notes.txt") });
      await askOf();
      await page.tap("document.querySelector('.offer-ask [data-v=\"1\"]')");
      await page.toast("Update this app to save files sent from a computer", "Save without the plugin");
      await waitFor(() => offerStates.get(sentOffer.offer)?.state === "failed", "Save without the plugin tells the computer: failed");
      assert.equal(offerStates.get(sentOffer.offer).error, "needsApp");
      assert.equal(await page.has("document.querySelector('.offer-task')"), false, "nothing is being saved");
      await page.tap("document.querySelector('.node-head [data-act=files]')");
      await page.until("__row('harbor-app')", "home folder listed");
      assert.equal(await page.text("document.querySelector('#app header.top h1')"), `Files · ${NODE_NAME}`);
      assert.equal(await page.eval("document.querySelector('.files-crumbs [aria-current]').textContent"), "home");

      // ---------- the project folder: folders first, the hidden ones too ----------
      await page.tap("__row('harbor-app').querySelector('.frow-open')");
      await page.until("__row('notes.txt')", "project folder listed");
      const rows = await page.eval("__rows()");
      const firstFile = rows.findIndex(x => !x.dir);
      assert.ok(firstFile > 0 && rows.slice(firstFile).every(x => !x.dir), `folders first: ${rows.map(x => x.name).join(", ")}`);
      assert.deepEqual(rows.filter(x => x.dir).map(x => x.name), [".cache", "deep", "docs", "many", "old-build", "src", "target"]);
      for (const n of [".env", "notes.txt", "README.md", "screenshot.png", "manual.pdf", "app-release.apk", LONG, CYR]) assert.ok(rows.some(x => x.name === n), `${n} listed`);
      assert.ok(rows.find(x => x.name === ".env").dotted && rows.find(x => x.name === ".cache").dotted, "hidden ones shown, dimmed");
      assert.match(rows.find(x => x.name === "app-release.apk").meta, /^300 KB · today \d/);
      assert.ok(rows.every(x => x.more), "every row has its actions button");
      assert.ok(await page.eval("getComputedStyle(document.querySelector('[data-act=upload]')).display !== 'none'"), "Upload shown in a folder");
      await page.fits("file list");
      // A long name is cut with an ellipsis inside its row, not pushing the row out.
      assert.ok(await page.eval(`(() => { const t = __row(${JSON.stringify(LONG)}).querySelector('.row-title'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis'; })()`), "long name ellipsised");
      await page.eval("document.querySelector('.files-list').scrollTop = 0");
      await page.shot("files-live-list.png");

      // ---------- into a folder and back by the breadcrumb ----------
      await page.tap("__row('deep').querySelector('.frow-open')");
      for (const d of DEEP) {
        await page.until(`__row(${JSON.stringify(d)})`, `in ${d}'s parent`);
        await page.tap(`__row(${JSON.stringify(d)}).querySelector('.frow-open')`);
      }
      await page.until("__row('inner.txt')", "deepest folder listed");
      assert.equal(await page.eval("document.querySelector('.files-crumbs [aria-current]').textContent"), "level-four");
      await page.fits("deep folder");
      await page.tap("[...document.querySelectorAll('.files-crumbs .crumb')].find(b => b.textContent === 'harbor-app')");
      await page.until("__row('notes.txt')", "back in the project by the breadcrumb");
      assert.equal(await page.eval("document.querySelector('.files-crumbs [aria-current]').textContent"), "harbor-app");

      // ---------- a folder of more than one page ----------
      await page.tap("__row('many').querySelector('.frow-open')");
      await page.until("__row('entry-0001.txt')", "big folder listed");
      assert.equal(await page.eval("__rows().length"), 500);
      assert.equal(await page.text("document.querySelector('.files-list [data-act=more]')"), "Load more");
      await page.tap("document.querySelector('.files-list [data-act=more]')");
      await page.until("__rows().length === 620", "second page added");
      const names = await page.eval("__rows().map(x => x.name)");
      assert.equal(new Set(names).size, 620, "no entry twice");
      assert.equal(names.at(-1), "entry-0620.txt");
      assert.equal(await page.has("document.querySelector('.files-list [data-act=more]')"), false, "no more after the last page");
      await page.tap("[...document.querySelectorAll('.files-crumbs .crumb')].find(b => b.textContent === 'harbor-app')");
      await page.until("__row('notes.txt')", "back in the project");

      // ---------- the order and the search ----------
      // manual.pdf is made the newest file on the host; "Newest first" must bring it to the top of the files.
      const topFile = "__rows().find(x => !x.dir)?.name";
      const later = new Date(Date.now() + 5 * 60000);
      await fsp.utimes(path.join(fx.project, "manual.pdf"), later, later);
      assert.ok(await page.has("__vis(document.querySelector('.files-tools'))"), "the search and the order above the list");
      assert.equal(await page.text("document.querySelector('.files-tools [data-act=order] span')"), "Name A–Z");
      assert.notEqual(await page.eval(topFile), "manual.pdf");
      await page.tap("document.querySelector('.files-tools [data-act=order]')");
      await page.until("document.querySelector('.sheet.menu')", "the order's sheet");
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.sheet.menu .menu-label')].map(x => x.textContent)"),
        ["Name A–Z", "Name Z–A", "Newest first", "Oldest first", "Largest first", "Smallest first"]);
      await page.fits("order sheet");
      await page.shot("files-live-order.png");
      await page.tap("[...document.querySelectorAll('.sheet.menu .menu-item')].find(b => b.textContent.trim() === 'Newest first')");
      await page.until(`${topFile} === "manual.pdf"`, "newest first: manual.pdf on top of the files");
      assert.ok((await page.eval("__rows()")).slice(0, 7).every(x => x.dir), "folders still first");
      assert.equal(await page.text("document.querySelector('.files-tools [data-act=order] span')"), "Newest first");
      assert.equal(await page.eval("localStorage.getItem('agentdeck.files.order')"), "newest", "the order is remembered on the phone");
      // The search: typed, asked a moment later, only the matches; its x clears it.
      await page.tap("document.querySelector('.files-tools input')");
      await page.type("NOTE");
      await page.until("__rows().length === 1 && __rows()[0].name === 'notes.txt'", "only the names with 'note'");
      assert.equal(await page.text("document.querySelector('.files-count')"), "1 matching");
      await page.fits("filtered list");
      await page.shot("files-live-filter.png");
      await page.tap("document.querySelector('.files-tools [data-act=unfilter]')");
      await page.until("__row('app-release.apk') && __rows().length > 10", "the search cleared: all again");
      assert.equal(await page.eval("document.querySelector('.files-tools input').value"), "");
      // Back to the name order for the rest of the steps.
      await page.tap("document.querySelector('.files-tools [data-act=order]')");
      await page.until("document.querySelector('.sheet.menu')", "the order's sheet again");
      await page.tap("[...document.querySelectorAll('.sheet.menu .menu-item')].find(b => b.textContent.trim() === 'Name A–Z')");
      await page.until(`${topFile} !== "manual.pdf" && !document.querySelector('.sheet-backdrop')`, "name order again");

      // ---------- looking at files ----------
      await page.tap("__row('notes.txt').querySelector('.frow-open')");
      await page.until("document.querySelector('.files-viewer .viewer-text')", "text viewer");
      assert.equal(await page.eval("document.querySelector('.files-viewer .viewer-text').textContent"), NOTES);
      assert.equal(await page.text("document.querySelector('.files-viewer h1')"), "notes.txt");
      assert.equal(await page.has("document.querySelector('.files-viewer [data-act=download]')"), false, "no Download without the plugin");
      await page.fits("text viewer");
      await page.tap("document.querySelector('.files-viewer [data-act=back]')");
      await page.until("!document.querySelector('.sheet-backdrop')", "viewer closed by its back button");

      await page.tap("__row('README.md').querySelector('.frow-open')");
      await page.until("document.querySelector('.files-viewer .viewer-md .md-h1')", "markdown rendered");
      assert.equal(await page.text("document.querySelector('.files-viewer .viewer-md .md-h1')"), "Release notes");
      assert.equal(await page.eval("document.querySelectorAll('.files-viewer .viewer-md ol li').length"), 3);
      assert.ok(await page.has("document.querySelector('.files-viewer .viewer-md pre')"), "code block rendered");
      await page.fits("markdown viewer");
      await page.shot("files-live-preview.png");
      // The phone's Back (history) closes the viewer and stays on the screen.
      await page.eval("history.back()");
      await page.until("!document.querySelector('.sheet-backdrop')", "viewer closed by Back");
      assert.ok(await page.has("__row('README.md')"), "still on the Files screen after Back");

      await page.tap("__row('screenshot.png').querySelector('.frow-open')");
      await page.until("document.querySelector('.files-viewer .viewer-image img')?.naturalWidth === 240", "picture decoded");
      await page.fits("picture viewer");
      await page.shot("files-live-image.png");
      await page.eval("history.back()");
      await page.until("!document.querySelector('.sheet-backdrop')", "picture closed by Back");

      // ---------- no plugin: download and PDF say "update the app" ----------
      await page.tap("__row('manual.pdf').querySelector('.frow-open')");
      await page.toast("Update this app to download files and open PDFs", "PDF tapped");
      await page.tap("__row('app-release.apk').querySelector('.frow-open')");
      await page.toast("Update this app to download files", "other file tapped");
      assert.equal(await page.has("document.querySelector('.sheet-backdrop')"), false, "no download question without the plugin");

      // ---------- a sent file while the Files screen is open, and while a sheet is open there ----------
      await page.hold("__row('notes.txt').querySelector('.frow-open')");
      await page.until("document.querySelector('.sheet.menu')", "a sheet is open");
      const third = await served.offers.make(pagePhone.id, { path: path.join(fx.project, "README.md") });
      await sleep(600);
      assert.equal(await page.has("document.querySelector('.offer-ask')"), false, "the prompt does not stack on an open sheet");
      await page.eval("history.back()");
      await page.until("document.querySelector('.offer-ask .sheet p')?.textContent.includes('README.md')", "the prompt once the sheet closed");
      assert.ok(await page.has("__row('notes.txt')"), "over the Files screen");
      await sleep(QUIET_MS);
      await page.tap("document.querySelector('.offer-ask [data-v=\"0\"]')");
      await waitFor(() => offerStates.get(third.offer)?.state === "declined", "declined from the Files screen");

      // ---------- a long press: the sheet ----------
      await page.hold("__row('notes.txt').querySelector('.frow-open')");
      await page.until("document.querySelector('.sheet.menu')", "sheet after a long press");
      await sleep(400);
      assert.equal(await page.eval("document.querySelectorAll('.sheet-backdrop').length"), 1, "one sheet, still open after the finger is lifted");
      assert.equal(await page.text("document.querySelector('.sheet.menu .menu-title')"), "notes.txt", "the sheet names its file");
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.sheet.menu .menu-label')].map(x => x.textContent)"),
        ["Download: update the app", "Copy to…", "Move to…", "Rename", "Delete"]);
      assert.ok(await page.has("document.querySelector('.sheet.menu .menu-item.danger .menu-label')?.textContent === 'Delete'"), "Delete marked as dangerous");
      await page.fits("action sheet");
      await page.shot("files-live-sheet.png");
      await page.tap("document.querySelector('.sheet.menu .menu-item')");
      await page.toast("Update this app to download files", "sheet's Download");
      // A folder's sheet has nothing to download.
      await page.tap("__row('docs').querySelector('[data-more]')");
      await page.until("document.querySelector('.sheet.menu')", "folder's sheet");
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.sheet.menu .menu-label')].map(x => x.textContent)"), ["Copy to…", "Move to…", "Rename", "Delete"]);
      // Two sheets one over the other (a second one put over the folder's sheet here, as any part of the app might):
      // Back closes the one on top, then the one under it, and the screen stays.
      await page.eval(`(() => {
        const over = document.createElement('div');
        over.className = 'sheet-backdrop test-over';
        over.innerHTML = '<div class="sheet"><p>on top</p></div>';
        over.addEventListener('click', e => { if (e.target === over) over.remove(); });
        document.body.append(over);
      })()`);
      assert.equal(await page.eval("document.querySelectorAll('.sheet-backdrop').length"), 2, "two sheets");
      await page.eval("history.back()");
      await page.until("!document.querySelector('.test-over')", "Back closed the sheet on top");
      assert.ok(await page.has("document.querySelector('.sheet.menu')"), "the sheet under it is still open");
      await page.eval("history.back()");
      await page.until("!document.querySelector('.sheet-backdrop')", "sheet closed by Back");
      assert.ok(await page.has("__row('docs')"), "still on the Files screen");

      // ---------- a finger held on a row while the list is read again ----------
      // A search typed just before: the list is asked for again a moment later, in the middle of the press. The row's
      // place is another file's by then - no sheet may open for it. A row at the top of a list that is not scrolled:
      // a list that jumps back to its top ends the press by itself, as any scroll does.
      await page.eval("document.querySelector('.files-list').scrollTop = 0");
      await sleep(100);
      await page.tap("document.querySelector('.files-tools input')");
      await page.type("txt");
      await page.hold("__row('deep').querySelector('.frow-open')", 900);
      await page.until("__rows().length && __rows().every(x => x.name.includes('txt'))", "the list was read again under the finger");
      await sleep(300);
      assert.equal(await page.has("document.querySelector('.sheet-backdrop')"), false, "a press that began on the old list opens no sheet on the new one");
      assert.equal(await page.has("document.querySelector('.files-viewer')"), false, "and no file");
      await page.tap("document.querySelector('.files-tools [data-act=unfilter]')");
      await page.until("__row('README.md') && __row('docs')", "the search cleared after the press");

      const sheetPick = async (name, label) => {
        await page.tap(`__row(${JSON.stringify(name)}).querySelector('[data-more]')`);
        await page.until("document.querySelector('.sheet.menu')", `${name}'s sheet`);
        await page.tap(`[...document.querySelectorAll('.sheet.menu .menu-item')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`);
      };

      // ---------- rename onto a taken name: "name (2)" is offered ----------
      await sheetPick("rename-me.txt", "Rename");
      await page.until("document.querySelector('.sheet .sheet-input')", "rename field");
      assert.equal(await page.eval("document.querySelector('.sheet p').textContent"), "New name for “rename-me.txt”");
      assert.equal(await page.eval("document.querySelector('.sheet .sheet-input').value"), "rename-me.txt");
      await page.fits("rename sheet");
      await page.type("taken.txt"); // the name is selected: typing replaces it
      await page.tap("document.querySelector('.sheet button[type=submit]')");
      await page.until("document.querySelector('.sheet p')?.textContent.includes('is taken')", "taken name offered");
      assert.equal(await page.eval("document.querySelector('.sheet p').textContent"), "“taken.txt” is taken there. Name it “taken (2).txt” instead?");
      await page.tap("document.querySelector('.sheet [data-v=\"1\"]')");
      await page.toast("Renamed to taken (2).txt", "rename");
      await page.until("__row('taken (2).txt') && !__row('rename-me.txt')", "renamed row");
      assert.equal(await fsp.readFile(path.join(fx.project, "taken (2).txt"), "utf8"), "the one being renamed\n");
      assert.equal(await fsp.readFile(path.join(fx.project, "taken.txt"), "utf8"), "already here\n");
      assert.equal(fs.existsSync(path.join(fx.project, "rename-me.txt")), false);

      // ---------- copy through the folder dialog, with its New folder ----------
      await sheetPick("notes.txt", "Copy to…");
      await page.until("document.querySelector('.files-pick .menu-item')", "folder dialog with folders");
      assert.equal(await page.text("document.querySelector('.files-pick .pick-head b')"), "Copy “notes.txt” to…");
      assert.equal(await page.text("document.querySelector('.files-pick .pick-path')"), "harbor-app");
      const pickFolders = await page.eval("[...document.querySelectorAll('.files-pick .pick-body .menu-label')].map(x => x.textContent)");
      assert.deepEqual(pickFolders, [".cache", "deep", "docs", "many", "old-build", "src", "target"], "only folders in the dialog");
      await page.fits("folder dialog");
      await page.shot("files-live-chooser.png");
      await page.tap("[...document.querySelectorAll('.files-pick .pick-body .menu-item')].find(b => b.textContent.trim() === 'target')");
      await page.until("document.querySelector('.files-pick .pick-path')?.textContent === 'target' && document.querySelector('.files-pick .pick-body .empty')", "into target");
      await page.tap("document.querySelector('.files-pick [data-act=new]')");
      await page.until("document.activeElement?.matches('.files-pick .pick-new input')", "new folder name field");
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.files-pick > .sheet-actions')).display"), "none", "the dialog's own buttons hidden while naming");
      await page.fits("folder dialog, naming");
      await page.shot("files-live-new-folder.png");
      await page.type("fresh");
      await page.tap("document.querySelector('.files-pick .pick-new button[type=submit]')");
      await page.until("document.querySelector('.files-pick .pick-path')?.textContent === 'fresh'", "into the new folder");
      assert.ok(fs.statSync(path.join(fx.project, "target", "fresh")).isDirectory(), "new folder made on the host");
      await page.tap("document.querySelector('.files-pick [data-act=ok]')");
      await page.toast("Copied as notes.txt", "copy");
      assert.equal(await fsp.readFile(path.join(fx.project, "target", "fresh", "notes.txt"), "utf8"), NOTES);
      assert.equal(await fsp.readFile(path.join(fx.project, "notes.txt"), "utf8"), NOTES, "the source stays");
      // A copy into its own folder: "name (2)".
      await sheetPick("notes.txt", "Copy to…");
      await page.until("document.querySelector('.files-pick .pick-path')?.textContent === 'harbor-app' && !document.querySelector('.files-pick [data-act=ok]').disabled", "dialog in the project");
      await page.tap("document.querySelector('.files-pick [data-act=ok]')");
      await page.toast("Copied as notes (2).txt", "copy into the same folder");
      await page.until("__row('notes (2).txt')", "the copy listed");
      assert.equal(await fsp.readFile(path.join(fx.project, "notes (2).txt"), "utf8"), NOTES);

      // ---------- move ----------
      await sheetPick(CYR, "Move to…");
      await page.until("document.querySelector('.files-pick .menu-item')", "folder dialog for the move");
      assert.equal(await page.text("document.querySelector('.files-pick [data-act=ok]')"), "Move here");
      await page.tap("[...document.querySelectorAll('.files-pick .pick-body .menu-item')].find(b => b.textContent.trim() === 'target')");
      await page.until("document.querySelector('.files-pick .pick-path')?.textContent === 'target' && !document.querySelector('.files-pick [data-act=ok]').disabled", "into target");
      await page.tap("document.querySelector('.files-pick [data-act=ok]')");
      await page.toast(`Moved as ${CYR}`, "move");
      await page.until(`!__row(${JSON.stringify(CYR)})`, "moved row gone");
      assert.equal(fs.existsSync(path.join(fx.project, CYR)), false);
      assert.equal(await fsp.readFile(path.join(fx.project, "target", CYR), "utf8"), "на български\n");

      // ---------- a name with nowhere to break, in the sheets' text and in a toast ----------
      const textFits = sel => page.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].every(p => p.scrollWidth <= p.clientWidth + 1)`);
      await sheetPick(SOLID, "Rename");
      await page.until("document.querySelector('.sheet .sheet-input')", "rename field for the long name");
      await page.settle();
      assert.ok(await textFits(".sheet p"), "a long name wraps inside the rename sheet");
      await page.tap("document.querySelector('.sheet [data-v=\"0\"]')");
      await page.until("!document.querySelector('.sheet-backdrop')", "rename cancelled");
      await sheetPick(SOLID, "Delete");
      await page.until("document.querySelector('.sheet .btn.danger-solid')", "delete confirmation for the long name");
      await page.settle();
      assert.equal(await page.eval("document.querySelector('.sheet p').textContent"), `Delete “${SOLID}” on ${NODE_NAME} for good? ${NODE_NAME} has no bin: this cannot be undone.`, "a file's prompt");
      assert.ok(await textFits(".sheet p"), "a long name wraps inside the delete confirmation");
      await page.shot("files-live-delete-long.png");
      await page.tap("document.querySelector('.sheet [data-v=\"0\"]')");
      await page.until("!document.querySelector('.sheet-backdrop')", "delete cancelled");
      await sheetPick(SOLID, "Copy to…");
      await page.until("document.querySelector('.files-pick .pick-path')?.textContent === 'harbor-app' && !document.querySelector('.files-pick [data-act=ok]').disabled", "dialog for the long name");
      await page.tap("document.querySelector('.files-pick [data-act=ok]')");
      await page.until("!document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('Copied as')", "toast for the long name");
      await page.settle();
      assert.ok(await textFits("#toast"), "a long name wraps inside the toast");
      assert.ok(await page.eval("(() => { const r = document.querySelector('#toast').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), "the toast inside the screen");
      await page.shot("files-live-toast-long.png");
      await page.eval("document.querySelector('#toast').hidden = true");
      assert.ok(fs.existsSync(path.join(fx.project, SOLID.replace(/\.txt$/, " (2).txt"))), "the long name copied as (2)");

      // ---------- delete, always asked ----------
      await sheetPick("old-build", "Delete");
      await page.until("document.querySelector('.sheet .btn.danger-solid')", "delete confirmation");
      const ask = await page.eval("document.querySelector('.sheet p').textContent");
      assert.equal(ask, `Delete the folder “old-build” on ${NODE_NAME} for good, with everything in it? ${NODE_NAME} has no bin: this cannot be undone.`, "a folder's prompt says what goes with it");
      assert.equal(await page.text("document.querySelector('.sheet .btn.danger-solid')"), "Delete for good");
      assert.equal(await page.eval("document.activeElement?.dataset.v"), "0", "Cancel has the focus, not Delete");
      await page.fits("delete confirmation");
      await page.shot("files-live-delete.png");
      await page.tap("document.querySelector('.sheet [data-v=\"0\"]')");
      await page.until("!document.querySelector('.sheet-backdrop')", "cancelled");
      assert.ok(fs.existsSync(path.join(fx.project, "old-build")), "Cancel deletes nothing");
      await sheetPick("old-build", "Delete");
      await page.until("document.querySelector('.sheet .btn.danger-solid')", "delete confirmation again");
      await page.tap("document.querySelector('.sheet .btn.danger-solid')");
      await page.toast("Deleted for good: old-build", "delete");
      await page.until("!__row('old-build')", "deleted row gone");
      assert.equal(fs.existsSync(path.join(fx.project, "old-build")), false);

      // ---------- upload through the system's picker ----------
      const uploadOnce = async () => {
        const chosen = new Promise(resolve => { page.chooser = resolve; });
        await page.tap("document.querySelector('[data-act=upload]')");
        const { backendNodeId } = await Promise.race([chosen, sleep(10000).then(() => { throw new Error("Timed out: file picker"); })]);
        await page.send("DOM.setFileInputFiles", { files: [fx.upload], backendNodeId });
      };
      const sent = await fsp.readFile(fx.upload);
      await uploadOnce();
      // While it goes: its name, how far, Stop - under the list, inside the screen.
      await page.until("__vis(document.querySelector('.files-task')) && /of/.test(document.querySelector('.files-task small').textContent)", "upload progress shown");
      assert.equal(await page.text("document.querySelector('.files-task b')"), "Uploading upload-sample.bin");
      assert.equal(await page.text("document.querySelector('.files-task [data-act=stop]')"), "Stop");
      await page.fits("upload progress");
      await page.shot("files-live-progress.png");
      // Stop: nothing of it stays there.
      await page.tap("document.querySelector('.files-task [data-act=stop]')");
      await page.toast("Stopped. Nothing unfinished was kept.", "upload stopped");
      await page.until("!__vis(document.querySelector('.files-task'))", "progress gone after Stop");
      await waitFor(async () => !(await fsp.readdir(fx.project)).some(n => n.startsWith("upload-sample")), "nothing left of the stopped upload");
      await uploadOnce();
      await page.toast(`On ${NODE_NAME} as upload-sample.bin`, "upload");
      await page.until("__row('upload-sample.bin')", "uploaded file listed");
      assert.ok(sent.equals(await fsp.readFile(path.join(fx.project, "upload-sample.bin"))), "uploaded bytes equal");
      await uploadOnce();
      await page.toast(`On ${NODE_NAME} as upload-sample (2).bin`, "second upload");
      assert.ok(sent.equals(await fsp.readFile(path.join(fx.project, "upload-sample (2).bin"))), "second upload's bytes equal");
      assert.deepEqual((await fsp.readdir(fx.project)).filter(n => n.endsWith(".agentdeck-part")), [], "nothing half-written left");
      await page.fits("after the changes");

      // ---------- the drives: nothing to do to them, nothing to upload into ----------
      await page.tap("document.querySelector('.files-crumbs .crumb[data-path=\"\"]')");
      await page.until("document.querySelector('.files-crumbs .crumb[data-path=\"\"][aria-current]') && __rows().length", "the drives listed");
      assert.equal(await page.eval("__rows().some(x => x.more)"), false, "no actions on a drive");
      assert.equal(await page.eval("getComputedStyle(document.querySelector('[data-act=upload]')).display"), "none", "no Upload on the list of drives");
      await page.fits("drives");

      // ---------- in from a session ----------
      await page.eval("history.back()");
      await page.until("document.querySelector('.node-head [data-act=files]')", "back on the computer's screen");
      if (!await page.has("document.querySelector('.node [data-id=\"s-files\"]')")) await page.tap("document.querySelector('.node [data-fold]')");
      await page.until("document.querySelector('.node [data-id=\"s-files\"]')", "the session's row");
      await page.tap("document.querySelector('.node [data-id=\"s-files\"]')");
      await page.until("document.querySelector('.sess-head [data-act=files]')", "the session's Files button");
      await page.fits("session screen");
      await page.shot("files-live-session.png");
      await page.tap("document.querySelector('.sess-head [data-act=files]')");
      await page.until("__row('notes.txt')", "the session's folder listed");
      assert.equal(await page.eval("document.querySelector('.files-crumbs [aria-current]').textContent"), "harbor-app");
      page.off();
      await chrome.control.send("Target.closeTarget", { targetId: page.targetId });

      // ---------- Bulgarian ----------
      const bg = await phonePage(["bg-BG", "bg"]);
      await bg.until("document.querySelector('.tabbar [data-tab=computers]')", "bg: inbox (paired already)");
      assert.equal(await bg.eval("document.documentElement.lang"), "bg");
      await bg.tap("document.querySelector('.tabbar [data-tab=computers]')");
      await bg.until("[...document.querySelectorAll('[data-open]')].some(b => b.innerText.includes('desktop'))", "bg: computer online");
      await bg.tap("[...document.querySelectorAll('[data-open]')].find(b => b.innerText.includes('desktop'))");
      await bg.until("document.querySelector('.node-head [data-act=files]')", "bg: Files button");
      assert.equal(await bg.eval("document.querySelector('.node-head [data-act=files]').getAttribute('aria-label')"), "Файлове");
      await bg.tap("document.querySelector('.node-head [data-act=files]')");
      await bg.until("__row('harbor-app')", "bg: home listed");
      await bg.tap("__row('harbor-app').querySelector('.frow-open')");
      await bg.until("__row('notes.txt')", "bg: project listed");
      assert.equal(await bg.text("document.querySelector('#app header.top h1')"), `Файлове · ${NODE_NAME}`);
      assert.equal(await bg.text("document.querySelector('[data-act=upload]')"), "Качи файл");
      assert.match((await bg.eval("__rows()")).find(x => x.name === "app-release.apk").meta, /^300 KB · днес \d/);
      await bg.fits("bg: file list");
      await bg.shot("files-live-list-bg.png");
      await bg.tap("__row('notes.txt').querySelector('[data-more]')");
      await bg.until("document.querySelector('.sheet.menu')", "bg: sheet");
      assert.deepEqual(await bg.eval("[...document.querySelectorAll('.sheet.menu .menu-label')].map(x => x.textContent)"),
        ["Сваляне: обнови приложението", "Копирай в…", "Премести в…", "Преименувай", "Изтрий"]);
      await bg.fits("bg: sheet");
      await bg.shot("files-live-sheet-bg.png");
      await bg.eval("history.back()");
      await bg.until("!document.querySelector('.sheet-backdrop')", "bg: sheet closed");
      watching = false;
      bg.off();
      await chrome.control.send("Target.closeTarget", { targetId: bg.targetId });
      assert.deepEqual(errors, [], "no page errors");
    }, { host: hostOpts });
    console.log("mobile files live: the real phone app in a test Chrome (390x844, touch) paired through an encrypted relay with a served host: Files from a computer and from a session; Newest first and a search by name with its clear; a file the computer sends asked for on the computer's screen and on Files (not over an open sheet), Not now -> declined, Save without the plugin -> \"update the app\" and failed; folders first with hidden ones; breadcrumb; 620 entries in two pages; text, markdown and picture viewers; no-plugin download/PDF note; long-press sheet naming its file; Back closing the upper of two sheets; no sheet for a press the list was read again under; the sent file's prompt focused on Not now and deaf in its first moment; rename with \"(2)\"; copy and move through the folder dialog with New folder; delete for good with its confirmation; an upload stopped half-way leaving nothing, two uploads compared byte for byte; the drives without actions; English and Bulgarian; no page errors");
    console.log("Screenshots: .tmp/files-live-{node,offer,order,filter,list,preview,image,sheet,chooser,new-folder,delete,delete-long,toast-long,progress,session,list-bg,sheet-bg}.png (synthetic files only)");
  } catch (e) {
    // What the phone showed when it failed: a screenshot and its text.
    watching = false;
    if (current) {
      try { await current.shot("files-live-failure.png"); console.error("Failure screenshot: .tmp/files-live-failure.png"); } catch {}
      try { console.error("Screen text:", await current.eval("location.href + '\\n' + document.body.innerText")); } catch {}
    }
    if (errors.length) console.error("Page errors:", errors);
    if (logs.length) console.error("The page's last console lines:\n" + logs.slice(-40).join("\n"));
    throw e;
  } finally {
    watching = false;
    for (const b of browsers.reverse()) await b.stop();
    if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 250 });
  }
}
main().catch(e => { console.error(e); if (e?.errors) console.error(e.errors); process.exitCode = 1; });
