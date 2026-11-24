// The status line command AgentDeck gives a Claude session (src/host/claude-context.js): run the way Claude Code runs
// it - `bash -c` (Git Bash on Windows, /bin/sh elsewhere) or `powershell -Command` - from folders with spaces, quotes
// and non-ASCII names. Each shell must save the context snapshot, show the user's own status line (or the default
// line) with its exit code, and follow an edit of the settings; and no shell may stand between Claude Code's own and
// the collector.
// On Windows the collector is the status line program (native/StatusLine.cs), compiled here as AgentDeck compiles it:
// it must do all of that without AgentDeck's executable, write the very figures the JavaScript collector writes, leave
// the session its status line when it is gone or may not run, and stand a newer version being put beside it while it
// runs.
// A shell that is not installed is skipped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launchSettings, statusCommand, statusProgram, readSnapshots, prune } = require('../src/host/claude-context');
const collector = require('../src/host/claude-context-collector');

const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-statusline-'));
// Legal in a folder name on every platform, and each one special to bash, to PowerShell or to both.
const odd = "it's a `test` #1 $HOME %TEMP% & (é 日本)";
const sh = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const ps = s => "'" + String(s).replace(/'/g, "''") + "'";
const data = { session_id: 'fixture-session', model: { id: 'claude-test', display_name: 'Test' },
  context_window: { current_usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 40 },
    context_window_size: 1000, used_percentage: 10 }, note: 'é 日本' };
const input = JSON.stringify(data) + '\n';

// Where Claude Code looks for Git Bash on Windows, in its order.
function gitBash() {
  const named = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const candidates = [named, 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ...onPath('git.exe').map(git => path.join(git, '..', '..', 'bin', 'bash.exe'))];
  return candidates.find(file => file && fs.existsSync(file));
}
function onPath(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)).filter(file => fs.existsSync(file));
}
// name, how Claude Code starts a command in it, and how a user would write "run this program with this file" for it.
function shells() {
  const bash = file => ({ name: file, kind: 'bash', run: command => [file, ['-c', command]], call: (...words) => words.map(sh).join(' ') });
  // Claude Code adds the last line to every PowerShell hook command.
  const powershell = file => ({ name: file, kind: 'powershell', call: (...words) => '& ' + words.map(ps).join(' '),
    run: command => [file, ['-NoProfile', '-NonInteractive', '-Command', command + '\n; if (-not $?) { if ($LASTEXITCODE -eq 2) { exit 2 } }']] });
  if (!windows) return ['/bin/sh', '/bin/bash'].filter(file => fs.existsSync(file)).map(bash);
  return [gitBash() && bash(gitBash()), powershell('powershell.exe'), onPath('pwsh.exe')[0] && powershell(onPath('pwsh.exe')[0])].filter(Boolean);
}

// The collector runs in "AgentDeck's executable as Node": here Node itself, from a folder with the odd name.
function executable(dir) {
  const file = path.join(dir, path.basename(process.execPath));
  if (windows) { try { fs.linkSync(process.execPath, file); } catch { fs.copyFileSync(process.execPath, file); } }
  else fs.symlinkSync(process.execPath, file);
  return file;
}

