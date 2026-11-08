// Optional Windows integration: installed Codex CLI + real DockPty, isolated home, no model request or account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTerminals } = require('../src/host/terminals');
const { createLaunch } = require('../src/host/launch');
const { readIdentity } = require('../src/host/codex-link');

(async () => {
  if (process.platform !== 'win32') throw new Error('This integration check needs Windows, DockPty and Codex CLI.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-codex-launch-'));
  const config = [
    'model = "audit-fixture"', 'model_provider = "audit"',
    '[model_providers.audit]', 'name = "Offline audit fixture"', 'base_url = "http://127.0.0.1:1/v1"',
    'wire_api = "responses"', 'requires_openai_auth = false',
    `[projects.${JSON.stringify(dir)}]`, 'trust_level = "trusted"',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.toml'), config);
  const terminals = createTerminals({ userDataDir: dir, onData() {}, onExit() {}, onChange() {} });
  try {
    const launch = createLaunch({ dataDir: dir, terminals });
    const spec = launch.newCommand('Codex', dir);
    const id = await launch.openTerminal(dir, spec.command, spec.meta, { ...process.env, CODEX_HOME: dir }, 'audit');
    let identity = '';
    for (let i = 0; i < 50 && !identity; i++) {
      await new Promise(r => setTimeout(r, 200));
      identity = await readIdentity(spec.meta.codexLog);
    }
    assert.match(identity, /^[0-9a-f-]{36}$/);
    assert.equal(terminals.getTabs().find(t => t.id === id).agentOnly, true);
    console.log('Real Codex launch: isolated profile, session identity and agent-only terminal OK');
  } finally {
    terminals.stopAll();
    await require('../src/shared/atomic-file').flush();
    await new Promise(r => setTimeout(r, 500));
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('agentdeck-codex-launch-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
