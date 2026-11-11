// What the QR code of "Add phone" carries (docs/MOBILE.md 4), and how the phone pairs with all of it at once. Both
// sides use this file: the desktop encodes, the app decodes and calls pairAll. Runs in Node and, bundled, in the
// phone's WebView (noble only, no Buffer, no node: modules).
//
// The payload (what decode answers and encode takes):
//   { r: { a: address, p: port, id: nodeId, k: key, c: code, n: name } | null,
//     n: [ { id: nodeId, k: key, c: code, n: name, t: "desktop" | "host", a?: address, p?: port } ] }
// The text: AGENTDECK-PAIR:2:<RFC 4648 base32 of the bytes below, upper case, no padding> - all of it in the QR code's
// alphanumeric set, which packs 5.5 bits a character (byte mode: 8), so the code is drawn in alphanumeric mode. Bytes:
//   [flags:1 - bit 0: there is a relay; the rest 0][computers:1 - 1..MAX_NODES]
//   [the relay, when there is one: node, address][each computer: node, [kind:1 - bit 0: host, bit 1: has an address;
//   the rest 0], address when it has one]
//   node = [id:32][key:32][invite:17 - its 26 Crockford base32 digits, digit i in bits 5i..5i+4 of a 136-bit big-endian
//   number, the top 6 bits 0][name length:1][name: UTF-8]; address = [length:1, 1..255][printable ASCII][port:2 BE]
// and nothing after; then every rule of check() as for a payload handed to encode. An address must be ASCII (a name
// in another script goes as punycode, xn--...). Read leniently only where people paste: case and white space (also
// inside, from wrapped lines); strictly in everything else, the base32 included (one spelling of the bytes).
// r: the relay the phone dials (the address as the phone will reach it); n: the computers to pair with through it,
// the desktop that made the code first. With no relay (r null) every computer carries a/p and is dialled directly
// (the same network). id: the node's id (64 hex: what the routes know it by); k: its Noise static public key (32 bytes,
// base64url) - the phone pairs only with the key in the code, so whoever answers in a node's place is refused before
// anything is sent; c: a one-time invite (pair.invite: 128 random bits, 10 minutes, one phone); n: its name. At most
// MAX_NODES computers, so the code stays easy to scan.
//
// An invite is named to the node by its tag (inviteTag): the node holds several and must know which one this pairing
// proves - the code itself is never sent. The tag is a hash of 128 random bits, so it tells nothing about the code;
// it is used for invites only (a hash of a six-digit code could be searched).
const { sha256 } = require("@noble/hashes/sha2");
const { bytesToHex, utf8ToBytes } = require("@noble/hashes/utils");
const { normCode } = require("./pair-proof");

const PREFIX = "AGENTDECK-PAIR:2:";
const MAX_TEXT = 4096;
const MAX_NODES = 6;
const ROUTE_TIMEOUT_MS = 20000;
const ID = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
// An invite: a long token (peers.js longToken), 26 Crockford base32 characters once its dashes are gone.
const INVITE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// A host name, an IPv4 or IPv6 address (bare or in brackets) - nothing that could make the WebSocket URL say more.
const ADDRESS = /^[^\s/?#@[\]]+$|^\[[0-9a-fA-F:.]+\]$/;
const KINDS = ["desktop", "host"];

const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = message => failure("invalidData", `Not an AgentDeck pairing code: ${message}.`);
const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------- base64url ----------
function toBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Strict: only the base64url alphabet, no padding, and only the one spelling of the bytes (re-encoded it must be the
// same text), so one payload has one text.
function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw invalid("not base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  if (toBase64Url(out) !== text) throw invalid("not base64url");
  return out;
}
const keyToHex = k => bytesToHex(fromBase64Url(k));
function hexToKey(hex) {
  if (typeof hex !== "string" || !ID.test(hex)) throw invalid("not a key");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return toBase64Url(out);
}

// The tag a pairing names a one-time invite by (64 hex).
const inviteTag = code => bytesToHex(sha256(utf8ToBytes(`AgentDeck invite 1\n${normCode(code)}`)));

// ---------- checking ----------
const onlyKeys = (o, allowed, what) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw invalid(`unknown field ${what}.${k}`); };
const name = v => {
  if (typeof v !== "string" || v.length > 60) throw invalid("a bad name");
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
};
function address(a, p) {
  if (typeof a !== "string" || !a || a.length > 255 || !ADDRESS.test(a)) throw invalid("a bad address");
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw invalid("a bad port");
  return a.replace(/^\[|\]$/g, "");
}
function node(o, what) {
  if (!isObj(o)) throw invalid(`${what} is not an object`);
  if (!ID.test(o.id)) throw invalid(`${what}.id`);
  if (typeof o.k !== "string" || !KEY.test(o.k) || fromBase64Url(o.k).length !== 32) throw invalid(`${what}.k`);
  if (typeof o.c !== "string" || o.c.length > 40 || !INVITE.test(normCode(o.c))) throw invalid(`${what}.c`);
  return { id: o.id, k: o.k, c: normCode(o.c), n: name(o.n) };
}
// A payload as decode answers it (a clean copy), or throws invalidData.
function check(p) {
  if (!isObj(p)) throw invalid("not an object");
  onlyKeys(p, ["r", "n"], "");
  let r = null;
  if (p.r !== null) {
    if (!isObj(p.r)) throw invalid("r");
    onlyKeys(p.r, ["a", "p", "id", "k", "c", "n"], "r");
    r = { a: address(p.r.a, p.r.p), p: p.r.p, ...node(p.r, "r") };
  }
  if (!Array.isArray(p.n) || p.n.length < 1 || p.n.length > MAX_NODES) throw invalid(`n must hold 1 to ${MAX_NODES} computers`);
  const n = p.n.map((x, i) => {
    const what = `n[${i}]`;
    onlyKeys(isObj(x) ? x : {}, ["id", "k", "c", "n", "t", "a", "p"], what);
    const out = node(x, what);
    if (!KINDS.includes(x.t)) throw invalid(`${what}.t`);
    out.t = x.t;
    const direct = x.a !== undefined || x.p !== undefined;
    if (!r && !direct) throw invalid(`${what} needs an address when there is no relay`);
    if (direct) { out.a = address(x.a, x.p); out.p = x.p; }
    return out;
  });
  const all = [...(r ? [r] : []), ...n];
  if (new Set(all.map(x => x.id)).size !== all.length || new Set(all.map(x => x.k)).size !== all.length) throw invalid("a node twice");
  return { r, n };
}

// ---------- base32 (RFC 4648) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function toBase32(bytes) {
  let out = "", bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits) out += B32[(value << (5 - bits)) & 31];
  return out;
}
// Strict: only the alphabet, a length bytes can have, and the one spelling of the bytes (the unused low bits 0).
function fromBase32(text) {
  if (!/^[A-Z2-7]*$/.test(text) || [1, 3, 6].includes(text.length % 8)) throw invalid("not base32");
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0, value = 0, at = 0;
  for (const ch of text) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out[at++] = (value >>> (bits - 8)) & 255; bits -= 8; }
    value &= (1 << bits) - 1;
  }
  if (value) throw invalid("not base32");
  return out;
}

