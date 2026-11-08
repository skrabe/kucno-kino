import top from "../data/top.json";
import { type Ctx, getCards, isReleased, type Ref, toPreview } from "./cards";
import type { CatalogDef } from "./catalogs";
import { genreIdByName } from "./genres";
import type { TmdbPage } from "./tmdb";

export const TMDB_PAGE = 20;
const STATIC_PAGE = 20;
/** TMDB refuses pages above 500. */
const MAX_PAGE = 500;

export interface CatalogResult {
  metas: ReturnType<typeof toPreview>[];
  /** False when some posters were skipped to stay within the request budget; caller caches briefly. */
  complete: boolean;
}

/**
 * Stremio sends `skip` = number of items it already has. Our pages hold up to 20 items (a few may be
 * dropped as unplayable), so rounding maps the running total back to the TMDB page reliably.
 */
export function pageForSkip(skip: number): number | undefined {
  const page = Math.max(1, Math.round(Math.max(0, skip) / TMDB_PAGE) + 1);
  return page > MAX_PAGE ? undefined : page;
}

export async function catalogHandler(
  ctx: Ctx,
  def: CatalogDef,
  extra: { skip?: string; genre?: string },
): Promise<CatalogResult> {
  const skip = Number.parseInt(extra.skip ?? "0", 10) || 0;

  if (def.kind === "static") {
    const list = def.list === "top-movies" ? top.movies : top.series;
    const refs: Ref[] = list.slice(skip, skip + STATIC_PAGE).map((x) => ({ type: def.type, tmdb: x.tmdb }));
    if (!refs.length) return { metas: [], complete: true };
    const { cards, complete } = await getCards(ctx, refs);
    return { metas: cards.map(toPreview), complete };
  }

  const params: Record<string, string> = { ...def.params(ctx.today) };
  if (extra.genre) {
    const id = genreIdByName(def.type, extra.genre);
    if (id === undefined) return { metas: [], complete: true };
    params.with_genres = params.with_genres ? `${params.with_genres},${id}` : String(id);
  }
  const page = pageForSkip(skip);
  if (page === undefined || (skip > 0 && page === 1)) return { metas: [], complete: true };
  const data = await ctx.tmdb.get<TmdbPage>(`/discover/${def.type === "movie" ? "movie" : "tv"}`, {
    ...params,
    language: "hr-HR",
    include_adult: "false",
    page,
  });
  if (page > data.total_pages) return { metas: [], complete: true };
  const refs: Ref[] = data.results
    .filter((r) => !r.adult && r.poster_path)
    .map((r) => ({ type: def.type, tmdb: r.id }));
  const { cards, complete } = await getCards(ctx, refs);
  return { metas: cards.filter((c) => isReleased(c, ctx.today)).map(toPreview), complete };
}
