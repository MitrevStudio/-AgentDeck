// Whatever stopped the processing of a meeting, as one of the meetings' errors (errors.js): a code for the window and
// meeting.json, the provider's or the system's own words only in `detail`, which never goes into the project - a
// provider can quote the key it refused.
const { HostError } = require("../host/errors");
const { VoiceError } = require("../voice/errors");
const { MESSAGES, fromFs } = require("./errors");

const BY_KIND = {
  Configuration: "meetingsNoKey", Auth: "meetingsKeyRefused", QuotaExhausted: "meetingsQuota",
  RateLimited: "meetingsRateLimited", Network: "meetingsNetwork", Timeout: "meetingsNetwork",
  ServerError: "meetingsProviderDown", ModelNotFound: "meetingsModelMissing",
  BadRequest: "meetingsRequestRefused", PayloadTooLarge: "meetingsRequestRefused",
  MalformedResponse: "meetingsBadAnswer", AudioUnreadable: "meetingsAudioUnreadable"
};

function problem(error) {
  if (error instanceof HostError) return error;
  if (error?.syscall) {
    try { fromFs(error); } catch (known) { return known; }
  }
  const code = (error instanceof VoiceError && BY_KIND[error.kind]) || "meetingsUnexpected";
  if (code === "meetingsUnexpected") console.error("A meeting could not be processed:", error);
  return Object.assign(new HostError(code, MESSAGES[code]), { detail: String(error?.longMessage || error?.message || error) });
}

module.exports = { problem };
