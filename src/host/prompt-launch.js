// Starting an agent CLI with a ready prompt (voice commands). The prompt never appears on a command line: wt.exe
// splits its own command line on ";", and PowerShell and cmd.exe would read quotes, "&", "%" and line breaks in it.
// It is written to a file, and the terminal's PowerShell reads that file into the agent's argument, deleting it as
// soon as it has been read:
//
//   if (($p = (Get-Content … '<file>' | ForEach-Object -Process { $_ } -End { Remove-Item '<file>' })) -and ($c = …)) { & $c $p }
//
// What is left is the hop from Windows PowerShell 5.1 (what the terminal runs) to the agent's executable: it puts an
// argument in double quotes only when it finds white space outside a pair of quotes, and does not escape the quotes
// inside it. So the file holds the text already escaped the way Windows programs split their command line
// (backslashes before a quote doubled, the quote escaped), behind a space that always makes PowerShell quote it -
// otherwise `"fix it --dangerously-skip-permissions"` would reach the agent as separate words, flags included.
// The npm shims (claude.ps1 -> claude.exe) pass it on the same way. A .cmd shim would run it through cmd.exe, which
// knows neither escape, so only .ps1, .exe and .com launchers are used.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// What each CLI takes for "start an interactive session on this prompt" (their --help).
const PROMPT_ARGS = {
  Claude: [],              // claude [options] [prompt]
  Codex: [],               // codex [OPTIONS] [PROMPT]
  OpenCode: ["--prompt"]   // opencode [project] --prompt <text>
};
// A terminal reads (and deletes) its file within seconds; what is older belongs to a launch that never ran.
const KEEP_MS = 60 * 60 * 1000;
const SAFE_NAME = /^prompt-[0-9a-f]{16,32}\.txt$/;

const psQuote = s => "'" + String(s).replace(/'/g, "''") + "'";

// The text as one Windows command-line argument, as PowerShell 5.1 will pass it on. The space in front makes
// PowerShell put it in quotes whatever the text holds, and keeps a leading "-" from being read as an option.
function escapeArgument(text) {
  const s = (" " + String(text ?? "").trim()).replace(/(\\*)"/g, '$1$1\\"');
  // Backslashes at its end would escape the closing quote.
  return s.replace(/(\\+)$/, "$1$1");
}

// Deletes one prompt file; best effort.
function remove(file) {
  if (SAFE_NAME.test(path.basename(String(file || "")))) try { fs.unlinkSync(file); } catch {}
}

// Removes prompt files older than maxAge; best effort.
function sweep(dir, { now = Date.now(), maxAge = KEEP_MS } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file); } catch {}
  }
}

// Writes the prompt for one launch and returns the file's path.
function writePrompt(dir, text) {
  const body = escapeArgument(text);
  if (!body.trim()) throw new Error("empty prompt");
  fs.mkdirSync(dir, { recursive: true });
  sweep(dir);
  const file = path.join(dir, `prompt-${crypto.randomBytes(8).toString("hex")}.txt`);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

// The PowerShell command (no ";": wt.exe would split there) that starts `exe` (the agent's command name) on the
// prompt in `file`, and deletes the file once read - whether or not a launcher is found. `missing` is said instead
// when no usable launcher is on PATH.
function command(agent, exe, file, missing) {
  if (!Object.hasOwn(PROMPT_ARGS, agent)) throw new Error(`no prompt syntax for ${agent}`);
  const f = psQuote(file);
  const read = `Get-Content -Raw -Encoding UTF8 -LiteralPath ${f} | ForEach-Object -Process { $_ } -End { Remove-Item -LiteralPath ${f} -Force -ErrorAction Ignore }`;
  const find = `Get-Command -Name ${psQuote(exe)} -CommandType ExternalScript,Application -All -ErrorAction Ignore`
    + ` | Where-Object { $_.Source -match '\\.(ps1|exe|com)$' } | Select-Object -First 1`;
  const run = ["&", "$c", ...PROMPT_ARGS[agent].map(psQuote), "$p"].join(" ");
  return `if (($p = (${read})) -and ($c = (${find}))) { ${run} } else { Write-Warning ${psQuote(missing)} }`;
}

module.exports = { writePrompt, command, escapeArgument, sweep, remove, psQuote, PROMPT_ARGS, KEEP_MS };
