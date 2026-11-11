// Pairing without showing the code: both nodes prove they know it, and nobody on the way learns it or can try
// codes at leisure. This is CPace (a password-authenticated key exchange) over ristretto255:
// - both derive a generator from the code and the two node ids - each side's own, and the other's as its TLS
//   certificate showed it. Someone in the middle shows each side a certificate of their own, so the two generators
//   differ and the exchange fails: the code is bound to the two computers that pair;
// - each sends generator * (a random number) and multiplies what it got by its own number: the same point on both
//   sides only when the code and the ids were the same;
// - a key made of that point and of what was sent gives two proofs (HMACs): the calling side shows its first, the
//   answering side checks it and only then shows its own. A wrong code costs one try (pair-guard.js counts those);
//   what was seen of a try tells nothing about the code, so even six digits cannot be searched afterwards.
// Over a web link (web-link.js: a phone, Noise instead of TLS) the "ids" are the two Noise static public keys as each
// side saw them, and the Noise handshake hash is bound in as well (`binding`), under a domain of its own: whoever sits
// in the middle (a relay included) has to run a handshake of their own with each side, so the keys or the hash differ
// and the proofs do not match. Without `binding` the computation is exactly the TLS one it always was.
// The points and proofs travel as hex. The file runs in Node and, bundled, in the phone's WebView (noble only).
const { RistrettoPoint, ed25519 } = require("@noble/curves/ed25519");
const { sha256, sha512 } = require("@noble/hashes/sha2");
const { hmac } = require("@noble/hashes/hmac");
const { bytesToHex, concatBytes, randomBytes, utf8ToBytes } = require("@noble/hashes/utils");

const DOMAIN = "AgentDeck pairing 2";
const WEB_DOMAIN = "AgentDeck web pairing 1";
const ID = /^[0-9a-f]{64}$/;
const POINT = /^[0-9a-f]{64}$/;
// Strings are hashed as their UTF-8 bytes, as node:crypto's update(string) did.
const sha = (hash, ...parts) => hash(concatBytes(...parts.map(p => (typeof p === "string" ? utf8ToBytes(p) : p))));

// What is compared: no spaces or dashes, upper case, and the letters Crockford reads as digits (I, L -> 1; O -> 0).
const normCode = code => String(code ?? "").replace(/[\s-]/g, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");

function generator(domain, code, initiator, responder, binding) {
  const c = utf8ToBytes(normCode(code));
  // The code's length first: the fields cannot run into each other.
  return RistrettoPoint.hashToCurve(sha(sha512, domain, Uint8Array.of(0, c.length & 255, c.length >> 8), c, initiator, responder, ...(binding ? [binding] : [])));
}
function randomScalar() {
  const n = BigInt(`0x${bytesToHex(randomBytes(64))}`) % ed25519.CURVE.n;
  return n || 1n;
}

// initiator, responder: the ids of the node that calls and of the one that answers (over a web link: their Noise
// public keys, hex); role: which of them this is; binding: over a web link, the Noise handshake hash (64 hex), as
// both sides got it. -> { y: what to send, finish(theirY) -> { own: this side's proof, expect: the other side's } }.
// finish throws on something that is not a point of the group.
function start({ code, initiator, responder, role, binding }) {
  if (!ID.test(initiator) || !ID.test(responder) || initiator === responder) throw new Error("not two node ids");
  if (binding !== undefined && !ID.test(binding)) throw new Error("not a handshake hash");
  const domain = binding === undefined ? DOMAIN : WEB_DOMAIN;
  const g = generator(domain, code, initiator, responder, binding), x = randomScalar();
  const y = g.multiply(x).toHex();
  function finish(theirY) {
    if (typeof theirY !== "string" || !POINT.test(theirY)) throw new Error("not a point");
    const theirs = RistrettoPoint.fromHex(theirY); // throws unless a valid encoding
    // The neutral element would give the same key whatever the code.
    if (theirs.equals(RistrettoPoint.ZERO)) throw new Error("not a point");
    const k = theirs.multiply(x);
    const [ya, yb] = role === "initiator" ? [y, theirY] : [theirY, y];
    const key = sha(sha256, domain, " key", k.toRawBytes(), ya, yb, initiator, responder, ...(binding === undefined ? [] : [binding]));
    const proof = who => bytesToHex(hmac(sha256, key, utf8ToBytes(who)));
    return role === "initiator" ? { own: proof("initiator"), expect: proof("responder") } : { own: proof("responder"), expect: proof("initiator") };
  }
  return { y, finish };
}
// Whether a proof received is the one expected (constant time in its content).
function same(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

module.exports = { start, same, normCode };
