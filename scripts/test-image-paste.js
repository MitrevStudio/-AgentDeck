const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual clipboard key handler and both file-drop branches without a live clipboard or agent.
const source = fs.readFileSync(path.join(__dirname, '../src/workspace-ui.js'), 'utf8');
const pasted = [], errors = [];
let image = '', remoteFile = '';
const ctx = vm.createContext({
  window: {
    prefs: { terminalFontSizes: [16] },
    terminals: {
      saveClipboardImage: async () => image,
      uploadFile: async () => remoteFile,
      getPathForFile: file => file.path,
      attach: async () => null,
    },
  },
  document: { documentElement: {}, createElement: () => ({ events: {}, addEventListener(name, fn) { this.events[name] = fn; } }) },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Terminal: class {
    loadAddon() {} open() {} attachCustomKeyEventHandler() {} onData() {} focus() {}
    paste(value) { pasted.push(value); }
  },
  FitAddon: { FitAddon: class {} },
  toast: message => errors.push(message),
});
vm.runInContext(source.slice(0, source.indexOf('// The same keys when the keyboard')), ctx);
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const file = 'C:\\Users\\conta\\AppData\\Local\\Temp\\agentdeck-paste\\2026-11-08T08-02-52-140Z-paste-2026-11-08T08-02-51-578Z.png';
  image = file;
  vm.runInContext(`globalThis.view = createTermView('tab'); handleTermKey(view.term, { type: 'keydown', ctrlKey: true, code: 'KeyV' }, 'tab');`, ctx);
  await settle();
  assert.equal(pasted.pop(), file.replace(/\\/g, '/'), 'clipboard preserves every path separator');
  image = 'C:\\Users\\Test User\\Temp\\image.png';
  vm.runInContext(`handleTermKey(view.term, { type: 'keydown', ctrlKey: true, code: 'KeyV' }, 'tab');`, ctx);
  await settle();
  assert.equal(pasted.pop(), '"C:/Users/Test User/Temp/image.png"');
  image = '';
  vm.runInContext(`handleTermKey(view.term, { type: 'keydown', ctrlKey: true, code: 'KeyV' }, 'tab');`, ctx);
  await settle();
  assert.equal(pasted.length, 0, 'ordinary text paste does not inject a file path');

  ctx.dropFile = { path: file, name: 'image.png', size: 10, arrayBuffer: async () => new ArrayBuffer(10) };
  vm.runInContext(`view.host.events.drop({ preventDefault() {}, dataTransfer: { files: [dropFile] } });`, ctx);
  assert.equal(pasted.pop(), file.replace(/\\/g, '/'), 'local drop uses the same formatting');
  remoteFile = '/tmp/agentdeck-paste/image one.png';
  vm.runInContext(`ws.terminals = [{ id: 'tab', node: 'remote' }]; view.host.events.drop({ preventDefault() {}, dataTransfer: { files: [dropFile] } });`, ctx);
  await settle();
  assert.equal(pasted.pop(), '"/tmp/agentdeck-paste/image one.png"');
  remoteFile = file;
  vm.runInContext(`view.host.events.drop({ preventDefault() {}, dataTransfer: { files: [dropFile] } });`, ctx);
  await settle();
  assert.equal(pasted.pop(), file.replace(/\\/g, '/'), 'remote Windows paths are normalized too');
  assert.equal(vm.runInContext(`terminalFilePath('\\\\\\\\server\\\\share\\\\image.png')`, ctx), '//server/share/image.png');
  ctx.posix = '/tmp/image\\name.png';
  assert.equal(vm.runInContext('terminalFilePath(posix)', ctx), ctx.posix, 'POSIX filenames are not rewritten');
  assert.deepEqual(errors, []);
  console.log('Image clipboard paste, spaces, local/remote drops, UNC and POSIX paths OK');
})().catch(e => { console.error(e); process.exitCode = 1; });
