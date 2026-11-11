// What the pairing screens read from the user (docs/MOBILE.md 4): the QR/paste payload goes to pair-code.js as it is
// (provider-relay.js pairAll); the manual way is an address with its port and a code.

// "192.168.1.10:7421", "relay.example.org:7421", "[fe80::1]:7421" -> { address, port } or null. A pasted ws:// URL
// is taken too.
export function parseAddress(text) {
  const s = String(text || "").trim().replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(s) || /^([^\s/?#@[\]:]+):(\d{1,5})$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  return port > 0 && port < 65536 ? { address: m[1], port } : null;
}

// A code as typed: spaces gone (pair-proof.js reads dashes and case itself).
export const cleanCode = text => String(text || "").replace(/\s+/g, "");

// Does the text look like a pairing payload at all (so the paste field can tell it from a typed code)?
export const looksLikePayload = text => /^\s*AGENTDECK-PAIR:/i.test(String(text || ""));
