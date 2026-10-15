// Syntax-checks every JavaScript file under src/ (CI runs this before building).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const files = fs.readdirSync(path.join(__dirname, "..", "src"), { recursive: true })
  .filter(f => f.endsWith(".js"))
  .map(f => path.join("src", f));

let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }); }
  catch (e) { failed++; process.stderr.write(e.stderr.toString()); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
