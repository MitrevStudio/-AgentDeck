const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { writeSync } = require('../shared/atomic-file');
const { psQuote } = require('./prompt-launch');
const shQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function shell(env = process.env) {
  if (process.platform !== 'win32') return { shell: '/bin/bash', shellKind: 'bash' };
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'),
    path.join(env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe')];
  for (const dir of (env.PATH || '').split(path.delimiter)) candidates.push(path.join(dir, '../bin/bash.exe'));
  const bash = candidates.find(p => p && fs.existsSync(p));
  return bash ? { shell: bash, shellKind: 'bash' } : { shell: 'powershell.exe', shellKind: 'powershell' };
}
// The settings files that can carry a status line, the later one winning.
function settingsFiles(cwd, home = os.homedir()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const folders = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    folders.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  return [path.join(configDir, 'settings.json'), ...folders.flatMap(dir =>
    [path.join(dir, '.claude/settings.json'), path.join(dir, '.claude/settings.local.json')])];
}
// Size and time of each of them. The collector runs on every status update and reads the settings again only when
// this changed, so an update costs no file reads there while the user's edit still shows on the next one. The time
// is in whole milliseconds: the status line program (native/StatusLine.cs) writes the same text for the same files.
function settingsStamp(cwd, home) {
  return settingsFiles(cwd, home).map(file => {
    const s = fs.statSync(file, { throwIfNoEntry: false });
    return s ? s.size + ':' + Math.floor(s.mtimeMs) : '';
  }).join('|');
}
function originalStatusLine(cwd, home) {
  let original;
  for (const file of settingsFiles(cwd, home)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const settings = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Object.hasOwn(settings, 'statusLine')) original = settings.statusLine;
  }
  return original;
}
// ---------- the status line program (Windows) ----------
// On Windows the status line does not start AgentDeck's executable: terminals outlive the app, an update moves the
// install folder away while their sessions go on asking for a status line, and an executable that is running then
// cannot be moved. The collector is a small program of its own instead (native/StatusLine.cs), compiled once into the
// data folder with the C# compiler that ships with Windows, as DockPty is (terminals.js), and far lighter to start.
// Its name carries a hash of its source: another version is another file, so one that running sessions use is never
// written over.
const PROGRAM_SOURCE = path.join(__dirname, '..', '..', 'native', 'StatusLine.cs');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const PROGRAM = /^StatusLine-[0-9a-f]{10}\.exe(\..*)?$/;
const programFile = (dataDir, source) => path.join(dataDir, `StatusLine-${crypto.createHash('sha1').update(source).digest('hex').slice(0, 10)}.exe`);
const notCompiled = new Set(); // what could not be compiled is not tried again on every launch
let builds = 0;

// The program in dataDir, compiled when it is not there yet; null where there is none (another system, no compiler,
// a compiler that is not allowed to run): the status line then goes through AgentDeck's executable, as before.
// source: the program's text, the shipped one when not given.
function statusProgram(dataDir, source) {
  if (process.platform !== 'win32') return null;
  let exe;
  try {
    source ??= fs.readFileSync(PROGRAM_SOURCE, 'utf8');
    exe = programFile(dataDir, source);
    if (fs.existsSync(exe)) return exe;
    if (notCompiled.has(exe)) return null;
    fs.mkdirSync(dataDir, { recursive: true });
    // csc reads a real file (the source may sit inside app.asar) and writes to a temporary name: an interrupted build
    // leaves no exe that would be trusted later.
    const partial = `${exe}.${process.pid}-${++builds}`, copy = `${partial}.cs`;
    try {
      fs.writeFileSync(copy, source);
      execFileSync(CSC, ['/nologo', '/optimize', '/target:exe', `/out:${partial}`, copy], { windowsHide: true, stdio: 'pipe', timeout: 60000 });
      // Another AgentDeck may have put it there meanwhile, and a session may already be running it.
      try { fs.renameSync(partial, exe); } catch (e) { if (!fs.existsSync(exe)) throw e; }
    } finally {
      for (const left of [copy, partial]) fs.rmSync(left, { force: true });
    }
    return exe;
  } catch (e) {
    console.warn('The status line program could not be compiled:', e.message);
    if (exe) notCompiled.add(exe);
    return null;
  }
}

