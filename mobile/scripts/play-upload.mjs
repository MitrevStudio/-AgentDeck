// Sends the Android app's bundle (.aab) to a testing track of Google Play, as xcode.mjs sends the iPhone app to
// TestFlight. Run by the release workflow (build-android of release.yml) after the bundle is built and signed:
//
//   node scripts/play-upload.mjs android/app/build/outputs/bundle/release/app-release.aab
//
// From the environment:
//   PLAY_SERVICE_ACCOUNT_JSON   the key of a Google service account that may release the app to testing: the JSON
//                               file Google Cloud gives, as it is or in base64 (how it is made - docs/MOBILE.md §12)
//   PLAY_TRACK                  the track: internal (the default), alpha (closed testing), beta (open testing)
//   PLAY_RELEASE_STATUS         completed (the default: the testers get it at once) or draft
//   PLAY_PACKAGE                the app; com.mitrevstudio.agentdeck when not set
//
// Nothing but Node: the key signs a short-lived request for a token (a JWT, RS256), and the token speaks to the
// Android Publisher API - an "edit" is opened, the bundle goes into it, the track is pointed at the bundle's
// version code, the edit is committed. Until the commit Google Play changes nothing, and an edit that fails is
// thrown away. The key and the token are never printed.
//
// Google Play answers the first-time troubles with texts of its own; explain() says what each one asks of the
// owner. An app that was never published takes only draft releases through the API ("Only releases with status
// draft may be created on draft app"): the release is then left as a draft, to be rolled out in Play Console.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_URL = "https://androidpublisher.googleapis.com";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const PACKAGE = "com.mitrevstudio.agentdeck";
const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

// The secret as it was stored: the JSON itself, or the JSON in base64. Nothing of it reaches an error's text.
export function serviceAccount(secret) {
  const text = String(secret || "").trim();
  let account = null;
  for (const candidate of [text, Buffer.from(text, "base64").toString("utf8")]) {
    try { account = JSON.parse(candidate); break; } catch {}
  }
  if (!account || typeof account !== "object") throw new Error("PLAY_SERVICE_ACCOUNT_JSON is neither the JSON key of a service account nor that JSON in base64");
  if (account.type !== "service_account" || !account.client_email || !account.private_key) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not the key of a service account (type, client_email and private_key are expected in it)");
  let key;
  try { key = createPrivateKey(account.private_key); } catch { throw new Error("the private key in PLAY_SERVICE_ACCOUNT_JSON cannot be read"); }
  return { email: account.client_email, key };
}

