(function () {
  const U = OttfreeUtils;
  const chatId = U.getParam("chat_id");
  const fileId = U.getParam("id");
  const hash = U.getParam("hash");

  let player = null;
  let currentMeta = null;

  // ---------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------

  function positionKey(id) { return "ottfree:pos:" + id; }
  function volumeKey() { return "ottfree:volume"; }

  function initPlayer() {
    player = videojs("player", {
      // fluid:true is what makes Video.js size itself to its container
      // instead of the source video's native pixel dimensions — without it
      // a 1080p/4K file can force the player (and everything around it) to
      // blow out way past the viewport.
      fluid: true,
      responsive: true,
      playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
      preload: "auto",
      html5: { vhs: { overrideNative: true } },
    });

    try {
      const saved = JSON.parse(localStorage.getItem(volumeKey()) || "null");
      if (saved) {
        player.volume(saved.volume);
        player.muted(saved.muted);
      }
    } catch (e) {}

    player.on("volumechange", () => {
      try {
        localStorage.setItem(volumeKey(), JSON.stringify({ volume: player.volume(), muted: player.muted() }));
      } catch (e) {}
    });

    if (typeof player.hotkeys === "function") {
      player.hotkeys({
        volumeStep: 0.1,
        seekStep: 10,
        enableModifiersForNumbers: false,
        enableVolumeScroll: true,
        enableHoverScroll: true,
      });
    }
    if (typeof player.mobileUi === "function") {
      player.mobileUi({ fullscreen: { enterOnRotate: true, lockOnRotate: true } });
    }
    if (typeof player.landscapeFullscreen === "function") {
      player.landscapeFullscreen({ fullscreen: { enterOnRotate: true, exitOnRotate: true, alwaysInLandscapeMode: true } });
    }

    player.on("timeupdate", () => {
      if (!currentMeta) return;
      const t = player.currentTime();
      const d = player.duration();
      if (t > 3) {
        try { localStorage.setItem(positionKey(currentMeta._localId), String(t)); } catch (e) {}
      }
      if (d && isFinite(d)) U.saveProgress(currentMeta, t, d);
    });

    player.on("ended", () => {
      if (currentMeta) {
        try { localStorage.removeItem(positionKey(currentMeta._localId)); } catch (e) {}
        U.clearProgress(currentMeta._localId);
      }
      maybeAutoAdvance();
    });
  }

  function loadSource(meta, { autoplay } = { autoplay: false }) {
    currentMeta = meta;
    const src = OttfreeAPI.streamUrl(meta.stream_url);
    const type = meta.mime_type || meta.file_type || "video/mp4";
    player.poster(U.resolveUrl(U.posterFor(meta)));
    player.src([{ src, type }]);

    const localId = meta._localId;
    let resumeAt = 0;
    try { resumeAt = parseFloat(localStorage.getItem(positionKey(localId)) || "0"); } catch (e) {}

    player.one("loadedmetadata", () => {
      if (resumeAt > 5 && resumeAt < player.duration() - 10) {
        player.currentTime(resumeAt);
      }
      if (autoplay) player.play().catch(() => {});
    });
  }

  // ---------------------------------------------------------------------
  // Page chrome: title / tags / overview
  // ---------------------------------------------------------------------

  function episodeContextLine(meta, episodeName) {
    if (meta.tmdb_type !== "tv" || meta.season == null) return "";
    const base = `Season ${meta.season}${meta.episode != null ? `, Episode ${meta.episode}` : ""}`;
    return episodeName ? `${base} — ${episodeName}` : base;
  }

  function renderInfo(meta, tmdbDetails, episodeName) {
    // Only ever the TMDb-derived title (falls back to the backend's own
    // fallback logic when there's genuinely no TMDb match) — never the raw
    // Telegram caption alongside it.
    const title = U.displayTitle(meta);
    document.getElementById("w-title").textContent = title;
    document.getElementById("w-title").classList.remove("skeleton", "skeleton-text");
    document.title = title + " — Ottfree";
    document.getElementById("w-sub").textContent = episodeContextLine(meta, episodeName);

    const tags = [];
    if (meta.tmdb_type) tags.push(meta.tmdb_type === "tv" ? "Series" : "Movie");
    if (tmdbDetails && tmdbDetails.vote_average) tags.push(`★ ${tmdbDetails.vote_average.toFixed(1)}`);
    if (tmdbDetails && (tmdbDetails.release_date || tmdbDetails.first_air_date)) {
      const year = (tmdbDetails.release_date || tmdbDetails.first_air_date || "").slice(0, 4);
      if (year) tags.push(year);
    }
    if (tmdbDetails && tmdbDetails.runtime) tags.push(`${tmdbDetails.runtime} min`);
    if (tmdbDetails && tmdbDetails.genres && tmdbDetails.genres.length) {
      tags.push(...tmdbDetails.genres.slice(0, 3).map((g) => g.name));
    }
    if (meta.file_size || meta.size) tags.push(meta.file_size || meta.size);
    document.getElementById("w-tags").innerHTML = tags.map((t) => `<span class="tag">${U.escapeHtml(t)}</span>`).join("");
    document.getElementById("w-overview").textContent = (tmdbDetails && tmdbDetails.overview) || "";
  }

  // ---------------------------------------------------------------------
  // Episodes (TV only)
  // ---------------------------------------------------------------------

  // Scanned once per page load and reused across season switches — this is
  // also what makes the season selector actually work without a TMDb key:
  // seasons are discovered from what's really in the channel, not only from
  // TMDb metadata.
  let showMap = {};        // { [season]: { [episode]: file } }
  let seasonMetaCache = {}; // { [season]: tmdb season payload | null }
  let tvDetails = null;
  let currentSeasonNum = null;

  async function scanChannelForShow(cid, tmdbId) {
    const map = {};
    for (let p = 1; p <= window.OTTFREE_CONFIG.MAX_EPISODE_SCAN_PAGES; p++) {
      let res;
      try { res = await OttfreeAPI.channel(cid, p); } catch (e) { break; }
      if (!res.ok || !res.data || !res.data.files || !res.data.files.length) break;
      res.data.files.forEach((f) => {
        if (String(f.tmdb_id) !== String(tmdbId) || f.season == null || f.episode == null) return;
        const s = Number(f.season);
        const e = Number(f.episode);
        if (!map[s]) map[s] = {};
        map[s][e] = { ...f, public_chat_id: f.public_chat_id || res.data.public_chat_id || cid, chat_id: f.chat_id || res.data.chat_id };
      });
    }
    return map;
  }

  function episodeRowHtml(ep, fileMatch, isCurrent, fallbackPoster) {
    const still = U.tmdbImg(ep.still_path, "w300") || fallbackPoster || "";
    const available = !!fileMatch;
    const name = ep.name || `Episode ${ep.episode_number}`;
    return `
      <button class="episode-row ${isCurrent ? "is-current" : ""} ${available ? "" : "is-unavailable"}"
              data-episode="${ep.episode_number}" ${available ? "" : "disabled"}>
        <div class="episode-row__thumb">${still ? `<img src="${U.escapeHtml(still)}" alt="" loading="lazy" />` : ""}</div>
        <div>
          <div class="episode-row__num">E${ep.episode_number}${available ? "" : " · Unavailable"}</div>
          <div class="episode-row__title">${U.escapeHtml(name)}</div>
          <div class="episode-row__overview">${U.escapeHtml(ep.overview || "")}</div>
        </div>
      </button>`;
  }

  async function fetchSeasonMeta(seasonNum) {
    if (seasonMetaCache[seasonNum] !== undefined) return seasonMetaCache[seasonNum];
    const data = currentMeta.tmdb_id ? await U.tmdbFetch(`/tv/${currentMeta.tmdb_id}/season/${seasonNum}`) : null;
    seasonMetaCache[seasonNum] = data;
    return data;
  }

  function renderTmdbHint() {
    const hint = document.getElementById("episodes-tmdb-hint");
    if (!hint) return;
    const info = U.tmdbInfo();
    if (info.lastOk) { hint.style.display = "none"; return; }
    hint.style.display = "block";
    hint.textContent = !info.configured
      ? "Showing what's in this channel only — add a TMDb API key in js/config.js for episode names, images, and full season lists."
      : "TMDb didn't return data (check the API key in js/config.js) — showing local channel data only.";
  }

  async function renderSeason(seasonNum) {
    currentSeasonNum = seasonNum;
    const list = document.getElementById("episodes-list");
    list.innerHTML = `<div class="skeleton" style="height:80px;margin:8px;border-radius:6px;"></div>`.repeat(4);

    const availability = showMap[seasonNum] || {};
    const seasonData = await fetchSeasonMeta(seasonNum);
    renderTmdbHint();

    const episodes = (seasonData && seasonData.episodes && seasonData.episodes.length)
      ? seasonData.episodes
      : Object.keys(availability)
          .map(Number)
          .sort((a, b) => a - b)
          .map((n) => ({ episode_number: n, name: "", overview: "", still_path: null }));

    if (!episodes.length) {
      list.innerHTML = `<div class="state-msg">No episodes found for this season.</div>`;
      return;
    }

    const fallbackPoster = U.resolveUrl(U.posterFor(currentMeta));
    list.innerHTML = episodes
      .slice()
      .sort((a, b) => a.episode_number - b.episode_number)
      .map((ep) => episodeRowHtml(
        ep,
        availability[ep.episode_number],
        Number(currentMeta.episode) === ep.episode_number && Number(currentMeta.season) === seasonNum,
        fallbackPoster
      ))
      .join("");

    list.querySelectorAll(".episode-row[data-episode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const epNum = Number(btn.dataset.episode);
        const file = availability[epNum];
        if (!file) return;
        playEpisode(file);
      });
    });
  }

  function playEpisode(file) {
    file._localId = String(file.file_id ?? file.id);
    U.stashFile(file);
    const cid = file.public_chat_id || chatId;
    history.replaceState(null, "", `watch.html?${U.qs({ chat_id: cid, id: file.file_id ?? file.id, hash: file.hash })}`);
    loadSource(file, { autoplay: true });
    const epMeta = (seasonMetaCache[file.season] && seasonMetaCache[file.season].episodes || [])
      .find((e) => e.episode_number === Number(file.episode));
    renderInfo(file, tvDetails, epMeta && epMeta.name);
    document.querySelectorAll(".episode-row").forEach((r) => r.classList.remove("is-current"));
    const row = document.querySelector(`.episode-row[data-episode="${file.episode}"]`);
    if (row) row.classList.add("is-current");
  }

  function maybeAutoAdvance() {
    if (!currentMeta || currentMeta.tmdb_type !== "tv") return;
    const season = showMap[Number(currentMeta.season)];
    const next = season && season[Number(currentMeta.episode) + 1];
    if (next) playEpisode(next);
  }

  async function setupEpisodesPanel(meta) {
    if (meta.tmdb_type !== "tv" || !meta.tmdb_id) return;
    const panel = document.getElementById("episodes-panel");
    panel.style.display = "flex";

    const [tvData, localMap] = await Promise.all([
      U.tmdbFetch(`/tv/${meta.tmdb_id}`),
      scanChannelForShow(chatId, meta.tmdb_id),
    ]);
    tvDetails = tvData;
    showMap = localMap;

    const tmdbSeasons = ((tvDetails && tvDetails.seasons) || []).filter((s) => s.season_number > 0).map((s) => s.season_number);
    const localSeasons = Object.keys(showMap).map(Number);
    const seasonNums = Array.from(new Set([...tmdbSeasons, ...localSeasons])).sort((a, b) => a - b);
    if (!seasonNums.length) seasonNums.push(meta.season || 1);

    const select = document.getElementById("season-select");
    const startSeason = seasonNums.includes(Number(meta.season)) ? Number(meta.season) : seasonNums[0];
    select.innerHTML = seasonNums
      .map((n) => `<option value="${n}" ${n === startSeason ? "selected" : ""}>Season ${n}</option>`)
      .join("");
    select.onchange = () => renderSeason(Number(select.value));

    renderInfo(meta, tvDetails);
    await renderSeason(startSeason);
  }

  // ---------------------------------------------------------------------
  // Related row
  // ---------------------------------------------------------------------

  async function renderRelated(meta, cid) {
    const slot = document.getElementById("related-slot");
    try {
      const { data, ok } = await OttfreeAPI.channel(cid, 1);
      if (!ok || !data) return;
      const files = U.filterListable(data.files || []).filter(
        (f) => String(f.id) !== String(meta.id) && String(f.file_id) !== String(meta.file_id)
      );
      if (!files.length) return;
      slot.innerHTML = `
        <div class="shelf" style="margin-top:8px;">
          <div class="shelf__head" style="padding:0"><h2 class="shelf__title">More from this channel</h2></div>
          <div class="shelf__track" style="padding:4px 0 12px;">${files.slice(0, 16).map((f) => U.cardHtml(f, cid)).join("")}</div>
        </div>`;
      U.wireCardStash(slot, files);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  function showFatal(title, sub) {
    const t = document.getElementById("w-title");
    t.classList.remove("skeleton", "skeleton-text");
    t.textContent = title;
    document.getElementById("w-sub").textContent = sub;
  }

  async function main() {
    if (!(await U.requireAuth())) return;
    U.initChrome();

    if (!chatId || !fileId || !hash) {
      showFatal("Missing playback details", "This link is missing chat_id, id, or hash.");
      return;
    }

    const stashed = U.unstashFile(fileId) || {};
    const { data: watchData, ok } = await OttfreeAPI.watch(chatId, fileId, hash);
    if (!ok || !watchData) {
      showFatal("Couldn't load this title", "The link may have expired or the hash is invalid.");
      return;
    }

    const meta = {
      ...stashed,
      chat_id: watchData.chat_id,
      public_chat_id: watchData.public_chat_id,
      file_id: watchData.file_id,
      hash: watchData.hash,
      stream_url: watchData.stream_url,
    };
    meta._localId = String(meta.file_id ?? meta.id ?? fileId);

    initPlayer();
    loadSource(meta);
    renderInfo(meta, null);

    if (meta.tmdb_id && meta.tmdb_type === "tv") {
      await setupEpisodesPanel(meta);
    } else if (meta.tmdb_id) {
      const details = await U.tmdbFetch(`/movie/${meta.tmdb_id}`);
      renderInfo(meta, details);
    }

    renderRelated(meta, meta.public_chat_id || chatId);
  }

  main();
})();
