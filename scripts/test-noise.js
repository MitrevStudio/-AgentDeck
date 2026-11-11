// Noise_XX_25519_ChaChaPoly_SHA256 (src/mesh/noise.js), the web link's encryption:
// - the published test vectors of two other implementations give the very same handshake messages, handshake hash
//   and transport messages (fixed static and ephemeral keys, a prologue, a payload in every message);
// - with random keys both sides finish, see each other's static key, share the handshake hash and talk both ways;
//   nonces advance (the same plaintext twice gives two ciphertexts) and a message decrypts only in its place;
// - a tampered, truncated, replayed or reordered message fails, so does a different prologue, a low-order key, a
//   call out of turn and anything too long; after a failure the handshake or cipher refuses everything.
// Plain synchronous code on purpose: the same file also runs bundled for the browser (esbuild --platform=browser),
// with no Buffer and no process around, to show the module needs nothing of Node.
const assert = require("node:assert/strict");
const { bytesToHex: hex, hexToBytes: unhex, utf8ToBytes } = require("@noble/hashes/utils");
const { x25519 } = require("@noble/curves/ed25519");
const noise = require("../src/mesh/noise");
const { createHandshake, generateKeypair, idOf, MAX_MESSAGE, MAX_PLAINTEXT } = noise;

// ---------- published test vectors (copied verbatim, only the one protocol of each file) ----------
const VECTORS = [
  // cacophony: https://raw.githubusercontent.com/haskell-cryptography/cacophony/master/vectors/cacophony.txt
  {"protocol_name":"Noise_XX_25519_ChaChaPoly_SHA256","init_prologue":"4a6f686e2047616c74","init_static":"e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1","init_ephemeral":"893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a","resp_prologue":"4a6f686e2047616c74","resp_static":"4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893","resp_ephemeral":"bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b","handshake_hash":"c8e5f64e846193be2a834104c2a009868d6c9f3bd3c186299888b488b2f1f58e","messages":[{"payload":"4c756477696720766f6e204d69736573","ciphertext":"ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573"},{"payload":"4d757272617920526f746862617264","ciphertext":"95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884381cbad1f276e038c48378ffce2b65285e08d6b68aaa3629a5a8639392490e5b9bd5269c2f1e4f488ed8831161f19b7815528f8982ffe09be9b5c412f8a0db50f8814c7194e83f23dbd8d162c9326ad"},{"payload":"462e20412e20486179656b","ciphertext":"c7195ffacac1307ff99046f219750fc47693e23c3cb08b89c2af808b444850a80ae475b9df0f169ae80a89be0865b57f58c9fea0d4ec82a286427402f113e4b6ae769a1d95941d49b25030"},{"payload":"4361726c204d656e676572","ciphertext":"96763ed773f8e47bb3712f0e29b3060ffc956ffc146cee53d5e1df"},{"payload":"4a65616e2d426170746973746520536179","ciphertext":"3e40f15f6f3a46ae446b253bf8b1d9ffb6ed9b174d272328ff91a7e2e5c79c07f5"},{"payload":"457567656e2042f6686d20766f6e2042617765726b","ciphertext":"eb3f3515110702e047a6c9da4478b6ead94873c11c0f2d710ddb3f09fce024b3a58502ae3f"}]},
  // snow: https://raw.githubusercontent.com/mcginty/snow/main/tests/vectors/snow.txt
  {"protocol_name":"Noise_XX_25519_ChaChaPoly_SHA256","init_prologue":"5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e","init_psks":[],"init_static":"7dec208517a3b81a2861d7a71266d5d6dc944c5a8816634a86fe63198a0148ee","init_ephemeral":"a32daf21e93c0131495ce1d903181fde81cc46937daaeb990bae7c992709421e","resp_prologue":"5468657265206973206e6f20726967687420616e642077726f6e672e2054686572652773206f6e6c792066756e20616e6420626f72696e672e","resp_psks":[],"resp_static":"4d0aed5098e3b4ef20357e9f686ce66204c792b358da2e475017d6c485304881","resp_ephemeral":"4eece0f195d026db035ff987597c429d3ad3bcc2944df37d649528951b2a27c5","messages":[{"payload":"d03c489139e645d0711a3c9e810d776b46a84912463fafa87b884eebf242dc34","ciphertext":"f9fa868ba97ab8a2686deccfaad5a484ee10a5bb85e3d1dce015a84797f92818d03c489139e645d0711a3c9e810d776b46a84912463fafa87b884eebf242dc34"},{"payload":"d8190a92f7dc0c93dbea9118ba8055751fb7c6590c416ffbd419964132b99a85","ciphertext":"8c4e6fdb7d09d501a86f7eca5c234522751706ed409182c05cdf5f827d4dae47b81c6c5f43b025692c24391eefee725c17d8cb0fbe3e4abb8aedf42c4fd2592d4ea48ac08989d6ae8b4adae08b2c34087c808c7aa55a63c02b0fab9e930612336bd43eaea04d3c670a0a146691aa9cc9d357872320dc735dbc48580cffb553db"},{"payload":"77891b19dcb92ef7c055b672c4a5aa7fdf1c84146b8b303459022729473ce254","ciphertext":"933ca6b5ed60df3df66121f0ab49a09e49efa45c613a86a3cecbf4c535cef2f83f72b42837b18e3572f2fdc2b74c331e2368a545cef54bdca081678ab0e9dd5348122459e0c034c851984d88ce610963d43cde6cfe73a67fbd5a63e8bfca96d0"},{"payload":"d7efdf988072881941db045a42882433817555128fbf5663e56081712ec7d212","ciphertext":"54ef0ff0629e1aaa7685a2806ab111cba76b52331f2642276736f415868eacb69ab2577f3bda0cbf72f879685f6ed25f"},{"payload":"dd7bf01a588bafb52c6cfba952e5d8fe35cc2b3f92b4730ae2474615157345ce","ciphertext":"356be70f110306d5c699bb834bb9d58d909e325924dfbec972e406e6f294dc63e1daebefe8a62a334facc8048ab4ad66"}]},
];

