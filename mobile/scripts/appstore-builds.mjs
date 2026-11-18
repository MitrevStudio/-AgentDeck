// TEMPORARY (the signing trial of this branch): what App Store Connect made of the uploaded builds, and what the
// trial left in the account. States and counts only.
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const { APPSTORE_API_KEY_FILE: file, APPSTORE_API_KEY_ID: kid, APPSTORE_API_ISSUER_ID: iss } = process.env;
const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: "ES256", kid, typ: "JWT" })}.${b64({ iss, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
const token = `${head}.${sign("sha256", Buffer.from(head), { key: createPrivateKey(readFileSync(file)), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
const get = async url => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${url}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) console.log(`${url.split("?")[0]}: HTTP ${r.status} ${(body.errors || []).map(e => e.code).join(", ")}`);
  return body;
};
const app = (await get("/v1/apps?filter[bundleId]=com.mitrevstudio.agentdeck&fields[apps]=bundleId")).data?.[0];
const builds = await get(`/v1/builds?filter[app]=${app.id}&limit=20&sort=-uploadedDate&include=preReleaseVersion,buildBetaDetail&fields[builds]=version,processingState,expired,usesNonExemptEncryption,minOsVersion,uploadedDate,preReleaseVersion,buildBetaDetail&fields[preReleaseVersions]=version&fields[buildBetaDetails]=internalBuildState,externalBuildState`);
const inc = new Map((builds.included || []).map(x => [`${x.type}:${x.id}`, x.attributes]));
for (const b of builds.data || []) {
  const pre = inc.get(`preReleaseVersions:${b.relationships?.preReleaseVersion?.data?.id}`), beta = inc.get(`buildBetaDetails:${b.relationships?.buildBetaDetail?.data?.id}`);
  console.log(`build ${pre?.version} (${b.attributes.version}): ${b.attributes.processingState}, expired ${b.attributes.expired}, usesNonExemptEncryption ${b.attributes.usesNonExemptEncryption}, iOS ${b.attributes.minOsVersion}+, internal ${beta?.internalBuildState}, external ${beta?.externalBuildState}`);
}
if (!builds.data?.length) console.log("no builds listed yet");
const count = (list, field) => JSON.stringify((list.data || []).reduce((m, x) => { m[x.attributes[field]] = (m[x.attributes[field]] || 0) + 1; return m; }, {}));
console.log(`certificates: ${count(await get("/v1/certificates?limit=200&fields[certificates]=certificateType"), "certificateType")}`);
console.log(`profiles: ${count(await get("/v1/profiles?limit=200&fields[profiles]=profileType,profileState"), "profileState")}`);
