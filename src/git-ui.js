// Git branch and changes beside projects and sessions (git-status.js in main). Classic script for the manager and the
// edge menu, loaded after common.js. Main sends { dirs: { normPath(folder): repo }, repos: { repo: status } }; a
// folder inside a repository shows the repository's state.
let git = { dirs: {}, repos: {} };

const gitOf = (dir, state = git) => { const repo = dir && state?.dirs?.[normPath(dir)]; return (repo && state?.repos?.[repo]) || null; };
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
function gitChip(dir, state = git) {
  const g = gitOf(dir, state);
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

// ---------- what the page shows ----------
// Main starts git by itself only for the repositories in use - a live session, an open terminal (git-status.js). Of
// any other it has a status once a page said it shows that repository, and a fresh one when the page says so again.
// So a page names what it shows: [{ node, path }], node "" for this computer, path a repository or a folder in one.
const GIT_SEEN_MS = 10 * 60 * 1000; // a status a list shows in passing (a project's row, a tile) is left alone this long
const GIT_SHOWN_MAX = 40;           // folders in one request: about what fits on a screen
const GIT_ASK_AGAIN_MS = 20 * 1000; // the same folders are not named again sooner, whatever is drawn meanwhile

// Whether a folder's repository wants a look: it is listed and has no status yet, or one older than maxAge. A folder
// outside any repository never does. state: that of the folder's computer.
function gitNeedsLook(dir, state = git, maxAge = Infinity) {
  const repo = dir && state?.dirs?.[normPath(dir)];
  if (!repo) return false;
  const g = state.repos?.[repo];
  return !g || Date.now() - (g.at || 0) > maxAge;
}
// The elements matching `selector` in `box` that are on screen now - not scrolled out of it, not in a folded or hidden
// part. Where the page cannot tell, all of them.
function gitOnScreen(box, selector) {
  const els = [...box?.querySelectorAll?.(selector) || []], area = box?.getBoundingClientRect?.();
  if (!area) return els;
  return els.filter(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > area.top && r.top < area.bottom; });
}

let gitShown = () => [], gitLooking = () => true, gitAskTimer = 0, gitAsked = "", gitAskedAt = 0;
// Names what the page shows to main. why: "focus" - somebody has just come to the page; "page" - something on it
// changed. all: also what has a status already, for a fresh one; else only what has none yet.
function sendGitShown(why, all) {
  const shown = gitShown(all).slice(0, GIT_SHOWN_MAX);
  gitAsked = JSON.stringify(shown);
  gitAskedAt = Date.now();
  return window.manager.refreshGit(false, shown, why).catch(() => {});
}
// After the page drew something, or its list was scrolled: a moment later (a burst is one request), only while
// somebody is at the page, and only when it names folders it has not just named.
function askGitShown(all = false) {
  clearTimeout(gitAskTimer);
  gitAskTimer = setTimeout(() => {
    if (!gitLooking()) return;
    const shown = gitShown(all).slice(0, GIT_SHOWN_MAX);
    if (!shown.length || (JSON.stringify(shown) === gitAsked && Date.now() - gitAskedAt < GIT_ASK_AGAIN_MS)) return;
    sendGitShown("page", all);
  }, 300);
}

// Calls onChange() when the state changes, and asks main to look at what the page shows: when its window gets the
// focus and when the edge menu opens (then main also takes what changed in the repositories in use while nobody was
// there), and through askGitShown() as the page draws. shown(all): what the page shows now, as sendGitShown() names
// it; isLooking(): whether somebody is at the page.
function watchGit(onChange, { shown = () => [], isLooking = () => document.hasFocus() } = {}) {
  const apply = g => { if (!g) return; git = g; onChange(); };
  gitShown = shown;
  gitLooking = isLooking;
  // A moment later: the page draws what it shows now first.
  const look = () => setTimeout(() => sendGitShown("focus", true), 50);
  window.manager.onGitChanged(apply);
  window.manager.getGit().then(apply).catch(() => {});
  window.addEventListener("focus", look);
  window.manager.onBarEvent(ev => { if (ev.type === "show") look(); });
}
