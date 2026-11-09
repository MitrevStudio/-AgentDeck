const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const elements = new Map(), queries = [], commands = [], launches = [];
function el(id) {
  if (!elements.has(id)) elements.set(id, { value: '', textContent: '', innerHTML: '', open: false, disabled: false, listeners: {}, children: [], dataset: {},
    setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener(k, f) { this.listeners[k] = f; }, showModal() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); } });
  return elements.get(id);
}
const details = { status: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }, branches: ['main'], remotes: ['origin'], worktrees: [{ path: '/repo', branch: 'main', active: [], sessions: [] }], operation: '' };
const ctx = { $: el, esc: s => String(s).replaceAll('<', '&lt;').replaceAll('"', '&quot;'), renderGitPatch: s => s, icon: () => '', confirm: () => true,
  window: { manager: {
    gitQuery: async (node, args) => { queries.push({ node, ...args }); return args.kind === 'details' ? details : { patch: 'review patch', token: 'review-token' }; },
    gitExecute: async (node, args) => { commands.push({ node, ...args }); return { path: '/task', output: 'done' }; },
    remoteLaunch: async (node, args) => { launches.push({ node, ...args }); }
  } }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/git-workflow.js'), 'utf8'), ctx);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function click(name) {
  el('gitActionsBody').listeners.click({ target: { closest: () => ({ dataset: { gitAction: name } }) } }); await tick();
}
async function main() {
  const sections = Array.from({ length: 4 }, () => ({ tagName: 'SECTION', hidden: false }));
  el('gitActionsBody').children = [{ tagName: 'P' }, ...sections];
  el('gitActionsBody').querySelectorAll = selector => selector === ':scope > section' ? sections : [];
  await ctx.window.gitWorkflow.open('remote', '/repo', true);
  assert.equal(sections.filter(s => !s.hidden).length, 1);
  assert.equal(sections[1].hidden, false, 'only commit section is visible');
  assert.equal(queries[0].node, 'remote'); assert.equal(queries[0].root, '/repo');
  assert.match(el('gitCommitReview').innerHTML, /review patch/);
  assert.equal(el('gitCommitSubmit').disabled, true, 'a message is required before submitting');
  el('gitCommitMessage').value = 'Reviewed commit'; el('gitCommitMessage').oninput();
  assert.equal(el('gitCommitSubmit').disabled, false);
  await el('gitCommitSubmit').onclick();
  assert.equal(commands[0].token, 'review-token'); assert.equal(commands[0].message, 'Reviewed commit');
  assert.equal(el('gitCommitMessage').value, '', 'successful commit clears the draft');
  el('gitCommitMessage').value = 'Keep this draft'; el('gitCommitMessage').oninput();
  await click('preview'); assert.equal(el('gitCommitMessage').value, 'Keep this draft');
  details.operation = 'cherry-pick';
  const operation = { tagName: 'SECTION', hidden: false };
  const originalSelector = el('gitActionsBody').querySelectorAll;
  el('gitActionsBody').querySelectorAll = selector => selector === ':scope > section' ? [operation, ...sections] : [];
  await ctx.window.gitWorkflow.open('remote', '/repo', 'branches');
  assert.equal(operation.hidden, false, 'operation controls stay visible outside sync');
  assert.equal(sections[0].hidden, false);
  details.operation = ''; el('gitActionsBody').querySelectorAll = originalSelector;
  await ctx.window.gitWorkflow.open('remote', '/repo', 'worktrees');
  assert.equal(sections[3].hidden, false, 'only worktrees section is visible');
  el('gitTaskBranch').value = 'task'; el('gitTaskPath').value = '/task'; el('gitTaskAgent').value = 'Codex'; el('gitTaskBase').value = 'main';
  await click('task');
  assert.equal(commands.at(-1).action, 'worktree-add'); assert.equal(launches[0].cwd, '/task'); assert.equal(launches[0].node, 'remote');
  ctx.window.manager.gitExecute = async () => { throw new Error('remote offline'); };
  await click('fetch'); assert.equal(el('gitActionsResult').textContent, 'remote offline');
  assert.equal(el('gitActionsDialog').open, true);
  console.log('Git workflow UI: remote routing, reviewed commit token, worktree session launch and visible errors passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
