// Shared labels and repository actions for the Git sidebar and dialogs.
const GIT_LABELS = {
  reviewChanges: ['Review changes', 'Преглед на промените'],
  repository: ['Choose repository', 'Избери хранилище'], gitErrors: ['Git errors', 'Git грешки'],
  noHistory: ['No commits yet', 'Все още няма commits'], graph: ['Graph', 'Graph'],
  fetch: ['Fetch', 'Изтегли'], pull: ['Pull (fast-forward)', 'Издърпай (fast-forward)'], push: ['Push', 'Избутай'],
  noUpstream: ['No upstream branch', 'Няма upstream branch'],
  publish: ['Publish branch', 'Публикувай branch'],
  publishHint: ['Choose a remote to publish this branch and set its upstream.', 'Избери remote за публикуване на branch-а и настройване на upstream.'],
  noRemote: ['No remotes configured. Add a remote in your terminal to sync this repository.', 'Няма настроен remote. Добави remote през терминала, за да синхронизираш хранилището.'],
  dirtyHint: ['Commit or stash changes before switching branches or pulling.', 'Направи commit или stash на промените преди смяна на branch или Pull.'],
  continueHint: ['Continue to process the remaining commits, or abort the operation.', 'Продължи с останалите commits или прекрати операцията.'],
  noStaged: ['No staged changes. Stage files from Source Control first.', 'Няма подготвени промени. Първо подготви файлове от Git панела.'],
  noMatches: ['No files match this filter.', 'Няма файлове, съответстващи на филтъра.'],
  done: ['Done.', 'Готово.'],
  commitReady: ['Only staged changes will be committed.', 'Commit ще включва само подготвените промени.'],
  comparison: ['Compare', 'Сравнение'], refreshReview: ['Refresh review', 'Обнови прегледа'],
  stageAll: ['Stage all changes', 'Подготви всички промени'], unstageAll: ['Unstage all', 'Извади всички от commit'],
  commitHint: ['Message (Ctrl+Enter to commit)', 'Съобщение (Ctrl+Enter за commit)'],
  stageFile: ['Stage changes', 'Подготви промените'], unstageFile: ['Unstage changes', 'Извади от commit'],
  sync: ['Sync with remote', 'Синхронизация'], filter: ['Filter files', 'Филтрирай файловете'],
  changes: ['Changes', 'Промени'], staged: ['Staged', 'За commit'], untracked: ['Untracked', 'Нови файлове'], conflicts: ['Conflicts', 'Конфликти'],
  search: ['Filter paths…', 'Търсене по път…'], tree: ['Folders', 'Папки'], list: ['List', 'Списък'],
  stage: ['Stage selected', 'Подготви избраните'], unstage: ['Unstage selected', 'Извади избраните'],
  manage: ['Repository actions', 'Действия с repo'], commit: ['Review & commit', 'Преглед и commit'],
  refresh: ['Refresh', 'Обнови'], previous: ['Previous', 'Предишен'], next: ['Next', 'Следващ'],
  editor: ['Open in VS Code', 'Отвори във VS Code'], editorIdea: ['Open in IntelliJ IDEA', 'Отвори в IntelliJ IDEA'], split: ['Side by side', 'Един до друг'], unified: ['Unified', 'Обединен'],
  checked: ['Checked', 'Проверено'], stale: ['Status may be outdated', 'Статусът може да е остарял'],
  branches: ['Branches', 'Branches'], branch: ['New branch name', 'Име на нов branch'], switch: ['Switch branch', 'Смени branch'], create: ['Create branch', 'Създай branch'],
  branchMenu: ['Branch', 'Branch'], commitMenu: ['Commit', 'Commit'], pullPush: ['Pull, Push', 'Pull, Push'],
  checkout: ['Checkout to…', 'Checkout към…'], viewSort: ['View & Sort', 'Изглед и сортиране'],
  asTree: ['View by folders', 'Изглед по папки'], byProject: ['Group by Project', 'Групирай по проект'],
  oneFile: ['1 file', '1 файл'], fileCount: ['{n} files', '{n} файла'], asList: ['View as List', 'Изглед като списък'],
  sortPath: ['Sort by Path', 'Сортирай по път'], sortName: ['Sort by Name', 'Сортирай по име'],
  sortStatus: ['Sort by Status', 'Сортирай по статус'], showOutput: ['Show Git Output', 'Покажи Git изхода'],
  history: ['History', 'История'], more: ['Older commits', 'По-стари commits'], compare: ['Compare with base', 'Сравни с базов branch'],
  worktrees: ['Worktrees & AI tasks', 'Worktrees и AI задачи'], path: ['Absolute worktree path', 'Абсолютен път за worktree'],
  task: ['Create worktree & start session', 'Създай worktree и стартирай сесия'], terminal: ['Open terminal', 'Отвори терминал'],
  remove: ['Remove worktree', 'Премахни worktree'], removeConfirm: ['Remove this clean worktree? Its branch and commits will be kept.', 'Да премахна ли този чист worktree? Branch-ът и commits ще се запазят.'],
  abort: ['Abort operation', 'Прекрати операцията'], continue: ['Continue operation', 'Продължи операцията'],
  abortConfirm: ['Abort the current operation? Conflict-resolution edits may be lost.', 'Да прекратя ли операцията? Редакции за разрешаване на конфликти може да се загубят.'],
  message: ['Commit message', 'Commit съобщение'], reviewed: ['Commit reviewed changes', 'Commit на прегледаните промени'],
  empty: ['No changes', 'Няма промени'], close: ['Close', 'Затвори'], loading: ['Loading…', 'Зареждане…'],
  base: ['Base branch', 'Базов branch'], remote: ['Remote', 'Remote'], upstream: ['Upstream', 'Upstream'],
  active: ['Active terminals / sessions', 'Активни терминали / сесии'], sessions: ['Sessions', 'Сесии'],
  operation: ['Operation in progress', 'Текуща операция'], select: ['Select file', 'Избери файл'],
  noAgent: ['Terminal only', 'Само терминал'], resolve: ['Resolve conflicts in your editor, stage the files, then continue.', 'Разреши конфликтите в редактора, подготви файловете и продължи.'],
  noFetch: ['Ahead/behind reflects the last fetch.', 'Ahead/behind е спрямо последния fetch.'],
  all: ['Select group', 'Избери групата'],
  sourceControl: ['Source Control', 'Git промени'], panelActions: ['Source Control actions', 'Git действия'],
  worktreesNav: ['Worktrees', 'Worktrees'], agent: ['Agent', 'Агент'], changedFiles: ['Changed files', 'Променени файлове']
};
// "editor" is named after the editor chosen in Settings (prefs.js EDITORS).
let preferredEditor = window.prefs?.editor || 'vscode';
window.prefs?.onChanged?.(p => { preferredEditor = p.editor || 'vscode'; });
function gitText(key) {
  const label = key === 'editor' && preferredEditor === 'idea' ? 'editorIdea' : key;
  return GIT_LABELS[label]?.[typeof I18N !== 'undefined' && I18N.language() === 'bg' ? 1 : 0] || key;
}
window.gitWorkflow = (() => {
  let target = null, details = null, generation = 0, busy = false, view = 'branches', draft = '';
  const outputs = new Map(), drafts = new Map();
  const targetKey = () => JSON.stringify([target.node, target.root]);
  const rememberDraft = (node, root, message) => drafts.set(JSON.stringify([node, root]), message);
  // Lane colours from the theme, so the graph follows it.
  const GRAPH_COLORS = ['--accent', '--busy', '--wait', '--read', '--danger', '--opencode', '--working', '--claude'].map(name => `var(${name})`);
  // The shared dialog (common.js) where the page has it.
  const ask = (title, body, danger) => typeof confirmDialog === 'function' ? confirmDialog({ title, body, confirmLabel: title, danger }) : Promise.resolve(confirm(body));
  const GRAPH_LIMIT = 150;
  let graphCommits = [], graphSkip = 0, graphHasMore = false;
  const dialog = $('gitActionsDialog'), body = $('gitActionsBody'), result = $('gitActionsResult');
  const button = (action, label, glyph, disabled = false, kind = '') => `<button class="btn sm ${kind}" type="button" data-git-action="${action}" ${disabled ? 'disabled' : ''}>${glyph ? icon(glyph) : ''}${esc(gitText(label || action))}</button>`;
  const input = (id, label, value = '', kind = '') => `<label class="git-field ${kind}">${esc(gitText(label))}<input class="input" id="${id}" value="${esc(value)}" autocomplete="off" spellcheck="false"></label>`;
  const options = (values, selected = '') => values.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v || gitText('noAgent'))}</option>`).join('');
  const query = args => window.manager.gitQuery(target.node, { root: target.root, ...args });
  async function execute(args) {
    const response = await window.manager.gitExecute(target.node, { root: target.root, ...args });
    result.textContent = recordOutput(target.node, target.root, response);
    result.dataset.state = 'success';
    return response;
  }
  function recordOutput(node, root, response) {
    const text = [response.output, response.messages].filter(Boolean).join('\n') || gitText('done');
    outputs.set(JSON.stringify([node, root]), text);
    return text;
  }
  async function refresh() {
    const request = ++generation;
    const next = await query({ kind: 'details' });
    if (request !== generation || !dialog.open) return;
    details = next;
    const st = details.status;
    const dirty = Boolean(st.fileCount || st.files?.length || st.staged || st.unstaged || st.untracked || st.conflicts);
    const blocked = dirty || Boolean(details.operation), noRemotes = !details.remotes.length;
    body.innerHTML = `<div class="git-sync-summary">
        <span class="git-sync-branch">${icon('branch')}<b>${esc(st.branch || st.oid)}</b></span>
        <span class="git-sync-meta">${st.upstream ? `${esc(gitText('upstream'))}: ${esc(st.upstream)}` : esc(gitText('noUpstream'))}${st.ahead ? ` <span class="gab">↑${st.ahead}</span>` : ''}${st.behind ? ` <span class="gab">↓${st.behind}</span>` : ''}</span>
        <span class="grow"></span>
      </div>
      <p class="git-sync-note" data-sync-only>${esc(gitText(noRemotes ? 'noRemote' : st.upstream ? 'noFetch' : 'publishHint'))}</p>
      <div class="git-sync-bar" data-sync-only>${button('fetch', 'fetch', 'download', noRemotes)}${button('pull', 'pull', 'download', blocked || !st.upstream)}${button('push', st.upstream ? 'push' : 'publish', 'upload', noRemotes || st.detached || st.initial)}<label class="git-field inline" ${st.upstream || noRemotes ? 'hidden' : ''}><span>${esc(gitText('remote'))}</span><select class="select" id="gitRemote">${options(details.remotes)}</select></label><span class="grow"></span>${button('refresh', 'refresh', 'refresh')}</div>
      ${dirty ? `<p class="git-state-note" data-dirty-note>${esc(gitText('dirtyHint'))}</p>` : ''}
      ${details.operation ? `<section class="git-operation"><h3>${esc(gitText('operation'))}: ${esc(details.operation)}</h3><p>${esc(gitText(st.conflicts ? 'resolve' : 'continueHint'))}</p><div class="git-toolbar">${button('continue', 'continue', 'play', Boolean(st.conflicts))}${button('abort', 'abort', 'x', false, 'danger')}</div></section>` : ''}
      <section><h3>${esc(gitText('branches'))}</h3><div class="git-toolbar"><select class="select" id="gitBranch" aria-label="${esc(gitText('branches'))}">${options(details.branches, st.branch)}</select>${button('switch', 'switch', 'branch')}</div><div class="git-form-row">${input('gitNewBranch', 'branch')}${button('branch', 'create', 'plus')}</div></section>
      <section><h3>${esc(gitText('commit'))}</h3>${button('preview', 'refreshReview', 'refresh')}<div id="gitCommitReview"></div></section>
      <section><h3>${esc(gitText('history'))}</h3><div class="git-form-row">${button('history', 'refresh', 'refresh')}<span class="grow"></span>${input('gitBase', 'base', details.branches.includes('main') ? 'main' : details.branches.includes('master') ? 'master' : st.upstream || 'HEAD', 'inline')}${button('compare', 'compare', 'splitRight')}</div><div class="git-history-split"><div class="git-history-list"><div id="gitHistory" class="git-graph"></div><div id="gitHistoryPager" class="git-graph-more"></div></div><div id="gitHistoryPatch"></div></div></section>
      <section><h3>${esc(gitText('worktrees'))}</h3>${details.worktrees.map((w, i) => `<article class="git-worktree"><strong>${esc(w.branch || w.oid || '')}</strong><div class="git-worktree-path">${esc(w.path)}</div><small>${esc(gitText('active'))}: ${w.active.length} · ${esc(gitText('sessions'))}: ${w.sessions.length}</small>${w.sessions.map(s => `<div>${esc(s.agent)} · ${esc(s.title)}</div>`).join('')}<div class="git-toolbar"><button class="btn sm" data-worktree-open="${i}">${icon('terminal')}${esc(gitText('terminal'))}</button>${i && !w.locked && !w.active.length ? `<button class="btn sm danger" data-worktree-remove="${i}">${icon('trash')}${esc(gitText('remove'))}</button>` : ''}</div></article>`).join('')}
      <div class="git-task-form">${input('gitTaskBranch', 'branch')}${input('gitTaskPath', 'path')}${input('gitTaskBase', 'base', st.branch || 'HEAD')}<label class="git-field">${esc(gitText('agent'))}<select class="select" id="gitTaskAgent">${options(['', 'Claude', 'Codex', 'OpenCode'])}</select></label>${button('task', 'task', 'play', false, 'primary')}</div></section>`;
    const sections = [...body.querySelectorAll(':scope > section')];
    const views = [...(details.operation ? ['sync'] : []), 'branches', 'commit', 'history', 'worktrees'];
    sections.forEach((section, i) => { section.hidden = views[i] !== 'sync' && views[i] !== (view === 'compare' ? 'history' : view); });
    for (const child of body.querySelectorAll('[data-sync-only]')) child.hidden = view !== 'sync';
    for (const child of body.querySelectorAll('[data-dirty-note]')) child.hidden = !['sync', 'branches'].includes(view);
    for (const child of body.querySelectorAll('[data-git-action="switch"], [data-git-action="branch"]')) child.disabled = blocked;
    dialog.dataset.view = view;
  }
  async function launch(cwd, agent = '') {
    if (target.node) return window.manager.remoteLaunch(target.node, { cwd, kind: agent ? 'new' : 'shell', agent });
    return agent ? window.manager.launchNew(agent, cwd) : window.manager.launchFolder(cwd);
  }
  function patch(container, text) { container.innerHTML = `<pre class="diff-patch">${renderGitPatch(text || gitText('empty'))}</pre>`; }
  // ---------- history graph ----------
  // A commit's decorations become chips: the checked-out branch, local branches, remotes and tags.
  function classifyRef(raw) {
    if (raw.startsWith('HEAD -> ')) return { type: 'head', name: raw.slice(8) };
    if (raw === 'HEAD' || /\/HEAD$/.test(raw)) return null;
    if (raw.startsWith('tag: ')) return { type: 'tag', name: raw.slice(5) };
    if ((details?.remotes || []).some(r => raw.startsWith(r + '/'))) return { type: 'remote', name: raw };
    return { type: 'branch', name: raw };
  }
  function refChips(raw = '') {
    return raw.split(',').map(s => s.trim()).filter(Boolean).map(classifyRef).filter(Boolean).map(r =>
      `<span class="gref ${r.type}" title="${esc(r.name)}">${icon(r.type === 'tag' ? 'tag' : r.type === 'remote' ? 'globe' : 'branch')}${esc(r.name)}</span>`).join('');
  }
  // Lanes: each holds the commit it is still waiting for, so rows line up and merges curve.
  function graphLayout(commits) {
    let lanes = [], color = 0;
    const rows = [];
    for (const c of commits) {
      let cols = [];
      for (let i = 0; i < lanes.length; i++) if (lanes[i].oid === c.oid) cols.push(i);
      const created = !cols.length;
      if (created) { lanes.push({ oid: c.oid, color: GRAPH_COLORS[color++ % GRAPH_COLORS.length] }); cols = [lanes.length - 1]; }
      const before = lanes.map(l => ({ ...l }));
      const nodeCol = cols[0], nodeColor = before[nodeCol].color, merges = cols.slice(1);
      const next = lanes.map(l => ({ ...l }));
      next[nodeCol].oid = c.parents[0] || null;
      // The other lanes waiting for this commit end on it; the branch's parents take over below.
      for (const m of merges) next[m].oid = null;
      for (let i = 1; i < c.parents.length; i++) {
        const p = c.parents[i];
        if (!p || next.some(l => l.oid === p)) continue;
        next.splice(Math.min(next.length, nodeCol + i), 0, { oid: p, color: GRAPH_COLORS[color++ % GRAPH_COLORS.length] });
      }
      const after = [], seen = new Set();
      for (const l of next) { if (!l.oid || seen.has(l.oid)) continue; seen.add(l.oid); after.push(l); }
      rows.push({ commit: c, before, after, nodeCol, nodeColor, merges, created });
      lanes = after;
    }
    const maxLanes = Math.max(1, ...rows.map(r => Math.max(r.before.length, r.after.length, r.nodeCol + 1)));
    return { rows, maxLanes };
  }
  function renderGraph() {
    const host = $('gitHistory'), pager = $('gitHistoryPager');
    if (!host) return;
    if (!graphCommits.length) { host.innerHTML = `<p class="git-panel-note">${esc(gitText('noHistory'))}</p>`; if (pager) pager.innerHTML = ''; return; }
    const { rows, maxLanes } = graphLayout(graphCommits);
    const LW = 13, RH = 32, W = maxLanes * LW, CY = RH / 2, x = i => i * LW + LW / 2;
    const html = rows.map(({ commit: c, before, after, nodeCol, nodeColor, merges, created }) => {
      const at = oid => after.findIndex(l => l.oid === oid);
      const paths = [];
      // The line coming down from the row above, into this commit's node.
      if (!created) paths.push(`<path d="M${x(nodeCol)} 0 L${x(nodeCol)} ${CY}" style="stroke:${nodeColor}"/>`);
      before.forEach((l, i) => {
        if (i === nodeCol || merges.includes(i)) return;
        const j = at(l.oid); if (j < 0) return;
        const x1 = x(i), x2 = x(j);
        paths.push(`<path d="M${x1} 0 C${x1} ${CY} ${x2} ${CY} ${x2} ${RH}" style="stroke:${l.color}"/>`);
      });
      for (const m of merges) {
        const xm = x(m), xc = x(nodeCol);
        paths.push(`<path d="M${xm} 0 C${xm} ${CY * 0.9} ${xc} ${CY * 0.6} ${xc} ${CY}" style="stroke:${before[m].color}"/>`);
      }
      for (const [pi, p] of c.parents.entries()) {
        if (!p) continue;
        const j = at(p); if (j < 0) continue;
        const xc = x(nodeCol), xp = x(j);
        paths.push(`<path d="M${xc} ${CY} C${xc} ${CY + 4} ${xp} ${RH - 6} ${xp} ${RH}" style="stroke:${pi === 0 ? nodeColor : after[j].color}"/>`);
      }
      const node = `<circle cx="${x(nodeCol)}" cy="${CY}" r="4.5" style="fill:var(--panel);stroke:${nodeColor};stroke-width:2"/>`;
      const date = new Date(c.date);
      const when = Number.isNaN(date.getTime()) ? c.date.slice(0, 10) : date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
      return `<button type="button" class="graph-row" data-commit="${esc(c.oid)}" title="${esc(c.oid)}">
        <svg class="graph-lanes" width="${W}" height="${RH}" viewBox="0 0 ${W} ${RH}" aria-hidden="true">${paths.join('')}${node}</svg>
        <span class="graph-info"><span class="graph-subject">${refChips(c.refs)}<span class="graph-title">${esc(c.subject)}</span><span class="graph-meta">${esc(c.author)} · ${esc(when)}</span></span></span>
      </button>`;
    }).join('');
    host.innerHTML = `<div class="graph-list">${html}</div>`;
    if (pager) pager.innerHTML = graphHasMore ? `<button class="btn sm" type="button" data-git-action="more">${icon('history')}<span>${esc(gitText('more'))}</span></button>` : '';
  }
  async function action(name) {
    if (name === 'refresh') return refresh();
    if (name === 'preview') {
      const oldMessage = body.querySelector('#gitCommitMessage');
      if (oldMessage) draft = oldMessage.value;
      const review = await query({ kind: 'preview' });
      $('gitCommitReview').innerHTML = `${review.patch ? `<pre class="diff-patch">${renderGitPatch(review.patch)}</pre>` : `<p class="git-state-note">${esc(gitText('noStaged'))}</p>`}<label class="git-field">${esc(gitText('message'))}<textarea class="textarea" id="gitCommitMessage" maxlength="20000" spellcheck="false" placeholder="${esc(gitText('commitHint'))}"></textarea></label><div class="git-review-submit"><small>${esc(gitText('commitReady'))}</small><button class="btn sm primary" id="gitCommitSubmit" disabled>${esc(gitText('reviewed'))}</button></div>`;
      const updateSubmit = () => { $('gitCommitSubmit').disabled = !review.patch || !$('gitCommitMessage').value.trim() || Boolean(details.status.conflicts); };
      $('gitCommitSubmit').onclick = () => guarded(async () => {
        const message = $('gitCommitMessage').value.trim(); if (!message) return;
        await execute({ action: 'commit', message, token: review.token });
        draft = ''; drafts.delete(targetKey());
        window.gitPanel?.setDraft?.(target.node, target.root, '');
        await refresh(); await action('preview');
      });
      $('gitCommitMessage').value = draft;
      $('gitCommitMessage').oninput = () => { draft = $('gitCommitMessage').value; drafts.set(targetKey(), draft); window.gitPanel?.setDraft?.(target.node, target.root, draft); updateSubmit(); };
      $('gitCommitMessage').onkeydown = e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!$('gitCommitSubmit').disabled) $('gitCommitSubmit').click(); }
      };
      updateSubmit();
      return;
    }
    if (name === 'history' || name === 'more') {
      if (name === 'history') { graphSkip = 0; graphCommits = []; $('gitHistoryPatch').innerHTML = ''; }
      const { commits } = await query({ kind: 'graph', limit: GRAPH_LIMIT, skip: graphSkip });
      graphCommits = graphCommits.concat(commits);
      graphSkip += commits.length;
      graphHasMore = commits.length >= GRAPH_LIMIT;
      renderGraph();
      return;
    }
    if (name === 'compare') {
      const comparison = await query({ kind: 'compare', base: $('gitBase').value });
      $('gitHistoryPatch').innerHTML = `<p class="git-sync-note">${esc(gitText('changedFiles'))}: ${comparison.files.length}</p><ul>${comparison.files.map(file => `<li><code>${esc(file)}</code></li>`).join('')}</ul><pre class="diff-patch">${renderGitPatch(comparison.patch || gitText('empty'))}</pre>`;
      return;
    }
    if (name === 'abort' && !(await ask(gitText('abort'), gitText('abortConfirm'), true))) return;
    if (name === 'task') {
      const agent = $('gitTaskAgent').value;
      const response = await execute({ action: 'worktree-add', branch: $('gitTaskBranch').value.trim(), path: $('gitTaskPath').value.trim(), base: $('gitTaskBase').value });
      // Keep the created worktree if launching fails; it remains available for retry.
      await refresh(); await launch(response.path, agent); return;
    }
    await execute({ action: name, branch: name === 'switch' ? $('gitBranch').value : $('gitNewBranch').value.trim(), remote: $('gitRemote').value });
    await refresh();
  }
  async function guarded(fn) {
    if (busy) return; busy = true; dialog.setAttribute('aria-busy', 'true');
    body.inert = true; $('gitActionsNav').inert = true; $('gitActionsClose').disabled = true;
    result.dataset.state = 'loading';
    result.textContent = gitText('loading');
    const controls = [...body.querySelectorAll('button, input, select, textarea')];
    const disabled = controls.map(el => el.disabled); controls.forEach(el => { el.disabled = true; });
    try { await fn(); } catch (e) { result.textContent = e.message; result.dataset.state = 'error'; outputs.set(targetKey(), e.message); }
    finally { controls.forEach((el, i) => { el.disabled = disabled[i]; }); busy = false; body.inert = false; $('gitActionsNav').inert = false; $('gitActionsClose').disabled = false; dialog.setAttribute('aria-busy', 'false'); if (result.textContent === gitText('loading')) result.textContent = ''; }
  }
  body.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.gitAction) return guarded(() => action(b.dataset.gitAction));
    if (b.dataset.commit) return guarded(async () => {
      patch($('gitHistoryPatch'), (await query({ kind: 'commit', oid: b.dataset.commit })).patch);
      for (const row of body.querySelectorAll('.graph-row.selected')) row.classList.remove('selected');
      b.classList.add('selected');
      $('gitHistoryPatch').scrollIntoView({ block: 'nearest' });
    });
    if (b.dataset.worktreeOpen !== undefined) return guarded(() => launch(details.worktrees[Number(b.dataset.worktreeOpen)].path));
    if (b.dataset.worktreeRemove !== undefined) return ask(gitText('remove'), gitText('removeConfirm'), true).then(ok => ok && guarded(async () => {
      await execute({ action: 'worktree-remove', path: details.worktrees[Number(b.dataset.worktreeRemove)].path }); await refresh();
    }));
  });
  $('gitActionsClose').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; });
  function renderNav() {
    const nav = $('gitActionsNav'); nav.setAttribute('aria-label', gitText('manage'));
    const labels = { commit: 'commitMenu', compare: 'comparison', worktrees: 'worktreesNav' };
    $('gitActionsIcon').innerHTML = icon({ sync: 'refresh', commit: 'eye', compare: 'splitRight', history: 'history', worktrees: 'layers', branches: 'branch' }[view] || 'branch');
    nav.innerHTML = ['commit', 'branches', 'sync', 'history', 'compare', 'worktrees'].map(mode => `<button type="button" data-view="${mode}" aria-pressed="${view === mode}">${esc(gitText(labels[mode] || mode))}</button>`).join('');
  }
  $('gitActionsNav').addEventListener('click', e => {
    const mode = e.target.closest('[data-view]')?.dataset.view;
    if (!mode || busy || mode === view) return;
    view = mode; renderNav();
    guarded(async () => { await refresh(); if (view === 'commit') await action('preview'); if (view === 'history') await action('history'); }).then(() => $('gitActionsNav').querySelector(`[data-view="${view}"]`)?.focus());
  });
  async function open(node, root, mode = 'branches', message = '') {
    if (busy) return;
    view = mode === true ? 'commit' : mode === false ? 'branches' : mode;
    target = { node, root }; result.textContent = ''; body.textContent = gitText('loading');
    draft = drafts.get(targetKey()) ?? message;
    $('gitActionsTitle').textContent = root.split(/[\\/]/).at(-1);
    $('gitActionsLocation').textContent = root;
    renderNav();
    $('gitActionsTitle').title = root; dialog.showModal();
    await guarded(async () => { await refresh(); if (view === 'commit') await action('preview'); if (view === 'history') await action('history'); });
  }
  // The sync view with the last command's output, instead of a fresh blank result.
  async function openOutput(node, root) {
    await open(node, root, 'sync');
    result.textContent = outputs.get(targetKey()) || gitText('empty');
  }
  return { open, openOutput, recordOutput, rememberDraft };
})();
