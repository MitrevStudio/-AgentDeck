// Noise_XX_25519_ChaChaPoly_SHA256: the encryption of the phone's web link (docs/MOBILE.md, 3.1), the Noise Protocol
// Framework (revision 34, noiseprotocol.org/noise.html) cut down to the one handshake it needs:
//   -> e
//   <- e, ee, s, es
//   -> s, se
// Both sides show their static key, each under encryption, and come out with two keys - one per direction - that
// only they hold. Who the other is (their static key) is the caller's question: a known key is a link, an unknown one
// may only pair. No PSK, no rekey, no other patterns.
// The same file runs in Node and, bundled, in the phone's WebView: Uint8Arrays only, no Buffer and no node: modules;
// random numbers come from noble (crypto.getRandomValues / node's crypto under it).
//
// generateKeypair() -> { publicKey, privateKey }: 32-byte Uint8Arrays (X25519).
// idOf(publicKey) -> a phone's node id: the SHA-256 of its public key, 64 lowercase hex.
// createHandshake({ initiator, s, prologue?, e? }) -> handshake. initiator: true on the side that calls; s: this
//   side's static keypair ({ privateKey, publicKey? }: the public key is derived, and must match when given);
//   prologue: bytes both sides must agree on (they are hashed in, not sent); e: a fixed ephemeral keypair, ONLY for
//   test vectors - a real handshake takes a fresh one.
//   handshake.writeMessage(payload?) -> the next message to send; handshake.readMessage(message) -> its payload.
//     The turns are fixed (initiator writes, responder writes, initiator writes); out of turn throws.
//     Handshake payloads are encrypted from the second message on, but the first goes in the clear and none of them
//     is bound to an authenticated peer until the handshake is done: send nothing secret in them.
//   handshake.done: whether all three messages went through.
//   handshake.remoteStatic: the other side's static public key once it arrived (initiator: after the 2nd message,
//     responder: after the 3rd), else null. Trust it only once done.
//   handshake.hash: the handshake hash once done, else null: the same on both sides only for the same handshake, to
//     bind something to it (channel binding: the pairing proof).
//   handshake.split() -> { send, recv } once done, once: send.encrypt(plaintext) -> ciphertext and
//     recv.decrypt(ciphertext) -> plaintext, each with its own nonce counter, in order (a lost, repeated or reordered
//     message fails to decrypt).
// Limits: a message is at most MAX_MESSAGE (65535) bytes, so a transport plaintext at most MAX_PLAINTEXT (65519):
// the caller chunks. A nonce never wraps: after 2^64-1 messages a cipher refuses to go on.
// Every failure throws a plain Error with a short message and leaves the handshake or cipher unusable: a broken link
// is closed, never carried on.
const { x25519 } = require("@noble/curves/ed25519");
const { chacha20poly1305 } = require("@noble/ciphers/chacha");
const { sha256 } = require("@noble/hashes/sha2");
const { hmac } = require("@noble/hashes/hmac");
const { bytesToHex, concatBytes, utf8ToBytes } = require("@noble/hashes/utils");

const PROTOCOL = "Noise_XX_25519_ChaChaPoly_SHA256";
const DHLEN = 32;
const HASHLEN = 32;
const TAGLEN = 16;
const MAX_MESSAGE = 65535;
const MAX_PLAINTEXT = MAX_MESSAGE - TAGLEN;
const EMPTY = new Uint8Array(0);
// 2^64-1 is reserved (the spec's rekey value): the last nonce a cipher may use is one below it.
const MAX_NONCE = (1n << 64n) - 1n;
// The three messages of XX: their tokens and their size without the payload (the payload's tag included where the
// payload is encrypted): 32 for e; 32 + 16 for s once a key exists; 16 for the payload's tag once a key exists.
const PATTERN = [
  { tokens: ["e"], overhead: DHLEN },
  { tokens: ["e", "ee", "s", "es"], overhead: DHLEN + DHLEN + TAGLEN + TAGLEN },
  { tokens: ["s", "se"], overhead: DHLEN + TAGLEN + TAGLEN },
];

// A Uint8Array, also one made in another realm (a worker, another frame), as noble checks it.
const isBytes = v => v instanceof Uint8Array || (ArrayBuffer.isView(v) && v.constructor.name === "Uint8Array");
function bytes(v, what, len) {
  if (!isBytes(v) || (len !== undefined && v.length !== len)) throw new Error(`${what} must be ${len === undefined ? "" : `${len} `}bytes`);
  return v;
}

