// The phone app's text tools (mobile/src): the markdown renderer of the chat view, the path pasted for a picture, the
// size a picture is drawn at. What this pins:
//   * markdown.js: headings, paragraphs with their line breaks, bold / italic / struck, inline code, fenced code (also
//     one cut short), bulleted, numbered and nested lists with task boxes, block quotes, tables with alignment, rules,
//     links and bare addresses;
//   * it is safe: whatever the source, the result holds only the renderer's own tags and attributes, a link's address
//     is http(s) or the link is plain text, and nothing of the source ends up as markup - checked on hostile input
//     and on a few thousand strings put together from hostile pieces;
//   * util.js terminalFilePath: a Windows path with forward slashes, quoted when it has a space, a POSIX path as it is;
//   * picture.js: the longer side at most 2000px, never enlarged; the name with the extension of what it became.
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const src = p => pathToFileURL(path.join(__dirname, "../mobile/src", p)).href;

// Every tag of the HTML with its attributes; throws on one the renderer does not write.
const TAGS = {
  p: [], br: [], hr: [], strong: [], em: [], del: [], code: [], ul: [], li: ["class"], blockquote: [], table: [], thead: [], tbody: [], tr: [],
  pre: ["class"], div: ["class", "role", "aria-level"], span: ["class"], ol: ["start"], th: ["class"], td: ["class"], a: ["href", "target", "rel"]
};
function check(html, source) {
  const where = `in the HTML of ${JSON.stringify(source).slice(0, 120)}: ${html.slice(0, 300)}`;
  // Outside tags no "<" or ">" is left: split the tags off first.
  const rest = html.replace(/<\/?([a-z0-9]+)((?:\s+[a-z-]+="[^"<>]*")*)>/g, (m, tag, attrs) => {
    assert.ok(Object.hasOwn(TAGS, tag), `tag <${tag}> ${where}`);
    for (const a of attrs.matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
      assert.ok(TAGS[tag].includes(a[1]), `attribute ${a[1]} on <${tag}> ${where}`);
      if (a[1] === "href") assert.match(a[2], /^https?:\/\//i, `a link that is not http(s) ${where}`);
      if (a[1] === "class") assert.match(a[2], /^md-[a-z0-9-]+( md-[a-z0-9-]+)*$/, `a class of the source's ${where}`);
      if (a[1] === "target") assert.equal(a[2], "_blank");
      if (a[1] === "rel") assert.equal(a[2], "noopener noreferrer");
      if (a[1] === "start" || a[1] === "aria-level") assert.match(a[2], /^\d+$/);
      if (a[1] === "role") assert.equal(a[2], "heading");
    }
    return "";
  });
  assert.ok(!/[<>]/.test(rest), `a bare < or > ${where}`);
  assert.ok(!rest.includes("\u0000"), `a placeholder left ${where}`);
  return html;
}

(async () => {
  const { renderMarkdown } = await import(src("markdown.js"));
  const { terminalFilePath } = await import(src("util.js"));
  const { fitSize, pictureName, sizeText } = await import(src("picture.js"));
  const md = s => check(renderMarkdown(s), s);

  // ---------- markdown: what it renders ----------
  assert.equal(md("Hello"), "<p>Hello</p>");
  assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>", "a line break stays one, a blank line parts paragraphs");
  assert.equal(md("# Title\n## Sub ##\ntext"), '<div class="md-h md-h1" role="heading" aria-level="1">Title</div><div class="md-h md-h2" role="heading" aria-level="2">Sub</div><p>text</p>');
  assert.equal(md("#hashtag is no heading"), "<p>#hashtag is no heading</p>");
  assert.equal(md("**bold** and *it* and _it_ and __bold__ and ~~gone~~"), "<p><strong>bold</strong> and <em>it</em> and <em>it</em> and <strong>bold</strong> and <del>gone</del></p>");
  assert.equal(md("snake_case_name and 2 * 3 * 4 and a_b"), "<p>snake_case_name and 2 * 3 * 4 and a_b</p>", "marks inside words and loose stars are text");
  assert.equal(md("run `npm run build && x` now"), "<p>run <code>npm run build &amp;&amp; x</code> now</p>");
  assert.equal(md("`` a ` b ``"), "<p><code> a ` b </code></p>");
  assert.equal(md("`**not bold**` and \\*not it\\*"), "<p><code>**not bold**</code> and *not it*</p>");
  assert.equal(md("```js\nconst a = 1 < 2;\n  **x**\n```\nafter"), '<pre class="md-code"><code>const a = 1 &lt; 2;\n  **x**</code></pre><p>after</p>');
  assert.equal(md("~~~\ncode\n~~~"), '<pre class="md-code"><code>code</code></pre>');
  assert.equal(md("text\n```\ncut short"), '<p>text</p><pre class="md-code"><code>cut short</code></pre>', "an answer cut inside a fence still shows its code");
  assert.equal(md("- a\n- b\n\n* c"), "<ul><li>a</li><li>b</li><li>c</li></ul>");
  assert.equal(md("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(md("3) three\n4) four"), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md("1. one\n   - in\n     - deeper\n   - in 2\n2. two"), "<ol><li>one<ul><li>in<ul><li>deeper</li></ul></li><li>in 2</li></ul></li><li>two</li></ol>");
  assert.equal(md("- a\n\n  more of a\n- b"), "<ul><li>a<p>more of a</p></li><li>b</li></ul>");
  assert.equal(md("- [x] done\n- [ ] todo"), '<ul><li class="md-task"><span class="md-box">☑</span>done</li><li class="md-task"><span class="md-box">☐</span>todo</li></ul>');
  assert.equal(md("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>", "another kind of list starts a new one");
  assert.equal(md("para\n- item"), "<p>para</p><ul><li>item</li></ul>");
  assert.equal(md("> quoted **b**\n> more\n\nout"), "<blockquote><p>quoted <strong>b</strong><br>more</p></blockquote><p>out</p>");
  assert.equal(md("> - a\n> - b"), "<blockquote><ul><li>a</li><li>b</li></ul></blockquote>");
  assert.equal(md("a\n\n---\n***\nb"), "<p>a</p><hr><hr><p>b</p>");
  assert.equal(md("| A | B |\n|:--|--:|\n| 1 | `x|y` |\n| 2 |"),
    '<div class="md-table"><table><thead><tr><th>A</th><th class="md-right">B</th></tr></thead><tbody><tr><td>1</td><td class="md-right"><code>x|y</code></td></tr><tr><td>2</td><td class="md-right"></td></tr></tbody></table></div>');
  assert.equal(md("a | b is no table"), "<p>a | b is no table</p>");
  assert.equal(md("[docs](https://example.com/a?b=1&c=2) and https://example.com/x_y(z). End"),
    '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a> and <a href="https://example.com/x_y(z)" target="_blank" rel="noopener noreferrer">https://example.com/x_y(z)</a>. End</p>');
  assert.equal(md("(see https://example.com/a)"), '<p>(see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>)</p>');
  assert.equal(md("![shot](https://example.com/a.png)"), '<p><a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">shot</a></p>', "a picture is a link: nothing is loaded from elsewhere");
  assert.equal(md(""), "");
  assert.equal(md(null), "");
  assert.equal(md("tab\there"), "<p>tab    here</p>");

  // ---------- markdown: what it must not let through ----------
  assert.equal(md("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(md('<img src=x onerror="alert(1)">'), "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
  assert.equal(md("[x](javascript:alert(1))"), "<p>x</p>", "not http(s): the label, no link");
  assert.equal(md("[x](JaVaScRiPt:alert(1)) [y](data:text/html,<b>) [z](vbscript:x) [w](file:///etc/passwd)"), "<p>x y z w</p>");
  assert.ok(!md('[x](https://example.com/" onclick="alert(1))').includes('" onclick'), "a quote in an address ends no attribute");
  assert.ok(!md("[x](https://example.com/'onmouseover='alert(1))").includes("'onmouseover"));
  assert.ok(!/<a[^>]*javascript/i.test(md("[a](https://ok.example/)[b](javascript:1)")));
  assert.equal(md("```\n</code></pre><script>x</script>\n```"), '<pre class="md-code"><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>');
  assert.equal(md("| <b> |\n|---|\n| <i onclick=x> |"), '<div class="md-table"><table><thead><tr><th>&lt;b&gt;</th></tr></thead><tbody><tr><td>&lt;i onclick=x&gt;</td></tr></tbody></table></div>');
  assert.equal(md("\u00000\u0000 and \u0000x"), "<p>0 and x</p>", "the renderer's own placeholders cannot be written by the source");
  assert.equal(md("# <h1 onclick=x>"), '<div class="md-h md-h1" role="heading" aria-level="1">&lt;h1 onclick=x&gt;</div>');
  assert.equal(md("1000000000000000000000. big"), "<p>1000000000000000000000. big</p>");
  // Deep nesting ends in plain text, not in a stack overflow; a long answer is rendered in no time.
  check(renderMarkdown("> ".repeat(500) + "deep"), "deep quotes");
  check(renderMarkdown(Array.from({ length: 300 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n")), "deep lists");
  const t0 = Date.now();
  check(renderMarkdown(("**a** `b` [c](https://example.com) _d_ | e |\n".repeat(40) + "\n```\ncode\n```\n").repeat(40)), "a long answer");
  check(renderMarkdown("*".repeat(20000) + "[".repeat(20000) + "`".repeat(20001) + "_".repeat(20000)), "nothing but marks");
  assert.ok(Date.now() - t0 < 3000, "rendering stays fast");
  // Strings put together from hostile pieces: the result holds nothing but the renderer's own tags (check()).
  const PIECES = ["<script>", "</script>", "<img src=x onerror=alert(1)>", "\"", "'", "&", "&lt;", "<", ">", "`", "``", "```", "~~~", "*", "**", "_", "__", "~~", "[", "]", "(", ")",
    "](", "![", "javascript:", "https://e.example/", "http://e.example/?a=\"b\"&c=<d>", "data:text/html,", "\n", "\n\n", "| ", " |", "|---|", "- ", "1. ", "> ", "# ", "    ", "\\", "\u0000", "0",
    " onclick=\"x\" ", "</a>", "<a href=\"javascript:x\">", "</code></pre>", "<!--", "-->", "&#x3c;", "\t", "x", " "];
  let seed = 12345;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let n = 0; n < 4000; n++) {
    let s = "";
    for (let k = 2 + rnd(14); k > 0; k--) s += PIECES[rnd(PIECES.length)];
    md(s);
  }

  // ---------- the path pasted for a file ----------
  assert.equal(terminalFilePath("C:\\Temp\\agentdeck-paste\\a.jpg"), "C:/Temp/agentdeck-paste/a.jpg");
  assert.equal(terminalFilePath("C:\\Temp\\my files\\a b.jpg"), '"C:/Temp/my files/a b.jpg"');
  assert.equal(terminalFilePath("\\\\server\\share\\a.jpg"), "//server/share/a.jpg");
  assert.equal(terminalFilePath("/tmp/agentdeck-paste/a\\b.jpg"), "/tmp/agentdeck-paste/a\\b.jpg", "a POSIX path keeps its backslash");
  assert.equal(terminalFilePath("/tmp/with space/a.jpg"), '"/tmp/with space/a.jpg"');

  // ---------- a picture's size and name ----------
  assert.deepEqual(fitSize(4000, 3000), { w: 2000, h: 1500, k: 0.5 });
  assert.deepEqual(fitSize(3000, 4000), { w: 1500, h: 2000, k: 0.5 });
  assert.deepEqual(fitSize(800, 600), { w: 800, h: 600, k: 1 }, "never enlarged");
  assert.deepEqual(fitSize(10000, 10), { w: 2000, h: 2, k: 0.2 });
  assert.equal(pictureName("IMG_0001.HEIC", true), "IMG_0001.jpg");
  assert.equal(pictureName("shot.PNG", false), "shot.png");
  assert.equal(pictureName("C:\\x\\photo.bmp", true), "photo.jpg");
  assert.equal(pictureName("", true, 42), "picture-42.jpg");
  assert.equal(pictureName("noext", false), "noext.png");
  assert.equal(sizeText(142505), "139 KB");
  assert.equal(sizeText(3 * 1024 * 1024), "3.0 MB");

  console.log("mobile text: markdown (blocks, inline, hostile input, 4000 mixed strings), the pasted path, picture size and name - passed");
})().catch(e => { console.error(e); process.exit(1); });
