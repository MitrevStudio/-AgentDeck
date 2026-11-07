// The side of the mesh that calls: a WebSocket over TLS to another node, with this node's certificate shown, and
// the other node's checked by fingerprint - the one it was paired as (expectId), or none yet while pairing, when
// the fingerprint seen is what gets pinned.
const { WebSocket } = require("ws");
const { fingerprintOf } = require("./identity");

const CONNECT_TIMEOUT_MS = 8000;

// Resolves with { ws, id } once the socket is open; rejects with code "wrongNode" when the node at that address is
// not the one expected, "timeout", or the socket's own error code.
function connect({ identity, address, port, expectId = "", timeout = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
    // A self-signed certificate fails Node's own check, which is why rejectUnauthorized is off; the certificate is
    // read once the handshake is done and judged by its fingerprint here.
    const ws = new WebSocket(`wss://${host}:${port}/`, { key: identity.key, cert: identity.cert, rejectUnauthorized: false, handshakeTimeout: timeout });
    const timer = setTimeout(() => { ws.terminate(); reject(Object.assign(new Error("no answer"), { code: "timeout" })); }, timeout + 1000);
    ws.once("upgrade", res => {
      try {
        const cert = res.socket.getPeerCertificate();
        seen = cert?.raw ? fingerprintOf(cert.raw) : "";
      } catch {}
    });
    ws.once("open", () => {
      clearTimeout(timer);
      if (!seen || (expectId && seen !== expectId)) {
        ws.close(1008, "wrong node");
        reject(Object.assign(new Error(seen ? "another node answered" : "no certificate"), { code: "wrongNode" }));
        return;
      }
      resolve({ ws, id: seen });
    });
    ws.once("error", e => {
      clearTimeout(timer);
      reject(Object.assign(new Error(e.message), { code: e.code || "unreachable" }));
    });
  });
}

module.exports = { connect };
