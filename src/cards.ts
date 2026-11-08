// A "card" is everything a poster tile needs: IMDb id (for streams), localized title/description, art.
// Cards are built from TMDB details + translations and cached in D1, so a row normally costs 1 TMDB call.
import { genreNames, type MediaType } from "./genres";
import { Budget, BudgetExceeded, type Env, img, Tmdb, type TmdbListItem } from "./tmdb";
import { cyrToLat, fold, formatRuntime, pickTranslation, type Translation } from "./text";

export interface Ctx {
  env: Env;
  tmdb: Tmdb;
  budget: Budget;
  /** Language chain, e.g. ["hr","bs","sr","sh","en"]. */
  chain: string[];
  /** YYYY-MM-DD (UTC). */
  today: string;
  waitUntil(p: Promise<unknown>): void;
}

export interface Card {
  imdb: string;
  tmdb: number;
  type: MediaType;
  name: string;
  poster?: string;
  background?: string;
  description?: string;
  releaseInfo?: string;
  runtime?: string;
  genres: string[];
  popularity: number;
  votes: number;
  /** First release / air date (YYYY-MM-DD); compared to "today" at request time. */
  date?: string;
  /** Folded titles in every language we know, for search ranking. */
  keys: string[];
}

type Cached = Card | { missing: true };

const CARD_VERSION = 3;
const CARD_TTL_S = 5 * 24 * 3600;
const MISSING_TTL_S = 2 * 24 * 3600;
const MAP_TTL_S = 365 * 24 * 3600;
/** Calls kept in reserve for the final steps of a request (search fan-out, edge cache put). */
const RESERVE = 2;

export const cardKey = (type: MediaType, tmdb: number) => `c${CARD_VERSION}:${type}:${tmdb}`;
const imdbKey = (imdb: string) => `i:${imdb}`;

const SLAVIC = new Set(["hr", "bs", "sr", "sh", "sl", "mk", "cnr"]);

export interface TmdbDetails extends TmdbListItem {
  runtime?: number | null;
  episode_run_time?: number[];
  last_air_date?: string | null;
  status?: string;
  genres?: { id: number; name: string }[];
  imdb_id?: string | null;
  external_ids?: { imdb_id?: string | null; wikidata_id?: string | null };
  translations?: { translations: Translation[] };
}

/** Localized title: first language in the chain that has one; else original title for ex-Yu films; else English. */
export function pickTitle(d: TmdbDetails, type: MediaType, chain: string[]): string {
  const field = type === "movie" ? "title" : "name";
  const original = (type === "movie" ? d.original_title : d.original_name) ?? "";
  const local = pickTranslation(d.translations?.translations, chain.filter((l) => l !== "en"), field);
  if (local) return local.text;
  if (original && SLAVIC.has(d.original_language ?? "")) return cyrToLat(original);
  const en = pickTranslation(d.translations?.translations, ["en"], field);
  if (en) return en.text;
  return cyrToLat(original || (type === "movie" ? d.title : d.name) || "");
}

export function pickOverview(d: TmdbDetails, chain: string[]): string | undefined {
  return pickTranslation(d.translations?.translations, chain, "overview")?.text ?? (d.overview?.trim() || undefined);
}

function allTitles(d: TmdbDetails, type: MediaType, name: string): string[] {
  const field = type === "movie" ? "title" : "name";
  const keys = new Set<string>([fold(name)]);
  for (const t of [d.original_title, d.original_name, d.title, d.name]) if (t) keys.add(fold(t));
  for (const tr of d.translations?.translations ?? []) {
    const v = tr.data[field];
    if (v && ["hr", "bs", "sr", "sh", "en"].includes(tr.iso_639_1)) keys.add(fold(v));
  }
  keys.delete("");
  return [...keys];
}

export function releaseInfo(d: TmdbDetails, type: MediaType): string | undefined {
  if (type === "movie") return d.release_date?.slice(0, 4) || undefined;
  const start = d.first_air_date?.slice(0, 4);
  if (!start) return undefined;
  const ended = d.status === "Ended" || d.status === "Canceled";
  const end = d.last_air_date?.slice(0, 4);
  if (ended) return end && end !== start ? `${start}–${end}` : start;
  return `${start}–`;
}

export function isReleased(c: Card, today: string): boolean {
  return Boolean(c.date && c.date <= today);
}

export function buildCard(d: TmdbDetails, type: MediaType, chain: string[]): Cached {
  const imdb = (d.external_ids?.imdb_id || d.imdb_id || "").trim();
  if (!/^tt\d+$/.test(imdb) || d.adult) return { missing: true };
  const name = pickTitle(d, type, chain);
  const date = type === "movie" ? d.release_date : d.first_air_date;
  const minutes = type === "movie" ? d.runtime : d.episode_run_time?.[0];
  return {
    imdb,
    tmdb: d.id,
    type,
    name,
    poster: img(d.poster_path, "w342"),
    background: img(d.backdrop_path, "w1280"),
    description: pickOverview(d, chain),
    releaseInfo: releaseInfo(d, type),
    runtime: formatRuntime(minutes ?? undefined),
    genres: genreNames(type, d.genres?.map((g) => g.id) ?? d.genre_ids),
    popularity: d.popularity ?? 0,
    votes: d.vote_count ?? 0,
    date: date || undefined,
    keys: allTitles(d, type, name),
  };
}

