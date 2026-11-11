// One-time pairing codes for phones (docs/MOBILE.md 4: pair.invite). A desktop that adds a phone asks each node the
// phone should reach for one and puts them all in one QR code (pair-code.js). An invite is 128 random bits (a long
// token, peers.js), lives INVITE_TTL_MS, pairs one phone and only over a web link (links.js), and is gone after one
// try, right or wrong. A pairing names the invite it proves by its tag (pair-code.js inviteTag) - the code is never
// sent. Kept in memory only: a restart ends them all. At most MAX_INVITES at a time; a new one pushes out the oldest.
// A node's own code is not touched by any of this and keeps working for pairing by hand.
const { longToken } = require("./peers");
const { inviteTag } = require("./pair-code");
const { same } = require("./pair-proof");

const INVITE_TTL_MS = 10 * 60 * 1000;
const MAX_INVITES = 16;
const TAG = /^[0-9a-f]{64}$/;

function createInvites({ now = Date.now, ttlMs = INVITE_TTL_MS } = {}) {
  let list = []; // { code, tag, expires }, oldest first
  const prune = () => { const t = now(); list = list.filter(x => x.expires > t); };
  // -> { code, expires }
  function mint() {
    prune();
    const code = longToken();
    const x = { code, tag: inviteTag(code), expires: now() + ttlMs };
    list.push(x);
    while (list.length > MAX_INVITES) list.shift();
    return { code, expires: x.expires };
  }
  // The invite named by `tag`, or null. Every one is compared, each in constant time.
  function find(tag) {
    prune();
    if (typeof tag !== "string" || !TAG.test(tag)) return null;
    let hit = null;
    for (const x of list) if (same(tag, x.tag)) hit = x;
    return hit;
  }
  // Whether an invite find() gave is still there (not used, not expired).
  const live = x => { prune(); return list.includes(x); };
  const use = x => { list = list.filter(y => y !== x); };
  return { mint, find, live, use, size: () => { prune(); return list.length; } };
}

module.exports = { createInvites, INVITE_TTL_MS, MAX_INVITES };
