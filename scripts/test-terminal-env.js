// The environment a terminal starts with (src/host/terminal-env.js), and what the launch adds for its agent
// (src/host/launch.js openTerminal).
const assert = require("node:assert/strict");
const os = require("node:os");
const { terminalEnv, codexEnv } = require("../src/host/terminal-env");
const { createLaunch } = require("../src/host/launch");

assert.equal(terminalEnv({ PATH: "x" }).PATH, "x");
// An agent session's own markers and its tool-shell settings do not reach the terminal; a user's own NO_COLOR does.
assert.deepEqual(terminalEnv({ CLAUDECODE: "1", NO_COLOR: "1", CLAUDE_CODE_ENTRYPOINT: "cli", A: "b" }), { A: "b" });
assert.equal(terminalEnv({ NO_COLOR: "1" }).NO_COLOR, "1");
// The proxy replaces every spelling it inherited.
const proxied = terminalEnv({ https_proxy: "old", No_Proxy: "old" }, { url: "http://p:1", noProxy: "localhost" });
assert.deepEqual(proxied, { HTTPS_PROXY: "http://p:1", HTTP_PROXY: "http://p:1", NO_PROXY: "localhost", NODE_USE_ENV_PROXY: "1" });

// Herdr's marker, under which Codex sends what it copied as an OSC 52 too (for a computer that looks at the terminal
// from elsewhere), is no part of every terminal's environment: other programs act on it.
assert.equal("HERDR_ENV" in terminalEnv({ PATH: "x" }), false);
// Only a Codex session gets it; a shell and the other agents do not.
assert.deepEqual(codexEnv({ PATH: "x" }, "Codex"), { PATH: "x", HERDR_ENV: "1" });
for (const agent of ["", undefined, "Claude", "OpenCode", "codex"]) assert.deepEqual(codexEnv({ PATH: "x" }, agent), { PATH: "x" });
// The user's own value stays as it is, in whatever letter case, with no second spelling beside it.
for (const own of [{ HERDR_ENV: "0" }, { herdr_env: "" }, { Herdr_Env: "mine" }]) assert.deepEqual(codexEnv({ PATH: "x", ...own }, "Codex"), { PATH: "x", ...own });
// The environment handed in is not changed.
const given = Object.freeze({ PATH: "x" });
assert.notEqual(codexEnv(given, "Codex"), given);

// The launch: every terminal of the host opens through openTerminal, which knows the terminal's agent.
(async () => {
  let opened = null;
  const terminals = { countRunning: () => 0, open: async spec => { opened = spec; return "id"; } };
  const dir = os.tmpdir();
  const launch = createLaunch({ dataDir: dir, terminals });
  const marker = env => Object.entries(env).filter(([k]) => /^herdr_env$/i.test(k));
  // A Codex session: new, or opened anew after a restart under the id it had.
  await launch.openTerminal(dir, "& 'codex'", { agent: "Codex" }, { PATH: "x" }, "test");
  assert.deepEqual(marker(opened.env), [["HERDR_ENV", "1"]]);
  await launch.openTerminal(dir, "& 'codex' 'resume' 's-1'", { agent: "Codex", sessionId: "s-1", id: "old", createdAt: 1, reopened: true, owner: "peer-1" }, { PATH: "x" }, "test");
  assert.deepEqual(marker(opened.env), [["HERDR_ENV", "1"]]);
  // With the user's own value in the inherited environment: that one, alone.
  await launch.openTerminal(dir, "& 'codex'", { agent: "Codex" }, { PATH: "x", herdr_env: "0" }, "test");
  assert.deepEqual(marker(opened.env), [["herdr_env", "0"]]);
  // A shell, a command of the user's, the other agents: none.
  for (const [command, meta] of [[null, {}], ["echo hello", {}], ["& 'claude'", { agent: "Claude" }], ["& 'opencode'", { agent: "OpenCode" }]]) {
    await launch.openTerminal(dir, command, meta, { PATH: "x" }, "test");
    assert.deepEqual(marker(opened.env), [], `${meta.agent || "a shell"} has no marker`);
    assert.equal(opened.env.PATH, "x");
  }
  console.log("terminal-env: ok");
})().catch(e => { console.error(e); process.exit(1); });
