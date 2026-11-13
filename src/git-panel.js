// Compact source control: the owning computer is part of every repository identity.
(() => {
  const list = $('gitRepositories'), footer = $('gitFooter'), expanded = new Map(), drafts = new Map(), busy = new Set(), errors = new Map(), repositories = new Map();
  const buttons = [...document.querySelectorAll('[data-side-tab]')], panels = { projects: $('sideOverview'), git: $('sideGit') };
  let selected = 'projects', last = '', filter = '', activeKey = '', sortMode = 'path';
  try { selected = localStorage.getItem('agentdeck.sidebarTab') || selected; } catch {}
  try { sortMode = localStorage.getItem('agentdeck.gitSort') || sortMode; } catch {}
  let byProject = false;
  try { byProject = localStorage.getItem('agentdeck.gitByProject') === '1'; } catch {}
  // Which repositories are listed (Settings > Git, prefs.js gitScope): 'open' - those an open terminal is in; 'all' -
  // also every one in a project.
  const toScope = value => (value === 'all' ? 'all' : 'open');
  let scope = toScope(window.prefs?.gitScope);
  window.prefs?.onChanged?.(p => {
    if (toScope(p.gitScope) === scope) return;
    scope = toScope(p.gitScope);
    render();
  });
  // Filters: the projects hidden with "all" (by project key), and the repositories hidden from a project's group
  // ({ project key: [repository key] }). projectRepos: what each group listed in the last render, for its menu.
  const HIDDEN_PROJECTS_KEY = 'agentdeck.gitHiddenProjects', HIDDEN_REPOS_KEY = 'agentdeck.gitHiddenRepos';
  function readJson(key, fallback, isValid) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return isValid(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }
  const hiddenProjects = new Set(readJson(HIDDEN_PROJECTS_KEY, [], Array.isArray));
  const hiddenRepos = readJson(HIDDEN_REPOS_KEY, {}, v => v && typeof v === 'object' && !Array.isArray(v));
  const projectRepos = new Map();
  // How a repository lists its changes: by folders (tree) or as a flat list, set in that repository's own menu
  // (repoViews, by its key). The default is the flat list - or the folders for whoever had them on for all
  // repositories before (TREE_KEY, no longer set). Either way as IntelliJ's commit view: a checkbox on every file and
  // folder, checked being staged.
  const TREE_KEY = 'agentdeck.gitTree', REPO_VIEWS_KEY = 'agentdeck.gitRepoViews';
  let tree = false, repoViews = {};
  try { tree = localStorage.getItem(TREE_KEY) === '1'; } catch {}
  try { repoViews = JSON.parse(localStorage.getItem(REPO_VIEWS_KEY)) || {}; } catch {}
  const isTree = key => repoViews[key]?.tree ?? tree;
  // A folder or a group is open unless the user folded it; while a filter is typed, all are, so what it found shows.
  const isOpen = id => Boolean(filter) || expanded.get(id) !== false;
  function select(name) {
    selected = Object.hasOwn(panels, name) ? name : 'projects';
    for (const [id, panel] of Object.entries(panels)) panel.hidden = id !== selected;
    for (const b of buttons) { const active = b.dataset.sideTab === selected; b.setAttribute('aria-selected', active); b.tabIndex = active ? 0 : -1; }
    try { localStorage.setItem('agentdeck.sidebarTab', selected); } catch {}
    if (selected === 'git') render();
  }
  buttons.forEach(b => {
    b.onclick = () => select(b.dataset.sideTab);
    b.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (buttons.indexOf(b) + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[i].dataset.sideTab); buttons[i].focus();
    };
  });
  const within = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');
  // The folders something is open in: every terminal that stands in a tab, by its own folder. A project whose tabs
  // name no terminal with a folder goes by the project's folder.
  function openFolders() {
    const open = [], terminals = new Map((ws.terminals || []).map(x => [x.id, x]));
    const visit = (pane, out) => { if (!pane) return out; if (pane.term) out.push(terminals.get(pane.term)); else { visit(pane.a, out); visit(pane.b, out); } return out; };
    for (const p of data.projects || []) {
      const tabs = (ws.spaces[p.n]?.tabs || []).map(id => ws.tabs[id]).filter(Boolean);
      if (tabs.length && !tabs.some(tab => visit(tab.root, []).some(x => x?.cwd))) open.push({ node: p.node, path: p.path });
    }
    for (const tab of Object.values(ws.tabs)) for (const x of visit(tab.root, [])) if (x?.cwd) open.push({ node: x.node, path: x.cwd });
    return open;
  }
  // The repositories those folders are about: the one a folder lies in, or - for a folder that is in none, such as
  // one that holds several repositories side by side - the ones right inside it. Not every repository further down:
  // a session at a drive's root would bring the whole drive.
  const depth = p => p.split('/').filter(Boolean).length;
  function openRoots(paths, roots) {
    const out = new Set();
    for (const p of paths) {
      const holding = roots.filter(r => within(p, r)).sort((a, b) => b.length - a.length)[0];
      if (holding) out.add(holding);
      else for (const r of roots) if (within(r, p) && depth(r) - depth(p) <= 1) out.add(r);
    }
    return out;
  }
  const conflict = f => /U|AA|DD/.test(f.status);
  const accepts = (group, f) => group === 'conflicts' ? conflict(f) : group === 'staged'
    ? f.status !== '??' && !conflict(f) && f.status[0] !== '.'
    : !conflict(f) && (f.status === '??' || f.status[1] !== '.');
  const statusKey = f => conflict(f) ? '!' : f.status === '??' ? 'U' : f.status[1] || f.status[0] || '';
  const base = f => f.path.split(/[\\/]/).at(-1).toLocaleLowerCase();
  function sortFiles(files) {
    if (sortMode === 'name') return files.sort((a, b) => base(a).localeCompare(base(b)) || a.path.localeCompare(b.path));
    if (sortMode === 'status') return files.sort((a, b) => statusKey(a).localeCompare(statusKey(b)) || a.path.localeCompare(b.path));
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  const more = (attributes, disabled = false) => `<button class="icon-btn git-more" type="button" ${attributes} title="${esc(gitText('manage'))}" aria-label="${esc(gitText('manage'))}" aria-haspopup="menu" ${disabled ? 'disabled' : ''}>${icon('more')}</button>`;
  const quick = (action, glyph, label, disabled = false) => `<button type="button" class="icon-btn git-quick" data-quick="${action}" title="${esc(gitText(label))}" aria-label="${esc(gitText(label))}" ${disabled ? 'disabled' : ''}>${icon(glyph)}</button>`;
  function fileRow(f, node, group, disabled, check = '') {
    const filename = f.path.split(/[\\/]/).at(-1), folder = f.path.slice(0, f.path.length - filename.length).replace(/[\\/]$/, '');
    const extension = filename.split('.').at(-1).toLowerCase(), known = /^(js|ts|json|css|md|html|yml|yaml|py)$/.test(extension);
    const change = group === 'all' ? (f.status[1] !== '.' ? f.status[1] : f.status[0]) : f.status[group === 'staged' ? 0 : 1];
    const status = conflict(f) ? '!' : f.status === '??' ? 'U' : change;
    return `<div class="git-file-row" data-file="${esc(f.path)}" data-group="${group}">${check}<button type="button" class="git-file" data-diff-node="${esc(node.node)}" data-diff-root="${esc(node.repo.root)}" data-diff-file="${esc(f.path)}" ${disabled ? 'disabled' : ''} title="${esc(f.original ? `${f.original} → ${f.path}` : f.path)}"><span class="git-file-icon ext-${known ? extension : 'file'}" aria-hidden="true">${icon('file')}</span><span class="git-file-name">${esc(filename)}</span><small>${esc(folder)}</small></button>${group === 'conflicts' || !node.node ? more('data-file-menu', disabled) : ''}<code class="git-file-status status-${status === '!' ? 'conflict' : status}">${esc(status)}</code></div>`;
  }
  function grouped(node, disabled) {
    return getGroupHtml(node, disabled, 'conflicts') + getCheckTreeHtml(node, disabled);
  }
  // A file's part in the next commit: "all" staged, "none", or "part" (changed again since it was staged).
  function getStaged(f) {
    if (f.status === '??' || f.status[0] === '.') {
      return 'none';
    }
    return f.status[1] === '.' ? 'all' : 'part';
  }
  // A checkbox for these files: checked when all are staged, mixed (data-mixed, set as indeterminate after render) when
  // some are. It names what it stands for (data-check: "all", "folder" or "file", and the path) rather than carrying
  // the paths: getCheckedFiles finds them when it is clicked.
  function getCheckHtml(files, label, disabled, scope, path = '') {
    const states = files.map(getStaged);
    const all = states.every(s => s === 'all'), none = states.every(s => s === 'none');
    return `<input type="checkbox" class="git-check" data-check="${scope}" data-check-path="${esc(path)}" aria-label="${esc(label)}" ${all ? 'checked' : ''} ${all || none ? '' : 'data-mixed="1"'} ${disabled ? 'disabled' : ''}>`;
  }
  // The files a repository's check tree lists: all but the conflicts, within the filter.
  const getListedFiles = node => (node.repo.files || []).filter(f => !conflict(f) && f.path.toLocaleLowerCase().includes(filter));
  // The listed files a checkbox stands for.
  function getCheckedFiles(node, scope, path) {
    const files = getListedFiles(node);
    if (scope === 'all') return files;
    return files.filter(f => (scope === 'folder' ? f.path.startsWith(path + '/') : f.path === path));
  }
  const getCountText = n => gitText(n === 1 ? 'oneFile' : 'fileCount').replace('{n}', n);
  // The changes as one tree, as IntelliJ groups them by directory: a folder with a single subfolder and no files of
  // its own shares that subfolder's row ("src\main\java\bg"), and every row has its file count and a checkbox.
  function getCheckTreeHtml(node, disabled) {
    const files = sortFiles(getListedFiles(node));
    if (!files.length) {
      return '';
    }
    const separator = node.repo.root.includes('\\') ? '\\' : '/';
    const root = { path: '', folders: new Map(), files: [] };
    for (const f of files) {
      let folder = root;
      for (const part of f.path.split('/').slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [] });
        folder = folder.folders.get(part);
      }
      folder.files.push(f);
    }
    const getAll = folder => [...folder.files, ...[...folder.folders.values()].flatMap(getAll)];
    const renderFolder = folder => {
      let name = folder.name;
      while (folder.folders.size === 1 && !folder.files.length) {
        folder = [...folder.folders.values()][0];
        name += separator + folder.name;
      }
      const all = getAll(folder), id = JSON.stringify([node.key, 'folder', folder.path]);
      return `<details class="git-folder git-check-folder" data-expand="${esc(id)}" ${isOpen(id) ? 'open' : ''}><summary><span class="git-chevron">${icon('right')}</span>${getCheckHtml(all, name, disabled, 'folder', folder.path)}${icon('folder')}<span class="git-folder-name">${esc(name)}</span><small class="git-folder-count">${esc(getCountText(all.length))}</small></summary>${renderChildren(folder)}</details>`;
    };
    const renderChildren = folder => [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(renderFolder).join('')
      + folder.files.map(f => fileRow(f, node, 'all', disabled, getCheckHtml([f], f.path, disabled, 'file', f.path))).join('');
    const id = JSON.stringify([node.key, 'all']);
    const rows = isTree(node.key) ? renderChildren(root) : files.map(f => fileRow(f, node, 'all', disabled, getCheckHtml([f], f.path, disabled, 'file', f.path))).join('');
    return `<details class="git-file-group git-check-tree" data-expand="${esc(id)}" data-group="changes" ${isOpen(id) ? 'open' : ''}><summary><span class="git-chevron">${icon('right')}</span>${getCheckHtml(files, gitText('changes'), disabled, 'all')}<span>${esc(gitText('changes'))}</span><small class="git-folder-count">${esc(getCountText(files.length))}</small><span class="grow"></span><span class="git-count">${files.length}</span></summary>${rows}</details>`;
  }
  function getGroupHtml(node, disabled, group) {
    const files = sortFiles((node.repo.files || []).filter(f => accepts(group, f) && f.path.toLocaleLowerCase().includes(filter)));
    if (!files.length) return '';
    const renderTree = (items, depth = 0) => {
      const folders = new Map(), leaves = [];
      for (const f of items) { const parts = f.path.split('/'); if (parts.length <= depth + 1) leaves.push(f); else { const folder = parts[depth]; if (!folders.has(folder)) folders.set(folder, []); folders.get(folder).push(f); } }
      return [...folders].map(([folder, children]) => {
        const id = JSON.stringify([node.key, group, children[0].path.split('/').slice(0, depth + 1).join('/')]);
        return `<details class="git-folder" data-expand="${esc(id)}" ${isOpen(id) ? 'open' : ''}><summary><span class="git-chevron">${icon('right')}</span>${esc(folder)}</summary>${renderTree(children, depth + 1)}</details>`;
      }).join('') + leaves.map(f => fileRow(f, node, group, disabled)).join('');
    };
    const id = JSON.stringify([node.key, group]);
    return `<details class="git-file-group" data-expand="${esc(id)}" data-group="${group}" ${expanded.get(id) !== false ? 'open' : ''}><summary><span class="git-chevron">${icon('right')}</span><span>${esc(gitText(group))}</span><span class="grow"></span><span class="git-hover-actions">${quick('review', 'eye', 'reviewChanges', disabled)}${quick(group === 'staged' ? 'unstage' : 'stage', group === 'staged' ? 'undo' : 'plus', group === 'staged' ? 'unstageAll' : 'stageAll', disabled)}${more('data-group-menu', disabled)}</span><span class="git-count">${files.length}</span></summary>${isTree(node.key) ? renderTree(files) : files.map(f => fileRow(f, node, group, disabled)).join('')}</details>`;
  }
  // The projects a repository belongs to: every one holding it - a linked worktree by its main checkout or by its own
  // folder (a worktree added as a project of its own) - so a folder of many repositories lists them too; in none, its
  // own folder (real: false - no project to filter).
  function getRepoProjects(sourceId, repo) {
    const root = normPath(repo.root), dirs = [normPath(repo.mainRoot || repo.root), root];
    const projects = (data.projects || []).filter(p => (p.node || 'local') === sourceId && dirs.some(d => within(d, normPath(p.path))));
    if (projects.length) return projects.map(p => ({ key: p.n, name: p.name, real: true }));
    return [{ key: root, name: root.split('/').filter(Boolean).at(-1) || root, real: false }];
  }
  const isRepoHidden = (projectKey, repoKey) => (hiddenRepos[projectKey] || []).includes(repoKey);
  // A repository is open until folded; inside a project group ("Group by Project") it is folded until opened, so an
  // opened project shows the list of its repositories first.
  // The two views keep their own fold state (a <details> drawn open reports itself as opened, so one state would carry
  // "open" from the plain list into the groups), and so does each group a repository is in.
  const getRepoExpandId = (key, projectKey) => (byProject ? `in-project:${projectKey}:${key}` : key);
  const isRepoOpen = id => (byProject ? expanded.get(id) === true : expanded.get(id) !== false);
  // With "Group by Project": the repositories in a foldable group per project (folded until opened), the projects by
  // name. A repository is in the group of every project holding it, unless hidden from that group; a group whose
  // repositories are all hidden stays, so its menu can bring them back.
  function getRepoRows(items) {
    if (!byProject) return items.map(x => x.html(getRepoExpandId(x.key)));
    const groups = new Map();
    for (const x of items) {
      for (const p of x.projects) {
        if (!groups.has(p.key)) groups.set(p.key, { key: p.key, name: p.name, real: p.real, repos: [], rows: [] });
        const g = groups.get(p.key);
        g.repos.push({ key: x.key, name: x.name });
        if (!isRepoHidden(p.key, x.key)) g.rows.push(x.html(getRepoExpandId(x.key, p.key)));
      }
    }
    for (const g of groups.values()) if (g.real) projectRepos.set(g.key, g.repos);
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)).map(g => {
      const id = `project:${g.key}`, count = g.rows.length < g.repos.length ? `${g.rows.length}/${g.repos.length}` : g.rows.length;
      // A filter needs something to choose from: a single repository has none, unless it is the one hidden.
      const actions = g.real && (g.repos.length > 1 || g.rows.length < g.repos.length) ? `<span class="git-hover-actions">${more(`data-project-menu="${esc(g.key)}"`)}</span>` : '';
      return `<details class="git-project" data-expand="${esc(id)}" ${expanded.get(id) === true ? 'open' : ''}><summary class="git-project-head">`
        + `<span class="git-chevron">${icon('right')}</span>${icon('folder')}<span>${esc(g.name)}</span><span class="grow"></span>${actions}<span class="git-count">${count}</span>`
        + `</summary>${g.rows.join('')}</details>`;
    });
  }
  function setByProject(on) {
    byProject = on;
    try { localStorage.setItem('agentdeck.gitByProject', on ? '1' : '0'); } catch {}
    render();
  }
  const saveViews = () => { try { localStorage.setItem(REPO_VIEWS_KEY, JSON.stringify(repoViews)); } catch {} };
  // One repository's view; nothing is kept for it once it is the default.
  function setRepoTree(key, on) {
    if (on === tree) delete repoViews[key]; else repoViews[key] = { tree: on };
    saveViews();
    render();
  }
  // The projects whose scan budget ran out, by name. A computer on an older version reports only that one did.
  function getScanLimitNote(source) {
    const paths = source.git.discoveryTruncatedIn || [];
    if (!paths.length) return t('git.panel.scanLimit');
    const name = dir => (data.projects || []).find(p => (p.node || 'local') === source.id && normPath(p.path) === normPath(dir))?.name || dir;
    return t('git.panel.scanLimitIn', { projects: paths.map(name).join(', ') });
  }
  function render() {
    if (selected !== 'git') return;
    const sources = [{ id: 'local', name: t('git.panel.local'), status: 'online', git }, ...nodes], rows = [], open = openFolders();
    const tips = new Map();
    repositories.clear();
    projectRepos.clear();
    for (const source of sources) {
      const paths = open.filter(p => (p.node || 'local') === source.id).map(p => normPath(p.path));
      if (!paths.length && scope !== 'all') continue;
      const repos = Object.values(source.git?.repos || {}).sort((a, b) => a.root.localeCompare(b.root));
      const viaTerminal = openRoots(paths, repos.map(repo => normPath(repo.root)));
      const items = [];
      for (const repo of repos) {
        // Listed: the repositories an open terminal is in and, with "all", every one in a project - unless every
        // project holding it is hidden by the project filter (which never hides one a terminal is in).
        const open = viaTerminal.has(normPath(repo.root)), holding = getRepoProjects(source.id, repo);
        if (!open && (scope !== 'all' || !holding[0].real)) continue;
        const projects = open || scope !== 'all' ? holding : holding.filter(p => !hiddenProjects.has(p.key));
        if (!projects.length) continue;
        const key = JSON.stringify([source.id, repo.root]), name = repo.root.split(/[\\/]/).at(-1);
        if (byProject && projects.every(p => isRepoHidden(p.key, key))) { items.push({ key, name, projects, html: () => '' }); continue; }
        const node = { key, node: source.id === 'local' ? '' : source.id, repo, offline: source.status !== 'online', source: source.name, error: errors.get(key) || source.gitError || repo.error };
        repositories.set(key, node);
        const offline = source.status !== 'online', disabled = offline || busy.has(key), files = repo.files || [], staged = files.some(f => accepts('staged', f));
        tips.set(key, `${source.name}\n${repo.root}\n${gitText('checked')}: ${repo.at ? new Date(repo.at).toLocaleTimeString() : '—'}${offline || Date.now() - (repo.at || 0) > 150000 ? '\n' + gitText('stale') : ''}`);
        // In a group a copy is folded until opened: its body is drawn once it is (the toggle listener renders again).
        items.push({ key, name, projects, html: expandId => `<details class="git-repository ${offline ? 'offline' : ''}" data-repo="${esc(key)}" data-expand="${esc(expandId)}" ${isRepoOpen(expandId) ? 'open' : ''}>
          <summary><span class="git-chevron">${icon('right')}</span><strong>${esc(name)}</strong><span class="git-repo-branch">${icon('branch')}${esc(repo.error ? '' : gitHead(repo))}</span>${gitAb(repo)}${source.id === 'local' ? '' : `<span class="proj-node ${offline ? 'offline' : 'online'}">${icon('nodes')}${esc(source.name)}</span>`}${offline ? `<span class="git-offline">${icon('alert')}</span>` : ''}<span class="grow"></span><span class="git-hover-actions">${quick('preview', 'eye', 'commit', disabled)}${quick('commit', 'check', 'commitMenu', disabled || !staged || !(drafts.get(key) || '').trim())}${quick('branches', 'branch', 'branches', disabled)}${quick('refresh', 'refresh', 'refresh', disabled)}${more('data-repo-menu', disabled)}</span><span class="git-count">${repo.fileCount ?? files.length}</span></summary>${byProject && !isRepoOpen(expandId) ? '' : `
          <div class="git-commit-box"><textarea class="textarea" data-commit-message="${esc(key)}" rows="1" spellcheck="false" aria-label="${esc(gitText('message'))}" placeholder="${esc(gitText('commitHint'))}" ${disabled ? 'disabled' : ''}>${esc(drafts.get(key) || '')}</textarea><div class="git-commit-split"><button type="button" class="btn sm primary git-commit-button" data-repo-action="commit" ${disabled || !staged || !(drafts.get(key) || '').trim() ? 'disabled' : ''}>${icon('check')}<span>${esc(gitText(busy.has(key) ? 'loading' : 'commitMenu'))}</span></button></div></div>
          ${errors.has(key) || repo.error || source.gitError ? `<p class="git-panel-error" role="status">${esc(errors.get(key) || repo.error || source.gitError)}</p>` : ''}
          ${grouped(node, disabled)}${!files.length && !repo.error ? `<p class="git-clean">${esc(gitText('empty'))}</p>` : filter && !files.some(f => f.path.toLocaleLowerCase().includes(filter)) ? `<p class="git-clean">${esc(gitText('noMatches'))}</p>` : ''}
          ${repo.filesTruncated ? `<p class="git-panel-note">${esc(t('git.panel.truncated'))}</p>` : ''}`}</details>` });
      }
      rows.push(...getRepoRows(items));
      if (source.git?.missing) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(t('git.panel.missing'))}</p>`);
      if (source.git?.discoveryTruncated) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(getScanLimitNote(source))}</p>`);
    }
    $('gitRepoCount').textContent = repositories.size;
    if (!repositories.has(activeKey)) activeKey = repositories.keys().next().value || '';
    window.gitFooter?.render();
    const html = rows.join('') || `<p class="git-panel-note">${esc(t('git.panel.empty'))}</p>`;
    if (html !== last) {
      const active = document.activeElement, focused = active?.dataset, scroll = list.scrollTop, selection = focused?.commitMessage ? [active.selectionStart, active.selectionEnd] : null;
      // A repository in several groups is drawn once per group: the focus goes back to the same copy.
      const copy = active?.closest?.('[data-repo]')?.dataset.expand;
      list.innerHTML = html; last = html; list.scrollTop = scroll;
      for (const box of list.querySelectorAll?.('.git-check[data-mixed]') || []) box.indeterminate = true;
      const copyEl = (copy && [...list.querySelectorAll('[data-repo]')].find(d => d.dataset.expand === copy)) || list;
      if (focused?.commitMessage) {
        const input = [...copyEl.querySelectorAll('[data-commit-message]')].find(b => b.dataset.commitMessage === focused.commitMessage);
        input?.focus({ preventScroll: true }); if (input && selection) input.setSelectionRange(...selection);
      } else if (focused?.diffFile) [...copyEl.querySelectorAll('[data-diff-file]')].find(b => b.dataset.diffFile === focused.diffFile && b.dataset.diffRoot === focused.diffRoot && b.dataset.diffNode === focused.diffNode)?.focus({ preventScroll: true });
    }
    // Outside the compared HTML: the time changes with every check, and the list must not be rebuilt for it.
    for (const summary of list.querySelectorAll?.('[data-repo] > summary') || []) {
      const tip = tips.get(summary.parentElement.dataset.repo);
      if (tip && summary.dataset.tip !== tip) summary.title = tip;
    }
  }
  function renderFooter() {
    const node = repositories.get(activeKey);
    if (!node) { footer.hidden = true; footer.innerHTML = ''; return; }
    footer.hidden = false;
    const repo = node.repo, disabled = node.offline || busy.has(node.key), branch = repo.error ? '' : gitHead(repo);
    footer.innerHTML = `<button type="button" class="git-footer-branch" data-footer-action="branches" title="${esc(gitText('branches'))}" ${disabled ? 'disabled' : ''}>${icon('branch')}<span class="git-footer-name">${esc(branch || '—')}</span>${gitAb(repo)}</button><span class="grow"></span><button type="button" class="git-footer-sync" data-footer-action="sync" title="${esc(gitText('sync'))}" aria-label="${esc(gitText('sync'))}" ${disabled ? 'disabled' : ''}>${icon('refresh')}</button><button type="button" class="git-footer-graph" data-footer-action="graph" title="${esc(gitText('graph'))}" ${disabled ? 'disabled' : ''}>${icon('history')}<span>${esc(gitText('graph'))}</span></button>`;
  }
  footer.addEventListener('click', e => {
    const button = e.target.closest('[data-footer-action]');
    if (!button || button.disabled) return;
    const node = repositories.get(activeKey); if (!node) return;
    e.preventDefault(); e.stopPropagation();
    window.gitWorkflow.open(node.node, node.repo.root, button.dataset.footerAction === 'graph' ? 'history' : button.dataset.footerAction, drafts.get(node.key) || '');
  });
  async function mutate(node, action, files) {
    if (busy.has(node.key) || (files && !files.length)) return;
    if (action === 'push' && !node.repo.upstream) return window.gitWorkflow.open(node.node, node.repo.root, 'sync');
    busy.add(node.key); errors.delete(node.key); render();
    try {
      const args = { root: node.repo.root, action };
      if (action === 'commit') {
        const message = (drafts.get(node.key) || '').trim(); if (!message) return;
        const review = await window.manager.gitQuery(node.node, { root: node.repo.root, kind: 'preview' });
        Object.assign(args, { message, token: review.token });
      } else if (files) args.files = files;
      const response = await window.manager.gitExecute(node.node, args);
      window.gitWorkflow.recordOutput?.(node.node, node.repo.root, response);
      if (action === 'commit') { drafts.delete(node.key); window.gitWorkflow.rememberDraft?.(node.node, node.repo.root, ''); }
      git = await window.manager.getGit();
    } catch (error) { errors.set(node.key, error.message); }
    finally { busy.delete(node.key); render(); }
  }
  const item = (label, glyph, run, extra = {}) => ({ label: gitText(label), icon: glyph, run: async () => run(), ...extra });
  const sep = () => ({ separator: true });
  function setSort(mode) { sortMode = mode; try { localStorage.setItem('agentdeck.gitSort', mode); } catch {} render(); }
  const openFor = (node, view) => () => window.gitWorkflow.open(node.node, node.repo.root, view, drafts.get(node.key) || '');
  // The repository's actions, grouped the way Source Control does it.
  function repoMenuItems(node) {
    const disabled = node.offline || busy.has(node.key);
    const pull = item('pull', 'download', () => mutate(node, 'pull'), { disabled });
    const push = item('push', 'upload', () => mutate(node, 'push'), { disabled });
    const fetch = item('fetch', 'download', () => mutate(node, 'fetch'), { disabled });
    return [
      item('asTree', 'folder', () => setRepoTree(node.key, !isTree(node.key)), { checked: isTree(node.key) }),
      sep(),
      pull, push, fetch,
      sep(),
      item('compare', 'splitRight', openFor(node, 'compare'), { disabled }), item('worktrees', 'layers', openFor(node, 'worktrees'), { disabled }),
      sep(),
      item('showOutput', 'terminal', () => window.gitWorkflow.openOutput(node.node, node.repo.root), { disabled })
    ];
  }
  function toggleProject(projectKey) {
    if (!hiddenProjects.delete(projectKey)) hiddenProjects.add(projectKey);
    try { localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...hiddenProjects])); } catch {}
    render();
  }
  function toggleRepo(projectKey, repoKey) {
    const keys = new Set(hiddenRepos[projectKey] || []);
    if (!keys.delete(repoKey)) keys.add(repoKey);
    if (keys.size) hiddenRepos[projectKey] = [...keys]; else delete hiddenRepos[projectKey];
    try { localStorage.setItem(HIDDEN_REPOS_KEY, JSON.stringify(hiddenRepos)); } catch {}
    render();
  }
  // A checkbox per project of the computers listed (named with its computer when it is another one).
  function projectFilterItems() {
    const sources = new Map([['local', ''], ...nodes.map(n => [n.id, n.name])]);
    return (data.projects || []).filter(p => sources.has(p.node || 'local'))
      .map(p => ({ label: p.node ? `${p.name || p.path} · ${sources.get(p.node)}` : p.name || p.path, key: p.n }))
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(p => ({ label: p.label, icon: 'folder', checked: !hiddenProjects.has(p.key), keepOpen: true, run: async () => toggleProject(p.key) }));
  }
  // A project group's menu (only with "Group by Project"): its repositories to show or hide in this group.
  function openProjectMenu(button) {
    const projectKey = button.dataset.projectMenu;
    // The list is drawn again with each tick: the menu then returns the focus to the button drawn in place of its own.
    const toggle = repoKey => {
      toggleRepo(projectKey, repoKey);
      const anchor = [...(list.querySelectorAll?.('[data-project-menu]') || [])].find(b => b.dataset.projectMenu === projectKey);
      if (groupMenu && anchor) groupMenu.returnFocus = anchor;
    };
    const repos = (projectRepos.get(projectKey) || []).map(r => ({ label: r.name, icon: 'branch', checked: !isRepoHidden(projectKey, r.key), keepOpen: true, run: async () => toggle(r.key) }));
    openGroupMenu(button, '', [{ label: gitText('filterRepos'), icon: 'eye', items: repos, disabled: !repos.length }]);
    groupMenu.classList.add('git-context-menu');
  }
  function panelMenuItems() {
    const filterProjects = projectFilterItems();
    const view = [
      item('byProject', 'stack', () => setByProject(!byProject), { checked: byProject }),
      ...(scope === 'all' && filterProjects.length ? [{ label: gitText('filterProjects'), icon: 'eye', items: filterProjects }] : []),
      { label: gitText('viewSort'), icon: 'sliders', items: [
        item('sortPath', 'history', () => setSort('path'), { checked: sortMode === 'path' }),
        item('sortName', 'terminal', () => setSort('name'), { checked: sortMode === 'name' }),
        item('sortStatus', 'alert', () => setSort('status'), { checked: sortMode === 'status' }),
        sep(),
        item('filter', 'search', () => { $('gitFilterBar').hidden = !$('gitFilterBar').hidden; if (!$('gitFilterBar').hidden) $('gitFilter').focus(); })
      ] },
      sep()
    ];
    return view.slice(0, -1);
  }
  function menu(button, node, group, file) {
    if (!file && !group) {
      openGroupMenu(button, node.repo.root, repoMenuItems(node));
      groupMenu.classList.add('git-context-menu'); return;
    }
    const files = group ? (node.repo.files || []).filter(f => accepts(group, f) && f.path.toLocaleLowerCase().includes(filter)).map(f => f.path) : [];
    const items = group !== 'conflicts' && file ? [] : [item(file ? (group === 'staged' ? 'unstageFile' : 'stageFile') : (group === 'staged' ? 'unstageAll' : 'stageAll'), group === 'staged' ? 'undo' : 'plus', () => mutate(node, group === 'staged' ? 'unstage' : 'stage', file ? [file] : files))];
    if (file && !node.node) items.push(item('editor', 'open', () => window.manager.gitOpenFile(node.node, node.repo.root, file)));
    openGroupMenu(button, node.repo.root, items);
    groupMenu.classList.add('git-context-menu');
  }
  list.addEventListener('toggle', e => {
    if (!e.target.dataset.expand) return;
    expanded.set(e.target.dataset.expand, e.target.open);
    // A repository opened inside a group was drawn without its body.
    if (e.target.open && e.target.dataset.repo && !e.target.querySelector?.('.git-commit-box')) render();
  }, true);
  list.addEventListener('input', e => {
    const key = e.target.dataset.commitMessage; if (!key) return;
    drafts.set(key, e.target.value);
    const node = repositories.get(key), commit = e.target.parentElement.querySelector('[data-repo-action="commit"]');
    if (node) window.gitWorkflow.rememberDraft?.(node.node, node.repo.root, e.target.value);
    commit.disabled = !e.target.value.trim() || busy.has(key) || !(node?.repo.files || []).some(f => accepts('staged', f));
    const headerCommit = e.target.closest('[data-repo]').querySelector('[data-quick="commit"]');
    if (headerCommit) headerCommit.disabled = commit.disabled;
  });
  // A checkbox stages what it stands for, or takes it out of the commit. Only the files that change are sent: an
  // untracked file cannot be unstaged, a staged one need not be staged again.
  list.addEventListener('change', e => {
    const box = e.target.closest('.git-check');
    if (!box) return;
    const node = repositories.get(box.closest('[data-repo]')?.dataset.repo);
    if (!node) return;
    const files = getCheckedFiles(node, box.dataset.check, box.dataset.checkPath).filter(f => getStaged(f) !== (box.checked ? 'all' : 'none')).map(f => f.path);
    mutate(node, box.checked ? 'stage' : 'unstage', files);
  });
  list.addEventListener('keydown', e => {
    if (e.target.dataset.commitMessage && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); const button = e.target.parentElement.querySelector('[data-repo-action="commit"]'); if (!button.disabled) button.click();
    }
  });
  list.addEventListener('focusin', e => { const repo = e.target.closest('[data-repo]'); if (repo) { activeKey = repo.dataset.repo; window.gitFooter?.render(); } });
  list.addEventListener('click', e => {
    const projectMenu = e.target.closest('[data-project-menu]');
    if (projectMenu?.dataset.projectMenu) { e.preventDefault(); e.stopPropagation(); return openProjectMenu(projectMenu); }
    const clickedRepo = e.target.closest('[data-repo]');
    if (clickedRepo) { activeKey = clickedRepo.dataset.repo; window.gitFooter?.render(); }
    const button = e.target.closest('[data-repo-menu], [data-group-menu], [data-file-menu], [data-repo-action], [data-quick]');
    if (!button || button.disabled) return;
    e.preventDefault(); e.stopPropagation();
    const node = repositories.get(button.closest('[data-repo]').dataset.repo); if (!node) return;
    if (button.dataset.quick) {
      const action = button.dataset.quick, group = button.closest('[data-group]');
      if (action === 'refresh') return $('gitPanelRefresh').onclick();
      if (action === 'preview' || action === 'branches') return window.gitWorkflow.open(node.node, node.repo.root, action === 'preview' ? 'commit' : 'branches', drafts.get(node.key) || '');
      if (action === 'review') return group?.querySelector('[data-diff-file]')?.click();
      const files = (node.repo.files || []).filter(f => accepts(group?.dataset.group || 'changes', f) && f.path.toLocaleLowerCase().includes(filter)).map(f => f.path);
      return mutate(node, action, action === 'commit' ? undefined : files);
    }
    if (button.dataset.repoAction) return mutate(node, button.dataset.repoAction);
    const file = button.closest('[data-file]'), group = button.closest('[data-group]');
    menu(button, node, group?.dataset.group, file?.dataset.file);
  });
  $('gitFilter').placeholder = gitText('search');
  $('gitFilter').setAttribute('aria-label', gitText('filter'));
  $('gitPanelTitle').textContent = gitText('sourceControl');
  $('gitPanelMenu').title = gitText('panelActions');
  $('gitFilter').oninput = e => { filter = e.target.value.toLocaleLowerCase(); render(); };
  $('gitPanelMenu').onclick = () => { openGroupMenu($('gitPanelMenu'), '', panelMenuItems()); groupMenu.classList.add('git-context-menu'); };
  $('gitPanelRefresh').onclick = async () => {
    const button = $('gitPanelRefresh'); button.disabled = true;
    try { await window.manager.refreshGit(true); git = await window.manager.getGit(); errors.clear(); render(); }
    catch (e) { toast(e.message, true); } finally { button.disabled = false; }
  };
  window.gitFooter = { render: renderFooter };
  window.gitPanel = { render, setDraft: (node, root, message) => { const key = JSON.stringify([node || 'local', root]); if (message) drafts.set(key, message); else drafts.delete(key); render(); }, getActive: () => repositories.get(activeKey), getRepos: () => [...repositories.values()], setActive: key => { if (repositories.has(key)) { activeKey = key; window.gitFooter?.render(); } } };
  select(selected);
})();