// ---------- an invite as 17 bytes ----------
// peers.js longToken: character i is bits 5i..5i+4 of the number; 26 characters, 130 bits, the top 6 of 136 are 0.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function inviteToBytes(code) {
  let v = 0n;
  [...normCode(code)].forEach((ch, i) => { v |= BigInt(CROCKFORD.indexOf(ch)) << BigInt(5 * i); });
  const out = new Uint8Array(17);
  for (let i = 16; i >= 0; i--) { out[i] = Number(v & 255n); v >>= 8n; }
  return out;
}
function bytesToInvite(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  if (v >> 130n) throw invalid("a bad invite");
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[Number((v >> BigInt(5 * i)) & 31n)];
  return out;
}

// ---------- the text ----------
const hexBytes = hex => { const out = new Uint8Array(32); for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16); return out; };
function encode(payload) {
  const p = check(payload);
  const out = [p.r ? 1 : 0, p.n.length];
  const put = (...xs) => { for (const x of xs) for (const b of x) out.push(b); };
  const node = x => {
    const name = utf8ToBytes(x.n);
    put(hexBytes(x.id), fromBase64Url(x.k), inviteToBytes(x.c), [name.length], name);
  };
  const address = x => {
    // The QR code carries ASCII: a name of another script goes as punycode (xn--...).
    if (!/^[\x21-\x7e]{1,255}$/.test(x.a)) throw invalid("an address that is not ASCII");
    put([x.a.length], [...x.a].map(ch => ch.charCodeAt(0)), [x.p >> 8, x.p & 255]);
  };
  if (p.r) { node(p.r); address(p.r); }
  for (const x of p.n) {
    node(x);
    put([(x.t === "host" ? 1 : 0) | (x.a ? 2 : 0)]);
    if (x.a) address(x);
  }
  const text = PREFIX + toBase32(Uint8Array.from(out));
  if (text.length > MAX_TEXT) throw invalid("too long");
  return text;
}
// text: what was scanned or pasted (case and white space do not matter). -> the payload ({ r, n } as above), or
// throws an Error with code "invalidData".
function decode(text) {
  if (typeof text !== "string") throw invalid("not text");
  if (text.length > 2 * MAX_TEXT) throw invalid("too long");
  const t = text.replace(/\s+/g, "").toUpperCase();
  if (t.length > MAX_TEXT) throw invalid("too long");
  if (!t.startsWith(PREFIX)) throw invalid(/^AGENTDECK-PAIR:\d+:/.test(t) ? "made by another AgentDeck version" : `no ${PREFIX} in front`);
  const bytes = fromBase32(t.slice(PREFIX.length));
  let at = 0;
  const take = n => {
    if (at + n > bytes.length) throw invalid("cut short");
    const part = bytes.subarray(at, at + n);
    at += n;
    return part;
  };
  const byte = () => take(1)[0];
  const node = () => {
    const id = bytesToHex(take(32)), k = toBase64Url(take(32)), c = bytesToInvite(take(17));
    let n;
    const utf8 = take(byte());
    try { n = new TextDecoder("utf-8", { fatal: true }).decode(utf8); } catch { throw invalid("a bad name"); }
    return { id, k, c, n };
  };
  const address = () => {
    const len = byte();
    if (!len) throw invalid("a bad address");
    const raw = take(len);
    if (raw.some(b => b < 0x21 || b > 0x7e)) throw invalid("a bad address");
    const p = take(2);
    return { a: String.fromCharCode(...raw), p: (p[0] << 8) | p[1] };
  };
  const flags = byte(), count = byte();
  if (flags & ~1) throw invalid("unknown flags");
  if (count < 1 || count > MAX_NODES) throw invalid(`n must hold 1 to ${MAX_NODES} computers`);
  let r = null;
  if (flags & 1) {
    const x = node();
    r = { ...address(), ...x };
  }
  const n = [];
  for (let i = 0; i < count; i++) {
    const x = node(), kind = byte();
    if (kind & ~3) throw invalid("unknown kind bits");
    n.push({ ...x, t: kind & 1 ? "host" : "desktop", ...(kind & 2 ? address() : {}) });
  }
  if (at !== bytes.length) throw invalid("something after the end");
  // Every rule of a payload, as for one handed to encode.
  return check({ r, n });
}

