// Markdown, as the agents write their answers, to HTML for the chat view. A small renderer of the app's own, safe by
// construction: there is no HTML passthrough - every character of the source is escaped before anything is made of
// it, and the only tags in the result are the ones written here, with no attribute taken from the source but a
// link's address, which is kept only when it is http(s) (and is escaped text too). Links open outside the app
// (target="_blank": the WebView hands them to the browser).
//
// Blocks: headings (#), paragraphs (a line break stays a line break, as chat text has it), fenced code (``` or ~~~;
// it scrolls sideways, CSS), lists - bulleted, numbered, nested, with task boxes -, block quotes, tables (they scroll
// sideways), horizontal rules. Inline: `code`, **bold**, *italic*, ~~struck~~, [links](https://...), bare
// addresses, backslash escapes. What it does not know stays as the text it is.
import { esc } from "./util.js";

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_RULE = /^ *\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const MAX_DEPTH = 12; // quotes in lists in quotes ...: deeper than this is plain paragraphs

// ---------- inline ----------
// The spans a mark may enclose are bounded, so that text made of nothing but unclosed marks costs no more than its
// length (a regular expression that may look to the end of the text for every mark is quadratic).
const LINK = "target=\"_blank\" rel=\"noopener noreferrer\"";
// An address as it stands in escaped text: http(s) only, nothing that ends an attribute (those are entities by now).
const isAddress = url => /^https?:\/\/[^\s\u0000]+$/i.test(url);

export function inline(source) {
  const keep = [];
  const stash = html => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(source).replace(/\u0000/g, "");
  // Code spans first: nothing inside them is markup.
  s = s.replace(/(`+)(?!`)([\s\S]{0,4000}?[^`])\1(?!`)/g, (m, ticks, code) => stash(`<code>${esc(code.replace(/\n/g, " "))}</code>`));
  // A backslash before a mark makes it the character it is.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (m, c) => stash(esc(c)));
  s = esc(s);
  // [text](address), ![alt](address) (shown as a link: the app loads no pictures from elsewhere), bare addresses.
  s = s.replace(/(!?)\[([^\]\n]{0,400})\]\(\s*([^\s()]{1,2000}(?:\([^\s()]{0,200}\)[^\s()]{0,2000}){0,8})(?:\s+(?:&quot;.*?&quot;|&#39;.*?&#39;))?\s*\)|https?:\/\/(?:(?!&(?:quot|lt|gt|#39);)[^\s<>\u0000])+/g, (m, bang, label, url) => {
    if (url === undefined) {
      // Punctuation after an address is the sentence's, as is a bracket that closes one opened before it.
      let end = m.length;
      while (end > 0 && (/[.,;:!?]/.test(m[end - 1]) || (m[end - 1] === ")" && !m.slice(0, end).includes("(")))) end--;
      const address = m.slice(0, end);
      return isAddress(address) ? `${stash(`<a href="${address}" ${LINK}>`)}${address}${stash("</a>")}${m.slice(end)}` : m;
    }
    return isAddress(url) ? `${stash(`<a href="${url}" ${LINK}>`)}${label || url}${stash("</a>")}` : label || m;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]{0,2000}?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]{0,2000}?\S)__(?!\w)/g, "$1<strong>$2</strong>");
  s = s.replace(/\*(?=[^\s*])([^*\n]{0,2000}?[^\s*])\*/g, "<em>$1</em>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]{0,2000}?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]{0,2000}?\S)~~/g, "<del>$1</del>");
  s = s.replace(/\n/g, "<br>");
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => keep[i]);
}

