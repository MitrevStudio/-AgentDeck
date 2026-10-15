// Git branch and changes beside projects and sessions (git-status.js in main). Classic script for the manager and the
// edge menu, loaded after common.js. Main sends { dirs: { normPath(folder): repo }, repos: { repo: status } }; a
// folder inside a repository shows the repository's state.
let git = { dirs: {}, repos: {} };
ICONS.branch = '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-3 6-7 6H6"/>';

const gitOf = dir => { const repo = dir && git.dirs?.[normPath(dir)]; return (repo && git.repos?.[repo]) || null; };
const gitHead = g => (g.detached ? g.oid.slice(0, 7) : g.branch);
const gitDirty = g => g.staged + g.unstaged + g.untracked + g.conflicts > 0;

// ---------- text ----------
// [class, text] for each kind of change there is.
function gitCounts(g) {
  return [
    g.conflicts && ["conflict", tn("git.conflicts", g.conflicts)],
    g.staged && ["staged", tn("git.staged", g.staged)],
    g.unstaged && ["unstaged", tn("git.unstaged", g.unstaged)],
    g.untracked && ["untracked", tn("git.untracked", g.untracked)]
  ].filter(Boolean);
}
function gitTitle(g) {
  if (g.error) return t("git.tip.error", { message: g.error });
  const lines = [g.detached ? t("git.tip.detached", { sha: g.oid.slice(0, 12) }) : t("git.tip.branch", { branch: g.branch })];
  if (g.initial) lines.push(t("git.tip.initial"));
  if (!g.upstream) lines.push(t("git.tip.noUpstream"));
  else if (!g.ahead && !g.behind) lines.push(t("git.tip.even", { upstream: g.upstream }));
  else {
    lines.push(t("git.tip.upstream", { upstream: g.upstream }));
    if (g.ahead) lines.push("↑ " + tn("git.tip.ahead", g.ahead));
    if (g.behind) lines.push("↓ " + tn("git.tip.behind", g.behind));
  }
  const counts = gitCounts(g).map(([, text]) => text);
  lines.push(counts.length ? counts.join(" · ") : t("git.clean"));
  lines.push(t("git.tip.repo", { path: g.root }));
  if (g.upstream) lines.push(t("git.tip.noFetch"));
  return lines.join("\n");
}
// For a tooltip that already says something: the state after a blank line, or nothing outside a repository.
const gitTip = dir => { const g = gitOf(dir); return g && !g.error ? `\n\n${gitTitle(g)}` : ""; };

// ---------- markup ----------
const gitDot = g => (g.conflicts ? '<span class="gdot conflict"></span>' : gitDirty(g) ? '<span class="gdot"></span>' : "");
const gitAb = g => `${g.ahead ? `<span class="gab">↑${g.ahead}</span>` : ""}${g.behind ? `<span class="gab">↓${g.behind}</span>` : ""}`;
// Edge menu tile, top left: the branch, a dot when there are changes (red with conflicts), ↑/↓ when not in step.
// The tile's own tooltip carries the details (gitTip).
function gitTile(dir) {
  const g = gitOf(dir);
  return g && !g.error ? `<span class="tgit"><span class="gb">${esc(gitHead(g))}</span>${gitDot(g)}${gitAb(g)}</span>` : "";
}
// Compact, with a tooltip: a manager project or session folder.
function gitChip(dir) {
  const g = gitOf(dir);
  if (!g || g.error) return "";
  return `<span class="git-chip" title="${esc(gitTitle(g))}">${icon("branch")}<span class="gb">${esc(gitHead(g))}</span>${gitDot(g)}${gitAb(g)}</span>`;
}
// In full: the edge menu's header for the chosen project.
function gitLine(dir) {
  const g = gitOf(dir);
  if (!g) return "";
  if (g.error) return `<span class="dgit err" title="${esc(gitTitle(g))}">${icon("branch")}${esc(t("git.error"))}</span>`;
  const counts = gitCounts(g).map(([cls, text]) => `<span class="gc ${cls}">${esc(text)}</span>`);
  return `<span class="dgit" title="${esc(gitTitle(g))}">${icon("branch")}<span class="gn">${esc(gitHead(g))}</span>${gitAb(g)}
    ${counts.length ? counts.join("") : `<span class="gc">${esc(t("git.clean"))}</span>`}</span>`;
}

// Calls onChange() when the state changes. Asks main for a fresh look (it skips repositories checked moments ago)
// when the page's window gets the focus and when the edge menu opens.
function watchGit(onChange) {
  const apply = g => { if (!g) return; git = g; onChange(); };
  const refresh = () => window.manager.refreshGit().catch(() => {});
  window.manager.onGitChanged(apply);
  window.manager.getGit().then(apply).catch(() => {});
  window.addEventListener("focus", refresh);
  window.manager.onBarEvent(ev => { if (ev.type === "show") refresh(); });
}
