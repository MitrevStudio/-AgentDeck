// A session: its last messages (sessions.preview), what it waits for, a reply box and a row of quick keys for
// the terminal it runs in, Stop, and the way to its terminal (or a shell in its folder). A session not in an
// AgentDeck terminal can only be watched and stopped; one not running can be resumed. While its computer is away
// nothing can be done to it: the tools go, the status says "unreachable", the messages loaded before stay.
// params: node, agent, id; title - what to call it until the computer lists it (a session just started); from -
// "terminal" when the session's terminal opened it (its chat view). A session that runs in an AgentDeck terminal is
// opened in that terminal from the lists (parts.js openSession); this screen is its messages, and what a session
// with no terminal has.
//
// A reply being typed is kept per session (also across a lost link, leaving the screen, a restart of the app) until
// it was sent. While the agent works the host refuses it (agentNotReady): it stays, and can be typed into the
// terminal instead.
import { t, tn, formatTime, ago, errorText } from "../i18n.js";
import { esc, KEYS, buzz } from "../util.js";
import { icon, iconBtn } from "../icons.js";
import { header, wireBack, statusChip, metaLine, connNote, wireConn } from "./parts.js";
import { keyStrip, wireStrip } from "./keys.js";
import { getDraft, setDraft } from "../drafts.js";
import { renderMarkdown } from "../markdown.js";

// [label or icon, what it sends]; a key with an icon is named by its aria label (keys.js).
const QUICK = [
  ["1", "1"], ["2", "2"], ["3", "3"], ["enter", KEYS.enter], ["Esc", KEYS.esc], ["Ctrl+C", KEYS.ctrlC],
  ["up", KEYS.up], ["down", KEYS.down], ["left", KEYS.left], ["right", KEYS.right], ["tab", KEYS.tab], ["shiftTab", KEYS.shiftTab]
];

// A message is markdown, as the agents write it (markdown.js: nothing of the source gets through as HTML).
// A message the host sent cut: under OLD_CUT characters it is a host from before whole answers (it cuts at 1500) -
// the note says to update it; else the message is longer than any host sends.
const OLD_CUT = 2000;
// While a session works its preview changes every few seconds: it is asked for again at most this often.
const RELOAD_MS = 4000;


