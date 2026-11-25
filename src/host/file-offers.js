// A file of this computer offered to a paired phone (docs/FILES.md 3.6). A phone serves nothing (web-client.js answers
// every request with unknownMethod), so nothing can be pushed onto it: the phone is told of the file ("files.offer"),
// asks its user, and pulls it itself with files.read, as any download of its own. What it decided and how it went
// comes back as "files.answer"; the computer's row follows that.
//
// An offer is the phone's it was made to and nobody else's: an answer from another peer, or for an offer that is not
// (or no longer) there, is `jobMissing`. Only the steps an offer can take are taken:
//   waiting  -> accepted | declined | failed      (the phone's user chose; failed: e.g. the phone cannot save files)
//   accepted -> done | failed                     (the download ended)
// Nobody answered within answerMs: the offer says "noAnswer" - an app too old to know the event drops it silently, and
// that must not look like success - but stays answerable (a person may take longer to tap Save) until expireMs from
// when it was made; then it is gone. An accepted offer has no such end: a large file takes as long as it takes. It
// ends with the phone's answer, or as `failed` ("offline") when the phone's link drops.
//
// createFileOffers({ files, notify, isPhone, answerMs, expireMs, keepMs }) - files: host/files.js (its stat); notify(peer,
// name, data); isPhone(peer): a paired phone, linked now. -> { make, answer, withdraw, get, list, drop, dispose, on }:
// "change" (view) for each step of each offer.
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const path = require("node:path");
const { HostError } = require("./errors");

const ANSWER_MS = 20 * 1000;      // no word from the phone by then: "noAnswer"
const EXPIRE_MS = 2 * 60 * 1000;  // an offer nobody took is gone by then
const KEEP_MS = 10 * 60 * 1000;   // an offer that ended can still be read (not answered) this long
const STEPS = { waiting: ["accepted", "declined", "failed"], accepted: ["done", "failed"] };
const ENDED = new Set(["done", "declined", "failed", "expired", "withdrawn"]);

const fail = code => { throw new HostError(code); };

function createFileOffers({ files, notify = () => {}, isPhone = () => false, answerMs = ANSWER_MS, expireMs = EXPIRE_MS, keepMs = KEEP_MS } = {}) {
  const ev = new EventEmitter();
  const offers = new Map(); // id -> offer
  const later = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };

  // noAnswer: asked within answerMs, not answered yet (a state of its own only for the one who offered).
  const view = o => ({ offer: o.id, peer: o.peer, path: o.path, name: o.name, size: o.size, state: o.state, noAnswer: o.noAnswer, error: o.error });
  const changed = o => { try { ev.emit("change", view(o)); } catch {} };
  function end(o, state, error = "") {
    o.state = state;
    o.error = error;
    clearTimeout(o.quiet);
    clearTimeout(o.expire);
    changed(o);
    o.forget = later(keepMs, () => offers.delete(o.id));
  }

  // peer: a phone linked now; p: { path } of a file here. -> the offer's view, once the phone was told.
  async function make(peer, p) {
    if (typeof peer !== "string" || !isPhone(peer)) fail("offline");
    const st = await files.stat({ path: p?.path });
    if (st.dir) fail("notFile");
    const o = { id: crypto.randomUUID(), peer, path: st.path, name: st.name || path.basename(st.path), size: st.size, mtime: st.mtime, state: "waiting", noAnswer: false, error: "", at: Date.now() };
    offers.set(o.id, o);
    o.quiet = later(answerMs, () => { if (o.state === "waiting") { o.noAnswer = true; changed(o); } });
    o.expire = later(expireMs, () => { if (o.state === "waiting") end(o, "expired"); });
    notify(peer, "files.offer", { offer: o.id, path: o.path, name: o.name, size: o.size, mtime: o.mtime });
    changed(o);
    return view(o);
  }

  // {offer, state, error?} from peer -> true. error: the phone's code for a failure (a word, bounded).
  function answer(peer, p) {
    const o = typeof p?.offer === "string" ? offers.get(p.offer) : null;
    if (!o || o.peer !== peer || ENDED.has(o.state)) fail("jobMissing");
    if (!STEPS[o.state].includes(p.state)) fail("invalidData");
    const error = p.state === "failed" ? (typeof p.error === "string" && /^[A-Za-z0-9]{1,40}$/.test(p.error) ? p.error : "fileFailed") : "";
    if (p.state === "accepted") {
      o.state = "accepted";
      o.noAnswer = false;
      clearTimeout(o.quiet);
      clearTimeout(o.expire);
      changed(o);
    } else end(o, p.state, error);
    return true;
  }

  // The computer takes it back before the phone took it: a later answer finds nothing.
  function withdraw(id) {
    const o = offers.get(id);
    if (!o || o.state !== "waiting") return false;
    end(o, "withdrawn");
    return true;
  }
  // The phone's link dropped: what it had not finished fails with it.
  function drop(peer) {
    for (const o of offers.values()) if (o.peer === peer && !ENDED.has(o.state)) end(o, "failed", "offline");
  }
  function dispose() {
    for (const o of offers.values()) { clearTimeout(o.quiet); clearTimeout(o.expire); clearTimeout(o.forget); }
    offers.clear();
  }
  const get = id => (offers.has(id) ? view(offers.get(id)) : null);
  const list = () => [...offers.values()].map(view);

  return { make, answer, withdraw, get, list, drop, dispose, on: (name, fn) => { ev.on(name, fn); return () => ev.off(name, fn); } };
}

module.exports = { createFileOffers, ANSWER_MS, EXPIRE_MS };
