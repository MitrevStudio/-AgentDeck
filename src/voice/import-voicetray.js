// One-time import of VoiceTray's settings and history (%APPDATA%\VoiceTray, only ever read). Records are copied
// as-is - our sidecars have VoiceTray's shape - and job-store.recoverOnStartup() re-points their AudioPath, so run
// this before it. Done once for good: marked in the settings (voice.importedFromVoiceTray) and by a file beside the
// records, so losing either one does not bring back records deleted or pruned since.
const fs = require("node:fs");
const path = require("node:path");
const settings = require("./settings");
const store = require("./job-store");
const { SAFE_ID, isObj } = require("./util");

const MARKER = ".imported-from-voicetray";

function defaultSource() {
  const appData = process.env.APPDATA || require("electron").app.getPath("appData");
  return path.join(appData, "VoiceTray");
}

const readJson = async file => JSON.parse((await fs.promises.readFile(file, "utf8")).replace(/^﻿/, ""));

// Temp name + rename, so an interrupted import never leaves a half-copied file under a real name
// (recoverOnStartup sweeps the *.tmp leftovers).
async function copyAtomic(from, to) {
  await fs.promises.copyFile(from, to + ".tmp");
  await fs.promises.rename(to + ".tmp", to);
}

function mapSettings(vt) {
  const patch = {};
  if (typeof vt.Provider === "string" && settings.PROVIDERS.includes(vt.Provider)) patch.provider = vt.Provider;
  if (vt.Models && typeof vt.Models === "object") {
    patch.models = {};
    for (const p of settings.PROVIDERS) if (typeof vt.Models[p] === "string" && vt.Models[p].trim()) patch.models[p] = vt.Models[p].trim();
  }
  if (typeof vt.Language === "string") patch.language = vt.Language;
  // MicrophoneDeviceId is a WinMM index and means nothing to the browser; the name is what gets matched.
  if (typeof vt.MicrophoneName === "string") patch.microphoneName = vt.MicrophoneName;
  if (typeof vt.UseClipboardFallback === "boolean") patch.useClipboardPaste = vt.UseClipboardFallback;
  if (Number.isFinite(vt.MaxRecordingMinutes)) patch.maxRecordingMinutes = vt.MaxRecordingMinutes;
  if (typeof vt.ReadAloudModel === "string") patch.readAloudModel = vt.ReadAloudModel;
  if (typeof vt.ReadAloudVoice === "string") patch.readAloudVoice = vt.ReadAloudVoice;
  if (Number.isFinite(vt.ReadAloudSpeed)) patch.readAloudSpeed = vt.ReadAloudSpeed;
  return patch;
}

async function importSettings(source) {
  const none = { settings: false, apiKeys: 0 };
  // Settings of our own are never replaced by VoiceTray's, even when the import marker went missing.
  if (await settings.hasVoiceSection()) return none;
  let vt;
  try { vt = await readJson(path.join(source, "settings.json")); } catch { return none; }
  if (!isObj(vt)) return none;
  await settings.save(mapSettings(vt));
  let apiKeys = 0;
  for (const [provider, key] of Object.entries(vt.ApiKeys || {})) {
    // A key we already hold wins: it may have been corrected here since.
    if (!settings.PROVIDERS.includes(provider) || typeof key !== "string" || !key.trim() || settings.hasApiKey(provider)) continue;
    // No safeStorage means no key rather than a plaintext one; the user can enter it in the settings.
    try { await settings.setApiKey(provider, key); apiKeys++; } catch {}
  }
  return { settings: true, apiKeys };
}

async function importRecords(source, target) {
  const from = path.join(source, "records");
  let names;
  try { names = (await fs.promises.readdir(from)).filter(n => n.toLowerCase().endsWith(".json")); } catch { return { records: 0, skipped: 0 }; }
  await fs.promises.mkdir(target, { recursive: true });
  let records = 0, skipped = 0;
  for (const name of names) {
    const id = name.slice(0, -5);
    let job = null;
    try { job = await readJson(path.join(from, name)); } catch {}
    const wav = path.join(from, id + ".wav");
    // Only finished records (anything else is still being worked on by a running VoiceTray), and only ones with
    // something left to show - recoverOnStartup() would drop a record with neither text nor audio anyway.
    const ok = job && job.Id === id && SAFE_ID.test(id) && (job.Status === "Done" || job.Status === "Failed")
      && (job.ResultText || fs.existsSync(wav));
    if (!ok || fs.existsSync(path.join(target, name))) { skipped++; continue; }
    try {
      // Audio first: a sidecar without its audio would be skipped as "existing" next time and the audio lost.
      if (fs.existsSync(wav)) await copyAtomic(wav, path.join(target, id + ".wav"));
      await copyAtomic(path.join(from, name), path.join(target, name));
      records++;
    } catch { skipped++; }
  }
  return { records, skipped };
}

// Idempotent: {settings:false, apiKeys:0, records:0, skipped:0} once done. Call after app 'ready' (safeStorage)
// and before store.recoverOnStartup(); copying a long history takes a while, nothing else waits for it.
async function importIfNeeded({ sourceDir, recordsDir } = {}) {
  const none = { settings: false, apiKeys: 0, records: 0, skipped: 0 };
  const target = recordsDir || store.dir();
  const marker = path.join(target, MARKER);
  const markFile = async at => {
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.writeFile(marker, at);
  };
  if (fs.existsSync(marker)) return none;
  const doneAt = settings.load().importedFromVoiceTray;
  if (doneAt) { await markFile(doneAt); return none; } // imported before the marker file existed
  const source = sourceDir || defaultSource();
  const result = fs.existsSync(source) ? { ...(await importSettings(source)), ...(await importRecords(source, target)) } : none;
  const at = new Date().toISOString();
  await markFile(at);
  await settings.save({ importedFromVoiceTray: at });
  return result;
}

module.exports = { importIfNeeded, mapSettings };
