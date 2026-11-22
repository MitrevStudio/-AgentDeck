// Read the signed-in Codex account's limits through its local app-server RPC.
// This creates no thread or model turn, and never sends credentials to the renderer.
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");

// Sign-ins billed per token: they have no plan limits to read.
const NO_PLAN = ["apiKey", "amazonBedrock", "gcp"];

function parseLimits(result) {
  const buckets = result?.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length
    ? Object.entries(result.rateLimitsByLimitId) : [["codex", result?.rateLimits]];
  return buckets.flatMap(([id, bucket]) => ["primary", "secondary"].flatMap(slot => {
    const w = bucket?.[slot];
    if (!Number.isFinite(w?.usedPercent) || !Number.isFinite(w?.windowDurationMins) || w.windowDurationMins <= 0) return [];
    return [{ key: `${id}:${slot}`, label: buckets.length > 1 ? String(bucket.limitName || id) : "",
      util: w.usedPercent, durationMins: w.windowDurationMins,
      resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : 0 }];
  }));
}

function createCodexLimits({ timeoutMs = 20000, spawnProcess = spawn } = {}) {
  let active = null;
  function stop() { active?.(); }
  function read(exe) {
    return new Promise((resolve, reject) => {
      const shim = /\.(cmd|bat)$/i.test(exe);
      if (shim && /[%"\r\n]/.test(exe)) { reject(new Error("unsupported")); return; }
      let child, done = false, buffer = "", step = 0;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); active = null;
        if (child) {
          child.stdin.destroy();
          if (shim && process.platform === "win32" && child.pid)
            execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => {});
          else child.kill();
        }
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
      active = () => finish(new Error("unavailable"));
      try {
        child = spawnProcess(shim ? process.env.ComSpec || "cmd.exe" : exe,
          shim ? ["/d", "/v:off", "/s", "/c", `""${exe}" app-server"`] : ["app-server"],
          { cwd: os.homedir(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
            ...(shim ? { windowsVerbatimArguments: true } : {}) });
      } catch { finish(new Error("unsupported")); return; }
      const send = msg => { if (!done) child.stdin.write(JSON.stringify(msg) + "\n"); };
      child.on("error", () => finish(new Error("unsupported")));
      child.on("exit", () => finish(new Error("unavailable")));
      child.stdin.on("error", () => finish(new Error("unavailable")));
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 2 * 1024 * 1024) { finish(new Error("unavailable")); return; }
        let end;
        while (!done && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let msg; try { msg = JSON.parse(line); } catch { finish(new Error("unavailable")); return; }
          if (msg.method) {
            if (msg.id != null) send({ id: msg.id, error: { code: -32601, message: "Unsupported method" } });
            continue;
          }
          if (msg.id !== step) continue;
          if (msg.error) { finish(new Error(msg.error.code === -32601 ? "unsupported" : "unavailable")); return; }
          if (step === 0) {
            step = 1; send({ method: "initialized", params: {} });
            send({ id: 1, method: "account/read", params: { refreshToken: false } });
          } else if (step === 1) {
            const account = msg.result?.account;
            if (!account) { finish(new Error("noLogin")); return; }
            if (NO_PLAN.includes(account.type)) { finish(new Error("accountType")); return; }
            // A background poll: the reset-credit details would cost Codex a second request to its backend.
            step = 2; send({ id: 2, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
          } else {
            const windows = parseLimits(msg.result);
            if (!windows.length) { finish(new Error("unavailable")); return; }
            finish(null, windows);
          }
        }
      });
      send({ id: 0, method: "initialize", params: { clientInfo: { name: "agentdeck", title: "AgentDeck", version: "1.0.0" }, capabilities: null } });
    });
  }
  return { read, stop };
}

module.exports = { createCodexLimits, parseLimits };
