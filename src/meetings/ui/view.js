// One meeting in a dialog: what can be done with it, what runs, its sound, and its summary, transcript and
// screenshots. All that it shows of them is untrusted (markdown.js, esc).
const meetingsView = (() => {
  const { live, key, call, report, errorText, SETTINGS_CODES, openSettings, clock, length, date, bytes, dialog } = meetingsShared;
  const TABS = ["summary", "transcript", "screens"];
  let cur = null; // the meeting shown

  const titleOf = meeting => (meeting.broken ? meeting.id : meeting.title || t("meetings.untitled"));

  function open(project, id) {
    closeGroupMenu();
    cur?.dialog.close();
    const d = dialog("meeting-view", `<header>
        <div class="mv-titles"><div class="mv-title"><h2 id="meetingViewTitle"></h2>
          <button type="button" class="icon-btn" data-mv="rename" title="${esc(t("action.rename"))}" aria-label="${esc(t("action.rename"))}" hidden>${icon("pencil")}</button></div>
          <small class="mv-about"></small></div>
        <button type="button" class="icon-btn" data-mv="close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}" autofocus>${icon("x")}</button>
      </header>
      <div class="mv-actions"></div>
      <div class="mv-status" role="status"></div>
      <div class="mv-player"></div>
      <div class="mv-tabs" role="tablist" aria-label="${esc(t("meetings.view.parts"))}">${TABS.map(name =>
        `<button type="button" role="tab" id="mvTab-${name}" aria-controls="mvPanel-${name}" data-mv-tab="${name}">${esc(t(`meetings.tab.${name}`))}${name === "screens" ? ' <span class="count"></span>' : ""}</button>`).join("")}</div>
      ${TABS.map(name => `<div class="mv-panel mv-${name}" id="mvPanel-${name}" role="tabpanel" aria-labelledby="mvTab-${name}" tabindex="0" hidden></div>`).join("")}`);
    const self = {
      project, id, dialog: d, place: "", data: null, tab: "", picked: false, starting: false, removing: false, failure: null, turn: 0, viewer: null,
      player: meetingsPlayer.create(d.querySelector(".mv-player")),
      part: selector => d.querySelector(selector)
    };
    cur = self;
    d.addEventListener("click", e => onClick(self, e));
    d.querySelector(".mv-tabs").addEventListener("keydown", e => onTabKey(self, e));
    d.addEventListener("close", () => {
      self.player.detach();
      self.viewer?.close();
      if (cur === self) cur = null;
    });
    self.part(".mv-status").textContent = t("meetings.loading");
    load(self);
  }

  async function load(self) {
    const turn = ++self.turn;
    let data;
    try {
      data = await call("open", self.project, self.id);
    } catch (error) {
      if (cur !== self || turn !== self.turn) return;
      self.dialog.close();
      return report(error);
    }
    if (cur !== self || turn !== self.turn) return;
    self.data = data;
    self.place = data.place;
    render(self);
  }

  // ---------- what it can do now ----------
  function facts(self) {
    const { meeting, raw } = self.data, id = key(self);
    const job = live.jobs.get(id), compression = live.compressions.get(id);
    return {
      meeting, job, compression,
      busy: Boolean(job) || self.starting,
      recording: meeting.state === "recording",
      saved: !meeting.broken && (meeting.audio.mic || meeting.audio.system),
      hasAudio: !meeting.broken && (meeting.audio.mic || meeting.audio.system || raw || Boolean(compression))
    };
  }
  function canRetry({ state, error, transcription }) {
    if (state === "failed" || transcription?.failed) return true;
    return (state === "transcribed" || state === "ready") && Boolean(error) && error.code !== "meetingsNoSpeech";
  }
  function actionsHtml(self) {
    const { meeting, busy, recording, compression, hasAudio, saved } = facts(self);
    const button = (name, mark, label, cls = "", disabled = false) =>
      `<button type="button" class="btn sm ${cls}" data-mv="${name}" ${disabled ? "disabled" : ""}>${icon(mark)}<span>${esc(t(`meetings.action.${label}`))}</span></button>`;
    if (meeting.broken) return `<span class="grow"></span>${button("remove", "trash", "remove", "danger")}`;

    const work = [];
    if (busy) work.push(button("cancel", "x", "cancel", "", self.starting && !live.jobs.has(key(self))));
    else if (!recording) {
      const retry = canRetry(meeting);
      if (retry) work.push(button("retry", "refresh", "retry", "primary"));
      if (!meeting.transcription && hasAudio) work.push(button("transcribe", "bolt", "transcribe", retry ? "" : "primary"));
      if (meeting.transcription) {
        if (meeting.summary) work.push(button("summarize-again", "refresh", "summarizeAgain"));
        else work.push(button("summarize", "bolt", "summarize", retry ? "" : "primary"));
        if (hasAudio) work.push(button("again", "refresh", "again"));
      }
      if (self.data.raw && !saved && !compression) work.push(button("compress", "download", "compress"));
    }
    const files = [button("copy", "copy", "copyPath")];
    if (!recording) {
      if (hasAudio && !busy) files.push(button("remove-audio", "speaker", "removeAudio", "danger"));
      files.push(button("remove", "trash", "remove", "danger"));
    }
    return `${work.join("")}<span class="grow"></span>${files.join("")}`;
  }

  // ---------- drawing ----------
  function progressHtml(label, done, total) {
    const known = total > 0 && Number.isFinite(done);
    const share = known ? Math.min(100, Math.round(done / total * 100)) : 0;
    return `<span class="mv-progress"><span>${esc(label)}${known && share ? ` ${share}%` : ""}</span>
      <progress ${known && share ? `max="100" value="${share}"` : ""} aria-label="${esc(label)}"></progress></span>`;
  }
  function statusHtml(self) {
    const { meeting, job, compression, recording, hasAudio } = facts(self);
    if (meeting.broken) return `<span class="mv-note error">${icon("alert")}<span>${esc(errorText("meetingsBroken"))}</span></span>`;
    const out = [];
    if (job) {
      let label = t(job.step ? `meetings.step.${job.step}` : "meetings.step.starting");
      if (job.waitMs) label += ` ${t("meetings.step.retrying", { n: Math.ceil(job.waitMs / 1000) })}`;
      out.push(progressHtml(label, job.waitMs ? NaN : job.done, job.total));
    } else if (self.starting) out.push(progressHtml(t("meetings.step.starting")));
    if (compression) out.push(progressHtml(t("meetings.step.compressing"), compression.done, compression.total));
    if (recording) out.push(`<span class="mv-note">${icon("record")}<span>${esc(t("meetings.view.recording"))}</span></span>`);

    const problem = !job && !self.starting && (self.failure || (meeting.error && { code: meeting.error.code, message: errorText(meeting.error.code) }));
    if (problem) {
      const link = SETTINGS_CODES.includes(problem.code) ? `<button type="button" class="btn sm" data-mv="settings">${esc(t("meetings.openSettings"))}</button>`
        : problem.code === "meetingsModelRetired" ? `<button type="button" class="btn sm" data-mv="again">${esc(t("meetings.action.again"))}</button>` : "";
      out.push(`<span class="mv-note ${meeting.state === "failed" || self.failure ? "error" : "warn"}">${icon("alert")}<span>${esc(problem.message)}</span>${link}</span>`);
    }
    if (!out.length && !meeting.transcription && hasAudio) out.push(`<span class="mv-note">${esc(t("meetings.view.notTranscribed"))}</span>`);
    return out.join("");
  }
  // What is drawn again keeps the keyboard where it was.
  function redraw(self, el, html) {
    const focused = el.contains(document.activeElement) ? document.activeElement.dataset.mv : null;
    if (!setHtml(el, html) || !focused) return;
    (el.querySelector(`[data-mv="${CSS.escape(focused)}"]:not(:disabled)`) || el.querySelector("button:not(:disabled)")
      || self.part('[data-mv="close"]')).focus();
  }
  function renderWork(self) {
    redraw(self, self.part(".mv-actions"), actionsHtml(self));
    redraw(self, self.part(".mv-status"), statusHtml(self));
  }

  // What a screenshot is of: a monitor, or the window that was chosen, by the title it had then.
  function sourceName({ monitor, window: chosen, title }) {
    return chosen ? title || t("meetings.window", { n: chosen }) : t("meetings.monitor", { n: monitor });
  }
  function screenName(screen) {
    return screen.window ? `${clock(screen.atMs)} · ${sourceName(screen)}` : t("meetings.screen.name", { time: clock(screen.atMs), monitor: screen.monitor });
  }
  function screensHtml(self) {
    const { meeting, media } = self.data;
    if (!meeting.screens.length) return `<p class="mv-empty">${esc(t("meetings.view.noScreens"))}</p>`;
    return `<div class="mv-grid">${meeting.screens.map(screen => `<figure>
      <button type="button" class="mv-shot" data-screen="${esc(screen.file)}" aria-label="${esc(screenName(screen))}"><img src="${esc(media + screen.file)}" alt="" loading="lazy" decoding="async"></button>
      <figcaption><button type="button" class="md-time" data-at="${Number(screen.atMs)}" aria-label="${esc(t("meetings.view.goTo", { time: clock(screen.atMs) }))}">${esc(clock(screen.atMs))}</button>
        <span>${esc(sourceName(screen))}</span>
        <button type="button" class="icon-btn danger" data-mv="remove-screen" data-file="${esc(screen.file)}" title="${esc(t("meetings.screen.remove"))}" aria-label="${esc(`${t("meetings.screen.remove")}: ${screenName(screen)}`)}">${icon("trash")}</button></figcaption>
    </figure>`).join("")}</div>`;
  }
  function documentHtml(part, render, empty) {
    if (!part) return `<p class="mv-empty">${esc(t(empty))}</p>`;
    if (part.tooLarge) return `<p class="mv-empty">${esc(t("meetings.view.tooLarge"))}</p>`;
    if (part.code) return `<p class="mv-empty">${esc(errorText(part.code))}</p>`;
    return render(part.text);
  }
  function renderPanels(self) {
    const { meeting, summary, transcript } = self.data;
    const screens = new Set(meeting.screens.map(screen => screen.file));
    setHtml(self.part(".mv-summary"), documentHtml(summary, text => `<div class="mv-md">${meetingsMarkdown.summary(text, screens)}</div>`, "meetings.view.noSummary"));
    setHtml(self.part(".mv-transcript"), documentHtml(transcript, text => meetingsMarkdown.transcript(text, screens), "meetings.view.noTranscript"));
    setHtml(self.part(".mv-screens"), screensHtml(self));
    self.part(".mv-tabs .count").textContent = meeting.screens.length;
    if (!self.picked) self.tab = summary ? "summary" : transcript ? "transcript" : meeting.screens.length ? "screens" : "summary";
    showTab(self, self.tab);
  }
  function render(self) {
    const { meeting, media, size } = self.data, heading = self.part("h2");
    if (!heading.hidden) heading.textContent = titleOf(meeting);
    self.part('[data-mv="rename"]').hidden = meeting.broken || heading.hidden;
    const about = meeting.broken ? [] : [date(meeting.startedAt), meeting.durationMs !== null && length(meeting.durationMs), t(`meetings.state.${meeting.state}`)];
    self.part(".mv-about").textContent = [...about, bytes(size.bytes)].filter(Boolean).join(" · ");
    renderWork(self);
    self.part(".mv-tabs").hidden = meeting.broken;
    if (meeting.broken) return;
    renderPanels(self);
    self.player.set(["mic", "system"].filter(channel => meeting.audio[channel]).map(channel => `${media}audio/${channel}.webm`), meeting.durationMs);
  }

  // ---------- moving about ----------
  function showTab(self, name, { picked = false, focus = false } = {}) {
    self.tab = name;
    self.picked ||= picked;
    for (const tab of self.dialog.querySelectorAll("[data-mv-tab]")) {
      const on = tab.dataset.mvTab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      self.part(`.mv-${tab.dataset.mvTab}`).hidden = !on;
      if (on && focus) tab.focus();
    }
  }
  function onTabKey(self, e) {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const next = step ? TABS[(TABS.indexOf(self.tab) + step + TABS.length) % TABS.length] : { Home: TABS[0], End: TABS.at(-1) }[e.key];
    if (!next) return;
    e.preventDefault();
    showTab(self, next, { picked: true, focus: true });
  }
  function goToLines(self, from, to) {
    showTab(self, "transcript", { picked: true });
    const rows = [...self.part(".mv-transcript").querySelectorAll(".mt-line")];
    let first = null;
    for (const row of rows) {
      const n = Number(row.dataset.line), hit = n >= from && n <= to;
      row.classList.toggle("hit", hit);
      if (hit) first ||= row;
    }
    first?.scrollIntoView({ block: "center" });
    first?.focus({ preventScroll: true });
  }
  // With sound a time plays from there; without, it is the transcript's line of that time.
  function goToTime(self, ms) {
    if (self.player.ready()) return self.player.playFrom(ms);
    const line = [...self.part(".mv-transcript").querySelectorAll("[data-start]")].filter(row => Number(row.dataset.start) <= ms).at(-1);
    if (line) goToLines(self, Number(line.dataset.line), Number(line.dataset.line));
  }

  // ---------- doing ----------
  // The three that process: they resolve when all of it is over, and what happens meanwhile comes as events.
  async function runJob(self, name, options) {
    self.failure = null;
    self.starting = true;
    renderWork(self);
    try {
      await call(name, self.project, self.id, options);
    } catch (error) {
      if (cur === self) self.failure = error;
      else report(error);
    } finally {
      self.starting = false;
      if (cur === self) await load(self);
    }
  }
  function askAndRun(self, { summaryOnly = false, again = false }) {
    meetingsProcess.open({
      project: self.project, id: self.id, title: titleOf(self.data.meeting), summaryOnly, again,
      run: choices => runJob(self, summaryOnly ? "summarize" : "transcribe", choices)
    });
  }
  async function act(self, fn) {
    self.failure = null;
    try {
      await fn();
    } catch (error) {
      if (cur !== self) return report(error);
      self.failure = error;
      await load(self); // what was let go of before a delete is there again
    }
  }

  function startRename(self) {
    const heading = self.part("h2");
    if (heading.hidden) return;
    const before = self.data.meeting.title, input = document.createElement("input"), pencil = self.part('[data-mv="rename"]');
    input.className = "input mv-rename";
    input.maxLength = 200;
    input.value = before;
    input.setAttribute("aria-label", t("action.rename"));
    heading.after(input);
    heading.hidden = true;
    pencil.hidden = true;
    let done = false;
    function end(save, refocus) {
      if (done) return;
      done = true;
      const title = input.value.trim();
      input.remove();
      heading.hidden = false;
      pencil.hidden = false;
      if (refocus) pencil.focus();
      if (!save || !title || title === before || cur !== self) return;
      act(self, async () => {
        await call("rename", self.project, self.id, title);
        await load(self);
      });
    }
    input.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      e.preventDefault();
      end(e.key === "Enter", true);
    });
    input.addEventListener("blur", () => end(true, false));
    input.focus();
    input.select();
  }

  async function remove(self) {
    const body = t(live.jobs.has(key(self)) ? "meetings.remove.bodyRunning" : "meetings.remove.body", { title: titleOf(self.data.meeting) });
    if (!await confirmDialog({ title: t("meetings.remove.title"), body, confirmLabel: t("meetings.action.remove"), danger: true })) return;
    await act(self, async () => {
      self.player.detach();
      self.removing = true; // main says "changed" before it answers
      try {
        await call("remove", self.project, self.id);
      } finally {
        self.removing = false;
      }
      self.dialog.close();
      toast(t("meetings.remove.done"));
    });
  }
  async function removeAudio(self) {
    if (!await confirmDialog({ title: t("meetings.removeAudio.title"), body: t("meetings.removeAudio.body"), confirmLabel: t("meetings.action.removeAudio"), danger: true })) return;
    await act(self, async () => {
      self.player.detach();
      await call("removeAudio", self.project, self.id);
      await load(self);
    });
  }
  async function removeScreen(self, file) {
    const screen = self.data.meeting.screens.find(s => s.file === file);
    if (!screen) return;
    if (!await confirmDialog({ title: t("meetings.screen.remove"), body: t("meetings.screen.removeBody", { name: screenName(screen) }), confirmLabel: t("meetings.screen.remove"), danger: true })) return;
    await act(self, async () => {
      await call("removeScreen", self.project, self.id, file);
      self.viewer?.close();
      await load(self);
      if (!self.dialog.contains(document.activeElement)) self.part(`[data-mv-tab="${self.tab}"]`).focus();
    });
  }

  function showScreen(self, file) {
    const { screens } = self.data.meeting, media = self.data.media;
    let at = screens.findIndex(screen => screen.file === file);
    if (at < 0) return;
    const d = dialog("meeting-screen", `<header><h2 id="meetingScreenTitle"></h2>
        <button type="button" class="icon-btn" data-step="-1" title="${esc(t("meetings.screen.previous"))}" aria-label="${esc(t("meetings.screen.previous"))}">${icon("left")}</button>
        <button type="button" class="icon-btn" data-step="1" title="${esc(t("meetings.screen.next"))}" aria-label="${esc(t("meetings.screen.next"))}">${icon("right")}</button>
        <button type="button" class="icon-btn danger" data-part="remove" title="${esc(t("meetings.screen.remove"))}" aria-label="${esc(t("meetings.screen.remove"))}">${icon("trash")}</button>
        <button type="button" class="icon-btn" data-part="close" title="${esc(t("common.close"))}" aria-label="${esc(t("common.close"))}" autofocus>${icon("x")}</button>
      </header><img alt="">`);
    const image = d.querySelector("img");
    function show(next) {
      if (next < 0 || next >= screens.length) return;
      at = next;
      d.querySelector("h2").textContent = screenName(screens[at]);
      image.src = media + screens[at].file;
      image.alt = screenName(screens[at]);
      const [previous, following] = d.querySelectorAll("[data-step]");
      previous.disabled = at === 0;
      following.disabled = at === screens.length - 1;
      if (!d.contains(document.activeElement) || document.activeElement.disabled) d.querySelector('[data-part="close"]').focus();
    }
    d.addEventListener("click", e => {
      const button = e.target.closest("button");
      if (button?.dataset.step) show(at + Number(button.dataset.step));
      else if (button?.dataset.part === "close") d.close();
      else if (button?.dataset.part === "remove") removeScreen(self, screens[at].file);
    });
    d.addEventListener("keydown", e => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) show(at + step);
    });
    d.addEventListener("close", () => { if (self.viewer === d) self.viewer = null; });
    self.viewer = d;
    show(at);
  }

  const ACTIONS = {
    close: self => self.dialog.close(),
    settings: () => openSettings().catch(report),
    rename: startRename,
    transcribe: self => askAndRun(self, {}),
    again: self => askAndRun(self, { again: true }),
    summarize: self => askAndRun(self, { summaryOnly: true }),
    "summarize-again": self => askAndRun(self, { summaryOnly: true, again: true }),
    retry: self => runJob(self, "retry"),
    cancel: self => act(self, () => call("cancel", self.project, self.id)),
    compress: self => act(self, async () => { await call("compress", self.project, self.id); await load(self); }),
    copy: self => act(self, async () => {
      await call("copyPath", self.project, self.id);
      if (cur !== self) return;
      const button = self.part('[data-mv="copy"] > span');
      if (button) button.textContent = t("meetings.view.copied");
      setTimeout(() => { if (button?.isConnected) button.textContent = t("meetings.action.copyPath"); }, 2000);
    }),
    remove, "remove-audio": removeAudio,
    "remove-screen": (self, button) => removeScreen(self, button.dataset.file)
  };
  function onClick(self, e) {
    const button = e.target.closest("button");
    if (!button) return;
    const { mv, mvTab, at, screen, from, to } = button.dataset;
    if (mv && (self.data || mv === "close")) ACTIONS[mv](self, button);
    else if (mvTab) showTab(self, mvTab, { picked: true, focus: true });
    else if (at !== undefined) goToTime(self, Number(at));
    else if (screen) showScreen(self, screen);
    else if (from) goToLines(self, Number(from), Number(to));
  }

  // ---------- what happens elsewhere ----------
  const shows = event => Boolean(cur?.data) && key(cur) === key(event);
  // A step of its job or compression.
  function moved(event) {
    if (shows(event)) renderWork(cur);
  }
  // Its files changed; without an id any meeting's of that place, without a place any.
  function changed({ place, id } = {}) {
    if (!cur?.data || cur.removing || (place && place !== cur.place) || (id && id !== cur.id)) return;
    load(cur);
  }

  return { open, shows, moved, changed };
})();
