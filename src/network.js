// AgentDeck's connections to the cloud (Gemini, OpenAI) and to GitHub for updates, and the proxy they go through:
// the `network` key of settings.json. Main process only.
//
// Requests go through Chromium's network stack (Electron's net), not Node's fetch. Chromium follows the Windows
// proxy settings, automatic configuration (WPAD, a PAC script) included, signs in to a proxy with the Windows account
// (NTLM, Kerberos) by itself, and trusts the certificates Windows trusts - a TLS-inspecting proxy's too. Node's fetch
// does none of that.
//
// Modes: "system" (the default: whatever Windows uses), "pac" (a configuration script at pacUrl), "manual" (one proxy
// and a bypass list) and "direct". They apply to the default session, which the requests below use, and to
// electron-updater's own session.
//
// A proxy that wants a user name and password (Basic, Digest; NTLM when the Windows sign-in is not accepted) gets the
// saved ones, once per request: asked again, it has refused them, and the request fails as "rejected" instead of
// asking forever. net.fetch cannot answer such a challenge (it cancels it), so fetch() below is a small fetch over
// net.request, which can. The password is kept like the API keys - safeStorage (DPAPI) ciphertext, base64, in
// passwordEnc - and never goes to a page.
const { net, session, safeStorage } = require("electron");
const settings = require("./voice/settings");
const { isObj } = require("./voice/util");
const { t } = require("./i18n");

const MODES = ["system", "pac", "manual", "direct"];
const defaults = Object.freeze({ mode: "system", pacUrl: "", proxy: "", bypass: "<local>", username: "", terminals: false });
// electron-updater's partition and options (electron-updater/out/electronHttpExecutor.js): whichever side asks
// first creates the session, so both must ask for the same one.
const UPDATER_PARTITION = "electron-updater";
// Gemini's API host: what the connection test asks, and what a terminal's proxy is resolved for.
const PROBE_URL = "https://generativelanguage.googleapis.com/";
const TEST_PARTITION = "agentdeck-network-test"; // in memory; the test never touches the sessions in use
const TEST_TIMEOUT_MS = 20_000;
// A second challenge this soon after an answer means the answer was refused.
const ASKED_AGAIN_MS = 10_000;
// Always direct in Chromium (and so in the terminals too): this machine itself.
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

let current = { ...defaults, passwordEnc: "" };
let applied = Promise.resolve(); // the saved settings, once in effect

// ---------- settings ----------
const str = (v, max) => (typeof v === "string" && v.length <= max ? v.trim() : null);
const CONTROL = /[\u0000-\u001f\u007f]/;

function normalize(v) {
  v = isObj(v) ? v : {};
  const text = (k, max) => str(v[k], max) ?? defaults[k];
  return {
    mode: MODES.includes(v.mode) ? v.mode : defaults.mode,
    pacUrl: text("pacUrl", 2048), proxy: text("proxy", 2048), bypass: text("bypass", 2048), username: text("username", 256),
    terminals: v.terminals === true,
    passwordEnc: typeof v.passwordEnc === "string" ? v.passwordEnc : ""
  };
}

// "proxy.corp:8080", "http://proxy.corp:8080", "socks5://10.0.0.1:1080" -> {value: "http://proxy.corp:8080"} etc., the
// form Chromium's proxy rules take; {credentials: true} when a user name is in it; null when it is no proxy address.
function parseProxy(value) {
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`); } catch { return null; }
  if (!["http:", "https:", "socks:", "socks4:", "socks5:"].includes(u.protocol) || !u.hostname) return null;
  if (u.username || u.password) return { credentials: true };
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) return null;
  return { value: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}` };
}

// Chromium's bypass rules: "<local>", "*.corp.local", "10.0.0.0/8", "[::1]:8080"... Windows separates them with
// semicolons, Chromium with commas; either is taken.
const BYPASS_RULE = /^[\w.*\-:[\]/<>]+$/;
const bypassRules = value => value.split(/[,;\s]+/).filter(Boolean);

