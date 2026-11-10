// Settings -> Computers: this node (its name, port, whether it is announced on the network, and its pairing code),
// the computers it is paired with and whether they are reachable, the ones found on the network, and pairing by
// address. Everything applies at once; main (mesh/links.js) pushes the whole picture again on every change. Loaded
// before settings.js, which switches tabs and sizes the window. Uses $, esc, icon, t from common.js.
(() => {
  const pane = $("nodes");
  const mesh = window.voiceSettings.mesh;
  let state = null; // { self, nodes, discovered }
  let busy = "";    // the id or address being paired
  const fit = () => { if (document.body.dataset.pane === "nodes") window.voiceSettings.fit(); };

  pane.innerHTML = `
    <section class="vs-sec">
      <h2>${icon("window")}<span>${esc(t("settings.nodes.self"))}</span></h2>
      <div class="vs-grid">
        <label class="vs-label" for="nodeName">${esc(t("settings.nodes.name"))}</label>
        <div class="vs-field"><input id="nodeName" class="input" type="text" maxlength="60" spellcheck="false" autocomplete="off"><div class="vs-hint">${esc(t("settings.nodes.nameHint"))}</div></div>
        <label class="vs-label" for="nodePort">${esc(t("settings.nodes.port"))}</label>
        <div class="vs-field"><input id="nodePort" class="input mono" type="number" min="0" max="65535" style="width:120px"><div class="vs-hint" id="nodePortHint"></div></div>
        <span class="vs-label">${esc(t("settings.nodes.discovery"))}</span>
        <div class="vs-field">
          <label class="vs-toggle" for="nodeDiscoverable"><span><b>${esc(t("settings.nodes.discoverable"))}</b></span><input type="checkbox" id="nodeDiscoverable" class="switch"></label>
          <div class="vs-hint">${esc(t("settings.nodes.discoverableHint"))}</div>
        </div>
        <label class="vs-label" for="nodeProxy">${esc(t("settings.nodes.proxy"))}</label>
        <div class="vs-field"><input id="nodeProxy" class="input mono" type="text" spellcheck="false" autocomplete="off" placeholder="http://proxy:8080" style="width:260px"><div class="vs-hint">${esc(t("settings.nodes.proxyHint"))}</div></div>
        <span class="vs-label">${esc(t("settings.nodes.code"))}</span>
        <div class="vs-field">
          <div class="vs-code"><b id="nodeCode"></b><button type="button" class="btn sm" id="nodeNewCode">${icon("refresh")}<span>${esc(t("settings.nodes.newCode"))}</span></button></div>
          <div class="vs-hint">${esc(t("settings.nodes.codeHint"))}</div>
          <div class="vs-hint warn" id="nodePairFailures" hidden></div>
        </div>
      </div>
    </section>
    <section class="vs-sec">
      <h2>${icon("nodes")}<span>${esc(t("settings.nodes.paired"))}</span></h2>
      <div class="vs-nodes" id="nodesPaired"></div>
    </section>
    <section class="vs-sec">
      <h2>${icon("search")}<span>${esc(t("settings.nodes.found"))}</span></h2>
      <div class="vs-nodes" id="nodesFound"></div>
    </section>
    <section class="vs-sec">
      <h2>${icon("plus")}<span>${esc(t("settings.nodes.byAddress"))}</span></h2>
      <div class="vs-grid">
        <label class="vs-label" for="nodeAddress">${esc(t("settings.nodes.address"))}</label>
        <div class="vs-field">
          <div class="vs-pair">
            <input id="nodeAddress" class="input mono" type="text" spellcheck="false" autocomplete="off" placeholder="192.168.1.20:7421">
            <input id="nodeTheirCode" class="input code" type="text" spellcheck="false" autocomplete="off" placeholder="${esc(t("settings.nodes.codePlaceholder"))}">
            <button type="button" class="btn sm primary" id="nodePair">${icon("plus")}<span>${esc(t("settings.nodes.pair"))}</span></button>
          </div>
          <div class="vs-hint" id="nodeAddressHint"></div>
          <div class="vs-hint" id="nodePairResult" role="status"></div>
        </div>
      </div>
    </section>`;

  // The readiness of one node, shown under its row: the facts as the node answered them, and the fixes.
  let setupOpen = "", setupState = null, setupBusy = false;
  const check = (ok, label, detail = "") => `<div class="vs-check ${ok ? "ok" : "no"}">${icon(ok ? "check" : "alert")}<b>${esc(label)}</b>${detail ? `<span>${esc(detail)}</span>` : ""}</div>`;
  function setupHtml() {
    const s = setupState;
    if (!s) return `<div class="vs-hint">${esc(t("settings.nodes.setupLoading"))}</div>`;
    if (s.error) return `<div class="vs-hint err">${esc(s.error)}</div>`;
    const key = s.sshKey;
    return [
      check(Boolean(s.git), "git", s.git || t("settings.nodes.setup.noGit")),
      check(Boolean(key), "SSH", key ? key.file : t("settings.nodes.setup.noKey")),
      key ? `<div class="vs-keyline"><code>${esc(key.publicKey)}</code><button type="button" class="btn sm" data-setup-copy>${icon("copy")}<span>${esc(t("common.copy"))}</span></button></div><div class="vs-hint">${esc(t("settings.nodes.setup.keyHint"))}</div>`
        : (s.sshKeygen ? `<div class="vs-pair"><button type="button" class="btn sm primary" data-setup-act="generateKey" ${setupBusy ? "disabled" : ""}>${icon("key")}<span>${esc(t("settings.nodes.setup.makeKey"))}</span></button></div>` : ""),
      `<div class="vs-pair"><input class="input mono" id="setupHost" placeholder="github.com" spellcheck="false"><button type="button" class="btn sm" data-setup-act="addKnownHost" ${setupBusy ? "disabled" : ""}>${icon("plus")}<span>${esc(t("settings.nodes.setup.trustHost"))}</span></button></div>
       <div class="vs-hint">${esc(t("settings.nodes.setup.knownHosts", { list: s.knownHosts.length ? s.knownHosts.slice(0, 8).join(", ") : "—" }))}</div>`,
      check(Boolean(s.gitIdentity.name && s.gitIdentity.email), t("settings.nodes.setup.identity"), s.gitIdentity.name ? `${s.gitIdentity.name} <${s.gitIdentity.email}>` : t("settings.nodes.setup.noIdentity")),
      `<div class="vs-pair"><input class="input" id="setupName" placeholder="${esc(t("settings.nodes.setup.name"))}" value="${esc(s.gitIdentity.name)}"><input class="input" id="setupEmail" placeholder="email" value="${esc(s.gitIdentity.email)}"><button type="button" class="btn sm" data-setup-act="setGitIdentity" ${setupBusy ? "disabled" : ""}>${icon("check")}<span>${esc(t("settings.nodes.setup.save"))}</span></button></div>`,
      check(s.agents.length > 0, t("settings.nodes.setup.agents"), s.agents.length ? s.agents.join(", ") : t("settings.nodes.setup.noAgents")),
      `<div class="vs-hint">${esc(t("settings.nodes.setup.facts", { platform: s.platform, node: s.node, home: s.home }))}</div>`
    ].join("");
  }
  async function loadSetup(id) {
    setupOpen = id;
    setupState = null;
    render();
    try { setupState = await mesh.setup(id); } catch (e) { setupState = { error: e.message }; }
    render();
  }
  async function setupAct(action, args) {
    setupBusy = true;
    render();
    const r = await mesh.setupAction(setupOpen, action, args);
    setupBusy = false;
    if (r?.ok) await loadSetup(setupOpen);
    else { setupState = { ...setupState, error: r?.error }; render(); }
  }
  const kindOf = n => t(`settings.nodes.kind.${n.kind === "host" ? "host" : "desktop"}`);
  const since = ms => (ms ? I18N.formatDateTime(ms, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
  function nodeRow(n, action) {
    const online = n.status === "online";
    const tag = online ? `<span class="tag ok">${esc(t("settings.nodes.online"))}</span>`
      : `<span class="tag" title="${esc(n.lastSeen ? t("settings.nodes.offlineSince", { time: since(n.lastSeen) }) : "")}">${esc(t("settings.nodes.offline"))}</span>`;
    const via = (n.via || []).map(id => [...state.nodes, ...state.discovered].find(x => x.id === id)?.name || id.slice(0, 8));
    const where = via.length ? t("settings.nodes.via", { route: via.join(" ? ") }) : n.address ? `${n.address}${n.port ? `:${n.port}` : ""}` : "";
    return `<div class="vs-node" data-id="${esc(n.id)}">${icon(n.kind === "host" ? "terminal" : "window")}
      <span class="who"><b title="${esc(n.id)}">${esc(n.name || n.id.slice(0, 8))}</b><small>${esc([kindOf(n), n.version ? `v${n.version}` : "", where].filter(Boolean).join(" · "))}</small></span>
      ${n.error ? `<small role="status">${esc(n.error)}</small>` : ""}${tag}${action}</div>`;
  }
  function render() {
    if (!state) return;
    const s = state.self;
    if (document.activeElement !== $("nodeName")) $("nodeName").value = s.name;
    if (document.activeElement !== $("nodePort")) $("nodePort").value = s.port;
    $("nodePortHint").textContent = t("settings.nodes.portHint", { port: s.port });
    $("nodeDiscoverable").checked = s.discoverable;
    if (document.activeElement !== $("nodeProxy")) $("nodeProxy").value = s.proxy || "";
    $("nodeCode").textContent = s.code.length > 8 ? s.code : `${s.code.slice(0, 3)} ${s.code.slice(3)}`;
    // Wrong pairing codes since AgentDeck started (pair-guard.js): someone may be guessing.
    const fails = s.pairFailures || {};
    $("nodePairFailures").hidden = !fails.failures;
    if (fails.failures) $("nodePairFailures").textContent = t("settings.nodes.pairFailures", { n: fails.failures, source: fails.lastSource, time: new Date(fails.lastAt).toLocaleString() });
    $("nodeAddressHint").textContent = t("settings.nodes.addressHint", { port: s.port });
    const paired = state.nodes.map(n => nodeRow(n, `${n.relayOnly ? `<span class="tag" title="${esc(t("settings.nodes.relayHint"))}">${esc(t("settings.nodes.relay"))}</span>` : n.status === "online" ? `<button type="button" class="btn sm" data-setup="${esc(n.id)}">${icon("sliders")}<span>${esc(t("settings.nodes.setup"))}</span></button>` : ""}<button type="button" class="btn sm" data-forget="${esc(n.id)}">${icon("x")}<span>${esc(t("settings.nodes.forget"))}</span></button>`)
      + (setupOpen === n.id ? `<div class="vs-setup" id="nodeSetup">${setupHtml()}</div>` : ""));
    $("nodesPaired").innerHTML = paired.join("") || `<div class="vs-hint">${esc(t("settings.nodes.pairedEmpty"))}</div>`;
    const known = new Set(state.nodes.map(n => n.id));
    const found = state.discovered.filter(n => !known.has(n.id)).map(n => nodeRow({ ...n, status: "online" },
      `<input class="input" type="text" data-code="${esc(n.id)}" placeholder="${esc(t("settings.nodes.codePlaceholder"))}" spellcheck="false" autocomplete="off">
       <button type="button" class="btn sm primary" data-pair="${esc(n.id)}" ${busy === n.id ? "disabled" : ""}>${icon("plus")}<span>${esc(t(busy === n.id ? "settings.nodes.pairing" : "settings.nodes.pair"))}</span></button>`));
    $("nodesFound").innerHTML = found.join("") || `<div class="vs-hint">${esc(t("settings.nodes.foundEmpty"))}</div>`;
    fit();
  }
  function apply(next) {
    if (next) state = next;
    render();
  }
  function result(el, text, ok) {
    el.textContent = text;
    el.classList.toggle("ok", ok);
    el.classList.toggle("err", !ok);
    fit();
  }
  async function pairWith(address, code, resultEl, key) {
    busy = key;
    render();
    const r = await mesh.pair(address, code);
    busy = "";
    if (r?.ok) result(resultEl, t(r.node.already ? "settings.nodes.alreadyPaired" : "settings.nodes.pairedWith", { name: r.node.name || address }), true);
    else result(resultEl, r?.error || t("errors.unreachable"), false);
    apply(await mesh.get().catch(() => null));
  }

  $("nodeName").addEventListener("change", async e => apply(await mesh.set({ name: e.target.value })));
  $("nodePort").addEventListener("change", async e => apply(await mesh.set({ port: Number(e.target.value) })));
  $("nodeDiscoverable").addEventListener("change", async e => apply(await mesh.set({ discoverable: e.target.checked })));
  $("nodeProxy").addEventListener("change", async e => apply(await mesh.set({ proxy: e.target.value })));
  $("nodeNewCode").addEventListener("click", async () => apply(await mesh.newCode()));
  $("nodesPaired").addEventListener("click", async e => {
    const open = e.target.closest("[data-setup]")?.dataset.setup;
    if (open) return setupOpen === open ? (setupOpen = "", render()) : loadSetup(open);
    if (e.target.closest("[data-setup-copy]")) { await navigator.clipboard.writeText(setupState?.sshKey?.publicKey || ""); return; }
    const act = e.target.closest("[data-setup-act]")?.dataset.setupAct;
    if (act === "generateKey") return setupAct(act, {});
    if (act === "addKnownHost") return setupAct(act, { host: $("setupHost").value.trim() });
    if (act === "setGitIdentity") return setupAct(act, { name: $("setupName").value.trim(), email: $("setupEmail").value.trim() });
    const id = e.target.closest("[data-forget]")?.dataset.forget;
    if (!id) return;
    if (setupOpen === id) setupOpen = "";
    const n = state.nodes.find(x => x.id === id);
    if (!confirm(t("settings.nodes.forgetConfirm", { name: n?.name || id.slice(0, 8) }))) return;
    apply(await mesh.forget(id));
  });
  $("nodesFound").addEventListener("click", e => {
    const id = e.target.closest("[data-pair]")?.dataset.pair;
    if (!id || busy) return;
    const n = state.discovered.find(x => x.id === id);
    const code = pane.querySelector(`[data-code="${CSS.escape(id)}"]`)?.value || "";
    if (n) pairWith(n.via?.length ? n.id : `${n.address}:${n.port}`, code, $("nodePairResult"), id);
  });
  $("nodePair").addEventListener("click", () => {
    if (busy) return;
    pairWith($("nodeAddress").value, $("nodeTheirCode").value, $("nodePairResult"), "address");
  });
  for (const id of ["nodeAddress", "nodeTheirCode"]) $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("nodePair").click(); } });

  mesh.onChanged(apply);
  mesh.get().then(s => { if (s) apply(s); else $("tabNodes").hidden = true; }).catch(() => { $("tabNodes").hidden = true; });
})();
