const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let els = new Map();
function element(id) {
  if (!els.has(id)) els.set(id, { innerHTML: '', attributes: {}, listeners: {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener(k, cb) { this.listeners[k] = cb; }, focus() {} });
  return els.get(id);
}
const buttons = ['projects', 'git'].map(name => Object.assign(element(name), { dataset: { sideTab: name } }));
const state = { repos: { one: { root: 'C:/app/backend', branch: 'main', files: [{ path: 'src/<script>.js', status: '.M' }] }, two: { root: 'C:/app/frontend', branch: 'feature', files: [] } } };
let refreshed = false;
let menuItems = [], executed = [], opened = [], prefsChanged = null;
const source = fs.readFileSync(path.join(__dirname, '../src/git-panel.js'), 'utf8');
const ctx = {
  $: element, document: { querySelectorAll: () => buttons },
  localStorage: { getItem: key => (key === 'agentdeck.sidebarTab' ? 'git' : null), setItem() {} },
  normPath: p => p.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''),
  data: { projects: [{ n: 'c:/app', path: 'C:/app' }, { n: 'node:remote:c:/app', path: 'C:/app', node: 'remote' }] },
  ws: { spaces: { 'c:/app': { tabs: ['local-tab'] }, 'node:remote:c:/app': { tabs: ['remote-tab'] } }, tabs: { 'local-tab': {}, 'remote-tab': {} }, terminals: [] },
  git: state, nodes: [{ id: 'remote', name: 'REMOTE', status: 'offline', git: state }],
  t: k => k, tn: (k, n) => `${k}:${n}`, gitText: k => k, esc: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  icon: () => '', gitHead: r => r.branch, gitCounts: () => [], gitAb: () => '', toast: e => { throw new Error(e); },
  groupMenu: { classList: { add() {} } }, openGroupMenu: (_button, _path, items) => { menuItems = items; },
  window: { prefs: { gitScope: 'open', onChanged: cb => { prefsChanged = cb; } }, gitWorkflow: { open: (...args) => { opened.push(args); } }, manager: { refreshGit: async force => { refreshed = force; }, getGit: async () => state, gitExecute: async (node, args) => { executed.push({ node, ...args }); } } },
};
vm.runInNewContext(source, ctx);
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
// The folder view is a repository's own, set in its menu (the panel has no switch for all of them). Folders start open,
// a chain of single folders shares a row, and a filter opens what the user folded.
const repoMenuButton = { dataset: { repoMenu: '' }, closest: selector => selector === '[data-repo]' ? { dataset: { repo: repoKey } } : null };
const openRepoMenu = () => element('gitRepositories').listeners.click({ target: { closest: () => repoMenuButton }, preventDefault() {}, stopPropagation() {} });
openRepoMenu();
assert.equal(menuItems[0].label, 'asTree');
assert.equal(menuItems[0].checked, false);
assert.doesNotMatch(menuItems.map(x => x.label).join(), /(commit|stageAll|unstageAll|branches|sync|history)/, 'nothing the row has a button for');
assert.doesNotMatch(element('gitRepositories').innerHTML, /git-check-folder/);
menuItems[0].run();
assert.match(element('gitRepositories').innerHTML, /<details class="git-folder git-check-folder" data-expand="[^"]*" open>/, 'folders start open');
assert.match(element('gitRepositories').innerHTML, /data-check="folder" data-check-path="src\/deep"/);
const folderId = JSON.stringify([repoKey, 'folder', 'src']);
element('gitRepositories').listeners.toggle({ target: { dataset: { expand: folderId }, open: false } });
ctx.window.gitPanel.render();
assert.match(element('gitRepositories').innerHTML, /folder&quot;,&quot;src&quot;\]" ><summary>/, 'a folded folder stays folded');
element('gitFilter').oninput({ target: { value: 'script' } });
assert.match(element('gitRepositories').innerHTML, /folder&quot;,&quot;src&quot;\]" open><summary>/, 'a filter opens the folders that hold what it found');
element('gitFilter').oninput({ target: { value: '' } });
element('gitPanelMenu').onclick();
assert.ok(!menuItems.some(x => x.label === 'asTree'), 'no folder view for all repositories');
openRepoMenu();
assert.equal(menuItems[0].checked, true);
menuItems[0].run();
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
// A profile from before: the folder view was on for all repositories, and the filters still hold a removed project
// and a deleted repository.
async function testUpgrade() {
  els = new Map();
  const key = root => JSON.stringify(['local', root]), saved = new Map();
  const stored = {
    'agentdeck.sidebarTab': 'git', 'agentdeck.gitTree': '1', 'agentdeck.gitByProject': '1',
    'agentdeck.gitHiddenProjects': JSON.stringify(['c:/removed', 'c:/work']),
    'agentdeck.gitHiddenRepos': JSON.stringify({ 'c:/removed': [key('C:/removed/app')], 'c:/work': [key('C:/work/deleted-app'), key('C:/work/child-app'), JSON.stringify(['WORK-01', 'D:/src/tool'])] })
  };
  const files = () => [{ path: 'src/deep/a.js', status: '.M' }];
  const repos = { one: { root: 'C:/work/parent-repo', branch: 'main', files: files() }, two: { root: 'C:/work/child-app', branch: 'main', files: files() } };
  let items = [];
  const upgraded = {
    ...ctx, $: element, document: { querySelectorAll: () => [] },
    localStorage: { getItem: k => stored[k] ?? null, setItem: (k, v) => saved.set(k, v) },
    data: { projects: [{ n: 'c:/work', name: 'Work', path: 'C:/work' }] },
    ws: { spaces: {}, tabs: { one: { root: { term: 'a' } }, two: { root: { term: 'b' } } }, terminals: [{ id: 'a', cwd: 'C:/work/parent-repo' }, { id: 'b', cwd: 'C:/work/child-app' }] },
    git: { repos }, nodes: [{ id: 'WORK-01', name: 'WORK-01', status: 'offline' }],
    openGroupMenu: (_button, _path, list) => { items = list; },
    window: { ...ctx.window, prefs: { gitScope: 'all' } }
  };
  vm.runInNewContext(source, upgraded);
  const html = () => element('gitRepositories').innerHTML, parentKey = key('C:/work/parent-repo');
  const listeners = element('gitRepositories').listeners;
  listeners.toggle({ target: { dataset: { expand: `in-project:c:/work:${parentKey}`, repo: parentKey }, open: true, querySelector: () => null } });
  assert.match(html(), /git-check-folder/, 'the folder view stays on after the upgrade');
  const openMenu = () => listeners.click({ target: { closest: () => ({ dataset: { repoMenu: '' }, closest: s => (s === '[data-repo]' ? { dataset: { repo: parentKey } } : null) }) }, preventDefault() {}, stopPropagation() {} });
  openMenu();
  assert.equal(items[0].label, 'asTree');
  assert.equal(items[0].checked, true);
  items[0].run();
  assert.doesNotMatch(html(), /git-check-folder/, 'a repository can be switched to the flat list');
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitRepoViews')), { [parentKey]: { tree: false } });
  openMenu();
  assert.equal(items[0].checked, false);
  items[0].run();
  assert.match(html(), /git-check-folder/, 'and back to the folders');
  assert.equal(saved.get('agentdeck.gitRepoViews'), '{}', 'nothing is kept for a repository on the default view');
  assert.ok(![...saved.keys()].includes('agentdeck.gitTree'), 'the old switch is only read');
  // The filters forget the removed project and the deleted repository as soon as one of them changes; a repository
  // of a computer that reports none now (offline) is kept.
  assert.match(html(), /class="git-count">1\/2</, 'child-app is hidden from Work');
  listeners.click({ target: { closest: s => (s === '[data-project-menu]' ? { dataset: { projectMenu: 'c:/work' } } : null) }, preventDefault() {}, stopPropagation() {} });
  await items.find(x => x.label === 'parent-repo').run();
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenProjects')), ['c:/work']);
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenRepos')), { 'c:/work': [key('C:/work/child-app'), JSON.stringify(['WORK-01', 'D:/src/tool']), parentKey] });
}
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
  assert.match(html, /<details class="git-project" data-expand="project:c:\/app" ><summary class="git-project-head"><span class="git-chevron"><\/span><span>App<\/span><span class="grow"><\/span><span class="git-hover-actions"><button [^>]*data-project-menu="c:\/app"[^>]*><\/button><\/span><span class="git-count">3</);
  // A worktree that is a project of its own, its main checkout in none: under its own project, not a made-up group.
  ctx.data.projects.push({ n: 'c:/feature-wt', name: 'Feature', path: 'C:/feature-wt' });
  state.repos.four = { root: 'C:/feature-wt', mainRoot: 'C:/elsewhere/main', branch: 'feature', files: [] };
  ctx.ws.terminals.push({ id: 'f', cwd: 'C:/feature-wt' });
  ctx.ws.tabs.fw = { root: { term: 'f' } };
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /data-expand="project:c:\/feature-wt" ><summary class="git-project-head"><span class="git-chevron"><\/span><span>Feature</);
  assert.doesNotMatch(element('gitRepositories').innerHTML, /data-project-menu="c:\/elsewhere/, 'a made-up group has no filter menu');
  assert.doesNotMatch(element('gitRepositories').innerHTML, /project:c:\/elsewhere/);
  // A project group starts folded; opened, it stays open on the next render.
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: 'project:c:/app' }, open: true } });
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /<details class="git-project" data-expand="project:c:\/app" open>/);
  // A repository is in the group of every project holding it, each copy folded and opened on its own.
  const esc = ctx.esc, plain = v => JSON.parse(JSON.stringify(v));
  ctx.data.projects.push({ n: 'c:/app/backend', name: 'Backend', path: 'C:/app/backend' });
  ctx.window.gitPanel.render();
  let list = element('gitRepositories').innerHTML;
  const backendKey = JSON.stringify(['local', 'C:/app/backend']), frontendKey = JSON.stringify(['local', 'C:/app/frontend']);
  const expandOf = (project, key) => esc(`in-project:${project}:${key}`);
  assert.ok(list.includes(`data-expand="${expandOf('c:/app', backendKey)}"`), 'backend under App');
  assert.ok(list.includes(`data-expand="${expandOf('c:/app/backend', backendKey)}"`), 'backend under Backend too');
  assert.match(list, /data-expand="project:c:\/app\/backend"/);
  assert.equal(element('gitRepoCount').textContent, 4, 'a repository in two groups counts once');
  // A folded copy in a group is drawn without its body; opened, it gets it.
  const copyOf = (html, id) => html.split(`data-expand="${esc(id)}"`)[1].split('</details>')[0];
  const backendCopy = `in-project:c:/app/backend:${backendKey}`;
  assert.doesNotMatch(copyOf(list, backendCopy), /git-commit-box/);
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: backendCopy, repo: backendKey }, open: true, querySelector: () => null } });
  assert.match(copyOf(element('gitRepositories').innerHTML, backendCopy), /git-commit-box/);
  element('gitRepositories').listeners.toggle({ target: { dataset: { expand: backendCopy, repo: backendKey }, open: false } });
  // A group of a single repository has no filter menu.
  assert.doesNotMatch(list, /data-project-menu="c:\/feature-wt"/);
  assert.match(list, /data-project-menu="c:\/app"/);
  // A group's menu hides its repositories from that group only; the menu stays open while ticking.
  const openProjectMenu = projectMenu => element('gitRepositories').listeners.click({ target: { closest: s => (s === '[data-project-menu]' ? { dataset: { projectMenu } } : null) }, preventDefault() {}, stopPropagation() {} });
  assert.match(list, /data-project-menu="c:\/app" title="filterRepos"/, 'the button says what its menu is');
  openProjectMenu('c:/app');
  assert.deepEqual(plain(menuItems.map(x => [x.label, x.checked, x.keepOpen])), [['app-wt', true, true], ['backend', true, true], ['frontend', true, true]], 'the repositories at once, no menu of one item before them');
  await menuItems.find(x => x.label === 'backend').run();
  await menuItems.find(x => x.label === 'frontend').run();
  list = element('gitRepositories').innerHTML;
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenRepos')), { 'c:/app': [backendKey, frontendKey] });
  assert.ok(!list.includes(`data-expand="${expandOf('c:/app', backendKey)}"`), 'hidden from App');
  assert.ok(list.includes(`data-expand="${expandOf('c:/app/backend', backendKey)}"`), 'still under Backend');
  assert.ok(!list.includes(`data-repo="${esc(frontendKey)}"`), 'frontend is in no other group, so it is gone');
  assert.match(list, /data-project-menu="c:\/app"[^>]*><\/button><\/span><span class="git-count">1\/3</, 'the group counts shown of all');
  assert.equal(element('gitRepoCount').textContent, 3);
  openProjectMenu('c:/app');
  assert.equal(menuItems.find(x => x.label === 'frontend').checked, false);
  await menuItems.find(x => x.label === 'frontend').run();
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenRepos')), { 'c:/app': [backendKey] });
  await menuItems.find(x => x.label === 'backend').run();
  assert.equal(saved.get('agentdeck.gitHiddenRepos'), '{}', 'nothing is kept for a group with nothing hidden');
  // "Only with an open terminal": a repository no terminal is in is not listed, and there is no project filter.
  ctx.ws.tabs = {};
  ctx.ws.terminals = [];
  ctx.window.gitPanel.render();
  assert.equal(element('gitRepoCount').textContent, 0);
  assert.match(element('gitRepositories').innerHTML, /git\.panel\.empty</);
  element('gitPanelMenu').onclick();
  assert.ok(!menuItems.some(x => x.label === 'filterProjects'));
  // "All in the projects" (Settings > Git): every repository in a project, with a terminal or not; one outside the
  // projects is not. A change of the setting draws the panel again.
  state.repos.five = { root: 'C:/other/old', branch: 'main', files: [] };
  prefsChanged({ gitScope: 'all' });
  list = element('gitRepositories').innerHTML;
  assert.equal(element('gitRepoCount').textContent, 7, 'backend, frontend, the worktree of backend and Feature here; the first three on REMOTE');
  assert.ok(list.includes(`data-repo="${esc(frontendKey)}"`));
  assert.doesNotMatch(list, /C:\/other\/old/);
  // The project filter: a repository goes when every project holding it is hidden. A project with no repository is
  // not offered.
  ctx.data.projects.push({ n: 'c:/notes', name: 'Notes', path: 'C:/notes' });
  element('gitPanelMenu').onclick();
  const projectFilter = menuItems.find(x => x.label === 'filterProjects').items;
  assert.deepEqual(plain(projectFilter.map(x => [x.label, x.checked, x.keepOpen])), [['App', true, true], ['Backend', true, true], ['C:/app · REMOTE', true, true], ['Feature', true, true]]);
  await projectFilter.find(x => x.label === 'App').run();
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenProjects')), ['c:/app']);
  list = element('gitRepositories').innerHTML;
  assert.doesNotMatch(list, /data-expand="project:c:\/app"/, 'the hidden project has no group');
  assert.ok(list.includes(`data-expand="${expandOf('c:/app/backend', backendKey)}"`), 'backend stays under Backend');
  assert.ok(!list.includes(`data-repo="${esc(frontendKey)}"`), 'frontend was only in App');
  // A repository a terminal is in stays, whatever the filter.
  ctx.ws.tabs = { f: { root: { term: 't' } } };
  ctx.ws.terminals = [{ id: 't', cwd: 'C:/app/frontend' }];
  ctx.window.gitPanel.render();
  assert.ok(element('gitRepositories').innerHTML.includes(`data-repo="${esc(frontendKey)}"`));
  ctx.ws.tabs = {};
  ctx.ws.terminals = [];
  await projectFilter.find(x => x.label === 'App').run();
  assert.deepEqual(JSON.parse(saved.get('agentdeck.gitHiddenProjects')), []);
  // Every project hidden: the panel says it is the filter, with a button that shows them all again.
  for (const x of projectFilter) await x.run();
  list = element('gitRepositories').innerHTML;
  assert.equal(element('gitRepoCount').textContent, 0);
  assert.match(list, /git\.panel\.filtered<\/span><button [^>]*data-show-projects>git\.panel\.showAllProjects</);
  assert.doesNotMatch(list, /git\.panel\.empty/);
  let focused = '';
  element('gitPanelMenu').focus = () => { focused = 'gitPanelMenu'; };
  element('gitRepositories').listeners.click({ target: { closest: s => (s === '[data-show-projects]' ? { dataset: { showProjects: '' } } : null) } });
  assert.equal(saved.get('agentdeck.gitHiddenProjects'), '[]');
  assert.equal(element('gitRepoCount').textContent, 7);
  assert.equal(focused, 'gitPanelMenu', 'the focus goes to the menu that holds the filter');
  // With "all" and no repository at all, the text does not send the user to open a terminal.
  const repos = state.repos;
  state.repos = {};
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /git\.panel\.emptyAll</);
  state.repos = repos;
  // The scan-limit note names the projects not scanned in full, worded for one and for several; an older computer's
  // bare flag keeps the plain note.
  state.discoveryTruncated = true;
  state.discoveryTruncatedIn = ['C:/app'];
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /git\.panel\.scanLimitIn:1</);
  state.discoveryTruncatedIn = ['C:/app', 'C:/feature-wt'];
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /git\.panel\.scanLimitIn:2</);
  delete state.discoveryTruncatedIn;
  ctx.window.gitPanel.render();
  assert.match(element('gitRepositories').innerHTML, /git\.panel\.scanLimit</);
  await testUpgrade();
  console.log('Git sidebar tabs, local/remote identity, offline state, filename escaping, checkboxes, the folder view, refresh, scopes and filters passed');
}).catch(e => { console.error(e); process.exitCode = 1; });
