const assert = require('node:assert/strict');
const { createWorkspace } = require('../src/workspace');
const { readCodexTitles } = require('../src/host/codex-titles');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = createWorkspace({ onChange() {} });
const first = workspace.addTab('project', 'terminal-1');
const second = workspace.addTab('project', 'terminal-2');
workspace.showSessions();
assert.equal(workspace.getActiveTab(), null);
assert.deepEqual(workspace.getTabTerms(first), ['terminal-1']);
assert.deepEqual(workspace.getTabTerms(second), ['terminal-2']);
assert.equal(workspace.snapshot().activeSpace, 'project');
workspace.activateTab(first);
assert.equal(workspace.getActiveTab().id, first);
workspace.showSessions();
const saved = workspace.exportState();
workspace.importState(saved, id => id);
assert.equal(workspace.getActiveTab(), null, 'picker stays selected after restoring layout');
assert.equal(workspace.snapshot().spaces.project.tabs.length, 2);
const third = workspace.addTab('project', 'terminal-3');
assert.equal(workspace.getActiveTab().id, third, 'new terminal replaces picker with its tab');
workspace.showSessions();
workspace.addTab('other-project', 'terminal-4');
workspace.activateSpace('project');
assert.equal(workspace.getActiveTab(), null, 'picker selection belongs to its project');
workspace.activateTab(second);
assert.equal(workspace.getActiveTab().id, second);
workspace.renameTab(second, 'Named session');
workspace.importState(workspace.exportState(), id => id);
assert.equal(workspace.getActiveTab().name, 'Named session');
workspace.renameTab(second, '');
assert.equal(workspace.getActiveTab().name, '', 'empty name restores automatic session title');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-titles-'));
const index = path.join(dir, 'session_index.jsonl');
try {
  fs.writeFileSync(index, [
    JSON.stringify({ id: 'thread', thread_name: 'Original title' }),
    'invalid line',
    JSON.stringify({ id: 'thread', thread_name: 'Renamed session' }),
    '{"id":',
  ].join('\n'));
  assert.equal(readCodexTitles(index).get('thread'), 'Renamed session');
  assert.equal(readCodexTitles(path.join(dir, 'missing')).size, 0);
} finally {
  fs.unlinkSync(index);
  fs.rmdirSync(dir);
}
console.log('Project session picker preserves tabs, restores state and selects existing/new tabs OK');
