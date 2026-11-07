// What a host needs before it can work on a project, as a desktop checks and fixes it from afar: git, an SSH key
// (made here; only the public half ever leaves), the git hosts it trusts (known_hosts), the git identity, the agent
// CLIs installed. Nothing here runs as root or touches anything outside the user's own files.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { fail } = require("./errors");
const { findOnPath } = require("./sessions");

const execFileAsync = promisify(execFile);
const KEY_FILES = ["id_ed25519", "id_ecdsa", "id_rsa"];
const HOST = /^[a-z0-9.-]{1,253}$/i;

const sshDir = () => path.join(os.homedir(), ".ssh");
// "~/work/x" -> the user's home; anything else as given, resolved.
const expandHome = p => {
  const s = String(p || "").trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
};
async function run(file, args, opts = {}) {
  const { stdout } = await execFileAsync(file, args, { windowsHide: true, timeout: 30000, ...opts });
  return String(stdout).trim();
}
const version = (file, args) => run(file, args).then(s => s.split(/\r?\n/)[0], () => null);

function readPublicKey() {
  for (const name of KEY_FILES) {
    try {
      const file = path.join(sshDir(), `${name}.pub`);
      return { file: path.join(sshDir(), name), publicKey: fs.readFileSync(file, "utf8").trim() };
    } catch {}
  }
  return null;
}
function knownHosts() {
  try {
    return fs.readFileSync(path.join(sshDir(), "known_hosts"), "utf8").split(/\r?\n/).filter(l => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// deps: agents() -> the agent CLIs on PATH (sessions.js).
function createSetup({ agents = async () => [] } = {}) {
  async function status() {
    const [git, node, identityName, identityEmail] = await Promise.all([
      version("git", ["--version"]), Promise.resolve(process.version),
      run("git", ["config", "--global", "user.name"]).catch(() => ""), run("git", ["config", "--global", "user.email"]).catch(() => "")
    ]);
    const key = readPublicKey();
    return {
      platform: process.platform, hostname: os.hostname(), home: os.homedir(), node,
      git, gitIdentity: { name: identityName, email: identityEmail },
      sshKey: key ? { file: key.file, publicKey: key.publicKey } : null,
      // Hosts (names) that are in known_hosts; hashed entries cannot be read back and count as unknown.
      knownHosts: knownHosts().map(l => l.split(/\s+/)[0]).filter(h => !h.startsWith("|")),
      agents: await agents(), sshKeygen: Boolean(await findOnPath("ssh-keygen"))
    };
  }
  // A new ed25519 key without a passphrase (the host is unattended); refused when one exists.
  async function generateKey() {
    if (readPublicKey()) fail("invalidData", "A key exists already.");
    fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
    const file = path.join(sshDir(), "id_ed25519");
    await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `agentdeck@${os.hostname()}`, "-f", file]);
    return readPublicKey();
  }
  // The host's keys into known_hosts (ssh-keyscan), so git over SSH does not stop at the first question.
  async function addKnownHost(host) {
    const h = String(host || "").trim();
    if (!HOST.test(h)) fail("invalidData");
    const lines = await run("ssh-keyscan", ["-T", "10", h]).then(s => s.split(/\r?\n/).filter(l => l && !l.startsWith("#")), () => []);
    if (!lines.length) fail("unreachable", `ssh-keyscan found nothing at ${h}.`);
    fs.mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
    const file = path.join(sshDir(), "known_hosts");
    const have = new Set(knownHosts());
    const fresh = lines.filter(l => !have.has(l));
    if (fresh.length) fs.appendFileSync(file, fresh.join("\n") + "\n", { mode: 0o600 });
    return { added: fresh.length, host: h };
  }
  async function setGitIdentity({ name, email }) {
    const n = String(name || "").trim().slice(0, 120), e = String(email || "").trim().slice(0, 200);
    if (!n || !e || /[\r\n]/.test(n + e)) fail("invalidData");
    await run("git", ["config", "--global", "user.name", n]);
    await run("git", ["config", "--global", "user.email", e]);
    return { name: n, email: e };
  }
  // The branches of a repository here (local, then the remote's), and the one checked out.
  async function branches(dir) {
    const d = expandHome(dir);
    const current = await run("git", ["-C", d, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    const list = await run("git", ["-C", d, "for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]).catch(() => "");
    return { current, branches: list.split(/\r?\n/).filter(b => b && !b.endsWith("/HEAD")) };
  }
  const remoteUrl = dir => run("git", ["-C", expandHome(dir), "remote", "get-url", "origin"]).catch(() => "");

  return { status, generateKey, addKnownHost, setGitIdentity, branches, remoteUrl, expandHome };
}

module.exports = { createSetup, expandHome };