// The status JSON Claude Code sends, sound and not: [name, the text on stdin].
function inputs() {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 90, output_tokens: 40 };
  const full = { session_id: 'fixture-full', transcript_path: 'C:\\fixture\\projects\\one\\fixture-full.jsonl', model: { id: 'claude-test', display_name: 'Test' },
    context_window: { current_usage: usage, context_window_size: 200000, used_percentage: 12.5 } };
  const but = (change, id) => JSON.stringify({ ...full, session_id: id, ...change });
  const window = change => ({ context_window: { ...full.context_window, ...change } });
  return [
    ['whole', but({}, 'fixture-whole')],
    ['a newline after it', but({}, 'fixture-newline') + '\r\n'],
    ['no usage yet', but(window({ current_usage: null, used_percentage: null }), 'fixture-pending')],
    ['a warm cache', but({ prompt_cache: { warm: true, expires_at: 1900000000 } }, 'fixture-warm')],
    ['a warm cache to half a second', but({ prompt_cache: { warm: true, expires_at: 1900000000.5 } }, 'fixture-warm-half')],
    ['a cold cache', but({ prompt_cache: { warm: false, expires_at: 1900000000 } }, 'fixture-cold')],
    ['a cache that says nothing', but({ prompt_cache: { warm: 'yes' } }, 'fixture-cache-odd')],
    ['a subagent', but({ agent: { id: 'agent-1' } }, 'fixture-agent')],
    ['an agent without an id', but({ agent: { name: 'main' } }, 'fixture-agent-none')],
    ['a task', but({ task: { id: 't1' } }, 'fixture-task')],
    ['a subagent\'s transcript', but({ transcript_path: 'C:\\fixture\\projects\\one\\subagents\\agent.jsonl' }, 'fixture-subagent-path')],
    ['a transcript that only mentions subagents', but({ transcript_path: '/fixture/subagents-notes/one.jsonl' }, 'fixture-subagents-word')],
    ['a third of the window', but(window({ used_percentage: 33.333333333333336 }), 'fixture-third')],
    ['a percent of many digits', but({}, 'fixture-digits').replace('12.5', '33.33333333333333333333333')],
    ['a percent as an exponent', but({}, 'fixture-exponent').replace('12.5', '1.25E+1').replace('200000', '2e5')],
    ['a tenth of a percent', but(window({ used_percentage: 0.1 }), 'fixture-tenth')],
    ['half a percent short of full', but(window({ used_percentage: 99.5 }), 'fixture-round')],
    ['no percent', but(window({ used_percentage: null }), 'fixture-no-percent')],
    ['a percent below zero', but(window({ used_percentage: -1 }), 'fixture-negative')],
    ['zero tokens', but(window({ current_usage: { input_tokens: 0 }, used_percentage: 0 }), 'fixture-zero')],
    ['counts that are not numbers', but(window({ current_usage: { input_tokens: '12', cache_read_input_tokens: -3, cache_creation_input_tokens: 7 } }), 'fixture-counts')],
    ['usage that is no object', but(window({ current_usage: 5 }), 'fixture-usage-odd')],
    ['a window without a size', but(window({ context_window_size: null }), 'fixture-no-size')],
    ['a window that is no object', but({ context_window: true }, 'fixture-window-odd')],
    ['no window', but({ context_window: null }, 'fixture-no-window')],
    ['a million tokens of window', but(window({ context_window_size: 1000000 }), 'fixture-million')],
    ['no model', but({ model: null }, 'fixture-no-model')],
    ['a model named in other scripts', but({ model: { id: 'м"оде\\л\n\t\u0001 日本 \u{1F600}', display_name: 'Модел 日本 \u{1F600}' } }, 'fixture-names')],
    ['a model with half a character', but({ model: { id: 'half \ud83d' } }, 'fixture-half')],
    ['a model that is a number', but({ model: { id: 5, display_name: 7 } }, 'fixture-model-number')],
    ['a key given twice', but({}, 'fixture-twice').replace('"session_id":"fixture-twice"', '"session_id":"fixture-first","session_id":"fixture-twice"')],
    ['a session id with a space', but({}, 'not a name')],
    ['a session id that is a path', but({}, '..\\outside')],
    ['a session id too long', but({}, 'x'.repeat(201))],
    ['the longest session id', but({}, 'x'.repeat(200))],
    ['no session id', but({ session_id: undefined }, undefined)],
    ['not JSON', 'not JSON'],
    ['JSON with more after it', but({}, 'fixture-more') + ' x'],
    ['a number with a zero in front', but({}, 'fixture-zero-front').replace('12.5', '012.5')],
    ['nothing', ''],
    ['null', 'null'],
    ['a number', '5'],
    ['a list', '[]'],
    ['a text', '"text"'],
  ];
}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

