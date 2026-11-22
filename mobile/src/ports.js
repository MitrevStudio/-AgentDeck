// What the "Ports" sheet of a terminal shows (screens/ports.js draws it; docs/PORT-FORWARDING.md 4): the listening
// ports of the terminal's computer as that computer lists them, the forwards this phone has to it, and the ports
// typed by hand. Nothing of the DOM here: the rows are built from plain data, so scripts/test-mobile-forward.js
// checks them in Node. The same list and wording as the desktop's menu (src/main.js listPorts, src/workspace-ui.js
// getPortsItems).
//
// The ports typed by hand ("Other port…") are remembered for the terminal's folder on its computer - the project, as
// far as a phone knows one: { "<node>:<folder>": [port] } in localStorage, the newest first, SAVED_MAX a folder; only
// on this phone (drafts.js keeps a session's unsent text the same way).
import { t, errorText } from "./i18n.js";
import { normPath } from "./util.js";

const PORTS_KEY = "agentdeck.ports";
const SAVED_MAX = 20, LISTED_MAX = 500;
export const isPort = v => Number.isInteger(v) && v >= 1 && v <= 65535;
// What a field holds, as a port: 0 when it is none.
export const readPort = text => (/^\d{1,5}$/.test(String(text).trim()) && isPort(Number(String(text).trim())) ? Number(String(text).trim()) : 0);

// ---------- the ports typed by hand ----------
export const portsKey = (node, cwd) => `${node}:${normPath(cwd)}`;
function all() { try { return JSON.parse(localStorage.getItem(PORTS_KEY) || "{}") || {}; } catch { return {}; } }
export function savedPorts(key) {
  const list = all()[key];
  return Array.isArray(list) ? [...new Set(list.filter(isPort))].slice(0, SAVED_MAX) : [];
}
function save(key, ports) {
  const kept = all();
  if (ports.length) kept[key] = ports.slice(0, SAVED_MAX); else delete kept[key];
  try { localStorage.setItem(PORTS_KEY, JSON.stringify(kept)); } catch {}
}
export const rememberPort = (key, port) => save(key, [port, ...savedPorts(key).filter(p => p !== port)]);
export const forgetPort = (key, port) => save(key, savedPorts(key).filter(p => p !== port));

// ---------- the list ----------
// A list of listening ports as the sheet gets it: one row a port (a server on both 0.0.0.0 and :: is one row; `own`
// when any of them is of the terminal's process tree), own first, then by number. What a computer answers is not
// trusted to be well formed.
export function cleanPorts(list) {
  const rows = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    if (x === null || typeof x !== "object" || !isPort(x.port)) continue;
    const row = rows.get(x.port) || { port: x.port, process: "", own: false };
    if (!row.process && typeof x.process === "string") row.process = x.process.slice(0, 80);
    row.own = row.own || x.own === true;
    rows.set(x.port, row);
  }
  return [...rows.values()].sort((a, b) => b.own - a.own || a.port - b.port).slice(0, LISTED_MAX);
}

// -> { node, name, ports: [{ port, process, own }], forwards: [{ node, port, localPort }] of that computer, saved:
// [port], error?, message? }. error: "offline" (the computer is not connected), "update" (its AgentDeck is too old to
// list or forward ports: no `ports: 1` in its host.info, or it does not know the method), "failed" (the list could
// not be read; `message` says why, "" when the computer itself could not read its ports). Asked when the sheet
// opens, never on a timer. store: data.js; forwards: forward.js.
export async function loadPorts({ store, forwards, node, term, cwd = "" }) {
  const base = { node, name: store.nodeName(node), ports: [], forwards: forwards.list().filter(f => f.node === node), saved: savedPorts(portsKey(node, cwd)) };
  const e = store.node(node);
  if (e?.node?.status !== "online") return { ...base, error: "offline" };
  // A computer whose host.info is not read yet is asked anyway, and answers "unknownMethod" if it is old.
  if (e.info && e.info.ports !== 1) return { ...base, error: "update" };
  try {
    return { ...base, ports: cleanPorts(await store.ports(node, term)) };
  } catch (err) {
    if (err?.code === "offline") return { ...base, error: "offline" };
    if (err?.code === "unknownMethod") return { ...base, error: "update" };
    return { ...base, error: "failed", message: err?.code === "portsUnread" ? "" : errorText(err) };
  }
}

// The sheet's rows, top to bottom:
//   { kind: "note", text }                     what could not be shown, or that nothing listens
//   { kind: "group", text }                    a heading: the terminal's own ports / the rest / the remembered ones
//   { kind: "port", port, process, own, active, localPort, saved, title, meta }
//       active: this phone forwards it now (localPort: where); saved: typed by hand for this folder. title: the
//       number; meta: the process and, for a forward, that it is one - with its address here when the number differs.
//   { kind: "other" }                          "Other port…"
// The terminal's own ports first, then those typed by hand and the forwards nothing listens behind any more (so
// they can still be stopped or forgotten), then "Other port…", and only then the rest of the computer's ports: a
// Windows machine listens on dozens, and what the user came for must not be below them. A computer that is away or
// too old has one note and nothing to tap.
export function portRows(data) {
  const name = data.name || "";
  const note = text => ({ kind: "note", text });
  if (data.error === "offline") return [note(t("ports.offline", { name }))];
  if (data.error === "update") return [note(t("ports.needsUpdate", { name }))];
  const active = new Map((data.forwards || []).map(f => [f.port, f.localPort]));
  const saved = new Set(data.saved || []);
  const row = (port, process = "", own = false) => {
    const local = active.get(port);
    const state = !local ? "" : local === port ? t("ports.forwarded") : t("ports.forwardedAs", { address: `127.0.0.1:${local}` });
    return { kind: "port", port, process, own, active: active.has(port), localPort: local || 0, saved: saved.has(port), title: String(port), meta: [process, state].filter(Boolean).join(" · ") };
  };
  const ports = data.ports || [], listed = new Set(ports.map(p => p.port));
  const own = ports.filter(p => p.own).map(p => row(p.port, p.process, true)), rest = ports.filter(p => !p.own).map(p => row(p.port, p.process));
  const kept = [...new Set([...saved, ...active.keys()])].filter(p => !listed.has(p)).sort((a, b) => a - b).map(p => row(p));
  const head = data.error ? [note(data.message || t("ports.failed"))] : ports.length ? [] : [note(t("ports.empty", { name }))];
  const group = (text, rows) => (rows.length ? [{ kind: "group", text }, ...rows] : []);
  return [...head, ...group(t("ports.own"), own), ...group(t("ports.kept"), kept), { kind: "other" }, ...group(own.length ? t("ports.rest") : t("ports.listening", { name }), rest)];
}

// Why a port could not be opened, as the user reads it: what the sheet's own words say better than the code's.
export function portError(e, { port, name }) {
  if (e?.code === "refused") return t("ports.dead", { port, name });
  if (e?.code === "offline") return t("ports.offline", { name });
  if (e?.code === "unknownMethod") return t("ports.needsUpdate", { name });
  return t("toast.failed", { error: errorText(e) });
}
