// Which parts a release builds (scripts/release-parts.js), in a made-up repository with the same shape as this
// one: every kind of change, changes that pile up while a part is skipped, a part whose build failed, the lock
// file, a build asked for by hand, the APK of the latest release. Then the real repository: what the builds take
// (package.json's build.files, the Dockerfile's COPY lines, the imports of the phone's page) is what the script
// counts for them.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const parts = require("./release-parts.js");

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-parts-"));
const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = files => {
  for (const [file, text] of Object.entries(files)) {
    const to = path.join(repo, file);
    if (text === null) { fs.rmSync(to); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`);
  }
};
const commit = (files, message = "change") => { write(files); git("add", "-A"); git("commit", "-q", "-m", message); };
const BASELINE = "v1.28.0"; // the made-up repository's last release that built everything
const clearTags = () => { for (const tag of git("tag").split("\n").filter(t => t && t !== BASELINE)) git("tag", "-d", tag); };
// Every scenario starts right after the last release that built everything - with the commit that brought
// release-parts.js on top of it - and with no tags left from the scenario before.
const start = () => {
  git("checkout", "-q", "-B", "work", "part-by-part");
  clearTags();
};
const plan = (force = []) => parts.plan({ cwd: repo, force });
const built = (force = []) => Object.entries(plan(force)).filter(([, r]) => r.build).map(([part]) => part);

const lock = versions => ({ name: "made-up", lockfileVersion: 3, packages: {
  "": { name: "made-up" },
  "node_modules/electron": { version: versions.electron || "40.0.0", dev: true },
  "node_modules/@noble/curves": { version: "1.9.0", dependencies: { "@noble/hashes": "1.8.0" } },
  "node_modules/@noble/hashes": { version: versions.hashes || "1.8.0" },
  "node_modules/ws": { version: versions.ws || "8.0.0" }
} });

try {
  git("init", "-q", "-b", "main");
  commit({
    "package.json": { name: "made-up", version: "0.0.0-development", scripts: { check: "node scripts/check.js" }, dependencies: { ws: "^8.0.0" } },
    "package-lock.json": lock({}),
    "THIRD_PARTY_NOTICES.md": "notices\n",
    "README.md": "readme\n",
    "LICENSE": "licence\n",
    ".gitignore": "node_modules/\n",
    ".dockerignore": "node_modules\n",
    ".releaserc.json": "{}\n",
    "docs/NOTES.md": "notes\n",
    ".github/workflows/release.yml": "name: Release\n",
    "scripts/test-something.js": "// a test\n",
    "build/icon.png": "icon\n",
    "native/helper.c": "int main(void) { return 0; }\n",
    "src/renderer.js": "// the window\n",
    "src/host/errors.js": "module.exports = {};\n",
    "src/host/usage.js": "module.exports = {};\n",
    "src/mesh/noise.js": "// require(\"ws\") is named in a comment only\nconst { x25519 } = require(\"@noble/curves/ed25519\");\nconst errors = require(\"../host/errors\");\nmodule.exports = { x25519, errors };\n",
    "src/mesh/server.js": "const { WebSocketServer } = require(\"ws\");\nmodule.exports = { WebSocketServer };\n",
    "src/shared/util.js": "module.exports = {};\n",
    "host/Dockerfile": "FROM node:24-alpine\n",
    "host/package.json": { name: "made-up-host" },
    "host/bin/host.js": "// the relay\n",
    "host/install.sh": "#!/bin/sh\n",
    "mobile/package.json": { name: "made-up-mobile" },
    "mobile/src/main.js": "import { x25519 } from \"../../src/mesh/noise.js\";\nimport \"./screen.js\";\nexport { x25519 };\n",
    "mobile/src/screen.js": "export const screen = 1;\n",
    "mobile/scripts/build.mjs": "// builds the page\n",
    "mobile/scripts/gradle.mjs": "// runs Gradle\n",
    "mobile/scripts/xcode.mjs": "// runs xcodebuild\n",
    "mobile/android/app/build.gradle": "// Android\n",
    "mobile/ios/App/Info.plist": "<plist/>\n"
  }, "the app");
  git("tag", BASELINE);
  commit({ "scripts/release-parts.js": "// from here on a release builds part by part\n" }, "ci: release by part");
  git("branch", "part-by-part");

  // Nothing changed: nothing is built, and every part is compared with the last release of everything.
  start();
  assert.deepEqual(built(), []);
  assert.deepEqual(Object.values(plan()).map(r => r.since), Array(4).fill(BASELINE));

  // One kind of change at a time.
  const cases = [
    [{ "docs/NOTES.md": "more\n", "README.md": "more\n" }, []],
    [{ ".github/workflows/release.yml": "name: Release 2\n", "scripts/test-something.js": "// more\n", ".releaserc.json": "{ }\n", "host/install.sh": "#!/bin/sh\n# more\n" }, []],
    [{ "src/renderer.js": "// more\n" }, ["desktop"]],
    [{ "build/icon.png": "another\n" }, ["desktop"]],
    [{ "native/helper.c": "int main(void) { return 1; }\n" }, ["desktop"]],
    [{ "THIRD_PARTY_NOTICES.md": "more\n" }, ["desktop"]],
    [{ "src/host/usage.js": "module.exports = { more: 1 };\n" }, ["desktop", "relay"]],
    [{ "src/shared/util.js": "module.exports = { more: 1 };\n" }, ["desktop", "relay"]],
    [{ "src/mesh/server.js": "// the phone does not bundle this one\n" }, ["desktop", "relay"]],
    [{ "src/mesh/noise.js": "const errors = require(\"../host/errors\");\nmodule.exports = { errors };\n" }, ["desktop", "android", "ios", "relay"]],
    [{ "src/host/errors.js": "module.exports = { more: 1 };\n" }, ["desktop", "android", "ios", "relay"]], // through noise.js
    [{ "host/bin/host.js": "// more\n" }, ["relay"]],
    [{ "host/Dockerfile": "FROM node:24-alpine\n# more\n" }, ["relay"]],
    [{ ".dockerignore": "dist\n" }, ["relay"]],
    [{ "mobile/src/screen.js": "export const screen = 2;\n" }, ["android", "ios"]],
    [{ "mobile/package.json": { name: "made-up-mobile", dependencies: {} } }, ["android", "ios"]],
    [{ "mobile/scripts/build.mjs": "// more\n" }, ["android", "ios"]],
    [{ "mobile/android/app/build.gradle": "// more\n" }, ["android"]],
    [{ "mobile/scripts/gradle.mjs": "// more\n" }, ["android"]],
    [{ "mobile/scripts/play-upload.mjs": "// new\n" }, ["android"]],
    [{ "mobile/ios/App/Info.plist": "<plist></plist>\n" }, ["ios"]],
    [{ "mobile/scripts/xcode.mjs": "// more\n" }, ["ios"]],
    [{ "mobile/scripts/ios-signing.mjs": "// new\n" }, ["ios"]],
    [{ "mobile/scripts/serve.mjs": "// new\n" }, []],
    [{ "src/renderer.js": null }, ["desktop"]],
    // A path nobody has placed yet builds everything.
    [{ "tools/new-thing.js": "// new\n" }, ["desktop", "android", "ios", "relay"]],
    [{ ".gitattributes": "* text=auto\n" }, ["desktop", "android", "ios", "relay"]]
  ];
  for (const [files, expected] of cases) {
    start();
    commit(files);
    assert.deepEqual(built(), expected, `changed: ${Object.keys(files).join(", ")}`);
  }

  // package.json: the commands of the repository are not the app; anything else of it is.
  start();
  commit({ "package.json": { name: "made-up", version: "0.0.0-development", scripts: { check: "node scripts/check.js", "test:new": "node scripts/test-new.js" }, dependencies: { ws: "^8.0.0" } } });
  assert.deepEqual(built(), []);
  commit({ "package.json": { name: "made-up", version: "0.0.0-development", scripts: {}, dependencies: { ws: "^8.1.0" } } });
  assert.deepEqual(built(), ["desktop"]);

  // The root's lock file: always the desktop; the phone only for a package its page bundles (or one that package
  // depends on) - "ws" is named in a comment of noise.js and required by a file the phone does not bundle.
  start();
  commit({ "package-lock.json": lock({ electron: "41.0.0", ws: "8.1.0" }) });
  assert.deepEqual(built(), ["desktop"]);
  commit({ "package-lock.json": lock({ electron: "41.0.0", hashes: "1.8.1" }) });
  assert.deepEqual(built(), ["desktop", "android", "ios"]);
  start();
  commit({ "package-lock.json": "not a lock file any more\n" });
  assert.deepEqual(built(), ["desktop", "android", "ios"]);

  // A change that was made and taken back leaves nothing to build.
  start();
  commit({ "mobile/src/screen.js": "export const screen = 2;\n" });
  commit({ "mobile/src/screen.js": "export const screen = 1;\n" });
  assert.deepEqual(built(), []);

  // Changes pile up for a part until it is released itself. A phone change comes with a push that releases
  // nothing (a docs commit beside it); then three desktop releases go by.
  start();
  commit({ "mobile/src/screen.js": "export const screen = 2;\n", "docs/NOTES.md": "more\n" }, "docs: notes");
  assert.deepEqual(built(), ["android", "ios"]);
  commit({ "src/renderer.js": "// 1.28.1\n" }, "fix: the window");
  assert.deepEqual(built(), ["desktop", "android", "ios"]);
  // 1.28.1 goes out: the desktop and Android are built, the iPhone build fails and leaves no tag.
  git("tag", "v1.28.1"); git("tag", "desktop-v1.28.1"); git("tag", "android-v1.28.1");
  assert.deepEqual(built(), ["ios"]);
  commit({ "docs/NOTES.md": "even more\n" }, "docs: more notes");
  assert.deepEqual(built(), ["ios"]);
  commit({ "src/renderer.js": "// 1.28.2\n" }, "fix: the window again");
  assert.deepEqual(built(), ["desktop", "ios"]);
  const piled = plan();
  assert.deepEqual([piled.desktop.since, piled.android.since, piled.ios.since, piled.relay.since], ["desktop-v1.28.1", "android-v1.28.1", BASELINE, BASELINE]);
  assert.deepEqual(piled.ios.files, ["mobile/src/screen.js"]);
  assert.deepEqual(piled.desktop.files, ["src/renderer.js"]);
  // 1.28.2: this time the iPhone build gets through.
  git("tag", "v1.28.2"); git("tag", "desktop-v1.28.2"); git("tag", "ios-v1.28.2");
  assert.deepEqual(built(), []);
  // The newest tag of a part counts, by version and not by name: 1.28.10 is after 1.28.9.
  commit({ "mobile/android/app/build.gradle": "// 1.28.9\n" });
  git("tag", "android-v1.28.9");
  commit({ "mobile/android/app/build.gradle": "// 1.28.10\n" });
  git("tag", "android-v1.28.10");
  assert.deepEqual(built(), []);
  assert.equal(plan().android.since, "android-v1.28.10");

  // A tag on a commit that is not below HEAD (another branch) says nothing about this one.
  start();
  commit({ "mobile/ios/App/Info.plist": "<plist>elsewhere</plist>\n" });
  git("tag", "ios-v1.30.0");
  git("checkout", "-q", "-B", "other", "part-by-part");
  commit({ "mobile/ios/App/Info.plist": "<plist>here</plist>\n" });
  assert.deepEqual(built(), ["ios"]);
  assert.equal(plan().ios.since, BASELINE);
  git("tag", "-d", "ios-v1.30.0");

  // Asked for by hand: built whatever changed, next to what changed anyway.
  start();
  assert.deepEqual(built(["ios"]), ["ios"]);
  assert.equal(plan(["ios"]).ios.forced, true);
  commit({ "src/renderer.js": "// more\n" });
  assert.deepEqual(built(["android", "ios"]), ["desktop", "android", "ios"]);
  assert.equal(plan(["android"]).desktop.forced, false);

  // The summary names the cause.
  const rows = parts.describe(plan(["ios"]));
  assert.deepEqual(rows.map(r => r.build), ["build", "skip", "build", "skip"]);
  assert.match(rows[0].cause, /src\/renderer\.js/);
  assert.match(rows[2].cause, /asked for by hand/);

  // An import of the page that leads nowhere: the phone apps are built rather than trusted to be unchanged.
  start();
  commit({ "mobile/src/main.js": "import \"../../src/mesh/gone.js\";\n" });
  git("tag", "android-v1.28.1"); git("tag", "ios-v1.28.1");
  assert.deepEqual(built(), ["android", "ios"]);
  assert.match(plan().ios.why, /could not be followed/);

  // The last release of everything is the newest version whose commit has no release-parts.js - not a fixed one.
  // Here the old workflow went on releasing (1.28.1, 1.28.2) before the new one was merged over it.
  git("checkout", "-q", "-B", "old", BASELINE);
  clearTags();
  commit({ "mobile/src/screen.js": "export const screen = 2;\n" }, "fix: the screen");
  git("tag", "v1.28.1");
  commit({ "src/renderer.js": "// 1.28.2\n" }, "fix: the window");
  git("tag", "v1.28.2");
  git("merge", "-q", "--no-edit", "part-by-part");
  assert.deepEqual(built(), []);
  assert.deepEqual(Object.values(plan()).map(r => r.since), Array(4).fill("v1.28.2"));
  // The first release of the new workflow: only the desktop changed, and its build fails - no part tag at all.
  // v1.28.3 is not taken for a release of everything: the desktop is still to be built, the rest stands at 1.28.2.
  commit({ "src/renderer.js": "// 1.28.3\n" }, "fix: the window");
  git("tag", "v1.28.3");
  assert.deepEqual(built(), ["desktop"]);
  assert.deepEqual(Object.values(plan()).map(r => r.since), Array(4).fill("v1.28.2"));
  commit({ "mobile/ios/App/Info.plist": "<plist>1.28.4</plist>\n" }, "fix: the iPhone app");
  git("tag", "v1.28.4"); git("tag", "desktop-v1.28.4"); git("tag", "ios-v1.28.4");
  assert.deepEqual(built(), []);
  assert.deepEqual([plan().desktop.since, plan().android.since, plan().ios.since], ["desktop-v1.28.4", "v1.28.2", "ios-v1.28.4"]);

  // No release from before release-parts.js is below HEAD, and a part has no tag of its own: it is built.
  start();
  git("tag", "relay-v1.28.1");
  git("tag", "-d", BASELINE);
  assert.deepEqual(built(), ["desktop", "android", "ios"]);
  assert.match(plan().desktop.why, /no earlier release/);
  git("tag", BASELINE, "part-by-part~1");

  // The command itself: the outputs of the job.
  start();
  commit({ "host/bin/host.js": "// more\n" });
  const outputs = path.join(repo, "outputs.txt"), summary = path.join(repo, "summary.md");
  const cli = (...args) => execFileSync(process.execPath, [path.join(__dirname, "release-parts.js"), ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary } });
  cli("plan", "--force", "ios");
  assert.deepEqual(fs.readFileSync(outputs, "utf8").trim().split("\n"), [
    "desktop=false", "force_desktop=false", "android=false", "force_android=false", "ios=true", "force_ios=true", "relay=true", "force_relay=false", "any=true", "forced=true"]);
  assert.match(fs.readFileSync(summary, "utf8"), /\| relay \| \*\*build\*\* \| v1\.28\.0 \| host\/bin\/host\.js \|/);
  fs.rmSync(outputs); fs.rmSync(summary);
  assert.throws(() => cli("plan", "--force", "phone"), /not a part: phone/);

  // The release marked latest carries the newest APK.
  const release = (tag, assets, draft = false) => ({ tag_name: tag, draft, assets: assets.map(name => ({ name })) });
  const desktop = v => [`AgentDeck-Setup-${v}.exe`, `AgentDeck-Setup-${v}.exe.blockmap`, "latest.yml"];
  // Everything was built: nothing to do.
  assert.equal(parts.apkCarry([release("v1.29.0", [...desktop("1.29.0"), "AgentDeck-1.29.0.apk"]), release("v1.28.0", [...desktop("1.28.0"), "AgentDeck-1.28.0.apk"])], "v1.29.0"), null);
  // A desktop release without the Android app: the last APK is copied onto it.
  assert.deepEqual(parts.apkCarry([release("v1.29.0", desktop("1.29.0")), release("v1.28.0", [...desktop("1.28.0"), "AgentDeck-1.28.0.apk"])], "v1.29.0"),
    { to: "v1.29.0", from: "v1.28.0", name: "AgentDeck-1.28.0.apk", remove: [] });
  // A release of the phone apps alone is not the latest one: its APK replaces the one of the latest release.
  assert.deepEqual(parts.apkCarry([release("v1.29.1", ["AgentDeck-1.29.1.apk"]), release("v1.29.0", [...desktop("1.29.0"), "AgentDeck-1.29.0.apk"])], "v1.29.0"),
    { to: "v1.29.0", from: "v1.29.1", name: "AgentDeck-1.29.1.apk", remove: ["AgentDeck-1.29.0.apk"] });
  // By version, not by the order of the list or of the letters; a draft is not looked at.
  assert.deepEqual(parts.apkCarry([release("v1.29.0", desktop("1.29.0")), release("v1.28.9", ["AgentDeck-1.28.9.apk"]), release("v1.28.10", ["AgentDeck-1.28.10.apk"]), release("v1.30.0", ["AgentDeck-1.30.0.apk"], true)], "v1.29.0"),
    { to: "v1.29.0", from: "v1.28.10", name: "AgentDeck-1.28.10.apk", remove: [] });
  // The newest is there already, beside an older one that was left behind.
  assert.deepEqual(parts.apkCarry([release("v1.29.0", [...desktop("1.29.0"), "AgentDeck-1.28.0.apk", "AgentDeck-1.29.1.apk"]), release("v1.29.1", ["AgentDeck-1.29.1.apk"])], "v1.29.0"),
    { to: "v1.29.0", from: null, name: "AgentDeck-1.29.1.apk", remove: ["AgentDeck-1.28.0.apk"] });
  // No APK anywhere, or no latest release: nothing to do. Other files are never touched.
  assert.equal(parts.apkCarry([release("v1.29.0", desktop("1.29.0"))], "v1.29.0"), null);
  assert.equal(parts.apkCarry([release("v1.29.1", ["AgentDeck-1.29.1.apk"])], ""), null);
  assert.equal(parts.apkCarry([release("v1.29.0", [...desktop("1.29.0"), "AgentDeck-1.29.0.apk", "AgentDeck-1.29.0.AppImage", "notes.apk"])], "v1.29.0"), null);
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

// --- The real repository ---------------------------------------------------------------------------------------
const root = path.join(__dirname, "..");
const goesInto = file => parts.partsOfPath(file) || parts.PARTS;

// The desktop: everything electron-builder is told to pack, and its build resources.
const builder = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build;
for (const pattern of builder.files.filter(p => !p.startsWith("!"))) {
  const sample = pattern.endsWith("/**") ? `${pattern.slice(0, -3)}/some/file.js` : pattern;
  assert.ok(goesInto(sample).includes("desktop"), `package.json packs ${pattern}, which does not count for the desktop`);
}
assert.ok(goesInto(`${builder.directories.buildResources}/icon.png`).includes("desktop"));

// The relay: everything its Dockerfile copies, the Dockerfile itself and what narrows its context.
const dockerfile = fs.readFileSync(path.join(root, "host", "Dockerfile"), "utf8");
const copied = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)].flatMap(m => m[1].trim().split(/\s+/).slice(0, -1)).filter(s => !s.startsWith("--"));
assert.ok(copied.length >= 5, "the COPY lines of host/Dockerfile were not read");
for (const source of copied) {
  const sample = fs.statSync(path.join(root, source)).isDirectory() ? `${source}/some/file.js` : source;
  assert.ok(goesInto(sample).includes("relay"), `host/Dockerfile copies ${source}, which does not count for the relay`);
}
for (const file of ["host/Dockerfile", ".dockerignore"]) assert.ok(goesInto(file).includes("relay"));

// The phone apps: the page's imports lead into the root, every one of them is found, and what they bundle from
// there is known - the Noise code and the packages under it.
const phone = parts.phoneBundle(root);
assert.deepEqual(phone.unresolved, []);
for (const file of ["src/mesh/noise.js", "src/mesh/web-client.js", "src/mesh/frames.js", "src/mesh/pair-code.js"]) assert.ok(phone.files.includes(file), `${file} is imported by the phone's page`);
assert.ok(phone.files.every(f => f.startsWith("src/")), `the phone's page bundles from outside src/: ${phone.files.join(", ")}`);
assert.ok(!phone.files.includes("src/mesh/server.js") && !phone.files.includes("src/main.js"));
for (const name of ["@noble/curves", "@noble/ciphers", "@noble/hashes"]) assert.ok(phone.packages.includes(name), `${name} is bundled into the phone's page`);
const realLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
assert.ok(JSON.parse(parts.lockSlice(realLock, phone.packages)).length >= 3);
assert.equal(parts.lockSlice(realLock, phone.packages).includes("node_modules/electron\""), false);

// The two apps in mobile/ go apart only by their own projects and scripts.
assert.deepEqual(goesInto("mobile/src/main.js"), ["android", "ios"]);
assert.deepEqual(goesInto("mobile/package-lock.json"), ["android", "ios"]);
assert.deepEqual(goesInto("mobile/static/index.html"), ["android", "ios"]);
assert.deepEqual(goesInto("mobile/capacitor.config.json"), ["android", "ios"]);
for (const file of fs.readdirSync(path.join(root, "mobile", "scripts"))) {
  const into = goesInto(`mobile/scripts/${file}`);
  assert.ok(into.length <= 2 && into.every(p => p === "android" || p === "ios"), `mobile/scripts/${file}`);
}

console.log("release parts OK");
