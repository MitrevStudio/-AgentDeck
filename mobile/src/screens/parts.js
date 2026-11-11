// Pieces several screens draw: the header with its tool strip, a session's status (a mark in a row, a chip in the
// session's header), agent and project labels, a session row, the relay link's note.
import { t, ago, errorText } from "../i18n.js";
import { esc, hue } from "../util.js";
import { icon, iconBtn, agentIcon } from "../icons.js";

// The top bar: an optional back button, the title (and a subtitle, HTML), the tools on the right (icon buttons, HTML).
export function header(title, { back = false, sub = "", actions = "" } = {}) {
  return `<header class="top">
    ${back ? iconBtn("back", t("common.back"), 'data-act="back"') : ""}
    <div class="top-title"><h1>${esc(title)}</h1>${sub ? `<small>${sub}</small>` : ""}</div>
    ${actions ? `<div class="top-actions">${actions}</div>` : ""}
  </header>`;
}
export function wireBack(el, ctx) {
  const b = el.querySelector("[data-act='back']");
  if (b) b.onclick = () => ctx.back();
}

// The one mark at a row's right end, as the desktop's sidebar has it: a red pulse (needs you), the orange spinner
// (working), a green dot (ready), a grey dot (stopped / offline).
export function statusMark(status) {
  const label = esc(t(`status.${status}`));
  if (status === "busy") return `<i class="mark spinner" role="img" aria-label="${label}" title="${label}"></i>`;
  return `<i class="mark dot st-${esc(status)}" role="img" aria-label="${label}" title="${label}"></i>`;
}
// The status with its word, for the session's header (the desktop's .live chip).
export function statusChip(item) {
  const s = item.status;
  return `<span class="live st-${esc(s)}">${s === "busy" ? '<i class="spinner"></i>' : `<i class="dot st-${esc(s)}"></i>`}${esc(t(`status.${s}`))}</span>`;
}
// The agent: its glyph in its colour, then its name.
export const agentTag = agent => `<span class="agent">${agentIcon(agent)}${esc(agent)}</span>`;
export const projectTag = name => `<span class="proj" style="--h:${hue(name)}">${esc(name)}</span>`;
export const nodeTag = (name, online = true) => `<span class="node-tag${online ? "" : " off"}">${esc(name)}</span>`;
// A project's mark, as the desktop's sidebar draws it: two letters on a tile in the project's hue.
const initials = name => {
  const words = String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || String(name)).slice(0, 2)).toUpperCase();
};
export const projectMark = name => `<span class="pmono" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
// "computer · project · agent" on one line. In a list row the agent is its glyph, first (as the desktop's sidebar
// has it), so a narrow screen cuts the project rather than the agent.
export const metaLine = (x, { showNode = true, glyph = false } = {}) => {
  const parts = [showNode ? nodeTag(x.nodeName, x.online) : "", projectTag(x.project), glyph ? "" : agentTag(x.agent)].filter(Boolean).join('<i class="sep">·</i>');
  return glyph ? `<span class="agent-mark" role="img" aria-label="${esc(x.agent)}" title="${esc(x.agent)}">${agentIcon(x.agent)}</span>${parts}` : parts;
};

// The relay link as a whole, when it is not fine: "No connection to the relay" (and why) with a Try now button at
// the end, "Connecting…", or - nothing left to dial (everything forgotten, or the relay dropped the phone) - "No
// relay" with Scan and Add at the end (add: false where the screen has them already). wireConn(el, store, ctx)
// hooks the buttons.
export function connNote(store, { add = true } = {}) {
  const c = store.connection();
  if (!store.demo && (c.state === "nohub" || c.state === "none")) {
    return `<div class="note warn" role="status">${icon("wifi")}<div class="note-text"><b>${esc(t("conn.noRelay"))}</b>
      <small>${esc(t("conn.noRelayWhy"))}</small></div>
      ${add ? iconBtn("scan", t("computers.scan"), 'data-act="conn-scan"') + iconBtn("plus", t("computers.add"), 'data-act="conn-add"') : ""}</div>`;
  }
  if (c.state === "down") {
    return `<div class="note down" role="status">${icon("wifi")}<div class="note-text"><b>${esc(t("conn.down", { name: c.name || "" }))}</b>
      <small>${esc(t("conn.downWhy", { reason: errorText(c.error) }))}</small></div>
      ${iconBtn("refresh", t("conn.retry"), 'data-act="reconnect"')}</div>`;
  }
  if (c.state === "connecting") return `<div class="note" role="status"><i class="spinner accent"></i><div class="note-text">${esc(t("conn.connecting", { name: c.name || "" }))}</div></div>`;
  return "";
}
export function wireConn(el, store, ctx) {
  const on = (act, fn) => { const b = el.querySelector(`[data-act='${act}']`); if (b) b.onclick = fn; };
  on("reconnect", () => store.wake());
  on("conn-scan", () => ctx?.go("scan"));
  on("conn-add", () => ctx?.go("pair", { add: true }));
}

// A terminal in a list (the inbox's Terminals, a computer's screen): its title, then computer · folder · who opened
// it, "ended" / "lost" at the end; the row opens it (an agent's terminal: its session), the X at the end closes it.
// wireTerminals(el, ctx) handles both.
export function terminalRow(x, { showNode = true } = {}) {
  const by = x.owner === "phone" ? t("terms.byPhone") : x.owner === "here" ? t("terms.byHere") : x.ownerName ? t("terms.byPeer", { name: x.ownerName }) : t("terms.byOther");
  const ended = x.exited ? "exited" : x.lost ? "lost" : "";
  const glyph = x.agent ? agentIcon(x.agent) || icon("terminal") : icon("terminal");
  const meta = [showNode ? nodeTag(x.nodeName) : "", projectTag(x.project), `<span>${esc(by)}</span>`].filter(Boolean).join('<i class="sep">·</i>');
  return `<div class="trow${ended ? " ended" : ""}">
    <button class="trow-open" data-node="${esc(x.node)}" data-term="${esc(x.id)}" data-title="${esc(x.title)}"${x.item ? ` data-agent="${esc(x.item.agent)}" data-sid="${esc(x.item.id)}"` : ""}>
      <span class="row-main">
        <span class="row-title">${esc(x.title)}</span>
        <span class="row-meta"><span class="agent-mark" role="img" aria-label="${esc(x.agent || t("new.shell"))}" title="${esc(x.agent || t("new.shell"))}">${glyph}</span>${meta}</span>
      </span>
      ${ended ? `<span class="row-end"><span class="tag">${esc(t(`terms.${ended}`))}</span></span>` : ""}
    </button>
    ${iconBtn("x", t("terms.close", { title: x.title }), `data-close-term="${esc(x.id)}" data-node="${esc(x.node)}" data-ended="${ended ? 1 : ""}"`, "danger")}
  </div>`;
}
export function wireTerminals(el, ctx) {
  el.addEventListener("click", async e => {
    const close = e.target.closest("[data-close-term]");
    if (close) {
      e.stopPropagation();
      const { node, closeTerm: id } = close.dataset;
      const title = close.closest(".trow")?.querySelector(".trow-open")?.dataset.title || "";
      const name = ctx.store.nodeName(node);
      const ask = close.dataset.ended ? t("terms.removeAsk", { title, name }) : t("term.closeAsk", { name });
      if (!await ctx.confirm(ask, t("term.close"), { danger: true })) return;
      try { await ctx.store.closeTerminal(node, id); ctx.toast(t("terms.closed")); } catch (err) { ctx.fail(err); }
      return;
    }
    const open = e.target.closest(".trow-open");
    if (!open) return;
    e.stopPropagation();
    const d = open.dataset;
    if (d.sid) ctx.go("session", { node: d.node, agent: d.agent, id: d.sid });
    else ctx.go("terminal", { node: d.node, term: d.term, title: d.title });
  });
}

// A session in a list (inbox, new session's resume list): the title, what it waits for, computer · project · agent;
// at the end the time and its status mark.
export function sessionRow(x, { showNode = true } = {}) {
  return `<button class="row st-${esc(x.status)}" data-node="${esc(x.node)}" data-agent="${esc(x.agent)}" data-id="${esc(x.id)}">
    <span class="row-main">
      <span class="row-title">${esc(x.title)}</span>
      ${x.status === "waiting" ? `<span class="row-reason">${esc(x.waitingFor || t("status.reasonUnknown"))}</span>` : ""}
      <span class="row-meta">${metaLine(x, { showNode, glyph: true })}</span>
    </span>
    <span class="row-end"><time>${esc(ago(x.updatedAt))}</time>${x.status !== "stopped" ? statusMark(x.status) : ""}</span>
  </button>`;
}
