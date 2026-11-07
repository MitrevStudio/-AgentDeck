// The side of the mesh that listens: an HTTPS server with this node's certificate that asks every client for its
// own, and a WebSocket on it. Who connected is the fingerprint of the certificate it showed (identity.js); whether
// that fingerprint is trusted is the caller's call (links.js) - an unknown one may only pair. No CA: the server does
// not reject an unknown client certificate, it hands it over.
const https = require("node:https");
const { WebSocketServer } = require("ws");
const { fingerprintOf } = require("./identity");

// identity: { key, cert }; onConnection(ws, { id, address, port }) - id "" when the client showed no certificate.
function createServer({ identity, onConnection }) {
  let server = null, wss = null, port = 0;

  function listen(p, host) {
    return new Promise((resolve, reject) => {
      const s = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false, handshakeTimeout: 10000 });
      s.on("error", e => { if (!server) reject(e); });
      s.listen(p, host, () => resolve(s));
    });
  }
  // Listens on `wanted`; when that port is taken, on any free one (the discovery announces the actual port).
  // Answers the port in use.
  async function start(wanted, host = "0.0.0.0") {
    try {
      server = await listen(wanted, host);
    } catch (e) {
      if (e.code !== "EADDRINUSE" || !wanted) throw e;
      server = await listen(0, host);
    }
    port = server.address().port;
    wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });
    wss.on("connection", (ws, req) => {
      const socket = req.socket;
      let id = "";
      try {
        const cert = socket.getPeerCertificate();
        if (cert?.raw) id = fingerprintOf(cert.raw);
      } catch {}
      onConnection(ws, { id, address: socket.remoteAddress || "", port: socket.remotePort || 0 });
    });
    return port;
  }
  function stop() {
    for (const c of wss?.clients || []) c.terminate();
    wss?.close();
    server?.close();
    wss = null;
    server = null;
    port = 0;
  }

  return { start, stop, port: () => port };
}

module.exports = { createServer };
