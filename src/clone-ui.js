// "Clone to…" (a project's menu): the project's repository cloned on another computer, on a branch (new or
// existing), and an agent started in it on a prompt - all in a terminal there that shows here in a pane
// (main: mesh:clone). The dialog asks the computer, the folder there, the branch and its base (this computer's
// current branch), the agent and the prompt. Loaded before renderer.js; uses $, esc, icon, t from common.js and
// onlineNodes() from nodes-ui.js.
let cloneDialog = null;

function buildCloneDialog() {
  const d = document.createElement("dialog");
  d.id = "cloneDialog";
  d.className = "modal";
  d.innerHTML = `<form method="dialog" class="modal-form">
    <h2>${icon("nodes")}<span id="cloneTitle"></span></h2>
    <label><span>${esc(t("clone.node"))}</span><select id="cloneNode" class="select"></select></label>
    <label><span>${esc(t("clone.url"))}</span><div class="modal-url"><input id="cloneUrl" class="input mono" spellcheck="false"><button type="button" class="btn sm" id="cloneHttps" title="${esc(t("clone.httpsTitle"))}">HTTPS</button></div><span class="modal-note" id="cloneUrlHint"></span></label>
    <label><span>${esc(t("clone.dir"))}</span><input id="cloneDir" class="input mono" spellcheck="false"></label>
    <div class="modal-row">
      <label><span>${esc(t("clone.branch"))}</span><input id="cloneBranch" class="input mono" spellcheck="false" placeholder="feat/…"></label>
      <label><span>${esc(t("clone.base"))}</span><input id="cloneBase" class="input mono" spellcheck="false"></label>
    </div>
    <div class="modal-row">
      <label><span>${esc(t("clone.agent"))}</span><select id="cloneAgent" class="select"></select></label>
    </div>
    <label><span>${esc(t("clone.prompt"))}</span><textarea id="clonePrompt" class="input" rows="4" placeholder="${esc(t("clone.promptHint"))}"></textarea></label>
    <div class="modal-hint" id="cloneHint"></div>
    <div class="modal-actions">
      <button type="button" class="btn" value="cancel" id="cloneCancel">${esc(t("common.cancel"))}</button>
      <button type="submit" class="btn primary" id="cloneGo">${icon("play")}${esc(t("clone.go"))}</button>
    </div>
  </form>`;
  document.body.append(d);
  d.querySelector("#cloneCancel").addEventListener("click", () => d.close());
  d.querySelector("#cloneNode").addEventListener("change", fillCloneDir);
  d.querySelector("#cloneUrl").addEventListener("input", renderUrlHint);
  d.querySelector("#cloneHttps").addEventListener("click", () => { $("cloneUrl").value = toHttps($("cloneUrl").value); renderUrlHint(); });
  d.querySelector("#cloneAgent").addEventListener("change", () => { $("clonePrompt").disabled = !$("cloneAgent").value; });
  d.querySelector("form").addEventListener("submit", e => { e.preventDefault(); submitClone().catch(err => { $("cloneHint").textContent = err.message; $("cloneHint").className = "modal-hint err"; }); });
  return d;
}
// git@github.com:a/b.git -> https://github.com/a/b.git; ssh://git@host/a/b -> https://host/a/b.
function toHttps(url) {
  const u = url.trim();
  let m = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = /^ssh:\/\/(?:[\w.-]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(u);
  return m ? `https://${m[1]}/${m[2]}` : u;
}
const isSsh = url => /^[\w.-]+@[\w.-]+:|^ssh:\/\//.test(url.trim());
function renderUrlHint() {
  const ssh = isSsh($("cloneUrl").value);
  $("cloneUrlHint").textContent = ssh ? t("clone.sshHint") : "";
  $("cloneHttps").hidden = !ssh;
}
// The folder on the chosen computer: its work folder, by the project's name.
function fillCloneDir() {
  const n = onlineNodes().find(x => x.id === $("cloneNode").value);
  const name = $("cloneDialog").dataset.name;
  const home = n?.info?.home || (n?.kind === "host" || n?.info?.platform === "linux" ? "~" : "~");
  $("cloneDir").value = `${home.replace(/[\\/]+$/, "")}${home.includes("\\") ? "\\" : "/"}work${home.includes("\\") ? "\\" : "/"}${name}`;
  $("cloneAgent").innerHTML = `<option value="">${esc(t("clone.noAgent"))}</option>` + (n?.data?.agents || []).map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  $("clonePrompt").disabled = !$("cloneAgent").value;
}
// path: the local project; node: the computer chosen in the menu (or the first one online).
async function openCloneDialog(path, node) {
  const list = onlineNodes();
  if (!list.length) return toast(t("clone.noNodes"), true);
  cloneDialog ||= buildCloneDialog();
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  cloneDialog.dataset.path = path;
  cloneDialog.dataset.name = name;
  $("cloneTitle").textContent = t("clone.title", { name });
  $("cloneNode").innerHTML = list.map(n => `<option value="${esc(n.id)}" ${n.id === node?.id ? "selected" : ""}>${esc(n.name)}</option>`).join("");
  const info = await window.manager.gitInfo(path).catch(() => ({ url: "", branch: "" }));
  $("cloneUrl").value = info.url || "";
  renderUrlHint();
  $("cloneBase").value = info.branch || "";
  $("cloneBranch").value = "";
  $("clonePrompt").value = "";
  $("cloneHint").textContent = info.url ? "" : t("clone.noRemote");
  $("cloneHint").className = "modal-hint";
  fillCloneDir();
  cloneDialog.showModal();
  $("cloneBranch").focus();
}
async function submitClone() {
  const node = $("cloneNode").value, url = $("cloneUrl").value.trim(), dir = $("cloneDir").value.trim();
  if (!url || !dir) throw new Error(t("clone.needUrlDir"));
  $("cloneGo").disabled = true;
  try {
    await window.manager.remoteClone(node, {
      url, dir, branch: $("cloneBranch").value.trim(), base: $("cloneBase").value.trim(),
      agent: $("cloneAgent").value, prompt: $("clonePrompt").value.trim()
    });
  } finally {
    $("cloneGo").disabled = false;
  }
  cloneDialog.close();
  toast(t("clone.started", { node: onlineNodes().find(n => n.id === node)?.name || "" }));
}
