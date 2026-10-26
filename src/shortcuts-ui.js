// The keyboard button of the edge menu (and F1): a panel with every shortcut - the global ones as they are set right
// now (main's "app:shortcuts"), then the menu's own keys. Esc, the cross or a click elsewhere closes it.
(() => {
  const panel = $("kbdPanel");
  const keys = label => String(label || "").split(" + ").filter(Boolean)
    .map(k => `<kbd>${esc(k)}</kbd>`).join('<span class="plus">+</span>');
  const row = (k, what) => (k ? `<div class="kbd-row"><span>${esc(what)}</span><span class="kbd-keys">${k}</span></div>` : "");

  async function open() {
    let s = {};
    try { s = await window.manager.getShortcuts(); } catch {}
    const global = [
      row(keys(s.menu), t("bar.shortcuts.menu")),
      s.commandHold && s.menu ? row(`${esc(t("bar.shortcuts.hold"))} ${keys(s.menu)}`, t("bar.shortcuts.command")) : "",
      row(keys(s.dictate), t("bar.shortcuts.dictate")),
      row(keys(s.readAloud), t("bar.shortcuts.readAloud")),
      row(keys(s.editSelection), t("bar.shortcuts.edit")),
      row(keys(s.ask), t("bar.shortcuts.ask")),
      row(keys("Esc"), t("bar.shortcuts.cancelRec"))
    ].join("");
    const menu = [[["↑", "↓"], "bar.shortcuts.session"], [["←", "→"], "bar.shortcuts.project"], [["Enter"], "bar.shortcuts.open"],
      [["Esc"], "bar.shortcuts.esc"], [["F5"], "bar.shortcuts.refresh"], [["F1"], "bar.shortcuts.help"]]
      .map(([k, what]) => row(k.map(x => `<kbd>${esc(x)}</kbd>`).join(" "), t(what))).join("")
      + row(`<span class="kbd-any">${esc(t("bar.shortcuts.typeAny"))}</span>`, t("bar.shortcuts.search"));
    panel.innerHTML = `<div class="kbd-head"><b>${esc(t("bar.shortcuts.title"))}</b><button class="icon-btn" data-kbd="close" title="${esc(t("common.close"))}">${icon("x")}</button></div>
      <h3>${esc(t("bar.shortcuts.global"))}</h3>${global}<h3>${esc(t("bar.shortcuts.inMenu"))}</h3>${menu}
      <div class="kbd-note">${esc(t("bar.shortcuts.note"))}</div>`;
    panel.hidden = false;
  }
  const close = () => { panel.hidden = true; };
  const toggle = () => (panel.hidden ? open() : close());

  $("shortcutsBtn").addEventListener("click", e => { e.stopPropagation(); toggle(); });
  panel.addEventListener("click", e => { e.stopPropagation(); if (e.target.closest('[data-kbd="close"]')) close(); });
  document.addEventListener("click", close);
  // Before bar.js's keys: F1 toggles, Esc closes the panel without closing the menu.
  window.addEventListener("keydown", e => {
    if (e.key === "F1") { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === "Escape" && !panel.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
  }, true);
  window.manager.onBarEvent(ev => { if (ev.type === "hide") close(); });
})();
