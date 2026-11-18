// Runs xcodebuild on the iOS project (ios/App), as gradle.mjs runs Gradle on the Android one. Only on a Mac - which
// here means a GitHub Actions runner: nobody builds the iPhone app by hand.
//
//   node scripts/xcode.mjs sim       the app for the simulator (Debug), signed to run locally: ios/build/sim/AgentDeck.app
//   node scripts/xcode.mjs archive   the app for a phone (Release), not signed yet: ios/build/AgentDeck.xcarchive
//   node scripts/xcode.mjs ipa       signs the archive for the App Store: ios/build/ipa/AgentDeck.ipa
//   node scripts/xcode.mjs upload    sends that file to App Store Connect (TestFlight)
//
// The version is the GitHub release's, as on Android (android/app/build.gradle): AGENTDECK_VERSION=1.23.4 ->
// CFBundleShortVersionString "1.23.4", CFBundleVersion 1023004 - App Store Connect takes a build only when its
// number is higher than the last one's. A local build is 0.0.0 (1).
//
// Signing (ipa) and the upload need only the App Store Connect API key in the environment - APPSTORE_API_KEY_FILE
// (the .p8), APPSTORE_API_KEY_ID, APPSTORE_API_ISSUER_ID, APPLE_TEAM_ID: the certificate and the profile to sign
// with are made from it for each release (ios-signing.mjs), so no certificate or its private key is kept anywhere.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { prepare } from "./ios-signing.mjs";

const BUNDLE = "com.mitrevstudio.agentdeck";
const ios = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "ios");
const project = path.join(ios, "App", "App.xcodeproj");
const out = path.join(ios, "build");
const archive = path.join(out, "AgentDeck.xcarchive");
const ipa = path.join(out, "ipa", "AgentDeck.ipa");

const version = (process.env.AGENTDECK_VERSION || "0.0.0").split("-")[0];
const [major, minor, patch] = [...version.split("."), "0", "0", "0"].slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
const settings = [`MARKETING_VERSION=${major}.${minor}.${patch}`, `CURRENT_PROJECT_VERSION=${Math.max(1, major * 1000000 + minor * 1000 + patch)}`];

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.map(a => (a.includes(process.env.APPSTORE_API_KEY_FILE || "\0") ? "<key>" : a)).join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: ios, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const need = names => {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) { console.error(`Not set: ${missing.join(", ")}`); process.exit(1); }
  return names.map(n => process.env[n]);
};

const what = process.argv[2];
if (process.platform !== "darwin") {
  console.error("The iOS app is built on macOS only (GitHub Actions: the mobile-ios job of ci.yml, build-ios of release.yml).");
  process.exit(1);
}
if (what === "sim") {
  const derived = path.join(out, "derived");
  run("xcodebuild", ["-project", project, "-scheme", "App", "-configuration", "Debug", "-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", derived, "ONLY_ACTIVE_ARCH=NO", "ARCHS=arm64", ...settings, "build"]);
  const app = path.join(out, "sim", "AgentDeck.app");
  rmSync(path.dirname(app), { recursive: true, force: true });
  mkdirSync(path.dirname(app), { recursive: true });
  cpSync(path.join(derived, "Build", "Products", "Debug-iphonesimulator", "AgentDeck.app"), app, { recursive: true });
  console.log(`\nApp: ${app}`);
} else if (what === "archive") {
  rmSync(archive, { recursive: true, force: true });
  // Not signed here: signing settings on the command line would reach the packages' targets too. The archive is
  // signed for the App Store when it is exported (ipa).
  run("xcodebuild", ["-project", project, "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS",
    "-derivedDataPath", path.join(out, "derived"), "-archivePath", archive, "CODE_SIGNING_ALLOWED=NO", ...settings, "archive"]);
  console.log(`\nArchive: ${archive}`);
} else if (what === "ipa") {
  const [key, keyId, issuer, team] = need(["APPSTORE_API_KEY_FILE", "APPSTORE_API_KEY_ID", "APPSTORE_API_ISSUER_ID", "APPLE_TEAM_ID"]);
  const signing = await prepare({ keyFile: key, keyId, issuer, bundleId: BUNDLE });
  const options = path.join(out, "export.plist");
  writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key><string>app-store-connect</string>
	<key>destination</key><string>export</string>
	<key>signingStyle</key><string>manual</string>
	<key>signingCertificate</key><string>Apple Distribution</string>
	<key>provisioningProfiles</key><dict><key>${BUNDLE}</key><string>${signing.profile}</string></dict>
	<key>teamID</key><string>${team}</string>
	<key>manageAppVersionAndBuildNumber</key><false/>
	<key>uploadSymbols</key><true/>
</dict>
</plist>
`);
  rmSync(path.dirname(ipa), { recursive: true, force: true });
  const r = spawnSync("xcodebuild", ["-exportArchive", "-archivePath", archive, "-exportPath", path.dirname(ipa), "-exportOptionsPlist", options], { cwd: ios, stdio: "inherit" });
  signing.remove();
  if (r.status !== 0) process.exit(r.status ?? 1);
  const made = readdirSync(path.dirname(ipa)).find(f => f.endsWith(".ipa"));
  if (!made) { console.error("xcodebuild made no .ipa"); process.exit(1); }
  console.log(`\nIPA: ${path.join(path.dirname(ipa), made)}`);
} else if (what === "upload") {
  const [key, keyId, issuer] = need(["APPSTORE_API_KEY_FILE", "APPSTORE_API_KEY_ID", "APPSTORE_API_ISSUER_ID"]);
  const file = existsSync(ipa) ? ipa : path.join(path.dirname(ipa), readdirSync(path.dirname(ipa)).find(f => f.endsWith(".ipa")) || "AgentDeck.ipa");
  // altool looks for the key by its id in ~/.appstoreconnect/private_keys; it is taken away again after the upload.
  const keys = path.join(os.homedir(), ".appstoreconnect", "private_keys"), copy = path.join(keys, `AuthKey_${keyId}.p8`);
  mkdirSync(keys, { recursive: true });
  cpSync(key, copy);
  const r = spawnSync("xcrun", ["altool", "--upload-app", "--type", "ios", "--file", file, "--apiKey", keyId, "--apiIssuer", issuer], { cwd: ios, stdio: "inherit" });
  rmSync(copy, { force: true });
  process.exit(r.status ?? 1);
} else {
  console.error("usage: node scripts/xcode.mjs sim | archive | ipa | upload");
  process.exit(2);
}
