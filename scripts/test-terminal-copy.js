// What a program in a terminal copies (OSC 52) reaches this computer's clipboard - also from a terminal of another
// computer, whose own clipboard is all the program can write itself - and what the scrollback holds does not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/workspace-ui.js'), 'utf8');
const copied = [], errors = [];
const osc = text => `c;${Buffer.from(text).toString('base64')}`;
let attached = null;
// xterm.js as far as this needs it: a write is parsed later, in order, and its callback comes after its own data.
// The data here is what xterm.js hands an OSC 52 handler ("c;<base64>"), one a line.
class Terminal {
  constructor() { this.unicode = {}; this.parser = { registerOscHandler: (n, fn) => { this.osc = fn; } }; this.pending = []; }
  loadAddon() {} open() {} attachCustomKeyEventHandler() {} onData() {} focus() {}
  hasSelection() { return false; }
  write(data, done) { this.pending.push({ data, done }); }
  flush() {
    for (let w; (w = this.pending.shift());) {
      w.data.split('\n').filter(Boolean).forEach(line => this.osc(line));
      w.done?.();
    }
  }
}
const ctx = vm.createContext({
  window: {
    prefs: { terminalFontSizes: [16] },
    terminals: { attach: async () => attached },
    manager: { copyText: text => copied.push(text) },
  },
  document: { documentElement: {}, createElement: () => ({ events: {}, addEventListener(name, fn) { this.events[name] = fn; }, closest: () => null }) },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Terminal, atob, TextDecoder,
  FitAddon: { FitAddon: class {} },
  Unicode11Addon: { Unicode11Addon: class {} },
  toast: message => errors.push(message),
});
vm.runInContext(source.slice(0, source.indexOf('// The same keys when the keyboard')), ctx);
const settle = () => new Promise(resolve => setImmediate(resolve));
const run = code => vm.runInContext(code, ctx);

(async () => {
  // A terminal with a scrollback in which a program copied something earlier, and output that came while attaching.
  const old = osc('copied long ago') + '\n', live = osc('copied just now') + '\n';
  attached = { scrollback: old, end: old.length, cols: 120, rows: 32 };
  run(`globalThis.view = createTermView('tab');`);
  run(`view.queue.push({ data: ${JSON.stringify(live)}, end: ${old.length + live.length} });`);
  await settle();
  run('view.term.flush()');
  assert.deepEqual(copied.splice(0), ['copied just now'], 'the scrollback copies nothing; what came after it does');
  assert.equal(run('view.replaying'), false);

  // Afterwards a copy is a copy: Cyrillic whole, a question for the clipboard unanswered, rubbish and nothing ignored.
  run(`view.term.osc(${JSON.stringify(osc('Копирано от друг компютър'))})`);
  assert.deepEqual(copied.splice(0), ['Копирано от друг компютър']);
  for (const data of ['c;?', 'c;', 'c;not base64!']) run(`view.term.osc(${JSON.stringify(data)})`);
  assert.deepEqual(copied, []);
  assert.equal(run(`view.term.osc(${JSON.stringify(osc('x'))})`), true, 'the sequence is taken, not printed');
  copied.length = 0;

  // A terminal with nothing in its scrollback yet copies from its first output on.
  attached = { scrollback: '', end: 0, cols: 120, rows: 32 };
  run(`globalThis.fresh = createTermView('fresh');`);
  await settle();
  run(`fresh.term.flush(); fresh.term.osc(${JSON.stringify(osc('first copy'))})`);
  assert.deepEqual(copied.splice(0), ['first copy']);

  assert.deepEqual(errors, []);
  console.log('terminal-copy: ok');
})().catch(e => { console.error(e); process.exit(1); });
