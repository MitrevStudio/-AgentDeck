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
assert.doesNotMatch(element('gitRepositories').innerHTML, /data-repo-action="manage"|git-repo-location|data-commit-menu/);
assert.match(element('gitRepositories').innerHTML, /git-check-tree/, 'the changes are one list with checkboxes');
assert.match(element('gitRepositories').innerHTML, /type="checkbox" class="git-check"/);
assert.match(element('gitRepositories').innerHTML, /class="git-repository[^>]*\sopen>/, 'without grouping the repositories start open');
const repoKey = JSON.stringify(['local', 'C:/app/backend']);
const fileButton = { dataset: {}, closest: selector => selector === '[data-repo]' ? { dataset: { repo: repoKey } } : selector === '[data-file]' ? { dataset: { file: 'src/<script>.js' } } : { dataset: { group: 'changes' } } };
element('gitRepositories').listeners.click({ target: { closest: () => fileButton }, preventDefault() {}, stopPropagation() {} });
assert.equal(menuItems.map(x => x.label).join(), 'editor', 'a checkbox stages a file: its menu only opens it');
state.repos.one.fileCount = 2500; state.repos.one.filesTruncated = true;
ctx.window.gitPanel.render();
assert.match(element('gitRepositories').innerHTML, />2500<\/span>/);
element('gitFilter').oninput({ target: { value: 'not-present' } });
assert.doesNotMatch(element('gitRepositories').innerHTML, /data-diff-file/);
element('gitFilter').oninput({ target: { value: '' } });
// A checkbox names what it stands for; the paths are looked up when it is clicked, and only those that change are sent.
assert.doesNotMatch(element('gitRepositories').innerHTML, /data-paths/);
state.repos.one.files = [{ path: 'src/<script>.js', status: '.M' }, { path: 'src/deep/staged.js', status: 'M.' }, { path: 'src/deep/part.js', status: 'MM' }, { path: 'docs/new.md', status: '??' }];
ctx.window.gitPanel.render();
const check = (scope, checkPath, checked) => element('gitRepositories').listeners.change({ target: { closest: () => ({ checked, dataset: { check: scope, checkPath }, closest: () => ({ dataset: { repo: repoKey } }) }) } });
check('folder', 'src', true);
assert.deepEqual({ ...executed.at(-1) }, { node: '', root: 'C:/app/backend', action: 'stage', files: ['src/<script>.js', 'src/deep/part.js'] }, 'a folder stages what is not staged in whole');
executed.length = 0;
// The folder view: the button above the list sets it for every repository, a repository's own menu for that one. Folders
// start open, a chain of single folders shares a row, and a filter opens what the user folded.
const repoMenuButton = { dataset: { repoMenu: '' }, closest: selector => selector === '[data-repo]' ? { dataset: { repo: repoKey } } : null };
const openRepoMenu = () => element('gitRepositories').listeners.click({ target: { closest: () => repoMenuButton }, preventDefault() {}, stopPropagation() {} });
openRepoMenu();
assert.equal(menuItems[0].label, 'asTree');
assert.equal(menuItems[0].checked, false);
assert.doesNotMatch(menuItems.map(x => x.label).join(), /(commit|stageAll|unstageAll|branches|sync|history)/, 'nothing the row has a button for');
assert.doesNotMatch(element('gitRepositories').innerHTML, /git-check-folder/);
element('gitTreeToggle').onclick();
assert.equal(element('gitTreeToggle').attributes['aria-pressed'], 'true');
assert.match(element('gitRepositories').innerHTML, /<details class="git-folder git-check-folder" data-expand="[^"]*" open>/, 'folders start open');
assert.match(element('gitRepositories').innerHTML, /data-check="folder" data-check-path="src\/deep"/);
const folderId = JSON.stringify([repoKey, 'folder', 'src']);
element('gitRepositories').listeners.toggle({ target: { dataset: { expand: folderId }, open: false } });
ctx.window.gitPanel.render();
assert.match(element('gitRepositories').innerHTML, /folder&quot;,&quot;src&quot;\]" ><summary>/, 'a folded folder stays folded');
element('gitFilter').oninput({ target: { value: 'script' } });
assert.match(element('gitRepositories').innerHTML, /folder&quot;,&quot;src&quot;\]" open><summary>/, 'a filter opens the folders that hold what it found');
element('gitFilter').oninput({ target: { value: '' } });
openRepoMenu();
assert.equal(menuItems[0].checked, true, 'the repository follows the button');
menuItems[0].run();
assert.doesNotMatch(element('gitRepositories').innerHTML.split('C:/app/frontend')[0], /git-check-folder/, 'one repository apart from the others');
element('gitPanelMenu').onclick();
assert.equal(menuItems[0].label, 'asTree');
assert.equal(menuItems[0].checked, true);
menuItems[0].run();
element('gitPanelMenu').onclick();
menuItems[0].run();
assert.match(element('gitRepositories').innerHTML.split('C:/app/frontend')[0], /git-check-folder/, 'the view menu sets all of them, the one that differed too');
element('gitTreeToggle').onclick();
assert.doesNotMatch(element('gitRepositories').innerHTML, /git-check-folder/);
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
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
element('gitPanelRefresh').onclick().then(async () => {
  assert.equal(refreshed, true);
  assert.equal(element('gitPanelRefresh').disabled, false);
  ctx.ws.spaces['c:/app'].tabs = ['local-tab']; ctx.ws.tabs = { 'local-tab': {} };
  ctx.window.gitPanel.render(); openRepoMenu();
  await menuItems.find(item => item.label === 'push').run();
  assert.deepEqual(opened.at(-1), ['', 'C:/app/backend', 'sync']);
  assert.equal(executed.length, 0, 'unpublished branches ask for the remote before pushing');
  state.repos.one.upstream = 'origin/main'; ctx.window.gitPanel.render(); openRepoMenu();
  await menuItems.find(item => item.label === 'push').run();
  assert.equal(executed.at(-1).action, 'push', 'tracked branches still push directly');
  check('all', '', false);
  await settle();
  assert.deepEqual(executed.at(-1).files, ['src/deep/staged.js', 'src/deep/part.js'], 'unticking the root takes out what is staged, an untracked file aside');
  check('file', 'docs/new.md', true);
  await settle();
  assert.deepEqual(executed.at(-1).files, ['docs/new.md']);
  // Commit sends what is staged: a file changed again since it was staged is not staged again behind the user's back.
  ctx.window.manager.gitQuery = async () => ({ token: 'reviewed' });
  element('gitRepositories').listeners.input({ target: { dataset: { commitMessage: repoKey }, value: 'A message', parentElement: { querySelector: () => ({}) }, closest: () => ({ querySelector: () => null }) } });
  const before = executed.length;
  const commitButton = { dataset: { repoAction: 'commit' }, closest: selector => selector === '[data-repo]' ? { dataset: { repo: repoKey } } : null };
  element('gitRepositories').listeners.click({ target: { closest: () => commitButton }, preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.deepEqual(executed.slice(before).map(x => [x.action, x.token]), [['commit', 'reviewed']], 'commit stages nothing by itself');
  state.repos.one.files = [{ path: 'src/<script>.js', status: '.M' }];
  // Group by Project: a worktree beside its main checkout goes under that checkout's project.
  const saved = new Map();
  ctx.localStorage.setItem = (k, v) => saved.set(k, v);
  ctx.data.projects[0].name = 'App';
  state.repos.three = { root: 'C:/app-wt', mainRoot: 'C:/app/backend', branch: 'fix', files: [] };
  ctx.ws.tabs = { 'local-tab': {}, wt: { root: { term: 'w' } } };
  ctx.ws.terminals = [{ id: 'w', cwd: 'C:/app-wt' }];
  ctx.window.gitPanel.render();
  assert.doesNotMatch(element('gitRepositories').innerHTML, /git-project-head/, 'not grouped unless chosen');
  // Drawn open in the plain list, a repository reports itself opened; that must not open it inside a group.
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: repoKey }, open: true } });
  element('gitPanelMenu').onclick();
  await menuItems.find(item => item.label === 'byProject').run();
  const html = element('gitRepositories').innerHTML;
  assert.equal(saved.get('agentdeck.gitByProject'), '1');
  assert.equal(html.match(/git-project-head/g).length, 1, 'the worktree joins the project of its main checkout');
  assert.doesNotMatch(html, /class="git-repository[^>]*\sopen>/, 'inside a project group the repositories start folded');
  assert.match(html, /<details class="git-project" data-expand="project:c:\/app" ><summary class="git-project-head"><span class="git-chevron"><\/span><span>App<\/span><span class="git-count">3</);
  // A worktree that is a project of its own, its main checkout in none: under its own project, not a made-up group.
  ctx.data.projects.push({ n: 'c:/feature-wt', name: 'Feature', path: 'C:/feature-wt' });
  state.repos.four = { root: 'C:/feature-wt', mainRoot: 'C:/elsewhere/main', branch: 'feature', files: [] };
  ctx.ws.terminals.push({ id: 'f', cwd: 'C:/feature-wt' });
  ctx.ws.tabs.fw = { root: { term: 'f' } };
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /data-expand="project:c:\/feature-wt" ><summary class="git-project-head"><span class="git-chevron"><\/span><span>Feature</);
  assert.doesNotMatch(element('gitRepositories').innerHTML, /project:c:\/elsewhere/);
  // A project group starts folded; opened, it stays open on the next render.
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: 'project:c:/app' }, open: true } });
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /<details class="git-project" data-expand="project:c:\/app" open>/);
  console.log('Git sidebar tabs, local/remote identity, offline state, filename escaping, checkboxes, the folder view and refresh passed');
}).catch(e => { console.error(e); process.exitCode = 1; });