// The status line program beside the JavaScript collector it stands in for: the same input to both.
function sameAsCollector(program) {
  const base = fs.mkdtempSync(path.join(root, 'same-'));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'profile') };
  const cases = inputs();
  const project = path.join(base, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '\uFEFF' + JSON.stringify({ statusLine: { type: 'command', command: '' } }));
  for (const [name, text] of cases) {
    const results = [program, process.execPath].map((exe, i) => {
      const dir = fs.mkdtempSync(path.join(base, i ? 'collector-' : 'program-')), launch = path.join(dir, 'launch.json');
      // What else the launch file holds stays in it when the settings are read again.
      fs.writeFileSync(launch, JSON.stringify({ directory: path.join(dir, 'sessions'), command: 'stale', cwd: project + path.sep, home: base, kept: [1.5, 'é', null] }).replace('1.5', '1.50'));
      const before = Date.now();
      const r = spawnSync(exe, i ? [path.resolve('src/host/claude-context-collector.js'), launch] : [launch], { input: text, env, encoding: 'utf8', windowsHide: true });
      assert.ifError(r.error);
      const saved = fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')).sort() : [];
      const files = saved.map(file => {
        const snapshot = JSON.parse(fs.readFileSync(path.join(dir, 'sessions', file), 'utf8'));
        assert.ok(snapshot.context.at >= before && snapshot.context.at <= Date.now(), `${name}: the time of the snapshot`);
        return [file, { ...snapshot, context: { ...snapshot.context, at: 0 } }, Object.keys(snapshot.context)];
      });
      return { stdout: r.stdout, status: r.status, complained: r.stderr !== '', files, launch: { ...JSON.parse(fs.readFileSync(launch, 'utf8')), directory: '' } };
    });
    assert.deepStrictEqual(results[0], results[1], `the status line program and the collector differ for ${name}`);
  }
  // What they agreed on is what the collector is known to write.
  const whole = cases.find(([name]) => name === 'whole')[1];
  const dir = fs.mkdtempSync(path.join(base, 'whole-')), launch = path.join(dir, 'claude-context', 'launch.json');
  fs.mkdirSync(path.dirname(launch));
  fs.writeFileSync(launch, JSON.stringify({ directory: path.join(dir, 'claude-context', 'sessions'), command: '', cwd: base, home: base }));
  const r = spawnSync(program, [launch], { input: whole, env, encoding: 'utf8', windowsHide: true });
  assert.equal(r.stdout, `Test · 105 tokens · 13%\n`, r.stderr);
  const context = readSnapshots(dir).get('Claude:fixture-whole');
  assert.deepStrictEqual({ ...context, at: 0 }, { tokens: 105, at: 0, model: 'claude-test', provider: '', window: 200000, exact: true,
    source: 'claude-statusline', status: 'reported', percent: 12.5, cache: null, warmUntil: 0 });
  return cases.length;
}

