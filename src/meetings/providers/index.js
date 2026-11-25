// What transcribes a meeting, by the catalog's word about the model: the request, how long its parts are and how
// exact its times (grain: "word", "segment" or "part"). And how every request of a meeting is repeated.
const timers = require("node:timers/promises");
const { classify } = require("../../voice/errors");
const { TASKS, providerName, modelInfo } = require("../../voice/catalog");
const { fail } = require("../errors");
const gemini = require("./gemini");
const openai = require("./openai");
const soniox = require("./soniox");

const SECOND = 1000, MINUTE = 60 * SECOND;

const PAUSES_MS = [2, 5, 15, 30].map(s => s * SECOND);
const PAUSE_MAX_MS = 2 * MINUTE;
const RETRIED = new Set(["RateLimited", "ServerError", "Network", "Timeout", "MalformedResponse"]);
// Failed without being billed: Google says it of its 500, and a refusal for the rate or the load did no work. Of
// OpenAI's and Soniox's 500, of a 502 and of a 504 nobody says it, and behind each the work may have been done.
const UNBILLED_STATUS = { Gemini: [429, 500, 503], OpenAI: [429, 503], Soniox: [429, 503] };
// Failures from before there was a connection to send on: names, refusals, proxies, certificates, offline. Any other
// lost connection, a reset or a "timed out" included, cannot be told from one lost while the answer was on its way.
const NEVER_SENT = [
  /\bERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_\w+|ICANN_NAME_COLLISION|INTERNET_DISCONNECTED)\b/,
  /\bERR_(CONNECTION_REFUSED|CONNECTION_FAILED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_\w+)\b/,
  /\bERR_(PAC_\w+|MANDATORY_PROXY_CONFIGURATION_FAILED|CERT_\w+)\b/,
  /\b(ENOTFOUND|EAI_\w+|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT)\b/ // Node's
];

// Connections lost in the ways Chromium repeats a POST for by itself, when it had reused the connection (as after an
// upload), before it reports the failure: seen on the wire, two arrivals for one request. So the one repeat may
// already be spent, and there is none of ours.
const RESENT = new RegExp("\\bERR_(CONNECTION_(RESET|CLOSED|ABORTED)|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED"
  + "|HTTP2_(PING_FAILED|SERVER_REFUSED_STREAM)|QUIC_HANDSHAKE_FAILED)\\b");

// 429, 5xx and the network; no other 4xx, and no answer that came and was only unreadable: that one was paid for.
function worthRepeating({ kind, retryable, status }) {
  if (!retryable || !RETRIED.has(kind)) return false;
  if (status >= 400 && status < 500) return status === 429;
  return kind !== "MalformedResponse" || status >= 500;
}

// How often a billable request that failed like this may be sent again.
function repeatsAllowed(provider, error) {
  if (error.kind === "Timeout") return 1;
  if (error.status) return UNBILLED_STATUS[provider]?.includes(error.status) ? Infinity : 1;
  for (let e = error.cause, depth = 0; e && depth < 5; e = e.cause, depth++) {
    const said = `${e.code ?? ""} ${e.message ?? ""}`;
    if (NEVER_SENT.some(re => re.test(said))) return Infinity;
    if (RESENT.test(said)) return 0;
  }
  return 1;
}

// call(attempt, { free }) runs attempt(signal) until it succeeds or fails for good, always at the same provider.
// The backoff is for what cannot cost money: a free request (upload, poll), one that was never sent or surely not
// billed. A billable one that may have been answered is sent twice at most, Chromium's own repeat counted; after
// that it is the user's Retry that pays.
function createCaller({ provider, signal, timeoutMs, wait = (ms, abort) => timers.setTimeout(ms, undefined, { signal: abort }), onRetry = () => {} }) {
  async function call(attempt, { free = false } = {}) {
    let maybePaid = 0;
    for (let failures = 0; ; failures++) {
      try {
        signal.throwIfAborted();
        return await attempt(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
      } catch (thrown) {
        const error = classify({ error: thrown, provider, signal });
        if (signal.aborted || failures >= PAUSES_MS.length || !worthRepeating(error)) throw error;
        if (!free) {
          const allowed = repeatsAllowed(provider, error);
          if (allowed !== Infinity && ++maybePaid > allowed) throw error;
        }
        const waitMs = Math.min(PAUSE_MAX_MS, Math.max(PAUSES_MS[failures], error.retryAfterMs || 0));
        onRetry({ waitMs, kind: error.kind });
        await call.wait(waitMs);
      }
    }
  }
  call.wait = async ms => {
    try { await wait(ms, signal); } catch (error) { throw classify({ error, provider, signal }); }
  };
  return call;
}

// The catalog's model for this task, or a refusal before anything is sent. A provider that has no model for the task
// cannot do it with a model of any name (Soniox writes no summaries).
function suitable(task, { provider, model }) {
  const name = providerName(provider);
  if (!name || !model || !TASKS[task].models[name]) fail("meetingsModelUnsuitable", `${provider} ${model}`.trim());
  const info = modelInfo(name, model);
  if (info.tasks && !info.tasks.includes(task)) fail("meetingsModelUnsuitable", `${name} ${model}`);
  return { provider: name, info };
}

// The length of a part: { min, target, max, gap } in ms, gap being the silence that ends one.
function partLimits(provider, info) {
  if (provider === "OpenAI") return { min: 30 * SECOND, target: 45 * SECOND, max: 90 * SECOND, gap: 15 * SECOND };
  if (info.api === "interactions" || info.api === "async") {
    // Under both of the limits Google documents with word times (30 and 15 minutes): past them it cuts off silently.
    // Soniox takes a file of hours; its parts are as long, so that a part that fails costs as little to ask again.
    const max = Math.min(14 * MINUTE, (info.limits?.timedAudioSeconds ?? Infinity) * SECOND);
    const target = Math.min(12 * MINUTE, max);
    return { min: Math.round(target * 2 / 3), target, max, gap: 2 * MINUTE };
  }
  // By what fits in the answer: up to about 4000 tokens of JSON a minute of dense Cyrillic speech, thinking included.
  const output = info.limits?.outputTokens ?? 16_000; // a model nobody knows gets short parts
  const target = Math.min(20 * MINUTE, Math.floor(output / 4000) * MINUTE);
  return { min: Math.round(target * 0.6), target, max: Math.round(target * 1.2), gap: Math.min(2 * MINUTE, target) };
}

function createTranscriber(choice) {
  const { provider, info } = suitable("meetingTranscription", choice);
  const common = { provider, model: choice.model, limits: partLimits(provider, info) };
  if (provider === "OpenAI") return { ...common, ...openai.text, grain: "part", parallel: 4 };
  if (provider === "Soniox") return { ...common, ...soniox.words, grain: "word", parallel: 2, removeFile: soniox.removeFile };
  return info.api === "interactions"
    ? { ...common, ...gemini.words, grain: "word", parallel: 2, removeFile: gemini.removeFile }
    : { ...common, ...gemini.segments, grain: "segment", parallel: 2, removeFile: gemini.removeFile };
}

module.exports = { createCaller, createTranscriber, partLimits, suitable };