// Only the private keys are in the vectors; the public ones follow from them.
const kp = privHex => ({ privateKey: unhex(privHex) });
const pub = privHex => hex(x25519.getPublicKey(unhex(privHex)));

let checked = 0;
for (const [index, v] of VECTORS.entries()) {
  assert.equal(v.protocol_name, noise.PROTOCOL);
  const at = `vector ${index} message`;
  const init = createHandshake({ initiator: true, s: kp(v.init_static), e: kp(v.init_ephemeral), prologue: unhex(v.init_prologue) });
  const resp = createHandshake({ initiator: false, s: kp(v.resp_static), e: kp(v.resp_ephemeral), prologue: unhex(v.resp_prologue) });
  let ends = null;
  // The messages alternate: the initiator sends the even ones, the responder the odd ones, in the handshake and after.
  for (const [i, m] of v.messages.entries()) {
    const fromInit = i % 2 === 0;
    if (i < 3) {
      const [w, r] = fromInit ? [init, resp] : [resp, init];
      const sent = w.writeMessage(unhex(m.payload));
      assert.equal(hex(sent), m.ciphertext, `${at} ${i}: the handshake message`);
      assert.equal(hex(r.readMessage(sent)), m.payload, `${at} ${i}: the payload read back`);
      if (i === 1) assert.equal(hex(init.remoteStatic), pub(v.resp_static), "the initiator has the responder's key after message 2");
      if (i === 2) {
        assert.ok(init.done && resp.done);
        assert.equal(hex(resp.remoteStatic), pub(v.init_static));
        assert.equal(hex(init.hash), hex(resp.hash));
        if (v.handshake_hash) { assert.equal(hex(init.hash), v.handshake_hash, `vector ${index}: the handshake hash`); checked++; }
        ends = { init: init.split(), resp: resp.split() };
      }
    } else {
      const [w, r] = fromInit ? [ends.init, ends.resp] : [ends.resp, ends.init];
      const sent = w.send.encrypt(unhex(m.payload));
      assert.equal(hex(sent), m.ciphertext, `${at} ${i}: the transport message`);
      assert.equal(hex(r.recv.decrypt(sent)), m.payload);
    }
    checked++;
  }
}
assert.equal(checked, VECTORS.reduce((n, v) => n + v.messages.length + (v.handshake_hash ? 1 : 0), 0));

