// What two nodes say to each other over one WebSocket, the same both ways: text frames carry JSON - a request
// { id, method, params }, its answer { id, result } or { id, error: { code, message } }, and an event
// { event, data } nobody answers; binary frames (terminal output and input, later) pass through untouched. A
// request the other side does not answer in time fails with code "timeout"; one sent on a closed link with "closed".
const { HostError } = require("../host/errors");

const PROTOCOL = 1;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TEXT = 16 * 1024 * 1024;

// ws: an open WebSocket (ws package), or what web-link.js makes that behaves like one (a phone's Noise link: text
// arrives as a string, binary as bytes; it runs in the phone's WebView too). onRequest(method, params) -> the result (or throws); onEvent(name, data);
// onBinary(buffer); onClose(code, reason).
function createLink(ws, { onRequest = () => { throw new HostError("unknownMethod"); }, onEvent = () => {}, onBinary = () => {}, onClose = () => {}, heartbeatMs = 15000 } = {}) {
  const pending = new Map(); // id -> { resolve, reject, timer }
  let next = 1, closed = false;
  let awaitingPong = false, closeReported = false;
  ws.on("pong", () => { awaitingPong = false; });
  const heartbeat = setInterval(() => {
    if (!isOpen()) return;
    if (awaitingPong) {
      finish(1006, "heartbeat timeout");
      ws.terminate();
      return;
    }
    awaitingPong = true;
    try { ws.ping(); } catch { finish(1006, "heartbeat failed"); ws.terminate(); }
  }, heartbeatMs);
  heartbeat.unref?.();

  const isOpen = () => !closed && ws.readyState === ws.OPEN;
  function send(obj) {
    if (isOpen()) ws.send(JSON.stringify(obj));
  }
  async function answer(m) {
    try {
      const result = await onRequest(String(m.method), m.params ?? {});
      send({ id: m.id, result: result === undefined ? null : result });
    } catch (e) {
      send({ id: m.id, error: { code: e?.code || "error", message: e?.message || String(e) } });
    }
  }
  ws.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      onBinary(data);
      return;
    }
    if (data.length > MAX_TEXT) {
      ws.close(1009, "too big");
      return;
    }
    let m;
    try { m = JSON.parse(typeof data === "string" ? data : data.toString("utf8")); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (m.event !== undefined) onEvent(String(m.event), m.data);
    else if (m.method !== undefined) answer(m);
    else if (pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || m.error.code), { code: m.error.code || "error" }));
      else p.resolve(m.result);
    }
  });
  function settleAll(code) {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("the link closed"), { code }));
    }
    pending.clear();
  }
  function finish(code, reason) {
    closed = true;
    clearInterval(heartbeat);
    settleAll("closed");
    if (!closeReported) { closeReported = true; onClose(code, reason?.toString() || ""); }
  }
  ws.on("close", finish);
  ws.on("error", () => {}); // "close" follows

  function call(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!isOpen()) return Promise.reject(Object.assign(new Error("the link is closed"), { code: "closed" }));
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`${method} did not answer in time`), { code: "timeout" }));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  const notify = (event, data) => send({ event, data });
  function sendBinary(buffer) {
    if (isOpen()) ws.send(buffer, { binary: true });
  }
  function close(code = 1000, reason = "") {
    finish(code, reason);
    try { ws.close(code, reason); } catch {}
  }

  return { call, notify, sendBinary, close, isOpen, ws };
}

module.exports = { createLink, PROTOCOL };
