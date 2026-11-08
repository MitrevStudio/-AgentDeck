// Escaped, read-only unified patches. No repository content becomes executable markup.
function renderGitPatch(patch) {
  let oldLine = null, newLine = null;
  return patch.split("\n").map(line => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    let kind = "meta", before = "", after = "";
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); kind = "hunk"; }
    else if (oldLine !== null) {
      if (line.startsWith("+")) { kind = "add"; after = newLine++; }
      else if (line.startsWith("-")) { kind = "remove"; before = oldLine++; }
      else if (line.startsWith(" ")) { kind = "context"; before = oldLine++; after = newLine++; }
    } else if (line.startsWith("+") && !line.startsWith("+++")) kind = "add";
    return `<span class="diff-line ${kind}"><span class="diff-number">${before}</span><span class="diff-number">${after}</span><span class="diff-code">${esc(line)}</span></span>`;
  }).join("");
}
(() => {
  const dialog = $("gitDiffDialog"), body = $("gitDiffBody");
  let generation = 0;
  const note = key => `<p class="git-panel-note">${esc(t(key))}</p>`;
  $("gitDiffClose").onclick = () => dialog.close();
  dialog.addEventListener("close", () => { generation++; });
  $("gitRepositories").addEventListener("click", async e => {
    const button = e.target.closest("[data-diff-file]");
    if (!button || button.disabled) return;
    const { diffNode: node, diffRoot: root, diffFile: file } = button.dataset;
    const request = ++generation;
    $("gitDiffTitle").textContent = file;
    $("gitDiffLocation").textContent = `${node ? nodeNameOf(node) : t("git.panel.local")} · ${root}`;
    body.innerHTML = note("git.diff.loading");
    dialog.showModal();
    try {
      const result = await window.manager.getGitDiff(node, root, file);
      if (request !== generation || !dialog.open) return;
      const sections = [["staged", "git.diff.staged"], ["unstaged", "git.diff.unstaged"], ["untracked", "git.diff.new"]];
      body.innerHTML = sections.filter(([key]) => result[key]).map(([key, title]) => `<section class="diff-section"><h3>${esc(t(title))}</h3><pre class="diff-patch">${renderGitPatch(result[key])}</pre></section>`).join("")
        + (result.tooLarge ? note("git.diff.tooLarge") : "")
        + (result.binary ? note("git.diff.binary") : "")
        + (result.emptyFile ? note("git.diff.emptyFile") : "");
      if (!body.innerHTML) body.innerHTML = note("git.diff.empty");
    } catch (error) {
      if (request === generation && dialog.open) body.textContent = error.message;
    }
  });
})();
