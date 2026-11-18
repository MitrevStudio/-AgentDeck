// Real Chromium DOM/layout checks with fixture IPC: never mutate a user's repo.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const testTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ui-'));
  env.AGENTDECK_UI_TEST_TMP = testTemp;
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 60000 });
  const resolved = path.resolve(testTemp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('agentdeck-ui-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
const temp = process.env.AGENTDECK_UI_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-ui-'));
const screenshots = path.join(root, '.tmp', 'git-ui-review');
app.setPath('userData', path.join(temp, 'profile'));
app.whenReady().then(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  const fileScript = file => `<script src="${pathToFileURL(file).href}"></script>`;
  const script = name => fileScript(path.join(src, name));
  const fixture = (name, text) => { const file = path.join(temp, name); fs.writeFileSync(file, text); return fileScript(file); };
  const renderer = fs.readFileSync(path.join(src, 'renderer.js'), 'utf8');
  const menu = 'let groupMenu = null, menuLayers = [];\n' + renderer.slice(renderer.indexOf('function openMenu('), renderer.indexOf('// ---------- projects: drag'));
  let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}">`);
  html = html.replace('</body>', script('i18n.js') + script('common.js') + script('git-ui.js') + fixture('data.js', `
    let data={projects:[{n:'demo',path:'C:/work/agentdeck'}]}, ws={spaces:{demo:{tabs:['demo']}},tabs:{demo:{}},terminals:[]}, nodes=[];
    git={repos:{demo:{root:'C:/work/agentdeck',branch:'feature/git',at:Date.now(),staged:1,unstaged:2,untracked:1,conflicts:0,ahead:0,behind:0,fileCount:4,files:[{path:'package.json',status:'M.'},{path:'README.md',status:'.M'},{path:'src/git-panel.js',status:'.M'},{path:'scripts/new-test.js',status:'??'}]}}};
    let fixtureDetails={status:git.repos.demo,branches:['main','feature/git'],remotes:['origin','backup'],operation:'',worktrees:[]};
    let fixturePatch='diff --git a/package.json b/package.json\\n@@ -1 +1 @@\\n-old\\n+new';
    let fixtureToken='review-1', commands=[], releaseDetails=null, holdDetails=false;
    window.manager={getGit:async()=>git,refreshGit:async()=>{},
      gitQuery:async(_node,p)=>{
        if(p.kind==='details') { if(holdDetails) await new Promise(r=>{releaseDetails=r;}); return fixtureDetails; }
        if(p.kind==='graph')return {commits:[]};
        return {patch:fixturePatch,token:fixtureToken};
      },
      gitExecute:async(node,p)=>{
        commands.push({node,...p});
        if(p.action==='commit') { if(p.token!==fixtureToken)throw Error('Staged changes changed. Review the commit again.'); fixturePatch=''; }
        return {output:'Done'};
      }};
    function toast(message){console.log(message);}
    const prefsListeners=[];
    window.prefs={gitScope:'open',onChanged:cb=>prefsListeners.push(cb)};
    localStorage.setItem('agentdeck.sidebarTab','git');
  `) + fixture('menu.js', menu) + script('git-workflow.js') + script('git-panel.js') + script('git-diff-ui.js') + '</body>');
  const file = path.join(temp, 'index.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 1100, height: 820, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const evaluate = code => win.webContents.executeJavaScript(code);
  const settle = () => evaluate('new Promise(r => setTimeout(r, 30))');
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  const capture = async name => {
    // Two frames: the picture is of what is drawn now, not of the frame before the last change.
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await settle();
    let bitmap;
    try { bitmap = await win.webContents.capturePage(); }
    catch (error) {
      // Windows' compositor occasionally loses the first surface after resize.
      if (!String(error).includes('UnknownVizError')) throw error;
      await settle(); bitmap = await win.webContents.capturePage();
    }
    fs.writeFileSync(path.join(screenshots, name + '.png'), bitmap.toPNG());
  };
  await win.loadFile(file); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.git-file-row').length"), 4);
  assert.equal(await evaluate("$('gitFilterBar').hidden"), false);
  await evaluate("$('gitFilter').value='missing'; $('gitFilter').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("$('gitRepositories').textContent.includes(gitText('noMatches'))"), true);
  await evaluate("$('gitFilter').value=''; $('gitFilter').dispatchEvent(new Event('input',{bubbles:true}))");
  await capture('sidebar');
  await click('[data-repo-menu]');
  await evaluate("[...document.querySelectorAll('.menu button')].find(b=>b.textContent.trim()===gitText('push')).click()"); await settle();
  assert.equal(await evaluate("$('gitActionsDialog').dataset.view"), 'sync');
  assert.equal(await evaluate('commands.length'), 0);
  assert.equal(await evaluate("$('gitActionsBody').textContent.includes(gitText('publishHint'))"), true);
  assert.equal(await evaluate("document.querySelector('[data-git-action=pull]').disabled"), true);
  await capture('publish');
  await evaluate("$('gitRemote').value='backup'"); await click('[data-git-action=push]');
  assert.equal(await evaluate('commands.at(-1).remote'), 'backup');
  await evaluate("fixtureDetails.remotes=[]"); await click('[data-git-action=refresh]');
  assert.equal(await evaluate("document.querySelector('[data-git-action=push]').disabled"), true);
  assert.equal(await evaluate("$('gitActionsBody').textContent.includes(gitText('noRemote'))"), true);
  await evaluate("fixtureDetails.remotes=['origin'];fixtureDetails.operation='cherry-pick';fixtureDetails.status.conflicts=1");
  await click('#gitActionsNav [data-view=commit]');
  assert.equal(await evaluate("document.querySelector('.git-operation').hidden"), false);
  assert.equal(await evaluate("document.querySelector('[data-git-action=continue]').disabled"), true);
  await capture('conflict');
  await evaluate("fixtureDetails.operation='';fixtureDetails.status.conflicts=0");
  await click('#gitActionsNav [data-view=branches]'); await click('#gitActionsNav [data-view=commit]');
  assert.equal(await evaluate("$('gitCommitSubmit').disabled"), true);
  await evaluate("$('gitCommitMessage').value='Keep my message';$('gitCommitMessage').dispatchEvent(new Event('input',{bubbles:true}));fixtureToken='review-2'");
  assert.equal(await evaluate("document.querySelector('[data-commit-message]').value"), 'Keep my message', 'dialog and sidebar share the draft');
  await click('#gitCommitSubmit');
  assert.equal(await evaluate("$('gitActionsResult').dataset.state"), 'error');
  assert.equal(await evaluate("$('gitCommitMessage').value"), 'Keep my message');
  await click('[data-git-action=preview]');
  assert.equal(await evaluate("$('gitCommitMessage').value"), 'Keep my message');
  await capture('review');
  await click('#gitCommitSubmit');
  assert.equal(await evaluate("$('gitCommitMessage').value"), '');
  assert.equal(await evaluate("$('gitCommitSubmit').disabled"), true);
  await evaluate("holdDetails=true;document.querySelector('#gitActionsNav [data-view=sync]').click()");
  assert.deepEqual(await evaluate("[$('gitActionsBody').inert,$('gitActionsNav').inert,$('gitActionsClose').disabled]"), [true, true, true]);
  await evaluate('holdDetails=false;releaseDetails()'); await settle();
  assert.equal(await evaluate("$('gitActionsBody').inert"), false);
  assert.equal(await evaluate("document.activeElement.dataset.view"), 'sync', 'keyboard focus returns to the selected navigation button');
  win.setSize(680, 700); await capture('narrow');
  assert.equal(await evaluate("$('gitActionsDialog').getBoundingClientRect().right <= innerWidth"), true);
  // Project groups, their filters and the keyboard focus. ClinicDesk is a project inside the Work project, so its
  // repository is drawn in both groups; child-app has no terminal in it, Notes has no repository.
  await evaluate("$('gitActionsClose').click()"); win.setSize(1100, 820); await settle();
  await evaluate(`
    data.projects=[{n:'work',name:'Work',path:'C:/work'},{n:'clinic',name:'ClinicDesk',path:'C:/work/clinicdesk'},{n:'notes',name:'Notes',path:'C:/notes'}];
    ws={spaces:{},tabs:{a:{root:{term:'a'}},b:{root:{term:'b'}}},terminals:[{id:'a',cwd:'C:/work/agentdeck'},{id:'b',cwd:'C:/work/clinicdesk'}]};
    git.repos.clinic={root:'C:/work/clinicdesk',branch:'main',at:Date.now(),staged:1,unstaged:1,untracked:0,conflicts:0,ahead:0,behind:0,files:[{path:'src/visits.js',status:'M.'},{path:'src/patients.js',status:'.M'}]};
    git.repos.child={root:'C:/work/parent-repo/child-app',branch:'main',at:Date.now(),staged:0,unstaged:0,untracked:0,conflicts:0,ahead:0,behind:0,files:[]};
    const groupOf=key=>[...document.querySelectorAll('.git-project')].find(d=>d.dataset.expand==='project:'+key);
    const headOf=details=>details.querySelector(':scope > summary');
    const copyOf=(project,root)=>[...groupOf(project).querySelectorAll('[data-repo]')].find(d=>JSON.parse(d.dataset.repo)[1]===root);
    const menuItem=label=>[...document.querySelectorAll('.menu button')].find(b=>b.textContent.trim()===label);
    const pressEscape=()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    const clinic='C:/work/clinicdesk';
    // Something the panel shows changed: the list is drawn again.
    const redraw=()=>{git.repos.demo.fileCount++;gitPanel.render();};
    gitPanel.render();
  `);
  await click('#gitPanelMenu'); await evaluate("menuItem(gitText('byProject')).click()"); await settle();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.git-project-head')].map(h=>h.textContent.trim())"), ['ClinicDesk1', 'Work2'], 'a group per project, with its count');
  assert.equal(await evaluate("document.querySelectorAll('.git-repository[open]').length"), 0, 'folded at first');
  // A group's header keeps the focus when it is opened and when the list is drawn again.
  await evaluate("headOf(groupOf('work')).focus();headOf(groupOf('work')).click()"); await settle();
  assert.equal(await evaluate("groupOf('work').open && document.activeElement===headOf(groupOf('work'))"), true);
  await evaluate('redraw()');
  assert.equal(await evaluate("document.activeElement===headOf(groupOf('work'))"), true, 'a group header keeps the focus over a redraw');
  // A folded repository is drawn without its body; opening it draws the list again, and its header keeps the focus -
  // on that copy, not on the one in the other group.
  assert.equal(await evaluate("copyOf('work',clinic).querySelector('.git-commit-box')"), null);
  await evaluate("headOf(copyOf('work',clinic)).focus();headOf(copyOf('work',clinic)).click()"); await settle();
  assert.equal(await evaluate("copyOf('work',clinic).open && Boolean(copyOf('work',clinic).querySelector('.git-commit-box'))"), true);
  assert.equal(await evaluate("document.activeElement===headOf(copyOf('work',clinic))"), true, 'an opened repository keeps the focus on its header');
  assert.equal(await evaluate("copyOf('clinic',clinic).open"), false, 'the copy in the other group stays folded');
  // The same for a repository's menu button and for a project's filter button.
  await evaluate("copyOf('work',clinic).querySelector('[data-repo-menu]').focus();redraw()");
  assert.equal(await evaluate("document.activeElement===copyOf('work',clinic).querySelector('[data-repo-menu]')"), true, 'a menu button keeps the focus over a redraw');
  await evaluate("groupOf('work').querySelector('[data-project-menu]').focus();redraw()");
  assert.equal(await evaluate("document.activeElement===groupOf('work').querySelector('[data-project-menu]')"), true, 'a filter button keeps the focus over a redraw');
  // A checkbox stages its file: the repository is drawn disabled while git works, then the checkbox has the focus again.
  const patients = "[...copyOf('work',clinic).querySelectorAll('.git-check')].find(b=>b.dataset.checkPath==='src/patients.js')";
  await evaluate(`${patients}.focus();${patients}.click()`); await settle();
  assert.deepEqual(await evaluate('(({action,files})=>({action,files}))(commands.at(-1))'), { action: 'stage', files: ['src/patients.js'] });
  assert.equal(await evaluate(`document.activeElement===${patients} && !${patients}.disabled`), true, 'a checkbox keeps the focus over the staging');
  // A project's filter button opens the list of its repositories at once; a tick hides one from that group only and
  // keeps the menu open, and Escape returns the focus to the button drawn in place of the one the menu opened from.
  await evaluate("groupOf('work').querySelector('[data-project-menu]').click()"); await settle();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.menu button')].map(b=>[b.textContent.trim(),b.getAttribute('aria-checked')])"), [['agentdeck', 'true'], ['clinicdesk', 'true']]);
  await evaluate("menuItem('clinicdesk').click()"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1, 'the menu stays open');
  assert.equal(await evaluate("copyOf('work',clinic)"), undefined, 'hidden from Work');
  assert.equal(await evaluate("Boolean(copyOf('clinic',clinic))"), true, 'still under ClinicDesk');
  assert.equal(await evaluate("headOf(groupOf('work')).querySelector('.git-count').textContent"), '1/2');
  await evaluate('pressEscape()'); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 0);
  assert.equal(await evaluate("document.activeElement===groupOf('work').querySelector('[data-project-menu]')"), true, 'the menu returns the focus to its button');
  await evaluate("groupOf('work').querySelector('[data-project-menu]').click()"); await settle();
  await evaluate("menuItem('clinicdesk').click();pressEscape()"); await settle();
  assert.equal(await evaluate("localStorage.getItem('agentdeck.gitHiddenRepos')"), '{}');
  // The copies of a repository stay in step while the user types: the message, and the Commit buttons.
  await evaluate("headOf(groupOf('clinic')).click()"); await settle();
  await evaluate("headOf(copyOf('clinic',clinic)).click()"); await settle();
  const copyState = project => evaluate(`(c=>[c.querySelector('[data-commit-message]').value,c.querySelector('[data-repo-action=commit]').disabled,c.querySelector('[data-quick=commit]').disabled])(copyOf('${project}',clinic))`);
  assert.deepEqual(await copyState('clinic'), ['', true, true]);
  await evaluate("(box=>{box.focus();box.value='Record visits';box.dispatchEvent(new Event('input',{bubbles:true}));})(copyOf('work',clinic).querySelector('[data-commit-message]'))");
  assert.deepEqual(await copyState('work'), ['Record visits', false, false]);
  assert.deepEqual(await copyState('clinic'), ['Record visits', false, false], 'the other copy follows the typing');
  assert.equal(await evaluate("document.activeElement===copyOf('work',clinic).querySelector('[data-commit-message]')"), true);
  await capture('groups');
  // "All in the projects": child-app is listed without a terminal in it, and the panel's menu filters by project -
  // only the projects that hold a repository. With every project hidden the panel says so and offers the way out.
  await evaluate("prefsListeners.forEach(cb=>cb({gitScope:'all'}))"); await settle();
  assert.equal(await evaluate("Boolean(copyOf('work','C:/work/parent-repo/child-app'))"), true);
  await click('#gitPanelMenu'); await evaluate("menuItem(gitText('filterProjects')).click()"); await settle();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.menu-sub button')].map(b=>b.textContent.trim())"), ['ClinicDesk', 'Work']);
  // Typing on the list searches it; Enter ticks the first match and keeps the search; Escape clears it first.
  const pressKey = k => evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true,cancelable:true}))`);
  const shownItems = () => evaluate("[...document.querySelectorAll('.menu-sub button[data-i]')].filter(b=>!b.hidden).map(b=>b.textContent.trim())");
  const searchState = () => evaluate("(f=>[f.value,f.hidden,document.activeElement===f,document.querySelector('.menu-sub .menu-empty').hidden])(document.querySelector('.menu-sub .menu-search'))");
  assert.deepEqual(await searchState(), ['', false, false, true], 'the search field is there from the start, the focus on the list');
  await pressKey('w');
  assert.deepEqual(await shownItems(), ['Work']);
  assert.deepEqual(await searchState(), ['w', false, true, true], 'the field shows what was typed and takes the typing');
  await evaluate("(f=>{f.value='wx';f.dispatchEvent(new Event('input'))})(document.querySelector('.menu-sub .menu-search'))");
  assert.deepEqual(await shownItems(), []);
  assert.deepEqual(await searchState(), ['wx', false, true, false], 'no match says so');
  await evaluate("(f=>{f.value='W';f.dispatchEvent(new Event('input'))})(document.querySelector('.menu-sub .menu-search'))");
  assert.deepEqual(await shownItems(), ['Work'], 'the search ignores case');
  await pressKey('Enter'); await settle();
  assert.equal(await evaluate("document.querySelector('.menu-sub button[data-i=\"1\"]').getAttribute('aria-checked')"), null, 'Enter unticks the match');
  assert.deepEqual(await shownItems(), ['Work'], 'the search stays while ticking');
  assert.deepEqual(await searchState(), ['W', false, true, true]);
  await pressKey('Enter'); await settle();
  assert.equal(await evaluate("document.querySelector('.menu-sub button[data-i=\"1\"]').getAttribute('aria-checked')"), 'true');
  await pressKey('Escape');
  assert.deepEqual(await shownItems(), ['ClinicDesk', 'Work']);
  assert.deepEqual(await searchState(), ['', false, false, true], 'Escape clears the search, the menu stays');
  assert.equal(await evaluate("document.querySelectorAll('.menu-sub').length"), 1);
  await evaluate("document.querySelectorAll('.menu-sub button')[0].click()"); await settle();
  await evaluate("document.querySelectorAll('.menu-sub button')[1].click()"); await settle();
  await evaluate('closeGroupMenu()');
  assert.equal(await evaluate("document.querySelectorAll('.git-project').length"), 0, 'the filter hides a repository a terminal is in too');
  assert.equal(await evaluate("document.querySelectorAll('[data-repo]').length"), 0);
  assert.equal(await evaluate("$('gitRepositories').textContent.includes(I18N.t('git.panel.filtered'))"), true, 'the filter is named as the reason, terminals open or not');
  await evaluate("ws.tabs={};ws.terminals=[];gitPanel.render()");
  await capture('filtered');
  await click('[data-show-projects]');
  assert.equal(await evaluate("document.querySelectorAll('.git-project').length"), 2);
  assert.equal(await evaluate("document.activeElement.id"), 'gitPanelMenu');
  // A long filter list opened from a button low at the right edge: inside the window, its search field pinned on top
  // while the list scrolls, an item reached with the keyboard not behind the field, ArrowUp from the field to the last.
  assert.deepEqual(await evaluate(`(() => {
    const b = document.createElement('button');
    b.style.cssText = 'position:fixed;right:2px;bottom:2px';
    document.body.append(b);
    openGroupMenu(b, '', Array.from({ length: 60 }, (_, i) => ({ label: 'repo-' + i, icon: 'branch', checked: true, keepOpen: true, run: () => {} })), 'git-context-menu');
    const m = groupMenu, r = m.getBoundingClientRect(), field = m.querySelector('.menu-search'), items = [...m.querySelectorAll('button[data-i]')];
    const scrolls = m.scrollHeight > m.clientHeight;
    const inside = r.top >= 8 && r.left >= 8 && r.right <= innerWidth - 8 && r.bottom <= innerHeight - 7;
    m.scrollTop = m.scrollHeight;
    const f = field.getBoundingClientRect();
    const pinned = f.top >= r.top && document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2) === field;
    // Scrolled to the top edge (as the focus does when an item above comes into view): it stops below the field.
    items[30].scrollIntoView({ block: 'start' });
    const clear = items[30].getBoundingClientRect().top >= field.getBoundingClientRect().bottom - 1;
    field.focus();
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    const last = document.activeElement === items.at(-1);
    closeGroupMenu();
    b.remove();
    return [scrolls, inside, pinned, clear, last];
  })()`), [true, true, true, true, true], 'a long list scrolls; inside the window, field pinned, focused item clear of it, ArrowUp from it to the last');
  assert.deepEqual(errors, []);
  console.log('Electron Git UI: publish routing, remote selection, empty/filter states, operation visibility, stale review, drafts, busy state, narrow layout, project groups, filters and the keyboard focus passed');
  console.log('Screenshots: ' + screenshots);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
