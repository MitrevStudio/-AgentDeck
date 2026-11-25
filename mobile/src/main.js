// The phone app: starts the provider (the user's relay), runs the screens, and keeps the shell
// around them - the screen stack with the Android back button (on an iPhone: a swipe from the left edge), the tab bar, the "waiting" banner, toasts,
// confirmations and the visual viewport (the soft keyboard) - and the link's lifecycle: connected on start, checked
// and made again when the app comes back to the foreground or the network changes.
import { App } from "@capacitor/app";
import { t, setLanguage, applyI18n, errorText } from "./i18n.js";
import { $, esc, buzz } from "./util.js";
import { icon, iconBtn } from "./icons.js";
import { createStore } from "./data.js";
import { createRelayProvider } from "./provider-relay.js";
import { createForwards } from "./forward.js";
import { nativeForward } from "./forward-native.js";
import { keystore, lock, deviceModel } from "./keystore.js";
import { isIos, setupPhone } from "./phone.js";
import { generateKeypair } from "../../src/mesh/noise.js";
import { checkOffer, takeOffer, bytesText } from "./files.js";
import { nativeFiles } from "./files-native.js";
import pkg from "../package.json";
import { openSession } from "./screens/parts.js";
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
import * as filesScreen from "./screens/files.js";

const SCREENS = { pair: pairScreen, pairing: pairingScreen, routes: routesScreen, scan: scanScreen, diag: diagScreen, inbox: inboxScreen, session: sessionScreen, terminal: terminalScreen, files: filesScreen, new: newScreen, computers: computersScreen, node: nodeScreen };
const TABS = ["inbox", "new", "computers"];
const META_KEY = "agentdeck.nodes"; // provider-relay.js meta: which nodes are relays, when each was last seen (not secret)

const app = $("#app");
let store = null;
let link = null; // the relay provider, once there is an identity (paired, or pairing)
let forwards = null; // the forwarded ports over that provider (forward.js)
let offOffers = null; // stops listening for files the computers send (offerHeard)
let stack = []; // [{ name, params, scroll }]
let cleanup = null;
let shown = null; // the stack entry on the screen now
const tabScroll = new Map(); // a tab's name -> how far its list was scrolled when it was left

// ---------- the soft keyboard ----------
// The app is as tall as what is visible above the keyboard, so bottom bars (reply box, extra keys) sit right on it.
// Android's WebView makes the page itself that tall (interactive-widget=resizes-content). An iPhone's does not: the
// page keeps its height, the keyboard covers its lower part and the view is moved up over it - so there the app is
// also put where the visible part begins (--vvt), and the heights the stylesheet asks about with max-height (a
// phone on its side with the keyboard up) are classes (.vv-low, .vv-tiny), since the media query sees the page.
// A field that took the keyboard is brought into what is left of its list, which Android does by itself.
function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  let last = 0;
  const set = () => {
    const h = vv ? vv.height : window.innerHeight;
    root.style.setProperty("--vvh", `${Math.round(h)}px`);
    root.classList.toggle("kb-open", window.innerHeight - h > 120 || (screen.height - h > 260 && document.activeElement?.matches?.("input, textarea")));
    if (vv) window.scrollTo(0, 0);
    if (isIos && vv) {
      root.style.setProperty("--vvt", `${Math.max(0, Math.round(vv.offsetTop))}px`);
      root.classList.toggle("vv-low", h <= 300);
      root.classList.toggle("vv-tiny", h <= 200);
      const field = document.activeElement;
      if (h < last - 100 && field?.matches?.("input, textarea") && field.closest(".body")) requestAnimationFrame(() => field.scrollIntoView({ block: "center" }));
      last = h;
    }
  };
  set();
  vv?.addEventListener("resize", set);
  vv?.addEventListener("scroll", set);
  window.addEventListener("resize", set);
  document.addEventListener("focusin", set);
  document.addEventListener("focusout", () => setTimeout(set, 50));
}