// A newer version comes while a session runs the one it was started with; versions no longer current go when old.
async function besideARunningOne(program) {
  const base = fs.mkdtempSync(path.join(root, 'versions-')), dataDir = path.join(base, 'data'), launch = path.join(base, 'launch.json');
  const day = 24 * 60 * 60 * 1000, old = new Date(Date.now() - 40 * day);
  const current = statusProgram(dataDir);
  assert.equal(path.basename(current), path.basename(program), 'the same source gives the same name in every data folder');
  // Another source, as another version of AgentDeck would bring: another file, the first one untouched.
  const written = fs.statSync(current).mtimeMs;
  const earlier = statusProgram(dataDir, fs.readFileSync(path.resolve('native/StatusLine.cs'), 'utf8') + '\n// An earlier version.\n');
  assert.notEqual(earlier, current);
  assert.equal(fs.statSync(current).mtimeMs, written);
  assert.equal(statusProgram(dataDir), current, 'a program that is there is not compiled again');
  // A session runs the earlier one: its own status line takes a while.
  const wait = path.join(base, 'wait.js'), started = path.join(base, 'started');
  fs.writeFileSync(wait, `require('node:fs').writeFileSync(${JSON.stringify(started)}, ''); setTimeout(() => process.stdout.write('LATE'), 1500);`);
  fs.mkdirSync(path.join(base, '.claude'));
  fs.writeFileSync(path.join(base, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `& ${ps(process.execPath)} ${ps(wait)}` } }));
  fs.writeFileSync(launch, JSON.stringify({ directory: path.join(dataDir, 'claude-context', 'sessions'), command: '', cwd: base, home: base }));
  const child = spawn(earlier, [launch, 'powershell', 'powershell.exe'], { windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'profile') } });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const ended = new Promise((resolve, reject) => child.on('error', reject).on('close', resolve));
  child.stdin.end(input);
  for (let i = 0; !fs.existsSync(started); i++) {
    assert.ok(i < 200, 'the status line of the earlier version did not start');
    await tick(50);
  }
  // Meanwhile it grows old, and so does what interrupted builds left; the current one is old too, and stays.
  const leftovers = ['StatusLine-0123456789.exe.123-1', 'StatusLine-0123456789.exe.123-1.cs'].map(name => path.join(dataDir, name));
  const fresh = path.join(dataDir, 'StatusLine-9876543210.exe.456-1'), other = path.join(dataDir, 'DockPty-0123456789.exe');
  for (const file of [...leftovers, fresh, other]) fs.writeFileSync(file, '');
  for (const file of [earlier, current, other, ...leftovers]) fs.utimesSync(file, old, old);
  prune(dataDir);
  assert.ok(fs.existsSync(earlier), 'a program that is running stays');
  assert.deepEqual(leftovers.filter(file => fs.existsSync(file)), []);
  assert.ok(fs.existsSync(current) && fs.existsSync(fresh) && fs.existsSync(other));
  assert.equal(await ended, 0);
  assert.equal(stdout, 'LATE');
  assert.equal(readSnapshots(dataDir).get('Claude:fixture-session').tokens, 100);
  // It was started before it grew old. A session that still uses it says so with every status update, and it stays.
  const once = () => spawnSync(earlier, [launch, 'powershell', 'powershell.exe'], { input: 'not JSON', windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, 'profile') } });
  fs.writeFileSync(path.join(base, '.claude', 'settings.json'), JSON.stringify({ statusLine: null }));
  assert.equal(once().status, 0);
  assert.ok(Date.now() - fs.statSync(earlier).mtimeMs < day, 'a program that ran is marked as used');
  prune(dataDir);
  assert.ok(fs.existsSync(earlier), 'an old program of another version stays while sessions use it');
  const marked = new Date(Date.now() - day / 2);
  fs.utimesSync(earlier, marked, marked);
  assert.equal(once().status, 0);
  assert.equal(fs.statSync(earlier).mtimeMs, marked.getTime(), 'and is not marked again the same day');
  // Nothing has used it for a month.
  fs.utimesSync(earlier, old, old);
  prune(dataDir);
  assert.ok(!fs.existsSync(earlier), 'an old program of another version goes once nothing uses it');
  assert.ok(fs.existsSync(current));
}

