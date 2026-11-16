// Standalone statusLine command. Save only context metadata, then run the user's
// original command with the original stdin and forward its output unchanged.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const context = require('./session-context');
const { writeSync } = require('../shared/atomic-file');
const ID = /^[\w-]{1,200}$/;

function collect(data, directory, now = Date.now()) {
  if (!ID.test(data.session_id || '') || /[\\/]subagents[\\/]/.test(data.transcript_path || '')) return null;
  const c = context.statusLine(data, now);
  if (!c) return null;
  writeSync(path.join(directory, data.session_id + '.json'), JSON.stringify({ sessionId: data.session_id, context: c }));
  return c;
}
// The user's own status line command ('' when they have none), or null when they switched the status line off.
// Their settings are read again only when one of the files changed since the launch or the last update (a clone, an
// edit during a session); the launch file then keeps what was found, for the updates after it.
function display(config, configFile) {
  const { settingsStamp, originalStatusLine } = require('./claude-context');
  try {
    const seen = settingsStamp(config.cwd, config.home);
    if (seen !== config.seen) {
      const original = originalStatusLine(config.cwd, config.home);
      const next = { ...config, seen, off: original === null, command: typeof original?.command === 'string' ? original.command : '' };
      writeSync(configFile, JSON.stringify(next));
      config = next;
    }
  } catch { /* Keep the last readable display command. */ }
  return config.off ? null : config.command;
}
// The shells to try for the user's command, as [program, its arguments before the command]. The half of the status
// line command that started the collector names its shell (statusCommand: 'bash' or 'powershell', and where it is):
// the one Claude Code itself would run that command in. A command written by an older version, still used by its
// running sessions, names none; the shell found at the launch then serves, as it also does when the named one fails.
function shells(config, runner, runnerPath) {
  const kind = runner || config.shellKind;
  const programs = [runner && runnerPath, config.shellKind === kind && config.shell, kind === 'powershell' ? 'powershell.exe' : 'bash'];
  return [...new Set(programs.filter(Boolean))].map(program => [program, kind === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command'] : ['-c']]);
}
function main(configFile, input, runner, runnerPath) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  let data;
  try { data = JSON.parse(input); collect(data, config.directory); } catch (e) { process.stderr.write(`AgentDeck context: ${e.message}\n`); }
  const command = display(config, configFile);
  if (command === null) return;
  if (command) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let result;
    for (const [program, args] of shells(config, runner, runnerPath)) {
      result = spawnSync(program, [...args, command], { input, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
      if (result.error?.code !== 'ENOENT') break;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.status || (result.error ? 1 : 0);
  } else if (data) {
    const c = context.statusLine(data);
    const pct = Number.isFinite(c?.percent) ? ` · ${Math.round(c.percent)}%` : '';
    process.stdout.write(`${data.model?.display_name || 'Claude'}${c?.tokens != null ? ` · ${c.tokens.toLocaleString()} tokens${pct}` : ''}\n`);
  }
}
if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => { try { main(process.argv[2], input, process.argv[3], process.argv[4]); } catch (e) { process.stderr.write(e.message); process.exitCode = 1; } });
}
module.exports = { collect, display };
