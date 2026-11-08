const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const els = new Map();
function element(id) {
  if (!els.has(id)) els.set(id, { innerHTML: '', attributes: {}, listeners: {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, cb) { this.listeners[k] = cb; }, focus() {} });
  return els.get(id);
}
const buttons = ['projects', 'git'].map(name => Object.assign(element(name), { dataset: { sideTab: name } }));
const state = { repos: { one: { root: 'C:/app/backend', branch: 'main', files: [{ path: 'src/<script>.js', status: '.M' }] }, two: { root: 'C:/app/frontend', branch: 'feature', files: [] } } };
let refreshed = false;
const ctx = {
  $: element, document: { querySelectorAll: () => buttons },
  localStorage: { getItem: () => 'git', setItem() {} },
  normPath: p => p.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''),
  data: { projects: [{ n: 'c:/app', path: 'C:/app' }, { n: 'node:remote:c:/app', path: 'C:/app', node: 'remote' }] },
  ws: { spaces: { 'c:/app': { tabs: ['local-tab'] }, 'node:remote:c:/app': { tabs: ['remote-tab'] } }, tabs: { 'local-tab': {}, 'remote-tab': {} }, terminals: [] },
  git: state, nodes: [{ id: 'remote', name: 'REMOTE', status: 'offline', git: state }],
  t: k => k, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  icon: () => '', gitHead: r => r.branch, gitCounts: () => [], gitAb: () => '', toast: e => { throw new Error(e); },
  window: { manager: { refreshGit: async force => { refreshed = force; }, getGit: async () => state } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/git-panel.js'), 'utf8'), ctx);
assert.equal(element('gitRepoCount').textContent, 4, 'same paths on different computers stay separate');
assert.match(element('gitRepositories').innerHTML, /backend/);
assert.match(element('gitRepositories').innerHTML, /frontend/);
assert.match(element('gitRepositories').innerHTML, /REMOTE/);
assert.match(element('gitRepositories').innerHTML, /git-repository offline/);
assert.doesNotMatch(element('gitRepositories').innerHTML, /<script>/);
assert.equal(element('sideOverview').hidden, true);
assert.equal(element('sideGit').hidden, false);
buttons[0].onclick();
assert.equal(element('sideOverview').hidden, false);
assert.equal(element('sideGit').hidden, true);
assert.equal(element('sideAgents').hidden, undefined, 'agents remain alongside projects');
buttons[1].onclick();
ctx.ws.spaces['c:/app'].tabs = [];
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 2, 'closing project tabs removes its repos');
ctx.ws.spaces['node:remote:c:/app'].tabs = [];
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'no open projects means no repos');
ctx.ws.tabs = { terminal: { root: { term: 't' } } };
ctx.ws.terminals = [{ id: 't', cwd: 'C:/app/backend/src' }];
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 2, 'attached terminal includes all repos of its project');
ctx.ws.terminals[0].cwd = 'C:/application';
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'path prefix must end at directory boundary');
ctx.ws.tabs = {};
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'unattached terminal does not keep a repository visible');
element('gitPanelRefresh').onclick().then(() => {
  assert.equal(refreshed, true);
  assert.equal(element('gitPanelRefresh').disabled, false);
  console.log('Git sidebar tabs, local/remote identity, offline state, filename escaping and refresh passed');
}).catch(e => { console.error(e); process.exitCode = 1; });