async function main() {
  // ---------- the command itself ----------
  assert.equal(statusCommand('/opt/a b/app', "/opt/it's/collector.js", '/data/launch.json', 'linux'),
    "ELECTRON_RUN_AS_NODE=1 '/opt/a b/app' '/opt/it'\\''s/collector.js' '/data/launch.json'");
  const win = statusCommand('C:\\Program Files\\App\\App.exe', "C:\\it's\\collector.js", 'C:\\data\\launch.json', 'win32');
  // One line, no shell in between: each half names the executable once, no powershell.exe is started for it, and bash
  // starts it in its own place.
  assert.ok(!/powershell\.exe|EncodedCommand|[\r\n]/.test(win), win);
  const [, forBash, forPowerShell] = /^echo "\\" >\$null <#" >\/dev\/null; (.*) #> ; (.*)$/.exec(win);
  assert.equal(forBash.split('App.exe').length, 2);
  assert.equal(forPowerShell.split('App.exe').length, 2);
  assert.equal(forBash, `ELECTRON_RUN_AS_NODE=1 exec 'C:/Program Files/App/App.exe' 'C:/it'\\''s/collector.js' 'C:/data/launch.json' bash "$BASH"`);
  assert.ok(forPowerShell.includes("& 'C:\\Program Files\\App\\App.exe' 'C:\\it''s\\collector.js'"));
  // A path that would end bash's half inside PowerShell's comment: the old form, the same text for both shells.
  assert.match(statusCommand('C:\\a#>b\\App.exe', 'c.js', 'm.json', 'win32'), /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
  // With the status line program: each half starts it first and alone, and names AgentDeck's executable only for when
  // the program is not there or does not start.
  const withProgram = statusCommand('C:\\Program Files\\App\\App.exe', "C:\\it's\\collector.js", 'C:\\data\\launch.json', 'win32', "C:\\it's data\\StatusLine-0123456789.exe");
  assert.ok(!/powershell\.exe|EncodedCommand|[\r\n]/.test(withProgram), withProgram);
  const [, bashWithProgram, powerShellWithProgram] = /^echo "\\" >\$null <#" >\/dev\/null; (.*) #> ; (.*)$/.exec(withProgram);
  assert.equal(bashWithProgram, `shopt -s execfail; [[ -f 'C:/it'\\''s data/StatusLine-0123456789.exe' ]] && exec 'C:/it'\\''s data/StatusLine-0123456789.exe' 'C:/data/launch.json' bash "$BASH"; ${forBash}`);
  assert.equal(powerShellWithProgram, "try { & 'C:\\it''s data\\StatusLine-0123456789.exe' 'C:\\data\\launch.json' powershell (Get-Process -Id $PID).Path } catch { " +
    forPowerShell.replace(/; exit \$LASTEXITCODE$/, '') + ' }; exit $LASTEXITCODE');
  assert.equal(statusCommand('/opt/app', '/opt/collector.js', '/data/launch.json', 'linux', '/data/StatusLine'), "ELECTRON_RUN_AS_NODE=1 '/opt/app' '/opt/collector.js' '/data/launch.json'");

  // ---------- in every shell ----------
  const ran = [];
  for (const shell of shells()) {
    const base = fs.mkdtempSync(path.join(root, 'run-'));
    const dataDir = path.join(base, odd, 'data'), project = path.join(base, odd, 'project'), profile = path.join(base, 'profile');
    for (const dir of [dataDir, path.join(project, '.claude'), profile]) fs.mkdirSync(dir, { recursive: true });
    const settingsPath = path.join(project, '.claude', 'settings.json');
    const show = path.join(base, odd, 'show.js');
    fs.writeFileSync(show, "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);" +
      "process.stdout.write(process.argv[2]+':'+d.session_id+':'+d.note+':'+(process.env.ELECTRON_RUN_AS_NODE||'-'));process.exitCode=+process.argv[3]||0;});");
    const node = executable(path.join(base, odd));
    // On Windows the status line program does the work: a launch names for AgentDeck's executable one that is not
    // there, so nothing below can have come from it.
    const absent = path.join(base, odd, 'absent', path.basename(process.execPath));
    const metadata = () => path.join(dataDir, 'claude-context', fs.readdirSync(path.join(dataDir, 'claude-context')).find(n => n.startsWith('launch-')));
    const realExec = process.execPath, realConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = profile;
    try {
      const launch = (exe = windows ? absent : node) => {
        process.execPath = exe;
        const args = launchSettings(dataDir, project, base);
        return args.length ? JSON.parse(fs.readFileSync(args[1], 'utf8')).statusLine : null;
      };
      const run = command => {
        const [file, args] = shell.run(command);
        const r = spawnSync(file, args, { input, encoding: 'utf8', windowsHide: true, cwd: project });
        assert.ifError(r.error);
        return r;
      };
      const where = `in ${shell.name}`;

      // No status line of the user's: the default line, and the snapshot.
      let line = launch();
      if (windows) assert.ok(!/powershell\.exe|EncodedCommand/.test(line.command), 'no shell between Claude Code\'s and the collector');
      const program = statusProgram(dataDir);
      assert.equal(Boolean(program), windows);
      if (windows) assert.ok(line.command.includes(path.basename(program)) && path.dirname(program) === dataDir, 'the status line program, in the data folder');
      let r = run(line.command);
      assert.equal(r.stdout, 'Test · 100 tokens · 10%\n', `${where}: ${r.stderr}`);
      assert.equal(r.status, 0, where);
      const snapshot = readSnapshots(dataDir).get('Claude:fixture-session');
      assert.equal(snapshot.tokens, 100, where);
      assert.equal(snapshot.window, 1000, where);
      assert.equal(snapshot.percent, 10, where);
      fs.rmSync(path.join(dataDir, 'claude-context', 'sessions'), { recursive: true });

      // Their own status line: its output and exit code, their other settings, the same input, and again a snapshot.
      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: shell.call(node, show, 'FIRST', '3'), padding: 2 } }));
      line = launch();
      assert.equal(line.padding, 2);
      r = run(line.command);
      assert.equal(r.stdout, 'FIRST:fixture-session:é 日本:-', `${where}: ${r.stderr}`);
      // `powershell -Command` itself ends with 1 for any failed program, with or without AgentDeck in between.
      assert.equal(r.status, shell.kind === 'powershell' ? 1 : 3, where);
      assert.equal(readSnapshots(dataDir).get('Claude:fixture-session').tokens, 100, where);

      // Nothing changed in the settings: the launch file is not written again.
      const before = fs.statSync(metadata()).mtimeMs;
      assert.equal(run(line.command).stdout, 'FIRST:fixture-session:é 日本:-', where);
      assert.equal(fs.statSync(metadata()).mtimeMs, before, where);

      // The collector runs it in the kind of shell that started the collector, not in one it looks for itself.
      if (windows) {
        const bash = shell.kind === 'bash';
        fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: bash ? 'echo "in $BASH"' : '"in $((Get-Process -Id $PID).Path)"' } }));
        assert.match(run(line.command).stdout.trim(), bash ? /^in \/usr\/bin\/(ba)?sh$/ : new RegExp(`^in .*\\\\${path.basename(shell.name)}$`, 'i'), where);
      }

      // Edited during the session: the next update shows the new one, with the same command line.
      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: shell.call(node, show, 'SECOND') } }));
      r = run(line.command);
      assert.equal(r.stdout, 'SECOND:fixture-session:é 日本:-', `${where}: ${r.stderr}`);
      assert.equal(r.status, 0, where);

      // A command an older version wrote names no shell; its running sessions still get their line.
      // (The shell it then uses is the one found at the launch, here bash.)
      if (shell.kind === 'bash') {
        r = spawnSync(node, [path.resolve('src/host/claude-context-collector.js'), metadata()], { input, encoding: 'utf8', windowsHide: true });
        assert.equal(r.stdout, 'SECOND:fixture-session:é 日本:-', `${where}: ${r.stderr}`);
      }

      // The program is gone, or may not be started: the session's command turns to AgentDeck's executable, which
      // shows the same line and saves the same figures; with the program back, it is the program again.
      if (windows) {
        const snapshots = path.join(dataDir, 'claude-context', 'sessions');
        const same = (when, command) => {
          fs.rmSync(snapshots, { recursive: true });
          r = run(command);
          assert.equal(r.stdout, 'SECOND:fixture-session:é 日本:-', `${where}, ${when}: ${r.stderr}`);
          assert.equal(r.status, 0, `${where}, ${when}`);
          assert.equal(readSnapshots(dataDir).get('Claude:fixture-session').tokens, 100, `${where}, ${when}`);
        };
        const both = launch(node).command;
        fs.renameSync(program, program + '.away');
        same('the program gone', both);
        fs.renameSync(program + '.away', program);
        // Everyone is denied the right to execute it, as a policy on programs would.
        const everyone = '*S-1-1-0';
        assert.equal(spawnSync('icacls', [program, '/deny', `${everyone}:(X)`], { windowsHide: true }).status, 0);
        try { same('the program not allowed to start', both); } finally {
          assert.equal(spawnSync('icacls', [program, '/remove:d', everyone], { windowsHide: true }).status, 0);
        }
        same('the program back', launch().command);
      }

      // Switched off during the session: nothing is shown, and a new launch leaves the status line alone.
      fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: null }));
      r = run(line.command);
      assert.equal(r.stdout, '', `${where}: ${r.stderr}`);
      assert.equal(r.status, 0, where);
      assert.equal(launch(), null);
      ran.push(path.basename(shell.name));
    } finally {
      process.execPath = realExec;
      if (realConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = realConfig;
    }
  }
  assert.ok(ran.length, 'no shell to run the status line in');

  // ---------- the status line program ----------
  let compared = 0;
  if (windows) {
    const program = statusProgram(path.join(root, 'program'));
    compared = sameAsCollector(program);
    await besideARunningOne(program);
  }

  // ---------- the settings are read only when they changed ----------
  const dir = fs.mkdtempSync(path.join(root, 'stamp-')), project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const settingsPath = path.join(project, '.claude', 'settings.json'), configFile = path.join(dir, 'launch.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'one' } }));
  const realConfig = process.env.CLAUDE_CONFIG_DIR, realRead = fs.readFileSync;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'profile');
  let reads = 0;
  fs.readFileSync = function (file, ...rest) { if (/settings(\.local)?\.json$/.test(String(file))) reads++; return realRead.call(this, file, ...rest); };
  try {
    const config = () => JSON.parse(realRead(configFile, 'utf8'));
    fs.writeFileSync(configFile, JSON.stringify({ cwd: project, home: dir, command: 'stale' }));
    assert.equal(collector.display(config(), configFile), 'one');
    assert.ok(reads > 0);
    reads = 0;
    assert.equal(collector.display(config(), configFile), 'one');
    assert.equal(reads, 0, 'unchanged settings are not read again');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'another' } }));
    assert.equal(collector.display(config(), configFile), 'another');
    // Unreadable settings: the last readable command stays, and they are tried again on the next update.
    fs.writeFileSync(settingsPath, '{ broken');
    assert.equal(collector.display(config(), configFile), 'another');
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: null }));
    assert.equal(collector.display(config(), configFile), null);
    fs.unlinkSync(settingsPath);
    assert.equal(collector.display(config(), configFile), '');
  } finally {
    fs.readFileSync = realRead;
    if (realConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = realConfig;
  }
  const native = windows ? `; the status line program without AgentDeck's executable, the collector's figures for ${compared} inputs, the way back to the executable, versions side by side` : '';
  console.log(`Claude status line: one command for bash and PowerShell, no shell in between, the user's line, edits and switch-off${native} OK (${ran.join(', ')})`);
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  // Only the unique temporary fixture directory created by this test is removed.
  fs.rmSync(root, { recursive: true, force: true });
});
