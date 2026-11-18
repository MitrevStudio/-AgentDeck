// The upload to Google Play (mobile/scripts/play-upload.mjs) against a made-up Google on this machine, with a key
// made for the test: the signed request for a token, the calls and their order, a draft app, a version code that
// is taken, the answers of an account that is not set up yet - and that neither the key nor the token is printed.
// The real Google Play is not spoken to.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const script = path.join(__dirname, "..", "mobile", "scripts", "play-upload.mjs");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const keyJson = JSON.stringify({ type: "service_account", project_id: "made-up-project", client_email: "releases@made-up-project.iam.gserviceaccount.com", private_key: pem });
const TOKEN = "made-up-access-token-0123456789";
const PACKAGE = "com.example.madeup";
const bundle = Buffer.concat([Buffer.from("PK\x03\x04"), crypto.randomBytes(4096)]);

// The made-up Google: answers as the real one does where the script cares, and writes down what it was asked.
const google = { calls: [], assertion: null, uploaded: null, track: null, committed: 0, deleted: 0, fail: {} };
const reset = (fail = {}) => Object.assign(google, { calls: [], assertion: null, uploaded: null, track: null, committed: 0, deleted: 0, fail });
const error = (res, status, message, extra = {}) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: status, message, ...extra } })); };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks), url = new URL(req.url, "http://localhost");
    const what = `${req.method} ${url.pathname}${url.search}`;
    google.calls.push(what);
    const ok = (o = {}) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (what === "POST /token") {
      const form = new URLSearchParams(body.toString());
      google.assertion = form.get("assertion");
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      if (google.fail.token) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." })); }
      return ok({ access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return error(res, 401, "Request is missing required authentication credential.");
    const app = `/androidpublisher/v3/applications/${PACKAGE}`;
    if (what === `POST ${app}/edits`) return google.fail.insert ? error(res, ...google.fail.insert) : ok({ id: "edit-1", expiryTimeSeconds: "0" });
    if (what === `POST /upload${app}/edits/edit-1/bundles?uploadType=media`) {
      assert.equal(req.headers["content-type"], "application/octet-stream");
      if (google.fail.upload) return error(res, ...google.fail.upload);
      google.uploaded = body;
      return ok({ versionCode: 1029001, sha256: crypto.createHash("sha256").update(body).digest("hex") });
    }
    if (what === `PUT ${app}/edits/edit-1/tracks/${google.fail.trackName || "internal"}`) {
      const asked = JSON.parse(body.toString());
      if (google.fail.draftAtTrack && asked.releases[0].status !== "draft") return error(res, 400, "Only releases with status draft may be created on draft app.");
      google.track = asked;
      return ok(asked);
    }
    if (req.method === "POST" && url.pathname === `${app}/edits/edit-1:commit`) {
      if (google.fail.draftAtCommit && google.track.releases[0].status !== "draft") return error(res, 400, "Only releases with status draft may be created on draft app.");
      if (google.fail.review && url.searchParams.get("changesNotSentForReview") !== "true") return error(res, 400, "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.");
      if (google.fail.commit) return error(res, ...google.fail.commit);
      google.committed++;
      return ok({ id: "edit-1" });
    }
    if (what === `DELETE ${app}/edits/edit-1`) { google.deleted++; res.writeHead(204); return res.end(); }
    error(res, 404, `not a call of the test: ${what}`);
  });
});