// Everything a page sends is checked here. -> { value, password: {set} | {clear} | null, errors | null }. A field the
// chosen mode does not use cannot show an error: it is kept as typed when empty or valid, as saved when not.
function validate(p) {
  if (!isObj(p) || !MODES.includes(p.mode)) return { errors: { "net.form": t("errors.invalidData") } };
  const mode = p.mode, errors = {};
  const value = { mode, terminals: p.terminals === true };
  const field = (key, used, check) => {
    const raw = str(p[key] ?? "", 2048);
    const r = raw === null ? { error: `settings.network.err.${key}` } : !raw && !used ? { value: "" } : check(raw);
    if (!r.error) value[key] = r.value;
    else if (used) errors[`net.${key}`] = t(r.error);
    else value[key] = current[key];
  };
  field("pacUrl", mode === "pac", v => {
    if (!v) return { error: "settings.network.err.pacUrlEmpty" };
    let ok = false;
    try { ok = ["http:", "https:", "file:"].includes(new URL(v).protocol); } catch {}
    return ok ? { value: v } : { error: "settings.network.err.pacUrl" };
  });
  field("proxy", mode === "manual", v => {
    if (!v) return { error: "settings.network.err.proxyEmpty" };
    const parsed = parseProxy(v);
    if (parsed?.value) return parsed;
    return { error: parsed?.credentials ? "settings.network.err.proxyCredentials" : "settings.network.err.proxy" };
  });
  field("bypass", mode === "manual", v => {
    const rules = bypassRules(v);
    return rules.every(r => BYPASS_RULE.test(r)) ? { value: rules.join(", ") } : { error: "settings.network.err.bypass" };
  });
  field("username", mode !== "direct", v => (v.length > 256 || CONTROL.test(v) ? { error: "settings.network.err.username" } : { value: v }));

  // {set: "..."} replaces, {clear: true} removes, absent keeps whatever is saved. Not trimmed: a space may be part of it.
  let password = null;
  const pw = isObj(p.password) ? p.password : {};
  if (pw.clear === true) password = { clear: true };
  else if (typeof pw.set === "string" && pw.set) {
    if (pw.set.length <= 256 && !CONTROL.test(pw.set)) password = { set: pw.set };
    else if (mode !== "direct") errors["net.password"] = t("settings.network.err.password");
  }
  return { value, password, errors: Object.keys(errors).length ? errors : null };
}

// What the Settings page sees: everything but the password itself.
const state = () => {
  const { passwordEnc, ...rest } = current;
  return { ...rest, hasPassword: Boolean(passwordEnc) };
};

function proxyConfig(s) {
  switch (s.mode) {
    case "direct": return { mode: "direct" };
    case "pac": return { mode: "pac_script", pacScript: s.pacUrl };
    case "manual": return { mode: "fixed_servers", proxyRules: s.proxy, proxyBypassRules: s.bypass };
    default: return { mode: "system" };
  }
}

// Connections already open keep the route they were opened on, and the sign-in cache answers for the old proxy: both
// go first (closing them afterwards would also kill the download of a new PAC script). A PAC script is then fetched
// afresh even when its address did not change - it may have been down the last time.
async function configure(ses, config) {
  await ses.closeAllConnections();
  await ses.clearAuthCache();
  await ses.setProxy(config);
  await ses.forceReloadProxyConfig();
}

const sessions = () => [session.defaultSession, session.fromPartition(UPDATER_PARTITION, { cache: false })];
let generation = 0; // settings put in effect so far: a new proxy or sign-in starts the asking afresh
function apply(s) {
  generation++;
  return Promise.all(sessions().map(ses => configure(ses, proxyConfig(s))));
}

async function encrypt(text) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(t("voice.errors.encryptionUnavailable"));
  return (await safeStorage.encryptStringAsync(text)).toString("base64");
}

async function savedPassword() {
  const enc = current.passwordEnc;
  if (!enc) return "";
  const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, "base64"));
  // The key store has rotated its key: stored again under the new one, unless the password changed meanwhile.
  if (shouldReEncrypt) encrypt(result).then(next => { if (current.passwordEnc === enc) return persist({ ...current, passwordEnc: next }); }).catch(() => {});
  return result;
}

// The saved sign-in, or null when there is none to give.
async function credentials() {
  if (!current.username) return null;
  return { username: current.username, password: await savedPassword() };
}

const persist = next => { current = next; return settings.writeRoot({ network: next }); };

// After app "ready". Reads the saved settings and puts them in effect; requests made meanwhile wait for that.
function start() {
  let root = {};
  try { root = settings.readRoot(); } catch (e) { console.error("Could not read the network settings:", e.message); }
  current = normalize(root.network);
  applied = apply(current).catch(e => console.error("Could not apply the proxy settings:", e.message));
  return applied;
}

