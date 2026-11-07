// Finding the other nodes on the local network, and letting them find this one: mDNS / DNS-SD, service
// _agentdeck._tcp, with the node's id, name, kind and version in the TXT record. Nothing found here is trusted - it
// only tells Settings where a node is, and pairing checks the certificate.
const { EventEmitter } = require("node:events");

const TYPE = "agentdeck";
const STALE_MS = 3 * 60 * 1000;

// self(): { id, name, kind, version, protocol }; iface: the address of the interface to use ("" for all).
function createDiscovery({ self, iface = "" }) {
  const out = new EventEmitter();
  const found = new Map(); // id -> { id, name, kind, version, protocol, address, port, lastSeen }
  let bonjour = null, service = null, browser = null;

  function instance() {
    if (!bonjour) {
      const { Bonjour } = require("bonjour-service");
      bonjour = new Bonjour(iface ? { interface: iface } : {}, e => console.error("mDNS:", e?.message || e));
    }
    return bonjour;
  }
  // Announces this node on `port`; announced again when the name or port changes.
  function advertise(port) {
    stopAdvertising();
    const s = self();
    service = instance().publish({
      name: `${s.name} (${s.id.slice(0, 8)})`.slice(0, 63), type: TYPE, port,
      txt: { id: s.id, name: s.name, kind: s.kind, ver: s.version, proto: String(s.protocol) }
    });
    service.on("error", e => console.error("mDNS announce:", e?.message || e));
  }
  function stopAdvertising() {
    if (service) {
      try { service.stop(); } catch {}
      service = null;
    }
  }
  function record(s) {
    const txt = s.txt || {};
    const id = String(txt.id || "");
    if (!/^[0-9a-f]{64}$/.test(id) || id === self().id) return;
    const addresses = (s.addresses || []).filter(a => a.includes("."));
    const address = addresses[0] || s.referer?.address || "";
    if (!address || !s.port) return;
    found.set(id, { id, name: String(txt.name || s.name || ""), kind: String(txt.kind || "desktop"), version: String(txt.ver || ""),
      protocol: Number(txt.proto) || 0, address, port: s.port, lastSeen: Date.now() });
    out.emit("changed");
  }
  function browse() {
    if (browser) {
      browser.update();
      return;
    }
    browser = instance().find({ type: TYPE }, record);
    browser.on("down", s => {
      const id = String(s.txt?.id || "");
      if (found.delete(id)) out.emit("changed");
    });
  }
  function stopBrowsing() {
    browser?.stop();
    browser = null;
  }
  const list = () => [...found.values()].filter(x => Date.now() - x.lastSeen < STALE_MS);
  function stop() {
    stopAdvertising();
    stopBrowsing();
    bonjour?.destroy();
    bonjour = null;
  }

  return Object.assign(out, { advertise, stopAdvertising, browse, stopBrowsing, list, stop });
}

module.exports = { createDiscovery, TYPE };
