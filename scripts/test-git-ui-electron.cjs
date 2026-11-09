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
  assert.deepEqual(errors, []);
  console.log('Electron Git UI: publish routing, remote selection, empty/filter states, operation visibility, stale review, drafts, busy state and narrow layout passed');
  console.log('Screenshots: ' + screenshots);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