function generateKeypair() {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}
// A keypair given by the caller, copied, with its public key derived from the private one.
function keypair(kp, what) {
  if (!kp || typeof kp !== "object") throw new Error(`${what} keypair missing`);
  const privateKey = bytes(kp.privateKey, `${what} private key`, DHLEN).slice();
  const publicKey = x25519.getPublicKey(privateKey);
  if (kp.publicKey !== undefined && bytesToHex(bytes(kp.publicKey, `${what} public key`, DHLEN)) !== bytesToHex(publicKey)) {
    throw new Error(`${what} public key does not match`);
  }
  return { privateKey, publicKey };
}
function idOf(publicKey) {
  return bytesToHex(sha256(bytes(publicKey, "public key", DHLEN)));
}

// noble refuses a shared secret of all zeros (the other side sent a low-order point): the spec lets DH fail so.
const dh = (kp, publicKey) => x25519.getSharedSecret(kp.privateKey, publicKey);

// HKDF as the spec defines it (RFC 5869 with an empty info): two or three 32-byte outputs.
function hkdf(chainingKey, ikm, n) {
  const temp = hmac(sha256, chainingKey, ikm);
  const out1 = hmac(sha256, temp, Uint8Array.of(1));
  const out2 = hmac(sha256, temp, concatBytes(out1, Uint8Array.of(2)));
  if (n === 2) return [out1, out2];
  return [out1, out2, hmac(sha256, temp, concatBytes(out2, Uint8Array.of(3)))];
}

