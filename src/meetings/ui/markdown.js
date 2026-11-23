// summary.md and transcript.md as HTML. Anybody who can write into the project can have written them, and what is in
// them was said by anybody: every piece of text is escaped, and the only elements are the ones made here - headings,
// paragraphs, lists, and buttons for a time, a range of the transcript's lines and the meeting's own screenshots.
// There is no link, no image and no attribute of the text's own making.
const meetingsMarkdown = (() => {
  const CLOCK = "\\d{2,3}:[0-5]\\d:[0-5]\\d";
  const INLINE = new RegExp([
    "\\\\([!-/:-@\\[-`{-~])",                                  // 1: an escaped character
    `\\[(~?${CLOCK})(–${CLOCK})?\\](?!\\()`,                   // 2, 3: a time, or a span of them
    "\\[([^\\]\\\\]{0,80})\\]\\((screens/[0-9a-z-]{1,40}\\.png)\\)", // 4, 5: a screenshot
    "~~([^~\\\\]{0,80})~~",                                    // 6: struck out
    "transcript\\.md, \\p{L}{1,20} (\\d{1,7})(?:–(\\d{1,7}))?" // 7, 8: lines of the transcript
  ].join("|"), "gu");
  const HEADING = /^(#{1,3}) (.*)$/;
  const HEADING_SPAN = new RegExp(`\\((~?${CLOCK})(–${CLOCK})\\)$`);

  function ms(value) {
    const [h, m, s] = value.replace("~", "").split(":").map(Number);
    return ((h * 60 + m) * 60 + s) * 1000;
  }
  function time(from, to = "") {
    const label = esc(from + to);
    return `<button type="button" class="md-time" data-at="${ms(from)}" aria-label="${esc(t("meetings.view.goTo", { time: from }))}">${label}</button>`;
  }

  // screens: the files of the meeting's own screenshots; a link to anything else stays text.
  function inline(text, screens) {
    let out = "", at = 0;
    for (const m of text.matchAll(INLINE)) {
      const [whole, escaped, from, to, label, file, struck, first, last] = m;
      out += esc(text.slice(at, m.index));
      at = m.index + whole.length;
      if (escaped) out += esc(escaped);
      else if (from) out += time(from, to);
      else if (file) {
        out += screens.has(file) ? `<button type="button" class="md-screen" data-screen="${esc(file)}">${icon("camera")}${esc(label)}</button>` : esc(label);
      } else if (first) {
        out += `<button type="button" class="md-lines" data-from="${Number(first)}" data-to="${Number(last || first)}">${esc(whole)}</button>`;
      } else out += `<s>${esc(struck)}</s>`;
    }
    return out + esc(text.slice(at));
  }

  function summary(source, screens) {
    const out = [];
    let inList = false;
    for (const line of source.split(/\r?\n/)) {
      const item = line.startsWith("- ");
      if (inList && !item) out.push("</ul>");
      if (item && !inList) out.push("<ul>");
      inList = item;
      if (item) {
        out.push(`<li>${inline(line.slice(2), screens)}</li>`);
        continue;
      }
      if (!line.trim()) continue;
      const heading = HEADING.exec(line);
      if (!heading) {
        out.push(`<p>${inline(line, screens)}</p>`);
        continue;
      }
      const tag = heading[1].length === 1 ? "h3" : "h4", span = HEADING_SPAN.exec(heading[2]);
      const title = span ? heading[2].slice(0, span.index) : heading[2];
      out.push(`<${tag}>${inline(title, screens)}${span ? time(span[1], span[2]) : ""}</${tag}>`);
    }
    if (inList) out.push("</ul>");
    return out.join("");
  }

  // Every line of the file is a row with its number: the summary and the agents name places by them.
  const LINE_TIME = new RegExp(`^- \\[~?(${CLOCK})`);
  function transcript(source, screens) {
    return source.replace(/\r?\n$/, "").split(/\r?\n/).map((line, i) => {
      const at = LINE_TIME.exec(line), heading = HEADING.exec(line);
      const text = heading ? `<b>${inline(heading[2], screens)}</b>` : inline(line.replace(/^- /, ""), screens);
      return `<div class="mt-line" data-line="${i + 1}"${at ? ` data-start="${ms(at[1])}"` : ""} tabindex="-1">`
        + `<span class="mt-no">${i + 1}</span><span class="mt-text">${text}</span></div>`;
    }).join("");
  }

  return { summary, transcript };
})();
