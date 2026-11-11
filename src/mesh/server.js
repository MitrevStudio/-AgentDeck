// The side of the mesh that listens: an HTTPS server with this node's certificate that asks every client for its
// own, and a WebSocket on it. Who connected is the fingerprint of the certificate it showed (identity.js); whether
// that fingerprint is trusted is the caller's call (links.js) - an unknown one may only pair. No CA: the server does
// not reject an unknown client certificate, it hands it over.
//
// The same port takes phones too (docs/MOBILE.md 3.2): a phone's WebView cannot do TLS with a self-signed certificate,
// so it comes with a plain WebSocket and does its own encryption inside (web-link.js). The first byte of each
// connection tells them apart: a TLS handshake starts with 0x16, an HTTP request with a letter ("GET"). The socket is
// handed to the HTTPS server or to a plain HTTP server as it is, so everything that reads it (the client certificate,
// remoteAddress/remotePort, the relay's tunnel ports) sees what it saw before.
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { WebSocketServer } = require("ws");
const { fingerprintOf } = require("./identity");
const { MAX_MESSAGE } = require("./noise");
const { addressSource } = require("./pair-guard");

const FIRST_BYTE_MS = 10000;
// From the first byte (TLS: from the end of the TLS handshake, which has handshakeTimeout of its own) to a WebSocket.
// The HTTP(S) servers here never listen() themselves - the sockets are handed to them - so Node's own
// headersTimeout/requestTimeout checks never run for them: without this, a client that sent half a request and
// stalled would keep its socket for good.
const UPGRADE_MS = 10000;
const TLS_HANDSHAKE = 0x16;

// identity: { key, cert }; onConnection(ws, { id, address, port, release }) - id "" when the client showed no
// certificate; onWebConnection(ws, { address, port, release }): a plain WebSocket (a phone's web link); without it
// those are turned away. admit(address, kill) -> release(): a connection is nobody until it shows who it is, and as
// that it takes a place (pair-guard.js createAdmission) from the moment it is accepted - before its first byte, so
// silent sockets cannot pile up either; kill() closes it when its place is taken back (too many, or too long). The
// place goes on with the WebSocket (`release`, for links.js to give back once it knows who that is) and is given
// back when the socket closes before. Loopback TLS is left out: that is a relay tunnel's last hop (relay.js), a
// paired neighbour's, already bounded by the relay's own limits - and the user's computers must not queue behind
// strangers. A plain connection from loopback (a phone on this machine, a test) takes its place at its first byte.
function createServer({ identity, onConnection, onWebConnection, admit }) {
  let server = null, tls = null, plain = null, wss = null, webWss = null, port = 0;
  const deadlines = new WeakMap(), admitted = new WeakMap();
  // A TLS connection's place until its WebSocket: the TLS socket is another object than the one accepted, so it is
  // found again by the remote address and port (unique while the connection lives).
  const tlsAdmitted = new Map();
  const endpoint = socket => `${socket.remoteAddress}|${socket.remotePort}`;

  function listen(p, host) {
    return new Promise((resolve, reject) => {
      const s = net.createServer(sniff);
      s.on("error", e => { if (!server) reject(e); });
      s.listen(p, host, () => resolve(s));
    });
  }
  function deadline(socket) {
    const timer = setTimeout(() => socket.destroy(), UPGRADE_MS);
    deadlines.set(socket, timer);
    socket.once("close", () => clearTimeout(timer));
  }
  const upgraded = socket => clearTimeout(deadlines.get(socket));
  // Reads the first byte without taking it, then hands the socket over.
  function sniff(socket) {
    socket.on("error", () => {});
    const address = socket.remoteAddress || "", local = addressSource(address).loopback;
    const take = () => (admit ? admit(address, () => socket.destroy()) : () => {});
    let release = local ? null : take();
    const key = endpoint(socket);
    socket.once("close", () => {
      release?.();
      if (tlsAdmitted.get(key) === release) tlsAdmitted.delete(key);
    });
    const timer = setTimeout(() => socket.destroy(), FIRST_BYTE_MS);
    socket.once("readable", function first() {
      const head = socket.read(1);
      if (head === null) { if (!socket.destroyed) socket.once("readable", first); return; }
      clearTimeout(timer);
      socket.unshift(head);
      const b = head[0];
      if (b === TLS_HANDSHAKE && tls) {
        if (release) tlsAdmitted.set(key, release);
        tls.emit("connection", socket);
      } else if (b >= 0x41 && b <= 0x5a && plain) { // an HTTP method: upper-case letters
        release = release || take();
        admitted.set(socket, release);
        deadline(socket);
        plain.emit("connection", socket);
      } else socket.destroy();
    });
    socket.once("close", () => clearTimeout(timer));
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
    tls = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false, handshakeTimeout: 10000 });
    tls.on("error", () => {});
    tls.on("secureConnection", deadline);
    wss = new WebSocketServer({ server: tls, maxPayload: 16 * 1024 * 1024 });
    wss.on("connection", (ws, req) => {
      const socket = req.socket;
      upgraded(socket);
      let id = "";
      try {
        const cert = socket.getPeerCertificate();
        if (cert?.raw) id = fingerprintOf(cert.raw);
      } catch {}
      const key = endpoint(socket), release = tlsAdmitted.get(key) || (() => {});
      tlsAdmitted.delete(key);
      onConnection(ws, { id, address: socket.remoteAddress || "", port: socket.remotePort || 0, release });
    });
    // Plain HTTP: only the WebSocket of a web link; one Noise message per WebSocket message, so nothing bigger.
    plain = http.createServer((req, res) => { res.writeHead(426, { connection: "close" }); res.end(); });
    plain.headersTimeout = 10000;
    plain.requestTimeout = 10000;
    plain.on("clientError", (_e, socket) => socket.destroy());
    if (onWebConnection) {
      webWss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
      plain.on("upgrade", (req, socket, head) => {
        webWss.handleUpgrade(req, socket, head, ws => {
          upgraded(socket);
          onWebConnection(ws, { address: socket.remoteAddress || "", port: socket.remotePort || 0, release: admitted.get(socket) || (() => {}) });
        });
      });
    } else plain.on("upgrade", (_req, socket) => socket.destroy());
    return port;
  }
  function stop() {
    for (const c of [...(wss?.clients || []), ...(webWss?.clients || [])]) c.terminate();
    wss?.close();
    webWss?.close();
    server?.close();
    wss = webWss = tls = plain = server = null;
    port = 0;
  }

  return { start, stop, port: () => port };
}

module.exports = { createServer };