// ChaChaPoly's nonce: 4 zero bytes, then the 64-bit counter little-endian.
function nonceBytes(n) {
  const out = new Uint8Array(12);
  for (let i = 0; i < 8; i++) out[4 + i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}

// The spec's CipherState: a key (or none yet) and its nonce counter. Used inside the handshake and, after split(),
// as one direction of the link.
function cipherState(key) {
  let k = key, n = 0n;
  function next() {
    if (n >= MAX_NONCE) throw new Error("nonce exhausted");
    return nonceBytes(n);
  }
  return {
    hasKey: () => k !== null,
    encrypt(ad, plaintext) {
      if (k === null) return plaintext;
      const out = chacha20poly1305(k, next(), ad).encrypt(plaintext);
      n++;
      return out;
    },
    decrypt(ad, ciphertext) {
      if (k === null) return ciphertext;
      if (ciphertext.length < TAGLEN) throw new Error("message too short");
      let out;
      try { out = chacha20poly1305(k, next(), ad).decrypt(ciphertext); } catch { throw new Error("decryption failed"); }
      n++;
      return out;
    },
    nonce: () => n,
    destroy() { if (k) k.fill(0); k = null; },
  };
}

// One direction of a finished link: what split() hands out. Any error leaves it broken for good.
function transport(key) {
  const cs = cipherState(key);
  let broken = false;
  const guard = fn => {
    if (broken) throw new Error("cipher unusable after an error");
    try { return fn(); } catch (err) { broken = true; cs.destroy(); throw err; }
  };
  return {
    encrypt: plaintext => guard(() => {
      bytes(plaintext, "plaintext");
      if (plaintext.length > MAX_PLAINTEXT) throw new Error("plaintext too long");
      return cs.encrypt(EMPTY, plaintext);
    }),
    decrypt: ciphertext => guard(() => {
      bytes(ciphertext, "message");
      if (ciphertext.length > MAX_MESSAGE) throw new Error("message too long");
      return cs.decrypt(EMPTY, ciphertext);
    }),
    // How many messages went through (the next nonce): for tests and diagnostics.
    get nonce() { return cs.nonce(); },
  };
}

function createHandshake({ initiator, s: staticKeys, prologue = EMPTY, e: fixedEphemeral } = {}) {
  if (typeof initiator !== "boolean") throw new Error("initiator must be true or false");
  const s = keypair(staticKeys, "static");
  bytes(prologue, "prologue");
  const fixedE = fixedEphemeral === undefined ? null : keypair(fixedEphemeral, "ephemeral");
  let e = null; // this side's ephemeral keypair, from its first message on
  let re = null, rs = null; // the other side's ephemeral and static keys, as they arrive

  // The spec's SymmetricState: the chaining key, the handshake hash and the CipherState.
  const name = utf8ToBytes(PROTOCOL);
  let h = name.length <= HASHLEN ? concatBytes(name, new Uint8Array(HASHLEN - name.length)) : sha256(name);
  let ck = h.slice();
  let cs = cipherState(null);
  const mixHash = data => { h = sha256(concatBytes(h, data)); };
  const mixKey = ikm => {
    const [newCk, tempK] = hkdf(ck, ikm, 2);
    ck = newCk;
    cs.destroy();
    cs = cipherState(tempK);
  };
  const encryptAndHash = plaintext => { const c = cs.encrypt(h, plaintext); mixHash(c); return c; };
  const decryptAndHash = ciphertext => { const p = cs.decrypt(h, ciphertext); mixHash(ciphertext); return p; };
  mixHash(prologue);

  let step = 0, failed = false, finished = false, splitDone = false;
  // The DH tokens name the initiator's key first and the responder's second: es = the initiator's e with the
  // responder's s, se = the initiator's s with the responder's e. Each side does its half with its own private key.
  const dhToken = token => {
    if (token === "ee") return dh(e, re);
    if (token === "es") return initiator ? dh(e, rs) : dh(s, re);
    return initiator ? dh(s, re) : dh(e, rs); // "se"
  };
  const myTurn = () => (step % 2 === 0) === initiator;
  function run(writing, fn) {
    if (failed) throw new Error("handshake unusable after an error");
    if (finished) throw new Error("handshake already done");
    try {
      // Out of turn means the two sides disagree about the handshake: as broken as a bad message.
      if (writing !== myTurn()) throw new Error(writing ? "not our turn to write" : "not our turn to read");
      return fn(PATTERN[step]);
    } catch (err) { failed = true; cs.destroy(); throw err; }
  }
  const advance = () => { step++; if (step === PATTERN.length) finished = true; };

  function writeMessage(payload = EMPTY) {
    return run(true, ({ tokens, overhead }) => {
      bytes(payload, "payload");
      if (payload.length + overhead > MAX_MESSAGE) throw new Error("payload too long");
      const parts = [];
      for (const token of tokens) {
        if (token === "e") {
          e = fixedE || generateKeypair();
          parts.push(e.publicKey);
          mixHash(e.publicKey);
        } else if (token === "s") {
          parts.push(encryptAndHash(s.publicKey));
        } else {
          mixKey(dhToken(token));
        }
      }
      parts.push(encryptAndHash(payload));
      advance();
      return concatBytes(...parts);
    });
  }

  function readMessage(message) {
    return run(false, ({ tokens, overhead }) => {
      bytes(message, "message");
      if (message.length > MAX_MESSAGE) throw new Error("message too long");
      if (message.length < overhead) throw new Error("message too short");
      let at = 0;
      const take = len => message.subarray(at, (at += len));
      for (const token of tokens) {
        if (token === "e") {
          re = take(DHLEN).slice();
          mixHash(re);
        } else if (token === "s") {
          rs = decryptAndHash(take(cs.hasKey() ? DHLEN + TAGLEN : DHLEN)).slice();
        } else {
          mixKey(dhToken(token));
        }
      }
      const payload = decryptAndHash(message.subarray(at)).slice();
      advance();
      return payload;
    });
  }

  function split() {
    if (failed) throw new Error("handshake unusable after an error");
    if (!finished) throw new Error("handshake not done");
    if (splitDone) throw new Error("already split");
    splitDone = true;
    const [k1, k2] = hkdf(ck, EMPTY, 2);
    // The handshake's secrets are no longer needed; the hash stays for channel binding.
    ck.fill(0);
    cs.destroy();
    if (e && e !== fixedE) e.privateKey.fill(0);
    // k1 is the initiator's sending key, k2 the responder's.
    return initiator ? { send: transport(k1), recv: transport(k2) } : { send: transport(k2), recv: transport(k1) };
  }

  return {
    writeMessage,
    readMessage,
    split,
    get done() { return finished && !failed; },
    get remoteStatic() { return rs && !failed ? rs.slice() : null; },
    get hash() { return finished && !failed ? h.slice() : null; },
  };
}

module.exports = { PROTOCOL, MAX_MESSAGE, MAX_PLAINTEXT, generateKeypair, idOf, createHandshake };
