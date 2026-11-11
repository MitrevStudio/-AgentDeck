// The edge menu in a real Chromium with fixture IPC: redraws that keep their tiles, rows and spinners, a row's
// buttons that take no room until they are wanted, the tile's badge line, and the top bar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const testTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bar-'));
  env.AGENTDECK_UI_TEST_TMP = testTemp;
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 90000 });
  const resolved = path.resolve(testTemp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('agentdeck-bar-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..'), src = path.join(root, 'src');
const temp = process.env.AGENTDECK_UI_TEST_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-bar-'));
const screenshots = path.join(root, '.tmp', 'bar-ui-review');
app.setPath('userData', path.join(temp, 'profile'));

// What main would answer: many projects (a group, pinned ones, repositories), running sessions, figures and previews.
const FIXTURE = `(() => {
  const now = Date.now();
  const fx = { cbs: {}, commands: [], live: [], copied: [], launched: [] };
  const names = ['agentdeck', 'EonBiz', 'BetterSelfCare', 'intranet-portal', 'irisdb', 'Documents', 'IrisAll', 'availabilityapi', 'DOTNETALL',
    'basketwrapper', 'ProblemDiagnostics', 'approvals', 'billing-gateway', 'customer-portal', 'reports', 'warehouse'];
  const session = (id, cwd, title, agent = 'Claude', age = 60000) => ({ id, agent, cwd, title, prompt: title, updatedAt: now - age });
  fx.data = {
    agents: ['Claude', 'Codex'],
    registry: { order: 'activity', groups: [{ id: 'g1', name: 'BDD' }], projects: [
      ...names.map((name, i) => ({ name, path: 'C:/work/' + name, ...(i === 2 || i === 4 ? { pin: i } : {}) })),
      { name: 'bdd-web', path: 'C:/work/bdd-web', group: 'g1' }, { name: 'bdd-ws', path: 'C:/work/bdd-ws', group: 'g1' }] },
    sessions: [session('s1', 'C:/work/agentdeck', 'Polish the edge menu so that it reads as one piece with the manager window'),
      session('s2', 'C:/work/EonBiz', 'Service activation in the EON TV portal'),
      session('s3', 'C:/work/agentdeck', 'Write the release notes', 'Codex', 3600000),
      session('s4', 'C:/work/agentdeck', 'Pairing limits that cannot be turned against the user', 'Claude', 90000000),
      session('s5', 'C:/work/bdd-web', 'Orchestrate the B1 batch', 'Claude', 7200000),
      ...names.slice(2).map((name, i) => session('p' + i, 'C:/work/' + name, 'Work in ' + name, i % 3 ? 'Claude' : 'Codex', 86400000 * (i + 1)))]
  };
  const liveOf = (id, status, extra = {}) => ({ agent: 'Claude', id, cwd: 'C:/work/agentdeck', status, pid: 100, startedAt: now - 500000, activityAt: now - 4000, statusAt: now - 4000, ...extra });
  fx.live = [liveOf('s1', 'busy', { subagents: [{ id: 'a1', type: 'builder', description: 'Builder B1 desktop', at: now, working: true }] }),
    liveOf('s2', 'idle', { cwd: 'C:/work/EonBiz', pid: 101 })];
  fx.limits = { providers: { claude: { installed: true, windows: [{ key: 'five_hour', util: 2, elapsedPct: 40, resetsAt: now + 3600000 }, { key: 'seven_day', util: 9, elapsedPct: 50, resetsAt: now + 86400000 }] },
    codex: { installed: true } } };
  const repo = (root, branch, dirty, ahead) => ({ root, branch, at: now, staged: dirty, unstaged: dirty, untracked: 0, conflicts: 0, ahead, behind: 0, upstream: 'origin/' + branch, fileCount: dirty * 2, files: [] });
  fx.git = { dirs: { 'c:/work/agentdeck': 'r1', 'c:/work/irisdb': 'r2', 'c:/work/bettercare': 'r3', 'c:/work/betterselfcare': 'r3', 'c:/work/availabilityapi': 'r4' }, repos: {
    r1: repo('C:/work/agentdeck', 'feat/ui-ux-polish', 1, 2), r2: repo('C:/work/irisdb', 'develop', 1, 0),
    r3: repo('C:/work/BetterSelfCare', 'feature/long-branch-name', 0, 0), r4: repo('C:/work/availabilityapi', 'master', 0, 0) } };
  fx.usage = { models: ['claude-fable-5'], sessions: [
    { key: 'Claude:s1', context: { tokens: 101700, window: 1000000, exact: true, at: now } }, { key: 'Claude:s2', context: { tokens: 890000, window: 1000000, exact: true, at: now } },
    { key: 'Claude:s4' }, { key: 'Codex:s3' }],
    rows: [[0, '2026-11-10', 0, 1000, 5000, 60000, 400500, 3.4, 12], [1, '2026-11-10', 0, 1000, 5000, 60000, 900500, 12.75, 30], [2, '2026-11-09', 0, 10, 50, 600, 4000, 0.02, 2], [3, '2026-11-09', 0, 100, 500, 6000, 40000, null, 2]] };
  fx.ws = { activeSpace: 'c:/work/agentdeck', spaces: { 'c:/work/agentdeck': { tabs: ['t1'], active: 't1' } },
    tabs: { t1: { id: 't1', space: 'c:/work/agentdeck', name: '', focus: 'x1', zoom: '', root: { term: 'x1' } } },
    terminals: [{ id: 'x1', cwd: 'C:/work/agentdeck', agent: 'Claude', sessionId: 's1', title: 'Claude', exited: false }] };
  const preview = id => ({ model: 'claude-fable-5', prompts: 3, replies: 7, startedAt: now - 720000, lastAt: now - 120000, more: true, messages: [
    { role: 'user', at: now - 400000, text: 'Make the edge menu read as one piece with the manager window (' + id + ').' },
    { role: 'assistant', at: now - 300000, text: 'The repositories are up to date, the branch is ready and the plan is below; no code touched yet.\\n\\n**State**\\n\\n- all three were current\\n- \`develop\` and \`master\` have no new commits' }] });
  const answers = {
    getData: async () => fx.data, getLive: async () => fx.live, getNodes: async () => [], getGit: async () => fx.git,
    getLimits: async () => fx.limits, refreshLimits: async () => fx.limits, getUsage: async () => fx.usage, refreshGit: async () => {},
    getPreview: async (_agent, id) => preview(id), searchText: async () => [], getDay: async date => ({ date, groups: [{ project: 'agentdeck', ticket: 'AD-12', sessions: [{ agent: 'Claude', id: 's1', title: 'Polish the edge menu', from: now - 7200000, to: now - 3600000, minutes: 60, branch: 'feat/ui-ux-polish', spans: [[now - 7200000, now - 3600000]] }] }] }), isDir: async () => '', getShortcuts: async () => ({ menu: 'Alt + \`' }),
    copyText: async text => { fx.copied.push(text); }, barCommand: async (...args) => { fx.commands.push(args); },
    launchAgent: async (...args) => { fx.launched.push(args); }, focusTerminal: async () => ({ ok: true, exact: true }), voiceCommandState: async () => ({ available: false })
  };
  // Answers come a moment later, as over IPC: never within the turn that asked. Every listener of an event is kept.
  const later = fn => (...args) => new Promise(resolve => setTimeout(() => resolve(fn(...args)), 1));
  const bridge = handlers => new Proxy({}, { get: (_t, name) => (String(name).startsWith('on') ? cb => { (fx.cbs[name] ||= []).push(cb); } : later(handlers[name] || (() => null))) });
  fx.emit = (name, value) => { for (const cb of fx.cbs[name] || []) cb(value); };
  window.manager = bridge(answers);
  window.terminals = bridge({ getWorkspace: async () => fx.ws, command: async (cmd, args) => { fx.commands.push([cmd, args]); } });
  window.prefs = { language: 'en', themeId: 'dark', resolvedTheme: 'dark', dayView: true, onChanged() {} };
  window.fx = fx;
})();
`;

app.whenReady().then(async () => {
  fs.mkdirSync(screenshots, { recursive: true });
  const fixtureFile = path.join(temp, 'fixture.js');
  fs.writeFileSync(fixtureFile, FIXTURE);
  // The menu's own window is see-through; a desktop-like backdrop stands behind it here.
  const html = fs.readFileSync(path.join(src, 'bar.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(src + path.sep).href}"><style>html { background: linear-gradient(135deg, #24384f, #0d1420) !important; }</style>`)
    .replace('<script src="i18n.js"></script>', `<script src="${pathToFileURL(fixtureFile).href}"></script><script src="i18n.js"></script>`);
  const file = path.join(temp, 'bar.html'); fs.writeFileSync(file, html);
  const win = new BrowserWindow({ width: 1480, height: 580, show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = globalThis.pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const evaluate = code => Promise.race([win.webContents.executeJavaScript(code).catch(error => { throw new Error(error.message + " In: " + code); }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("No answer from the page: " + code)), 10000))]);
  const settle = (ms = 60) => evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
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
  const key = (k, target = 'document') => evaluate(`${target}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true })); 0`);
  const rescan = () => evaluate("fx.emit('onDataChanged', structuredClone(fx.data)); 0");
  const poll = () => evaluate('pollLive()');
  const show = () => evaluate("fx.emit('onBarEvent', { type: 'show', mode: 'hotkey', hotkey: 'Alt + `', handle: true, motion: false }); 0");

  await win.loadFile(file); await settle(300);
  await evaluate('localStorage.clear(); 0');
  await show(); await settle(200);

  // ---------- what is open now ----------
  assert.equal(await evaluate("document.querySelector('.tile.sel').dataset.key"), 'live');
  assert.equal(await evaluate("document.querySelectorAll('#rows .row').length"), 2);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('#rows .rgroup')].map(el => el.textContent)"), ['Working', 'Ready']);
  assert.equal(await evaluate("$('liveSum').textContent.includes('ready')"), true);
  assert.equal(await evaluate("$('limits').textContent.includes('Limits ?')"), false, 'an agent with no figures is a quiet dash');
  await capture('open-now');

  // A row's buttons take no room: what a row says ends at its right edge.
  const gap = await evaluate("(() => { const row = document.querySelector('#rows .row'), st = row.querySelector('.st'); return Math.round(row.getBoundingClientRect().right - st.getBoundingClientRect().right); })()");
  assert.ok(gap < 30, `the state sits at the row's right edge (${gap}px away)`);

  // ---------- redraws keep what did not change ----------
  await evaluate("window.keptTile = document.querySelector('.tile[data-key=\"p:c:/work/irisdb\"]'); window.keptSpinner = document.querySelector('#rows .row .spinner'); window.keptRow = document.querySelector('#rows .row'); 0");
  await rescan(); await settle();
  await evaluate("fx.live[1] = { ...fx.live[1], status: 'waiting', waitingFor: 'permission' }; 0"); await poll(); await settle();
  assert.equal(await evaluate('keptTile.isConnected && keptSpinner.isConnected && keptRow.isConnected'), true, 'unchanged tiles and rows survive a redraw');
  assert.equal(await evaluate("document.querySelectorAll('#rows .rgroup')[0].textContent"), 'Need you');
  assert.equal(await evaluate("document.getAnimations().filter(a => a.animationName === 'spin').every(a => a.startTime === 0)"), true, 'spinners turn in step');
  await evaluate("fx.emit('onGitChanged', structuredClone(fx.git)); fx.emit('onUsageChanged', structuredClone(fx.usage)); 0"); await settle();
  assert.equal(await evaluate('keptTile.isConnected && keptRow.isConnected'), true, 'the same figures again draw nothing anew');

  // ---------- tiles ----------
  const overlaps = await evaluate(`[...document.querySelectorAll('.tile')].filter(tile => {
    const parts = [...tile.querySelectorAll('.tgit, .tcount, .tpin')].map(el => el.getBoundingClientRect()).filter(r => r.width);
    return parts.some((a, i) => parts.some((b, j) => j > i && a.left < b.right - 0.5 && b.left < a.right - 0.5));
  }).map(tile => tile.dataset.key)`);
  assert.deepEqual(overlaps, [], "a tile's branch, count and pin do not run into each other");
  await key('ArrowRight'); await key('ArrowRight'); await settle(100);
  assert.equal(await evaluate("document.querySelector('.tile.sel').dataset.key.startsWith('p:')"), true);
  await evaluate("selectTile('p:c:/work/agentdeck'); 0"); await settle(150);
  assert.equal(await evaluate("document.querySelectorAll('#rows .row').length"), 3);
  await capture('project');

  // ---------- rows ----------
  await key('ArrowDown'); await key('ArrowDown'); await settle();
  assert.equal(await evaluate("[...document.querySelectorAll('#rows .row')].findIndex(el => el.classList.contains('sel'))"), 1);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#rows .row.sel .ract')).visibility"), 'visible', 'the highlighted row offers its buttons');
  await capture('row-selected');
  await evaluate("document.querySelector('#rows .row.sel [data-act=delete]').click(); 0"); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.confirm.del').length"), 1);
  await rescan(); await poll(); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.confirm.del').length"), 1, 'a question under a row stays through a redraw');
  await capture('delete');
  await key('Escape'); await settle();
  assert.equal(await evaluate("document.querySelectorAll('.confirm.del').length"), 0);

  // ---------- search ----------
  await evaluate("setQuery('iris')"); await settle(350);
  assert.equal(await evaluate("document.querySelector('.tile.sel .tname').textContent"), 'irisdb');
  await capture('search');
  await evaluate("setQuery('')"); await settle(100);

  // ---------- messages, shortcuts, the day, light ----------
  await evaluate("toast('Copied C:/work/agentdeck'); 0"); await settle();
  assert.equal(await evaluate("$('toast').classList.contains('show')"), true);
  await evaluate("$('shortcutsBtn').click(); 0"); await settle(100);
  assert.equal(await evaluate("$('kbdPanel').hidden"), false);
  await capture('shortcuts');
  await key('Escape', 'window'); await settle();
  await evaluate("selectTile('day'); 0"); await settle(150);
  await capture('day');
  await evaluate("selectTile('p:c:/work/agentdeck'); document.documentElement.dataset.theme = 'light'; 0"); await capture('light');
  await evaluate("delete document.documentElement.dataset.theme; 0");
  win.setSize(1000, 580); await settle(150); await capture('narrow');
  assert.equal(await evaluate("$('shell').scrollWidth <= $('shell').clientWidth"), true);

  assert.deepEqual(errors, []);
  console.log('Electron edge menu UI: kept tiles, rows and spinners, row buttons, tile badges, search and the top bar passed');
  console.log('Screenshots: ' + screenshots);
  win.destroy(); app.exit(0);
}).catch(error => { console.error(error); console.error('page errors:', globalThis.pageErrors); app.exit(1); });
