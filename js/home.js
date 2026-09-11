(function () {
  const U = OttfreeUtils;
  const { filterListable, shuffle, dedupeById, cardHtml, channelCircleHtml, folderTileHtml,
          wireCardStash, resolveUrl, escapeHtml, displayTitle, initChrome, requireAuth } = U;

  let heroItems = [];
  let heroIndex = 0;
  let heroTimer = null;
  let shelfCounter = 0;

  function nextShelfNum() {
    shelfCounter += 1;
    return String(shelfCounter).padStart(2, "0");
  }

  // ---------------------------------------------------------------------
  // Hero — a blurred "wash" of the art behind a properly-proportioned
  // poster card, enriched with TMDb details (backdrop/year/genre/rating)
  // when a key is configured. Never stretches a portrait poster across a
  // wide banner, unlike the old full-bleed-cover version.
  // ---------------------------------------------------------------------

  async function enrichHeroItem(file) {
    if (!file.tmdb_id) return { file, details: null };
    const path = file.tmdb_type === "tv" ? `/tv/${file.tmdb_id}` : `/movie/${file.tmdb_id}`;
    const details = await U.tmdbFetch(path);
    return { file, details };
  }

  function renderHeroSlide(entry) {
    const { file, details } = entry;
    const slot = document.getElementById("hero-slot");
    const washSrc = resolveUrl(
      (details && U.tmdbImg(details.backdrop_path, "w1280")) || U.posterFor(file)
    );
    const artSrc = resolveUrl(U.posterFor(file)) || (details && U.tmdbImg(details.poster_path, "w500")) || "";
    const title = displayTitle(file);
    const kind = file.tmdb_type === "tv" ? "Series" : "Feature";

    const tags = [kind];
    if (details && details.vote_average) tags.push(`★ ${details.vote_average.toFixed(1)}`);
    const year = details && (details.release_date || details.first_air_date);
    if (year) tags.push(year.slice(0, 4));
    if (details && details.genres) tags.push(...details.genres.slice(0, 2).map((g) => g.name));

    slot.innerHTML = `
      <section class="hero">
        <div class="hero__wash" style="background-image:url('${washSrc}')"></div>
        <div class="hero__scrim"></div>
        <div class="hero__inner">
          <div class="hero__art">${artSrc ? `<img src="${escapeHtml(artSrc)}" alt="" />` : ""}</div>
          <div class="hero__content">
            <div class="hero__tag">On air now</div>
            <h1 class="hero__title">${escapeHtml(title)}</h1>
            <div class="hero__tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>
            <p class="hero__desc">${escapeHtml((details && details.overview) || "")}</p>
            <div class="hero__actions">
              <a class="btn btn--primary" href="${U.watchHref(file)}" data-hero-play>▶ Play</a>
            </div>
          </div>
        </div>
        <div class="hero__dots" data-hero-dots></div>
      </section>`;

    slot.querySelector("[data-hero-play]").addEventListener("click", () => U.stashFile(file));
    const dots = slot.querySelector("[data-hero-dots]");
    dots.innerHTML = heroItems
      .map((_, i) => `<button aria-label="Slide ${i + 1}" class="${i === heroIndex ? "is-active" : ""}" data-i="${i}"></button>`)
      .join("");
    dots.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        heroIndex = Number(b.dataset.i);
        renderHeroSlide(heroItems[heroIndex]);
        resetHeroTimer();
      })
    );
  }

  function resetHeroTimer() {
    clearInterval(heroTimer);
    if (heroItems.length < 2) return;
    heroTimer = setInterval(() => {
      heroIndex = (heroIndex + 1) % heroItems.length;
      renderHeroSlide(heroItems[heroIndex]);
    }, 7000);
  }

  function renderHeroSkeleton() {
    document.getElementById("hero-slot").innerHTML = `
      <section class="hero">
        <div class="hero__inner">
          <div class="hero__art skeleton"></div>
          <div class="hero__content">
            <div class="skeleton skeleton-text" style="width:30%;height:1em;margin-bottom:14px;"></div>
            <div class="skeleton skeleton-text" style="width:60%;height:2.4em;margin-bottom:14px;"></div>
            <div class="skeleton skeleton-text" style="width:80%;height:4em;"></div>
          </div>
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------------
  // Shelves
  // ---------------------------------------------------------------------

  function renderShelf(elId, title, files, opts = {}) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!files.length) { el.innerHTML = ""; return; }
    el.innerHTML = `
      <div class="shelf">
        <div class="shelf__head">
          <span class="shelf__num">${nextShelfNum()}</span>
          <h2 class="shelf__title">${escapeHtml(title)}</h2>
        </div>
        <div class="shelf__track">${files.map((f) => cardHtml(f, opts.chatId || f.public_chat_id || f.chat_id)).join("")}</div>
      </div>`;
    wireCardStash(el, files);
  }

  function renderOttRow(channels) {
    const el = document.getElementById("ott-shelf");
    if (!channels.length) return;
    el.innerHTML = `
      <div class="shelf">
        <div class="shelf__head">
          <span class="shelf__num">${nextShelfNum()}</span>
          <h2 class="shelf__title">OTT available</h2>
        </div>
        <div class="ott-row">${channels.map(channelCircleHtml).join("")}</div>
      </div>`;
  }

  function renderPlaylistShelf(playlists) {
    const el = document.getElementById("playlists-shelf");
    if (!playlists.length) { el.innerHTML = ""; return; }
    el.innerHTML = `
      <div class="shelf">
        <div class="shelf__head">
          <span class="shelf__num">${nextShelfNum()}</span>
          <h2 class="shelf__title">Your playlists</h2>
        </div>
        <div class="folder-row">${playlists.map(folderTileHtml).join("")}</div>
      </div>`;
  }

  async function loadAggregatedRows(channels) {
    const sample = channels.slice(0, window.OTTFREE_CONFIG.HOME_CHANNEL_SAMPLE);
    const results = await Promise.all(
      sample.map(async (ch) => {
        try {
          const cid = ch.public_id ?? ch.chat_id;
          const { data, ok } = await OttfreeAPI.channel(cid, 1);
          if (!ok || !data) return [];
          return filterListable(data.files || []).map((f) => ({
            ...f,
            public_chat_id: f.public_chat_id || data.public_chat_id || cid,
            chat_id: f.chat_id || data.chat_id,
          }));
        } catch (e) {
          return [];
        }
      })
    );
    return dedupeById(results.flat());
  }

  function sortByRecency(files) {
    return files.slice().sort((a, b) => {
      const ai = parseInt(String(a.file_id ?? a.id).replace(/\D/g, ""), 10) || 0;
      const bi = parseInt(String(b.file_id ?? b.id).replace(/\D/g, ""), 10) || 0;
      return bi - ai;
    });
  }

  // "Use tmdb to known [what's trending]": cross-reference the local pool
  // against TMDb's actual trending list. Falls back to a shuffle when no
  // TMDb key is configured or nothing overlaps, so the row is never empty.
  async function buildTrending(pool) {
    const [trendMovies, trendTv] = await Promise.all([
      U.tmdbFetch("/trending/movie/week"),
      U.tmdbFetch("/trending/tv/week"),
    ]);
    const rank = new Map();
    [...((trendMovies && trendMovies.results) || []), ...((trendTv && trendTv.results) || [])].forEach((item, i) => {
      rank.set(String(item.id), i);
    });
    if (!rank.size) return shuffle(pool).slice(0, 20);

    const matched = pool
      .filter((f) => f.tmdb_id != null && rank.has(String(f.tmdb_id)))
      .sort((a, b) => rank.get(String(a.tmdb_id)) - rank.get(String(b.tmdb_id)));

    if (matched.length >= 8) return matched.slice(0, 20);
    const rest = shuffle(pool.filter((f) => !matched.includes(f)));
    return matched.concat(rest).slice(0, 20);
  }

  async function main() {
    if (!(await requireAuth())) return;
    initChrome();
    renderHeroSkeleton();

    const { data, ok } = await OttfreeAPI.home();
    if (!ok || !data) {
      document.getElementById("hero-slot").innerHTML =
        `<div class="state-msg"><strong>Couldn't reach the backend.</strong>Check js/config.js — BASE_URL should point at your API.</div>`;
      return;
    }

    const channels = data.channels || [];
    const playlists = data.playlists || [];
    renderOttRow(channels);
    renderPlaylistShelf(playlists);

    if (!channels.length) {
      document.getElementById("hero-slot").innerHTML =
        `<div class="state-msg"><strong>No channels yet.</strong>Once channels are added they'll show up here.</div>`;
      return;
    }

    const continueWatching = U.listContinueWatching(20);
    renderShelf("continue-shelf", "Continue watching", continueWatching);

    const pool = await loadAggregatedRows(channels);
    const withPoster = pool.filter((f) => f.poster_url || f.thumbnail);

    const recent = sortByRecency(pool).slice(0, 20);
    const trending = await buildTrending(pool);
    const movies = pool.filter((f) => f.tmdb_type !== "tv").slice(0, 20);
    const tvShows = pool.filter((f) => f.tmdb_type === "tv").slice(0, 20);
    const featuredPool = shuffle(withPoster.length ? withPoster : pool).slice(0, 20);

    // Hero candidates: prefer titles TMDb can enrich, otherwise anything
    // with a poster at all.
    const heroCandidates = shuffle(withPoster.length ? withPoster : pool).slice(0, 5);
    heroItems = await Promise.all(heroCandidates.map(enrichHeroItem));
    if (heroItems.length) {
      heroIndex = 0;
      renderHeroSlide(heroItems[0]);
      resetHeroTimer();
    } else {
      document.getElementById("hero-slot").innerHTML = "";
    }

    renderShelf("new-releases-shelf", "New releases", recent);
    renderShelf("trending-shelf", "Trending now", trending);
    renderShelf("movies-shelf", "Movies", movies);
    renderShelf("tv-shelf", "TV shows", tvShows);
    renderShelf("featured-shelf", "Featured", featuredPool);
  }

  main();
})();
