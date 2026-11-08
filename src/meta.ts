// Full detail page for a movie or series, in the viewer's language, with a Cinemeta safety net.
import {
  type Ctx,
  fetchDetails,
  pickOverview,
  pickTitle,
  readCache,
  releaseInfo,
  resolveImdb,
  type TmdbDetails,
  writeCache,
} from "./cards";
import { genreFilterOptions, genreNames, type MediaType } from "./genres";
import { img } from "./tmdb";
import { cyrToLat, formatRuntime } from "./text";

const CINEMETA = "https://v3-cinemeta.strem.io";
const LOCAL_LANGS = ["hr", "bs", "sr", "sh"];

interface Image {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  width: number;
}
interface Video {
  key: string;
  site: string;
  type: string;
  official: boolean;
  iso_639_1: string;
  name: string;
}
interface Person {
  name: string;
  job?: string;
  department?: string;
  order?: number;
}
interface Episode {
  episode_number: number;
  season_number: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  still_path?: string | null;
  runtime?: number | null;
}
interface Season {
  season_number: number;
  episodes?: Episode[];
}

interface FullDetails extends TmdbDetails {
  images?: { posters: Image[]; backdrops: Image[]; logos: Image[] };
  videos?: { results: Video[] };
  credits?: { cast: Person[]; crew: Person[] };
  created_by?: { name: string }[];
  production_countries?: { iso_3166_1: string }[];
  origin_country?: string[];
  seasons?: { season_number: number; episode_count: number }[];
  [season: `season/${number}`]: Season | undefined;
}

function bestImage(images: Image[] | undefined, langs: (string | null)[]): Image | undefined {
  for (const lang of langs) {
    const pool = (images ?? []).filter((i) => i.iso_639_1 === lang);
    if (pool.length) return pool.sort((a, b) => b.vote_average - a.vote_average)[0];
  }
  return undefined;
}

function bestTrailer(videos: Video[] | undefined): Video | undefined {
  const yt = (videos ?? []).filter((v) => v.site === "YouTube");
  const rank = (v: Video) =>
    (v.type === "Trailer" ? 0 : v.type === "Teaser" ? 10 : 20) +
    (LOCAL_LANGS.includes(v.iso_639_1) ? 0 : v.iso_639_1 === "en" ? 3 : 6) +
    (v.official ? 0 : 1);
  return yt.sort((a, b) => rank(a) - rank(b))[0];
}

const countryNames = (() => {
  try {
    return new Intl.DisplayNames(["hr"], { type: "region" });
  } catch {
    return undefined;
  }
})();

const GENERIC_EPISODE = /^(epizoda|episode|епизода)\s*\d+$/i;

