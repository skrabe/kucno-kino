# Kućno kino

A Stremio add-on that turns the Stremio home screen into a Netflix-style set of live rows, with titles and
descriptions in Croatian. When a Croatian translation is missing it falls back to Bosnian, then Serbian
(Cyrillic is transliterated to Latin), then English. It runs on Cloudflare Workers.

Install: open `https://kucno-kino.batricp.workers.dev` and press **Instaliraj u Stremio**, or paste
`https://kucno-kino.batricp.workers.dev/manifest.json` into Stremio → Add-ons.

## What it does

- **About 30 home rows** that refresh by themselves:
  - Popular, new to watch, domestic (ex-Yu) films and series, Turkish series, classics.
  - The IMDb Top 250 films and series.
  - Genre rows.
- **Only playable films.** Every item has an IMDb id, so stream add-ons such as Torrentio work. Film rows only
  list titles that have had a digital or physical release.
- **Discover tab:** every general row has a genre filter with Croatian genre names.
- **Search in our languages.** TMDB search ignores translated titles, so this combines:
  - Wikidata, which has labels in hr/sr/bs in both Latin and Cyrillic.
  - TMDB title search.
  - People: `bud spencer` returns his films.

  Results are ranked by title match and how well-known the title is. `kum`, `kuca od papira` and
  `žikina dinastija` all work.
- **Detail pages in Croatian:**
  - Title, description, genres, director and cast.
  - Croatian poster when one exists, the logo, the trailer and the real IMDb rating.
  - Episode lists with Croatian text, falling back to English per episode.
  - If TMDB is down, it falls back to Cinemeta.

## Croatian stream list (relay on the TV box)

Torrentio lists around 75 raw torrent names per title, and it rate-limits requests coming from Cloudflare
(HTTP 429). So a tiny Go service, `box/kkproxy`, runs on the TV box itself:

- It listens on `127.0.0.1:11471` and is installed in Stremio as the add-on "Kućno kino · gledanje".
- It fetches the user's Torrentio + Real-Debrid results over the home connection and POSTs them to
  `/u/<STREAM_KEY>/curate` on the worker.
- The worker returns at most 6 entries labelled in Croatian, for example
  `★ Preporučeno · 3,3 GB / Kreće odmah`. It:
  - drops AV1 (this box can't decode it), CAM/TS releases and uncached items;
  - ranks dubs, multi-film packs and AI upscales last.

If the worker can't be reached, the relay serves the raw Torrentio list, so playback never depends on it.

**Install on the box (root):**

1. Copy the binary to `/vendor/bin/kkproxy`.
2. Put the config at `/data/kk/config.json` (mode 600):
   `{"torrentio": "<Torrentio URL incl. RD key>", "curate": "https://<worker>/u/<key>/curate"}`
3. Add `box/kkproxy.rc` to `/vendor/etc/init/`. Android's init starts the service at boot and restarts it if
   it dies.

**Build:** `cd box/kkproxy && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -ldflags "-s -w"`

## Using it as the metadata source

Put this add-on **first** in the Stremio add-on collection, so Stremio uses it for detail pages. Keep Cinemeta
later in the list as a fallback, with its catalogs removed so the English rows disappear.

## How it stays fast

- **Request budget:** each request counts its outbound calls, as a safety valve against runaway fan-out
  (`Budget` in `src/tmdb.ts`). The account is on Workers Paid.
- **D1 cache:**
  - Poster-tile data ("cards"), refreshed every ~5 days.
  - IMDb↔TMDB id map.
  - Trimmed episode lists per season (12 h for airing seasons, 30 days otherwise).
- **Edge cache:** responses are cached at the edge per deployment, and the TV app caches them too
  (`cacheMaxAge`, `staleError`).
- **Cron warm-up:** a job every 6 hours rebuilds every row through a service binding to itself, so each row
  gets its own budget. Viewers never wait on a cold cache.

## Develop

```sh
pnpm install
echo "TMDB_TOKEN=<TMDB API Read Access Token>" > .dev.vars
pnpm wrangler d1 migrations apply kucno-kino --local
pnpm dev                      # http://localhost:8787
pnpm test && pnpm typecheck
node scripts/smoke.mjs http://localhost:8787
```

**Deploy:** `pnpm deploy`. The worker needs three secrets:

- `TMDB_TOKEN`
- `WARM_KEY` (any random string)
- `STREAM_KEY` (any random string, also written into the box relay config)

**IMDb Top 250 data:** rebuild with `TMDB_TOKEN=... node scripts/build-top.mjs data/imdb-top-lists.json`. The
input is a list of IMDb ids taken from imdb.com/chart/top and /chart/toptv.

This product uses the TMDB API but is not endorsed or certified by TMDB. Data also comes from Wikidata (CC0).

## Box note: Dolby/DTS audio

The Amlogic AC3/E-AC3/DTS hardware decoders on this box output silence under the GSI. They are commented out in
`/vendor/etc/media_codecs.xml` (original kept as `media_codecs.xml.orig`), so Stremio's player decodes that
audio in software (FFmpeg) while video stays hardware-decoded.
