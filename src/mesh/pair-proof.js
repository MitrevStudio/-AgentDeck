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
// The points and proofs travel as hex.
const crypto = require("node:crypto");
const { RistrettoPoint, ed25519 } = require("@noble/curves/ed25519");
const { normCode } = require("./peers");

const DOMAIN = "AgentDeck pairing 2";
const ID = /^[0-9a-f]{64}$/;
const POINT = /^[0-9a-f]{64}$/;
const sha = (alg, ...parts) => { const h = crypto.createHash(alg); for (const p of parts) h.update(p); return h.digest(); };

function generator(code, initiator, responder) {
  const c = Buffer.from(normCode(code), "utf8");
  // The code's length first: the fields cannot run into each other.
  return RistrettoPoint.hashToCurve(sha("sha512", DOMAIN, Buffer.from([0, c.length & 255, c.length >> 8]), c, initiator, responder));
}
function randomScalar() {
  const n = BigInt(`0x${crypto.randomBytes(64).toString("hex")}`) % ed25519.CURVE.n;
  return n || 1n;
}

// initiator, responder: the ids of the node that calls and of the one that answers; role: which of them this is.
// -> { y: what to send, finish(theirY) -> { own: this side's proof, expect: the other side's } }. finish throws on
// something that is not a point of the group.
function start({ code, initiator, responder, role }) {
  if (!ID.test(initiator) || !ID.test(responder) || initiator === responder) throw new Error("not two node ids");
  const g = generator(code, initiator, responder), x = randomScalar();
  const y = g.multiply(x).toHex();
  function finish(theirY) {
    if (typeof theirY !== "string" || !POINT.test(theirY)) throw new Error("not a point");
    const theirs = RistrettoPoint.fromHex(theirY); // throws unless a valid encoding
    // The neutral element would give the same key whatever the code.
    if (theirs.equals(RistrettoPoint.ZERO)) throw new Error("not a point");
    const k = theirs.multiply(x);
    const [ya, yb] = role === "initiator" ? [y, theirY] : [theirY, y];
    const key = sha("sha256", DOMAIN, " key", k.toRawBytes(), ya, yb, initiator, responder);
    const proof = who => crypto.createHmac("sha256", key).update(who).digest("hex");
    return role === "initiator" ? { own: proof("initiator"), expect: proof("responder") } : { own: proof("responder"), expect: proof("initiator") };
  }
  return { y, finish };
}
// Whether a proof received is the one expected.
function same(given, expected) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

module.exports = { start, same };
