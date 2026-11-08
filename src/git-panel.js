// Read-only source-control overview; repository identity includes its computer.
(() => {
  const list = $("gitRepositories"), expanded = new Map();
  const buttons = [...document.querySelectorAll("[data-side-tab]")];
  const panels = { projects: $("sideOverview"), git: $("sideGit") };
  let selected = "projects", last = "";
  try { selected = localStorage.getItem("agentdeck.sidebarTab") || selected; } catch {}
  function select(name) {
    selected = Object.hasOwn(panels, name) ? name : "projects";
    for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== selected;
    for (const b of buttons) { const active = b.dataset.sideTab === selected; b.setAttribute("aria-selected", active); b.tabIndex = active ? 0 : -1; }
    try { localStorage.setItem("agentdeck.sidebarTab", selected); } catch {}
    if (selected === "git") render();
  }
  buttons.forEach(b => {
    b.onclick = () => select(b.dataset.sideTab);
    b.onkeydown = e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const i = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (buttons.indexOf(b) + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[i].dataset.sideTab); buttons[i].focus();
    };
  });
  function fileRow(f, source, repo) {
    const filename = f.path.split(/[\\/]/).at(-1), folder = f.path.slice(0, f.path.length - filename.length);
    return `<button type="button" class="git-file" data-diff-node="${esc(source.id === "local" ? "" : source.id)}" data-diff-root="${esc(repo.root)}" data-diff-file="${esc(f.path)}" ${source.status !== "online" ? "disabled" : ""} title="${esc(f.original ? `${f.original} → ${f.path}` : f.path)}"><span class="git-file-name">${esc(filename)}</span><small>${esc(folder)}</small><code>${esc(f.status === "??" ? "U" : f.status.replaceAll(".", " ").trim())}</code></button>`;
  }
  const within = (child, parent) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
  function openProjects() {
    const projects = data.projects || [];
    const open = projects.filter(p => ws.spaces[p.n]?.tabs.some(id => ws.tabs[id]));
    const terminalIds = new Set();
    const visit = pane => { if (!pane) return; if (pane.term) terminalIds.add(pane.term); else { visit(pane.a); visit(pane.b); } };
    for (const tab of Object.values(ws.tabs)) visit(tab.root);
    for (const term of ws.terminals || []) {
      if (!terminalIds.has(term.id) || !term.cwd) continue;
      const candidates = projects.filter(p => (p.node || "") === (term.node || "") && within(normPath(term.cwd), normPath(p.path)));
      candidates.sort((a, b) => b.path.length - a.path.length);
      open.push(candidates[0] || { node: term.node, path: term.cwd });
    }
    return open;
  }
  function render() {
    if (selected !== "git") return;
    const sources = [{ id: "local", name: t("git.panel.local"), status: "online", git }, ...nodes];
    const rows = [], open = openProjects();
    let count = 0;
    for (const source of sources) {
      const paths = open.filter(p => (p.node || "local") === source.id).map(p => normPath(p.path));
      if (!paths.length) continue;
      for (const repo of Object.values(source.git?.repos || {}).sort((a, b) => a.root.localeCompare(b.root))) {
        const root = normPath(repo.root);
        if (!paths.some(p => within(root, p) || within(p, root))) continue;
        count++;
        const key = `${source.id}:${repo.root}`, files = repo.files || [], offline = source.status !== "online";
        rows.push(`<details class="git-repository ${offline ? "offline" : ""}" data-repo="${esc(key)}" ${expanded.get(key) !== false ? "open" : ""}>
          <summary title="${esc(repo.root)}"><strong>${esc(repo.root.split(/[\\/]/).at(-1))}</strong><span class="git-repo-branch">${icon("branch")}${esc(repo.error ? "" : gitHead(repo))}</span><span class="count">${files.length}</span></summary>
          <div class="git-repo-location">${esc(source.name)}${offline ? ` · ${esc(t("manager.node.offline"))}` : ""}<br>${esc(repo.root)}</div>
          ${repo.error ? `<p class="git-panel-note">${esc(repo.error)}</p>` : `<div class="git-repo-counts">${esc(gitCounts(repo).map(([, label]) => label).join(" · ") || t("git.clean"))}${gitAb(repo)}</div>${files.map(f => fileRow(f, source, repo)).join("")}`}
          ${repo.filesTruncated ? `<p class="git-panel-note">${esc(t("git.panel.truncated"))}</p>` : ""}
        </details>`);
      }
      if (source.git?.missing) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(t("git.panel.missing"))}</p>`);
      if (source.git?.discoveryTruncated) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(t("git.panel.scanLimit"))}</p>`);
    }
    $("gitRepoCount").textContent = count;
    const html = rows.join("") || `<p class="git-panel-note">${esc(t("git.panel.empty"))}</p>`;
    if (html !== last) { list.innerHTML = html; last = html; }
  }
  list.addEventListener("toggle", e => { if (e.target.matches("details[data-repo]")) expanded.set(e.target.dataset.repo, e.target.open); }, true);
  $("gitPanelRefresh").onclick = async () => {
    const button = $("gitPanelRefresh"); button.disabled = true;
    try { await window.manager.refreshGit(true); git = await window.manager.getGit(); render(); }
    catch (e) { toast(e.message, true); } finally { button.disabled = false; }
  };
  window.gitPanel = { render };
  select(selected);
})();
