// The nodes this one trusts (<dir>/peers.json: id = certificate fingerprint, name, kind, the last address it was
// reached at) and this node's pairing code (<dir>/pair-token.json), which another node must show to be added. A
// desktop's code is six digits for people to read off a screen and type. A host's (a relay or a resource host, often
// reachable from the internet) is long: 128 random bits as 26 Crockford base32 characters in groups of four, which
// cannot be guessed. A code is made anew after every pairing and after too many wrong tries; how fast codes may be
// tried at all is pair-guard.js's business.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isObj } = require("../shared/util");

const ID = /^[0-9a-f]{64}$/;
const KINDS = ["desktop", "host"];
const MAX_TRIES = 5;
const TRIES_WINDOW_MS = 10 * 60 * 1000;

const digits = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
// Crockford base32 (no I, L, O, U): 26 characters, 128 random bits and 2 more, "XXXX-XXXX-...-XX".
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function longToken() {
  let bits = 0n;
  for (const b of crypto.randomBytes(17)) bits = (bits << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) out += BASE32[Number((bits >> BigInt(5 * i)) & 31n)];
  return out.match(/.{1,4}/g).join("-");
}
// What is compared: no spaces or dashes, upper case, and the letters Crockford reads as digits (I, L -> 1; O -> 0).
const normCode = code => String(code ?? "").replace(/[\s-]/g, "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
// Long enough not to be guessed: 20 or more letters and digits, not just a few repeated ("aaaa...").
const isLong = code => { const n = normCode(code); return /^[0-9A-Z]{20,}$/.test(n) && new Set(n).size >= 8; };

// long: this node's codes are long ones (a host); a short code saved earlier is replaced at once.
function createPeers(dir, { long: hostCodes = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "peers.json"), tokenFile = path.join(dir, "pair-token.json");

  // ---------- the trusted nodes ----------
  let peers = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    peers = (Array.isArray(saved?.peers) ? saved.peers : []).filter(p => isObj(p) && ID.test(p.id)).map(clean);
  } catch {}
  function clean(p) {
    const kind = KINDS.includes(p.kind) ? p.kind : "desktop";
    return {
      id: p.id, name: typeof p.name === "string" ? p.name.slice(0, 60) : "", kind,
      address: typeof p.address === "string" ? p.address : "", port: Number.isInteger(p.port) ? p.port : 0,
      // May this peer control this computer (open terminals, run git, write files - mesh/serve.js)? A desktop peer may;
      // a host (a VPS/relay, or a resource host) may relay and be used as a resource but never reach back into this
      // computer, so a broken or hostile relay cannot control the machines it connects. Fixed from the peer's kind at
      // pairing - not spoofable later, since an existing boolean is kept even if the peer re-announces another kind.
      control: typeof p.control === "boolean" ? p.control : kind === "desktop",
      pairedAt: Number(p.pairedAt) || Date.now(), lastSeen: Number(p.lastSeen) || 0
    };
  }
  const save = () => fs.writeFileSync(file, JSON.stringify({ peers }, null, 2));
  const list = () => peers.map(p => ({ ...p }));
  const get = id => peers.find(p => p.id === id) || null;
  function add(peer) {
    if (!ID.test(peer?.id)) throw new Error("not a node id");
    const p = clean({ ...get(peer.id), ...peer, pairedAt: Date.now() });
    peers = [...peers.filter(x => x.id !== p.id), p];
    save();
    return { ...p };
  }
  function update(id, patch) {
    const p = get(id);
    if (!p) return null;
    Object.assign(p, clean({ ...p, ...patch, pairedAt: p.pairedAt }));
    save();
    return { ...p };
  }
  function remove(id) {
    const before = peers.length;
    peers = peers.filter(p => p.id !== id);
    if (peers.length !== before) save();
    return peers.length !== before;
  }

  // ---------- the pairing code ----------
  let token = { code: "", long: false, tries: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
    if (typeof saved?.code === "string" && saved.code) token = { code: saved.code, long: saved.long === true, tries: [] };
  } catch {}
  const saveToken = () => fs.writeFileSync(tokenFile, JSON.stringify({ code: token.code, long: token.long }), { mode: 0o600 });
  // long: a token for a host (printed by its installer and by `agentdeck-host pair`), not a code to read off a screen.
  function regenerate({ long = hostCodes } = {}) {
    token = { code: long ? longToken() : digits(), long, tries: [] };
    saveToken();
    return token.code;
  }
  // A host that still has a short code (made before host codes were long) gets a long one.
  if (!token.code || (hostCodes && !isLong(token.code))) regenerate();
  // A fixed token (a scripted install): kept until the next pairing. One that could be guessed is refused.
  function setCode(code) {
    if (!isLong(code)) throw new Error("A pairing token needs at least 20 letters or digits.");
    token = { code: String(code), long: true, tries: [] };
    saveToken();
  }
  const code = () => token.code;
  // true when the code is right; too many wrong tries make a new code, which the user sees in Settings.
  function check(given) {
    const now = Date.now();
    token.tries = token.tries.filter(at => now - at < TRIES_WINDOW_MS);
    const a = Buffer.from(normCode(given)), b = Buffer.from(normCode(token.code));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) return true;
    token.tries.push(now);
    if (token.tries.length >= MAX_TRIES) regenerate({ long: token.long });
    return false;
  }

  return { list, get, add, update, remove, code, regenerate, setCode, check, ID, KINDS };
}

module.exports = { createPeers, ID, KINDS, normCode, isLong };
