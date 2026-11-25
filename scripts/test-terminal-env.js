// The environment a terminal starts with (src/host/terminal-env.js).
const assert = require("node:assert/strict");
const { terminalEnv } = require("../src/host/terminal-env");

// Codex sends what it copied as an OSC 52 too, for a computer that looks at the terminal from elsewhere.
assert.equal(terminalEnv({ PATH: "x" }).HERDR_ENV, "1");
assert.equal(terminalEnv({ PATH: "x" }).PATH, "x");
// An agent session's own markers and its tool-shell settings do not reach the terminal; a user's own NO_COLOR does.
assert.deepEqual(terminalEnv({ CLAUDECODE: "1", NO_COLOR: "1", CLAUDE_CODE_ENTRYPOINT: "cli", A: "b" }), { A: "b", HERDR_ENV: "1" });
assert.equal(terminalEnv({ NO_COLOR: "1" }).NO_COLOR, "1");
// The proxy replaces every spelling it inherited.
const proxied = terminalEnv({ https_proxy: "old", No_Proxy: "old" }, { url: "http://p:1", noProxy: "localhost" });
assert.deepEqual(proxied, { HTTPS_PROXY: "http://p:1", HTTP_PROXY: "http://p:1", NO_PROXY: "localhost", NODE_USE_ENV_PROXY: "1", HERDR_ENV: "1" });
console.log("terminal-env: ok");