export function render(el, ctx, p) {
  const store = ctx.store;
  const draftKey = `${p.node}:${p.agent}:${p.id}`;
  let item = store.item(p.node, p.agent, p.id);
  let preview = null, previewAt = -1, loading = false, loadedAt = 0, reloadTimer = 0;

  el.innerHTML = `<div class="sess-head"></div><main class="body session"><div class="conn"></div><div class="msgs"></div></main><div class="dock"></div>`;
  const head = el.querySelector(".sess-head"), msgs = el.querySelector(".msgs"), dock = el.querySelector(".dock"), body = el.querySelector(".body"), conn = el.querySelector(".conn");

  // The tools: a shell in the session's folder, its terminal, and Stop (Resume once it is not running) - Stop where
  // the host can stop it (store.stopKind: its terminal, or a Claude session), Resume where it can be started again.
  function drawHead() {
    const x = item;
    const canStop = x?.online && (x.term || (x.status !== "stopped" && store.stopKind(p.node, p.agent, p.id)));
    const canResume = x && !x.term && x.online && x.status === "stopped";
    const actions = [
      x?.online && x.cwd ? iconBtn("termPlus", t("session.shell"), 'data-act="shell"') : "",
      x?.online && x.term ? iconBtn("terminal", t("session.terminal"), 'data-act="term"') : "",
      canStop ? iconBtn("stop", t("session.stop"), 'data-act="stop"', "danger") : "",
      canResume ? iconBtn("play", t("session.resume"), 'data-act="resume"', "accent") : ""
    ].join("");
    head.innerHTML = header(x?.title || p.title || t("session.starting"), { back: true, sub: x ? metaLine(x) : "", actions })
      + (x ? `<div class="status-line">${statusChip(x)}
      ${x.status === "waiting" ? `<span class="reason">${esc(x.waitingFor || t("status.reasonUnknown"))}</span>` : `<span class="when">${esc(ago(x.updatedAt))}</span>`}</div>` : "");
    wireBack(head, ctx);
    const on = (act, fn) => { const b = head.querySelector(`[data-act='${act}']`); if (b) b.onclick = fn; };
    // Opened from its terminal (the chat view of a running session): the terminal is one step back.
    on("term", () => (p.from === "terminal" ? ctx.back() : ctx.go("terminal", { node: x.node, term: x.term, title: x.title })));
    on("shell", openShell);
    on("stop", stop);
    on("resume", resume);
    conn.innerHTML = connNote(store);
    wireConn(conn, store, ctx);
  }

  const cutNote = (text, cut) => (cut ? `<p class="msg-cut">${esc(t(text.length < OLD_CUT ? "session.cutOld" : "session.cutLong", { name: item?.nodeName || "" }))}</p>` : "");
  // The view follows the newest message only while it is at the end (or on the first draw): someone reading further
  // up is left there when the session moves on.
  let drawn = false;
  function drawMsgs() {
    if (!preview) {
      const missing = item?.online && store.missing(p.node, "sessions.preview");
      const why = !item ? t("session.loading") : !item.online ? t("session.offline") : missing ? t("session.noPreview", { name: item.nodeName }) : loading ? t("session.loading") : t("session.noMessages");
      msgs.innerHTML = `<p class="empty">${esc(why)}</p>`;
      return;
    }
    const atEnd = !drawn || body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    drawn = true;
    const meta = [preview.model ? t("session.model", { model: preview.model }) : "", preview.prompts != null ? `${tn("session.prompts", preview.prompts)} · ${tn("session.replies", preview.replies ?? 0)}` : ""].filter(Boolean).join(" · ");
    msgs.innerHTML = `${preview.more ? `<p class="more muted small">${esc(t("session.more"))}</p>` : ""}
      ${preview.firstPrompt ? `<div class="msg first"><div class="who">${esc(t("session.firstPrompt"))}</div><div class="text md">${renderMarkdown(preview.firstPrompt)}</div>${cutNote(preview.firstPrompt, preview.firstCut)}</div>` : ""}
      ${preview.messages.map(m => `<div class="msg ${m.role}">
        <div class="who">${esc(m.role === "user" ? t("common.you") : preview.agent)}<time>${m.at ? esc(formatTime(m.at)) : ""}</time></div>
        <div class="text md">${renderMarkdown(m.text)}</div>${cutNote(m.text, m.cut)}</div>`).join("")}
      ${preview.messages.length ? "" : `<p class="empty">${esc(t("session.noMessages"))}</p>`}
      ${meta ? `<p class="muted small center">${esc(meta)}</p>` : ""}`;
    if (atEnd) body.scrollTop = body.scrollHeight;
  }

  async function loadPreview() {
    if (!item?.online) { drawMsgs(); return; }
    loading = true;
    loadedAt = Date.now();
    if (!preview) drawMsgs();
    try {
      previewAt = item.updatedAt;
      preview = await store.preview(p.node, p.agent, p.id);
    } catch (e) {
      // An older host has no previews: said in the list, not as an error.
      if (e?.code === "unknownMethod") store.node(p.node)?.missing.add("sessions.preview");
      else if (e?.code !== "offline") ctx.fail(e);
    }
    loading = false;
    drawMsgs();
  }

  // The dock: the reply box while the session has a terminal (kept as it is across redraws - the text being typed,
  // the keyboard); while the computer is away the box stays, Send waits.
  function drawDock() {
    const x = item;
    if (!x) { dock.innerHTML = ""; return; }
    if (x.term) {
      if (!dock.querySelector(".reply")) buildReply();
      const note = dock.querySelector(".dock-note.kept");
      note.hidden = x.online;
      dock.querySelector(".send").disabled = !x.online;
      dock.querySelector(".keys").hidden = !x.online;
      return;
    }
    // Not in an AgentDeck terminal: why there is no reply box (Stop and Resume are in the header).
    const note = !x.online ? "session.offline" : x.status === "stopped" ? "session.notRunning"
      : store.stopKind(p.node, p.agent, p.id) ? "session.noTerm" : "session.noTermWatch";
    dock.innerHTML = `<p class="dock-note">${icon(x.online ? "terminal" : "computer")}<span>${esc(t(note))}</span></p>`;
  }

  function buildReply() {
    dock.innerHTML = `<p class="dock-note kept" hidden>${icon("wifi")}<span>${esc(t("session.kept"))}</span></p>
      ${keyStrip(QUICK, "keys")}
      <form class="reply"><textarea rows="1" enterkeyhint="send" aria-label="${esc(t("session.replyPh"))}"></textarea>
      ${iconBtn("send", t("session.send"), 'type="submit"', "send")}</form>`;
    const ta = dock.querySelector("textarea");
    ta.placeholder = t("session.replyPh");
    ta.value = getDraft(draftKey);
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; };
    ta.oninput = () => { setDraft(draftKey, ta.value); grow(); };
    requestAnimationFrame(grow);
    // The keyboard's Send key (enterkeyhint) sends; Shift+Enter (hardware keyboard) is a new line.
    ta.onkeydown = e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); dock.querySelector("form").requestSubmit(); }
    };
    // A key goes straight to the terminal; the phone answers with a short buzz, since nothing else shows it went.
    dock.querySelector(".keys").onclick = e => {
      const b = e.target.closest("[data-k]");
      if (!b || !item?.term) return;
      store.keys(p.node, item.term, QUICK[b.dataset.k][1]);
      buzz(8);
    };
    wireStrip(dock.querySelector(".keys"));
    // Keys keep the reply box's focus (and the keyboard up).
    dock.querySelector(".keys").onpointerdown = e => e.preventDefault();
    const sent = () => { ta.value = ""; setDraft(draftKey, ""); grow(); };
    dock.querySelector("form").onsubmit = async e => {
      e.preventDefault();
      const text = ta.value;
      if (!text.trim() || !item?.term || !item.online) return;
      const term = item.term;
      try {
        await store.send(p.node, term, text);
        sent();
        ctx.toast(t("session.sent"));
      } catch (err) {
        // Busy (or a host without terminals.send): the text stays; typing it into the terminal is offered.
        if (err?.code === "agentNotReady" || err?.code === "unknownMethod") {
          const typeIt = await ctx.confirm(err.code === "agentNotReady" ? t("session.busy") : errorText(err), t("session.typeAnyway"));
          if (typeIt === true && item?.online) {
            store.typeInto(p.node, term, text);
            sent();
            ctx.toast(t("session.typed"));
          }
        } else ctx.fail(err);
      }
    };
  }

  async function stop() {
    const kind = store.stopKind(p.node, p.agent, p.id);
    const ask = kind === "terminal" ? t("session.stopAskTerm", { title: item.title, name: item.nodeName }) : t("session.stopAsk", { title: item.title });
    if (!await ctx.confirm(ask, t("session.stop"), { danger: true })) return;
    try { await store.stop(p.node, p.agent, p.id); ctx.toast(t("session.stopped")); } catch (e) { ctx.fail(e); }
  }
  async function resume() {
    try {
      const tab = await store.launch(p.node, { cwd: item.cwd, kind: "resume", agent: p.agent, sessionId: p.id });
      // Already running in a terminal there (opened elsewhere meanwhile): that terminal is opened, nothing new ran.
      ctx.toast(t(tab?.already ? "session.alreadyRunning" : "session.resumed", { name: item.nodeName }));
      if (tab?.id) ctx.go("terminal", { node: p.node, term: tab.id, title: item.title });
    } catch (e) { ctx.fail(e); }
  }
  // A shell on that computer, in the session's folder.
  async function openShell() {
    try {
      const tab = await store.launch(p.node, { cwd: item.cwd, kind: "shell" });
      if (tab?.id) ctx.go("terminal", { node: p.node, term: tab.id, title: tab.title || item.project });
    } catch (e) { ctx.fail(e); }
  }

  const sig = x => (x ? `${x.status}|${x.term}|${x.online}|${x.waitingFor}|${x.title}|${store.connection().state}` : "");
  let lastSig = sig(item);
  const off = store.on("change", () => {
    const next = store.item(p.node, p.agent, p.id) || item;
    const changedState = sig(next) !== lastSig;
    const cameBack = next?.online && !item?.online;
    item = next;
    lastSig = sig(item);
    if (changedState) { drawHead(); drawDock(); }
    if (!item || (item.updatedAt === previewAt && !cameBack)) return;
    // Whole answers travel now: not more often than every RELOAD_MS, the last change always.
    const wait = cameBack ? 0 : loadedAt + RELOAD_MS - Date.now();
    clearTimeout(reloadTimer);
    if (wait <= 0) loadPreview(); else reloadTimer = setTimeout(loadPreview, wait);
  });
  drawHead();
  drawDock();
  loadPreview();
  return () => { off(); clearTimeout(reloadTimer); };
}
