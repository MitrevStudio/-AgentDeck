// Which parts of AgentDeck a release has to build (release.yml asks before semantic-release runs):
//
//   desktop   the Windows installer and the Linux AppImage
//   android   the phone app for Android (the APK on the release, the bundle for Google Play)
//   ios       the phone app for the iPhone (TestFlight)
//   relay     the relay's Docker image
//
// A part is built when something that goes into it changed since that part was last released - not since the
// last push: a part that was skipped for five releases is compared with where it was built five releases ago.
// Each job of release.yml that gets its part out leaves a tag on the commit it built, <part>-v<version>
// (android-v1.29.0); the newest such tag below HEAD is where the part stands. A part with no tag of its own yet
// stands at the last release in which everything was still built together: the newest version tag whose commit
// does not have this file - the releases before this file existed were made by a workflow that built every part
// each time, and every release since is made by the one that asks here. A part whose build failed gets no tag, so
// the next release builds it again.
//
// What goes into a part is read from what its build takes (and the test holds it against package.json's
// build.files, the Dockerfile's COPY lines and the phone app's imports):
//   - desktop: what electron-builder packs. package.json counts unless only its "scripts" changed.
//   - relay: what host/Dockerfile copies.
//   - android, ios: mobile/ (each without the other's project and scripts), and the files of the root that the
//     page imports - followed from mobile/src/main.js, so a change in src/mesh that the phone does not bundle
//     builds no phone app. The root's package-lock.json counts only when a package of those files changed in it.
//   - docs, tests, the workflows and the tools around them go into nothing.
//   - a path this file does not know builds everything.
//
//   node scripts/release-parts.js plan [--force desktop,ios]   decides; writes the outputs and the summary of the job
//   node scripts/release-parts.js carry-apk                    the release marked latest gets the newest APK (below)
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PARTS = ["desktop", "android", "ios", "relay"];
const SELF = "scripts/release-parts.js"; // a release whose commit has it was built part by part
const PHONE_ENTRY = "mobile/src/main.js";

const under = (file, dir) => file.startsWith(`${dir}/`);

// What a changed file goes into, apart from the files the phone imports: a list of parts ([] for none), or null
// for a path nothing here knows.
function partsOfPath(file) {
  if (file === "THIRD_PARTY_NOTICES.md") return ["desktop"];
  if (file.endsWith(".md") || under(file, "docs") || under(file, ".github") || under(file, "scripts")) return [];
  if (["LICENSE", ".gitignore", ".releaserc.json", "host/install.sh", "host/docker-compose.yml"].includes(file)) return [];

  if (under(file, "mobile")) {
    if (["mobile/.gitignore", "mobile/scripts/serve.mjs"].includes(file)) return []; // serve.mjs: the page in a browser, for development
    if (under(file, "mobile/android") || /^mobile\/scripts\/(gradle|play-[^/]*)\.mjs$/.test(file)) return ["android"];
    if (under(file, "mobile/ios") || /^mobile\/scripts\/(xcode|ios-[^/]*)\.mjs$/.test(file)) return ["ios"];
    return ["android", "ios"];
  }
  const parts = [];
  if (under(file, "src") || under(file, "native") || under(file, "build") || file === "package.json" || file === "package-lock.json") parts.push("desktop");
  if (under(file, "src/host") || under(file, "src/mesh") || under(file, "src/shared") || under(file, "host/bin")
    || ["host/Dockerfile", "host/package.json", "host/package-lock.json", ".dockerignore"].includes(file)) parts.push("relay");
  return parts.length ? parts : null;
}

