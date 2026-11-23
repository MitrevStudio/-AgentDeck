// Both channels of a meeting played as one: the microphone and the system sound were recorded on one clock, so the
// second follows the first. Its sources are media.js's addresses.
const meetingsPlayer = (() => {
  const { clock } = meetingsShared;
  const DRIFT_S = 0.2; // past it the second channel is put where the first is

  function create(host) {
    host.innerHTML = `<button type="button" class="icon-btn mp-play"></button><span class="mp-now"></span>
      <input type="range" class="mp-seek" min="0" step="1" value="0" aria-label="${esc(t("meetings.player.position"))}">
      <span class="mp-total"></span><span class="mp-error" role="alert"></span>`;
    const [button, now, seek, total, failed] = [".mp-play", ".mp-now", ".mp-seek", ".mp-total", ".mp-error"].map(s => host.querySelector(s));
    let tracks = [], signature = "", lengthS = 0;

    function drawButton() {
      const playing = Boolean(tracks.length) && !tracks[0].paused;
      const label = t(playing ? "meetings.player.pause" : "meetings.player.play");
      setHtml(button, icon(playing ? "pause" : "play"));
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    function drawTime() {
      const at = tracks[0]?.currentTime || 0, end = lengthS || (Number.isFinite(tracks[0]?.duration) ? tracks[0].duration : 0);
      seek.max = String(Math.ceil(end));
      seek.value = String(Math.round(at));
      seek.setAttribute("aria-valuetext", clock(at * 1000));
      now.textContent = clock(at * 1000);
      total.textContent = clock(end * 1000);
    }
    function follow() {
      const [first, second] = tracks;
      if (!second || first.paused || first.seeking || second.seeking) return;
      if (Number.isFinite(second.duration) && first.currentTime >= second.duration) return;
      if (Math.abs(second.currentTime - first.currentTime) > DRIFT_S) second.currentTime = first.currentTime;
      if (second.paused) second.play().catch(() => {});
    }
    function play() {
      if (!tracks.length) return;
      const [first, second] = tracks;
      if (first.ended) first.currentTime = 0;
      if (second) second.currentTime = first.currentTime;
      for (const track of tracks) track.play().catch(error => { if (error.name !== "AbortError" && tracks.includes(track)) fail(); });
    }
    const pause = () => tracks.forEach(track => track.pause());
    function fail() {
      pause();
      failed.textContent = t("errors.meetingsAudioUnreadable");
    }
    function seekTo(seconds) {
      for (const track of tracks) track.currentTime = seconds;
      drawTime();
    }

    // Lets go of the files: Windows deletes nothing that is being read.
    function detach() {
      const old = tracks;
      tracks = [];
      signature = "";
      for (const track of old) {
        track.pause();
        track.removeAttribute("src");
        track.load();
      }
      host.hidden = true;
    }
    function set(urls, durationMs) {
      lengthS = (durationMs || 0) / 1000;
      const next = urls.join("|");
      if (next === signature) return drawTime();
      detach();
      signature = next;
      failed.textContent = "";
      tracks = urls.map(url => {
        const track = new Audio();
        track.preload = "metadata";
        track.addEventListener("error", () => { if (tracks.includes(track)) fail(); });
        track.src = url;
        return track;
      });
      const first = tracks[0];
      if (first) {
        for (const event of ["play", "pause"]) first.addEventListener(event, drawButton);
        for (const event of ["loadedmetadata", "seeked"]) first.addEventListener(event, drawTime);
        first.addEventListener("timeupdate", () => { drawTime(); follow(); });
        first.addEventListener("ended", () => { pause(); drawButton(); });
      }
      host.hidden = !first;
      drawButton();
      drawTime();
    }

    button.addEventListener("click", () => (tracks[0]?.paused ? play() : pause()));
    seek.addEventListener("input", () => seekTo(Number(seek.value)));
    host.hidden = true;
    return {
      set, detach,
      ready: () => tracks.length > 0 && !failed.textContent,
      playFrom(ms) { seekTo(ms / 1000); play(); }
    };
  }

  return { create };
})();
