// The manager window in a real Chromium with fixture IPC: redraws that keep their rows, menus that stay open, pane
// buttons that always answer, the stacked messages, the confirmation dialog and the status bar's computers; and the
// shared terminals of docs/SHARED-SESSIONS.md (§5.3 view and IPC): viewers, another device's size, hide versus Stop,
// the Terminals section, agents in a terminal with no pane here, legacy terminals, and the views of panes that go.
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
  // stopped / taken: the terminals Stop and "Use my size" were sent for; attached: the terminals the page attached.
  // resized: the wants the panes sent (terminals.resize).
  const fx = { cbs: {}, wsCommands: [], live: [], copied: [], stopped: [], taken: [], attached: [], resized: [] };
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
  // The view of docs/SHARED-SESSIONS.md §5.3: x1 is open on two more devices, opened from one of them, whose size it has.
  const me = { id: 'self', name: 'DEV-01', kind: 'desktop', me: true };
  fx.ws = { activeSpace: 'c:/work/agentdeck', spaces: { 'c:/work/agentdeck': { tabs: ['t1'], active: 't1' } },
    tabs: { t1: { id: 't1', space: 'c:/work/agentdeck', name: '', focus: 'x1', zoom: '', root: { term: 'x1' } } },
    terminals: [{ id: 'x1', node: '', cwd: 'C:/work/agentdeck', agent: 'Claude', sessionId: 's1', title: 'Claude', exited: false, paned: true, createdAt: now - 900000,
      owner: 'node-a', ownerName: 'IvanDevPc', viewers: [me, { id: 'node-a', name: 'IvanDevPc', kind: 'desktop' }, { id: 'phone-1', name: 'Pixel 8', kind: 'mobile' }],
      driver: { name: 'IvanDevPc', me: false }, legacy: false, note: '' }] };
  fx.sizes = { x1: { cols: 120, rows: 32, mine: false, by: 'IvanDevPc' } };
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
    getWorkspace: async () => fx.ws, attach: async id => { fx.attached.push(id); return { scrollback: 'agentdeck $ ', end: 12, ...(fx.sizes[id] || {}) }; }, input() {}, resize(id, cols, rows) { fx.resized.push([id, cols, rows]); },
    stop: async id => { fx.stopped.push(id); return true; }, takeSize: async id => { fx.taken.push(id); return true; },
    command: async (cmd, args) => {
      fx.wsCommands.push({ cmd, ...args });
      if (cmd === 'split') {
        fx.ws = structuredClone(fx.ws);
        if (!fx.ws.terminals.some(x => x.id === 'x2')) fx.ws.terminals.push({ id: 'x2', node: '', cwd: 'C:/work/agentdeck', title: 'pwsh', exited: false, paned: true, createdAt: now - 60000, viewers: [me], driver: null, legacy: false, note: '' });
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
  // The same view in the light theme, the terminals' colours too, then back.
  const captureLight = async name => {
    await evaluate("document.documentElement.dataset.theme = 'light'; applyTermTheme()"); await capture(name);
    await evaluate("delete document.documentElement.dataset.theme; applyTermTheme()");
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
  assert.equal(await evaluate("$('sideTerms').hidden"), true, 'no Terminals section while the only terminal is an agent listed above');
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
  // A shared terminal's header: who else has it open, who opened it, the size another device set; Stop beside X.
  assert.equal(await evaluate("document.querySelector('.pane-viewers').textContent"), '2', 'the other devices are counted, not this one');
  assert.equal(await evaluate("document.querySelector('.pane-viewers').title"), 'Also open on: IvanDevPc, Pixel 8');
  assert.equal(await evaluate("document.querySelector('.pane-title').title.includes('Opened from IvanDevPc')"), true);
  assert.equal(await evaluate("document.querySelector('.size-chip').textContent"), '120×32 · IvanDevPc');
  assert.equal(await evaluate("document.querySelector('.pane').classList.contains('sized')"), true);
  assert.deepEqual(await evaluate("(() => { const v = termViews.get('x1').term; return [v.cols, v.rows]; })()"), [120, 32], "the terminal is drawn in the size it has there");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.pane-tools [data-ws]')].map(b => b.dataset.ws)"), ['split-right', 'split-down', 'take-size', 'stop', 'close-pane']);
  assert.equal(await evaluate("document.querySelector('[data-ws=stop]').classList.contains('danger')"), true);
  assert.equal(await evaluate("document.querySelector('[data-ws=close-pane]').title"), 'Hide the pane (Ctrl+Shift+W) · the terminal keeps running');
  assert.equal(await evaluate("document.querySelector('.wtab [data-ws=close-tab]').title"), 'Hide the tab');
  await capture('shared-header');
  await captureLight('shared-header-light');
  await click('[data-ws=take-size]'); await settle();
  assert.deepEqual(await evaluate('fx.taken'), ['x1'], '"Use my size" asks main for it');
  // The host made this window the one that sets the size: the chip and the button go, the pane fits itself again.
  await evaluate("fx.cbs.onSize({ id: 'x1', cols: 150, rows: 40, mine: true, by: 'DEV-01' })"); await settle();
  assert.equal(await evaluate("document.querySelector('.size-chip')"), null);
  assert.equal(await evaluate("document.querySelector('[data-ws=take-size]')"), null);
  assert.equal(await evaluate("document.querySelector('.pane').classList.contains('sized')"), false);
  assert.notDeepEqual(await evaluate("(() => { const v = termViews.get('x1').term; return [v.cols, v.rows]; })()"), [120, 32], 'the pane fits itself again');
  // Another device typed: its size again.
  await evaluate("fx.cbs.onSize({ id: 'x1', cols: 120, rows: 32, mine: false, by: 'IvanDevPc' })"); await settle();
  assert.equal(await evaluate("document.querySelector('.size-chip').textContent"), '120×32 · IvanDevPc');
  // A size larger than the pane: the pane scrolls, yet what it wants is what fits it without the scrollbars - and when
  // it drives again, the terminal is resized once, to that.
  const ownFit = "(() => { const p = document.querySelector('.pane[data-term=x1]'), had = p.classList.contains('sized'); p.classList.remove('sized'); const d = termViews.get('x1').fit.proposeDimensions(); if (had) p.classList.add('sized'); return [d.cols, d.rows]; })()";
  await evaluate("fx.cbs.onSize({ id: 'x1', cols: 400, rows: 200, mine: false, by: 'IvanDevPc' })"); await settle();
  assert.equal(await evaluate("(() => { const b = document.querySelector('.pane[data-term=x1] .pane-body'); return b.scrollWidth > b.clientWidth && b.scrollHeight > b.clientHeight; })()"), true, 'the pane scrolls');
  await evaluate("fx.resized.length = 0; fitShown()"); await settle();
  assert.deepEqual(await evaluate("fx.resized.filter(r => r[0] === 'x1').map(r => [r[1], r[2]])"), [await evaluate(ownFit)], "the want is the pane's own fit, not a cell short");
  await evaluate("fx.resized.length = 0; fx.cbs.onSize({ id: 'x1', cols: 400, rows: 200, mine: true, by: 'DEV-01' })"); await settle(150);
  assert.deepEqual([...new Set(await evaluate("fx.resized.filter(r => r[0] === 'x1').map(r => r[1] + 'x' + r[2])"))], [(await evaluate(ownFit)).join('x')], 'driving again: one size, its own');
  await evaluate("fx.cbs.onSize({ id: 'x1', cols: 120, rows: 32, mine: false, by: 'IvanDevPc' })"); await settle();
  await click('[data-ws=split-right]'); await settle(150);
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'split').map(c => c.dir)"), ['right']);
  assert.equal(await evaluate("document.querySelectorAll('#panes .pane').length"), 2);
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1] .pane-title').textContent"), 'Polish the manager UI');
  // The button of a pane that is not the focused one: focused first, then split.
  await click('.pane[data-term=x1] [data-ws=split-down]'); await settle(150);
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'split').map(c => c.dir)"), ['right', 'down']);
  await capture('split');

  // ---------- questions and messages ----------
  // X only hides the pane - nothing is lost, so nothing is asked, an agent's pane too.
  await click('.pane[data-term=x1] [data-ws=close-pane]'); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm')"), null, 'hiding a pane asks nothing');
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'close-pane').map(c => c.term)"), ['x1']);
  // Stop ends the terminal for everyone: asked first, naming where it runs and who else has it open.
  await click('.pane[data-term=x1] [data-ws=stop]'); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm')?.open"), true, 'Stop asks in a dialog');
  assert.equal(await evaluate("document.querySelector('dialog.confirm p').textContent"),
    'Stop "Polish the manager UI" on this computer? The terminal closes on every device, also open on: IvanDevPc, Pixel 8. The conversation stays and can be resumed.');
  assert.equal(await evaluate("document.querySelector('dialog.confirm button[value=ok]').textContent"), 'Stop');
  await capture('stop-confirm');
  await captureLight('stop-confirm-light');
  await click('dialog.confirm button[value=cancel]'); await settle();
  assert.deepEqual(await evaluate('fx.stopped'), []);
  await click('.pane[data-term=x1] [data-ws=stop]'); await settle();
  await click('dialog.confirm button[value=ok]'); await settle();
  assert.deepEqual(await evaluate('fx.stopped'), ['x1'], 'Stop calls terminals.stop');
  assert.equal(await evaluate("document.querySelector('dialog.confirm')"), null);
  // A shell's question names its folder.
  await click('.pane[data-term=x2] [data-ws=stop]'); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm p').textContent"), 'Stop the terminal in C:/work/agentdeck on this computer? It closes on every device.');
  await click('dialog.confirm button[value=cancel]'); await settle();
  // A terminal of a host without these rules (legacy): fitted as always, no size of another device, no viewers.
  await evaluate("fx.ws = structuredClone(fx.ws); fx.ws.terminals[0] = { ...fx.ws.terminals[0], legacy: true, viewers: [], driver: null }; fx.cbs.onWorkspace(fx.ws)"); await settle();
  await evaluate("fx.cbs.onSize({ id: 'x1', cols: 120, rows: 32, mine: false, by: 'IvanDevPc' })"); await settle();
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1] .size-chip, .pane[data-term=x1] .pane-viewers, .pane[data-term=x1] [data-ws=take-size]')"), null);
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1]').classList.contains('sized')"), false);
  assert.notDeepEqual(await evaluate("(() => { const v = termViews.get('x1').term; return [v.cols, v.rows]; })()"), [120, 32], 'a legacy terminal fits its pane');
  await click('.pane[data-term=x1] [data-ws=close-pane]'); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm')"), null);
  assert.equal(await evaluate("document.querySelector('.pane[data-term=x1] [data-ws=stop]') !== null"), true, 'a legacy terminal can be stopped too');
  await evaluate("fx.ws = structuredClone(fx.ws); fx.ws.terminals[0].legacy = false; fx.cbs.onWorkspace(fx.ws)"); await settle();
  assert.deepEqual(await evaluate("(() => { const v = termViews.get('x1').term; return [v.cols, v.rows]; })()"), [120, 32], 'no longer legacy: the size there again');
  await evaluate("toast('Copied'); toast(\"Error invoking remote method 'x': Error: The computer is offline\", true); toast('Copied')"); await settle();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.toast-item')].map(el => el.querySelector('.toast-text').textContent)"), ['Copied', 'The computer is offline']);
  await capture('toasts');
  await click('.toast-item.error [data-toast=close]'); await settle(300);
  assert.equal(await evaluate("document.querySelectorAll('.toast-item.error').length"), 0);

  // ---------- terminals of every computer ----------
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#terms .agent')].map(el => el.dataset.key)"), ['term:x2'], 'the shell split off above is listed, the agent is not');
  // A shell here without a pane, one with a pane, a shell on another computer, one on an offline computer, and Codex
  // running in a terminal with no pane here (its live state names the terminal).
  await evaluate(`(() => {
    const term = (id, extra) => ({ id, node: '', title: 'pwsh', exited: false, paned: false, createdAt: Date.now(), viewers: [], driver: null, legacy: false, note: '', ...extra });
    fx.ws = structuredClone(fx.ws);
    fx.ws.terminals.push(term('x3', { cwd: 'C:/work/docs', createdAt: Date.now() - 5000 }), term('x5', { cwd: 'C:/work/bdd-web', createdAt: Date.now() - 9000, paned: true }),
      term('x4', { node: 'node-a', cwd: 'D:/src/liberdent', title: 'bash · IvanDevPc', viewers: [{ id: 'node-a', name: 'IvanDevPc', kind: 'desktop' }] }),
      term('x7', { node: 'node-c', cwd: '/srv/app', title: 'bash · agentdeck-relay', note: 'offline' }),
      term('x6', { cwd: 'C:/work/docs', agent: 'Codex', sessionId: 's3', title: 'Codex' }));
    fx.live.push({ agent: 'Codex', id: 's3', cwd: 'C:/work/docs', status: 'idle', pid: 300, startedAt: Date.now() - 50000, activityAt: Date.now() - 9000, statusAt: Date.now() - 9000, term: 'x6' });
    fx.cbs.onWorkspace(fx.ws);
  })(); 0`);
  await poll(); await settle(150);
  assert.equal(await evaluate("$('sideTerms').hidden"), false);
  assert.equal(await evaluate("$('termCount').textContent"), '4');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#terms .agent')].map(el => el.dataset.key)"), ['term:x3', 'term:x5', 'term:x2', 'term:x4'], 'this computer first, the newest first; offline computers and agents listed above are left out');
  assert.equal(await evaluate("document.querySelector('#terms [data-key=\"term:x3\"] .agent-sub').textContent"), 'docs · This computer · no pane here');
  assert.equal(await evaluate("document.querySelector('#terms [data-key=\"term:x5\"]').classList.contains('here')"), true);
  assert.equal(await evaluate("document.querySelector('#terms [data-key=\"term:x4\"] .agent-title').textContent"), 'bash', "a remote terminal's title leaves its computer to the line below");
  assert.equal(await evaluate("document.querySelector('#terms [data-key=\"term:x4\"] .agent-sub').textContent"), 'LiberDent · IvanDevPc · no pane here');
  assert.equal(await evaluate("document.querySelector('#terms [data-key=\"term:x4\"] .term-viewers').textContent"), '1');
  // The row with the keyboard shows its Stop button, as a pointed-at one does.
  await evaluate("document.querySelector('#terms [data-key=\"term:x4\"]').focus()");
  await capture('terminals-section');
  await captureLight('terminals-section-light');
  await click('#terms [data-key="term:x3"]');
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'open-term')"), [{ cmd: 'open-term', term: 'x3', place: 'tab' }], 'a terminal with no pane here opens in a new one');
  // Stop on a row: asked, naming the computer it runs on.
  await click('#terms [data-key="term:x4"] [data-action=term-stop]');
  assert.equal(await evaluate("document.querySelector('dialog.confirm p').textContent"), 'Stop the terminal in D:/src/liberdent on IvanDevPc? It closes on every device, also open on: IvanDevPc.');
  await click('dialog.confirm button[value=ok]'); await settle();
  assert.deepEqual(await evaluate('fx.stopped'), ['x1', 'x4']);
  // An agent running in a terminal with no pane here: a click opens it here, whoever started it; its menu stops the terminal.
  assert.equal(await evaluate("document.querySelector('#agents [data-key=\"Codex:s3\"] .agent-sub').textContent"), 'docs', 'not "in another terminal": it runs in one of AgentDeck');
  assert.equal(await evaluate("document.querySelector('#agents [data-key=\"Codex:s3\"]').classList.contains('here')"), false);
  assert.equal(await evaluate("document.querySelector('#agents [data-key=\"Claude:s1\"]').classList.contains('here')"), true);
  await click('#agents [data-key="Codex:s3"]');
  assert.deepEqual(await evaluate("fx.wsCommands.filter(c => c.cmd === 'open-term').map(c => c.term)"), ['x3', 'x6']);
  await click('#agents [data-key="Codex:s3"] [data-action=agent-menu]');
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.menu button')].map(b => b.textContent.trim())"), ['Show terminal', 'Copy the session ID', 'Copy path', 'Open terminal', 'Open in Explorer', 'Stop']);
  await click('.menu button.danger'); await settle();
  assert.equal(await evaluate("document.querySelector('dialog.confirm p').textContent.startsWith('Stop \"Write the release notes\" on this computer?')"), true);
  await click('dialog.confirm button[value=ok]'); await settle();
  assert.deepEqual(await evaluate('fx.stopped'), ['x1', 'x4', 'x6'], "an agent's Stop stops its terminal");
  // A terminal that ended elsewhere: its pane goes (main), a message says so.
  await evaluate("fx.cbs.onEnded({ id: 'x3', title: 'pwsh' })"); await settle();
  assert.equal(await evaluate("[...document.querySelectorAll('.toast-item .toast-text')].some(el => el.textContent === '\"pwsh\" ended')"), true);

  // ---------- a pane that goes takes its terminal's view with it ----------
  const layout = root => `fx.ws = structuredClone(fx.ws); fx.ws.tabs.t1.root = ${JSON.stringify(root)}; fx.ws.tabs.t1.focus = 'x2'; for (const x of fx.ws.terminals) if (x.id === 'x1') x.paned = ${JSON.stringify(JSON.stringify(root).includes('x1'))}; fx.cbs.onWorkspace(fx.ws)`;
  const shownText = "(() => { const b = termViews.get('x1').term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\\\\n'; return s; })()";
  await evaluate(layout({ term: 'x2' })); await settle();
  assert.equal(await evaluate("termViews.has('x1')"), false, "a hidden pane's terminal has no view any more");
  assert.equal(await evaluate("document.querySelectorAll('.pane[data-term=x1], .term-host').length"), 1, 'only the shown pane is in the page');
  // Output that comes for it afterwards (sent before main heard of the hiding) has nothing to go to.
  await evaluate("fx.cbs.onData({ id: 'x1', data: 'late output', end: 99 })"); await settle();
  assert.equal(await evaluate("termViews.has('x1')"), false, 'no view is made for a terminal without a pane');
  // Shown again: a new view, attached anew - what it missed is in the scrollback, shown once.
  const attaches = await evaluate("fx.attached.filter(id => id === 'x1').length");
  await evaluate(layout({ dir: 'right', ratio: 0.5, a: { term: 'x1' }, b: { term: 'x2' } })); await settle(200);
  assert.equal(await evaluate("fx.attached.filter(id => id === 'x1').length"), attaches + 1, 'attached anew');
  assert.equal((await evaluate(shownText)).split('agentdeck $').length - 1, 1, 'the scrollback once');
  // The space's last tab goes: no pane is left in the page, nor any view.
  await evaluate("fx.ws = structuredClone(fx.ws); fx.ws.spaces['c:/work/agentdeck'] = { tabs: [], active: '' }; fx.ws.tabs = {}; for (const x of fx.ws.terminals) x.paned = false; fx.cbs.onWorkspace(fx.ws)"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.pane[data-term]').length"), 0, 'no pane lingers after its tab went');
  assert.equal(await evaluate("termViews.size"), 0);
  assert.equal(await evaluate("$('spaceEmpty').hidden"), false);

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
  // A machine that asks for reduced motion (a remote desktop session) gets the red chip without the beat.
  assert.equal(await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches ? 'hot-chip' : getComputedStyle(document.querySelector('#limits [data-machine=node-a]')).animationName"), 'hot-chip');
  await capture('status-hot');
  await evaluate("fx.nodes = structuredClone(fx.nodes); fx.nodes[0].resources.cpu = 11; fx.cbs.onNodesChanged(fx.nodes); 0"); await settle();

  // ---------- sidebar splitters ----------
  // Projects / Agents / Terminals: each line resizes only the section below it, the projects keep at least 120px, the
  // dragged heights are kept and restored, and the Agents | Terminals line is there only with the Terminals section.
  {
    const box = id => evaluate(`(() => { const r = $('${id}').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; })()`);
    const shown = id => evaluate(`getComputedStyle($('${id}')).display !== 'none'`);
    const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 2, `${message}: ${actual} is not ~${expected}`);
    const stored = () => evaluate("[localStorage.getItem('agentdeck.agentsHeight'), localStorage.getItem('agentdeck.termsHeight')]");
    // A real pointer: down on the line's middle, moved to toY, up.
    const drag = async (id, toY) => {
      const [x, y] = await evaluate(`(() => { const r = $('${id}').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
      toY = Math.round(toY);
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await settle(30);
      for (const at of [Math.round((y + toY) / 2), toY]) { win.webContents.sendInputEvent({ type: 'mouseMove', x, y: at, button: 'left', modifiers: ['leftButtonDown'] }); await settle(30); }
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y: toY, button: 'left', clickCount: 1 }); await settle();
    };
    const key = async (id, name) => { await evaluate(`$('${id}').dispatchEvent(new KeyboardEvent('keydown', { key: '${name}', bubbles: true })); 0`); await settle(); };
    const dblclick = async id => { await evaluate(`$('${id}').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 0`); await settle(); };
    await evaluate("window.keptTerms = fx.ws.terminals; fx.ws = structuredClone(fx.ws); fx.ws.terminals = []; fx.cbs.onWorkspace(fx.ws); 0"); await poll(); await settle(150);

    // No Terminals section: one line, which sizes the agents.
    assert.equal(await evaluate("$('sideTerms').hidden"), true);
    assert.equal(await shown('sideSplitter'), true);
    assert.equal(await shown('termsSplitter'), false, 'no line above a hidden Terminals section');
    assert.equal(await evaluate("[$('sideSplitter'), $('termsSplitter')].every(el => el.getAttribute('role') === 'separator' && el.getAttribute('aria-orientation') === 'horizontal' && el.tabIndex === 0 && el.title === 'Drag to resize. Double-click: default height.')"), true);
    let agents = await box('sideAgents');
    await drag('sideSplitter', agents.bottom - 250);
    near((await box('sideAgents')).height, 250, 'the agents take the dragged height');
    near((await box('sideAgents')).bottom, agents.bottom, "the agents' bottom stays");
    assert.equal(Number((await stored())[0]), Math.round((await box('sideAgents')).height));
    const dragged = (await box('sideAgents')).height;
    await key('sideSplitter', 'ArrowUp');
    near((await box('sideAgents')).height, dragged + 16, 'ArrowUp: taller');
    await key('sideSplitter', 'ArrowDown'); await key('sideSplitter', 'ArrowDown');
    near((await box('sideAgents')).height, dragged - 16, 'ArrowDown: shorter');
    await drag('sideSplitter', (await box('sideProjects')).top);
    near((await box('sideProjects')).height, 120, 'dragged to the top, the projects keep their minimum');
    await drag('sideSplitter', (await box('sideAgents')).bottom + 50);
    near((await box('sideAgents')).height, 80, 'dragged to the bottom, the agents keep their minimum');
    await dblclick('sideSplitter');
    assert.equal(await evaluate("$('sideOverview').style.getPropertyValue('--agents-h')"), '', 'a double-click: the default height again');
    assert.deepEqual(await stored(), [null, null]);

    // With terminals: two lines, each resizes only its own section.
    await evaluate(`(() => {
      const shell = (id, cwd, ago) => ({ id, node: '', cwd, title: 'pwsh', exited: false, paned: false, createdAt: Date.now() - ago, viewers: [], driver: null, legacy: false, note: '' });
      fx.ws = structuredClone(fx.ws); fx.ws.terminals = [shell('y1', 'C:/work/docs', 1000), shell('y2', 'C:/work/bdd-web', 2000), shell('y3', 'C:/work/agentdeck', 3000)]; fx.cbs.onWorkspace(fx.ws);
    })(); 0`); await poll(); await settle(150);
    assert.equal(await evaluate("$('sideTerms').hidden"), false);
    assert.equal(await shown('termsSplitter'), true, 'a line above the Terminals section');
    assert.equal(await evaluate("getComputedStyle($('sideTerms')).borderTopWidth"), '0px', 'the line, not a border too');
    const terms = await box('sideTerms');
    agents = await box('sideAgents');
    await drag('sideSplitter', agents.bottom - 200);
    near((await box('sideAgents')).height, 200, 'the agents take the dragged height above the terminals');
    near((await box('sideTerms')).height, terms.height, 'the terminals keep theirs');
    const overview = await box('sideOverview');
    await drag('termsSplitter', terms.bottom - overview.height * 0.4);
    near((await box('sideTerms')).height, overview.height * 0.4, 'the terminals take the dragged height, more than 30% too');
    near((await box('sideAgents')).height, 200, 'the agents keep theirs');
    await key('termsSplitter', 'ArrowDown');
    near((await box('sideTerms')).height, overview.height * 0.4 - 16, 'ArrowDown: shorter terminals');
    await drag('termsSplitter', overview.top);
    near((await box('sideProjects')).height, 120, 'the terminals stop where the projects keep their minimum');
    near((await box('sideAgents')).height, 200, 'and the agents keep theirs');
    await key('termsSplitter', 'ArrowUp'); await key('sideSplitter', 'ArrowUp');
    near((await box('sideProjects')).height, 120, 'nor the keys take the projects below it');
    const [agentsH, termsH] = (await stored()).map(Number);
    near(agentsH, 200, 'the agents height is kept'); assert.ok(termsH > overview.height * 0.4, 'the terminals height is kept');
    await drag('termsSplitter', (await box('sideTerms')).top + 150);
    const kept = await evaluate("[$('sideAgents').getBoundingClientRect().height, $('sideTerms').getBoundingClientRect().height]");
    await capture('sidebar-splitters');
    // Restored as the window opens: the stored heights again.
    await evaluate("$('sideOverview').style.removeProperty('--agents-h'); $('sideOverview').style.removeProperty('--terms-h'); restoreSplit(AGENTS_SPLIT); restoreSplit(TERMS_SPLIT); 0"); await settle();
    assert.deepEqual(await evaluate("[$('sideAgents').getBoundingClientRect().height, $('sideTerms').getBoundingClientRect().height]"), kept, 'the stored heights are restored');
    // A smaller window than they were dragged in: the projects keep their minimum, nothing spills out of the sidebar.
    win.setSize(1500, 600); await settle(200);
    assert.ok((await box('sideProjects')).height >= 119, 'a small window: the projects keep their minimum');
    assert.ok((await box('sideTerms')).bottom <= (await box('sideOverview')).bottom + 1, 'a small window: the terminals stay inside');
    win.setSize(1500, 900); await settle(200);
    // The Git tab hides the overview with its lines; back, the heights are as they were.
    await click('#sideTabGit');
    assert.equal(await evaluate("$('sideOverview').hidden"), true);
    await click('#sideTabProjects'); await settle();
    assert.deepEqual(await evaluate("[$('sideAgents').getBoundingClientRect().height, $('sideTerms').getBoundingClientRect().height]"), kept);
    await dblclick('termsSplitter');
    assert.equal(await evaluate("$('sideOverview').style.getPropertyValue('--terms-h')"), '');
    near((await box('sideAgents')).height, 200, "the terminals' reset leaves the agents");
    await dblclick('sideSplitter');
    assert.deepEqual(await stored(), [null, null]);
    await evaluate("fx.ws = structuredClone(fx.ws); fx.ws.terminals = keptTerms; fx.cbs.onWorkspace(fx.ws); 0"); await poll(); await settle(150);
  }

  // ---------- which computer a terminal runs on ----------
  assert.equal(await evaluate("document.querySelectorAll('.term-node').length"), 0, 'no marks while everything runs here');
  // The tab went with the checks above: one with this computer's terminal and one of another computer's.
  await evaluate(`fx.ws = structuredClone(fx.ws); fx.ws.terminals = [{ ...fx.ws.terminals.find(x => x.id === 'x1'), paned: true }, { id: 'r1', node: 'node-a', cwd: 'D:/src/liberdent', title: 'pwsh', exited: false, paned: true, viewers: [], driver: null }];
    fx.ws.spaces['c:/work/agentdeck'] = { tabs: ['t1'], active: 't1' };
    fx.ws.tabs = { t1: { id: 't1', space: 'c:/work/agentdeck', name: '', focus: 'x1', zoom: '', root: { dir: 'right', ratio: 0.5, a: { term: 'x1' }, b: { term: 'r1' } } } }; fx.cbs.onWorkspace(fx.ws); 0`); await settle(150);
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

  // ---------- dragging sidebar rows and hiding by drag ----------
  win.setSize(1500, 900); await settle(150);
  // Tab t1: y1 | y2, tab t2: y6 - shells here with panes; y3 a shell here and y4 one on another computer, no pane here;
  // a session there running in terminal y9, known only from its live state; s2 here runs outside AgentDeck.
  await evaluate(`(() => {
    const now = Date.now(), me = { id: 'self', name: 'DEV-01', kind: 'desktop', me: true };
    const term = (id, extra) => ({ id, node: '', cwd: 'C:/work/agentdeck', title: 'pwsh', exited: false, paned: false, createdAt: now, viewers: [], driver: null, legacy: false, note: '', ...extra });
    fx.ws = { activeSpace: 'c:/work/agentdeck', spaces: { 'c:/work/agentdeck': { tabs: ['t1', 't2'], active: 't1' } },
      tabs: { t1: { id: 't1', space: 'c:/work/agentdeck', name: '', focus: 'y1', zoom: '', root: { dir: 'right', ratio: 0.5, a: { term: 'y1' }, b: { term: 'y2' } } },
        t2: { id: 't2', space: 'c:/work/agentdeck', name: 'logs', focus: 'y6', zoom: '', root: { term: 'y6' } } },
      terminals: [term('y1', { paned: true, viewers: [me] }), term('y2', { paned: true, viewers: [me], createdAt: now - 1000 }), term('y6', { paned: true, viewers: [me], createdAt: now - 1500 }),
        term('y3', { cwd: 'C:/work/docs', createdAt: now - 2000 }), term('y4', { node: 'node-a', cwd: 'D:/src/liberdent', title: 'bash · IvanDevPc', createdAt: now - 3000 })] };
    fx.nodes = structuredClone(fx.nodes);
    fx.nodes[0].data.sessions = [{ id: 'rs1', agent: 'Claude', cwd: 'D:/src/liberdent', title: 'Tidy the invoice export', prompt: 'Tidy the invoice export', updatedAt: now - 60000 }];
    fx.nodes[0].live = [{ agent: 'Claude', id: 'rs1', cwd: 'D:/src/liberdent', status: 'busy', pid: 7, startedAt: now - 90000, activityAt: now, statusAt: now, term: 'y9' }];
    // fx.cbs keeps one listener per event (the status bar's): the sidebar's own (nodes-ui.js) is called directly.
    fx.cbs.onNodesChanged(fx.nodes); applyNodes(fx.nodes); fx.cbs.onWorkspace(fx.ws);
    // A drag as the browser runs it: dragstart on the row or header, dragover and drop where the pointer is (a share of
    // the target's box), dragend on the source. Answers whether the target took it.
    window.dragFire = (el, type, dt, at = [0.5, 0.5]) => {
      const r = el.getBoundingClientRect();
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width * at[0], clientY: r.top + r.height * at[1] });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    window.dragTo = (from, to, at) => {
      const dt = new DataTransfer(), src = document.querySelector(from), target = document.querySelector(to);
      fx.wsCommands.length = 0;
      dragFire(src, 'dragstart', dt);
      const over = dragFire(target, 'dragover', dt, at);
      if (over) dragFire(target, 'drop', dt, at);
      dragFire(src, 'dragend', dt);
      return over;
    };
  })(); 0`);
  await poll(); await settle(200);
  const dragTo = async (from, to, at) => {
    const over = await evaluate(`dragTo(${JSON.stringify(from)}, ${JSON.stringify(to)}, ${JSON.stringify(at)})`);
    await settle();
    return { over, commands: await evaluate('fx.wsCommands') };
  };
  const SIDE_AT = { left: [0.05, 0.5], right: [0.95, 0.5], up: [0.5, 0.05], down: [0.5, 0.95], center: [0.5, 0.5] };
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#terms .agent')].map(el => el.dataset.key)"), ['term:y1', 'term:y2', 'term:y6', 'term:y3', 'term:y4']);
  assert.equal(await evaluate("[...document.querySelectorAll('#terms .agent')].every(el => el.draggable)"), true, 'every Terminals row can be dragged');
  // A terminal with no pane here, dropped on a side of a pane: it opens there, beside that pane.
  for (const side of ['right', 'left', 'up', 'down']) {
    const r = await dragTo('#terms [data-key="term:y3"]', '.pane[data-term=y2] .pane-body', SIDE_AT[side]);
    assert.deepEqual(r.commands, [{ cmd: 'open-term', term: 'y3', place: side, at: 'y2' }], `a Terminals row dropped on the ${side} of a pane`);
  }
  // While it is over the pane, that side lights up.
  await evaluate("(() => { const dt = new DataTransfer(); dragFire(document.querySelector('#terms [data-key=\"term:y3\"]'), 'dragstart', dt); dragFire(document.querySelector('.pane[data-term=y1] .pane-body'), 'dragover', dt, [0.05, 0.5]); window.heldDrag = dt; })(); 0");
  assert.equal(await evaluate("document.querySelector('.pane[data-term=y1]').classList.contains('drop-left')"), true);
  await capture('drag-row-onto-pane');
  await evaluate("dragFire(document.querySelector('#terms [data-key=\"term:y3\"]'), 'dragend', heldDrag); 0");
  assert.equal(await evaluate("document.querySelectorAll('.pane[class*=drop-]').length"), 0, 'the marks go with the drag');
  // The middle of a pane, or the tab bar: a tab of its own.
  assert.deepEqual((await dragTo('#terms [data-key="term:y3"]', '.pane[data-term=y1] .pane-body', SIDE_AT.center)).commands, [{ cmd: 'open-term', term: 'y3', place: 'tab' }]);
  assert.deepEqual((await dragTo('#terms [data-key="term:y3"]', '#tabbar', [0.9, 0.5])).commands, [{ cmd: 'open-term', term: 'y3', place: 'tab' }]);
  // On another computer: the same command, main finds it there.
  assert.deepEqual((await dragTo('#terms [data-key="term:y4"]', '.pane[data-term=y1] .pane-body', SIDE_AT.down)).commands, [{ cmd: 'open-term', term: 'y4', place: 'down', at: 'y1' }]);
  // An agent on another computer, in a terminal known only from its live state.
  const remoteAgent = '#agents [data-key="node:node-a:Claude:rs1"]';
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(remoteAgent)}).draggable`), true);
  assert.deepEqual((await dragTo(remoteAgent, '.pane[data-term=y2] .pane-body', SIDE_AT.right)).commands, [{ cmd: 'open-term', term: 'y9', place: 'right', at: 'y2' }]);
  // A terminal with a pane here moves: beside the pane it is dropped on, out of its tab from the tab bar; onto its own
  // pane nothing happens.
  assert.deepEqual((await dragTo('#terms [data-key="term:y6"]', '.pane[data-term=y1] .pane-body', SIDE_AT.up)).commands, [{ cmd: 'move-pane', term: 'y6', into: 't1', at: 'y1', side: 'up' }]);
  assert.deepEqual((await dragTo('#terms [data-key="term:y2"]', '.pane[data-term=y1] .pane-body', SIDE_AT.left)).commands, [{ cmd: 'move-pane', term: 'y2', into: 't1', at: 'y1', side: 'left' }]);
  assert.deepEqual((await dragTo('#terms [data-key="term:y2"]', '#tabbar', [0.9, 0.5])).commands, [{ cmd: 'detach-pane', term: 'y2' }]);
  assert.deepEqual((await dragTo('#terms [data-key="term:y6"]', '#tabbar', [0.9, 0.5])).commands, [{ cmd: 'focus', term: 'y6' }], 'alone in its tab: it has a tab of its own');
  const own = await dragTo('#terms [data-key="term:y2"]', '.pane[data-term=y2] .pane-body', SIDE_AT.left);
  assert.deepEqual([own.over, own.commands], [false, []], 'its own pane does not take it');
  // A session running outside AgentDeck cannot be dragged anywhere.
  assert.equal(await evaluate("document.querySelector('#agents [data-key=\"Claude:s2\"]').draggable"), false);
  const outside = await dragTo('#agents [data-key="Claude:s2"]', '.pane[data-term=y1] .pane-body', SIDE_AT.right);
  assert.deepEqual([outside.over, outside.commands], [false, []]);
  // Held over another tab while dragging a row, that tab comes up so its panes can take the drop.
  await evaluate("(() => { const dt = new DataTransfer(); fx.wsCommands.length = 0; dragFire(document.querySelector('#terms [data-key=\"term:y3\"]'), 'dragstart', dt); dragFire(document.querySelector('.wtab[data-tab=t2]'), 'dragover', dt); window.heldDrag = dt; })(); 0");
  await settle(800);
  assert.deepEqual(await evaluate("fx.wsCommands"), [{ cmd: 'tab', tab: 't2' }], 'a row held over a tab brings it up');
  await evaluate("dragFire(document.querySelector('#terms [data-key=\"term:y3\"]'), 'dragend', heldDrag); 0");
  // A pane's header or a tab dragged onto the sidebar: hidden (the terminal keeps running), the sidebar says so first.
  await evaluate("(() => { const dt = new DataTransfer(); dragFire(document.querySelector('.pane[data-term=y1] .pane-info'), 'dragstart', dt); window.heldOver = dragFire(document.querySelector('#projects'), 'dragover', dt); window.heldDrag = dt; })(); 0");
  assert.equal(await evaluate("heldOver && $('sideOverview').classList.contains('drop-hide')"), true);
  assert.equal(await evaluate("getComputedStyle($('sideOverview'), '::after').content"), '"Drop here to hide · the terminal keeps running"');
  await capture('drag-pane-onto-sidebar');
  await evaluate("dragFire(document.querySelector('.pane[data-term=y1] .pane-info'), 'dragend', heldDrag); 0");
  assert.equal(await evaluate("$('sideOverview').classList.contains('drop-hide')"), false);
  assert.deepEqual((await dragTo('.pane[data-term=y1] .pane-info', '#agents', [0.5, 0.5])).commands, [{ cmd: 'close-pane', term: 'y1' }]);
  assert.deepEqual((await dragTo('.wtab[data-tab=t1]', '#terms', [0.5, 0.5])).commands, [{ cmd: 'close-tab', tab: 't1' }]);
  // A project dragged in its list is not a pane: nothing is hidden.
  assert.equal(await evaluate("(() => { const dt = new DataTransfer(); const p = document.querySelector('#projects .proj[draggable]'); dragFire(p, 'dragstart', dt); dragFire($('agents'), 'dragover', dt); const over = $('sideOverview').classList.contains('drop-hide'); dragFire(p, 'dragend', dt); return over; })()"), false);
  // Dragging a pane onto another pane still moves it, as before.
  assert.deepEqual((await dragTo('.pane[data-term=y1] .pane-info', '.pane[data-term=y2] .pane-body', SIDE_AT.down)).commands, [{ cmd: 'move-pane', term: 'y1', into: 't1', at: 'y2', side: 'down' }]);

  await settle(3200);
  assert.equal(await evaluate("document.querySelectorAll('.toast-item').length"), 0, 'messages leave by themselves');
  assert.deepEqual(errors, []);
  console.log('Electron manager UI: kept rows and spinners, open menus, pane buttons, shared terminals, dialogs, messages, keys and the status bar passed');
  console.log('Screenshots: ' + screenshots);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); console.error('page errors:', globalThis.pageErrors); app.exit(1); });