// ---------- blocks ----------
// A table's row as its cells: split at the bars that are not escaped and not inside a code span.
function cells(line) {
  const out = [];
  let cur = "", ticks = false;
  const row = line.trim().replace(/^\|/, "");
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "\\" && row[i + 1] === "|") { cur += "|"; i++; }
    else if (c === "`") { ticks = !ticks; cur += c; }
    else if (c === "|" && !ticks) { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  if (cur.trim() || !row.endsWith("|")) out.push(cur.trim());
  return out;
}
const startsBlock = (line, next) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)
  || (line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-"));

function blocks(lines, depth) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if (depth >= MAX_DEPTH) { out.push(`<p>${inline(lines.slice(i).join("\n"))}</p>`); break; }

    if ((m = FENCE.exec(line))) {
      // Up to the fence that closes it (as long, of the same mark), or the end: an answer cut short still shows.
      const indent = m[1].length, close = new RegExp(`^ {0,3}${m[2][0]}{${m[2].length},}[ \\t]*$`), code = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ""));
      i++;
      out.push(`<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      out.push(`<div class="md-h md-h${m[1].length}" role="heading" aria-level="${m[1].length}">${inline(m[2])}</div>`);
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push("<hr>"); i++; continue; }
    if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${blocks(inner, depth + 1)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line), align = cells(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      const cell = (tag, text, n) => `<${tag}${align[n] ? ` class="md-${align[n]}"` : ""}>${inline(text || "")}</${tag}>`;
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, n) => cell("th", c, n)).join("")}</tr></thead><tbody>${
        rows.map(r => `<tr>${head.map((_, n) => cell("td", r[n], n)).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    if ((m = ITEM.exec(line))) {
      // The items of one list: of the first one's kind, at its indent. What follows an item's first line further in
      // than its mark (and blank lines between such lines) is the item's own - a paragraph more, a nested list, code.
      const base = m[1].length, ordered = /\d/.test(m[2]), items = [];
      const start = ordered ? Number(m[2].slice(0, -1)) : 1;
      // Where the next line that is not blank is, looked for once for a run of blank ones: a file of a megabyte is
      // rendered here too, and looking from every blank line to the end of the text would take its length squared.
      let filled = -1;
      for (; i < lines.length; ) {
        // Blank lines between two items of the list part nothing.
        let at = i;
        while (at < lines.length && !lines[at].trim()) at++;
        const it = at < lines.length ? ITEM.exec(lines[at]) : null;
        if (!it || it[1].length < base || it[1].length > base + 1 || /\d/.test(it[2]) !== ordered || RULE.test(lines[at])) break;
        i = at;
        const offset = it[1].length + it[2].length + 1, body = [it[3] || ""];
        for (i++; i < lines.length; i++) {
          const l = lines[i];
          if (!l.trim()) {
            // A blank line stays in the item only when what follows is the item's too.
            if (filled <= i) for (filled = i + 1; filled < lines.length && !lines[filled].trim();) filled++;
            const after = lines[filled];
            if (after === undefined || after.search(/\S/) < base + 2) break;
            body.push("");
          } else if (l.search(/\S/) >= base + 2) body.push(l.slice(Math.min(offset, l.search(/\S/))));
          else if (ITEM.test(l) || startsBlock(l, lines[i + 1])) break;
          else body.push(l.trim()); // a paragraph's line that was not indented
        }
        items.push(body);
      }
      const html = items.map(body => {
        const task = /^\[([ xX])\][ \t]+/.exec(body[0]);
        if (task) body[0] = body[0].slice(task[0].length);
        let inner = blocks(body, depth + 1);
        // An item that is one paragraph is just its text.
        if (/^<p>(?:(?!<p>)[\s\S])*<\/p>$/.test(inner)) inner = inner.slice(3, -4);
        else if (inner.startsWith("<p>")) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
        return `<li${task ? " class=\"md-task\"" : ""}>${task ? `<span class="md-box">${task[1] === " " ? "☐" : "☑"}</span>` : ""}${inner}</li>`;
      }).join("");
      out.push(ordered ? `<ol${start !== 1 && Number.isSafeInteger(start) ? ` start="${start}"` : ""}>${html}</ol>` : `<ul>${html}</ul>`);
      continue;
    }
    // A paragraph: up to a blank line or the start of something else.
    const para = [line];
    for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++) para.push(lines[i]);
    out.push(`<p>${inline(para.map(l => l.trim()).join("\n"))}</p>`);
  }
  return out.join("");
}

// source: a message's text. -> HTML, for an element with the class "md" (style.css).
export function renderMarkdown(source) {
  return blocks(String(source ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);
}