// -> {ok: true, state, warnings} once in effect (and on disk, or a warning saying it is not), or {ok: false, errors}.
async function save(payload) {
  const { value, password, errors } = validate(payload);
  if (errors) return { ok: false, errors };
  let passwordEnc = current.passwordEnc;
  try {
    if (!value.username || password?.clear) passwordEnc = ""; // no user name, no use for a password
    else if (password?.set) passwordEnc = await encrypt(password.set);
  } catch (e) {
    return { ok: false, errors: { "net.password": t("settings.network.err.passwordNotSaved", { error: e.message }) } };
  }
  const warnings = {};
  const written = persist({ ...value, passwordEnc }).catch(e => { warnings["net.form"] = t("voice.settings.err.notWritten", { error: e.message }); });
  await (applied = apply(current).catch(e => { warnings["net.form"] = e.message; }));
  await written;
  return { ok: true, state: state(), warnings };
}

// ---------- proxy sign-in ----------
// A 'login' listener for net.request or electron-updater (which keeps one for all its requests). state.outcome:
// "answered", "required" (nothing saved to answer with) or "rejected" (asked again right after an answer, with the
// same settings in effect). A website's own sign-in is never answered.
function loginHandler(getCredentials = credentials) {
  const state = { outcome: null, answeredAt: 0, generation };
  const handler = (authInfo, callback) => {
    if (!authInfo?.isProxy) { callback(); return; }
    Promise.resolve().then(getCredentials).then(c => {
      if (state.generation !== generation) Object.assign(state, { answeredAt: 0, generation });
      if (!c) state.outcome = "required";
      else if (Date.now() - state.answeredAt < ASKED_AGAIN_MS) state.outcome = "rejected";
      else {
        state.outcome = "answered";
        state.answeredAt = Date.now();
        callback(c.username, c.password);
        return;
      }
      callback();
    }, () => { state.outcome = "required"; callback(); });
  };
  handler.state = state;
  return handler;
}

// Chromium reports a proxy sign-in it did not get as a failed tunnel - as it does a proxy that refuses the
// destination. The login handler knows which it was.
const SIGN_IN_FAILED = /\bnet::ERR_(TUNNEL_CONNECTION_FAILED|PROXY_AUTH_REQUESTED(_WITH_NO_CONNECTION)?)\b/;
function proxyAuthError(outcome, cause) {
  const rejected = outcome === "rejected";
  return Object.assign(
    new Error(rejected ? "The proxy rejected the user name and password" : "The proxy asks for a user name and password", cause ? { cause } : undefined),
    { code: rejected ? "PROXY_AUTH_REJECTED" : "PROXY_AUTH_REQUIRED" });
}
const explain = (error, login) => {
  const outcome = login.state.outcome;
  return outcome && outcome !== "answered" && SIGN_IN_FAILED.test(error?.message) ? proxyAuthError(outcome, error) : error;
};

// ---------- requests ----------
// Header values must be byte strings; Chromium hands over UTF-8 as is.
const byteString = v => (/[^\x00-\xff]/.test(v) ? Buffer.from(v, "utf8").toString("latin1") : v);

// fetch(url, {method, headers, body, signal}) -> Response, over net.request: the body streams (pull-driven, so a
// slow reader holds the download back), and `signal` aborts before or during it with its reason - as Node's fetch
// does, which keeps "cancelled" and "timed out" apart. A FormData body is sent as the multipart bytes Node's fetch
// would send, with a Content-Length. Failures are Chromium's Error("net::ERR_..."), or PROXY_AUTH_REQUIRED /
// PROXY_AUTH_REJECTED (code) when the proxy wanted a sign-in.
async function request(url, { method = "GET", headers, body = null, signal, session: ses = session.defaultSession, login = loginHandler() } = {}) {
  const head = new Headers(headers);
  if (body instanceof FormData) {
    const encoded = new Response(body);
    head.set("content-type", encoded.headers.get("content-type"));
    body = Buffer.from(await encoded.arrayBuffer());
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method, session: ses, cache: "no-store" });
    for (const [k, v] of head) req.setHeader(k, v);
    let controller = null; // the response body's, once there is one
    let settled = false;
    const finish = () => { settled = true; signal?.removeEventListener("abort", onAbort); };
    const fail = error => {
      if (settled) return;
      finish();
      if (controller) controller.error(error);
      else reject(error);
    };
    function onAbort() { fail(signal.reason); req.abort(); }
    signal?.addEventListener("abort", onAbort, { once: true });

    req.on("login", login);
    req.on("error", e => fail(explain(e, login)));
    req.on("response", res => {
      try {
        // Only a plain-http request ever sees the proxy's own 407; it is a failed sign-in all the same.
        if (res.statusCode === 407) { fail(proxyAuthError(login.state.outcome === "rejected" ? "rejected" : "required")); req.abort(); return; }
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) for (const x of [].concat(v)) out.append(k, byteString(String(x)));
        let stream = null;
        if ([204, 205, 304].includes(res.statusCode) || method === "HEAD") { finish(); res.resume(); }
        else stream = new ReadableStream({
          start(c) {
            controller = c;
            res.on("data", chunk => {
              if (settled) return;
              c.enqueue(new Uint8Array(chunk));
              if (c.desiredSize <= 0) res.pause();
            });
            res.on("end", () => { if (!settled) { finish(); c.close(); } });
            res.on("error", e => fail(explain(e, login)));
          },
          pull() { res.resume(); },
          cancel() { if (!settled) finish(); req.abort(); }
        });
        resolve(new Response(stream, { status: res.statusCode, statusText: res.statusMessage, headers: out }));
      } catch (e) { fail(e); req.abort(); }
    });
    if (body != null) req.write(typeof body === "string" ? body : Buffer.from(body));
    req.end();
  });
}

