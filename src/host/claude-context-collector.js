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
function main(configFile, input) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  let data;
  try { data = JSON.parse(input); collect(data, config.directory); } catch (e) { process.stderr.write(`AgentDeck context: ${e.message}\n`); }
  // Re-read after a clone and when the user edits their display during a session.
  try {
    const original = require('./claude-context').originalStatusLine(config.cwd, config.home);
    if (original === null) return;
    config.command = original?.command || '';
  } catch { /* Keep the last readable display command. */ }
  if (config.command) {
    const args = config.shellKind === 'powershell' ? ['-NoProfile', '-NonInteractive', '-Command', config.command] : ['-c', config.command];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(config.shell, args, { input, env, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
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
  process.stdin.on('end', () => { try { main(process.argv[2], input); } catch (e) { process.stderr.write(e.message); process.exitCode = 1; } });
}
module.exports = { collect };
