// The phone app: picks the provider (the Demo's mock or the user's relay), runs the screens, and keeps the shell
// around them - the screen stack with the Android back button, the tab bar, the "waiting" banner, toasts,
// confirmations and the visual viewport (the soft keyboard) - and the link's lifecycle: connected on start, checked
// and made again when the app comes back to the foreground or the network changes.
import { App } from "@capacitor/app";
import { t, setLanguage, applyI18n, errorText } from "./i18n.js";
import { $, esc, buzz } from "./util.js";
import { icon } from "./icons.js";
import { createStore } from "./data.js";
import { createMockProvider } from "./mock.js";
import { createRelayProvider } from "./provider-relay.js";
import { keystore, lock, deviceModel } from "./keystore.js";
import { generateKeypair } from "../../src/mesh/noise.js";
import pkg from "../package.json";
import * as pairScreen from "./screens/pair.js";
import * as pairingScreen from "./screens/pairing.js";
import * as routesScreen from "./screens/routes.js";
import * as scanScreen from "./screens/scan.js";
import * as diagScreen from "./screens/diag.js";
import * as inboxScreen from "./screens/inbox.js";
import * as sessionScreen from "./screens/session.js";
import * as terminalScreen from "./screens/terminal.js";
import * as newScreen from "./screens/new-session.js";
import * as computersScreen from "./screens/computers.js";
import * as nodeScreen from "./screens/node.js";

const SCREENS = { pair: pairScreen, pairing: pairingScreen, routes: routesScreen, scan: scanScreen, diag: diagScreen, inbox: inboxScreen, session: sessionScreen, terminal: terminalScreen, new: newScreen, computers: computersScreen, node: nodeScreen };
const TABS = ["inbox", "new", "computers"];
const MODE_KEY = "agentdeck.mode"; // "demo" while the Demo is on
const META_KEY = "agentdeck.nodes"; // provider-relay.js meta: which nodes are relays, when each was last seen (not secret)

const app = $("#app");
let store = null;
let link = null; // the relay provider, once there is an identity (paired, or pairing)
let stack = []; // [{ name, params }]
let cleanup = null;

// ---------- the soft keyboard ----------
// The app is as tall as what is visible above the keyboard, so bottom bars (reply box, extra keys) sit right on it.
function trackViewport() {
  const vv = window.visualViewport;
  const set = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--vvh", `${Math.round(h)}px`);
    document.documentElement.classList.toggle("kb-open", window.innerHeight - h > 120 || (screen.height - h > 260 && document.activeElement?.matches?.("input, textarea")));
    if (vv) window.scrollTo(0, 0);
  };
  set();
  vv?.addEventListener("resize", set);
  vv?.addEventListener("scroll", set);
  window.addEventListener("resize", set);
  document.addEventListener("focusin", set);
  document.addEventListener("focusout", () => setTimeout(set, 50));
}

// ---------- toasts, confirmations, the banner ----------
let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
const fail = e => toast(t("toast.failed", { error: errorText(e) }));

