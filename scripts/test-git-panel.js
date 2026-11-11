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
let menuItems = [], executed = [], opened = [];
const ctx = {
  $: element, document: { querySelectorAll: () => buttons },
  localStorage: { getItem: () => 'git', setItem() {} },
  normPath: p => p.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''),
  data: { projects: [{ n: 'c:/app', path: 'C:/app' }, { n: 'node:remote:c:/app', path: 'C:/app', node: 'remote' }] },
  ws: { spaces: { 'c:/app': { tabs: ['local-tab'] }, 'node:remote:c:/app': { tabs: ['remote-tab'] } }, tabs: { 'local-tab': {}, 'remote-tab': {} }, terminals: [] },
  git: state, nodes: [{ id: 'remote', name: 'REMOTE', status: 'offline', git: state }],
  t: k => k, gitText: k => k, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  icon: () => '', gitHead: r => r.branch, gitCounts: () => [], gitAb: () => '', toast: e => { throw new Error(e); },
  groupMenu: { classList: { add() {} } }, openGroupMenu: (_button, _path, items) => { menuItems = items; },
  window: { gitWorkflow: { open: (...args) => { opened.push(args); } }, manager: { refreshGit: async force => { refreshed = force; }, getGit: async () => state, gitExecute: async (node, args) => { executed.push({ node, ...args }); } } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/git-panel.js'), 'utf8'), ctx);
assert.equal(element('gitRepoCount').textContent, 4, 'same paths on different computers stay separate');
assert.match(element('gitRepositories').innerHTML, /backend/);
assert.match(element('gitRepositories').innerHTML, /frontend/);
assert.match(element('gitRepositories').innerHTML, /REMOTE/);
assert.match(element('gitRepositories').innerHTML, /git-file-group/);
assert.match(element('gitRepositories').innerHTML, /data-repo-action="commit"/);
assert.match(element('gitRepositories').innerHTML, /data-repo-menu/);
assert.match(element('gitRepositories').innerHTML, /data-file-menu/);
assert.doesNotMatch(element('gitRepositories').innerHTML, /type="checkbox"|data-repo-action="manage"|git-repo-location/);
assert.doesNotMatch(element('gitRepositories').innerHTML, /class="git-repository[^>]*\sopen>/, 'repositories start folded');
const repoKey = JSON.stringify(['local', 'C:/app/backend']);
const fileButton = { dataset: {}, closest: selector => selector === '[data-repo]' ? { dataset: { repo: repoKey } } : selector === '[data-file]' ? { dataset: { file: 'src/<script>.js' } } : { dataset: { group: 'changes' } } };
element('gitRepositories').listeners.click({ target: { closest: () => fileButton }, preventDefault() {}, stopPropagation() {} });
assert.equal(menuItems[0].label, 'stageFile');
assert.equal(menuItems[1].label, 'editor');
state.repos.one.fileCount = 2500; state.repos.one.filesTruncated = true;
ctx.window.gitPanel.render();
assert.match(element('gitRepositories').innerHTML, />2500<\/span>/);
element('gitFilter').oninput({ target: { value: 'not-present' } });
assert.doesNotMatch(element('gitRepositories').innerHTML, /data-diff-file/);
element('gitFilter').oninput({ target: { value: '' } });
element('gitTreeToggle').onclick();
assert.match(element('gitRepositories').innerHTML, /git-folder/);
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
assert.equal(element('gitRepoCount').textContent, 1, 'a terminal brings the repository it is in, not its neighbours');
ctx.ws.terminals[0].cwd = 'C:/app';
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 2, 'a terminal in a folder of repositories brings the ones right inside it');
ctx.ws.terminals[0].cwd = 'C:/';
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'a terminal far above brings none of the repositories below');
ctx.ws.terminals[0].cwd = 'C:/application';
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'path prefix must end at directory boundary');
ctx.ws.tabs = {};
ctx.window.gitPanel.render();
assert.equal(element('gitRepoCount').textContent, 0, 'unattached terminal does not keep a repository visible');
element('gitPanelRefresh').onclick().then(async () => {
  assert.equal(refreshed, true);
  assert.equal(element('gitPanelRefresh').disabled, false);
  ctx.ws.spaces['c:/app'].tabs = ['local-tab']; ctx.ws.tabs = { 'local-tab': {} };
  ctx.window.gitPanel.render(); element('gitPanelMenu').onclick();
  await menuItems.find(item => item.label === 'push').run();
  assert.deepEqual(opened.at(-1), ['', 'C:/app/backend', 'sync']);
  assert.equal(executed.length, 0, 'unpublished branches ask for the remote before pushing');
  state.repos.one.upstream = 'origin/main'; ctx.window.gitPanel.render(); element('gitPanelMenu').onclick();
  await menuItems.find(item => item.label === 'push').run();
  assert.equal(executed.at(-1).action, 'push', 'tracked branches still push directly');
  // Group by Project: a worktree beside its main checkout goes under that checkout's project.
  const saved = new Map();
  ctx.localStorage.setItem = (k, v) => saved.set(k, v);
  ctx.data.projects[0].name = 'App';
  state.repos.three = { root: 'C:/app-wt', mainRoot: 'C:/app/backend', branch: 'fix', files: [] };
  ctx.ws.tabs = { 'local-tab': {}, wt: { root: { term: 'w' } } };
  ctx.ws.terminals = [{ id: 'w', cwd: 'C:/app-wt' }];
  ctx.window.gitPanel.render();
  assert.doesNotMatch(element('gitRepositories').innerHTML, /git-project-head/, 'not grouped unless chosen');
  element('gitPanelMenu').onclick();
  await menuItems.find(item => item.label === 'byProject').run();
  const html = element('gitRepositories').innerHTML;
  assert.equal(saved.get('agentdeck.gitByProject'), '1');
  assert.equal(html.match(/git-project-head/g).length, 1, 'the worktree joins the project of its main checkout');
  assert.match(html, /<details class="git-project" data-expand="project:c:\/app" open><summary class="git-project-head"><span class="git-chevron"><\/span><span>App<\/span><span class="git-count">3</);
  // A project group folds, and stays folded on the next render.
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: 'project:c:/app' }, open: false } });
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /<details class="git-project" data-expand="project:c:\/app" >/);
  console.log('Git sidebar tabs, local/remote identity, offline state, filename escaping and refresh passed');
}).catch(e => { console.error(e); process.exitCode = 1; });