// ---------- toasts, confirmations, the banner ----------
// A toast stays as long as its text takes to read (a screen reader says it: role="status"); a failure at least 5 s.
let toastTimer = 0;
function toast(text, least = 2600) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.min(9000, Math.max(least, 1200 + 55 * String(text).length)));
}
const fail = e => toast(t("toast.failed", { error: errorText(e) }), 5000);

// A sheet is a dialog: named by its text, Escape cancels it, and Tab stays among its own fields and buttons.
let sheets = 0;
function sheetKeys(el, cancel) {
  const p = el.querySelector("p");
  if (p) {
    p.id = `sheet-text-${++sheets}`;
    el.querySelector("[role='dialog']").setAttribute("aria-labelledby", p.id);
  }
  el.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); return cancel(); }
    if (e.key !== "Tab") return;
    const stops = [...el.querySelectorAll("button, input, textarea")].filter(x => !x.disabled);
    const first = stops[0], last = stops.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}

// confirmSheet(text, okLabel, { danger, extra: [label], cancelLabel, cls }) -> true | false | the extra button's index
// (2, 3, ...). cls: a class of the backdrop's own (what it is, for a test).
function confirmSheet(text, okLabel, { danger = false, extra = [], cancelLabel = t("common.cancel"), cls = "" } = {}) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = `sheet-backdrop${cls ? ` ${cls}` : ""}`;
    el.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><p>${esc(text)}</p>
      <div class="sheet-actions"><button class="btn" data-v="0">${esc(cancelLabel)}</button>
      ${extra.map((label, i) => `<button class="btn" data-v="${i + 2}">${esc(label)}</button>`).join("")}
      <button class="btn ${danger ? "danger-solid" : "primary"}" data-v="1">${esc(okLabel)}</button></div></div>`;
    const focusOn = danger ? "0" : "1"; // a hardware Enter never confirms what cannot be undone
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener("click", e => {
      const b = e.target.closest("button");
      if (b) done(b.dataset.v === "1" ? true : b.dataset.v === "0" ? false : Number(b.dataset.v));
      else if (e.target === el) done(false);
    });
    sheetKeys(el, () => done(false));
    document.body.append(el);
    el.querySelector(`[data-v='${focusOn}']`).focus();
  });
}

// menuSheet(items) -> the chosen item's key, or null: a list of things to do, each a row with its icon. An item is
// { key, icon, label, danger, on } - or { stepper: true, label, value(), minus(), plus(), minusLabel, plusLabel }, a
// row whose two buttons act at once and leave the sheet open (the text size).
function menuSheet(items) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "sheet-backdrop";
    el.innerHTML = `<div class="sheet menu" role="dialog" aria-modal="true" aria-label="${esc(t("term.more"))}">${items.map((it, i) => (it.stepper
      ? `<div class="menu-item menu-step" data-i="${i}">${icon("textSize")}<span class="menu-label">${esc(it.label)}</span>${iconBtn("minus", it.minusLabel, 'data-step="minus"')}<b class="menu-value">${esc(it.value())}</b>${iconBtn("plus", it.plusLabel, 'data-step="plus"')}</div>`
      : `<button class="menu-item${it.danger ? " danger" : ""}${it.on ? " on" : ""}" data-i="${i}">${icon(it.icon)}<span class="menu-label">${esc(it.label)}</span></button>`)).join("")}</div>`;
    const done = v => { el.remove(); resolve(v); };
    el.addEventListener("click", e => {
      const step = e.target.closest("[data-step]");
      if (step) {
        const row = step.closest("[data-i]"), it = items[row.dataset.i];
        it[step.dataset.step]();
        row.querySelector(".menu-value").textContent = it.value();
        return;
      }
      const b = e.target.closest("button.menu-item");
      if (b) done(items[b.dataset.i].key);
      else if (e.target === el) done(null);
    });
    sheetKeys(el, () => done(null));
    document.body.append(el);
    el.querySelector("button.menu-item")?.focus();
  });
}

// promptSheet(title, value, okLabel, { multiline, maxLength }) -> the text, or null when cancelled. multiline: a few
// lines of any length (text to paste into a terminal), kept as typed; else one line, trimmed, of at most maxLength
// characters (a name: 60; a file's name there: 255).
function promptSheet(title, value, okLabel, { multiline = false, maxLength = 60 } = {}) {
  return new Promise(resolve => {
    const el = document.createElement("div");
    el.className = "sheet-backdrop";
    el.innerHTML = `<form class="sheet" role="dialog" aria-modal="true"><p>${esc(title)}</p>
      ${multiline ? `<textarea class="sheet-input" rows="4" autocomplete="off" autocapitalize="off" spellcheck="false">${esc(value)}</textarea>`
        : `<input class="sheet-input" maxlength="${maxLength}" autocomplete="off" value="${esc(value)}">`}
      <div class="sheet-actions"><button class="btn" type="button" data-v="0">${esc(t("common.cancel"))}</button>
      <button class="btn primary" type="submit">${esc(okLabel)}</button></div></form>`;
    const input = el.querySelector(".sheet-input");
    const done = v => { el.remove(); resolve(v); };
    el.querySelector("form").onsubmit = e => { e.preventDefault(); done((multiline ? input.value : input.value.trim()) || null); };
    el.querySelector("[data-v='0']").onclick = () => done(null);
    el.addEventListener("click", e => { if (e.target === el) done(null); });
    sheetKeys(el, () => done(null));
    document.body.append(el);
    input.focus();
    input.select();
  });
}

let bannerTimer = 0;
function banner({ node, item }) {
  // Not over the session's own screen, nor over its terminal (the header there says what it waits for).
  const top = current();
  if (top?.name === "session" && top.params.node === node && top.params.id === item.id) return;
  if (top?.name === "terminal" && top.params.node === node && item.term && top.params.term === item.term) return;
  const el = $("#banner");
  // The banner opens the session; its X puts it away (it lies over the header's tools). Over a terminal it goes
  // sooner: the header there is all the way out.
  el.innerHTML = `<div class="banner-in" role="alert"><button class="banner-open" aria-label="${esc(`${t("common.open")}: ${t("banner.waiting", { title: item.title })}`)}"><i class="mark dot st-waiting"></i><span class="banner-text"><b>${esc(t("banner.waiting", { title: item.title }))}</b>
    <small>${esc(item.nodeName)} · ${esc(item.project)}${item.waitingFor ? ` · ${esc(item.waitingFor)}` : ""}</small></span></button>${iconBtn("x", t("common.dismiss"), 'data-act="dismiss"')}</div>`;
  el.hidden = false;
  el.classList.remove("in");
  void el.offsetWidth;
  el.classList.add("in");
  el.querySelector(".banner-open").onclick = () => { el.hidden = true; openSession(ctx, node, item.agent, item.id); };
  el.querySelector("[data-act='dismiss']").onclick = () => { el.hidden = true; };
  buzz();
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, current()?.name === "terminal" ? 5000 : 9000);
}

// ---------- a file a computer sends (docs/FILES.md 3.6) ----------
// A paired computer offers one of its files ("files.offer"): the phone serves nothing, so the computer cannot put it
// here - the user is asked every time (else any paired computer could fill Downloads), whatever screen is open, naming
// the computer (by the link the offer came on, never by what it sent), the file and its size. Save pulls it with the
// Files screen's own download (files.js takeOffer) into Downloads, its progress and Stop in a bar of its own; Not now
// tells the computer so. Without the Files plugin (a browser, an app whose native part is older) Save says the app
// must be updated, and the computer hears that it failed. One prompt at a time and never over another sheet: an offer
// that comes meanwhile waits until that closes (the computer keeps it a couple of minutes). A save may run beside a
// transfer of the Files screen: two pieces on the link then, each at most 256 KB.
const offersWaiting = [];
let offerBusy = false, sheetWatch = null;
function offerHeard({ node, event, payload }) {
  if (event !== "files.offer" || !store) return;
  const offer = checkOffer(payload);
  if (!offer) return;
  if (offersWaiting.length >= 10) offersWaiting.shift();
  offersWaiting.push({ node, offer });
  nextOffer();
}
function nextOffer() {
  if (offerBusy || !offersWaiting.length) return;
  if ($(".sheet-backdrop")) {
    // Asked again once no sheet is open.
    sheetWatch ||= new MutationObserver(() => {
      if ($(".sheet-backdrop")) return;
      sheetWatch.disconnect();
      sheetWatch = null;
      nextOffer();
    });
    sheetWatch.observe(document.body, { childList: true });
    return;
  }
  offerBusy = true;
  const { node, offer } = offersWaiting.shift();
  askOffer(node, offer).catch(e => console.error("a file sent from a computer", e)).finally(() => { offerBusy = false; nextOffer(); });
}
async function askOffer(node, offer) {
  if (!store) return;
  const computer = store.nodeName(node), provider = store.provider;
  buzz();
  const save = (await confirmSheet(t("offer.ask", { computer, name: offer.name, size: bytesText(offer.size) }), t("offer.save"), { cancelLabel: t("offer.notNow"), cls: "offer-ask" })) === true;
  const plugin = nativeFiles();
  if (!save || !plugin) {
    try { await takeOffer({ provider, node, plugin, offer, save }); }
    catch (e) { if (e?.code === "needsApp") toast(t("offer.needsApp"), 6000); else fail(e); }
    return;
  }
  const stop = new AbortController();
  const bar = offerBar(t("offer.saving", { name: offer.name, computer }), () => stop.abort());
  try {
    const r = await takeOffer({ provider, node, plugin, offer, save, signal: stop.signal, onProgress: bar.progress });
    toast(t("files.downloaded", { name: r.shown }));
  } catch (e) {
    if (e?.code === "cancelled") toast(t("files.stopped"));
    else if (e?.code === "jobMissing") toast(t("offer.gone", { computer }), 5000);
    else fail(e);
  } finally { bar.close(); }
}
// The bar of a save under way: its name, how far, Stop. Above every screen, below the sheets.
function offerBar(label, onStop) {
  const el = document.createElement("div");
  el.className = "offer-task";
  el.setAttribute("role", "status");
  el.innerHTML = `<div class="task-text"><b></b><small></small><i class="task-bar"><i></i></i></div>
    <button class="btn sm" data-act="stop">${icon("stop")}<span>${esc(t("files.stop"))}</span></button>`;
  el.querySelector("b").textContent = label;
  el.querySelector("small").textContent = t("files.starting");
  el.querySelector("[data-act='stop']").onclick = onStop;
  document.body.append(el);
  return {
    progress: ({ bytes = 0, total = 0 }) => {
      el.querySelector("small").textContent = total ? `${t("files.progress", { done: bytesText(bytes), total: bytesText(total) })} · ${Math.floor((bytes / total) * 100)} %` : t("files.starting");
      el.querySelector(".task-bar > i").style.width = total ? `${Math.min(100, (bytes / total) * 100)}%` : "0";
    },
    close: () => el.remove()
  };
}

// ---------- screens ----------
const current = () => stack.at(-1);

function render() {
  const top = current();
  if (!top) return;
  // Where the list being left was scrolled to: it is there again when the user comes back to it.
  if (shown) {
    shown.scroll = app.querySelector(".body")?.scrollTop || 0;
    if (TABS.includes(shown.name)) tabScroll.set(shown.name, shown.scroll);
  }
  cleanup?.();
  cleanup = null;
  const mod = SCREENS[top.name];
  const tabbed = TABS.includes(top.name);
  app.className = `screen-${top.name}${tabbed ? " tabbed" : ""}`;
  app.innerHTML = `<section class="screen"></section>${tabbed ? tabBar(top.name) : ""}`;
  const el = app.firstElementChild;
  cleanup = mod.render(el, ctx, top.params || {}) || null;
  applyI18n(app);
  shown = top;
  const body = app.querySelector(".body");
  if (body && top.scroll) body.scrollTop = top.scroll;
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
    // A tab is where it was left; pressed again while it shows, it goes to its top.
    const again = stack.length === 1 && current().name === name;
    if (again) shown = null;
    stack = [{ name, params, scroll: again ? 0 : tabScroll.get(name) || 0 }];
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
  if (stack.length <= 1) return;
  // A swipe back on an iPhone with a sheet open (the Android back button is told below): the sheet goes, the screen
  // stays - its place in the history is taken again.
  const sheet = $(".sheet-backdrop");
  if (sheet) { history.pushState({ depth: stack.length - 1 }, ""); sheet.click(); return; }
  stack.pop();
  render();
});

// ---------- the provider ----------
async function useProvider(provider) {
  store?.disconnect();
  store = createStore(provider);
  ctx.store = store;
  // Forwarded ports (docs/PORT-FORWARDING.md 4): on the provider itself, beside the store. Without the app's Forward
  // plugin (a browser) `available` is false and no screen offers them. A forward goes with the link to its computer:
  // the page's view was closed with it, and the user is told why.
  forwards?.dispose();
  forwards = createForwards({ provider, plugin: nativeForward() });
  ctx.forwards = forwards;
  forwards.on("lost", ({ node }) => toast(t("ports.lost", { name: store?.nodeName(node) || "" }), 5000));
  store.on("waiting", banner);
  // A file a computer sends: asked whatever screen is open (on the provider: the store has no word for it).
  offOffers?.();
  offOffers = provider.on("notify", offerHeard);
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
  const name = (await keystore.getName()) || (await deviceModel()) || t("phone.name");
  let saving = Promise.resolve();
  link = createRelayProvider({
    keypair: { publicKey: fromHex(id.publicKey), privateKey: fromHex(id.privateKey) },
    peers: await keystore.getPeers(), name, version: pkg.version, meta: readMeta(),
    onPeersChanged: list => { saving = saving.then(() => keystore.setPeers(list)).catch(e => { console.error("saving the peers failed", e); fail(e); }); },
    onMetaChanged: writeMeta,
    log: line => console.log(`[mesh] ${line}`)
  });
  await useProvider(link);
  return link;
}

// Every computer that is online hears that it is forgotten; the identity and the list go.
async function unpair() {
  if (link) for (const n of link.nodes()) { try { await link.forget(n.id); } catch {} }
  forwards?.dispose();
  forwards = null;
  ctx.forwards = null;
  offOffers?.();
  offOffers = null;
  store?.disconnect();
  store = null;
  ctx.store = null;
  link = null;
  await keystore.clear();
  try { localStorage.removeItem(META_KEY); } catch {}
  go("pair", {}, { root: true });
}
async function rename(name) {
  await keystore.setName(name);
  link?.setName(name);
}
async function phoneName() {
  return link?.name || (await keystore.getName()) || (await deviceModel()) || t("phone.name");
}

const ctx = { store: null, forwards: null, go, back, toast, fail, confirm: confirmSheet, prompt: promptSheet, menu: menuSheet, unpair, relay, rename, phoneName, secure: () => keystore.secure, version: pkg.version };

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
  setupPhone();
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

  if ((await keystore.getPeers()).length) {
    await relay();
    return go("inbox", {}, { root: true });
  }
  go("pair", {}, { root: true });
}

// The app could not start (the secure storage, most likely): said in words, the details in the console.
boot().catch(e => {
  console.error(e);
  app.innerHTML = `<div class="boot"><p class="empty" role="alert">${esc(t("boot.failed"))}<br><span class="small">${esc(errorText(e))}</span></p></div>`;
});
