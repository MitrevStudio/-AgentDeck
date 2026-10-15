// Public pay-as-you-go API prices, USD per million tokens, used to show what a session's tokens would cost on the
// API. Subscriptions (Claude Pro/Max, ChatGPT, Copilot) are not billed per token, so the app labels every figure
// as an API-equivalent cost. Models missing here show tokens only, unless the agent reports a cost itself.
const AS_OF = "2026-10-15";
const SOURCES = [
  "https://platform.claude.com/docs/en/about-claude/pricing",
  "https://developers.openai.com/api/docs/pricing"
];

// Anthropic: cache writes cost 1.25x (5-minute) and 2x (1-hour) the input price; reads vary per model.
// `geo`: Claude 4.6 and later cost 1.1x with US-only inference. `fast`: fast mode costs 2x, caching included (Opus
// 5.5, 5 and 4.8; a fast request to Opus 4.6 runs and is billed at the standard rate). Every row checked against both
// pricing pages on AS_OF.
const claude = (input, output, read, extra) => ({ input, output, write5m: input * 1.25, write1h: input * 2, read, ...extra });
const NEW = { geo: true };
const FAST = { geo: true, fast: 2 };
// OpenAI: no charge for writing the cache; prompts over 272K tokens use the long-context rates where listed.
const openai = (input, read, output, long) => ({
  input, output, write5m: input, write1h: input, read,
  ...(long && { long: { above: 272_000, input: long[0], output: long[2], write5m: long[0], write1h: long[0], read: long[1] } })
});

const PRICES = {
  "claude-fable-5-1": claude(10, 50, 0.25, NEW),
  "claude-mythos-5-1": claude(10, 50, 0.25, NEW),
  "claude-fable-5": claude(10, 50, 1, NEW),
  "claude-mythos-5": claude(10, 50, 1, NEW),
  "claude-opus-5-5": claude(4, 20, 0.2, FAST),
  "claude-opus-5": claude(5, 25, 0.5, FAST),
  "claude-opus-4-8": claude(5, 25, 0.5, FAST),
  "claude-opus-4-7": claude(5, 25, 0.5, NEW),
  "claude-opus-4-6": claude(5, 25, 0.5, NEW),
  "claude-opus-4-5": claude(5, 25, 0.5),
  "claude-opus-4-1": claude(15, 75, 1.5),
  "claude-opus-4": claude(15, 75, 1.5),
  "claude-sonnet-5-5": claude(2, 10, 0.1, NEW),
  "claude-sonnet-5": claude(2, 10, 0.2, NEW),
  "claude-sonnet-4-6": claude(3, 15, 0.3, NEW),
  "claude-sonnet-4-5": claude(3, 15, 0.3),
  "claude-sonnet-4": claude(3, 15, 0.3),
  // Priced by prompt length (input, cache writes and cache reads together), request by request.
  "claude-haiku-5-5": claude(0.1, 0.5, 0.01, { geo: true, long: { above: 100_000, ...claude(0.5, 2.5, 0.05) } }),
  "claude-haiku-4-5": claude(1, 5, 0.1),
  "claude-haiku-3-5": claude(0.8, 4, 0.08),

  "gpt-6-astra": openai(10, 1, 50, [20, 2, 75]),
  "gpt-6.1-sol": openai(2, 0.1, 10, [4, 0.2, 15]),
  "gpt-6-sol": openai(2, 0.2, 10, [4, 0.4, 15]),
  "gpt-6-luna": openai(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]),
  "gpt-5.6-sol": openai(4, 0.4, 20, [8, 0.8, 30]),
  "gpt-5.6-terra": openai(2, 0.2, 12, [4, 0.4, 18]),
  "gpt-5.6-luna": openai(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
  "gpt-5.5": openai(5, 0.5, 30, [10, 1, 45]),
  "gpt-5.4": openai(2.5, 0.25, 15, [5, 0.5, 22.5]),
  "gpt-5.4-mini": openai(0.75, 0.075, 4.5),
  "gpt-5.4-nano": openai(0.2, 0.02, 1.25),
  "gpt-5.3-codex": openai(1.75, 0.175, 14),
  "gpt-5.2": openai(1.75, 0.175, 14),
  "gpt-5.1": openai(1.25, 0.125, 10),
  "gpt-5": openai(1.25, 0.125, 10),
  "gpt-5-mini": openai(0.25, 0.025, 2),
  "gpt-5-nano": openai(0.05, 0.005, 0.4)
};
// Older spellings, and Codex variants priced like their base model.
const ALIASES = {
  "claude-3-5-haiku": "claude-haiku-3-5",
  "claude-opus-4-0": "claude-opus-4",
  "claude-sonnet-4-0": "claude-sonnet-4",
  "gpt-5-codex": "gpt-5",
  "gpt-5.1-codex": "gpt-5.1",
  "gpt-5.2-codex": "gpt-5.2"
};

// "us.anthropic.claude-opus-4-8-v1:0", "anthropic/claude-opus-4.8", "claude-opus-4-6[1m]", "claude-haiku-4-5@20251001",
// "claude-sonnet-4-5-20250929", "gpt-5-2025-08-07" -> the table's key.
function modelKey(model) {
  let m = String(model || "").toLowerCase().trim().replace(/\[[^\]]*\]$/, "");
  m = m.slice(m.lastIndexOf("/") + 1).replace(/@.*$/, "");
  if (m.includes("claude")) {
    m = m.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "").replace(/-v\d+(?::\d+)?$/, "").replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return m.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, "");
}
function priceOf(model) {
  const key = modelKey(model);
  return PRICES[ALIASES[key] || key] || null;
}

// t: { input, output, write5m, write1h, read } (input without cache reads/writes); null when the model is unknown.
function cost(model, t, { fast = false, geo = "" } = {}) {
  const p = priceOf(model);
  if (!p) return null;
  const r = p.long && t.input + t.write5m + t.write1h + t.read > p.long.above ? p.long : p;
  let usd = (t.input * r.input + t.output * r.output + t.write5m * r.write5m + t.write1h * r.write1h + t.read * r.read) / 1e6;
  if (fast && p.fast) usd *= p.fast;
  if (geo === "us" && p.geo) usd *= 1.1;
  return usd;
}

module.exports = { AS_OF, SOURCES, PRICES, modelKey, priceOf, cost };