(async () => {
  const play = await import(pathToFileURL(script).href);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const said = [];
  const send = (more = {}) => play.upload({ account: play.serviceAccount(keyJson), bundle, packageName: PACKAGE, tokenUrl: `${base}/token`, apiUrl: base, log: line => said.push(line), ...more });
  const fails = async (more, pattern) => {
    const e = await send(more).then(() => null, e => e);
    assert.ok(e, "the upload should have failed");
    assert.match(e.message, pattern);
    return e;
  };

  // The secret: the JSON as it is, or in base64; anything else is refused without a word of it in the error.
  assert.equal(play.serviceAccount(keyJson).email, "releases@made-up-project.iam.gserviceaccount.com");
  assert.equal(play.serviceAccount(Buffer.from(keyJson).toString("base64")).email, "releases@made-up-project.iam.gserviceaccount.com");
  assert.equal(play.serviceAccount(`\n${Buffer.from(keyJson).toString("base64")}\n`).email, "releases@made-up-project.iam.gserviceaccount.com");
  for (const bad of ["", "not a key", JSON.stringify({ type: "authorized_user", client_email: "someone@example.invalid", private_key: pem }), JSON.stringify({ type: "service_account", client_email: "a@example.invalid", private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-of-the-test\n-----END PRIVATE KEY-----\n" })]) {
    assert.throws(() => play.serviceAccount(bad), e => /PLAY_SERVICE_ACCOUNT_JSON/.test(e.message) && !e.message.includes("not-a-real-key-of-the-test") && !e.message.includes("example.invalid"));
  }

  // The request for a token: signed by the key, says who asks, for what and for how long.
  const jwt = play.assertion(play.serviceAccount(keyJson), { tokenUrl: "https://oauth2.googleapis.com/token", now: 1800000000 });
  const [head, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { iss: "releases@made-up-project.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token", iat: 1800000000, exp: 1800000600 });
  assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
  assert.deepEqual(play.trackBody("internal", 1029001, "completed"), { track: "internal", releases: [{ status: "completed", versionCodes: ["1029001"] }] });

  // The whole way: token, edit, bundle, track, commit - in that order, the bundle byte for byte.
  reset();
  assert.deepEqual(await send(), { versionCode: 1029001, track: "internal", status: "completed" });
  const app = `/androidpublisher/v3/applications/${PACKAGE}`;
  assert.deepEqual(google.calls, ["POST /token", `POST ${app}/edits`, `POST /upload${app}/edits/edit-1/bundles?uploadType=media`, `PUT ${app}/edits/edit-1/tracks/internal`, `POST ${app}/edits/edit-1:commit`]);
  assert.ok(google.uploaded.equals(bundle));
  assert.deepEqual(google.track, { track: "internal", releases: [{ status: "completed", versionCodes: ["1029001"] }] });
  assert.equal(google.committed, 1);
  assert.equal(google.deleted, 0);
  const [h, c, s] = google.assertion.split(".");
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url")));
  assert.equal(JSON.parse(Buffer.from(c, "base64url")).aud, `${base}/token`);
  assert.match(said.join("\n"), /Version code 1029001 is released on the internal track/);

  // Another track, a draft asked for.
  reset({ trackName: "alpha" });
  assert.deepEqual(await send({ track: "alpha", status: "draft" }), { versionCode: 1029001, track: "alpha", status: "draft" });
  assert.equal(google.track.releases[0].status, "draft");

  // An app that was never published takes a draft only - said when the track is set, or when the edit is
  // committed: the release is left as a draft and the log says what to do with it.
  for (const where of ["draftAtTrack", "draftAtCommit"]) {
    reset({ [where]: true });
    said.length = 0;
    assert.deepEqual(await send(), { versionCode: 1029001, track: "internal", status: "draft" });
    assert.equal(google.track.releases[0].status, "draft");
    assert.equal(google.committed, 1);
    assert.equal(google.deleted, 0);
    assert.match(said.join("\n"), /draft release on the internal track: roll it out in Play Console/);
  }

  // Changes that cannot be sent for review by themselves: committed with that said.
  reset({ review: true });
  await send();
  assert.equal(google.committed, 1);
  assert.equal(google.calls.at(-1), `POST ${app}/edits/edit-1:commit?changesNotSentForReview=true`);

  // What an account that is not ready answers, and what the owner is told. A failed edit is dropped.
  reset({ token: true });
  await fails({}, /signing in with the service account: HTTP 400 - Invalid JWT Signature\.\n {2}→ Google does not accept the key/);
  reset({ insert: [404, `Package not found: ${PACKAGE}.`] });
  await fails({}, /opening an edit: HTTP 404 - Package not found.*\n {2}→ .*create the app in Play Console and upload its first bundle by hand/);
  reset({ insert: [403, "Google Play Android Developer API has not been used in project 123456789012 before or it is disabled. Enable it by visiting the console then retry.", { status: "PERMISSION_DENIED" }] });
  await fails({}, /→ the Google Play Android Developer API is not enabled/);
  reset({ insert: [401, "The caller does not have permission"] });
  await fails({}, /→ the service account may not release this app: invite its e-mail in Play Console/);
  reset({ insert: [403, "The caller does not have permission", { status: "PERMISSION_DENIED" }] });
  await fails({}, /→ the service account may not release this app/);
  assert.equal(google.deleted, 0); // no edit was opened
  reset({ upload: [403, "Version code 1029001 has already been used."] });
  await fails({}, /uploading the bundle: HTTP 403 - Version code 1029001 has already been used\.\n {2}→ Google Play already has a bundle with this version code/);
  assert.equal(google.deleted, 1);
  assert.equal(google.committed, 0);
  reset({ commit: [500, "Internal error encountered."] });
  const plain = await fails({}, /committing the edit: HTTP 500 - Internal error encountered\.$/);
  assert.equal(plain.hint, "");
  assert.equal(google.deleted, 1);
  reset({ draftAtCommit: true, commit: [400, "The app is missing a privacy policy."] });
  await fails({}, /committing the edit: HTTP 400 - The app is missing a privacy policy\./);
  assert.equal(google.track.releases[0].status, "draft");
  assert.match(play.explain(404, "Track not found: beta-2", { track: "beta-2" }), /no track "beta-2"/);
  assert.equal(play.explain(400, "something nobody has seen"), "");

  // The command, as the workflow runs it - it speaks to the real Google, so only what happens before that.
  const run = (args, env) => new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, PLAY_SERVICE_ACCOUNT_JSON: "", ...env } });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => resolve({ code, out }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-play-"));
  const file = path.join(dir, "app-release.aab");
  fs.writeFileSync(file, bundle);
  try {
    assert.deepEqual(await run([], {}), { code: 2, out: "usage: node scripts/play-upload.mjs <app-release.aab>\n" });
    assert.deepEqual(await run([file], {}), { code: 1, out: "Not set: PLAY_SERVICE_ACCOUNT_JSON\n" });
    const refused = await run([file], { PLAY_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify({ type: "service_account", client_email: "a@example.invalid", private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-of-the-test\n-----END PRIVATE KEY-----\n" })).toString("base64") });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /the private key in PLAY_SERVICE_ACCOUNT_JSON cannot be read/);
    assert.ok(!refused.out.includes("not-a-real-key-of-the-test"));
    const missing = await run([path.join(dir, "no-such.aab")], { PLAY_SERVICE_ACCOUNT_JSON: keyJson });
    assert.equal(missing.code, 1);
    assert.ok(!missing.out.includes("PRIVATE KEY"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Nothing that was logged above holds the token or the key.
  for (const line of said) assert.ok(!line.includes(TOKEN) && !line.includes("PRIVATE KEY"));

  server.close();
  console.log("play upload OK");
})().catch(e => { console.error(e); process.exit(1); });
