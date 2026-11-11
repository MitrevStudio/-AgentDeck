// The inbox: every computer's sessions in one list - "Waiting for you" on top with what they wait for, then the
// running ones, then the terminals that are not a running session's (a shell pane on a desktop, a shell this phone
// opened and left running), then the recent sessions - with the computer and project on each, and a search.
import { t, errorText } from "../i18n.js";
import { esc } from "../util.js";
import { icon } from "../icons.js";
import { header, sessionRow, terminalRow, connNote, wireConn, wireTerminals } from "./parts.js";

let lastQuery = ""; // kept while the app runs, as a list's filter usually is

export function render(el, ctx) {
  const store = ctx.store;
  el.innerHTML = `${header(t("inbox.title"), { actions: store.demo ? `<span class="tag accent">${esc(t("inbox.demo"))}</span>` : "" })}
    <div class="searchbar">${icon("search")}<input type="search" enterkeyhint="search" data-i18n-placeholder="inbox.searchPh" value="${esc(lastQuery)}" aria-label="${esc(t("common.search"))}"></div>
    <main class="body inbox"></main>`;
  const list = el.querySelector(".inbox");
  const input = el.querySelector("input");

  function draw() {
    const g = store.inbox({ query: lastQuery });
    const terms = store.terminals({ query: lastQuery, running: true, loose: true });
    const conn = store.connection();
    // Computers that are offline while the relay is there, and those that cannot come back by themselves (with no
    // relay at all, the note above says it all; their names are still listed here).
    const offline = conn.state === "ok" || conn.state === "nohub" ? store.computers().filter(n => !n.online) : [];
    const head = (name, n) => `<h2 class="group g-${name}">${esc(t(`inbox.${name}`))}<span class="count">${n}</span></h2>`;
    const group = (name, items) => (items.length ? `${head(name, items.length)}<div class="rows">${items.map(x => sessionRow(x)).join("")}</div>` : "");
    // Nothing to list: said, unless the note says why already (nothing left to dial).
    const empty = !g.waiting.length && !g.working.length && !g.recent.length && !terms.length && (store.demo || !["nohub", "none"].includes(conn.state));
    list.innerHTML = `${connNote(store)}${group("waiting", g.waiting)}${group("working", g.working)}
      ${terms.length ? `${head("terminals", terms.length)}<div class="rows">${terms.map(x => terminalRow(x)).join("")}</div>` : ""}
      ${group("recent", g.recent)}
      ${empty ? `<p class="empty">${esc(lastQuery ? t("inbox.noMatch", { q: lastQuery }) : store.loading() || conn.state === "connecting" ? t("session.loading") : t("inbox.empty"))}</p>` : ""}
      ${offline.map(n => `<p class="offline-note">${icon("computer")}<span>${esc(t("inbox.offline", { name: n.name }))}${n.error ? ` · ${esc(errorText(n.error))}` : ""}</span></p>`).join("")}`;
    wireConn(list, store, ctx);
  }
  list.onclick = e => {
    const row = e.target.closest(".row");
    if (row) ctx.go("session", { node: row.dataset.node, agent: row.dataset.agent, id: row.dataset.id });
  };
  wireTerminals(list, ctx);
  input.oninput = () => { lastQuery = input.value; draw(); };
  draw();
  // The relative times move on even when nothing changes.
  const timer = setInterval(draw, 30000);
  const off = store.on("change", draw);
  return () => { off(); clearInterval(timer); };
}
