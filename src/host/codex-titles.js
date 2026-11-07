const fs = require('node:fs');
// Codex's index contains the user-facing thread name; later entries replace earlier names.
function readCodexTitles(file) {
  const titles = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return titles; }
  for (const line of text.split('\n')) {
    try {
      const x = JSON.parse(line);
      if (typeof x.id === 'string' && typeof x.thread_name === 'string' && x.thread_name.trim()) titles.set(x.id, x.thread_name.trim());
    } catch {}
  }
  return titles;
}
module.exports = { readCodexTitles };
