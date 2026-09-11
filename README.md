# Ottfree frontend

A frontend for the Ottfree/Surf-TG backend API. Plain HTML/CSS/JS, no build
framework — the only Node involved is a small built-in server that also
doubles as a CORS-fixing reverse proxy, a tiny local settings store, and a
short-lived response cache (see below).

**Deploying?** See [DEPLOY.md](./DEPLOY.md) for step-by-step guides for
**Render** and **Termux** (running it on an Android phone), plus a shorter
note for any other Node host or static file host.

## How it works out of the box

This ships already pointed at `https://ucapi-jtrl.onrender.com`. To run it:

```sh
npm start
```

That's it — open `http://localhost:8080`. You'll land on the sign-in page
first (demo login: `user` / `user` on the default backend); the whole site
requires a session before it'll show anything, matching the backend's own
auth rules.

Want to point at a different backend, or add a TMDb key? Copy
`.env.example` to `.env`, fill in what you need, and run `npm start` again
(no separate build step needed for the proxy target).

## Why there's a server.js at all

The backend doesn't send CORS headers, so calling it directly from a browser
on a different origin fails outright ("blocked by CORS policy"). Rather than
requiring backend changes, `server.js` serves the frontend **and**
transparently forwards every `/api-proxy/*` request to the real backend
server-side — browser-to-frontend and frontend-to-backend are each same-
process/same-origin hops, so CORS never applies. `js/config.js`'s `BASE_URL`
points at `/api-proxy` by default for exactly this reason.

It also fixes two things noticed while re-reading the backend's API docs:
- The backend's session cookie is set with `Secure` and sometimes a `Domain`
  attribute that don't survive being proxied cleanly — `server.js` strips
  both so login actually sticks.
- The backend sends `Content-Disposition: attachment` on every media
  response, which can make browsers force-download instead of playing
  inline. `server.js` rewrites that to `inline` so the Video.js player works.

`server.js` now also does two more things:
- **Response caching** — safe, idempotent `GET` JSON responses through the
  proxy are cached in memory per-session for `OTTFREE_CACHE_TTL_MS`
  (default 20s), so navigating around doesn't re-hit the backend for data
  that hasn't changed. Any admin mutation (create/edit/delete/send/config)
  or a manual "Reload" flushes it automatically.
- **A tiny local settings store** (`data/site-settings.json`) for the
  site-only features the real API has no concept of — ads, a notice banner,
  and maintenance mode. See "Admin: Ads / Site tabs" below.

Deploying somewhere that can't run `server.js` (a plain static host)? See
"Direct mode" in [DEPLOY.md](./DEPLOY.md) — it still works, but then the
backend itself needs proper CORS headers, and the ads/notice/maintenance
features won't be available (there's no server to back them).

## Pages

| File | Purpose |
|---|---|
| `index.html` | **Sign-in page — this is the site's root.** Every other page redirects here first if there's no active session (demo: `user` / `user`). |
| `home.html` | OTT row (circular channel avatars), Continue Watching, New Releases, Trending Now (TMDb-aware), Movies, TV Shows, Featured, and your playlists. |
| `channel.html?chat_id=` | Browse one channel, paginated with infinite scroll, plus in-channel search. |
| `playlist.html?db=` | Browse a playlist/folder: subfolders + files, plus search within it. |
| `search.html?q=` | Aggregated search. The API only exposes per-channel/per-playlist search, so this fans a query out across every channel from `GET /` and merges the results. |
| `watch.html?chat_id=&id=&hash=` | Video.js player + TMDb-sourced details + (for TV) an episode list. |
| `admin.html` | Folders, files, send-to-playlist, cache, config, **ads**, and **site management** (notice banner + maintenance mode). |
| `404.html` / `500.html` / `maintenance.html` | Styled fallback pages served automatically by `server.js`. |

## Login-first flow

`index.html` is the root and only ever shows the sign-in form. Every other
page calls a shared `OttfreeUtils.requireAuth()` guard as the first thing in
its `main()`: it checks `GET /login`'s session state and, if there's no
active session, redirects to `index.html?next=<page>` — so signing in sends
you right back to what you were trying to open. `admin.html` additionally
probes an admin-only route to confirm the session is actually an admin, not
just any logged-in user, and `server.js` does the same server-side check
before allowing settings changes or bypassing maintenance mode.

