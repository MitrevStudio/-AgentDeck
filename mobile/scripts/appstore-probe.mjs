// TEMPORARY (the signing trial of this branch): what the App Store Connect API key may do. Prints HTTP statuses and
// counts by type only - no names, ids or contents.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const { APPSTORE_API_KEY_FILE: file, APPSTORE_API_KEY_ID: kid, APPSTORE_API_ISSUER_ID: iss } = process.env;
const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64({ iss, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
const token = `${head}.${sign("sha256", Buffer.from(head), { key: createPrivateKey(readFileSync(file)), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;

async function ask(what, url, field) {
  try {
    const r = await fetch(`https://api.appstoreconnect.apple.com${url}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => ({}));
    const counts = {};
    for (const x of body.data || []) { const k = field ? x.attributes?.[field] : "all"; counts[k] = (counts[k] || 0) + 1; }
    const errors = (body.errors || []).map(e => `${e.status} ${e.code}`).join("; ");
    console.log(`${what}: HTTP ${r.status}${body.data ? ` ${JSON.stringify(counts)}` : ""}${errors ? ` ${errors}` : ""}`);
  } catch (e) { console.log(`${what}: ${e.message}`); }
}
await ask("apps (this bundle id)", "/v1/apps?filter[bundleId]=com.mitrevstudio.agentdeck&fields[apps]=bundleId");
await ask("bundle ids (this one)", "/v1/bundleIds?filter[identifier]=com.mitrevstudio.agentdeck&fields[bundleIds]=platform", "platform");
await ask("certificates", "/v1/certificates?limit=200&fields[certificates]=certificateType", "certificateType");
await ask("profiles", "/v1/profiles?limit=200&fields[profiles]=profileType,profileState", "profileType");
await ask("devices", "/v1/devices?limit=200&fields[devices]=platform,status", "status");
