// Session preview (session-preview.js in main): a session's last prompts and replies and a few facts about it -
// beside the edge menu's session list, and as a hover card over the manager's session cards. Classic script for both
// pages, loaded after common.js and usage-ui.js (tokens and cost come from there when they are known).
const previews = new Map();          // sessionKey -> main's last answer (null: nothing to read)
let previewScroll = { key: "", top: 0, end: true };

// ---------- markup ----------
// Escaped; ``` fences become code blocks, `inline code` and **bold** keep their look. A code span closes with as many
// backticks as it opened with, so ``Alt+` `` holds a backtick (one space inside each end is padding, as in Markdown).
const previewInline = s => esc(s)
  .replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n][^\n]*?)(?<!`)\1(?!`)/g, (_, _ticks, code) => `<code>${/^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code}</code>`)
  .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
function previewText(text) {
  return String(text).replace(/\n{3,}/g, "\n\n").split(/```[^\n]*\n?/)
    .map((part, i) => (i % 2 ? `<pre class="pv-code">${esc(part.replace(/\n$/, ""))}</pre>` : previewInline(part.replace(/^\n+|\n+$/g, ""))))
    .join("");
}
function previewMessage(s, m) {
  const who = m.role === "user" ? t("preview.you") : s.agent;
  return `<div class="pv-msg ${m.role === "user" ? "user" : `assistant ${s.agent.toLowerCase()}`}">
    <div class="pv-who"><span class="pv-role">${esc(who)}</span>${m.at ? `<span class="pv-at" title="${esc(fullDate(m.at))}">${esc(ago(m.at))}</span>` : ""}</div>
    <div class="pv-text">${previewText(m.text)}${m.cut ? "…" : ""}</div></div>`;
}
function previewFacts(s, d) {
  const a = typeof usageOf === "function" ? usageOf(s) : null;
  const facts = [
    d.model && `<span class="pv-model">${esc(d.model)}</span>`,
    d.prompts != null && esc(tn("preview.prompts", d.prompts)),
    d.replies != null && esc(tn("preview.replies", d.replies)),
    d.subagents && esc(tn("preview.subagents", d.subagents)),
    // the cost alone (the tokens when no price is known), as beside the session; the breakdown is its tooltip
    a && `<span class="pv-usage" title="${esc(usageTitle(a))}">${esc(a.cost == null ? tokensText(a.tokens) : fmtUsd(a.cost))}</span>`
  ].filter(Boolean);
  const times = [d.startedAt && t("preview.started", { time: ago(d.startedAt) }), d.lastAt && t("preview.last", { time: ago(d.lastAt) })].filter(Boolean);
  return `<div class="pv-facts">${facts.join('<span class="pv-sep">·</span>')}</div>
    ${times.length ? `<div class="pv-times" title="${esc([d.startedAt && fullDate(d.startedAt), d.lastAt && fullDate(d.lastAt)].filter(Boolean).join(" – "))}">${esc(times.join(" · "))}</div>` : ""}`;
}
// ---------- resume or continue fresh ----------
// Resume re-reads the whole conversation on the first prompt; a fresh session starts with a short handoff (the task
// and where it ended) already loaded by Claude, without a pointer to the old transcript, so the old context stays out.
const HANDOFF_PART_CHARS = 600;
function getHandoffPart(text) {
  const plain = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return plain.length > HANDOFF_PART_CHARS ? `${plain.slice(0, HANDOFF_PART_CHARS).trimEnd()}…` : plain;
}
// The first prompt comes apart only when it is not among the last messages (session-preview.js); otherwise it opens them.
function getFirstPrompt(d) {
  const first = d?.messages?.[0];
  return d?.firstPrompt || (!d?.more && first?.role === "user" ? first.text : "");
}
function getHandoff(s, d) {
  const answers = (d?.messages || []).filter(m => m.role !== "user");
  return t("preview.handoff", {
    title: s.title,
    task: getHandoffPart(getFirstPrompt(d)) || t("preview.handoff.unknown"),
    outcome: getHandoffPart(answers[answers.length - 1]?.text) || t("preview.handoff.unknown")
  });
}
function getSessionContext(s) {
  return typeof contextBySession !== "undefined" ? contextBySession.get(sessionKey(s)) || null : null;
}
// Continue fresh pays off only when resuming would carry on a nearly full context (the red context chip, usage-ui.js
// FULL_CONTEXT). It starts Claude Code (--append-system-prompt-file), so only Claude sessions get it.
function isFreshOffered(s, c) {
  return s.agent === "Claude" && Boolean(c) && getContextState(c) === "large";
}
// Why Continue fresh is left out for a session.
function getFreshMissingReason(s, c) {
  if (s.agent !== "Claude") {
    return t("preview.fresh.none.agent");
  }
  if (!c || c.status === "pending" || c.tokens == null) {
    return t("preview.fresh.none.empty");
  }
  const n = I18N.formatNumber(c.tokens);
  if (getContextFill(c) == null) {
    return t("preview.fresh.none.unknown", { n });
  }
  return t("preview.fresh.none.small", { n, pct: getFillText(c), limit: `${Math.round(FULL_CONTEXT * 100)}%` });
}
// Resume and Continue fresh on a past session's card (renderer.js): the cheaper one is blue, and Resume's tooltip says
// why Continue fresh is missing.
function getSessionActions(s) {
  const c = getSessionContext(s);
  const fresh = Boolean(s.cwd) && isFreshOffered(s, c);
  const resumeTip = [t("preview.resume.cost"), fresh ? "" : getFreshMissingReason(s, c)].filter(Boolean).join("\n\n");
  return `${fresh ? getActionButton("fresh", "plus", true, t("preview.fresh.cost"), "") : ""}
      ${getActionButton("resume", "play", !fresh, resumeTip, s.cwd ? "" : "disabled")}`;
}
function getActionButton(action, iconName, recommended, tip, attrs) {
  const name = `${t(`preview.${action}`)}${recommended ? ` ${t("preview.recommended")}` : ""}:`;
  return `<button class="btn sm ${recommended ? "primary" : ""}" data-action="${action}" data-tip-name="${esc(name)}" data-tip="${esc(tip)}"
      aria-description="${esc(`${name} ${tip}`)}" ${attrs}>${icon(iconName)}${esc(t(`preview.${action}`))}</button>`;
}
async function continueFresh(s) {
  const d = await window.manager.getPreview(s.agent, s.id).catch(() => null);
  await window.manager.launchFresh(s.cwd, getHandoff(s, d));
}

// d: main's answer; undefined while it is on its way (a skeleton), null when the session cannot be read.
function previewHtml(s, d) {
  const title = `<div class="pv-title">${agentMark(s.agent)}<span class="t" title="${esc(s.title)}">${esc(s.title)}</span></div>`;
  const body = html => `<div class="pv-scroll"><div class="pv-list">${html}</div></div>`;
  if (d === undefined) {
    return `${title}<div class="pv-head"><div class="pv-skel" style="width: 62%"></div></div>
      <div class="pv-scroll" aria-busy="true"><div class="pv-list"><div class="pv-skel"></div><div class="pv-skel" style="width: 80%"></div><div class="pv-skel" style="width: 45%"></div></div></div>`;
  }
  if (!d) return title + body(`<div class="pv-empty">${esc(t("preview.unavailable"))}</div>`);
  const first = d.firstPrompt
    ? `<div class="pv-first"><div class="pv-label">${esc(t("preview.firstPrompt"))}</div><div class="pv-text">${previewText(d.firstPrompt)}${d.firstCut ? "…" : ""}</div></div>`
    : "";
  const gap = d.more ? `<div class="pv-gap"><span>${esc(t("preview.earlier"))}</span></div>` : "";
  const msgs = d.messages.length ? d.messages.map(m => previewMessage(s, m)).join("") : `<div class="pv-empty">${esc(t("preview.noMessages"))}</div>`;
  return `${title}<div class="pv-head">${previewFacts(s, d)}</div>${body(first + gap + msgs)}`;
}

// ---------- filling ----------
// Nothing here waits for a layout, so filling the pane adds no time to a tile switch in the edge menu.
function fillPreview(box, s, d) {
  const key = sessionKey(s);
  box.innerHTML = previewHtml(s, d);
  const scroll = box.querySelector(".pv-scroll");
  // The scroll area is anchored at its bottom (column-reverse, scrollTop 0 = the end): the newest message is in view
  // by itself. Only a place the user scrolled back to in this same preview is restored.
  if (previewScroll.key === key && previewScroll.top < -4) scroll.scrollTop = previewScroll.top;
  else previewScroll = { key, top: 0 };
  scroll.addEventListener("scroll", () => { previewScroll = { key, top: scroll.scrollTop }; }, { passive: true });
  // Long messages are clipped with a fade (a click shows the rest), told apart in the next frame.
  requestAnimationFrame(() => {
    if (!scroll.isConnected) return;
    const clipped = [...scroll.querySelectorAll(".pv-text")].filter(el => el.scrollHeight > el.clientHeight + 1);
    for (const el of clipped) { el.classList.add("clipped"); el.title = t("preview.expand"); }
  });
}
// Shows s's preview in box: at once from the last answer when there is one (then brought up to date), otherwise as a
// skeleton for the few milliseconds the answer takes. s null empties the box.
function showPreview(box, s) {
  if (!box) return;
  const key = s ? sessionKey(s) : "";
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    if (!s) { box.innerHTML = ""; return; }
    setPreview(box, s, previews.get(key));
  }
  if (!s) return;
  window.manager.getPreview(s.agent, s.id).then(d => d ?? null, () => null).then(d => {
    previews.set(key, d);
    if (box.isConnected && box.dataset.key === key && JSON.stringify(d) !== JSON.stringify(box.pvData)) setPreview(box, s, d);
  });
}
function setPreview(box, s, d) {
  box.pvData = d;
  box.pvSession = s;
  fillPreview(box, s, d);
}
// A click on a clipped message opens it in full.
document.addEventListener("click", e => {
  const el = e.target.closest?.(".pv-text.clipped");
  if (el) { el.classList.toggle("open"); el.title = el.classList.contains("open") ? "" : t("preview.expand"); }
});

