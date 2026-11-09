// Escaped, read-only unified patches. No repository content becomes executable markup.
function gitHighlight(line) {
  // Lightweight escaped lexical highlighting; repository text is never HTML.
  return line.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|class|if|else|async|await|import|export|from|def|for|while|true|false|null|None)\b|\b\d+(?:\.\d+)?\b|\/\/.*$)/g).map((part, i) => i % 2 ? `<span class="git-token">${esc(part)}</span>` : esc(part)).join('');
}
function renderGitPatch(patch) {
  let oldLine = null, newLine = null;
  return patch.split("\n").map(line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    let kind = "meta", before = "", after = "";
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); kind = "hunk"; }
    else if (oldLine !== null) {
      if (line.startsWith("+")) { kind = "add"; after = newLine++; }
      else if (line.startsWith("-")) { kind = "remove"; before = oldLine++; }
      else if (line.startsWith(" ")) { kind = "context"; before = oldLine++; after = newLine++; }
    } else if (line.startsWith("+") && !line.startsWith("+++")) kind = "add";
    return `<span class="diff-line ${kind}"><span class="diff-number">${before}</span><span class="diff-number">${after}</span><span class="diff-code">${gitHighlight(line)}</span></span>`;
  }).join("");
}
function renderGitSplit(patch) {
  let oldLine = null, newLine = null, removed = [], added = [], rows = [];
  const cell = (text, number, kind) => `<td class="${kind}"><span class="diff-number">${number ?? ''}</span><code>${gitHighlight(text || '')}</code></td>`;
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push(`<tr>${cell(removed[i]?.text, removed[i]?.number, removed[i] ? 'remove' : '')}${cell(added[i]?.text, added[i]?.number, added[i] ? 'add' : '')}</tr>`);
    removed = []; added = [];
  };
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); rows.push(`<tr><td colspan="2" class="hunk">${esc(line)}</td></tr>`); }
    else if (oldLine !== null && line.startsWith('-')) removed.push({ text: line.slice(1), number: oldLine++ });
    else if ((oldLine !== null || !line.startsWith('+++')) && line.startsWith('+')) added.push({ text: line.slice(1), number: newLine === null ? '' : newLine++ });
    else { flush(); if (oldLine !== null && line.startsWith(' ')) rows.push(`<tr>${cell(line.slice(1), oldLine++, '')}${cell(line.slice(1), newLine++, '')}</tr>`); else rows.push(`<tr><td colspan="2">${esc(line)}</td></tr>`); }
  }
  flush(); return `<table class="git-split"><tbody>${rows.join('')}</tbody></table>`;
}
(() => {
  const dialog = $("gitDiffDialog"), body = $("gitDiffBody");
  let generation = 0;
  let current = null, resultCache = null, split = false;
  const tools = $('gitDiffTools');
  $('gitDiffIcon').innerHTML = icon('file');
  const note = key => `<p class="git-panel-note">${esc(t(key))}</p>`;
  const diffButton = (action, label, glyph, disabled = false) => `<button class="btn git-diff-btn" data-diff-action="${action}" title="${esc(label)}" ${disabled ? 'disabled' : ''}>${icon(glyph)}<span>${esc(label)}</span></button>`;
  // The tools, grouped: go between files, reload, the layout, and the editor.
  function renderTools() {
    if (!current) return;
    tools.innerHTML = `${diffButton('previous', gitText('previous'), 'left')}${diffButton('next', gitText('next'), 'right')}<span class="tb-sep"></span>${diffButton('refresh', gitText('refresh'), 'refresh')}<span class="tb-sep"></span>${diffButton('split', gitText(split ? 'unified' : 'split'), split ? 'splitDown' : 'splitRight')}<span class="grow"></span>${diffButton('editor', gitText('editor'), 'open', Boolean(current.node))}`;
  }
  $("gitDiffClose").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { generation++; });
  function renderResult(result) {
    const sections = [["staged", "git.diff.staged", "check"], ["unstaged", "git.diff.unstaged", "pencil"], ["untracked", "git.diff.new", "plus"]];
    body.innerHTML = sections.filter(([key]) => result[key]).map(([key, titleKey, glyph]) => {
      const [title, detail] = t(titleKey).split(" · ");
      return `<section class="diff-section ${key}"><h3><span class="diff-badge">${icon(glyph)}</span><span>${esc(title)}</span>${detail ? `<small>${esc(detail)}</small>` : ""}</h3>${split ? renderGitSplit(result[key]) : `<pre class="diff-patch">${renderGitPatch(result[key])}</pre>`}</section>`;
    }).join('')
      + (result.tooLarge ? note('git.diff.tooLarge') : '') + (result.binary ? note('git.diff.binary') : '') + (result.emptyFile ? note('git.diff.emptyFile') : '');
    if (!body.innerHTML) body.innerHTML = note('git.diff.empty');
  }
  async function load() {
    if (!current) return;
    const { node, root, file } = current;
    const request = ++generation;
    resultCache = null;
    $('gitDiffTitle').textContent = file;
    $('gitDiffLocation').textContent = `${node ? nodeNameOf(node) : t('git.panel.local')} · ${root}`;
    body.innerHTML = note('git.diff.loading');
    renderTools();
    try {
      const result = await window.manager.getGitDiff(node, root, file);
      if (request !== generation || !dialog.open) return;
      resultCache = result; renderResult(result);
    } catch (error) { if (request === generation && dialog.open) body.textContent = error.message; }
  }
  tools.addEventListener('click', async e => {
    const action = e.target.closest('[data-diff-action]')?.dataset.diffAction;
    if (!action || !current) return;
    if (action === 'refresh') return load();
    if (action === 'split') { split = !split; renderTools(); if (resultCache) renderResult(resultCache); return; }
    if (action === 'editor') {
      try { await window.manager.gitOpenFile(current.node, current.root, current.file); } catch (error) { toast(error.message, true); } return;
    }
    const files = [...new Set([...$('gitRepositories').querySelectorAll('[data-diff-file]')].filter(b => b.dataset.diffRoot === current.root && b.dataset.diffNode === current.node).map(b => b.dataset.diffFile))];
    const index = files.indexOf(current.file), next = index + (action === 'next' ? 1 : -1);
    if (next >= 0 && next < files.length) { current.file = files[next]; await load(); }
  });
  $("gitRepositories").addEventListener("click", async e => {
    const button = e.target.closest("[data-diff-file]");
    if (!button || button.disabled) return;
    const { diffNode: node, diffRoot: root, diffFile: file } = button.dataset;
    current = { node, root, file };
    dialog.showModal();
    await load();
  });
})();