async function cinemetaMeta(type: MediaType, imdb: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`${CINEMETA}/meta/${type}/${imdb}.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    return ((await res.json()) as { meta?: Record<string, unknown> }).meta ?? undefined;
  } catch {
    return undefined;
  }
}

/** Series with more episodes than this skip the Cinemeta call: its JSON for long shows is ~1 MB. */
const CINEMETA_MAX_EPISODES = 150;

export async function metaHandler(ctx: Ctx, type: MediaType, imdb: string, manifestUrl: string) {
  // Cinemeta gives the real IMDb rating, and is the safety net when TMDB fails.
  let cinemetaP: Promise<Record<string, unknown> | undefined> | undefined;
  const cinemeta = () => {
    if (!cinemetaP) {
      ctx.budget.take();
      cinemetaP = cinemetaMeta(type, imdb);
    }
    return cinemetaP;
  };
  const fallback = async () => {
    const m = await cinemeta().catch(() => undefined);
    return m ? { meta: m, fallback: true } : undefined;
  };
  if (type === "movie") void cinemeta();

  let d: FullDetails;
  let episodes: SlimEpisode[] = [];
  try {
    const tmdbId = await resolveImdb(ctx, type, imdb);
    if (tmdbId === undefined) return fallback();
    d = (await fetchDetails(ctx, type, tmdbId, ["credits", "videos", "images"], {
      include_image_language: "hr,bs,sr,en,null",
      include_video_language: "hr,bs,sr,en,null",
    })) as FullDetails;
    if (type === "series") {
      const total = (d.seasons ?? []).reduce((n, s) => n + s.episode_count, 0);
      if (total <= CINEMETA_MAX_EPISODES) void cinemeta();
      episodes = await seasonEpisodes(ctx, d);
    }
  } catch (e) {
    console.warn("TMDB meta failed, using Cinemeta", imdb, String(e));
    return fallback();
  }

  const name = pickTitle(d, type, ctx.chain);
  const description = pickOverview(d, ctx.chain);
  const poster = bestImage(d.images?.posters, [...LOCAL_LANGS, "en"])?.file_path ?? d.poster_path;
  const background = bestImage(d.images?.backdrops, [null, "xx", "en"])?.file_path ?? d.backdrop_path;
  // Only a logo in our language: an English logo would put the English title back on the page.
  const logo = bestImage(d.images?.logos, LOCAL_LANGS);
  const trailer = bestTrailer(d.videos?.results);
  const crew = d.credits?.crew ?? [];
  const directors = [...new Set(crew.filter((c) => c.job === "Director").map((c) => c.name))];
  const writers = [
    ...new Set(crew.filter((c) => c.job === "Screenplay" || c.job === "Writer" || c.job === "Novel").map((c) => c.name)),
  ].slice(0, 4);
  const creators = (d.created_by ?? []).map((c) => c.name);
  const cast = (d.credits?.cast ?? [])
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 10)
    .map((c) => cyrToLat(c.name));
  const genres = genreNames(type, d.genres?.map((g) => g.id));
  const countries = (type === "movie" ? d.production_countries?.map((c) => c.iso_3166_1) : d.origin_country) ?? [];
  const country = countries.map((c) => countryNames?.of(c) ?? c).join(", ") || undefined;
  const cm = cinemetaP ? await cinemetaP : undefined;
  const imdbRating = typeof cm?.imdbRating === "string" && cm.imdbRating ? cm.imdbRating : undefined;
  const minutes = type === "movie" ? d.runtime : d.episode_run_time?.[0];
  const date = type === "movie" ? d.release_date : d.first_air_date;

  const filterable = new Set(genreFilterOptions(type));
  const discover = (genre: string) =>
    `stremio:///discover/${encodeURIComponent(manifestUrl)}/${type}/popularno?genre=${encodeURIComponent(genre)}`;
  const search = (q: string) => `stremio:///search?search=${encodeURIComponent(q)}`;
  const links = [
    ...(imdbRating ? [{ name: imdbRating, category: "imdb", url: `https://imdb.com/title/${imdb}` }] : []),
    ...genres
      .filter((g) => filterable.has(g))
      .map((g) => ({ name: g, category: "Genres", url: discover(g) })),
    ...(type === "movie" ? directors : creators).map((n) => ({ name: n, category: "Directors", url: search(n) })),
    ...writers.map((n) => ({ name: n, category: "Writers", url: search(n) })),
    ...cast.map((n) => ({ name: n, category: "Cast", url: search(n) })),
  ];

  const meta: Record<string, unknown> = {
    id: imdb,
    imdb_id: imdb,
    type,
    name,
    description,
    poster: img(poster, "w500"),
    posterShape: "poster",
    background: img(background, "w1280"),
    logo: logo ? img(logo.file_path, "w500") : undefined,
    releaseInfo: releaseInfo(d, type),
    released: date ? `${date}T00:00:00.000Z` : undefined,
    year: releaseInfo(d, type),
    runtime: formatRuntime(minutes ?? undefined),
    genres,
    genre: genres,
    director: type === "movie" ? directors : creators,
    writer: writers,
    cast,
    country,
    imdbRating,
    links,
    trailers: trailer ? [{ source: trailer.key, type: "Trailer" }] : [],
    trailerStreams: trailer ? [{ title: trailer.name, ytId: trailer.key }] : [],
    behaviorHints: type === "movie" ? { defaultVideoId: imdb, hasScheduledVideos: false } : { hasScheduledVideos: d.status === "Returning Series" },
  };

  if (type === "series") meta.videos = toVideos(episodes, imdb);

  return { meta, fallback: false };
}

// ---- Episodes ---------------------------------------------------------------------------------
// TMDB season payloads are heavy (guest stars, crew), so each season is trimmed once and kept in D1.
// Long shows then cost one small D1 read instead of megabytes of JSON per request.

interface SlimEpisode {
  s: number;
  e: number;
  t: string;
  o: string;
  d?: string;
  i?: string;
  r?: string;
}

