const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCodexLimits, parseLimits } = require("../src/codex-limits");
const { forecast } = require("../src/limits");

assert.deepEqual(parseLimits({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 } } }),
  [{ key: "codex:primary", label: "", util: 25, durationMins: 300, resetsAt: 1800000000000 }]);
assert.equal(parseLimits({ rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }).length, 0);

// The forecast both agents share: 3 of 5 hours gone with 30% used burns 10%/h, full after the reset.
const H = 3600000, now = 1800000000000, five = 5 * H;
let f = forecast([], five, 30, now + 2 * H, now);
assert.equal(f.elapsedPct, 60);
assert.equal(f.fullAt, now + 7 * H);
assert.equal(f.runsOut, false);
// An hour later at 70%: the recent burn (40%/h) is full in 45 minutes, before the reset an hour away.
const list = [];
forecast(list, five, 30, now + 2 * H, now);
f = forecast(list, five, 70, now + 2 * H, now + H);
assert.equal(Math.round(f.fullAt), now + H + 0.75 * H);
assert.equal(f.runsOut, true);
// Less used than before means a new window, and an unknown reset time no elapsed share.
forecast(list, five, 5, now + 2 * H, now + H);
assert.equal(list.length, 1);
assert.equal(forecast([], five, 10, 0, now).elapsedPct, null);

function server(account = { type: "chatgpt" }) {
  const messages = [];
  function spawnProcess() {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => {};
    let buffer = "";
    child.stdin.on("data", chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        messages.push(message);
        const reply = result => child.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
        if (message.method === "initialize") reply({});
        if (message.method === "account/read") reply({ account });
        if (message.method === "account/rateLimits/read") reply({ rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1800000000 },
            secondary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1800600000 } }
        } });
      }
    });
    return child;
  }
  return { spawnProcess, messages };
}

(async () => {
  const mock = server();
  const limits = await createCodexLimits({ spawnProcess: mock.spawnProcess }).read("codex.exe");
  assert.equal(limits.length, 2);
  assert.deepEqual(mock.messages.map(x => x.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  assert.deepEqual(mock.messages.at(-1).params, { excludeResetCreditDetails: true });
  await assert.rejects(createCodexLimits({ spawnProcess: server(null).spawnProcess }).read("codex.exe"), /noLogin/);
  await assert.rejects(createCodexLimits({ spawnProcess: server({ type: "apiKey" }).spawnProcess }).read("codex.exe"), /accountType/);
  console.log("Codex limit parsing and RPC flow OK");
  if (process.argv.includes("--live")) {
    const exe = process.argv[process.argv.indexOf("--live") + 1];
    const actual = await createCodexLimits({ timeoutMs: 12000 }).read(exe);
    console.log(`Live Codex: ${actual.length} limit window(s) returned`);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
