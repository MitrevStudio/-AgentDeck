// Who this node is: a self-signed certificate made once and kept in <dir> (key.pem, cert.pem), whose SHA-256
// fingerprint is the node's id - what peers pin when they pair with it (server.js and client.js check it on every
// connection, so no CA is needed). Beside it, node.json: the name peers see, the port the mesh listens on, and
// whether the node announces itself on the local network (discovery.js). And noise.json: the node's X25519 key for
// web links (web-link.js: phones), made once and kept like key.pem; a phone knows the node by its public half.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { x25519 } = require("@noble/curves/ed25519");
const { bytesToHex, hexToBytes } = require("@noble/hashes/utils");
const { isObj } = require("../shared/util");
const { writeSync } = require("../shared/atomic-file");
const { generateKeypair } = require("./noise");

const DEFAULT_PORT = 7421;
const CERT_DAYS = 3650;

const fingerprintOf = pem => new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();

async function makeCertificate() {
  const { generate } = require("selfsigned");
  const r = await generate([{ name: "commonName", value: "agentdeck-node" }], {
    keySize: 2048, algorithm: "sha256", days: CERT_DAYS,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true }
    ]
  });
  return { key: r.private, cert: r.cert };
}

// Only a file that is not there is made: one that is there but cannot be read now (locked by an antivirus or a backup -
// EBUSY/EPERM on Windows) or holds something else must not be replaced, or the node would silently become another
// node and every pairing would be lost. Such an error surfaces (the node does not start) for the user to see.
const missing = e => e?.code === "ENOENT";

// The same for the JSON files the node keeps (node.json here, peers.json and pair-token.json in peers.js): the parsed
// contents, or null when the file is not there. One that is there but cannot be read now, or does not hold JSON, is
// an error (code "unreadable", .file) and stays as it is - starting empty in its place would lose every pairing (or
// the port peers reach this node on) at the next save, and setting it aside would do the same at the next start (a
// service restarts within seconds). The user repairs it or removes it; the message says which file and how. The files
// are written whole or not at all (atomic-file.js writeSync), so a crash mid-write does not leave a broken one.
function readKept(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (missing(e)) return null;
    throw Object.assign(new Error(`${file} cannot be read now (${e.code || e.message}): another program (an antivirus, a backup) may hold it, or its permissions changed. Nothing was changed; AgentDeck tries again.`), { code: "unreadable", file });
  }
  try { return JSON.parse(text); } catch {
    throw Object.assign(new Error(`${file} is damaged (not valid JSON). Nothing was changed: repair it, or remove it to start without what it held (for peers.json: every pairing).`), { code: "unreadable", file, damaged: true });
  }
}

// -> { privateKey, publicKey } (Uint8Arrays), made the first time - phones paired with a lost one have to pair again,
// as computers do when the certificate is lost.
function loadNoiseKey(dir) {
  const file = path.join(dir, "noise.json");
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (!missing(e)) throw e; }
  if (text !== null) {
    const saved = JSON.parse(text);
    if (!/^[0-9a-f]{64}$/.test(saved?.privateKey)) throw new Error(`${file} does not hold a Noise key`);
    const privateKey = hexToBytes(saved.privateKey);
    return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
  }
  const kp = generateKeypair();
  fs.writeFileSync(file, JSON.stringify({ privateKey: bytesToHex(kp.privateKey) }), { mode: 0o600, flag: "wx" });
  return kp;
}

// defaultName: the name until the user picks one (the computer's name).
async function loadIdentity(dir, { defaultName }) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "key.pem"), certFile = path.join(dir, "cert.pem"), file = path.join(dir, "node.json");
  let key = "", cert = "";
  try {
    key = fs.readFileSync(keyFile, "utf8");
    cert = fs.readFileSync(certFile, "utf8");
  } catch (e) {
    // Made only when one of them is not there (half an identity is none: a key without its certificate, or the other
    // way round, cannot be used); any other error surfaces (missing above).
    if (!missing(e)) throw e;
    ({ key, cert } = await makeCertificate());
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.writeFileSync(certFile, cert);
  }
  const id = fingerprintOf(cert);

  let saved = readKept(file);
  if (!isObj(saved)) saved = {};
  const settings = {
    name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim().slice(0, 60) : defaultName,
    port: Number.isInteger(saved.port) && saved.port >= 0 && saved.port <= 65535 ? saved.port : DEFAULT_PORT,
    discoverable: saved.discoverable !== false,
    // The network interface's address to announce on (empty: all of them).
    interface: typeof saved.interface === "string" ? saved.interface : "",
    // An HTTP CONNECT proxy for outbound links ("http://host:port"); empty: connect directly. Lets a node behind a
    // corporate proxy reach a hub node it otherwise could not (proxy.js).
    proxy: typeof saved.proxy === "string" ? saved.proxy.trim() : ""
  };
  const save = () => writeSync(file, JSON.stringify(settings, null, 2));
  // Unknown or invalid values are ignored; answers what changed.
  function update(patch) {
    const keys = [];
    if (!isObj(patch)) return keys;
    if (typeof patch.name === "string" && patch.name.trim() && patch.name.trim().slice(0, 60) !== settings.name) { settings.name = patch.name.trim().slice(0, 60); keys.push("name"); }
    if (Number.isInteger(patch.port) && patch.port >= 0 && patch.port <= 65535 && patch.port !== settings.port) { settings.port = patch.port; keys.push("port"); }
    if (typeof patch.discoverable === "boolean" && patch.discoverable !== settings.discoverable) { settings.discoverable = patch.discoverable; keys.push("discoverable"); }
    if (typeof patch.proxy === "string" && patch.proxy.trim() !== settings.proxy) { settings.proxy = patch.proxy.trim(); keys.push("proxy"); }
    if (keys.length) save();
    return keys;
  }
  if (!fs.existsSync(file)) save();

  return { id, key, cert, noise: loadNoiseKey(dir), settings, update, dir };
}

module.exports = { loadIdentity, readKept, fingerprintOf, DEFAULT_PORT };
