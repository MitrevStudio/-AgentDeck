// What signing the iPhone app for the App Store takes, made on the runner from the App Store Connect API key alone
// (xcode.mjs ipa): a distribution certificate and a provisioning profile, in a keychain of their own.
//
// Xcode can do all of this by itself in Apple's cloud, but only for a key with the Admin role ("Cloud signing
// permission error" for any other). The key here is an App Manager's, which may ask the API for the same things:
//   1. a private key and a certificate request are made here (openssl) and the API signs the request into an
//      "Apple Distribution" certificate (POST /v1/certificates);
//   2. an App Store profile for the app with that certificate (POST /v1/profiles), named "AgentDeck CI <time>";
//   3. both go where xcodebuild looks: a keychain made for this run, the profiles folder.
// The private key never leaves the runner and is gone with it, so every release makes a new certificate - and
// first removes what the release before it made: the profiles named "AgentDeck CI ..." and the certificates in
// them. Found by that name, so no other certificate or profile of the account is ever touched. They are not removed
// at the end of the same run: Apple is still looking at the upload then. Between releases the account so holds one
// distribution certificate of the CI (of the three Apple allows).
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://api.appstoreconnect.apple.com";
const NAME = "AgentDeck CI";
const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");

// The API as the key: a token of ten minutes for every call.
function client({ keyFile, keyId, issuer }) {
  const key = createPrivateKey(readFileSync(keyFile));
  return async function call(method, url, body) {
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "ES256", kid: keyId, typ: "JWT" })}.${b64({ iss: issuer, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
    const token = `${head}.${sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    const res = await fetch(url.startsWith("http") ? url : API + url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) {
      let why = text.slice(0, 300);
      try { why = JSON.parse(text).errors.map(e => `${e.code}: ${e.detail || e.title}`).join("; "); } catch {}
      throw new Error(`App Store Connect API, ${method} ${url.split("?")[0]}: HTTP ${res.status} - ${why}`);
    }
    return text ? JSON.parse(text) : null;
  };
}

function run(cmd, args, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed${quiet ? "" : `: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`}`);
  return r.stdout;
}
// Signing identities the keychain holds that codesign would take (their names are not printed: a person's is in them).
const identities = keychain => Number(run("security", ["find-identity", "-v", "-p", "codesigning", keychain]).match(/(\d+) valid identit/)?.[1] || 0);

// -> { profile, keychain, remove() }. profile: the profile's name, for the export options.
export async function prepare({ keyFile, keyId, issuer, bundleId }) {
  const call = client({ keyFile, keyId, issuer });
  const dir = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "agentdeck-signing-"));

  // What the release before this one left.
  const old = (await call("GET", "/v1/profiles?limit=200&fields[profiles]=name")).data.filter(p => p.attributes.name.startsWith(`${NAME} `));
  for (const p of old) {
    const certs = (await call("GET", `/v1/profiles/${p.id}/certificates?fields[certificates]=certificateType`)).data.filter(c => /DISTRIBUTION/.test(c.attributes.certificateType));
    await call("DELETE", `/v1/profiles/${p.id}`);
    for (const c of certs) { try { await call("DELETE", `/v1/certificates/${c.id}`); } catch (e) { console.log(`an old certificate stays: ${e.message}`); } }
  }
  if (old.length) console.log(`Removed ${old.length} earlier "${NAME}" profile(s) and their certificates`);

  // 1. The certificate.
  const keyPem = path.join(dir, "key.pem"), csr = path.join(dir, "request.csr"), certPem = path.join(dir, "cert.pem"), p12 = path.join(dir, "identity.p12");
  run("/usr/bin/openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPem, "-out", csr, "-subj", `/CN=${NAME}`], { quiet: true });
  const cert = (await call("POST", "/v1/certificates", { data: { type: "certificates", attributes: { certificateType: "DISTRIBUTION", csrContent: readFileSync(csr, "utf8") } } })).data;
  writeFileSync(certPem, `-----BEGIN CERTIFICATE-----\n${cert.attributes.certificateContent.match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`);
  console.log(`Certificate: ${cert.attributes.certificateType}, until ${String(cert.attributes.expirationDate).slice(0, 10)}`);

  // 2. The profile.
  const bundle = (await call("GET", `/v1/bundleIds?filter[identifier]=${bundleId}&fields[bundleIds]=identifier`)).data.find(b => b.attributes.identifier === bundleId);
  if (!bundle) throw new Error(`the App ID ${bundleId} is not registered with the team`);
  const name = `${NAME} ${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`;
  const profile = (await call("POST", "/v1/profiles", { data: { type: "profiles", attributes: { name, profileType: "IOS_APP_STORE" },
    relationships: { bundleId: { data: { type: "bundleIds", id: bundle.id } }, certificates: { data: [{ type: "certificates", id: cert.id }] } } } })).data;
  const folders = [path.join(os.homedir(), "Library", "Developer", "Xcode", "UserData", "Provisioning Profiles"), path.join(os.homedir(), "Library", "MobileDevice", "Provisioning Profiles")];
  const files = folders.map(f => path.join(f, `${profile.attributes.uuid}.mobileprovision`));
  for (const f of files) { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, Buffer.from(profile.attributes.profileContent, "base64")); }
  console.log(`Profile: ${name}`);

  // 3. The keychain: its own, unlocked for this run, codesign allowed to use the key without asking.
  const keychain = path.join(dir, "signing.keychain-db"), pass = randomBytes(24).toString("hex");
  run("/usr/bin/openssl", ["pkcs12", "-export", "-inkey", keyPem, "-in", certPem, "-out", p12, "-name", NAME, "-passout", `pass:${pass}`], { quiet: true });
  run("security", ["create-keychain", "-p", pass, keychain]);
  run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
  run("security", ["unlock-keychain", "-p", pass, keychain]);
  run("security", ["import", p12, "-k", keychain, "-P", pass, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], { quiet: true });
  run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", pass, keychain], { quiet: true });
  const before = run("security", ["list-keychains", "-d", "user"]).split("\n").map(l => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
  run("security", ["list-keychains", "-d", "user", "-s", keychain, ...before]);
  for (const f of [keyPem, csr, p12]) rmSync(f, { force: true });
  // The certificate is only an identity with Apple's intermediate above it: fetched when the Mac does not have it.
  if (!identities(keychain)) {
    const g = run("/usr/bin/openssl", ["x509", "-in", certPem, "-noout", "-issuer"]).match(/OU\s*=\s*(G\d+)/)?.[1] || "G3";
    const der = path.join(dir, "wwdr.cer");
    writeFileSync(der, Buffer.from(await (await fetch(`https://www.apple.com/certificateauthority/AppleWWDRCA${g}.cer`)).arrayBuffer()));
    run("security", ["import", der, "-k", keychain], { quiet: true });
    console.log(`Apple's intermediate certificate (${g}) was added`);
  }
  if (!identities(keychain)) throw new Error("the new certificate is not a signing identity in the keychain");

  return {
    profile: name, keychain,
    remove() {
      try { run("security", ["list-keychains", "-d", "user", "-s", ...before]); } catch {}
      try { run("security", ["delete-keychain", keychain]); } catch {}
      for (const f of files) rmSync(f, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