const seasonKey = (tvId: number, season: number) => `ep1:${tvId}:${season}`;

async function fetchSeasonGroup(ctx: Ctx, tvId: number, seasons: number[], language: string): Promise<Map<number, Episode[]>> {
  const out = new Map<number, Episode[]>();
  const groups: number[][] = [];
  for (let i = 0; i < seasons.length; i += 20) groups.push(seasons.slice(i, i + 20));
  await Promise.all(
    groups.map(async (g) => {
      const d = await ctx.tmdb.get<FullDetails>(`/tv/${tvId}`, {
        language,
        append_to_response: g.map((n) => `season/${n}`).join(","),
      });
      for (const n of g) out.set(n, d[`season/${n}`]?.episodes ?? []);
    }),
  );
  return out;
}

const needsFallback = (e: Episode) => !e.overview?.trim() || !e.name || GENERIC_EPISODE.test(e.name);

function slim(e: Episode, en: Episode | undefined): SlimEpisode {
  const localName = e.name && !GENERIC_EPISODE.test(e.name) ? e.name : undefined;
  const enName = en?.name && !GENERIC_EPISODE.test(en.name) ? en.name : undefined;
  return {
    s: e.season_number,
    e: e.episode_number,
    t: cyrToLat(localName ?? enName ?? `Epizoda ${e.episode_number}`),
    o: cyrToLat(e.overview?.trim() || en?.overview?.trim() || ""),
    d: e.air_date || undefined,
    i: e.still_path || undefined,
    r: formatRuntime(e.runtime ?? undefined),
  };
}

export async function seasonEpisodes(ctx: Ctx, d: FullDetails): Promise<SlimEpisode[]> {
  const numbers = (d.seasons ?? []).filter((s) => s.episode_count > 0).map((s) => s.season_number);
  if (!numbers.length) return [];
  const cached = await readCache(ctx.env, numbers.map((n) => seasonKey(d.id, n)));
  const missing = numbers.filter((n) => !cached.has(seasonKey(d.id, n)));
  const fresh = new Map<number, SlimEpisode[]>();
  if (missing.length) {
    const local = await fetchSeasonGroup(ctx, d.id, missing, "hr-HR");
    // English only for seasons where a noticeable share of episodes has no Croatian text.
    const weak = missing.filter((n) => {
      const eps = local.get(n) ?? [];
      return eps.length > 0 && eps.filter(needsFallback).length > eps.length * 0.2;
    });
    let english = new Map<number, Episode[]>();
    if (weak.length && ctx.budget.left > Math.ceil(weak.length / 20) + 2) {
      english = await fetchSeasonGroup(ctx, d.id, weak, "en-US").catch(() => new Map());
    }
    const lastSeason = Math.max(...numbers);
    const airing = d.status === "Returning Series" || d.status === "In Production";
    const writes = [];
    for (const n of missing) {
      const enByEp = new Map((english.get(n) ?? []).map((e) => [e.episode_number, e]));
      const eps = (local.get(n) ?? []).map((e) => slim(e, enByEp.get(e.episode_number)));
      fresh.set(n, eps);
      // A season still airing changes weekly; finished seasons almost never.
      const ttl = airing && n >= lastSeason - 1 ? 12 * 3600 : 30 * 24 * 3600;
      if (eps.length) writes.push({ key: seasonKey(d.id, n), value: eps, ttl });
    }
    ctx.waitUntil(writeCache(ctx.env, writes));
  }
  const all = numbers.flatMap((n) => (fresh.get(n) ?? (cached.get(seasonKey(d.id, n)) as SlimEpisode[] | undefined) ?? []));
  // Regular seasons in order, specials (season 0) last, so "next episode" never jumps into specials.
  const order = (x: SlimEpisode) => (x.s === 0 ? 1e6 : x.s) * 10000 + x.e;
  return all.sort((a, b) => order(a) - order(b));
}

function toVideos(eps: SlimEpisode[], imdb: string) {
  return eps.map((e) => ({
    id: `${imdb}:${e.s}:${e.e}`,
    title: e.t,
    season: e.s,
    episode: e.e,
    number: e.e,
    released: e.d ? `${e.d}T00:00:00.000Z` : undefined,
    overview: e.o,
    thumbnail: img(e.i, "w300"),
    runtime: e.r,
  }));
}
