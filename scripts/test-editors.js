// findIdea (src/shared/editors.js): PATH first, the newest install otherwise, never a launcher script for a shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findIdea } = require('../src/shared/editors');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-editors-'));
const touch = (...parts) => { const file = path.join(root, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };
try {
  const programFiles = path.join(root, 'Program Files'), local = path.join(root, 'Local'), scripts = path.join(root, 'scripts'), bin = path.join(root, 'bin');
  const win = extra => ({ platform: 'win32', home: root, env: { ProgramFiles: programFiles, LOCALAPPDATA: local, PATH: '', ...extra } });
  assert.equal(findIdea(win()), '', 'none installed');
  // Toolbox's shell script on PATH is not a program to start.
  touch('scripts', 'idea.cmd');
  assert.equal(findIdea(win({ PATH: scripts })), '');
  const older = touch('Local', 'Programs', 'IntelliJ IDEA Ultimate 2024.3', 'bin', 'idea64.exe');
  assert.equal(findIdea(win({ PATH: scripts })), older, 'the Toolbox install, the script on PATH aside');
  const newer = touch('Program Files', 'JetBrains', 'IntelliJ IDEA 2025.1', 'bin', 'idea64.exe');
  touch('Program Files', 'JetBrains', 'IntelliJ IDEA Community Edition 2023.2', 'bin', 'idea64.exe');
  fs.mkdirSync(path.join(programFiles, 'JetBrains', 'IntelliJ IDEA 2026.1', 'bin'), { recursive: true }); // a leftover folder without the program
  touch('Program Files', 'JetBrains', 'PyCharm 2026.1', 'bin', 'idea64.exe');
  assert.equal(findIdea(win()), newer, 'the newest install, whichever folder and edition');
  // Toolbox names its folder without a version: product-info.json states it.
  const toolboxWin = touch('Local', 'Programs', 'IntelliJ IDEA Ultimate', 'bin', 'idea64.exe');
  fs.writeFileSync(path.join(local, 'Programs', 'IntelliJ IDEA Ultimate', 'product-info.json'), JSON.stringify({ version: '2025.2.1' }));
  assert.equal(findIdea(win()), toolboxWin, 'the version comes from product-info.json');
  const onPath = touch('bin', 'idea64.exe');
  assert.equal(findIdea(win({ PATH: [scripts, bin].join(path.delimiter) })), onPath, 'PATH comes first');
  // Linux: the launcher on PATH, else an install under ~/.local/share/JetBrains/Toolbox/apps.
  const linux = extra => ({ platform: 'linux', home: path.join(root, 'home'), env: { PATH: '', ...extra } });
  assert.equal(findIdea(linux()), '');
  const toolbox = touch('home', '.local', 'share', 'JetBrains', 'Toolbox', 'apps', 'intellij-idea-ultimate', 'bin', 'idea');
  assert.equal(findIdea(linux()), toolbox);
  const launcher = touch('linux-bin', 'idea');
  assert.equal(findIdea(linux({ PATH: path.join(root, 'linux-bin') })), launcher);
  console.log('Editors: IntelliJ IDEA on PATH, newest install, no shell scripts, Linux places passed');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