// ---------- random keys: a whole link ----------
function handshake(opts = {}) {
  const a = opts.a || generateKeypair(), b = opts.b || generateKeypair();
  const init = createHandshake({ initiator: true, s: a, prologue: opts.prologueA || utf8ToBytes("AgentDeck web 1") });
  const resp = createHandshake({ initiator: false, s: b, prologue: opts.prologueB || utf8ToBytes("AgentDeck web 1") });
  return { a, b, init, resp };
}
function link() {
  const h = handshake();
  h.resp.readMessage(h.init.writeMessage());
  h.init.readMessage(h.resp.writeMessage(utf8ToBytes("hello phone")));
  h.resp.readMessage(h.init.writeMessage(utf8ToBytes("hello node")));
  return { ...h, i: h.init.split(), r: h.resp.split() };
}
{
  const { a, b, init, resp } = handshake();
  assert.equal(init.remoteStatic, null);
  assert.equal(init.hash, null, "no hash before the handshake is done");
  const m1 = init.writeMessage();
  assert.equal(m1.length, 32, "message 1: just the ephemeral key");
  assert.equal(resp.readMessage(m1).length, 0);
  assert.equal(resp.remoteStatic, null);
  const m2 = resp.writeMessage(utf8ToBytes("from the node"));
  assert.equal(m2.length, 32 + 48 + 13 + 16);
  assert.equal(new TextDecoder().decode(init.readMessage(m2)), "from the node");
  assert.equal(hex(init.remoteStatic), hex(b.publicKey), "the initiator sees the responder's static key");
  assert.ok(!init.done);
  assert.throws(() => init.split(), /not done/);
  resp.readMessage(init.writeMessage());
  assert.equal(hex(resp.remoteStatic), hex(a.publicKey), "the responder sees the initiator's static key");
  assert.ok(init.done && resp.done);
  assert.equal(hex(init.hash), hex(resp.hash));
  assert.equal(init.hash.length, 32);
  const i = init.split(), r = resp.split();
  assert.throws(() => init.split(), /already split/);
  assert.throws(() => init.writeMessage(), /already done/);

  // Both ways, nonces advancing.
  const p = utf8ToBytes("same text");
  const c1 = i.send.encrypt(p), c2 = i.send.encrypt(p);
  assert.notEqual(hex(c1), hex(c2), "a new nonce per message");
  assert.equal(i.send.nonce, 2n);
  assert.equal(hex(r.recv.decrypt(c1)), hex(p));
  assert.equal(hex(r.recv.decrypt(c2)), hex(p));
  assert.equal(r.recv.nonce, 2n);
  assert.equal(new TextDecoder().decode(i.recv.decrypt(r.send.encrypt(utf8ToBytes("back")))), "back");
  assert.equal(i.recv.decrypt(r.send.encrypt(new Uint8Array(0))).length, 0, "an empty message is fine");
  // The two directions have different keys: what the initiator sends is not readable as the responder's.
  assert.throws(() => i.recv.decrypt(i.send.encrypt(p)), /decryption failed/);
}
// Two handshakes of the same keys: different ephemerals, different hashes.
{
  const a = generateKeypair(), b = generateKeypair();
  const hashes = [0, 1].map(() => {
    const h = handshake({ a, b });
    h.resp.readMessage(h.init.writeMessage());
    h.init.readMessage(h.resp.writeMessage());
    h.resp.readMessage(h.init.writeMessage());
    return hex(h.init.hash);
  });
  assert.notEqual(hashes[0], hashes[1]);
}

// ---------- ids and keys ----------
{
  const k = generateKeypair();
  assert.equal(k.publicKey.length, 32);
  assert.equal(k.privateKey.length, 32);
  assert.equal(hex(x25519.getPublicKey(k.privateKey)), hex(k.publicKey));
  assert.match(idOf(k.publicKey), /^[0-9a-f]{64}$/);
  assert.equal(idOf(k.publicKey), idOf(k.publicKey.slice()));
  assert.notEqual(idOf(k.publicKey), idOf(generateKeypair().publicKey));
  // SHA-256 of 32 zero bytes, a known value.
  assert.equal(idOf(new Uint8Array(32)), "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925");
  assert.throws(() => idOf(new Uint8Array(31)));
  assert.throws(() => createHandshake({ initiator: true, s: { privateKey: k.privateKey, publicKey: generateKeypair().publicKey } }), /does not match/);
  assert.throws(() => createHandshake({ initiator: true }), /keypair missing/);
  assert.throws(() => createHandshake({ s: k }), /initiator/);
  assert.throws(() => createHandshake({ initiator: true, s: k, prologue: "text" }), /prologue/);
}

