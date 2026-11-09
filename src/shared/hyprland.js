// Hyprland's IPC (Linux, Wayland), for what Wayland itself does not let an application do: global key bindings, the
// window in front, focusing a window, the state of a key, and rules for our own windows (the voice panel floats,
// pinned and unfocusable). Hyprland 0.5x takes Lua through `dispatch`: a binding, a rule or an unbind is added that
// way at run time; what Hyprland adds at run time goes with a config reload, so `onReload` is how it is put back.
//
// Requests go over .socket.sock, async (request) or through hyprctl when the caller needs the answer at once
// (requestSync: the hotkeys register synchronously). Events arrive on .socket2.sock, one "name>>data" per line;
// bindings made here send theirs with hl.dsp.event, which shows up there as "custom>>data".
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const runtimeDir = () => process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;

// The running Hyprland's instance: the environment's, else the newest one with a socket (an app started outside the
// session's environment, from a shell over SSH, say).
let cachedSig;
function signature() {
  if (cachedSig !== undefined) return cachedSig;
  cachedSig = null;
  if (process.platform !== "linux") return cachedSig;
  const base = path.join(runtimeDir(), "hypr");
  const has = sig => { try { return fs.statSync(path.join(base, sig, ".socket.sock")).isSocket(); } catch { return false; } };
  const env = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (env && has(env)) return (cachedSig = env);
  try {
    const found = fs.readdirSync(base).filter(has)
      .map(sig => ({ sig, at: fs.statSync(path.join(base, sig)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
    cachedSig = found ? found.sig : null;
  } catch {}
  return cachedSig;
}
const available = () => Boolean(signature());
const socketPath = name => path.join(runtimeDir(), "hypr", signature(), name);

function request(command, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(new Error("Hyprland is not running"));
    const chunks = [];
    const sock = net.connect(socketPath(".socket.sock"));
    const timer = setTimeout(() => sock.destroy(new Error("Hyprland did not answer")), timeoutMs);
    sock.on("connect", () => sock.end(command));
    sock.on("data", d => chunks.push(d));
    sock.on("error", e => { clearTimeout(timer); reject(e); });
    sock.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
  });
}
function requestSync(args, timeoutMs = 2000) {
  if (!available()) throw new Error("Hyprland is not running");
  return execFileSync("hyprctl", args, {
    encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, HYPRLAND_INSTANCE_SIGNATURE: signature() }
  });
}
const json = text => { try { return JSON.parse(text); } catch { return null; } };

// Lua run for its effect: `dispatch` wants a dispatcher back, so the statements end with a no-op one.
const luaCommand = code => `(function() ${code}\nreturn hl.dsp.no_op() end)()`;
const lua = code => request(`dispatch ${luaCommand(code)}`, 5000);
const luaSync = code => requestSync(["dispatch", luaCommand(code)]);
// A Lua value read back: `dispatch` answers nothing but "ok" or the error, so the value comes back as one. The
// marker is put together at run time, so the request's own text (echoed in the error) never contains it.
const MARK = "\u0001AD\u0001";
async function query(expr) {
  const out = await request(`dispatch (function() error("\\1AD\\1" .. tostring(${expr}) .. "\\1AD\\1") end)()`);
  const parts = out.split(MARK);
  return parts.length >= 3 ? parts[parts.length - 2] : null;
}
const luaString = s => JSON.stringify(String(s)); // a JSON string literal is a valid Lua one for the text used here

// ---------- events ----------
const listeners = new Set();
const reloadHooks = new Set();
let events = null, retryTimer = null;
function connectEvents() {
  if (events || !available()) return;
  let buffer = "";
  const sock = events = net.connect(socketPath(".socket2.sock"));
  sock.setEncoding("utf8");
  sock.on("data", d => {
    buffer += d;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const sep = line.indexOf(">>");
      if (sep < 0) continue;
      const name = line.slice(0, sep), data = line.slice(sep + 2);
      if (name === "configreloaded") for (const fn of reloadHooks) try { fn(); } catch (e) { console.error("Hyprland reload hook:", e); }
      for (const fn of listeners) try { fn(name, data); } catch (e) { console.error("Hyprland event handler:", e); }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (events !== sock) return;
    events = null;
    // Hyprland restarted, or the socket hiccuped: listen again while anyone still is.
    if (listeners.size || reloadHooks.size) retryTimer = setTimeout(connectEvents, 1000);
  });
  sock.unref();
}
function disconnectIfIdle() {
  if (listeners.size || reloadHooks.size) return;
  clearTimeout(retryTimer);
  const s = events;
  events = null;
  s?.destroy();
}
function onEvent(fn) {
  listeners.add(fn);
  connectEvents();
  return () => { listeners.delete(fn); disconnectIfIdle(); };
}
// What Hyprland added at run time is gone once its config is reloaded (it is, on every save of it).
function onReload(fn) {
  reloadHooks.add(fn);
  connectEvents();
  return () => { reloadHooks.delete(fn); disconnectIfIdle(); };
}

// ---------- windows ----------
const activeWindow = () => json(requestSync(["-j", "activewindow"])) || null;
const activeWindowAsync = async () => json(await request("j/activewindow")) || null;
const clients = async () => json(await request("j/clients")) || [];
const focusWindow = address => lua(`hl.dispatch(hl.dsp.focus({ window = ${luaString(`address:${address}`)} }))`);

// Rules for windows of ours (a Lua table's fields as given), kept across config reloads.
function keepWindowRule(fields) {
  const apply = () => lua(`hl.window_rule(${fields})`).catch(e => console.error("Hyprland window rule:", e.message));
  apply();
  return onReload(apply);
}

module.exports = {
  available, signature, request, requestSync, lua, luaSync, query, luaString, json,
  onEvent, onReload, activeWindow, activeWindowAsync, clients, focusWindow, keepWindowRule
};
