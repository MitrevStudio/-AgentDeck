// Every failure a transcription or speech attempt can produce, classified once so the tray, the overlay and
// the retry logic all describe it the same way. Port of VoiceTray's TranscriptionException.
//
// `kind` is one of KINDS. `retryable` means repeating the exact same request could plausibly succeed. The messages are
// in the UI language of the moment they are made (a failed record keeps them in that language).
const { t } = require("../i18n");

const KINDS = [
  "Unknown", "Network", "Timeout", "RateLimited", "ServerError", "QuotaExhausted", "Auth", "BadRequest",
  "ModelNotFound", "PayloadTooLarge", "Configuration", "AudioUnreadable", "MalformedResponse", "Cancelled"
];

class VoiceError extends Error {
  constructor(kind, shortMessage, longMessage, { retryable = false, status = null, retryAfterMs = null, providerCode = null, cause } = {}) {
    super(longMessage, cause ? { cause } : undefined);
    this.name = "VoiceError";
    this.kind = kind;
    this.shortMessage = shortMessage;
    this.longMessage = longMessage;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.providerCode = providerCode;
  }
}

const configuration = message => new VoiceError("Configuration", t("voice.errors.notConfigured"), message);
const tooLarge = message => new VoiceError("PayloadTooLarge", t("voice.errors.tooLarge.short"), message);

// Both providers answer {"error":{"message","code","status"}}; Gemini puts the useful code in error.details[].reason.
function parseErrorBody(body) {
  let root;
  try { root = JSON.parse(body); } catch { return {}; }
  if (Array.isArray(root)) root = root[0]; // a streamed request (TTS) is answered with a one-element array
  const error = root && typeof root === "object" ? root.error : undefined;
  if (typeof error === "string") return { message: error };
  if (!error || typeof error !== "object") return {};
  const str = v => (typeof v === "string" ? v : undefined);
  let code = str(error.code);
  if (code === undefined && Array.isArray(error.details)) code = error.details.map(d => str(d?.reason)).find(Boolean);
  if (code === undefined) code = str(error.status);
  return { message: str(error.message), code };
}

// Gemini reports per-minute limits and daily caps alike as RESOURCE_EXHAUSTED; only the daily ones mean "stop trying".
const isQuotaExhausted = (code, body) =>
  String(code || "").toLowerCase() === "insufficient_quota" || /perday|per day/i.test(body);

function classifyResponse({ status, statusText = "", body = "", provider, retryAfterMs = null }) {
  body = String(body ?? "");
  const { message: providerMessage, code: providerCode } = parseErrorBody(body);

  // The proxy itself wants a sign-in (it usually says so with a page of its own).
  if (status === 407) {
    return new VoiceError("Network", t("voice.errors.proxy.short"), t("voice.errors.proxy.authRequired", { provider }), { status });
  }
  // A proxy or captive portal answering with HTML means we never reached the API.
  if (providerMessage == null && body.trimStart().startsWith("<")) {
    return new VoiceError("MalformedResponse", t("voice.errors.malformed.short"), t("voice.errors.malformed.html", { provider, status }),
      { retryable: true, status });
  }

  // The hint is ours; what the provider said, if anything, follows in a paragraph of its own.
  const make = (kind, shortMessage, hint, retryable) => new VoiceError(kind, shortMessage,
    providerMessage && providerMessage.trim() ? `${hint}\n\n${t("voice.errors.providerSays", { provider, message: providerMessage })}` : hint,
    { retryable, status, retryAfterMs, providerCode: providerCode ?? null });
  const invalidKey = () => make("Auth", t("voice.errors.auth.short"), t("voice.errors.auth.long", { provider }), false);

  switch (status) {
    case 401: return invalidKey();
    case 403: return make("Auth", t("voice.errors.forbidden.short"), t("voice.errors.forbidden.long", { provider }), false);
    case 404: return make("ModelNotFound", t("voice.errors.modelNotFound.short"), t("voice.errors.modelNotFound.long", { provider }), false);
    case 413: return make("PayloadTooLarge", t("voice.errors.tooLarge.short"), t("voice.errors.tooLarge.long", { provider }), false);
    case 408: return make("Timeout", t("voice.errors.timeout.short"), t("voice.errors.timeout.upload", { provider }), true);
    case 429: {
      if (isQuotaExhausted(providerCode, body)) {
        return make("QuotaExhausted", t("voice.errors.quota.short"), t("voice.errors.quota.long", { provider }), false);
      }
      const hint = retryAfterMs > 0
        ? t("voice.errors.rateLimited.after", { provider, seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) })
        : t("voice.errors.rateLimited.long", { provider });
      return make("RateLimited", t("voice.errors.rateLimited.short"), hint, true);
    }
    case 400:
    case 422:
      // Gemini answers 400 (not 401) with API_KEY_INVALID when the key is wrong.
      if (String(providerCode || "").toUpperCase() === "API_KEY_INVALID") return invalidKey();
      return make("BadRequest", t("voice.errors.badRequest.short", { status }), t("voice.errors.badRequest.long", { provider }), false);
    default:
      if (status >= 500) {
        return make("ServerError", t("voice.errors.server.short", { status }), t("voice.errors.server.long", { provider, status }), true);
      }
      return make("Unknown", statusText.trim() ? `${status} ${statusText}` : t("voice.errors.unexpected.short"),
        t("voice.errors.unexpected.reply", { provider, status }), false);
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const NAME_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"]);
const CONNECT_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT"]);
const isTlsCode = code => /^ERR_(TLS|SSL)_|CERT|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code);
// Only these say anything about the connection: system errors (ECONNRESET, EAI_AGAIN...), undici's own and TLS.
// Node's ERR_* codes (ERR_INVALID_ARG_TYPE...) are bugs, and retrying a bug does not help.
const isNetworkCode = code => /^E(?!RR_)[A-Z0-9_]+$/.test(code) || code.startsWith("UND_ERR_") || isTlsCode(code);