// The app's requests: the saved proxy settings and sign-in.
async function fetch(url, init = {}) {
  await applied;
  return request(url, { ...init, login: loginHandler() });
}

// Asks Gemini's API host with the settings as entered (`payload` as for save(); an empty password field means the
// saved password). Any HTTP answer counts as reachable. -> {errors} | {reachable: true, status, ms, route} |
// {reachable: false, error, route}; route is what Chromium resolved for the address ("PROXY host:port; DIRECT",
// "" when the proxy configuration itself failed).
async function test(payload) {
  const { value, password, errors } = validate(payload);
  if (errors) return { errors };
  const ses = session.fromPartition(TEST_PARTITION);
  await configure(ses, proxyConfig(value));
  const route = await ses.resolveProxy(PROBE_URL).catch(() => "");
  const signIn = async () => {
    if (value.mode === "direct" || !value.username) return null;
    const pw = password?.set ?? (password?.clear || value.username !== current.username ? "" : await savedPassword());
    return { username: value.username, password: pw };
  };
  const started = performance.now();
  try {
    const res = await request(PROBE_URL, { session: ses, signal: AbortSignal.timeout(TEST_TIMEOUT_MS), login: loginHandler(signIn) });
    const ms = Math.round(performance.now() - started);
    res.body?.cancel().catch(() => {});
    return { reachable: true, status: res.status, ms, route };
  } catch (error) {
    return { reachable: false, error, route };
  }
}

// ---------- terminals ----------
// "PROXY host:port; DIRECT" -> the first proxy as a URL; null when that is DIRECT or SOCKS (which HTTPS_PROXY & co.
// mostly cannot use).
function firstProxy(route) {
  const [kind, hostPort] = String(route || "").split(";")[0].trim().split(/\s+/);
  if (!hostPort) return null;
  if (kind === "PROXY") return `http://${hostPort}`;
  if (kind === "HTTPS") return `https://${hostPort}`;
  return null;
}

// NO_PROXY as most tools read it: comma-separated host suffixes ("*.corp" -> ".corp"), and loopback, which Chromium
// never proxies either. "<local>" (names without a dot) has no NO_PROXY equivalent.
function noProxy(s) {
  const rules = s.mode === "manual" ? bypassRules(s.bypass).filter(r => !/^<.*>$/.test(r)).map(r => r.replace(/^\*\./, ".")) : [];
  return [...new Set([...LOOPBACK, ...rules])].join(",");
}

// The proxy the terminals AgentDeck opens get, as {url, noProxy} for HTTPS_PROXY, HTTP_PROXY and NO_PROXY - the URL
// with the saved sign-in in it, URL-encoded. null when they should keep their environment as it is: the option is
// off, or the connection is direct.
async function terminalProxy() {
  const s = current;
  if (!s.terminals || s.mode === "direct") return null;
  await applied;
  const server = s.mode === "manual" ? s.proxy : firstProxy(await session.defaultSession.resolveProxy(PROBE_URL));
  if (!server || /^socks/i.test(server)) return null;
  const c = await credentials().catch(() => null);
  const [, scheme, hostPort] = /^([a-z0-9]+:\/\/)(.*)$/i.exec(server);
  const auth = c ? `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@` : "";
  return { url: `${scheme}${auth}${hostPort}`, noProxy: noProxy(s) };
}

module.exports = { start, state, save, test, fetch, loginHandler, terminalProxy, validate };