## The episode-filtering rule

Listings never show an episode file unless `episode` is `1` (or the file is
a movie, i.e. `episode` is `null`). That episode-1 card is the show's entry
point everywhere except the watch page. This is implemented once, in
`OttfreeUtils.filterListable()`, and applied on Home, Channel, Playlist, and
Search. The **watch page is the exception** — it deliberately fetches the
*full* episode list so people can jump between episodes without leaving the
player.

## The watch page: title, details, and episodes

- **Title is always the TMDb-sourced one** (`file.title`, which the backend
  already prefers over the raw Telegram caption when it has a match) — the
  Telegram caption itself is never shown anywhere on this page anymore.
- Year, genre tags, a ★ rating, and the TMDb overview are fetched and shown
  whenever `tmdb_id` is present and a TMDb key is configured.
- **Episode discovery is local-first.** `watch.js` scans the channel once
  per page load (up to `MAX_EPISODE_SCAN_PAGES`) for every file matching the
  show's `tmdb_id`, across every season — so the season switcher has real
  options even without a TMDb key. TMDb metadata (names, overviews, still
  images) is layered on top per season, lazily, when available.
- If TMDb isn't returning data, a small hint appears under the season
  picker explaining why (no key configured vs. the key being rejected) —
  the **#1 cause** of "episode names/thumbnails don't show up" is a TMDb key
  in the wrong format. TMDb's dashboard now hands out an "API Read Access
  Token" (a long token with dots in it) much more prominently than the
  classic "API Key (v3 auth)" (a short 32-character string), and only the
  latter works with a plain `?api_key=` query param. `js/utils.js`'s
  `tmdbFetch` auto-detects which one you pasted and calls TMDb the right way
  either way — so it doesn't matter which one you grab from
  https://www.themoviedb.org/settings/api.

## Home page sections

Since the backend's `GET /` only returns channels + playlists, everything
else is assembled client-side from a sample of channels
(`OTTFREE_CONFIG.HOME_CHANNEL_SAMPLE`):

- **OTT available** — circular channel avatars, tune into any of them.
- **Continue watching** — fully client-side, from playback positions saved
  in `localStorage` (see `OttfreeUtils.saveProgress`/`listContinueWatching`).
  Nothing is sent anywhere; it just lives in the browser.
- **New releases** — sorted by file ID (a reasonable proxy for "recently
  added" given the backend has no upload-date field).
- **Trending now** — cross-referenced against TMDb's actual
  `/trending/movie|tv/week` when a TMDb key is configured; falls back to a
  shuffle when it isn't, so the row is never empty either way.
- **Movies** / **TV shows** — split from the same sampled pool by
  `tmdb_type`.
- **Featured** and **Your playlists** — as before.

The hero banner uses a blurred, oversized "wash" of the art as an ambient
background (works whether we only have a portrait poster or a proper TMDb
landscape backdrop) with a properly-proportioned poster card on top — nothing
gets stretched to fill a mismatched aspect ratio anymore.

## Admin: Ads / Site tabs

Two new admin tabs, backed by `server.js`'s local settings store:

- **Ads** — paste a site-wide script from Monetag, Adsterra, or anywhere
  else. It's injected once per content page (not on `index.html` or
  `admin.html`) when enabled. "See test ad" renders it in a sandboxed
  `<iframe>` (`sandbox="allow-scripts allow-popups"`, no `allow-same-origin`)
  so you can check it before it goes live, isolated from the admin page's
  own session/cookies.
- **Site** — a dismissible notice banner shown site-wide, and a maintenance
  mode toggle that blocks every page except sign-in for non-admins. Both are
  enforced **server-side** in `server.js` (not just hidden by frontend JS),
  and maintenance mode never locks out a real admin session, so turning it
  on can't accidentally strand you.

Security notes for this part specifically:
- Writing settings requires (a) a verified admin session, checked against
  the real backend on every write (fails closed — any doubt, including the
  backend being unreachable, is treated as "not admin"), and (b) a custom
  `X-Requested-With` header that a plain cross-site form POST can't set,
  as basic CSRF protection.
- Settings reads are public by design — the notice/maintenance/ad config
  needs to be visible before login too.