export const tmdbPath = (type: MediaType, id: number) => `/${type === "movie" ? "movie" : "tv"}/${id}`;

export async function fetchDetails(
  ctx: Ctx,
  type: MediaType,
  id: number,
  extra: string[] = [],
  params: Record<string, string> = {},
): Promise<TmdbDetails> {
  return ctx.tmdb.get<TmdbDetails>(tmdbPath(type, id), {
    ...params,
    language: "hr-HR",
    append_to_response: ["external_ids", "translations", ...extra].join(","),
  });
}

// ---- D1 cache -------------------------------------------------------------------------------

export async function readCache(env: Env, keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!keys.length) return out;
  const now = Math.floor(Date.now() / 1000);
  try {
    for (let i = 0; i < keys.length; i += 90) {
      const chunk = keys.slice(i, i + 90);
      const { results } = await env.DB.prepare(
        `SELECT key, json FROM cards WHERE expires > ? AND key IN (${chunk.map(() => "?").join(",")})`,
      )
        .bind(now, ...chunk)
        .all<{ key: string; json: string }>();
      for (const r of results) out.set(r.key, JSON.parse(r.json));
    }
  } catch (e) {
    console.warn("D1 read failed", e);
  }
  return out;
}

export async function writeCache(env: Env, rows: { key: string; value: unknown; ttl: number }[]): Promise<void> {
  if (!rows.length) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = env.DB.prepare("INSERT OR REPLACE INTO cards (key, json, expires) VALUES (?, ?, ?)");
  try {
    // Jitter TTLs so a whole row never expires at the same moment.
    await env.DB.batch(
      rows.map((r) => stmt.bind(r.key, JSON.stringify(r.value), now + Math.round(r.ttl * (0.85 + Math.random() * 0.3)))),
    );
  } catch (e) {
    console.warn("D1 write failed", e);
  }
}

export interface Ref {
  type: MediaType;
  tmdb: number;
}

/**
 * Cards for the given TMDB items, in input order. Items that have no IMDb id (unplayable) are dropped.
 * Cache misses are fetched in parallel within the request budget; anything over budget is skipped
 * this time and will be filled by the next request (or the cron warm-up).
 */
export async function getCards(ctx: Ctx, refs: Ref[]): Promise<{ cards: Card[]; complete: boolean }> {
  const unique = [...new Map(refs.map((r) => [cardKey(r.type, r.tmdb), r])).values()];
  const cached = await readCache(ctx.env, unique.map((r) => cardKey(r.type, r.tmdb)));
  const misses = unique.filter((r) => !cached.has(cardKey(r.type, r.tmdb)));
  const affordable = misses.slice(0, Math.max(0, ctx.budget.left - RESERVE));
  const fresh = await Promise.all(
    affordable.map(async (r) => {
      try {
        const d = await fetchDetails(ctx, r.type, r.tmdb);
        return { r, card: buildCard(d, r.type, ctx.chain) };
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) console.warn("card fetch failed", r, String(e));
        return undefined;
      }
    }),
  );
  const writes: { key: string; value: unknown; ttl: number }[] = [];
  for (const f of fresh) {
    if (!f) continue;
    const key = cardKey(f.r.type, f.r.tmdb);
    cached.set(key, f.card);
    if ("missing" in f.card) {
      writes.push({ key, value: f.card, ttl: MISSING_TTL_S });
    } else {
      writes.push({ key, value: f.card, ttl: CARD_TTL_S });
      writes.push({ key: imdbKey(f.card.imdb), value: { type: f.r.type, tmdb: f.r.tmdb }, ttl: MAP_TTL_S });
    }
  }
  ctx.waitUntil(writeCache(ctx.env, writes));
  const complete = unique.every((r) => cached.has(cardKey(r.type, r.tmdb)));
  const cards = refs
    .map((r) => cached.get(cardKey(r.type, r.tmdb)) as Cached | undefined)
    .filter((c): c is Card => Boolean(c && !("missing" in c)));
  return { cards, complete };
}

/** IMDb id -> TMDB id, via D1 first and TMDB /find second. */
export async function resolveImdb(ctx: Ctx, type: MediaType, imdb: string): Promise<number | undefined> {
  const hit = (await readCache(ctx.env, [imdbKey(imdb)])).get(imdbKey(imdb)) as Ref | undefined;
  if (hit?.type === type) return hit.tmdb;
  const found = await ctx.tmdb.get<{ movie_results: TmdbListItem[]; tv_results: TmdbListItem[] }>(`/find/${imdb}`, {
    external_source: "imdb_id",
  });
  const item = (type === "movie" ? found.movie_results : found.tv_results)[0];
  if (!item) return undefined;
  ctx.waitUntil(writeCache(ctx.env, [{ key: imdbKey(imdb), value: { type, tmdb: item.id }, ttl: MAP_TTL_S }]));
  return item.id;
}

/** The Stremio "meta preview" shown on a poster tile and in the home-screen hero. */
export function toPreview(c: Card) {
  return {
    id: c.imdb,
    type: c.type,
    name: c.name,
    poster: c.poster,
    posterShape: "poster",
    background: c.background,
    description: c.description,
    releaseInfo: c.releaseInfo,
    runtime: c.runtime,
    genres: c.genres,
  };
}
