(function () {
  /**
   * Rule from the brief: a listing (Home, Channel, Search, Playlist) should
   * never show an episode file unless it's episode 1 — episode 1 stands in
   * as the "open this show" card. Movies (episode == null) always pass.
   * Full episode browsing happens on the watch page instead.
   */
  function filterListable(files) {
    return (files || []).filter((f) => f.episode == null || Number(f.episode) === 1);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function dedupeById(files) {
    const seen = new Set();
    const out = [];
    for (const f of files) {
      const key = String(f.id ?? f.file_id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  function posterFor(file) {
    return file.poster_url || file.thumbnail || "";
  }

  function displayTitle(file) {
    return file.title || file.tmdb_title || file.name || file.telegram_title || "Untitled";
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  function qs(params) {
    const p = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") p.set(k, v);
    });
    return p.toString();
  }

  function getParam(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // ---- TMDb (client-side, optional — only runs if TMDB_API_KEY is set) ----
  // Supports both TMDb key formats people paste in by mistake:
  //  - "API Key (v3 auth)": a short ~32-char hex string -> ?api_key= query param
  //  - "API Read Access Token" (v4 auth): a long JWT-like string with dots
  //    -> Authorization: Bearer header
  // This is the #1 cause of "episode details don't show up" reports, since
  // TMDb's dashboard hands out the v4 token much more prominently now.
  const TMDB_BASE = "https://api.themoviedb.org/3";
  const tmdbCache = new Map(); // path -> parsed JSON, session-lifetime memoization
  const tmdbState = { configured: false, lastOk: null, lastStatus: null };

  function tmdbInfo() {
    return { ...tmdbState };
  }

  async function tmdbFetch(path) {
    const key = (window.OTTFREE_CONFIG.TMDB_API_KEY || "").trim();
    tmdbState.configured = !!key;
    if (!key) { tmdbState.lastOk = false; tmdbState.lastStatus = "no-key"; return null; }

    if (tmdbCache.has(path)) return tmdbCache.get(path);

    const isV4 = key.length > 60 || key.split(".").length === 3;
    const url = isV4
      ? `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}language=en-US`
      : `${TMDB_BASE}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}&language=en-US`;

    try {
      const res = await fetch(url, isV4 ? { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } } : {});
      if (!res.ok) {
        tmdbState.lastOk = false;
        tmdbState.lastStatus = res.status === 401 ? "invalid-key" : `http-${res.status}`;
        return null;
      }
      const data = await res.json();
      tmdbState.lastOk = true;
      tmdbState.lastStatus = "ok";
      tmdbCache.set(path, data);
      return data;
    } catch (e) {
      tmdbState.lastOk = false;
      tmdbState.lastStatus = "network-error";
      return null;
    }
  }

  function tmdbImg(path, size = "w500") {
    if (!path) return "";
    return `${window.OTTFREE_CONFIG.TMDB_IMG}/${size}${path}`;
  }

  // ---- session/watch-meta passing between pages ----
  function stashFile(file) {
    try {
      sessionStorage.setItem(
        "ottfree:lastFile:" + String(file.id ?? file.file_id),
        JSON.stringify(file)
      );
    } catch (e) {}
  }

  function unstashFile(id) {
    try {
      const raw = sessionStorage.getItem("ottfree:lastFile:" + String(id));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function watchHref(file, chatId) {
    const cid = chatId || file.public_chat_id || file.chat_id;
    return `watch.html?${qs({ chat_id: cid, id: file.file_id ?? file.id, hash: file.hash })}`;
  }

  // ---- continue watching (fully client-side, no backend involved) ----
  const CONTINUE_KEY = "ottfree:continue";
  const CONTINUE_FIELDS = [
    "id", "file_id", "chat_id", "public_chat_id", "hash", "title", "tmdb_title",
    "telegram_title", "name", "poster_url", "thumbnail", "tmdb_id", "tmdb_type",
    "season", "episode", "mime_type", "file_type",
  ];

  function readContinueMap() {
    try {
      return JSON.parse(localStorage.getItem(CONTINUE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }

  function saveProgress(file, currentTime, duration) {
    if (!duration || !isFinite(duration)) return;
    // Don't bother tracking the very start or the very end of a title.
    if (currentTime < 8 || currentTime > duration - 15) return;
    try {
      const map = readContinueMap();
      const id = String(file.file_id ?? file.id);
      const trimmed = {};
      CONTINUE_FIELDS.forEach((k) => { if (file[k] !== undefined) trimmed[k] = file[k]; });
      map[id] = { t: currentTime, d: duration, updatedAt: Date.now(), file: trimmed };
      localStorage.setItem(CONTINUE_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function clearProgress(fileId) {
    try {
      const map = readContinueMap();
      delete map[String(fileId)];
      localStorage.setItem(CONTINUE_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function getProgress(fileId) {
    const map = readContinueMap();
    return map[String(fileId)] || null;
  }

  function listContinueWatching(limit = 20) {
    const map = readContinueMap();
    return Object.values(map)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry.file, _progressPct: Math.min(100, Math.round((entry.t / entry.d) * 100)) }));
  }

  // ---- site settings: notice banner + ad injection (admin-configurable, ----
  // ---- served from server.js's small local JSON store, not the backend) ----
  async function fetchSiteSettings() {
    try {
      const res = await fetch("/local-api/settings");
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function showNoticeBanner(notice) {
    if (!notice || !notice.enabled || !notice.message) return;
    if (sessionStorage.getItem("ottfree:noticeDismissed") === notice.message) return;
    const bar = document.createElement("div");
    bar.className = `notice-bar notice-bar--${notice.level || "info"}`;
    bar.innerHTML = `<span>${escapeHtml(notice.message)}</span><button aria-label="Dismiss" data-dismiss>&times;</button>`;
    bar.querySelector("[data-dismiss]").addEventListener("click", () => {
      sessionStorage.setItem("ottfree:noticeDismissed", notice.message);
      bar.remove();
    });
    document.body.prepend(bar);
  }

  // Ads: raw HTML/script snippets can't just be dropped in via innerHTML —
  // the DOM spec doesn't execute <script> tags inserted that way. Rebuild
  // each script tag so it actually runs.
  function injectHtmlWithScripts(container, html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    Array.from(tmp.childNodes).forEach((node) => {
      if (node.tagName === "SCRIPT") {
        const s = document.createElement("script");
        Array.from(node.attributes).forEach((a) => s.setAttribute(a.name, a.value));
        s.text = node.textContent || "";
        container.appendChild(s);
      } else {
        container.appendChild(node);
      }
    });
  }

  function applyAds(ads) {
    if (!ads || !ads.enabled || !ads.snippet) return;
    const holder = document.createElement("div");
    holder.id = "ottfree-ad-slot";
    holder.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden;";
    document.body.appendChild(holder);
    try { injectHtmlWithScripts(holder, ads.snippet); } catch (e) {}
  }

  // ---- session/auth state shared across pages ----

  /**
   * Gate a page behind login. Call this first thing in a page's main().
   * Redirects to the login page (index.html) with ?next= set to return here
   * on success. Returns true if the page should continue rendering.
   */
  async function requireAuth() {
    try {
      const { data, ok } = await OttfreeAPI.loginState();
      if (ok && data && data.authenticated) return true;
    } catch (e) {}
    const next = encodeURIComponent(location.pathname.split("/").pop() + location.search);
    location.replace(`index.html?next=${next}`);
    return false;
  }

  async function refreshSessionBadge() {
    const nav = document.querySelector("[data-nav-auth]");
    if (!nav) return;
    const { data } = await OttfreeAPI.loginState();
    const authed = !!(data && data.authenticated);
    const isAdmin = sessionStorage.getItem("ottfree:isAdmin") === "1";
    if (authed) {
      nav.innerHTML = `
        ${isAdmin ? '<a href="admin.html" class="nav-link">Admin</a>' : ""}
        <button class="nav-link nav-link--btn" data-logout>Sign out</button>
      `;
      const btn = nav.querySelector("[data-logout]");
      if (btn) btn.addEventListener("click", async () => {
        await OttfreeAPI.logout();
        sessionStorage.removeItem("ottfree:isAdmin");
        location.href = "index.html";
      });
    } else {
      const next = encodeURIComponent(location.pathname.split("/").pop() + location.search);
      nav.innerHTML = `<a href="index.html?next=${next}" class="nav-link nav-link--btn">Sign in</a>`;
      sessionStorage.removeItem("ottfree:isAdmin");
    }
    return authed;
  }

  function wireNavSearch() {
    const form = document.querySelector("[data-nav-search]");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = form.querySelector("input").value.trim();
      if (!q) return;
      location.href = `search.html?${qs({ q })}`;
    });
  }

  function initChrome(opts = {}) {
    wireNavSearch();
    refreshSessionBadge();
    const menuBtn = document.querySelector("[data-menu-toggle]");
    const nav = document.querySelector(".site-nav");
    if (menuBtn && nav) {
      menuBtn.addEventListener("click", () => nav.classList.toggle("is-open"));
    }
    fetchSiteSettings().then((settings) => {
      if (!settings) return;
      showNoticeBanner(settings.notice);
      if (opts.ads !== false) applyAds(settings.ads);
    });
  }

  function cardHtml(file, chatId) {
    const title = escapeHtml(displayTitle(file));
    const poster = resolveUrl(posterFor(file));
    const isSeries = file.tmdb_type === "tv" || (file.season != null);
    const href = watchHref(file, chatId);
    const sub = file.season != null ? `Season ${file.season}` : (file.tmdb_type ? "" : "");
    const progress = typeof file._progressPct === "number"
      ? `<div class="card__progress"><span style="width:${file._progressPct}%"></span></div>`
      : "";
    return `
      <a class="card" href="${href}" data-stash-id="${escapeHtml(String(file.file_id ?? file.id))}">
        <div class="card__poster">
          ${poster ? `<img src="${escapeHtml(poster)}" alt="" loading="lazy" />` : `<div class="skeleton" style="position:absolute;inset:0;"></div>`}
          ${isSeries ? `<span class="card__badge">Series</span>` : ""}
          ${progress}
        </div>
        <div class="card__title">${title}</div>
        ${sub ? `<div class="card__sub">${escapeHtml(sub)}</div>` : ""}
      </a>`;
  }

  function resolveUrl(u) {
    if (!u) return "";
    return u.startsWith("http") ? u : OttfreeAPI.streamUrl(u);
  }

  function channelCardHtml(ch) {
    const thumb = resolveUrl(ch.thumbnail) || OttfreeAPI.thumbUrl(ch.public_id ?? ch.chat_id);
    return `
      <a class="card channel-card" href="channel.html?${qs({ chat_id: ch.public_id ?? ch.chat_id })}">
        <div class="card__poster">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : `<div class="skeleton" style="position:absolute;inset:0;"></div>`}
        </div>
        <div class="card__title">${escapeHtml(ch.title)}</div>
      </a>`;
  }

  function channelCircleHtml(ch) {
    const thumb = resolveUrl(ch.thumbnail) || OttfreeAPI.thumbUrl(ch.public_id ?? ch.chat_id);
    return `
      <a class="ott-circle" href="channel.html?${qs({ chat_id: ch.public_id ?? ch.chat_id })}">
        <div class="ott-circle__ring">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : `<div class="skeleton" style="position:absolute;inset:0;border-radius:50%;"></div>`}
        </div>
        <div class="ott-circle__name">${escapeHtml(ch.title)}</div>
      </a>`;
  }

  function folderTileHtml(pl) {
    return `
      <a class="folder-tile" href="playlist.html?${qs({ db: pl.id })}">
        <span class="folder-tile__icon">📁</span>
        <span class="folder-tile__name">${escapeHtml(pl.title || pl.name)}</span>
      </a>`;
  }

  function wireCardStash(root, files) {
    const byId = {};
    files.forEach((f) => (byId[String(f.file_id ?? f.id)] = f));
    root.querySelectorAll("[data-stash-id]").forEach((el) => {
      el.addEventListener("click", () => {
        const f = byId[el.getAttribute("data-stash-id")];
        if (f) stashFile(f);
      });
    });
  }

  window.OttfreeUtils = {
    filterListable,
    shuffle,
    dedupeById,
    posterFor,
    displayTitle,
    escapeHtml,
    qs,
    getParam,
    requireAuth,
    tmdbFetch,
    tmdbImg,
    tmdbInfo,
    stashFile,
    unstashFile,
    watchHref,
    saveProgress,
    clearProgress,
    getProgress,
    listContinueWatching,
    fetchSiteSettings,
    refreshSessionBadge,
    initChrome,
    resolveUrl,
    cardHtml,
    channelCardHtml,
    channelCircleHtml,
    folderTileHtml,
    wireCardStash,
  };
})();
