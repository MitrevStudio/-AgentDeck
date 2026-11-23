// What processing a meeting costs, before it is sent: for the confirm button. A range, from the catalog's dated
// prices and the research's assumptions about how much is said; the bill is the provider's.
const { modelInfo, providerName } = require("../voice/catalog");
const { partLimits } = require("./providers");

const PER_MINUTE = {
  transcript: [175, 25_000 / 60], // tokens of text a minute of meeting, however many channels it is spread over
  summaryInput: [175, 50_000 / 60]
};
const SUMMARY_OUTPUT = { least: 1000, most: 4000, mostPerHour: 2500 }; // thinking included
const USD = 1_000_000;

function priceOn(prices, day) {
  if (!prices?.length) return null;
  return prices.filter(p => p.from <= day).at(-1) || prices[0];
}
const byTokens = (price, input, output) => (input * price.input + output * price.output) / USD;

// -> { provider, model, requests: { min, max }, cost: { min, max } | null }
function transcriptionEstimate({ provider, model }, { durationMs, channels, day }) {
  const info = modelInfo(provider, model), limits = partLimits(provider, info);
  const requests = { min: Math.ceil(durationMs / limits.max), max: channels * Math.ceil(durationMs / limits.min) };
  const price = priceOn(info.price, day), minutes = durationMs / 60_000;
  const heard = [minutes * channels / 2, minutes * channels]; // silence that is skipped takes off up to about half
  let cost = null;
  if (Number.isFinite(price?.perMinute)) cost = heard.map(m => m * price.perMinute);
  else if (price && info.limits?.audioTokensPerSecond) {
    cost = heard.map((m, i) => byTokens(price, m * 60 * info.limits.audioTokensPerSecond, minutes * PER_MINUTE.transcript[i]));
  }
  return { provider, model, requests, cost: cost && { min: cost[0], max: cost[1] } };
}

function summaryEstimate({ provider, model }, { durationMs, day }) {
  const price = priceOn(modelInfo(provider, model).price, day), minutes = durationMs / 60_000;
  let cost = null;
  if (Number.isFinite(price?.input)) {
    cost = {
      min: byTokens(price, minutes * PER_MINUTE.summaryInput[0], SUMMARY_OUTPUT.least),
      max: byTokens(price, minutes * PER_MINUTE.summaryInput[1], SUMMARY_OUTPUT.most + minutes / 60 * SUMMARY_OUTPUT.mostPerHour)
    };
  }
  return { provider, model, requests: { min: 1, max: 1 }, cost };
}

// transcription, summary: { provider, model }. null while the meeting's length or channels are unknown; a cost is
// null where the catalog has no price, and then so is the whole. Retries of doubtful parts come on top.
function estimateMeeting(meeting, { transcription, summary }, now = new Date()) {
  const { durationMs, audio } = meeting || {};
  const channels = [audio?.mic, audio?.system].filter(Boolean).length;
  if (!(durationMs > 0) || !channels || ![transcription, summary].every(c => providerName(c.provider) && c.model)) return null;
  const context = { durationMs, channels, day: now.toISOString().slice(0, 10) };
  const text = transcriptionEstimate(transcription, context), index = summaryEstimate(summary, context);
  const sum = key => ({ min: text[key].min + index[key].min, max: text[key].max + index[key].max });
  return { transcription: text, summary: index, requests: sum("requests"), cost: text.cost && index.cost ? sum("cost") : null };
}

module.exports = { estimateMeeting };
