// The manager window in a real Chromium with fixture IPC: redraws that keep their rows, menus that stay open, pane
// buttons that always answer, the stacked messages, the confirmation dialog and the status bar's computers.
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
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
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
const screenshots = path.join(root, '.tmp', 'manager-ui-review');
app.setPath('userData', path.join(temp, 'profile'));

// What main would answer: three computers, projects in a group and at a drive's root, running sessions with subagents.
const FIXTURE = `(() => {
  const now = Date.now();
  const fx = { cbs: {}, wsCommands: [], live: [], copied: [] };
  const session = (id, cwd, title, agent = 'Claude') => ({ id, agent, cwd, title, prompt: title, updatedAt: now - 60000 });
  fx.data = {
    agents: ['Claude', 'Codex'],
    registry: { order: 'activity', groups: [{ id: 'g1', name: 'BDD' }], projects: [
      { name: 'agentdeck', path: 'C:/work/agentdeck' }, { name: 'bdd-web', path: 'C:/work/bdd-web', group: 'g1' },
      { name: 'bdd-ws', path: 'C:/work/bdd-ws', group: 'g1' }, { name: '', path: 'E:/' }, { name: 'docs', path: 'C:/work/docs' }] },
    sessions: [session('s1', 'C:/work/agentdeck', 'Polish the manager UI'), session('s2', 'C:/work/bdd-web', 'Orchestrate the B1 batch'),
      session('s3', 'C:/work/docs', 'Write the release notes', 'Codex'), session('s4', 'E:/', 'A session at the drive root')]
  };
  const liveOf = (id, status, extra = {}) => ({ agent: 'Claude', id, cwd: 'C:/work/agentdeck', status, pid: 100, startedAt: now - 500000, activityAt: now - 4000, statusAt: now - 4000, ...extra });
  fx.live = [liveOf('s1', 'idle'), liveOf('s2', 'busy', { cwd: 'C:/work/bdd-web', subagents: [{ id: 'a1', type: 'builder', description: 'Builder B1 desktop', at: now, working: true }] })];
  const limits = util => ({ providers: { claude: { installed: true, windows: [{ key: 'five_hour', util, elapsedPct: 40, resetsAt: now + 3600000 }, { key: 'seven_day', util: 23, elapsedPct: 50, resetsAt: now + 86400000 }] },
    codex: { installed: true } } });
  const stats = name => ({ name, at: now, cpu: 11, cores: 16, memory: { used: 8 * 2 ** 30, total: 32 * 2 ** 30 }, disk: { free: 2 ** 38, total: 2 ** 39, path: 'C:/' } });
  fx.nodes = [
    { id: 'node-a', name: 'IvanDevPc', kind: 'desktop', status: 'online', limits: limits(15), resources: stats('IvanDevPc'), live: [], git: {},
      data: { agents: ['Claude'], registry: { projects: [{ name: 'LiberDent', path: 'D:/src/liberdent' }] }, sessions: [] } },
    { id: 'node-b', name: 'WSF0029727', kind: 'desktop', status: 'online', limits: limits(98), resources: stats('WSF0029727'), live: [], git: {}, data: { agents: ['Claude'], registry: { projects: [] }, sessions: [] } },
    { id: 'node-c', name: 'agentdeck-relay', kind: 'host', status: 'offline', live: [], git: {} }
  ];
  fx.git = { dirs: { 'c:/work/agentdeck': 'r1', 'c:/work/docs': 'r2' }, repos: {
    r1: { root: 'C:/work/agentdeck', branch: 'feat/ui', at: now, staged: 1, unstaged: 1, untracked: 0, conflicts: 0, ahead: 2, behind: 0, upstream: 'origin/feat/ui', fileCount: 2,
      files: [{ path: 'src/renderer.js', status: 'M.' }, { path: 'README.md', status: '.M' }] },
    r2: { root: 'C:/work/docs', branch: 'main', at: now, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0, upstream: 'origin/main', fileCount: 0, files: [] } } };
  fx.ws = { activeSpace: 'c:/work/agentdeck', spaces: { 'c:/work/agentdeck': { tabs: ['t1'], active: 't1' } },
    tabs: { t1: { id: 't1', space: 'c:/work/agentdeck', name: '', focus: 'x1', zoom: '', root: { term: 'x1' } } },
    terminals: [{ id: 'x1', cwd: 'C:/work/agentdeck', agent: 'Claude', sessionId: 's1', title: 'Claude', exited: false }] };
  const answers = {
    getData: async () => fx.data, getLive: async () => fx.live, getNodes: async () => fx.nodes, getGit: async () => fx.git,
    getLimits: async () => limits(16), getResources: async () => stats('DEV-01'), getUsage: async () => null, refreshGit: async () => {},
    copyText: async text => { fx.copied.push(text); }, gitQuery: async () => ({ status: fx.git.repos.r1, branches: ['main'], remotes: ['origin'], worktrees: [], operation: '' })
  };
  // Answers come a moment later, as over IPC: never within the turn that asked.
  const later = fn => (...args) => new Promise(resolve => setTimeout(() => resolve(fn(...args)), 1));
  const SYNC = new Set(['input', 'resize', 'onChanged']);
  const bridge = handlers => new Proxy({}, { get: (_t, name) => (String(name).startsWith('on') ? cb => { fx.cbs[name] = cb; } : SYNC.has(name) ? handlers[name] : later(handlers[name] || (() => null))) });
  window.manager = bridge(answers);
  window.terminals = bridge({
    getWorkspace: async () => fx.ws, attach: async () => ({ scrollback: 'agentdeck $ ', end: 12 }), input() {}, resize() {},
    command: async (cmd, args) => {
      fx.wsCommands.push({ cmd, ...args });
      if (cmd === 'split') {
        fx.ws = structuredClone(fx.ws);
        fx.ws.terminals.push({ id: 'x2', cwd: 'C:/work/agentdeck', title: 'pwsh', exited: false });
        fx.ws.tabs.t1.root = { dir: args.dir, ratio: 0.5, a: { term: 'x1' }, b: { term: 'x2' } };
        fx.ws.tabs.t1.focus = 'x2';
        fx.cbs.onWorkspace(fx.ws);
      }
      if (cmd === 'focus') { fx.ws = structuredClone(fx.ws); fx.ws.tabs.t1.focus = args.term; fx.cbs.onWorkspace(fx.ws); }
    }
  });
  window.prefs = { language: 'en', themeId: 'dark', resolvedTheme: 'dark', terminalFontSizes: [12, 14, 16], terminalFontSize: 14, onChanged() {} };
  window.fx = fx;
})();
`;

