// "Meetings" in the top bar: the count of the active project's folder, the menu, and main's events handed to the
// pieces. Nothing polls: the folder is read again when the project changes, the window gets the focus, the menu opens
// and something of a meeting happens. Uses renderer.js's menu, data and layout.
(() => {
  const { live, key, call, setState, errorText, report, date, length, bytes } = meetingsShared;
  const COUNT_AFTER_MS = 150;
  const button = $("meetingsBtn");
  if (!window.meetings) return; // a page without the bridge has no meetings
  let shown = null; // { key, path, name, place, count } of the project the button stands for
  let turn = 0, countTimer = 0;
  let menu = null;  // { el, project, meetings, sizes, error }

  // ---------- whose meetings ----------
  // The active pane's project, else the selected one; never another computer's.
  function activeProject() {
    const local = built.projects.filter(p => !p.node), term = getTerminal(getShownTab()?.focus);
    if (term?.node) return null;
    if (term) {
      if (term.id === getCentreTerm()?.id) return null;
      const owner = ownerProject(local, normPath(term.cwd));
      if (owner) return owner;
    }
    return local.find(p => p.n === ws.activeSpace) || null;
  }
  function drawButton() {
    button.hidden = !shown;
    if (!shown) return;
    const known = Number.isFinite(shown.count);
    const badge = button.querySelector(".count");
    badge.hidden = !known;
    badge.textContent = known ? I18N.formatNumber(shown.count) : "";
    const label = known ? tn("meetings.button.title", shown.count, { name: shown.name }) : t("meetings.button.plain", { name: shown.name });
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  async function readCount() {
    if (!shown) return;
    const project = shown, mine = ++turn;
    try {
      const { place, count } = await call("count", project.path);
      if (mine !== turn || project !== shown) return;
      Object.assign(project, { place, count });
    } catch {
      if (mine !== turn || project !== shown) return;
      project.count = null; // the menu says why
    }
    drawButton();
  }
  function countSoon() {
    clearTimeout(countTimer);
    countTimer = setTimeout(readCount, COUNT_AFTER_MS);
  }
  function sync() {
    const project = activeProject();
    if (project?.n === shown?.key) {
      if (shown && shown.name !== project.name) {
        shown.name = project.name;
        drawButton();
      }
      return;
    }
    const focused = document.activeElement === button;
    shown = project && { key: project.n, path: project.path, name: project.name, place: "", count: null };
    drawButton();
    if (focused && !shown) button.blur();
    readCount();
  }

  // ---------- the menu ----------
  const openMeeting = (project, id) => () => meetingsView.open(project, id);

  async function discardLeft(left) {
    // While its meeting is there, this sound is the only one it has.
    const body = t(left.code ? "meetings.left.removeBody" : "meetings.left.removeBodyNoSound", { name: left.name });
    const sure = await confirmDialog({ title: t("meetings.left.removeTitle"), body, confirmLabel: t("meetings.left.remove"), danger: true });
    if (sure) await call("discardRecoverable", left.key);
  }
  function leftItem(left) {
    const why = left.code ? errorText(left.code) : t(`meetings.left.${left.kind === "compression" ? "compression" : "interrupted"}`);
    return {
      key: `left:${left.key}`, label: t("meetings.left.title"), detail: [left.name, date(left.startedAt), why].filter(Boolean).join(" · "), icon: "alert",
      items: [
        ...(left.code ? [] : [{ label: t("meetings.left.recover"), icon: "refresh", run: () => call("recover") }]),
        { label: t("meetings.left.remove"), icon: "trash", danger: true, run: () => discardLeft(left) }
      ]
    };
  }
  function meetingItem({ project, place, sizes }, meeting) {
    const run = openMeeting(project.path, meeting.id);
    if (meeting.broken) {
      return { key: meeting.id, label: meeting.id, icon: "alert", detail: [t("meetings.state.broken"), bytes(sizes[meeting.id])].filter(Boolean).join(" · "), run };
    }
    const { recording } = live.status;
    const state = live.jobs.has(`${place}|${meeting.id}`) ? "processing"
      : recording?.id === meeting.id && recording.place === place ? "recording" : meeting.state;
    const mark = state === "recording" ? "record" : state === "failed" ? "alert" : state === "ready" ? "check" : "file";
    const about = [date(meeting.startedAt), meeting.durationMs !== null && length(meeting.durationMs), t(`meetings.state.${state}`), bytes(sizes[meeting.id])];
    return { key: meeting.id, label: meeting.title || t("meetings.untitled"), icon: mark, detail: about.filter(Boolean).join(" · "), run };
  }
  function menuItems(state) {
    const { capabilities, status } = live, busy = status.phase !== "idle";
    const why = !capabilities.supported ? errorText(capabilities.code || "meetingsWindowsOnly")
      : busy ? t("meetings.menu.busy", { name: status.recording?.name || "" }) : "";
    const items = [{ key: "record", label: t("meetings.record"), icon: "record", detail: why, disabled: Boolean(why) || !state.meetings, run: () => meetingsStart.open(state.project) }];
    const left = live.recoverable.filter(one => !(one.kind === "compression" && !one.code && live.compressions.has(key(one))));
    items.push(...left.map(leftItem), { separator: true });
    const note = label => ({ key: "note", label, icon: "file", disabled: true });
    if (state.error) items.push({ ...note(state.error), icon: "alert" });
    else if (!state.meetings) items.push(note(t("meetings.loading")));
    else if (!state.meetings.length) items.push(note(t("meetings.menu.empty")));
    else items.push(...state.meetings.map(meeting => meetingItem(state, meeting)));
    return items;
  }
  const isMenuOpen = state => Boolean(state) && menu === state && groupMenu === state.el && state.el.isConnected;
  // The focus stays on the row it was on, the submenu's anchor included.
  function drawMenu(state) {
    if (!isMenuOpen(state)) return;
    if (menuLayers.length > 1) return; // a flyout is open: drawn again once the menu is opened again
    const { el } = state, index = document.activeElement?.closest?.("[data-i]")?.dataset.i;
    const was = el.contains(document.activeElement) && index !== undefined ? el.__items[index]?.key : null;
    const top = el.scrollTop;
    renderMenuLayer(el, menuItems(state));
    placeGroupMenu(button);
    el.scrollTop = top;
    const at = was ? el.__items.findIndex(item => item.key === was) : -1;
    const row = el.querySelector(`[data-i="${at}"]:not(:disabled)`);
    if (row) row.focus({ preventScroll: true });
    else focusFirst(el);
  }
  async function fillMenu(state) {
    try {
      const answer = await call("list", state.project.path);
      if (!isMenuOpen(state)) return;
      setState(answer.state);
      meetingsIndicator.render();
      Object.assign(state, { place: answer.place, meetings: answer.meetings, error: "" });
      if (shown?.key === state.project.key) {
        turn++; // a count asked for earlier is older than this
        Object.assign(shown, { place: answer.place, count: answer.meetings.length });
        drawButton();
      }
      drawMenu(state);
      const sizes = await call("sizes", state.project.path);
      if (!isMenuOpen(state)) return;
      state.sizes = sizes;
    } catch (error) {
      if (!state.meetings) state.error = error.message;
    }
    drawMenu(state);
  }
  function openMeetingsMenu() {
    if (!shown) return;
    const state = { el: null, project: { ...shown }, place: shown.place, meetings: null, sizes: {}, error: "" };
    openMenu(button, "", menuItems(state), "meetings-menu");
    state.el = groupMenu;
    menu = state;
    fillMenu(state);
  }

  // ---------- events ----------
  function refresh(place = "") {
    if (!place || !shown?.place || place === shown.place) countSoon();
    if (isMenuOpen(menu)) fillMenu(menu);
  }
  function readState() {
    return call("state").then(state => {
      setState(state);
      meetingsIndicator.render();
    });
  }
  function jobToast(event) {
    const action = { label: t("meetings.view.open"), run: openMeeting(event.project, event.id) };
    if (event.type === "finished") toast(t("meetings.toast.processed"), false, action);
    if (event.type === "failed") toast(errorText(event.code), true, action);
  }
  const EVENTS = {
    status(status) {
      const before = live.status;
      live.status = status;
      meetingsIndicator.render();
      const id = status.recording?.id || null;
      if (before.phase !== status.phase || (before.recording?.id || null) !== id) refresh();
    },
    levels: event => meetingsIndicator.levels(event),
    warning(event) {
      if (event.active) toast(meetingsIndicator.warningText(event), true);
    },
    screenshot(event) {
      for (const failed of event.failed) toast(meetingsIndicator.warningText(failed), true);
      if (event.taken) toast(tn("meetings.toast.screens", event.taken));
      meetingsView.changed(event);
    },
    async ended(event) {
      refresh(event.place);
      meetingsView.changed(event);
      if (event.reason === "discarded" && !event.code) return toast(t("meetings.toast.discarded"));
      if (event.code) toast(errorText(event.code), true);
      // The "Transcribe" button is there; nothing is transcribed by itself.
      if (event.reason === "stopped" && event.saved && !document.querySelector("dialog[open]")) meetingsView.open(event.project, event.id);
    },
    job(event) {
      const id = key(event);
      if (event.type === "finished" || event.type === "failed" || event.type === "cancelled") {
        live.jobs.delete(id);
        meetingsView.moved(event);
        meetingsView.changed(event);
        refresh(event.place);
        if (!meetingsView.shows(event)) jobToast(event);
        return;
      }
      const { type, step, done, total, waitMs } = event, before = live.jobs.get(id);
      const job = type === "started" ? {} : type === "retrying" ? { ...before, step, waitMs } : { step, done, total };
      live.jobs.set(id, job);
      meetingsView.moved(event);
      if (type === "started" && isMenuOpen(menu)) drawMenu(menu);
    },
    compression(event) {
      const id = key(event);
      if (event.type === "finished" || event.type === "failed") {
        live.compressions.delete(id);
        meetingsView.moved(event);
        meetingsView.changed(event);
        refresh(event.place);
        if (event.type === "failed" && event.code !== "meetingsInterrupted" && !meetingsView.shows(event)) jobToast(event);
        return;
      }
      live.compressions.set(id, { done: event.done, total: event.total });
      meetingsView.moved(event);
    },
    changed(event) {
      refresh(event.place);
      meetingsView.changed(event);
    }
  };
  window.meetings.onEvent((name, data) => { if (Object.hasOwn(EVENTS, name)) EVENTS[name](data); });

  button.addEventListener("click", openMeetingsMenu);
  window.addEventListener("focus", countSoon);
  // renderer.js says when the layout or the projects changed.
  window.meetingsUi = { sync };
  readState().catch(report);
  sync();
})();