// The network error code behind a failed fetch: undici wraps it in `cause`, sometimes inside an AggregateError.
function errorCode(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    const codes = [e.code, ...(Array.isArray(e.errors) ? e.errors.map(x => x?.code) : [])];
    const hit = codes.find(c => typeof c === "string" && isNetworkCode(c));
    if (hit) return hit;
  }
  return "";
}

// Chromium's network stack (Electron's net, ../network.js) fails with a bare Error("net::ERR_..."); network.js adds
// PROXY_AUTH_REQUIRED / PROXY_AUTH_REJECTED (as `code`) when the proxy wanted a sign-in it did not get.
function chromiumCode(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === "PROXY_AUTH_REQUIRED" || e.code === "PROXY_AUTH_REJECTED") return e.code;
    const m = /\bnet::(ERR_[A-Z0-9_]+)/.exec(String(e.message || ""));
    if (m) return m[1];
  }
  return "";
}
// Chromium codes, by what the user can do about them (net/base/net_error_list.h).
const CHROMIUM = [
  ["voice.errors.proxy.authRequired", false, /^(PROXY_AUTH_REQUIRED|ERR_PROXY_AUTH_REQUESTED(_WITH_NO_CONNECTION)?|ERR_UNEXPECTED_PROXY_AUTH)$/],
  ["voice.errors.proxy.authRejected", false, /^PROXY_AUTH_REJECTED$/],
  ["voice.errors.proxy.authUnsupported", false, /^ERR_PROXY_AUTH_UNSUPPORTED$/],
  ["voice.errors.proxy.pac", true, /^ERR_(MANDATORY_PROXY_CONFIGURATION_FAILED|PAC_\w+)$/],
  ["voice.errors.proxy.unreachable", true, /^ERR_(PROXY_CONNECTION_FAILED|PROXY_CERTIFICATE_INVALID|PROXY_HTTP_1_1_REQUIRED|SOCKS_CONNECTION_FAILED|SOCKS_\w+)$/],
  ["voice.errors.proxy.refused", true, /^ERR_(TUNNEL_CONNECTION_FAILED|PROXY_UNABLE_TO_CONNECT_TO_DESTINATION|SOCKS_CONNECTION_HOST_UNREACHABLE)$/],
  ["voice.errors.network.notFound", true, /^ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_\w+|ICANN_NAME_COLLISION)$/],
  ["voice.errors.network.noConnection", true, /^ERR_(INTERNET_DISCONNECTED|CONNECTION_\w+|ADDRESS_UNREACHABLE|NETWORK_CHANGED|NETWORK_ACCESS_DENIED|TIMED_OUT|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED)$/],
  ["voice.errors.network.tls", true, /^ERR_(CERT_\w+|SSL_\w+|BAD_SSL_CLIENT_AUTH_CERT|CERTIFICATE_\w+)$/]
];
// A malformed request rather than a network failure: a bug, which retrying does not fix.
const CHROMIUM_BUGS = /^ERR_(INVALID_ARGUMENT|INVALID_URL|UNKNOWN_URL_SCHEME|DISALLOWED_URL_SCHEME|UNSAFE_PORT|NOT_IMPLEMENTED)$/;