app.whenReady().then(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  const fixtureFile = path.join(temp, 'fixture.js');
  fs.writeFileSync(fixtureFile, FIXTURE);
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}">`)
    .replace('<script src="i18n.js"></script>', `<script src="${pathToFileURL(fixtureFile).href}"></script><script src="i18n.js"></script>`);
  const file = path.join(temp, 'index.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 1500, height: 900, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = globalThis.pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  // A page that stops answering fails the step that asked, instead of hanging the run.
  const evaluate = code => Promise.race([win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + " In: " + code); }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("No answer from the page: " + code)), 10000))]);
  const settle = (ms = 60) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
  const click = async selector => { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); };
  const capture = async name => {
    await settle(150);
    let bitmap;
    try { bitmap = await win.webContents.capturePage(); }
    catch (error) {
      if (!String(error).includes('UnknownVizError')) throw error;
      await settle(); bitmap = await win.webContents.capturePage();
    }
    fs.writeFileSync(path.join(screenshots, name + '.png'), bitmap.toPNG());
  };
  // What main's pushes do: the same data again (a rescan), and a live poll.
  const rescan = () => evaluate('fx.cbs.onDataChanged(structuredClone(fx.data))');
  const poll = () => evaluate('pollLive()');

  await win.loadFile(file); await settle(400);
  if (process.env.UI_DEBUG) console.log(await evaluate("JSON.stringify({ projects: document.querySelectorAll('#projects .proj').length, loaded: ui.loaded, html: $('projects').innerHTML.slice(0, 300) })"));
  await evaluate("localStorage.clear(); $('sideTabProjects').click()"); await settle();

  // ---------- the lists ----------
  assert.equal(await evaluate("document.querySelectorAll('#projects .proj').length >= 6"), true, 'projects, the group and the other computer are listed');
  assert.equal(await evaluate("[...document.querySelectorAll('#projects .proj-name')].some(el => el.textContent === 'E:/')"), true, 'a project at a drive root goes by its path');
  assert.equal(await evaluate("document.querySelectorAll('#agents .agent').length"), 2);
  assert.equal(await evaluate("document.querySelector('#agents .agroup').textContent"), 'Working');
  assert.equal(await evaluate("[...document.querySelectorAll('#agents .agroup')].at(-1).textContent"), 'Ready');
  await capture('manager');

  // A rescan and a state change elsewhere leave the unchanged rows - and their spinners - as the elements they were.
  await evaluate("window.keptSpinner = document.querySelector('#agents .agent[data-key=\"Claude:s2\"] .spinner'); window.keptRow = document.querySelector('#projects .proj[data-path=\"C:/work/docs\"]'); window.keptPaneButton = document.querySelector('[data-ws=split-right]')");
  await rescan(); await settle();
  await evaluate("fx.live[0] = { ...fx.live[0], status: 'waiting', waitingFor: 'permission' }"); await poll(); await settle();
  assert.equal(await evaluate('keptSpinner.isConnected && keptRow.isConnected'), true, 'unchanged rows survive a redraw');
  assert.equal(await evaluate("document.querySelector('#agents .agroup').textContent"), 'Need you');
  assert.equal(await evaluate("document.getAnimations().filter(a => a.animationName === 'spin').every(a => a.startTime === 0)"), true, 'spinners turn in step');
  assert.equal(await evaluate('document.title.startsWith("(1!)")'), true);

  // ---------- menus stay open across redraws ----------
  await click('#projects .proj[data-path="C:/work/docs"] [data-action=project-menu]');
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1);
  await rescan(); await evaluate("fx.live[0] = { ...fx.live[0], status: 'idle' }"); await poll(); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1, "a project's menu stays open while the list is redrawn");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 0);
  await click('#sideTabGit'); await settle(100);
  assert.equal(await evaluate("document.querySelectorAll('#gitRepositories .git-repository').length"), 1);
  await capture('git-panel');
  await click('#gitPanelMenu');
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1);
  await rescan(); await evaluate("fx.live[0] = { ...fx.live[0], status: 'busy' }"); await poll(); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1, 'a Git menu stays open while the lists are redrawn');
  await capture('git-menu');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await click('#sideTabProjects');

  // ---------- panes ----------
  assert.equal(await evaluate('keptPaneButton.isConnected'), true, "a pane's buttons survive state changes");
  assert.equal(await evaluate("document.querySelector('.pane-info').draggable && !document.querySelector('.pane-tools').closest('[draggable=true]')"), true, 'only the title half of a header is dragged');
  assert.equal(await evaluate("document.querySelector('.pane-title').textContent"), 'C:/work/agentdeck', 'a pane alone in its tab shows its folder');
  await click('[data-ws=split-right]'); await settle(150);
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'split').map(c => c.dir)"), ['right']);
  assert.equal(await evaluate("document.querySelectorAll('#panes .pane').length"), 2);
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1] .pane-title').textContent"), 'Polish the manager UI');
  // The button of a pane that is not the focused one: focused first, then split.
  await click('.pane[data-term=x1] [data-ws=split-down]'); await settle(150);
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'split').map(c => c.dir)"), ['right', 'down']);
  await capture('split');

  // ---------- questions and messages ----------
  await evaluate("window.closing = closePane('x1'); 0"); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm')?.open"), true, 'closing an agent pane asks in a dialog');
  await capture('confirm');
  await click('dialog.confirm button[value=cancel]'); await evaluate('closing');
  assert.equal(await evaluate("fx.wsCommands.some(c => c.cmd === 'close-pane')"), false);
  await evaluate("window.closing = closePane('x1'); 0"); await settle();
  await click('dialog.confirm button[value=ok]'); await evaluate('closing');
  assert.equal(await evaluate("fx.wsCommands.some(c => c.cmd === 'close-pane')"), true);
  assert.equal(await evaluate("document.querySelector('dialog.confirm')"), null);
  await evaluate("toast('Copied'); toast(\"Error invoking remote method 'x': Error: The computer is offline\", true); toast('Copied')"); await settle();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.toast-item')].map(el => el.querySelector('.toast-text').textContent)"), ['Copied', 'The computer is offline']);
  await capture('toasts');
  await click('.toast-item.error [data-toast=close]'); await settle(300);
  assert.equal(await evaluate("document.querySelectorAll('.toast-item.error').length"), 0);

  // ---------- keyboard ----------
  await evaluate("document.querySelector('#agents .agent').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
  assert.equal(await evaluate("document.activeElement === document.querySelectorAll('#agents .agent')[1]"), true, 'the arrows walk the agents');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.menu').length"), 1, "the Menu key opens a session's menu");
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

  // ---------- status bar ----------
  assert.equal(await evaluate("document.querySelectorAll('#limits .machine-status').length"), 4);
  assert.equal(await evaluate("document.querySelectorAll('#limits .machine-status.chip').length"), 3, 'the other computers are short chips');
  assert.equal(await evaluate("document.querySelector('#limits [data-machine=node-b] .machine-fullest').className.includes('danger')"), true);
  assert.equal(await evaluate("$('limits').scrollWidth <= $('limits').clientWidth"), true, 'the computers fit without scrolling');
  assert.equal(await evaluate("$('limits').textContent.includes('Limits ?')"), false);
  assert.equal(await evaluate("document.querySelector('#limits .machine-status:not(.chip) .lim-value').textContent"), '16%', 'this computer shows its limits in full');
  // Pointing at a computer brings its card: every limit with a bar, then the computer's own figures.
  await evaluate("document.querySelector('#limits [data-card=node-b]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); 0"); await settle();
  assert.equal(await evaluate("document.querySelector('.machine-card').hidden"), false);
  assert.equal(await evaluate("document.querySelector('.machine-card header b').textContent"), 'WSF0029727');
  assert.equal(await evaluate("document.querySelectorAll('.machine-card .mc-part.claude .mc-row').length"), 2);
  assert.equal(await evaluate("document.querySelector('.machine-card .mc-row.danger .mc-v').textContent"), '98%');
  assert.equal(await evaluate("(() => { const r = document.querySelector('.machine-card').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0; })()"), true, 'the card stays inside the window');
  assert.equal(await evaluate("document.querySelectorAll('#limits [title], #limits [data-tip]').length"), 0, 'the card is the only tooltip of the bar');
  await capture('status-card');
  await evaluate("document.querySelector('#limits [data-card=local]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); 0"); await settle();
  assert.equal(await evaluate("document.querySelector('.machine-card header b').textContent"), 'DEV-01');
  await capture('status-card-local');
  await evaluate("$('limits').dispatchEvent(new MouseEvent('mouseleave')); 0"); await settle();
  assert.equal(await evaluate("document.querySelector('.machine-card').hidden"), true);
  await click('#limits [data-machine=node-b]');
  assert.equal(await evaluate("document.querySelectorAll('#limits .machine-status.chip').length"), 2, 'a chip opens to the full figures');
  await capture('status-open');
  await click('#limits [data-machine=node-b]');

  // A processor that is nearly full beats in red: on the chip of its computer, and in the card.
  assert.equal(await evaluate("document.querySelectorAll('#limits .hot').length"), 0);
  await evaluate("fx.nodes = structuredClone(fx.nodes); fx.nodes[0].resources.cpu = 97; fx.cbs.onNodesChanged(fx.nodes); 0"); await settle();
  assert.equal(await evaluate("document.querySelector('#limits [data-machine=node-a]').classList.contains('hot')"), true);
  assert.equal(await evaluate("document.querySelector('#limits [data-machine=node-a] .resource-value.hot').textContent"), '97%');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#limits [data-machine=node-a]')).animationName"), 'hot-chip');
  await capture('status-hot');
  await evaluate("fx.nodes = structuredClone(fx.nodes); fx.nodes[0].resources.cpu = 11; fx.cbs.onNodesChanged(fx.nodes); 0"); await settle();

  // ---------- which computer a terminal runs on ----------
  assert.equal(await evaluate("document.querySelectorAll('.term-node').length"), 0, 'no marks while everything runs here');
  await evaluate(`fx.ws = structuredClone(fx.ws); fx.ws.terminals = [fx.ws.terminals[0], { id: 'r1', node: 'node-a', cwd: 'D:/src/liberdent', title: 'pwsh', exited: false }];
    fx.ws.tabs.t1.root = { dir: 'right', ratio: 0.5, a: { term: 'x1' }, b: { term: 'r1' } }; fx.cbs.onWorkspace(fx.ws); 0`); await settle(150);
  assert.equal(await evaluate("document.querySelector('.pane[data-term=r1] .term-node.remote').textContent"), 'IvanDevPc');
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1] .term-node.local').textContent"), 'DEV-01');
  assert.equal(await evaluate("document.querySelector('.wtab .term-node').title"), 'IvanDevPc, DEV-01');
  await capture('computers');

  // ---------- by device, light theme, narrow ----------
  await click('#projectView'); await settle();
  assert.equal(await evaluate("$('deviceChips').scrollWidth <= $('deviceChips').clientWidth"), true, 'every computer chip is in view');
  assert.equal(await evaluate("document.querySelectorAll('#projects .proj.dev').length"), 4);
  assert.equal(await evaluate("document.querySelectorAll('#projects .proj.in-dev').length > 0"), true);
  await capture('by-device');
  await click('#projectView');
  await evaluate("document.documentElement.dataset.theme = 'light'"); await capture('light');
  await evaluate("delete document.documentElement.dataset.theme");
  win.setSize(1000, 700); await capture('narrow');
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);

  await settle(3200);
  assert.equal(await evaluate("document.querySelectorAll('.toast-item').length"), 0, 'messages leave by themselves');
  assert.deepEqual(errors, []);
  console.log('Electron manager UI: kept rows and spinners, open menus, pane buttons, dialogs, messages, keys and the status bar passed');
  console.log('Screenshots: ' + screenshots);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); console.error('page errors:', globalThis.pageErrors); app.exit(1); });