// The files outside mobile/ that the phone's page bundles, and the packages those files take from the root's
// node_modules: every import and require followed from the entry. -> { files, packages, unresolved }
function phoneBundle(root, entry = PHONE_ENTRY) {
  const files = new Set(), packages = new Set(), unresolved = [], seen = new Set();
  const rel = p => path.relative(root, p).split(path.sep).join("/");
  const resolve = (from, spec) => {
    const base = path.resolve(path.dirname(from), spec);
    return [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
  };
  (function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const outside = !under(rel(file), "mobile");
    if (outside) files.add(rel(file));
    if (!/\.[cm]?js$/.test(file)) return;
    const code = fs.readFileSync(file, "utf8").split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    for (const m of code.matchAll(/(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s+|\bimport\s+)\s*(["'])([^"'\n]+)\1/g)) {
      const spec = m[2];
      if (spec.startsWith(".")) {
        const to = resolve(file, spec);
        if (to) walk(to); else unresolved.push(`${rel(file)}: ${spec}`);
      } else if (outside && !spec.startsWith("node:")) {
        packages.add(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"));
      }
    }
  })(path.join(root, entry));
  return { files: [...files].sort(), packages: [...packages].sort(), unresolved };
}

// What a lock file says of these packages and of everything they depend on.
function lockSlice(lock, names) {
  const all = lock?.packages || {}, out = {}, todo = [...names], seen = new Set();
  while (todo.length) {
    const name = todo.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const [key, p] of Object.entries(all)) {
      if (key !== `node_modules/${name}` && !key.endsWith(`/node_modules/${name}`)) continue;
      out[key] = [p.version, p.resolved, p.integrity];
      todo.push(...Object.keys({ ...p.dependencies, ...p.optionalDependencies, ...p.peerDependencies }));
    }
  }
  return JSON.stringify(Object.entries(out).sort());
}

const json = text => { try { return JSON.parse(text); } catch { return null; } };
// package.json is the same for the desktop when only the commands of the repository ("scripts") differ.
function samePackage(before, after) {
  const strip = text => { const o = json(text); if (!o) return null; delete o.scripts; return JSON.stringify(o); };
  const a = strip(before), b = strip(after);
  return a !== null && a === b;
}

const versionOf = (tag, prefix) => {
  const m = new RegExp(`^${prefix}v(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag);
  return m && m.slice(1).map(Number);
};
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// -> { desktop: { build, forced, since, files, why }, ... }. since: the tag the part is compared with (null: none
// is known). files: what changed for it since then. why: the cause when it is not a file of its own.
function plan({ cwd = process.cwd(), force = [], head = "HEAD" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const show = (ref, file) => { try { return git("show", `${ref}:${file}`); } catch { return null; } };
  const merged = git("tag", "--merged", head).split("\n").map(t => t.trim()).filter(Boolean);
  const phone = phoneBundle(cwd);
  const changes = new Map(); // tag -> the files that differ from it
  const result = {};
  // The last release of everything, for the parts with no tag of their own.
  const has = (ref, file) => { try { git("cat-file", "-e", `${ref}:${file}`); return true; } catch { return false; } };
  const versions = merged.filter(t => versionOf(t, "")).sort((a, b) => newer(versionOf(b, ""), versionOf(a, "")));
  let whole; // found when first needed
  const baseline = () => (whole === undefined ? (whole = versions.find(t => !has(t, SELF)) || null) : whole);

  for (const part of PARTS) {
    const own = merged.filter(t => versionOf(t, `${part}-`)).sort((a, b) => newer(versionOf(a, `${part}-`), versionOf(b, `${part}-`))).pop();
    const since = own || baseline();
    const r = result[part] = { build: false, forced: force.includes(part), since, files: [], why: "" };
    const isPhone = part === "android" || part === "ios";
    if (!since) r.why = "no earlier release of it is known";
    else {
      if (!changes.has(since)) changes.set(since, git("diff", "--name-only", "--no-renames", since, head).split("\n").filter(Boolean));
      for (const file of changes.get(since)) {
        const known = partsOfPath(file);
        let goes = known === null || known.includes(part) || (isPhone && phone.files.includes(file));
        if (goes && file === "package.json" && part === "desktop") goes = !samePackage(show(since, file), show(head, file));
        if (file === "package-lock.json" && isPhone) {
          const before = json(show(since, file)), after = json(show(head, file));
          goes = !before || !after || lockSlice(before, phone.packages) !== lockSlice(after, phone.packages);
        }
        if (goes) r.files.push(file);
      }
      if (isPhone && phone.unresolved.length && !r.files.length) r.why = `an import of the page could not be followed (${phone.unresolved[0]})`;
    }
    if (r.forced && !r.files.length && !r.why) r.why = "asked for by hand";
    r.build = r.forced || r.files.length > 0 || Boolean(r.why);
  }
  return result;
}

// One line per part, for the log and the summary of the run.
function describe(result) {
  return PARTS.map(part => {
    const r = result[part];
    const shown = r.files.slice(0, 5).join(", ") + (r.files.length > 5 ? `, … (${r.files.length} files)` : "");
    const cause = [r.forced && r.files.length ? "asked for by hand" : "", r.why, shown].filter(Boolean).join("; ");
    return { part, build: r.build ? "build" : "skip", since: r.since || "-", cause: r.build ? cause : "nothing of it changed" };
  });
}

// The release GitHub marks as latest is the newest one with the desktop installer (the installed app and the
// download links read it), and the README sends Android users there too. So it always carries the newest APK:
// after a release without the Android app the last APK is copied onto it, after a release with only the phone
// apps the new APK replaces the one it had. releases: GitHub's list; latest: the tag of the one marked latest.
// -> null when there is nothing to do, or { to, from, name, remove } - copy `name` from release `from` (null when
// `to` already has it) and remove the older APKs listed.
function apkCarry(releases, latest) {
  const version = name => { const m = /^AgentDeck-(\d+)\.(\d+)\.(\d+)\.apk$/.exec(name); return m && m.slice(1).map(Number); };
  const found = [];
  for (const r of releases) {
    if (r.draft) continue;
    for (const a of r.assets || []) if (version(a.name)) found.push({ tag: r.tag_name, name: a.name, v: version(a.name) });
  }
  const target = releases.find(r => r.tag_name === latest && !r.draft);
  if (!target || !found.length) return null;
  const newest = found.sort((a, b) => newer(a.v, b.v)).pop();
  const has = (target.assets || []).map(a => a.name).filter(version);
  const remove = has.filter(name => name !== newest.name);
  const from = has.includes(newest.name) ? null : newest.tag;
  return from || remove.length ? { to: latest, from, name: newest.name, remove } : null;
}

function main(argv) {
  const [what, ...rest] = argv;
  if (what === "plan") {
    const at = rest.indexOf("--force");
    const force = at < 0 ? [] : String(rest[at + 1] || "").split(",").map(s => s.trim()).filter(Boolean);
    const unknown = force.filter(p => !PARTS.includes(p));
    if (unknown.length) throw new Error(`not a part: ${unknown.join(", ")} (parts: ${PARTS.join(", ")})`);
    const result = plan({ force });
    const rows = describe(result);
    for (const r of rows) console.log(`${r.part.padEnd(8)} ${r.build.padEnd(6)} since ${r.since.padEnd(18)} ${r.cause}`);
    if (process.env.GITHUB_OUTPUT) {
      const lines = PARTS.flatMap(p => [`${p}=${result[p].build}`, `force_${p}=${result[p].forced}`]);
      lines.push(`any=${PARTS.some(p => result[p].build)}`, `forced=${PARTS.some(p => result[p].forced)}`);
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const table = ["### What this release builds", "", "| Part | | Compared with | Why |", "| --- | --- | --- | --- |",
        ...rows.map(r => `| ${r.part} | ${r.build === "build" ? "**build**" : "skip"} | ${r.since} | ${r.cause.replace(/\|/g, "\\|")} |`)];
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table.join("\n")}\n`);
    }
  } else if (what === "carry-apk") {
    // gh takes the repository and the token from the job (GH_REPO or the checkout, GH_TOKEN).
    const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
    const repo = process.env.GITHUB_REPOSITORY;
    let latest = "";
    try { latest = gh("api", `repos/${repo}/releases/latest`, "--jq", ".tag_name").trim(); } catch { /* no release is marked latest */ }
    const todo = apkCarry(JSON.parse(gh("api", `repos/${repo}/releases?per_page=100`)), latest);
    if (!todo) return console.log(`Nothing to do: ${latest || "no release"} is the latest release and has the newest APK (or there is none yet)`);
    if (todo.from) {
      const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || require("node:os").tmpdir(), "agentdeck-apk-"));
      gh("release", "download", todo.from, "--pattern", todo.name, "--dir", dir);
      gh("release", "upload", todo.to, path.join(dir, todo.name), "--clobber");
      console.log(`${todo.name} copied from ${todo.from} onto ${todo.to}`);
    }
    for (const name of todo.remove) {
      gh("release", "delete-asset", todo.to, name, "--yes");
      console.log(`${name} removed from ${todo.to}`);
    }
  } else {
    console.error("usage: node scripts/release-parts.js plan [--force part,part] | carry-apk");
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message || e); process.exitCode = 1; }
}

module.exports = { PARTS, partsOfPath, phoneBundle, lockSlice, samePackage, plan, describe, apkCarry };
