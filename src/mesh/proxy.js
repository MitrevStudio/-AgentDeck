// A TCP tunnel to host:port through an HTTP CONNECT proxy ("http://phost:pport" or "phost:pport"), so the
// mesh WSS can ride over a corporate proxy that only allows outbound CONNECT (e.g. a work laptop reaching the
// VPS hub). Resolves with the connected socket, ready for client.js's `socket` seam - TLS runs end to end over
// it, so the proxy only ever sees an opaque tunnel and never the node certificates or traffic.
const net = require("node:net");

// Accepts "http://host:port", "host:port" (scheme optional, defaults to an HTTP CONNECT proxy).
function parseProxy(proxy) {
  const m = /^(?:https?:\/\/)?([^/:]+):(\d+)\/?$/.exec(String(proxy || "").trim());
  if (!m) throw new Error(`Invalid proxy address: ${proxy}`);
  return { host: m[1], port: Number(m[2]) };
}

function connectViaProxy({ proxy, host, port, timeout = 8000 }) {
  const p = parseProxy(proxy);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), done = false;
    const socket = net.connect(p.port, p.host);
    const fail = e => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(Object.assign(new Error("proxy timeout"), { code: "timeout" })), timeout);
    socket.once("error", fail);
    socket.once("connect", () => {
      const target = host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });
    socket.on("data", function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) { if (buf.length > 65536) fail(new Error("proxy sent an oversized response header")); return; }
      // Removing the only "data" listener reverts the socket to paused mode, so bytes that arrive before the
      // consumer (TLS) attaches are buffered, not lost.
      socket.off("data", onData);
      const statusLine = buf.toString("latin1", 0, buf.indexOf("\r\n") === -1 ? end : buf.indexOf("\r\n"));
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
      if (!status || status[1] !== "200") { fail(new Error(`proxy refused CONNECT: ${statusLine || "no response"}`)); return; }
      clearTimeout(timer);
      done = true;
      socket.removeListener("error", fail);
      // Any bytes after the blank line (rare before a TLS ClientHello) are handed back so TLS doesn't lose them.
      const rest = buf.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    });
  });
}

module.exports = { connectViaProxy, parseProxy };