// The signed request for a token: who asks (the service account), for what (the Play API), from whom, for an hour at most.
export function assertion(account, { tokenUrl = TOKEN_URL, now = Math.floor(Date.now() / 1000) } = {}) {
  const head = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: account.email, scope: SCOPE, aud: tokenUrl, iat: now, exp: now + 600 })}`;
  return `${head}.${sign("sha256", Buffer.from(head), account.key).toString("base64url")}`;
}

// The track's new state: one release with this bundle.
export const trackBody = (track, versionCode, status) => ({ track, releases: [{ status, versionCodes: [String(versionCode)] }] });

// What Google's answer asks of the owner, when it is one of the known ones.
export function explain(status, message, { track = "internal" } = {}) {
  const m = String(message || "");
  if (/has not been used in project|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(m)) return "the Google Play Android Developer API is not enabled in the Google Cloud project of the service account - enable it there (docs/MOBILE.md §12.2)";
  if (/invalid_grant|Invalid JWT|account not found|invalid_client/i.test(m)) return "Google does not accept the key: it was deleted or disabled in Google Cloud, or the clock of this machine is wrong - make a new key and store it again (docs/MOBILE.md §12.4)";
  if (/Package not found|No application was found/i.test(m)) return "Google Play knows no such app for this account: create the app in Play Console and upload its first bundle by hand, then invite the service account to it (docs/MOBILE.md §12.1, §12.3)";
  if (/does not have permission|PERMISSION_DENIED|insufficient permissions/i.test(m) || status === 401) return "the service account may not release this app: invite its e-mail in Play Console → Users and permissions with \"Release to testing tracks\" for the app (docs/MOBILE.md §12.3); a new invitation can take a few minutes to work";
  if (/already been used|Version code \d+ (has|is|was)/i.test(m)) return "Google Play already has a bundle with this version code (or a higher one on the track): every upload needs a new, higher version, so this version cannot be sent again";
  if (/Only releases with status draft/i.test(m)) return "the app was never published, so Google Play takes only draft releases for it through the API";
  if (/track.*not found|Track not found/i.test(m)) return `Google Play has no track "${track}" for this app (internal, alpha, beta or the name of a closed track)`;
  if (/signed with the wrong key|wrong signing key|not signed|upload certificate/i.test(m)) return "the bundle is not signed with the upload key Google Play has for this app: the first bundle, uploaded by hand, fixes that key (docs/MOBILE.md §12.1)";
  return "";
}

class PlayError extends Error {
  constructor(step, status, message, hint) {
    super(`Google Play, ${step}: HTTP ${status} - ${message}${hint ? `\n  → ${hint}` : ""}`);
    this.status = status; this.reason = message; this.hint = hint;
  }
}

// -> { versionCode, track, status }. status is "draft" when Google Play would not take anything else.
// tokenUrl, apiUrl and fetch are the test's way in.
export async function upload({ account, bundle, packageName = PACKAGE, track = "internal", status = "completed", tokenUrl = TOKEN_URL, apiUrl = API_URL, fetch = globalThis.fetch, log = console.log }) {
  const fail = async (step, res) => {
    const text = await res.text();
    let message = text.replace(/\s+/g, " ").slice(0, 300);
    try { const e = JSON.parse(text); message = e.error?.message || e.error_description || (typeof e.error === "string" ? e.error : message); } catch {}
    return new PlayError(step, res.status, message, explain(res.status, `${message} ${text.slice(0, 2000)}`, { track }));
  };

  const asked = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion(account, { tokenUrl }) }) });
  if (!asked.ok) throw await fail("signing in with the service account", asked);
  const token = (await asked.json()).access_token;
  if (!token) throw new Error("Google gave no access token for the service account");

  const app = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const call = async (step, method, url, body, type = "application/json") => {
    const res = await fetch(apiUrl + url, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": type }) },
      body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body });
    if (!res.ok) throw await fail(step, res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  const edit = (await call("opening an edit", "POST", `${app}/edits`, {})).id;
  try {
    const sent = await call("uploading the bundle", "POST", `/upload${app}/edits/${edit}/bundles?uploadType=media`, bundle, "application/octet-stream");
    const versionCode = sent.versionCode;
    log(`Bundle uploaded: version code ${versionCode}`);

    const draftOnly = e => e instanceof PlayError && /Only releases with status draft/i.test(e.reason);
    const point = to => call(`putting the release on the ${track} track`, "PUT", `${app}/edits/${edit}/tracks/${encodeURIComponent(track)}`, trackBody(track, versionCode, to));
    const commit = async () => {
      try { await call("committing the edit", "POST", `${app}/edits/${edit}:commit`); }
      catch (e) {
        // An account whose changes wait for a review of the app takes the commit only with this said.
        if (!(e instanceof PlayError) || !/changesNotSentForReview/.test(e.reason)) throw e;
        await call("committing the edit", "POST", `${app}/edits/${edit}:commit?changesNotSentForReview=true`);
        log("Committed without sending the changes for review: send them from Play Console → Publishing overview");
      }
    };
    try {
      await point(status);
      await commit();
    } catch (e) {
      if (status === "draft" || !draftOnly(e)) throw e;
      status = "draft";
      await point(status);
      await commit();
    }
    log(status === "draft"
      ? `Version code ${versionCode} is a draft release on the ${track} track: roll it out in Play Console (Testing → the track → the draft release → Review and roll out)`
      : `Version code ${versionCode} is released on the ${track} track`);
    return { versionCode, track, status };
  } catch (e) {
    // The edit is not left behind; Google Play would drop it by itself in time.
    try { await call("dropping the edit", "DELETE", `${app}/edits/${edit}`); } catch {}
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/play-upload.mjs <app-release.aab>"); process.exit(2); }
  if (!process.env.PLAY_SERVICE_ACCOUNT_JSON) { console.error("Not set: PLAY_SERVICE_ACCOUNT_JSON"); process.exit(1); }
  try {
    const bundle = readFileSync(file);
    console.log(`Bundle: ${file} (${(bundle.length / 1048576).toFixed(1)} MB)`);
    await upload({ account: serviceAccount(process.env.PLAY_SERVICE_ACCOUNT_JSON), bundle, packageName: process.env.PLAY_PACKAGE || PACKAGE,
      track: process.env.PLAY_TRACK || "internal", status: process.env.PLAY_RELEASE_STATUS || "completed" });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