// confirmSheet(text, okLabel, { danger, extra: [label] }) -> true | false | the extra button's index (2, 3, ...).
function confirmSheet(text, okLabel, { danger = false, extra = [] } = {}) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "sheet-backdrop";
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><p>${esc(text)}</p>
      <div class="sheet-actions"><button class="btn" data-v="0">${esc(t("common.cancel"))}</button>
      ${extra.map((label, i) => `<button class="btn" data-v="${i + 2}">${esc(label)}</button>`).join("")}
      <button class="btn ${danger ? "danger-solid" : "primary"}" data-v="1">${esc(okLabel)}</button></div></div>`;
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) done(b.dataset.v === "1" ? true : b.dataset.v === "0" ? false : Number(b.dataset.v));
      else if (e.target === el) done(false);
    });
    document.body.append(el);
    el.querySelector("[data-v='1']").focus();
  });
}

// promptSheet(title, value, okLabel) -> the text, or null when cancelled.
function promptSheet(title, value, okLabel) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "sheet-backdrop";
    el.innerHTML = `<form class="sheet" role="dialog" aria-modal="true"><p>${esc(title)}</p>
      <input class="sheet-input" maxlength="60" autocomplete="off" value="${esc(value)}">
      <div class="sheet-actions"><button class="btn" type="button" data-v="0">${esc(t("common.cancel"))}</button>
      <button class="btn primary" type="submit">${esc(okLabel)}</button></div></form>`;
    const input = el.querySelector("input");
    const done = v => { el.remove(); resolve(v); };
    el.querySelector("form").onsubmit = e => { e.preventDefault(); done(input.value.trim() || null); };
    el.querySelector("[data-v='0']").onclick = () => done(null);
    el.addEventListener("click", e => { if (e.target === el) done(null); });
    document.body.append(el);
    input.focus();
    input.select();
  });
}

let bannerTimer = 0;
function banner({ node, item }) {
  if (current()?.name === "session" && current().params.node === node && current().params.id === item.id) return;
  const el = $("#banner");
  el.innerHTML = `<button class="banner-in" aria-label="${esc(`${t("common.open")}: ${t("banner.waiting", { title: item.title })}`)}"><i class="mark dot st-waiting"></i><span class="banner-text"><b>${esc(t("banner.waiting", { title: item.title }))}</b>
    <small>${esc(item.nodeName)} · ${esc(item.project)}${item.waitingFor ? ` · ${esc(item.waitingFor)}` : ""}</small></span>${icon("right", "banner-go")}</button>`;
  el.hidden = false;
  el.classList.remove("in");
  void el.offsetWidth;
  el.classList.add("in");
  el.querySelector("button").onclick = () => { el.hidden = true; go("session", { node, agent: item.agent, id: item.id }); };
  buzz();
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 9000);
}

// ---------- screens ----------
const current = () => stack.at(-1);

function render() {
  const top = current();
  if (!top) return;
  cleanup?.();
  cleanup = null;
  const mod = SCREENS[top.name];
  const tabbed = TABS.includes(top.name);
  app.className = `screen-${top.name}${tabbed ? " tabbed" : ""}`;
  app.innerHTML = `<section class="screen"></section>${tabbed ? tabBar(top.name) : ""}`;
  const el = app.firstElementChild;
  cleanup = mod.render(el, ctx, top.params || {}) || null;
  applyI18n(app);
  if (tabbed) {
    for (const b of app.querySelectorAll(".tabbar [data-tab]")) b.onclick = () => go(b.dataset.tab, {}, { root: true });
  }
}
function tabBar(active) {
  const waiting = store ? store.inbox().waiting.length : 0;
  const tab = (name, ic, label) => `<button data-tab="${name}" class="${active === name ? "on" : ""}" aria-label="${esc(t(label))}"${active === name ? ' aria-current="page"' : ""}><span class="tab-ic">${icon(ic)}${name === "inbox" && waiting ? `<i class="badge">${waiting}</i>` : ""}</span><span>${esc(t(label))}</span></button>`;
  return `<nav class="tabbar">${tab("inbox", "inbox", "nav.inbox")}${tab("new", "plus", "nav.new")}${tab("computers", "computer", "nav.computers")}</nav>`;
}

// go(name, params, { replace, root }): root - a tab: the stack starts again from it.
function go(name, params = {}, { replace = false, root = false } = {}) {
  if (root) {
    stack = [{ name, params }];
    history.replaceState({ depth: 0 }, "");
  } else if (replace && stack.length) {
    stack[stack.length - 1] = { name, params };
  } else {
    stack.push({ name, params });
    history.pushState({ depth: stack.length - 1 }, "");
  }
  render();
}
function back() {
  if (stack.length > 1) history.back();
}
window.addEventListener("popstate", () => {
  if (stack.length > 1) { stack.pop(); render(); }
});

// ---------- the provider ----------
async function useProvider(provider) {
  store?.disconnect();
  store = createStore(provider);
  ctx.store = store;
  store.on("waiting", banner);
  // The tab bar's badge follows the waiting count.
  store.on("change", () => {
    const tab = app.querySelector(".tabbar [data-tab='inbox']");
    if (!tab) return;
    const n = store.inbox().waiting.length;
    let badge = tab.querySelector(".badge");
    if (!n) return badge?.remove();
    if (!badge) { badge = document.createElement("i"); badge.className = "badge"; (tab.querySelector(".tab-ic") || tab).append(badge); }
    badge.textContent = n;
  });
  await store.connect();
}

const toHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const fromHex = h => Uint8Array.from(String(h).match(/../g) || [], x => parseInt(x, 16));
function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || "{}") || {}; } catch { return {}; } }
function writeMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch {} }

// The relay provider over the phone's identity (made the first time) and its saved peers; the store runs on it.
// Saving is queued: the last list handed over is the one that stays.
async function relay() {
  if (link) return link;
  let id = await keystore.getIdentity();
  if (!id?.publicKey || !id?.privateKey) {
    const kp = generateKeypair();
    id = { publicKey: toHex(kp.publicKey), privateKey: toHex(kp.privateKey) };
    await keystore.setIdentity(id);
  }
  const name = (await keystore.getName()) || (await deviceModel()) || "Phone";
  let saving = Promise.resolve();
  link = createRelayProvider({
    keypair: { publicKey: fromHex(id.publicKey), privateKey: fromHex(id.privateKey) },
    peers: await keystore.getPeers(), name, version: pkg.version, meta: readMeta(),
    onPeersChanged: list => { saving = saving.then(() => keystore.setPeers(list)).catch(e => { console.error("saving the peers failed", e); fail(e); }); },
    onMetaChanged: writeMeta,
    log: line => console.log(`[mesh] ${line}`)
  });
  try { localStorage.removeItem(MODE_KEY); } catch {}
  await useProvider(link);
  return link;
}

async function startDemo() {
  try { localStorage.setItem(MODE_KEY, "demo"); } catch {}
  link?.stop();
  link = null;
  await useProvider(createMockProvider());
  go("inbox", {}, { root: true });
}
async function leaveDemo() {
  try { localStorage.removeItem(MODE_KEY); } catch {}
  store?.disconnect();
  store = null;
  ctx.store = null;
  if ((await keystore.getPeers()).length) {
    await relay();
    return go("inbox", {}, { root: true });
  }
  go("pair", {}, { root: true });
}
// Every computer that is online hears that it is forgotten; the identity and the list go.
async function unpair() {
  if (link) for (const n of link.nodes()) { try { await link.forget(n.id); } catch {} }
  store?.disconnect();
  store = null;
  ctx.store = null;
  link = null;
  await keystore.clear();
  try { localStorage.removeItem(MODE_KEY); localStorage.removeItem(META_KEY); } catch {}
  go("pair", {}, { root: true });
}
async function rename(name) {
  await keystore.setName(name);
  link?.setName(name);
}
async function phoneName() {
  return link?.name || (await keystore.getName()) || (await deviceModel()) || "Phone";
}

const ctx = { store: null, go, back, toast, fail, confirm: confirmSheet, prompt: promptSheet, startDemo, leaveDemo, unpair, relay, rename, phoneName, secure: () => keystore.secure };

// ---------- the lifecycle ----------
// The links do not survive the background reliably (and not at all on iOS): back in the foreground, or when the
// network comes back or changes, every link is checked and the dead ones made again at once. In the background
// nothing is dialled (it would only drain the battery until the system freezes the app); what is up stays up.
let wakeTimer = 0;
function wake() {
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { store?.wake(); }, 300);
}
function pause() {
  clearTimeout(wakeTimer);
  store?.pause();
}

// ---------- start ----------
async function boot() {
  setLanguage();
  trackViewport();
  document.body.classList.toggle("native", Boolean(window.Capacitor?.isNativePlatform?.()));
  await lock.unlock();
  App.addListener("backButton", () => {
    if ($(".sheet-backdrop")) return $(".sheet-backdrop").click();
    if (stack.length > 1) back();
    else App.minimizeApp();
  }).catch(() => {});
  App.addListener("resume", wake).catch(() => {});
  App.addListener("pause", pause).catch(() => {});
  App.addListener("appStateChange", s => { if (s?.isActive) wake(); else pause(); }).catch(() => {});
  // The network back or changed: only in the foreground (in the background it waits for resume).
  const netWake = () => { if (document.visibilityState === "visible") wake(); };
  window.addEventListener("online", netWake);
  navigator.connection?.addEventListener?.("change", netWake);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wake(); else pause(); });

  let mode = null;
  try { mode = localStorage.getItem(MODE_KEY); } catch {}
  if (mode === "demo") return startDemo();
  if ((await keystore.getPeers()).length) {
    await relay();
    return go("inbox", {}, { root: true });
  }
  go("pair", {}, { root: true });
}

boot().catch(e => {
  console.error(e);
  app.textContent = String(e?.stack || e);
});
