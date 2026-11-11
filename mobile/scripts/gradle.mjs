// Runs the Android project's Gradle wrapper (gradlew / gradlew.bat) with the given tasks. ANDROID_HOME and
// JAVA_HOME are filled in when they are not set: the SDK from its usual place (%LOCALAPPDATA%\Android\Sdk,
// ~/Library/Android/sdk, ~/Android/Sdk), Java from JAVA_HOME or the JDK 21 Android Studio would use. The SDK path is
// also written to android/local.properties (not in git), which Gradle reads first.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const android = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "android");
const env = { ...process.env };

const sdkCandidates = [
  env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
  env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Android", "Sdk"),
  path.join(os.homedir(), "Library", "Android", "sdk"),
  path.join(os.homedir(), "Android", "Sdk")
].filter(Boolean);
const sdk = sdkCandidates.find(p => existsSync(p));
if (!sdk) {
  console.error("Android SDK not found: set ANDROID_HOME.");
  process.exit(1);
}
env.ANDROID_HOME = sdk;
writeFileSync(path.join(android, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}\n`);

if (!env.JAVA_HOME) {
  const jdk = ["C:\\Program Files\\Java\\jdk-21", "C:\\Program Files\\Android\\Android Studio\\jbr", "/Applications/Android Studio.app/Contents/jbr/Contents/Home"].find(p => existsSync(p));
  if (jdk) env.JAVA_HOME = jdk;
}

const win = process.platform === "win32";
const tasks = process.argv.slice(2);
// The full path: cmd.exe may be told not to look in the current folder (NoDefaultCurrentDirectoryInExePath).
const wrapper = win ? `"${path.join(android, "gradlew.bat")}"` : "./gradlew";
const r = spawnSync(wrapper, tasks.length ? tasks : ["assembleDebug"], { cwd: android, env, stdio: "inherit", shell: win });
if (r.status === 0 && tasks.includes("assembleDebug")) console.log(`\nAPK: ${path.join(android, "app", "build", "outputs", "apk", "debug", "app-debug.apk")}`);
process.exit(r.status ?? 1);
