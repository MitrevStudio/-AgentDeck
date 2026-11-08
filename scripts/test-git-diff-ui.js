const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const elements = new Map(), requests = [];
const el = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', open: false, listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, showModal() { this.open = true; }, close() { this.open = false; this.listeners.close(); } });
  return elements.get(id);
};
const ctx = {
  $: el, t: s => s, nodeNameOf: () => 'REMOTE',
  esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  window: { manager: { getGitDiff: (...args) => new Promise(resolve => requests.push({ args, resolve })) } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/git-diff-ui.js'), 'utf8'), ctx);
async function main() {
  const rendered = ctx.renderGitPatch('@@ -2,1 +2,1 @@\n-<script>bad</script>\n+safe');
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /diff-line remove/);
  assert.match(rendered, /diff-line add/);
  assert.match(rendered, /diff-number">2/);
  const button = { dataset: { diffNode: 'remote', diffRoot: '/repo', diffFile: 'file.txt' } };
  const click = () => el('gitRepositories').listeners.click({ target: { closest: () => button } });
  const first = click();
  assert.deepEqual(requests[0].args, ['remote', '/repo', 'file.txt']);
  el('gitDiffDialog').close();
  const second = click();
  requests[0].resolve({ staged: 'obsolete result' }); await first;
  assert.doesNotMatch(el('gitDiffBody').innerHTML, /obsolete/);
  requests[1].resolve({ staged: '@@ -1 +1 @@\n-old\n+new', unstaged: '@@ -1 +1 @@\n-new\n+working' }); await second;
  assert.match(el('gitDiffBody').innerHTML, /git.diff.staged/);
  assert.match(el('gitDiffBody').innerHTML, /git.diff.unstaged/);
  assert.match(el('gitDiffBody').innerHTML, /\+working/);
  el('gitDiffDialog').close();
  console.log('Read-only diff escaping, line numbers, remote requests and stale-response protection passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
