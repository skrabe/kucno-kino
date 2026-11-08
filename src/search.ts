// Search that understands Croatian/Bosnian/Serbian titles.
// TMDB's own search ignores translated titles ("kum" doesn't find The Godfather), so we combine:
//   1. Wikidata full-text search over labels in every language (hr/sr/bs, Latin or Cyrillic) -> TMDB id
//   2. TMDB title search (original + English titles)
//   3. People: "bud spencer" -> his films
// and rank everything by how well a localized title matches plus how well-known the title is.
import { type Card, type Ctx, getCards, isReleased, type Ref, toPreview } from "./cards";
import type { MediaType } from "./genres";
import { BudgetExceeded, type TmdbPage } from "./tmdb";
import { fold, hasCyrillic, latToCyr } from "./text";

const MAX_RESULTS = 30;
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const UA = "KucnoKino/1.0 (Stremio add-on; https://github.com/skrabe/kucno-kino)";

interface Candidate {
  ref: Ref;
  wikiRank?: number;
  tmdbRank?: number;
  person?: boolean;
}

function sparqlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ")}"`;
}

/** One SPARQL round-trip: Wikidata search (Latin + Cyrillic spelling) joined to the TMDB id property. */
export function wikidataQuery(query: string, type: MediaType): string {
  const prop = type === "movie" ? "P4947" : "P4983";
  const variants = [...new Set([query, hasCyrillic(query) ? query : latToCyr(query)])];
  // The property join must sit inside each branch: outside the UNION the query planner scans every
  // film on Wikidata first and the query times out.
  const blocks = variants.map(
    (v, i) => `{ SERVICE wikibase:mwapi {
        bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "Search";
                        mwapi:srsearch ${sparqlString(`${v} haswbstatement:${prop}`)}; mwapi:srlimit "12".
        ?item wikibase:apiOutputItem mwapi:title. ?ord wikibase:apiOrdinal true. }
      ?item wdt:${prop} ?tmdb. BIND(${i} AS ?variant) }`,
  );
  return `SELECT ?tmdb (MIN(?variant * 100 + ?ord) AS ?rank) WHERE {
    ${blocks.join(" UNION ")}
  } GROUP BY ?tmdb ORDER BY ?rank LIMIT 15`;
}

/** A source that failed (timeout, 5xx) returns undefined so the response is only cached briefly. */
async function wikidataSearch(ctx: Ctx, query: string, type: MediaType): Promise<number[] | undefined> {
  try {
    ctx.budget.take();
    const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(wikidataQuery(query, type))}`;
    const res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json", "User-Agent": UA },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`wikidata ${res.status}`);
    const data = (await res.json()) as { results: { bindings: { tmdb: { value: string } }[] } };
    return data.results.bindings.map((b) => Number.parseInt(b.tmdb.value, 10)).filter((n) => Number.isFinite(n));
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) console.warn("wikidata search failed", String(e));
    return undefined;
  }
}

async function tmdbSearch(ctx: Ctx, query: string, type: MediaType): Promise<number[] | undefined> {
  try {
    const data = await ctx.tmdb.get<TmdbPage>(`/search/${type === "movie" ? "movie" : "tv"}`, {
      query,
      language: "hr-HR",
      include_adult: "false",
    });
    return data.results.filter((r) => !r.adult).map((r) => r.id);
  } catch (e) {
    console.warn("tmdb search failed", String(e));
    return undefined;
  }
}

interface PersonHit {
  id: number;
  name: string;
  popularity: number;
  known_for_department?: string;
}
interface Credit {
  id: number;
  popularity?: number;
  vote_count?: number;
  job?: string;
  episode_count?: number;
  genre_ids?: number[];
}