// The status line command of a launch. Claude Code gives it to a shell: /bin/sh elsewhere, on Windows Git Bash when it
// finds one and PowerShell (pwsh or powershell.exe) when it does not, and a status line cannot name the shell itself.
// Which of the two it will be is not known here for sure (its search also depends on the environment of the terminal
// it is started in), so the Windows command is one line that both read, each as its own half:
//
//   echo "\" >$null <#" >/dev/null; <for bash> #> ; <for PowerShell>
//
// bash prints a string to nowhere, runs its half and takes the rest, behind "#", for a comment. PowerShell ends the
// string at the second quote, sends "\" to nowhere and skips the bash half as a <# #> comment. Neither starts a
// process for that. Each half then starts the collector directly, where there used to be a powershell.exe in between;
// bash does it with `exec`, in its own place, as a command in the middle of a line would cost a copy of bash first.
// Each also tells the collector which shell it is and where, and the collector runs the user's own status line in
// that one.
// The collector is the status line program (`program`) and, behind it, AgentDeck's executable as Node with
// claude-context-collector.js: what each half turns to when the program is gone (a cleaned data folder, a version
// removed as old) or may not run, so the session keeps its status line. With no program there is only the second.
// A session keeps the command it was started with, so both must go on taking these arguments.
function statusCommand(exe, collector, metadata, platform = process.platform, program = null) {
  if (platform !== 'win32') return `ELECTRON_RUN_AS_NODE=1 ${[exe, collector, metadata].map(shQuote).join(' ')}`;
  const run = [exe, collector, metadata].map(psQuote).join(' ');
  const asNode = `$env:ELECTRON_RUN_AS_NODE='1'; & ${run} powershell (Get-Process -Id $PID).Path`;
  const bashWords = files => files.map(file => shQuote(file.replace(/\\/g, '/'))).join(' ');
  const bashAsNode = `ELECTRON_RUN_AS_NODE=1 exec ${bashWords([exe, collector, metadata])} bash "$BASH"`;
  // PowerShell: a program that is not there, or is not let to start, is an error to catch, and has read nothing yet.
  // bash: `execfail` lets it go on to the next command when a program it found does not start.
  const forPowerShell = program
    ? `try { & ${[program, metadata].map(psQuote).join(' ')} powershell (Get-Process -Id $PID).Path } catch { ${asNode} }; exit $LASTEXITCODE`
    : `${asNode}; exit $LASTEXITCODE`;
  const forBash = program
    ? `shopt -s execfail; [[ -f ${bashWords([program])} ]] && exec ${bashWords([program, metadata])} bash "$BASH"; ${bashAsNode}`
    : bashAsNode;
  // No Windows path can hold what would end either half early. Should one ever, the old form goes through an extra
  // powershell.exe and is the same text for both shells.
  if (forBash.includes('#>') || /[\r\n]/.test(forBash + forPowerShell)) {
    const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${run}`;
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  return `echo "\\" >$null <#" >/dev/null; ${forBash} #> ; ${forPowerShell}`;
}
// Only a per-launch settings file is written. Existing settings and their display
// command stay intact; unreadable settings disable instrumentation for this launch.
function launchSettings(dataDir, cwd, home = os.homedir()) {
  try {
    const seen = settingsStamp(cwd, home);
    const original = originalStatusLine(cwd, home);
    // An explicit disabled or unsupported status line is respected.
    if (original === null || original && (original.type !== 'command' || typeof original.command !== 'string')) return [];
    const dir = path.join(dataDir, 'claude-context');
    const key = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24);
    const metadata = path.join(dir, `launch-${key}.json`);
    const settingsFile = path.join(dir, `settings-${key}.json`);
    writeSync(metadata, JSON.stringify({ directory: path.join(dir, 'sessions'), command: original?.command || '', cwd, home, seen, ...shell() }));
    const collector = path.join(__dirname, 'claude-context-collector.js');
    const command = statusCommand(process.execPath, collector, metadata, process.platform, statusProgram(dataDir));
    writeSync(settingsFile, JSON.stringify({ statusLine: { ...original, type: 'command', command } }));
    return ['--settings', settingsFile];
  } catch (e) {
    console.warn('Claude context collector unavailable:', e.message);
    return [];
  }
}

const snapshotsDir = dataDir => path.join(dataDir, 'claude-context', 'sessions');
// One session's snapshot file: [key, context], or null when the file is not a snapshot (or is gone). Throws while
// the file cannot be read - it is being replaced - so the caller keeps what it had and tries again.
function readSnapshot(dir, name) {
  if (!/^[\w-]{1,200}\.json$/.test(name)) return null;
  let text;
  try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const d = JSON.parse(text);
  if (name !== d.sessionId + '.json' || d.context?.source !== 'claude-statusline' || !Number.isFinite(d.context.at)) return null;
  return [`Claude:${d.sessionId}`, d.context];
}
function readSnapshots(dataDir) {
  const dir = snapshotsDir(dataDir), result = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return result; }
  for (const name of names) {
    try {
      const found = readSnapshot(dir, name);
      if (found) result.set(found[0], found[1]);
    } catch { /* A concurrently replaced file is retried on the next scan. */ }
  }
  return result;
}
// Snapshots and per-launch files are written per session and per folder and would otherwise stay forever; a running
// session rewrites its snapshot on every status update, so only files idle for maxAgeMs go. So do the status line
// programs of earlier versions, and what an interrupted build left, once they are that old: a session started long
// ago may still name one, and its command then turns to AgentDeck's executable. The current program stays.
function prune(dataDir, maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const dir = path.join(dataDir, 'claude-context');
  let current = '';
  try { if (process.platform === 'win32') current = path.basename(programFile(dataDir, fs.readFileSync(PROGRAM_SOURCE, 'utf8'))); } catch { /* no program here */ }
  for (const [folder, pattern] of [[dir, /^(launch|settings)-[0-9a-f]{24}\.json$/], [path.join(dir, 'sessions'), /^[\w-]{1,200}\.json$/], [dataDir, PROGRAM]]) {
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!pattern.test(name) || name === current) continue;
      const file = path.join(folder, name);
      try { if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file); } catch { /* replaced, gone or running meanwhile */ }
    }
  }
}
module.exports = { launchSettings, statusCommand, statusProgram, readSnapshots, readSnapshot, snapshotsDir, originalStatusLine, settingsStamp, prune };
