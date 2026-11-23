// transcript.md: a line for each utterance, each screenshot at its time, gaps and doubts in sight. An agent opens it
// by line numbers, so one entry is always one line under a head of the same height. The summary is made from this
// file as it is, whatever the work folder still has.
//   # Payments - transcript, 22.11.2026 14:30, 1:12:40
//
//   <what the marks mean>
//
//   - [00:14:05] Others: the button does not work
//   - [00:14:32] Screen: [00:14:32](screens/00-14-32-m1.png)
//   - [00:15:10] Screen: ~~00:15:10~~ (deleted)
//   - [00:20:00–00:31:58] Me: not transcribed. <why>
const { t } = require("../i18n");
const { escapeText, unescapeText, clock, length, readClock } = require("./text");

const LINE = /^- \[(~)?(\d{2,3}:\d\d:\d\d)(?:–(\d{2,3}:\d\d:\d\d))?\] (.*)$/;
// A screenshot's line, the deleted one's too. What anybody said cannot be either: its brackets and tildes are escaped.
const SCREEN_LINE = /^(\[[^\]\\]*\]\(screens\/[^)\s]+\)$|~~[^~\\]*~~)/;

// "Payments", "22.11.2026 14:30", "1:12:40": the date from the folder's name, where it is the recorder's local time.
function heading({ id, title, durationMs }) {
  const date = t("meetings.doc.date", {
    year: id.slice(0, 4), month: id.slice(5, 7), day: id.slice(8, 10), time: `${id.slice(11, 13)}:${id.slice(13, 15)}`
  });
  return { title: escapeText(title) || t("meetings.doc.untitled"), when: durationMs === null ? date : `${date}, ${length(durationMs)}` };
}

const screenLink = ({ atMs, file, monitor }) => `[${clock(atMs)}${monitor > 1 ? ` m${monitor}` : ""}](${file})`;

// A document with the links to a deleted screenshot struck out where they stand: still a screenshot's moment, to
// parseTranscript() as well, and every line where it was.
function strikeScreenLink(document, file) {
  const link = new RegExp(`\\[([^\\]\\\\\\r\\n]*)\\]\\(${file.replace(/\./g, "\\.")}\\)`, "g");
  return document.replace(link, (_, label) => `~~${label}~~ ${t("meetings.doc.screenDeleted")}`);
}

function renderTranscript(meeting, entries, { approximate }) {
  const about = approximate ? "~" : "";
  const line = entry => {
    const who = entry.speaker && t(`meetings.doc.${entry.speaker}`);
    const range = `[${clock(entry.start)}–${clock(entry.end)}]`;
    switch (entry.type) {
      case "gap": return `${range} ${who}: ${t("meetings.doc.gap")} ${escapeText(t(`errors.${entry.reason}`))}`;
      case "note": return `${range} ${who}: ${t(`meetings.check.${entry.reason}`)}`;
      case "screen": return `[${clock(entry.start)}] ${t("meetings.doc.screen")}: ${screenLink({ ...entry, atMs: entry.start })}`;
      default: return `[${about}${clock(entry.start)}] ${who}: ${escapeText(entry.text)}${entry.doubt ? " (?)" : ""}${entry.echo ? ` ${t("meetings.doc.echo")}` : ""}`;
    }
  };
  const { title, when } = heading(meeting);
  const legend = [
    t("meetings.doc.legend"), ...(approximate ? [t("meetings.doc.approximate")] : []), ...(entries.some(e => e.echo) ? [t("meetings.doc.echoLegend")] : [])
  ].join(" ");
  const shown = entries.map(entry => `- ${line(entry)}`);
  if (!entries.some(e => e.type === "speech" || e.type === "gap")) {
    if (shown.length) shown.push("");
    shown.push(t("meetings.doc.noSpeech"));
  }
  return `# ${title} - ${t("meetings.doc.transcript")}, ${when}\n\n${legend}\n\n${shown.join("\n")}\n`;
}

// -> [{ number, start, kind: "speech"|"note"|"screen", approximate, speaker, text }], number being the line's in the
// file, from 1. A line that is not the pipeline's is not the meeting's.
function parseTranscript(file) {
  const lines = [];
  file.split(/\r?\n/).forEach((raw, i) => {
    const m = LINE.exec(raw);
    if (!m) return;
    const start = readClock(m[2]);
    if (start === null) return;
    const colon = m[4].indexOf(": ");
    const speaker = colon < 0 ? "" : m[4].slice(0, colon), text = colon < 0 ? m[4] : m[4].slice(colon + 2);
    const kind = SCREEN_LINE.test(text) ? "screen" : m[3] ? "note" : "speech";
    lines.push({ number: i + 1, start, kind, approximate: Boolean(m[1]), speaker, text: kind === "screen" ? "" : unescapeText(text) });
  });
  return lines;
}

module.exports = { heading, screenLink, strikeScreenLink, renderTranscript, parseTranscript };