/** If the query is clearly a person's name, return their best-known titles of this type. */
async function personSearch(ctx: Ctx, query: string, type: MediaType): Promise<number[]> {
  const fq = fold(query);
  if (fq.length < 4 || !fq.includes(" ")) return [];
  try {
    const people = await ctx.tmdb.get<{ results: PersonHit[] }>("/search/person", { query, include_adult: "false" });
    const p = people.results[0];
    if (!p || p.popularity < 1) return [];
    const nameTokens = fold(p.name).split(" ");
    if (!fq.split(" ").every((t) => nameTokens.some((n) => n.startsWith(t)))) return [];
    const credits = await ctx.tmdb.get<{ cast: Credit[]; crew: Credit[] }>(
      `/person/${p.id}/${type === "movie" ? "movie_credits" : "tv_credits"}`,
      { language: "hr-HR" },
    );
    const directing = p.known_for_department === "Directing" || p.known_for_department === "Writing";
    const pool = directing ? credits.crew.filter((c) => c.job === "Director" || c.job === "Screenplay") : credits.cast;
    const seen = new Set<number>();
    return pool
      // Talk-show / news appearances are noise in a "films with this actor" list.
      .filter((c) => !(c.genre_ids ?? []).some((g) => g === 10767 || g === 10763 || g === 99))
      .sort((a, b) => (b.vote_count ?? 0) - (a.vote_count ?? 0))
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .slice(0, 15)
      .map((c) => c.id);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) console.warn("person search failed", String(e));
    return [];
  }
}

/** How well the query matches any of the card's titles (0 = no textual match). */
export function textScore(keys: string[], fq: string): number {
  let best = 0;
  const qTokens = fq.split(" ");
  // Very short queries ("kum") must match whole words, or "Kumar" and "Kumaré" crowd out "Kum".
  const partialOk = fq.length >= 4;
  for (const k of keys) {
    if (k === fq) return 70;
    const words = k.split(" ");
    if (k.startsWith(`${fq} `)) best = Math.max(best, 55);
    else if (partialOk && k.startsWith(fq)) best = Math.max(best, 50);
    else if (` ${k} `.includes(` ${fq} `)) best = Math.max(best, 45);
    else if (qTokens.every((t) => words.some((w) => (partialOk || t.length >= 4 ? w.startsWith(t) : w === t))))
      best = Math.max(best, 30);
  }
  return best;
}

export function scoreCard(card: Card, cand: Candidate, fq: string): number {
  const text = textScore(card.keys, fq);
  if (!text && cand.wikiRank === undefined && !cand.person && (cand.tmdbRank ?? 99) > 5) return -1;
  const fame = 15 * Math.log10(1 + card.votes);
  const wiki = cand.wikiRank === undefined ? 0 : Math.max(0, 12 - cand.wikiRank);
  const tmdb = cand.tmdbRank === undefined ? 0 : Math.max(0, 8 - cand.tmdbRank);
  const person = cand.person ? 35 : 0;
  return text + fame + wiki + tmdb + person;
}

export async function searchHandler(ctx: Ctx, type: MediaType, rawQuery: string) {
  const query = rawQuery.trim().replace(/\s+/g, " ").slice(0, 100);
  const fq = fold(query);
  if (!fq) return { metas: [], complete: true };

  const [wiki, tmdb, person] = await Promise.all([
    wikidataSearch(ctx, query, type),
    tmdbSearch(ctx, query, type),
    personSearch(ctx, query, type),
  ]);

  const cands = new Map<number, Candidate>();
  const get = (id: number) => {
    let c = cands.get(id);
    if (!c) cands.set(id, (c = { ref: { type, tmdb: id } }));
    return c;
  };
  (wiki ?? []).forEach((id, i) => {
    const c = get(id);
    c.wikiRank ??= i;
  });
  (tmdb ?? []).slice(0, 15).forEach((id, i) => {
    const c = get(id);
    c.tmdbRank ??= i;
  });
  for (const id of person) get(id).person = true;

  const list = [...cands.values()].slice(0, 40);
  const { cards, complete } = await getCards(
    ctx,
    list.map((c) => c.ref),
  );
  const byId = new Map(list.map((c) => [c.ref.tmdb, c]));
  const ranked = cards
    .filter((c) => isReleased(c, ctx.today))
    .map((card) => ({ card, score: scoreCard(card, byId.get(card.tmdb)!, fq) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS);
  return { metas: ranked.map((x) => toPreview(x.card)), complete: complete && wiki !== undefined && tmdb !== undefined };
}
