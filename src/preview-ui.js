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
// d: main's answer; undefined while it is on its way (a skeleton), null when the session cannot be read.
function previewHtml(s, d) {
  const title = `<div class="pv-title"><span class="adot ${s.agent.toLowerCase()}"></span><span class="t" title="${esc(s.title)}">${esc(s.title)}</span></div>`;
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
function setPreview(box, s, d) { box.pvData = d; fillPreview(box, s, d); }
// A click on a clipped message opens it in full.
document.addEventListener("click", e => {
  const el = e.target.closest?.(".pv-text.clipped");
  if (el) { el.classList.toggle("open"); el.title = el.classList.contains("open") ? "" : t("preview.expand"); }
});

// ---------- manager: hover card ----------
// A card beside the session the pointer rests on (after a short pause), over the projects column so that the
// session's own buttons stay free. It stays while the pointer is on it, and goes on scrolling, Esc, losing the focus
// or once the pointer has left both. sessionOf(cardElement) -> session.
const PREVIEW_HOVER_MS = 250, PREVIEW_LEAVE_MS = 300;
function previewHoverCard(list, sessionOf) {
  const card = document.createElement("aside");
  card.className = "pv pv-card";
  card.hidden = true;
  card.setAttribute("aria-label", t("preview.title"));
  document.body.append(card);
  let over = null, shownFor = null, showTimer = 0, hideTimer = 0;
  // Pointing at a session again (any part of it) brings the card back.
  const hide = () => { clearTimeout(showTimer); clearTimeout(hideTimer); card.hidden = true; shownFor = over = null; };
  const hideSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, PREVIEW_LEAVE_MS); };
  function open(el) {
    const s = el.isConnected && sessionOf(el);
    if (!s) return;
    shownFor = el;
    card.hidden = false;
    // Beside the panel the list is in, level with the session, kept inside the window.
    const panel = list.closest(".panel")?.getBoundingClientRect() ?? list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const width = Math.min(440, Math.max(320, panel.left - 24));
    const height = Math.min(460, innerHeight - 24);
    card.style.width = `${width}px`;
    card.style.maxHeight = `${height}px`;
    card.style.left = `${Math.max(12, panel.left - width - 10)}px`;
    card.style.top = `${Math.max(12, Math.min(r.top, innerHeight - height - 12))}px`;
    showPreview(card, s);
  }
  list.addEventListener("mouseover", e => {
    const el = e.target.closest(".sess");
    if (el === over) return;
    over = el;
    clearTimeout(showTimer);
    if (!el) return hideSoon();
    clearTimeout(hideTimer);
    if (el !== shownFor) showTimer = setTimeout(() => open(el), PREVIEW_HOVER_MS);
  });
  list.addEventListener("mouseleave", () => { over = null; clearTimeout(showTimer); hideSoon(); });
  list.addEventListener("scroll", hide, { passive: true });
  card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  card.addEventListener("mouseleave", hideSoon);
  window.addEventListener("blur", hide);
  document.addEventListener("keydown", e => { if (e.key === "Escape") hide(); });
  return { hide };
}
