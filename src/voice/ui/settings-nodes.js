// Settings -> Computers: this node (its name, port, whether it is announced on the network, and its pairing code),
// the computers it is paired with and whether they are reachable, the phones paired with it (and "Add phone": a QR
// code, docs/MOBILE.md 4), the ones found on the network, and pairing by address. Everything applies at once; main (mesh/links.js) pushes the whole picture again on every change. Loaded
// before settings.js, which switches tabs and sizes the window. Uses $, esc, icon, t from common.js.
(() => {
  const pane = $("nodes");
  const mesh = window.voiceSettings.mesh;
  let state = null; // { self, nodes (the computers), phones, discovered, lan (this computer's LAN addresses) }
  let busy = "";    // the id or address being paired
  const fit = () => { if (document.body.dataset.pane === "nodes") window.voiceSettings.fit(); };

  pane.innerHTML = `
    <div class="vs-hint err" id="nodesOff" role="alert" hidden></div>
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
      <h2>${icon("phone")}<span>${esc(t("settings.phones"))}</span></h2>
      <div class="vs-nodes" id="nodesPhones"></div>
      <div class="vs-pair"><button type="button" class="btn sm primary" id="phoneAdd">${icon("plus")}<span>${esc(t("settings.phones.add"))}</span></button></div>
      <div class="vs-hint">${esc(t("settings.phones.hint"))}</div>
      <div class="vs-hint" id="phoneResult" role="status"></div>
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
    // The mesh is off (a file of this node that cannot be read, main.js startMesh) or not up yet: only why.
    $("nodesOff").hidden = Boolean(s);
    for (const sec of pane.querySelectorAll(".vs-sec")) sec.hidden = !s;
    if (!s) {
      $("nodesOff").textContent = state.error ? t("settings.nodes.off", { error: state.error }) : t("settings.nodes.starting");
      fit();
      return;
    }
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
    $("nodesPhones").innerHTML = (state.phones || []).map(phoneRow).join("") || `<div class="vs-hint">${esc(t("settings.phones.empty"))}</div>`;
    fit();
  }
  function apply(next) {
    if (next) state = next;
    render();
    phonePaired();
  }

  // ---------- phones (docs/MOBILE.md 4, 5) ----------
  // A paired phone: its name, when it was paired and last seen, and Forget - here and on every computer (main asks
  // them all; those offline now are named, the phone may still be paired there).
  function phoneRow(n) {
    const online = n.status === "online";
    const seen = online ? "" : n.lastSeen ? t("settings.phones.lastSeen", { time: since(n.lastSeen) }) : t("settings.phones.neverSeen");
    return `<div class="vs-node" data-id="${esc(n.id)}">${icon("phone")}
      <span class="who"><b title="${esc(n.id)}">${esc(n.name || n.id.slice(0, 8))}</b><small>${esc([t("settings.phones.pairedAt", { time: since(n.pairedAt) }), seen].filter(Boolean).join(" · "))}</small></span>
      <span class="tag${online ? " ok" : ""}">${esc(t(online ? "settings.nodes.online" : "settings.nodes.offline"))}</span>
      <button type="button" class="btn sm" data-forget-phone="${esc(n.id)}">${icon("x")}<span>${esc(t("settings.nodes.forget"))}</span></button></div>`;
  }
  $("nodesPhones").addEventListener("click", async e => {
    const id = e.target.closest("[data-forget-phone]")?.dataset.forgetPhone;
    if (!id) return;
    const n = (state.phones || []).find(x => x.id === id);
    if (!confirm(t("settings.phones.forgetConfirm", { name: n?.name || id.slice(0, 8) }))) return;
    const r = await mesh.forgetPhone(id);
    if (r?.state) apply(r.state);
    if (r?.still?.length) result($("phoneResult"), t("settings.phones.stillPaired", { list: r.still.join(", ") }), false);
    else result($("phoneResult"), t("settings.phones.forgotten", { name: n?.name || id.slice(0, 8) }), true);
  });

  // "Add phone": a dialog that asks which computers and which relay, then shows the QR code (rendered here, by
  // qrcode-generator) for as long as its invites last, and closes itself once a phone has paired.
  const dlg = document.createElement("dialog");
  dlg.className = "dialog vs-phone";
  document.body.appendChild(dlg);
  let invite = null, tick = 0, closing = 0; // invite: { text, expires, madeAt, included, skipped } while a code is shown
  const wrapHost = a => (a.includes(":") ? `[${a}]` : a);
  // The relays a phone can dial: computers this one reaches directly; the relay-only ones first.
  const rank = n => (n.relayOnly ? 0 : n.kind === "host" ? 1 : 2);
  const relays = () => state.nodes.filter(n => n.status === "online" && !(n.via || []).length && n.address).sort((a, b) => rank(a) - rank(b));
  function addressFor(relayId) {
    const r = state.nodes.find(n => n.id === relayId);
    return r ? `${wrapHost(r.address)}:${r.port}` : state.lan?.[0] ? `${state.lan[0]}:${state.self.port}` : "";
  }
  // The host part of "host", "host:port", "[v6]:port" or a bare IPv6 address.
  const hostOf = a => {
    const s = String(a || "").trim();
    if (s.startsWith("[")) return s.slice(1).split("]")[0];
    return (s.match(/:/g) || []).length > 1 ? s : s.split(":")[0];
  };
  // An address only this computer reaches (a relay on this machine, as this computer dials it): useless to a phone.
  const loopback = a => /^(127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1|localhost|0\.0\.0\.0|::)$/i.test(hostOf(a));
  // Under the address field: what is wrong with a loopback one, and this computer's LAN addresses (with the relay's
  // port) to take instead - a loopback relay runs on this machine.
  function addressHint(address, relayId) {
    if (!loopback(address)) return "";
    const r = state.nodes.find(n => n.id === relayId);
    const port = (r ? r.port : state.self.port) || "";
    const lan = (state.lan || []).map(a => `${wrapHost(a)}${port ? `:${port}` : ""}`);
    return `<div class="vs-hint warn">${esc(t("settings.phones.loopback", { address }))}</div>
      ${lan.length ? `<div class="vs-hint">${esc(t("settings.phones.lanOffer"))} ${lan.map(a => `<button type="button" class="btn sm" data-phone-lan="${esc(a)}">${esc(a)}</button>`).join(" ")}</div>` : ""}`;
  }
  function formHtml(relayId, address, ticked) {
    // A relay-only computer runs no sessions: it can be the relay, not one to reach.
    const others = state.nodes.filter(n => n.id !== relayId && !n.relayOnly);
    const row = n => {
      const direct = !(n.via || []).length && n.address;
      const why = n.status !== "online" ? t("settings.nodes.offline") : !relayId && !direct ? t("settings.phones.needsRelay") : "";
      const can = !why;
      return `<label class="vs-phone-node"><input type="checkbox" data-phone-node="${esc(n.id)}" ${can && ticked(n.id) ? "checked" : ""} ${can ? "" : "disabled"}><b>${esc(n.name || n.id.slice(0, 8))}</b><small>${esc(why)}</small></label>`;
    };
    return `<form class="confirm-form" method="dialog">
      <h2>${esc(t("settings.phones.add"))}</h2>
      <p>${esc(t("settings.phones.intro"))}</p>
      <div class="vs-phone-label">${esc(t("settings.phones.computers"))}</div>
      <label class="vs-phone-node"><input type="checkbox" checked disabled><b>${esc(state.self.name)}</b><small>${esc(t("settings.nodes.self"))}</small></label>
      ${others.map(row).join("")}
      <div class="vs-phone-label">${esc(t("settings.phones.relay"))}</div>
      <select class="select" id="phoneRelay">${relays().map(n => `<option value="${esc(n.id)}" ${n.id === relayId ? "selected" : ""}>${esc(n.name || n.id.slice(0, 8))}</option>`).join("")}
        <option value="" ${relayId ? "" : "selected"}>${esc(t("settings.phones.noRelay"))}</option></select>
      <div class="vs-phone-label">${esc(t(relayId ? "settings.phones.relayAddress" : "settings.phones.ownAddress"))}</div>
      <input class="input mono" id="phoneAddress" spellcheck="false" autocomplete="off" value="${esc(loopback(address) ? "" : address)}">
      <div id="phoneAddressHint">${addressHint(address, relayId)}</div>
      <div class="vs-hint">${esc(t(relayId ? "settings.phones.relayAddressHint" : "settings.phones.ownAddressHint"))}</div>
      <div class="vs-hint err" id="phoneError" role="status"></div>
      <div class="confirm-actions"><button type="button" class="btn" data-phone-close>${esc(t("common.cancel"))}</button><button type="button" class="btn primary" id="phoneMake">${icon("phone")}<span>${esc(t("settings.phones.make"))}</span></button></div>
    </form>`;
  }
  function showForm(relayId = relays()[0]?.id || "", ticked = () => true) {
    invite = null;
    clearInterval(tick);
    dlg.innerHTML = formHtml(relayId, addressFor(relayId), ticked);
  }
  // The QR code as SVG: dark modules on white with the quiet zone around. The text is all in the alphanumeric set
  // (pair-code.js), so it is encoded in that mode; error correction M, or L when M would need more than version 20.
  function qrSvg(text) {
    const make = level => { const qr = qrcode(0, level); qr.addData(text, "Alphanumeric"); qr.make(); return qr; };
    let qr = null;
    try { qr = make("M"); if (qr.getModuleCount() > 17 + 4 * 20) qr = make("L"); } catch { try { qr = make("L"); } catch { qr = null; } }
    if (!qr) return "";
    const n = qr.getModuleCount(), q = 4, size = n + 2 * q;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
    // Big modules: 5 px each, up to the dialog's width.
    const px = Math.min(440, size * 5);
    return `<svg viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="${esc(t("settings.phones.scan"))}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  function showCode() {
    const x = invite;
    dlg.innerHTML = `<div class="confirm-form">
      <h2>${esc(t("settings.phones.scan"))}</h2>
      <div class="vs-qr" id="phoneQr">${qrSvg(x.text)}</div>
      <div class="vs-phone-left" id="phoneLeft"></div>
      <p>${esc(t("settings.phones.for", { list: x.included.join(", ") }))}</p>
      ${x.skipped.map(s => `<div class="vs-hint warn">${esc(t("settings.phones.skipped", { name: s.name, error: s.error }))}</div>`).join("")}
      <div class="vs-phone-label">${esc(t("settings.phones.paste"))}</div>
      <textarea class="input mono" readonly id="phoneText">${esc(x.text)}</textarea>
      <div class="vs-hint" id="phoneStatus" role="status"></div>
      <div class="confirm-actions"><button type="button" class="btn" id="phoneCopy">${icon("copy")}<span>${esc(t("common.copy"))}</span></button><button type="button" class="btn" data-phone-close>${esc(t("common.close"))}</button></div>
    </div>`;
    const left = () => {
      const ms = x.expires - Date.now();
      if (ms <= 0) {
        clearInterval(tick);
        $("phoneQr")?.classList.add("expired");
        $("phoneLeft").textContent = t("settings.phones.expired");
        return;
      }
      const s = Math.ceil(ms / 1000);
      $("phoneLeft").textContent = t("settings.phones.left", { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` });
    };
    left();
    clearInterval(tick);
    tick = setInterval(left, 1000);
  }
  // A phone that paired since the code was made: the dialog says so and closes.
  function phonePaired() {
    if (!invite || closing) return;
    const p = (state.phones || []).find(x => x.pairedAt >= invite.madeAt);
    if (!p) return;
    $("phoneStatus").textContent = t("settings.phones.paired", { name: p.name || p.id.slice(0, 8) });
    $("phoneStatus").classList.add("ok");
    closing = setTimeout(() => { closing = 0; dlg.close(); }, 1500);
  }
  async function make() {
    const relay = $("phoneRelay").value, address = $("phoneAddress").value.trim();
    const nodes = [...dlg.querySelectorAll("[data-phone-node]:checked")].map(x => x.dataset.phoneNode);
    $("phoneMake").disabled = true;
    const madeAt = Date.now();
    const r = await mesh.invitePhone({ relay, address, nodes });
    if (!dlg.open) return;
    if (!r?.ok) {
      $("phoneMake").disabled = false;
      $("phoneError").textContent = r?.error || t("errors.unreachable");
      return;
    }
    invite = { ...r, madeAt };
    showCode();
  }
  dlg.addEventListener("click", async e => {
    if (e.target.closest("[data-phone-close]")) return dlg.close();
    if (e.target.closest("#phoneMake")) return make();
    const lan = e.target.closest("[data-phone-lan]");
    if (lan) {
      $("phoneAddress").value = lan.dataset.phoneLan;
      $("phoneAddressHint").innerHTML = "";
      return;
    }
    if (e.target.closest("#phoneCopy")) {
      await navigator.clipboard.writeText(invite?.text || "");
      $("phoneStatus").textContent = t("settings.phones.copied");
    }
  });
  // A loopback address typed by hand gets the same hint.
  dlg.addEventListener("input", e => {
    if (e.target.id === "phoneAddress") $("phoneAddressHint").innerHTML = addressHint(e.target.value.trim(), $("phoneRelay").value);
  });
  dlg.addEventListener("change", e => {
    if (e.target.id !== "phoneRelay") return;
    const ticked = new Set([...dlg.querySelectorAll("[data-phone-node]:checked")].map(x => x.dataset.phoneNode));
    showForm(e.target.value, id => ticked.has(id) || !dlg.querySelector(`[data-phone-node="${CSS.escape(id)}"]`));
  });
  dlg.addEventListener("close", () => { clearInterval(tick); clearTimeout(closing); closing = 0; invite = null; dlg.innerHTML = ""; });
  $("phoneAdd").addEventListener("click", () => {
    if (!state) return;
    showForm();
    dlg.showModal();
  });
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
