// The status line command AgentDeck gives a Claude session (src/host/claude-context.js): run the way Claude Code runs
// it - `bash -c` (Git Bash on Windows, /bin/sh elsewhere) or `powershell -Command` - from folders with spaces, quotes
// and non-ASCII names. Each shell must save the context snapshot, show the user's own status line (or the default
// line) with its exit code, and follow an edit of the settings; and no shell may stand between Claude Code's own and
// the collector.
// A shell that is not installed is skipped.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { launchSettings, statusCommand, readSnapshots } = require('../src/host/claude-context');
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

function main() {
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
    const metadata = () => path.join(dataDir, 'claude-context', fs.readdirSync(path.join(dataDir, 'claude-context')).find(n => n.startsWith('launch-')));
    const realExec = process.execPath, realConfig = process.env.CLAUDE_CONFIG_DIR;
    process.execPath = node; process.env.CLAUDE_CONFIG_DIR = profile;
    try {
      const launch = () => {
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
  console.log(`Claude status line: one command for bash and PowerShell, no shell in between, the user's line, edits and switch-off OK (${ran.join(', ')})`);
}
try { main(); } catch (e) { console.error(e); process.exitCode = 1; } finally {
  // Only the unique temporary fixture directory created by this test is removed.
  fs.rmSync(root, { recursive: true, force: true });
}