- An ad snippet is arbitrary script by nature; the security boundary here is
  "only a verified admin can set what runs," not sanitizing the snippet
  itself (which would break real ad tags anyway).

## Video.js setup

`watch.html` loads Video.js 8 plus:
- **videojs-hotkeys** — space/arrow-key/volume shortcuts.
- **videojs-mobile-ui** — larger touch controls and tap-to-seek on phones.
- **videojs-landscape-fullscreen** — auto-rotates to fullscreen landscape on
  mobile when playback starts.

The player is initialized with **`fluid: true`**, which is what makes it
size itself to its container instead of the source video's native pixel
dimensions — without it, a large source file can force the player (and
everything around it) to blow out past the viewport, breaking the layout
site-wide. `css/style.css` backs this up with a `width: 100% !important`
safety net on `.video-js`.

Plus custom (non-plugin) behavior in `watch.js`: resume-from-last-position
and remembered volume via `localStorage`, continue-watching progress
tracking (see above), and auto-advance to the next episode on `ended` for
TV files.

## Responsive & TV-friendly

`css/style.css` has three tiers: mobile (`≤640px`), the default
laptop/desktop layout, and a `≥1600px` tier with larger type, larger cards,
and a thicker focus ring for D-pad/remote navigation. All interactive
elements use `:focus-visible` so keyboard/remote users always see where they
are. Grid/flex containers (`.watch-layout`, `.grid`, `.form-grid`, admin
tables) all get `min-width: 0` on their children as a safety net against any
single oversized child forcing horizontal scroll.

## Loading states

Nothing shows literal "Loading…" text anymore — page titles and similar
placeholders use a shimmering skeleton (`.skeleton` / `.skeleton-text`)
until real content arrives, consistent with the skeleton cards already used
throughout the grids and shelves.

## Configuration reference

Set these as real environment variables (Render dashboard) or in a local
`.env` (copy `.env.example`) — full details in [DEPLOY.md](./DEPLOY.md).

| Variable | Read by | Purpose |
|---|---|---|
| `OTTFREE_API_URL` | `server.js` (runtime) | The real backend to proxy to. Defaults to `https://ucapi-jtrl.onrender.com`. |
| `OTTFREE_USE_PROXY` | `npm run build` | Set to `false` to disable proxying and bake `OTTFREE_API_URL` straight into `BASE_URL` (direct mode — needs backend CORS). Default `true`. |
| `OTTFREE_TMDB_API_KEY` | `npm run build` | Baked into `js/config.js`'s `TMDB_API_KEY`. Either key format works — see "The watch page" above. |
| `OTTFREE_CACHE_TTL_MS` | `server.js` (runtime) | How long cached API GET responses are kept. Default `20000` (20s). Set to `0` to disable caching. |
| `OTTFREE_HOME_CHANNEL_SAMPLE` / `OTTFREE_MAX_EPISODE_SCAN_PAGES` | `npm run build` | Optional tuning knobs, same defaults as before. |
| `PORT` / `OTTFREE_PORT` | `server.js` (runtime) | Listen port. Render sets `PORT` itself. |

## Known limitations / things to wire up as you go

- `POST /send` is documented as **currently public** by the backend. The
  admin panel still gates it behind the admin UI for convenience, but it
  isn't actually protected until the backend requires auth on that route.
- The admin access check calls `GET /searchDbFol` as a probe (since
  `GET /login` doesn't return `is_admin` after the fact) — if you add a
  dedicated "am I admin" endpoint, swap `checkAccess()` in `js/admin.js`
  (and `verifyAdmin()` in `server.js`) to use it instead.
- TMDb calls are made directly from the browser with the API key visible in
  `config.js`. That's normal for TMDb's free v3 key (rate-limited, not
  billed), but don't reuse a paid/read-access-token that you want to keep
  private.
- Episode discovery only scans the channel the episode was opened from —
  cross-channel series aren't merged.
- The settings store and response cache are both per-process — on Render's
  free tier the service can spin down on idle, which resets the cache (fine,
  it's meant to be short-lived) and, since `data/` isn't a persistent disk
  on the free tier, can also reset saved ads/notice/maintenance settings on
  redeploys. Attach a persistent disk (Render's paid tiers) if you need
  those to survive restarts.
