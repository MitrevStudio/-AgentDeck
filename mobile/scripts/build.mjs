// Builds the app into www/: src/main.js bundled by esbuild (one IIFE, no eval, so the page's CSP can stay at
// script-src 'self'), the stylesheets (ours and xterm's) bundled into one, and static/ copied as it is.
// --watch rebuilds on every change.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "www");
const watch = process.argv.includes("--watch");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(root, "static"), out, { recursive: true });

const options = {
  absWorkingDir: root,
  entryPoints: { app: "src/main.js", style: "src/style.css" },
  outdir: out,
  bundle: true,
  format: "iife",
  target: ["chrome100", "safari15"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "linked",
  logLevel: "info"
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