// ---------- failures ----------
// Each one leaves the handshake unusable.
const unusable = h => { assert.throws(() => h.writeMessage(), /unusable/); assert.throws(() => h.readMessage(new Uint8Array(32)), /unusable/); assert.equal(h.done, false); };
const flip = (m, at) => { const c = m.slice(); c[at] ^= 1; return c; };
{ // tampered handshake message 2 (in the encrypted static key, then in the payload)
  for (const at of [40, 32 + 48 + 2]) {
    const { init, resp } = handshake();
    resp.readMessage(init.writeMessage());
    const m2 = resp.writeMessage(utf8ToBytes("pay"));
    assert.throws(() => init.readMessage(flip(m2, at)), /decryption failed/);
    unusable(init);
  }
}
{ // tampered ephemeral key in message 1: the responder goes on, the initiator cannot read its answer
  const { init, resp } = handshake();
  resp.readMessage(flip(init.writeMessage(), 5));
  assert.throws(() => init.readMessage(resp.writeMessage()), /decryption failed/);
}
{ // tampered message 3
  const { init, resp } = handshake();
  resp.readMessage(init.writeMessage());
  init.readMessage(resp.writeMessage());
  assert.throws(() => resp.readMessage(flip(init.writeMessage(), 10)), /decryption failed/);
  unusable(resp);
  assert.equal(resp.remoteStatic, null);
  assert.throws(() => resp.split(), /unusable/);
}
{ // truncated messages
  const { init, resp } = handshake();
  assert.throws(() => resp.readMessage(init.writeMessage().subarray(0, 31)), /too short/);
  unusable(resp);
  const h = handshake();
  h.resp.readMessage(h.init.writeMessage());
  const m2 = h.resp.writeMessage();
  assert.throws(() => h.init.readMessage(m2.subarray(0, m2.length - 1)), /too short/);
  const h2 = handshake();
  h2.resp.readMessage(h2.init.writeMessage());
  const m2b = h2.resp.writeMessage(utf8ToBytes("payload"));
  assert.throws(() => h2.init.readMessage(m2b.subarray(0, m2b.length - 3)), /decryption failed/);
}
{ // a different prologue: the first encrypted part fails
  const { init, resp } = handshake({ prologueB: utf8ToBytes("AgentDeck web 2") });
  resp.readMessage(init.writeMessage());
  assert.throws(() => init.readMessage(resp.writeMessage()), /decryption failed/);
}
{ // a low-order ephemeral key (all zeros) makes the DH fail instead of giving a key anyone knows
  const { resp } = handshake();
  resp.readMessage(new Uint8Array(32));
  assert.throws(() => resp.writeMessage());
  unusable(resp);
}
{ // out of turn
  const { init, resp } = handshake();
  assert.throws(() => init.readMessage(new Uint8Array(32)), /not our turn to read/);
  const fresh = handshake();
  assert.throws(() => fresh.resp.writeMessage(), /not our turn to write/);
  const h = handshake();
  h.init.writeMessage();
  assert.throws(() => h.init.writeMessage(), /not our turn to write/);
  unusable(init);
  unusable(fresh.resp);
}
{ // too long, in the handshake and after
  const h = handshake();
  assert.throws(() => h.init.writeMessage(new Uint8Array(MAX_MESSAGE - 32 + 1)), /too long/);
  const ok = handshake();
  assert.equal(ok.init.writeMessage(new Uint8Array(MAX_MESSAGE - 32)).length, MAX_MESSAGE, "exactly the limit is fine");
  const r = handshake();
  assert.throws(() => r.resp.readMessage(new Uint8Array(MAX_MESSAGE + 1)), /too long/);
  const h2 = handshake();
  h2.resp.readMessage(h2.init.writeMessage());
  assert.throws(() => h2.resp.writeMessage(new Uint8Array(MAX_MESSAGE - 96 + 1)), /too long/);

  assert.equal(MAX_PLAINTEXT, MAX_MESSAGE - 16);
  const { i, r: rr } = link();
  const big = i.send.encrypt(new Uint8Array(MAX_PLAINTEXT).fill(7));
  assert.equal(big.length, MAX_MESSAGE);
  assert.equal(rr.recv.decrypt(big).length, MAX_PLAINTEXT);
  assert.throws(() => i.send.encrypt(new Uint8Array(MAX_PLAINTEXT + 1)), /too long/);
  assert.throws(() => i.send.encrypt(utf8ToBytes("x")), /unusable/, "a cipher that failed stays failed");
  assert.throws(() => rr.recv.decrypt(new Uint8Array(MAX_MESSAGE + 1)), /too long/);
}
{ // transport: tampered, truncated, replayed, reordered - and broken afterwards
  for (const bad of [c => flip(c, 3), c => c.subarray(0, c.length - 1), c => c.subarray(0, 15)]) {
    const { i, r } = link();
    const c = i.send.encrypt(utf8ToBytes("terminal input"));
    assert.throws(() => r.recv.decrypt(bad(c)));
    assert.throws(() => r.recv.decrypt(c), /unusable/, "the right message no longer helps");
  }
  const { i, r } = link();
  const c1 = i.send.encrypt(utf8ToBytes("one")), c2 = i.send.encrypt(utf8ToBytes("two"));
  assert.throws(() => r.recv.decrypt(c2), /decryption failed/, "out of order");
  const l = link();
  const d = l.i.send.encrypt(utf8ToBytes("once"));
  l.r.recv.decrypt(d);
  assert.throws(() => l.r.recv.decrypt(d), /decryption failed/, "replayed");
  assert.throws(() => l.r.recv.decrypt("text"));
  void c1;
}

console.log(`noise: ${VECTORS.length} published vectors (${checked} checks: handshake messages, hash, transport), random links both ways, tampered/truncated/replayed/reordered/out-of-turn/oversize/low-order/wrong prologue refused OK`);
