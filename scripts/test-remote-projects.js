// A project added on another computer (mesh/serve.js "projects.add" over host/project-folder.js and
// host/registry.js): the folder check a host makes of a path a peer typed; the request answered by a served host
// with a real registry file; and over real links in one process - H serves, D is a desktop peer (may control), X a
// resource host (may not), OLD a node whose AgentDeck does not know the request. Checked too: the "data" a change
// brings reaches the peer before the answer, host.info names the capability, and the manager's strings are there in
// both languages. No mDNS, no Electron, no terminals.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { resolveFolder, MAX_PATH } = require("../src/host/project-folder");
const { createRegistry, addProject, norm } = require("../src/host/registry");
const { HostError } = require("../src/host/errors");
const { createServed } = require("../src/mesh/serve");
const { createLinks } = require("../src/mesh/links");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentdeck-remote-projects-")));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = code => e => e instanceof HostError && e.code === code;
const failsOver = code => e => e.code === code; // over a link the error is rebuilt from its code
const waitFor = async (test, what, ms = 15000) => {
  for (let t = 0; t < ms; t += 50) { if (test()) return; await sleep(50); }
  throw new Error(`timed out: ${what}`);
};

// A home with a project folder, a nested one and a file.
const home = path.join(root, "home");
const work = path.join(home, "work", "shop");
const file = path.join(home, "notes.txt");
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(file, "x");

// ---------- the folder check ----------
assert.equal(resolveFolder(work, { home }), work);
assert.equal(resolveFolder(`  ${work}  `, { home }), work, "blanks around the path are typing, not the path");
assert.equal(resolveFolder(work + path.sep, { home }), work, "a trailing separator is tidied away");
assert.equal(resolveFolder(path.join(work, "..", "shop"), { home }), work, "dots are resolved");
assert.equal(resolveFolder("~", { home }), home, "~ is the home here");
assert.equal(resolveFolder("~/work/shop", { home }), work);
assert.equal(resolveFolder("~\\work\\shop".replaceAll("\\", path.sep), { home }), work);
assert.throws(() => resolveFolder(path.join(home, "nowhere"), { home }), fails("folderMissing"));
assert.throws(() => resolveFolder("~/nowhere", { home }), fails("folderMissing"));
assert.throws(() => resolveFolder(file, { home }), fails("notFolder"), "a file is no project");
assert.throws(() => resolveFolder("work/shop", { home }), fails("folderNotAbsolute"), "never read against the process's own folder");
assert.throws(() => resolveFolder("./work", { home }), fails("folderNotAbsolute"));
assert.throws(() => resolveFolder("~other/work", { home }), fails("folderNotAbsolute"), "only this user's ~");
assert.throws(() => resolveFolder("~", { home: "" }), fails("folderMissing"), "no home known: ~ leads nowhere");
for (const bad of ["", "   ", undefined, null, 7, {}, ["~"], `${work}\0`, "a".repeat(MAX_PATH + 1)]) {
  assert.throws(() => resolveFolder(bad, { home }), fails("invalidData"), `refused: ${JSON.stringify(bad)?.slice(0, 40)}`);
}

// ---------- the registry ----------
{
  const data = { projects: [{ name: "Shop", path: work, pin: 0 }], removed: [norm(home), "node:abc:/srv/x"], groups: [] };
  const kept = addProject(data, work);
  assert.equal(kept.name, "Shop", "a folder listed already keeps its entry (name, pin)");
  assert.equal(data.projects.length, 1);
  const added = addProject(data, home);
  assert.deepEqual(added, { name: "home", path: home }, "named by its folder");
  assert.deepEqual(data.removed, ["node:abc:/srv/x"], "a folder the user removed is wanted again; the others stay removed");
  assert.equal(data.projects.length, 2);
}

// ---------- the request, as a host serves it ----------
// A host with a real registry file; saving tells its "data" as host/sessions.js does.
function makeHost(dir) {
  const host = new EventEmitter();
  const registry = createRegistry(path.join(dir, "registry.json"));
  const sessions = {
    get: () => ({ agents: [] }),
    data: async () => ({ registry: registry.read(), sessions: [], agents: [] }),
    registry: { read: () => registry.read(), save: reg => { registry.write(reg); host.emit("data", { registry: reg, sessions: [], agents: [] }); return reg; } }
  };
  Object.assign(host, { home, sessions, terminals: {}, launch: {}, git: {}, setup: {}, viewers: { state: () => null, leave() {} }, liveSessions: () => [], tabs: () => [] });
  return { host, registry };
}
const peer = { id: "d".repeat(64), name: "D", kind: "desktop" };

