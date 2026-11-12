// Compact source control: the owning computer is part of every repository identity.
(() => {
  const list = $('gitRepositories'), footer = $('gitFooter'), expanded = new Map(), drafts = new Map(), busy = new Set(), errors = new Map(), repositories = new Map();
  const buttons = [...document.querySelectorAll('[data-side-tab]')], panels = { projects: $('sideOverview'), git: $('sideGit') };
  let selected = 'projects', last = '', filter = '', activeKey = '', sortMode = 'path';
  try { selected = localStorage.getItem('agentdeck.sidebarTab') || selected; } catch {}
  try { sortMode = localStorage.getItem('agentdeck.gitSort') || sortMode; } catch {}
  let byProject = false;
  try { byProject = localStorage.getItem('agentdeck.gitByProject') === '1'; } catch {}
  // How the repositories list their changes: by folders (tree) or as a flat list. The button above the list sets it for
  // all of them; a repository's own menu makes that repository differ (repoViews, by its key). Either way as
  // IntelliJ's commit view: a checkbox on every file and folder, checked being staged.
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
  // The project a repository belongs to: the deepest one holding it - a linked worktree by its main checkout, else by
  // its own folder (a worktree added as a project of its own) - or, in none, its own folder.
  function getRepoProject(sourceId, repo) {
    const root = normPath(repo.root);
    const holding = dir => (data.projects || []).filter(p => (p.node || 'local') === sourceId && within(dir, normPath(p.path)))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const project = holding(normPath(repo.mainRoot || repo.root)) || holding(root);
    return project ? { key: project.n, name: project.name } : { key: root, name: root.split('/').filter(Boolean).at(-1) || root };
  }
  // A repository is open until folded; inside a project group ("Group by Project") it is folded until opened, so an
  // opened project shows the list of its repositories first.
  // The two views keep their own fold state (a <details> drawn open reports itself as opened, so one state would carry
  // "open" from the plain list into the groups).
  const getRepoExpandId = key => (byProject ? `in-project:${key}` : key);
  const isRepoOpen = key => (byProject ? expanded.get(getRepoExpandId(key)) === true : expanded.get(key) !== false);
  // With "Group by Project": the repositories in a foldable group per project (folded until opened), the projects by name.
  function getRepoRows(items) {
    if (!byProject) return items.map(x => x.html);
    const groups = new Map();
    for (const x of items) {
      if (!groups.has(x.project.key)) groups.set(x.project.key, { key: `project:${x.project.key}`, name: x.project.name, rows: [] });
      groups.get(x.project.key).rows.push(x.html);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)).map(g =>
      `<details class="git-project" data-expand="${esc(g.key)}" ${expanded.get(g.key) === true ? 'open' : ''}><summary class="git-project-head">`
      + `<span class="git-chevron">${icon('right')}</span>${icon('folder')}<span>${esc(g.name)}</span><span class="git-count">${g.rows.length}</span>`
      + `</summary>${g.rows.join('')}</details>`);
  }
  function setByProject(on) {
    byProject = on;
    try { localStorage.setItem('agentdeck.gitByProject', on ? '1' : '0'); } catch {}
    render();
  }
  const saveViews = () => { try { localStorage.setItem(TREE_KEY, tree ? '1' : '0'); localStorage.setItem(REPO_VIEWS_KEY, JSON.stringify(repoViews)); } catch {} };
  // All the repositories by folders, or all as lists: the ones that differed follow too.
  function setTree(on) {
    tree = on; repoViews = {};
    saveViews();
    $('gitTreeToggle').setAttribute('aria-pressed', String(tree));
    render();
  }
  // One repository apart from the others; nothing is kept for it once it is as they are.
  function setRepoTree(key, on) {
    if (on === tree) delete repoViews[key]; else repoViews[key] = { tree: on };
    saveViews();
    render();
  }
  function render() {
    if (selected !== 'git') return;
    const sources = [{ id: 'local', name: t('git.panel.local'), status: 'online', git }, ...nodes], rows = [], open = openFolders();
    const tips = new Map();
    repositories.clear();
    for (const source of sources) {
      const paths = open.filter(p => (p.node || 'local') === source.id).map(p => normPath(p.path));
      if (!paths.length) continue;
      const shown = openRoots(paths, Object.values(source.git?.repos || {}).map(repo => normPath(repo.root)));
      const items = [];
      for (const repo of Object.values(source.git?.repos || {}).sort((a, b) => a.root.localeCompare(b.root))) {
        if (!shown.has(normPath(repo.root))) continue;
        const key = JSON.stringify([source.id, repo.root]), node = { key, node: source.id === 'local' ? '' : source.id, repo, offline: source.status !== 'online', source: source.name, error: errors.get(key) || source.gitError || repo.error };
        repositories.set(key, node);
        const offline = source.status !== 'online', disabled = offline || busy.has(key), files = repo.files || [], staged = files.some(f => accepts('staged', f));
        tips.set(key, `${source.name}\n${repo.root}\n${gitText('checked')}: ${repo.at ? new Date(repo.at).toLocaleTimeString() : '—'}${offline || Date.now() - (repo.at || 0) > 150000 ? '\n' + gitText('stale') : ''}`);
        items.push({ project: getRepoProject(source.id, repo), html: `<details class="git-repository ${offline ? 'offline' : ''}" data-repo="${esc(key)}" data-expand="${esc(getRepoExpandId(key))}" ${isRepoOpen(key) ? 'open' : ''}>
          <summary><span class="git-chevron">${icon('right')}</span><strong>${esc(repo.root.split(/[\\/]/).at(-1))}</strong><span class="git-repo-branch">${icon('branch')}${esc(repo.error ? '' : gitHead(repo))}</span>${gitAb(repo)}${source.id === 'local' ? '' : `<span class="proj-node ${offline ? 'offline' : 'online'}">${icon('nodes')}${esc(source.name)}</span>`}${offline ? `<span class="git-offline">${icon('alert')}</span>` : ''}<span class="grow"></span><span class="git-hover-actions">${quick('preview', 'eye', 'commit', disabled)}${quick('commit', 'check', 'commitMenu', disabled || !staged || !(drafts.get(key) || '').trim())}${quick('branches', 'branch', 'branches', disabled)}${quick('refresh', 'refresh', 'refresh', disabled)}${more('data-repo-menu', disabled)}</span><span class="git-count">${repo.fileCount ?? files.length}</span></summary>
          <div class="git-commit-box"><textarea class="textarea" data-commit-message="${esc(key)}" rows="1" spellcheck="false" aria-label="${esc(gitText('message'))}" placeholder="${esc(gitText('commitHint'))}" ${disabled ? 'disabled' : ''}>${esc(drafts.get(key) || '')}</textarea><div class="git-commit-split"><button type="button" class="btn sm primary git-commit-button" data-repo-action="commit" ${disabled || !staged || !(drafts.get(key) || '').trim() ? 'disabled' : ''}>${icon('check')}<span>${esc(gitText(busy.has(key) ? 'loading' : 'commitMenu'))}</span></button></div></div>
          ${errors.has(key) || repo.error || source.gitError ? `<p class="git-panel-error" role="status">${esc(errors.get(key) || repo.error || source.gitError)}</p>` : ''}
          ${grouped(node, disabled)}${!files.length && !repo.error ? `<p class="git-clean">${esc(gitText('empty'))}</p>` : filter && !files.some(f => f.path.toLocaleLowerCase().includes(filter)) ? `<p class="git-clean">${esc(gitText('noMatches'))}</p>` : ''}
          ${repo.filesTruncated ? `<p class="git-panel-note">${esc(t('git.panel.truncated'))}</p>` : ''}</details>` });
      }
      rows.push(...getRepoRows(items));
      if (source.git?.missing) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(t('git.panel.missing'))}</p>`);
      if (source.git?.discoveryTruncated) rows.push(`<p class="git-panel-note">${esc(source.name)}: ${esc(t('git.panel.scanLimit'))}</p>`);
    }
    $('gitRepoCount').textContent = repositories.size;
    if (!repositories.has(activeKey)) activeKey = repositories.keys().next().value || '';
    window.gitFooter?.render();
    const html = rows.join('') || `<p class="git-panel-note">${esc(t('git.panel.empty'))}</p>`;
    if (html !== last) {
      const active = document.activeElement, focused = active?.dataset, scroll = list.scrollTop, selection = focused?.commitMessage ? [active.selectionStart, active.selectionEnd] : null;
      list.innerHTML = html; last = html; list.scrollTop = scroll;
      for (const box of list.querySelectorAll?.('.git-check[data-mixed]') || []) box.indeterminate = true;
      if (focused?.commitMessage) {
        const input = [...list.querySelectorAll('[data-commit-message]')].find(b => b.dataset.commitMessage === focused.commitMessage);
        input?.focus({ preventScroll: true }); if (input && selection) input.setSelectionRange(...selection);
      } else if (focused?.diffFile) [...list.querySelectorAll('[data-diff-file]')].find(b => b.dataset.diffFile === focused.diffFile && b.dataset.diffRoot === focused.diffRoot && b.dataset.diffNode === focused.diffNode)?.focus({ preventScroll: true });
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
  function panelMenuItems() {
    const view = [
      item('asTree', 'folder', () => setTree(!tree), { checked: tree }),
      item('byProject', 'stack', () => setByProject(!byProject), { checked: byProject }),
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
  list.addEventListener('toggle', e => { if (e.target.dataset.expand) expanded.set(e.target.dataset.expand, e.target.open); }, true);
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
  $('gitTreeToggle').title = gitText('tree');
  $('gitPanelTitle').textContent = gitText('sourceControl');
  $('gitPanelMenu').title = gitText('panelActions');
  $('gitFilter').oninput = e => { filter = e.target.value.toLocaleLowerCase(); render(); };
  $('gitTreeToggle').setAttribute('aria-pressed', String(tree));
  $('gitTreeToggle').onclick = () => setTree(!tree);
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
