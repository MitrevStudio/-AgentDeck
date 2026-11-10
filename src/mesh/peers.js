// The nodes this one trusts (<dir>/peers.json: id = certificate fingerprint, name, kind, the last address it was
// reached at) and this node's pairing code (<dir>/pair-token.json), which another node must show to be added. The
// code is six digits for people to read off a screen; a headless host gets a long token instead (install.sh). It is
// made anew after every pairing and after too many wrong tries, so it cannot be guessed over time.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isObj } = require("../shared/util");

const ID = /^[0-9a-f]{64}$/;
const KINDS = ["desktop", "host"];
const MAX_TRIES = 5;
const TRIES_WINDOW_MS = 10 * 60 * 1000;

const digits = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const longToken = () => crypto.randomBytes(16).toString("hex");

function createPeers(dir) {
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
  // long: a token for a headless host (printed by its installer), not a code to read off a screen.
  function regenerate({ long = false } = {}) {
    token = { code: long ? longToken() : digits(), long, tries: [] };
    saveToken();
    return token.code;
  }
  if (!token.code) regenerate();
  // A fixed token (a scripted install): kept until the next pairing.
  function setCode(code) {
    token = { code: String(code), long: true, tries: [] };
    saveToken();
  }
  const code = () => token.code;
  // true when the code is right; too many wrong tries make a new code, which the user sees in Settings.
  function check(given) {
    const now = Date.now();
    token.tries = token.tries.filter(at => now - at < TRIES_WINDOW_MS);
    const a = Buffer.from(String(given ?? "").replace(/[\s-]/g, "")), b = Buffer.from(token.code);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (ok) return true;
    token.tries.push(now);
    if (token.tries.length >= MAX_TRIES) regenerate({ long: token.long });
    return false;
  }

  return { list, get, add, update, remove, code, regenerate, setCode, check, ID, KINDS };
}

module.exports = { createPeers, ID, KINDS };