(async () => {
  {
    const dir = path.join(root, "host-local");
    fs.mkdirSync(dir, { recursive: true });
    const { host, registry } = makeHost(dir);
    const served = createServed({ host });
    assert.equal(served.api("host.info", {}, peer).projects, 1, "the capability, for a peer to see before it asks");
    assert.equal(served.api("host.info", {}, peer).home, home, "the home a terminal opens in");
    assert.deepEqual(served.api("projects.add", { path: "~/work/shop" }, peer), { name: "shop", path: work, added: true });
    assert.deepEqual(registry.read().projects, [{ name: "shop", path: work }], "written to the registry file");
    assert.deepEqual(served.api("projects.add", { path: work }, peer), { name: "shop", path: work, added: false }, "twice is once");
    assert.equal(registry.read().projects.length, 1);
    // A folder the user removed there comes back when asked for by name.
    const reg = registry.read();
    reg.projects = [];
    reg.removed = [norm(work)];
    registry.write(reg);
    assert.equal(served.api("projects.add", { path: work }, peer).added, true);
    assert.deepEqual(registry.read().removed, []);
    // What is refused leaves the registry as it was.
    const before = fs.readFileSync(path.join(dir, "registry.json"), "utf8");
    assert.throws(() => served.api("projects.add", { path: path.join(home, "nowhere") }, peer), fails("folderMissing"));
    assert.throws(() => served.api("projects.add", { path: file }, peer), fails("notFolder"));
    assert.throws(() => served.api("projects.add", { path: "work/shop" }, peer), fails("folderNotAbsolute"));
    for (const params of [undefined, null, {}, { path: "" }, { path: 5 }, { path: ["~"] }, { dir: work }]) {
      assert.throws(() => served.api("projects.add", params, peer), fails("invalidData"), `refused: ${JSON.stringify(params)}`);
    }
    assert.equal(fs.readFileSync(path.join(dir, "registry.json"), "utf8"), before);
    assert.throws(() => served.api("projects.remove", { path: work }, peer), fails("unknownMethod"), "only adding is served");
  }

  // ---------- over links: who may ask, and a computer too old to know the request ----------
  const node = (name, kind, api) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ port: 0 }));
    return createLinks({ dir, defaultName: name, kind, version: "test", api, discover: false, log: () => {} });
  };
  const hostDir = path.join(root, "host-linked");
  fs.mkdirSync(hostDir, { recursive: true });
  const { host, registry } = makeHost(hostDir);
  const served = createServed({ host });
  const h = node("H", "desktop", (m, p, who) => served.api(m, p, who));
  // An AgentDeck from before the request: its api knows no "projects.add", and its host.info names no `projects`.
  const old = node("OLD", "desktop", method => {
    if (method === "host.info") return { home: "/home/dev", terminals: 2, ports: 1 };
    throw new HostError("unknownMethod");
  });
  const d = node("D", "desktop", async () => null), x = node("X", "host", async () => null);
  const selfH = await h.start(), selfOld = await old.start();
  served.attach(h);
  const selfD = await d.start(), selfX = await x.start();
  await d.pair("127.0.0.1", selfH.port, h.self().code);
  await sleep(1100); // one pairing a second from one address (pair-guard.js)
  await x.pair("127.0.0.1", selfH.port, h.self().code);
  await d.pair("127.0.0.1", selfOld.port, old.self().code);
  await waitFor(() => h.online(selfD.id) && h.online(selfX.id) && d.online(selfH.id) && x.online(selfH.id) && d.online(selfOld.id), "every link up");
  assert.equal(h.peers().get(selfD.id).control, true);
  assert.equal(h.peers().get(selfX.id).control, false, "X is a host: no control");

  // D, a desktop, adds a folder on H: answered, written, and the new list reached D before the answer did.
  const events = [];
  d.on("event", e => e.node === selfH.id && e.name === "data" && events.push(e.data));
  assert.equal((await d.call(selfH.id, "host.info")).projects, 1);
  const r = await d.call(selfH.id, "projects.add", { path: "~/work/shop" });
  assert.deepEqual(r, { name: "shop", path: work, added: true });
  assert.deepEqual(events.at(-1)?.registry.projects, [{ name: "shop", path: work }], "the list that has the folder came first");
  assert.deepEqual(registry.read().projects, [{ name: "shop", path: work }]);
  await assert.rejects(d.call(selfH.id, "projects.add", { path: path.join(home, "nowhere") }), failsOver("folderMissing"), "the code crosses the link, for the asker to translate");
  await assert.rejects(d.call(selfH.id, "projects.add", { path: file }), failsOver("notFolder"));
  await assert.rejects(d.call(selfH.id, "projects.add", { path: "shop" }), failsOver("folderNotAbsolute"));

  // X, a resource host, may not: the same gate as every request (links.js), and nothing is written.
  await assert.rejects(x.call(selfH.id, "projects.add", { path: home }), failsOver("relayOnly"));
  assert.equal(registry.read().projects.length, 1);
  assert.ok(!registry.read().projects.some(p => p.path === home));

  // An older AgentDeck answers at once, with a code the asker turns into "update it" (main.js remoteAddProject).
  const from = Date.now();
  assert.equal((await d.call(selfOld.id, "host.info")).projects, undefined, "no capability: main does not even ask");
  await assert.rejects(d.call(selfOld.id, "projects.add", { path: "~/work" }), failsOver("unknownMethod"));
  assert.ok(Date.now() - from < 5000, "refused, not left to time out");

  d.stop(); x.stop(); old.stop(); h.stop();

  // ---------- the words ----------
  const strings = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  for (const key of ["errors.folderMissing", "errors.notFolder", "errors.folderNotAbsolute", "manager.node.needsUpdate", "manager.devices.more",
    "manager.devices.addProject", "manager.devices.terminalTitle", "nodeProject.title", "nodeProject.dir", "nodeProject.note", "nodeProject.go",
    "nodeProject.need", "nodeProject.added", "nodeProject.already"]) {
    assert.equal(strings.split(`"${key}":`).length - 1, 2, `${key} in English and Bulgarian`);
  }

  await sleep(200);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  console.log("Remote projects: the folder check, projects.add as served, who may ask and an older computer OK");
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
