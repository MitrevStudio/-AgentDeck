// Who this node is: a self-signed certificate made once and kept in <dir> (key.pem, cert.pem), whose SHA-256
// fingerprint is the node's id - what peers pin when they pair with it (server.js and client.js check it on every
// connection, so no CA is needed). Beside it, node.json: the name peers see, the port the mesh listens on, and
// whether the node announces itself on the local network (discovery.js).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isObj } = require("../shared/util");

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

// defaultName: the name until the user picks one (the computer's name).
async function loadIdentity(dir, { defaultName }) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "key.pem"), certFile = path.join(dir, "cert.pem"), file = path.join(dir, "node.json");
  let key = "", cert = "";
  try {
    key = fs.readFileSync(keyFile, "utf8");
    cert = fs.readFileSync(certFile, "utf8");
    fingerprintOf(cert);
  } catch {
    ({ key, cert } = await makeCertificate());
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.writeFileSync(certFile, cert);
  }
  const id = fingerprintOf(cert);

  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!isObj(saved)) saved = {};
  const settings = {
    name: typeof saved.name === "string" && saved.name.trim() ? saved.name.trim().slice(0, 60) : defaultName,
    port: Number.isInteger(saved.port) && saved.port >= 0 && saved.port <= 65535 ? saved.port : DEFAULT_PORT,
    discoverable: saved.discoverable !== false,
    // The network interface's address to announce on (empty: all of them).
    interface: typeof saved.interface === "string" ? saved.interface : ""
  };
  const save = () => fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  // Unknown or invalid values are ignored; answers what changed.
  function update(patch) {
    const keys = [];
    if (!isObj(patch)) return keys;
    if (typeof patch.name === "string" && patch.name.trim() && patch.name.trim().slice(0, 60) !== settings.name) { settings.name = patch.name.trim().slice(0, 60); keys.push("name"); }
    if (Number.isInteger(patch.port) && patch.port >= 0 && patch.port <= 65535 && patch.port !== settings.port) { settings.port = patch.port; keys.push("port"); }
    if (typeof patch.discoverable === "boolean" && patch.discoverable !== settings.discoverable) { settings.discoverable = patch.discoverable; keys.push("discoverable"); }
    if (keys.length) save();
    return keys;
  }
  if (!fs.existsSync(file)) save();

  return { id, key, cert, settings, update, dir };
}

module.exports = { loadIdentity, fingerprintOf, DEFAULT_PORT };
