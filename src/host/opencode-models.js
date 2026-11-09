const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findOnPath } = require('./sessions');
const fs = require('node:fs');
const path = require('node:path');
const run = promisify(execFile);
const TTL = 5 * 60 * 1000;

// OpenCode 2 model.list response. No legacy CLI output parsing.
// Keep only identifiers and numeric limits: headers/options may contain credentials.
function parseModels(text) {
  const models = {};
  const response = JSON.parse(text);
  if (!Array.isArray(response.data)) throw new Error('Unexpected OpenCode 2 model.list response');
  for (const m of response.data) {
    if (typeof m.providerID !== 'string' || typeof m.id !== 'string' || !Number.isFinite(m.limit?.context) || m.limit.context <= 0) continue;
    models[`${m.providerID}/${m.id}`] = { context: m.limit.context,
      input: Number.isFinite(m.limit.input) ? m.limit.input : 0,
      output: Number.isFinite(m.limit.output) ? m.limit.output : 0 };
  }
  return models;
}
async function query(cwd) {
  let exe = await findOnPath('opencode');
  if (!exe) return {};
  if (/\.(cmd|bat)$/i.test(exe)) {
    // Invoke the official npm package's native binary directly. JSON arguments must
    // never be interpolated through cmd.exe (paths may contain %, &, or quotes).
    const native = path.join(path.dirname(exe), 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe');
    if (!fs.existsSync(native)) throw new Error('OpenCode 2 native executable not found');
    exe = native;
  }
  const opts = { cwd, windowsHide: true, timeout: 12000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' } };
  // The API specifies deepObject query encoding, not a JSON string parameter.
  const endpoint = `/api/model?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
  const { stdout } = await run(exe, ['api', 'GET', endpoint], opts);
  return parseModels(stdout);
}
function createModelLimits({ read = query, now = Date.now } = {}) {
  const cache = new Map();
  async function enrich(sources) {
    const projects = [...new Set(sources.filter(s => s.key.startsWith('OpenCode:') && s.context?.model && s.cwd).map(s => s.cwd))];
    let index = 0;
    // Bound simultaneous CLI processes. A failed provider cannot block the worker indefinitely.
    await Promise.all(Array.from({ length: Math.min(3, projects.length) }, async () => {
      while (index < projects.length) {
        const cwd = projects[index++], prev = cache.get(cwd);
        if (prev && now() - prev.at < TTL) continue;
        try { cache.set(cwd, { at: now(), models: await read(cwd) }); }
        catch { cache.set(cwd, { at: now(), models: {} }); }
      }
    }));
    return sources.map(s => {
      const c = s.context, limits = c && cache.get(s.cwd)?.models[`${c.provider}/${c.model}`];
      if (!s.key.startsWith('OpenCode:') || !limits) return s;
      return { ...s, context: { ...c, window: limits.context, inputLimit: limits.input, outputLimit: limits.output,
        exact: false, limitSource: 'opencode-current-config' } };
    });
  }
  return { enrich };
}
module.exports = { parseModels, createModelLimits };