function classifyChromium(error, code, provider) {
  if (CHROMIUM_BUGS.test(code)) return new VoiceError("Unknown", t("voice.errors.unexpected.short"), String(error?.message || error), { cause: error });
  const [key, retryable] = CHROMIUM.find(([, , re]) => re.test(code)) || ["voice.errors.network.failed", true];
  const short = key.includes(".proxy.") ? t("voice.errors.proxy.short") : t("voice.errors.network.short");
  const detail = String(error?.cause?.message || error?.message || code);
  return new VoiceError("Network", short, t(key, { provider, error: detail }), { retryable, cause: error });
}

function classifyNetwork(error, provider) {
  const code = errorCode(error);
  const net = (detail, retryable) => new VoiceError("Network", t("voice.errors.network.short"), detail, { retryable, cause: error });
  if (NAME_CODES.has(code)) return net(t("voice.errors.network.notFound", { provider }), true);
  if (CONNECT_CODES.has(code)) return net(t("voice.errors.network.noConnection", { provider }), true);
  if (isTlsCode(code)) return net(t("voice.errors.network.tls", { provider }), true);
  const detail = error.cause?.message || error.message;
  // Without a system error code underneath there is no sign this was the connection rather than a bug.
  return net(t("voice.errors.network.failed", { provider, error: detail }), Boolean(code) || error.message === "terminated");
}

// Classifies a thrown error. `signal` is the caller's own signal: it is what separates "we asked it to stop" from
// "it timed out", because both surface as aborts. A signal combined with AbortSignal.timeout() is fine too: a
// timeout aborts with a TimeoutError reason.
function classifyError({ error, provider, signal }) {
  if (error instanceof VoiceError) return error;
  const name = error?.name;
  if (signal?.aborted && signal.reason?.name !== "TimeoutError") {
    return new VoiceError("Cancelled", t("voice.errors.cancelled.short"), t("voice.errors.cancelled.long"), { cause: error });
  }
  if (name === "AbortError" || name === "TimeoutError" || signal?.aborted) {
    return new VoiceError("Timeout", t("voice.errors.timeout.short"), t("voice.errors.timeout.long", { provider }), { retryable: true, cause: error });
  }
  if (error instanceof SyntaxError) {
    return new VoiceError("MalformedResponse", t("voice.errors.malformed.short"), t("voice.errors.malformed.unreadable", { provider }),
      { retryable: true, cause: error });
  }
  // fs errors carry the path; network errors never do.
  if (error?.path && typeof error.code === "string") {
    return error.code === "ENOENT"
      ? new VoiceError("AudioUnreadable", t("voice.errors.audioMissing.short"), t("voice.errors.audioMissing.long"), { cause: error })
      : new VoiceError("AudioUnreadable", t("voice.errors.audioUnreadable.short"), t("voice.errors.audioUnreadable.long"), { cause: error });
  }
  const chromium = chromiumCode(error);
  if (chromium) return classifyChromium(error, chromium, provider);
  if ((name === "TypeError" && (error.message === "fetch failed" || error.message === "terminated")) || errorCode(error)) {
    return classifyNetwork(error, provider);
  }
  return new VoiceError("Unknown", t("voice.errors.unexpected.short"), String(error?.message || error), { cause: error });
}

// classify({status, body, statusText, retryAfterMs, provider}) for a failed HTTP reply,
// classify({error, provider, signal}) for anything thrown.
function classify({ error, status, provider = "API", ...rest } = {}) {
  return error !== undefined ? classifyError({ error, provider, signal: rest.signal }) : classifyResponse({ status, provider, ...rest });
}

// Read the body first and pass it in: it is the only useful part of most failures.
const fromResponse = (res, body, provider) =>
  classify({ status: res.status, statusText: res.statusText, body, provider, retryAfterMs: parseRetryAfter(res.headers.get("retry-after")) });

module.exports = { VoiceError, KINDS, classify, fromResponse, configuration, tooLarge };
