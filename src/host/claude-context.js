const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
function originalStatusLine(cwd, home = os.homedir()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const folders = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    folders.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  const files = [path.join(configDir, 'settings.json'), ...folders.flatMap(dir =>
    [path.join(dir, '.claude/settings.json'), path.join(dir, '.claude/settings.local.json')])];
  let original;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const settings = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Object.hasOwn(settings, 'statusLine')) original = settings.statusLine;
  }
  return original;
}
// Only a per-launch settings file is written. Existing settings and their display
// command stay intact; unreadable settings disable instrumentation for this launch.
function launchSettings(dataDir, cwd, home = os.homedir()) {
  try {
    const original = originalStatusLine(cwd, home);
    // An explicit disabled or unsupported status line is respected.
    if (original === null || original && (original.type !== 'command' || typeof original.command !== 'string')) return [];
    const dir = path.join(dataDir, 'claude-context');
    const key = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 24);
    const metadata = path.join(dir, `launch-${key}.json`);
    const settingsFile = path.join(dir, `settings-${key}.json`);
    writeSync(metadata, JSON.stringify({ directory: path.join(dir, 'sessions'), command: original?.command || '', cwd, home, ...shell() }));
    const collector = path.join(__dirname, 'claude-context-collector.js');
    let command;
    if (process.platform === 'win32') {
      const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${[process.execPath, collector, metadata].map(psQuote).join(' ')}`;
      command = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
    } else command = `ELECTRON_RUN_AS_NODE=1 ${[process.execPath, collector, metadata].map(shQuote).join(' ')}`;
    writeSync(settingsFile, JSON.stringify({ statusLine: { ...original, type: 'command', command } }));
    return ['--settings', settingsFile];
  } catch (e) {
    console.warn('Claude context collector unavailable:', e.message);
    return [];
  }
}

function readSnapshots(dataDir) {
  const dir = path.join(dataDir, 'claude-context', 'sessions'), result = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return result; }
  for (const name of names) {
    if (!/^[\w-]{1,200}\.json$/.test(name)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (name !== d.sessionId + '.json' || d.context?.source !== 'claude-statusline' || !Number.isFinite(d.context.at)) continue;
      result.set(`Claude:${d.sessionId}`, d.context);
    } catch { /* A concurrently replaced file is retried on the next scan. */ }
  }
  return result;
}
// Snapshots and per-launch files are written per session and per folder and would otherwise stay forever; a running
// session rewrites its snapshot on every status update, so only files idle for maxAgeMs go.
function prune(dataDir, maxAgeMs = 30 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const dir = path.join(dataDir, 'claude-context');
  for (const [folder, pattern] of [[dir, /^(launch|settings)-[0-9a-f]{24}\.json$/], [path.join(dir, 'sessions'), /^[\w-]{1,200}\.json$/]]) {
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const file = path.join(folder, name);
      try { if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file); } catch { /* replaced or gone meanwhile */ }
    }
  }
}
module.exports = { launchSettings, readSnapshots, originalStatusLine, prune };