// ---------- pairing with all of it ----------
// Waits until a connected hub of the client routes to node `id`.
function routeTo(client, id, ms) {
  if (client.routes().some(r => r.id === id)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const on = list => { if (list.some(r => r.id === id)) { done(); resolve(); } };
    const timer = setTimeout(() => { done(); reject(failure("unreachable", "The relay does not reach that computer now.")); }, ms);
    const done = () => { clearTimeout(timer); client.off("routes", on); };
    client.on("routes", on);
  });
}
// client: a started web-client.js client; payload: the text or a decoded payload. Pairs with the relay, then with
// each computer - through the relay, or directly when there is none. A failure does not stop the others.
// -> [{ id, name, kind: "relay" | "desktop" | "host", ok, already, error }] in the payload's order; error: a
// web-client.js pairing code ("wrongKey", "inviteExpired", "unreachable", ...), or, for a computer behind a relay that
// could not be paired, the relay's.
// "already" only for a pairing that works: the node is paired under that key and linked now. One the phone still
// lists but is not linked to - forgotten on that side (it answers "unpaired"), or not reached - is paired again with
// its invite (one that still knows the phone pairs it again on its link: links.js), so a fresh code always mends what
// it names. An id the phone has paired under another key is refused (wrongNode) before its invite is touched: forget
// that one first (web-client.js keep).
async function pairAll(client, payload, { routeTimeoutMs = ROUTE_TIMEOUT_MS } = {}) {
  const p = typeof payload === "string" ? decode(payload) : check(payload);
  const results = [];
  // -> "linked" (paired under that key and online), "otherKey", or "" (pair it).
  const held = (id, key) => {
    const x = client.peers().find(y => y.id === id);
    return !x ? "" : x.key !== key ? "otherKey" : client.online(id) ? "linked" : "";
  };
  const result = (x, kind, extra) => results.push({ id: x.id, name: x.n, kind, ok: false, already: false, error: "", ...extra });
  const otherKey = () => ({ error: "wrongNode" });
  let relayError = "";
  if (p.r) {
    const key = keyToHex(p.r.k), state = held(p.r.id, key);
    if (state === "linked") result(p.r, "relay", { ok: true, already: true });
    else if (state === "otherKey") { relayError = "wrongNode"; result(p.r, "relay", otherKey()); }
    else try {
      await client.pairDirect(p.r.a, p.r.p, p.r.c, { key, id: p.r.id, invite: true });
      result(p.r, "relay", { ok: true });
    } catch (e) {
      relayError = e.code || "unreachable";
      result(p.r, "relay", { error: relayError });
    }
  }
  for (const x of p.n) {
    const key = keyToHex(x.k), state = held(x.id, key);
    if (state === "linked") { result(x, x.t, { ok: true, already: true }); continue; }
    if (state === "otherKey") { result(x, x.t, otherKey()); continue; }
    if (relayError) { result(x, x.t, { error: relayError }); continue; }
    try {
      if (p.r) {
        await routeTo(client, x.id, routeTimeoutMs);
        await client.pairVia(x.id, x.c, { key, invite: true });
      } else await client.pairDirect(x.a, x.p, x.c, { key, id: x.id, invite: true });
      result(x, x.t, { ok: true });
    } catch (e) {
      result(x, x.t, { error: e.code || "unreachable" });
    }
  }
  return results;
}

module.exports = { PREFIX, MAX_NODES, encode, decode, check, pairAll, inviteTag, keyToHex, hexToKey };
