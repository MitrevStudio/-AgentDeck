// A new session: computer -> project -> agent -> task (optional), started in a terminal there; or one of the
// project's earlier sessions resumed. Start sits in the header, so it stays in sight above the keyboard.
import { t } from "../i18n.js";
import { esc, baseName } from "../util.js";
import { icon, agentIcon } from "../icons.js";
import { header, sessionRow, projectMark } from "./parts.js";

const pick = { node: "", project: "", agent: "" }; // remembered while the app runs

export function render(el, ctx) {
  const store = ctx.store;
  el.innerHTML = `<div class="new-head"></div><main class="body new"></main>`;
  const head = el.querySelector(".new-head"), body = el.querySelector(".new");
  let prompt = "";

  function drawHead(canStart) {
    head.innerHTML = header(t("new.title"), {
      actions: canStart != null ? `<button class="btn sm primary" data-act="start" ${canStart ? "" : "disabled"}>${icon("play")}<span>${esc(t("new.start"))}</span></button>` : ""
    });
    head.querySelector("[data-act='start']")?.addEventListener("click", start);
  }

  function draw() {
    const nodes = store.computers().filter(n => n.online);
    if (!nodes.length) { drawHead(null); body.innerHTML = `<p class="empty">${esc(t("new.noComputers"))}</p>`; return; }
    if (!nodes.some(n => n.id === pick.node)) pick.node = nodes[0].id;
    const projects = store.projects(pick.node);
    if (!projects.some(x => x.path === pick.project)) pick.project = projects[0]?.path || "";
    const agents = store.agents(pick.node);
    if (pick.agent !== "shell" && !agents.includes(pick.agent)) pick.agent = agents[0] || "shell";
    const project = projects.find(x => x.path === pick.project);
    const old = (project?.sessions || []).filter(x => x.status === "stopped").slice(0, 8);

    const seg = (kind, value, label, on, ic = "") => `<button class="${on ? "on" : ""}" data-${kind}="${esc(value)}" aria-pressed="${on}">${ic}<span>${esc(label)}</span></button>`;
    const step = (n, key) => `<h2 class="group step"><span class="step-n">${n}</span>${esc(t(key))}</h2>`;
    drawHead(Boolean(project));
    body.innerHTML = `
      ${step(1, "new.computer")}
      <div class="seg">${nodes.map(n => seg("node", n.id, n.name, n.id === pick.node, icon(n.kind === "headless" ? "server" : "computer"))).join("")}</div>
      ${step(2, "new.project")}
      ${projects.length ? `<div class="list">${projects.map(x => {
        const name = x.name || baseName(x.path), on = x.path === pick.project;
        return `<button class="pick${on ? " on" : ""}" data-project="${esc(x.path)}" aria-pressed="${on}">${projectMark(name)}
          <span class="pick-main"><b>${esc(name)}</b><small>${esc(x.path)}</small></span>${on ? icon("check", "pick-check") : ""}</button>`;
      }).join("")}</div>`
        : `<p class="empty small">${esc(t("new.noProjects"))}</p>`}
      ${step(3, "new.agent")}
      <div class="seg">${agents.map(a => seg("agent", a, a, a === pick.agent, agentIcon(a))).join("")}${seg("agent", "shell", t("new.shell"), pick.agent === "shell", icon("terminal"))}</div>
      ${pick.agent !== "shell" ? `${step(4, "new.prompt")}
        <textarea class="prompt" rows="3" data-i18n-placeholder="new.promptPh" aria-label="${esc(t("new.prompt"))}">${esc(prompt)}</textarea>` : ""}
      ${old.length ? `<h2 class="group">${esc(t("new.resumeTitle"))}</h2><div class="rows">${old.map(x => sessionRow(x, { showNode: false })).join("")}</div>` : ""}`;
    const ta = body.querySelector(".prompt");
    if (ta) { ta.placeholder = t("new.promptPh"); ta.oninput = () => { prompt = ta.value; }; }
  }

  async function start(e) {
    const b = e.currentTarget;
    b.disabled = true;
    const shell = pick.agent === "shell";
    const spec = shell ? { cwd: pick.project, kind: "shell" } : { cwd: pick.project, kind: prompt.trim() ? "prompt" : "new", agent: pick.agent, prompt: prompt.trim() || undefined };
    try {
      const tab = await store.launch(pick.node, spec);
      ctx.toast(t("new.started", { name: store.nodeName(pick.node) }));
      prompt = "";
      if (!shell && tab?.sessionId) ctx.go("session", { node: pick.node, agent: tab.agent, id: tab.sessionId });
      else if (tab?.id) ctx.go("terminal", { node: pick.node, term: tab.id, title: tab.title || baseName(pick.project) });
    } catch (err) { ctx.fail(err); b.disabled = false; }
  }

  body.onclick = e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.node) { pick.node = b.dataset.node; pick.project = ""; return draw(); }
    if (b.dataset.project) { pick.project = b.dataset.project; return draw(); }
    if (b.dataset.agent) { pick.agent = b.dataset.agent; return draw(); }
    if (b.classList.contains("row")) return ctx.go("session", { node: b.dataset.node, agent: b.dataset.agent, id: b.dataset.id });
  };

  draw();
  // Only what the choices depend on redraws (not every live tick, which would drop the keyboard).
  const sig = () => JSON.stringify(store.computers().map(n => [n.id, n.online, store.projects(n.id).length]));
  let last = sig();
  const off = store.on("change", () => { const s = sig(); if (s !== last) { last = s; draw(); } });
  return off;
}
