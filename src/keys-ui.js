// The manager window's keyboard shortcuts in a popup (F1, or the sidebar's keyboard icon). The keys themselves are
// workspace-ui.js's (getWorkspaceKey), the search's (palette-ui.js) and renderer.js's; this lists them. Classic script
// loaded last; kept in a function scope, as the page's scripts share one global scope.
(() => {
  const box = $("keysPanel");
  // A chord as keycaps: "Ctrl+Shift+1" -> Ctrl + Shift + 1; " / " separates alternatives.
  const keys = chord => chord.split(" / ").map(alt => alt.split("+").map(k => `<kbd>${esc(k)}</kbd>`).join("")).join(" / ");
  const row = (chord, what) => `<div class="keys-row"><span>${esc(what)}</span><span class="keys-keys">${keys(chord)}</span></div>`;

  function render() {
    // Only the agents found on this computer have a key that does something.
    const agents = Object.values(NEW_AGENT_KEYS).filter(a => getInstalledAgents().includes(a));
    const groups = [
      ["keys.group.sessions", [
        ["Ctrl+Shift+T", t("keys.newTerminal")],
        ...agents.map(a => [getNewAgentKey(a), t("keys.newAgent", { agent: a })]),
        ...(agents.length ? [[`Ctrl+Alt+Shift+${agents.map(a => getNewAgentKey(a).slice(-1)).join(" / ")}`, t("keys.newAgentBeside")]] : []),
        ["Ctrl+Shift+R", t("keys.resumeLatest")],
        ["Ctrl+K", t("keys.search")]
      ]],
      ["keys.group.windows", [
        ["Ctrl+,", t("keys.settings")],
        ["Ctrl+Shift+H", t("keys.history")],
        ["Ctrl+Shift+U", t("keys.usage")],
        ["F5", t("keys.rescan")],
        ["F1", t("keys.help")]
      ]],
      ["keys.group.panes", [
        ["Alt+Shift+= / Alt+Shift+-", t("keys.split")],
        ["Alt+←→↑↓", t("keys.focus")],
        ["Ctrl+Tab / Ctrl+Shift+Tab", t("keys.nextTab")],
        ["Ctrl+Shift+Z", t("keys.zoom")],
        ["Ctrl+Shift+W", t("keys.closePane")],
        ["Ctrl+= / Ctrl+- / Ctrl+0", t("keys.font")]
      ]]
    ];
    $("keysList").innerHTML = groups.map(([title, rows]) => `<h3>${esc(t(title))}</h3>${rows.map(([k, what]) => row(k, what)).join("")}`).join("");
  }
  function toggle() {
    box.hidden = !box.hidden;
    if (!box.hidden) render();
  }

  $("keysBtn").addEventListener("click", toggle);
  box.addEventListener("mousedown", e => { if (e.target === box) toggle(); });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape" && !box.hidden) { e.preventDefault(); e.stopPropagation(); toggle(); }
  }, true);

  // Not window.keysPanel: that name is the element's.
  window.shortcutsHelp = { toggle };
})();
