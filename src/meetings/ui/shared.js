// What the meetings' pieces of the manager window share: main's calls, what runs, the figures' formats, a dialog.
// Loaded after renderer.js; uses $, esc, icon, t and toast of common.js and renderer.js.
const meetingsShared = (() => {
  const BYTE_UNITS = ["B", "KB", "MB", "GB"];
  const DATE = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };
  // Failures that Settings -> Models can put right.
  const SETTINGS_CODES = ["meetingsNoKey", "meetingsKeyRefused", "meetingsModelMissing", "meetingsModelUnsuitable"];

  const live = {
    capabilities: { supported: false, code: null, ownAudioExcluded: true },
    status: { phase: "idle", recording: null },
    jobs: new Map(),         // key -> { step, done, total, waitMs }
    compressions: new Map(), // key -> { done, total }
    recoverable: [],
    shortcut: ""
  };
  const key = ({ place, id }) => `${place}|${id}`;

  // main's value; what it refused is an Error with the code.
  async function call(name, ...args) {
    const answer = await window.meetings[name](...args);
    if (answer?.ok) return answer.value;
    throw Object.assign(new Error(answer?.message || t("errors.meetingsUnexpected")), { code: answer?.code || "" });
  }
  function setState(state) {
    const { capabilities, status, shortcut, recoverable } = state;
    Object.assign(live, { capabilities, status, shortcut, recoverable });
    live.jobs = new Map(state.jobs.map(job => [key(job), job]));
    live.compressions = new Map(state.compressions.map(job => [key(job), job]));
  }

  // A code of meeting.json is as untrusted as the rest of it: only one that has a text shows as itself.
  function errorText(code) {
    const name = `errors.${code}`, text = t(name);
    return text === name ? t("errors.meetingsUnexpected") : text;
  }
  async function openSettings(pane = "models") {
    if (!await call("settings", pane)) toast(t("meetings.settingsUnavailable"), true);
  }
  function report(error) {
    const action = SETTINGS_CODES.includes(error?.code) ? { label: t("meetings.openSettings"), run: () => openSettings() } : null;
    toast(error?.message || error, true, action);
  }

  const two = n => String(n).padStart(2, "0");
  function clock(ms) {
    const s = Math.floor(Math.max(0, ms || 0) / 1000);
    return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  }
  const length = ms => clock(ms).replace(/^0/, "");
  const date = ms => (Number.isFinite(ms) ? I18N.formatDateTime(ms, DATE) : "");
  function bytes(value) {
    if (!Number.isFinite(value)) return "";
    let n = value, unit = 0;
    while (n >= 1000 && unit < BYTE_UNITS.length - 1) { n /= 1024; unit++; }
    return `${I18N.formatNumber(n, { maximumFractionDigits: n < 10 && unit ? 1 : 0 })} ${BYTE_UNITS[unit]}`;
  }
  function accelerator(value) {
    return String(value || "").replace(/Control/g, "Ctrl").replace(/Super/g, "Win").split("+").filter(Boolean)
      .map(part => `<kbd>${esc(part)}</kbd>`).join("+");
  }

  // A modal of the meetings: gone once closed, the window's own keys stay out of it, and the focus is not lost with
  // the menu item it was opened from.
  function dialog(className, html) {
    const d = document.createElement("dialog");
    d.className = className;
    d.innerHTML = html;
    d.setAttribute("aria-labelledby", d.querySelector("h2").id);
    d.addEventListener("keydown", e => e.stopPropagation());
    d.addEventListener("close", () => {
      d.remove();
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const under = [...document.querySelectorAll("dialog[open]")].at(-1);
      (under?.querySelector("button:not(:disabled)") || $("meetingsBtn")).focus();
    });
    document.body.append(d);
    d.showModal();
    return d;
  }

  return { live, key, call, setState, errorText, SETTINGS_CODES, openSettings, report, clock, length, date, bytes, accelerator, dialog };
})();
