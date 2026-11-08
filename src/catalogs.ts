// The home-screen rows. Order here = order on the TV. Stremio shows each row as "<name> - <Film|Serija>",
// so names deliberately don't repeat the type.
import type { MediaType } from "./genres";

export type Params = Record<string, string>;

export interface DiscoverCatalog {
  kind: "discover";
  id: string;
  type: MediaType;
  name: string;
  /** TMDB /discover parameters; a function so date windows are computed per request. */
  params: (today: string) => Params;
  /** Offer the Croatian genre dropdown in Discover. Off for rows that already are a genre. */
  genreFilter: boolean;
}

export interface StaticCatalog {
  kind: "static";
  id: string;
  type: MediaType;
  name: string;
  list: "top-movies" | "top-series";
}

export type CatalogDef = DiscoverCatalog | StaticCatalog;

export const EXYU_COUNTRIES = "HR|RS|BA|ME|SI|MK|YU|CS|XK";
/** Original language must be one of ours too, so foreign co-productions don't count as "domaće". */
export const EXYU_LANGUAGES = "hr|sr|bs|sh|sl|mk|cnr";

export function daysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Movies that can actually be streamed: they've had a digital or physical release. */
const watchableMovie = (today: string): Params => ({
  with_release_type: "4|5",
  "release_date.lte": today,
});

/** Series without talk shows, news, reality and soaps, already on air. */
const regularSeries = (today: string): Params => ({
  without_genres: "10763|10764|10767|10766",
  "first_air_date.lte": today,
});

const movieGenre = (
  id: string,
  name: string,
  genre: number | string,
  minVotes = 400,
  without?: string,
): DiscoverCatalog => ({
  kind: "discover",
  id,
  type: "movie",
  name,
  genreFilter: false,
  params: (today) => ({
    ...watchableMovie(today),
    with_genres: String(genre),
    ...(without ? { without_genres: without } : {}),
    sort_by: "popularity.desc",
    "vote_count.gte": String(minVotes),
    "vote_average.gte": "6",
  }),
});

const seriesGenre = (id: string, name: string, genres: string, minVotes = 150): DiscoverCatalog => ({
  kind: "discover",
  id,
  type: "series",
  name,
  genreFilter: false,
  params: (today) => ({
    ...regularSeries(today),
    with_genres: genres,
    sort_by: "popularity.desc",
    "vote_count.gte": String(minVotes),
    "vote_average.gte": "6.5",
  }),
});

export const CATALOGS: CatalogDef[] = [
  {
    kind: "discover",
    id: "popularno",
    type: "movie",
    name: "Popularno",
    genreFilter: true,
    params: (today) => ({ ...watchableMovie(today), sort_by: "popularity.desc", "vote_count.gte": "150" }),
  },
  {
    kind: "discover",
    id: "popularno",
    type: "series",
    name: "Popularno",
    genreFilter: true,
    params: (today) => ({
      ...regularSeries(today),
      without_genres: "10763|10764|10767|10766|16",
      sort_by: "popularity.desc",
      "vote_count.gte": "100",
    }),
  },
  {
    kind: "discover",
    id: "novo",
    type: "movie",
    name: "Novo za gledanje",
    genreFilter: true,
    params: (today) => ({
      with_release_type: "4|5",
      "release_date.gte": daysAgo(today, 150),
      "release_date.lte": today,
      sort_by: "popularity.desc",
      "vote_count.gte": "25",
    }),
  },
  {
    kind: "discover",
    id: "novo",
    type: "series",
    name: "Nove serije",
    genreFilter: true,
    params: (today) => ({
      ...regularSeries(today),
      without_genres: "10763|10764|10767|10766|16",
      "first_air_date.gte": daysAgo(today, 365),
      sort_by: "popularity.desc",
      "vote_count.gte": "20",
    }),
  },
  {
    kind: "discover",
    id: "domace",
    type: "movie",
    name: "Domaći filmovi",
    genreFilter: true,
    params: (today) => ({
      with_origin_country: EXYU_COUNTRIES,
      with_original_language: EXYU_LANGUAGES,
      // No horror: keeps notorious shock films (e.g. "Srpski film") off the family home screen.
      without_genres: "27",
      "release_date.lte": today,
      sort_by: "popularity.desc",
      "vote_count.gte": "10",
    }),
  },
  {
    kind: "discover",
    id: "domace",
    type: "series",
    name: "Domaće serije",
    genreFilter: true,
    params: (today) => ({
      with_origin_country: EXYU_COUNTRIES,
      with_original_language: EXYU_LANGUAGES,
      without_genres: "10763|10764|10767|27",
      "first_air_date.lte": today,
      sort_by: "popularity.desc",
      "vote_count.gte": "3",
    }),
  },
  {
    kind: "discover",
    id: "turske",
    type: "series",
    name: "Turske serije",
    genreFilter: true,
    params: (today) => ({
      with_origin_country: "TR",
      with_original_language: "tr",
      without_genres: "10763|10764|10767",
      "first_air_date.lte": today,
      sort_by: "popularity.desc",
      "vote_count.gte": "15",
    }),
  },
  { kind: "static", id: "najbolje", type: "movie", name: "Najbolje svih vremena", list: "top-movies" },
  { kind: "static", id: "najbolje", type: "series", name: "Najbolje svih vremena", list: "top-series" },

  // Genre rows: the most common genres first, always "Film" then "Serija" under the same name.
  // (TMDB series genres differ: action is "Action & Adventure", sci-fi is "Sci-Fi & Fantasy", war is "War & Politics".)
  movieGenre("komedija", "Komedija", 35),
  seriesGenre("komedija", "Komedija", "35"),
  movieGenre("akcija", "Akcija", 28),
  seriesGenre("akcija", "Akcija", "10759"),
  movieGenre("kriminalisticki", "Kriminalistički", 80),
  seriesGenre("kriminalisticke", "Kriminalistički", "80"),
  movieGenre("drama", "Drama", 18),
  seriesGenre("drama", "Drama", "18", 300),
  movieGenre("triler", "Triler i misterij", "53|9648"),
  seriesGenre("misterij", "Triler i misterij", "9648"),
  movieGenre("obiteljski", "Za djecu i obitelj", 10751, 300),
  seriesGenre("djecje", "Za djecu i obitelj", "10762|10751", 50),
  movieGenre("dokumentarni", "Dokumentarni", 99, 150, "35|10402"),
  seriesGenre("dokumentarne", "Dokumentarni", "99", 50),
  movieGenre("scifi", "Znanstvena fantastika", 878),
  seriesGenre("scifi", "Znanstvena fantastika", "10765"),
  movieGenre("ratni", "Ratni", 10752, 200),
  seriesGenre("ratni", "Ratni", "10768", 50),
  movieGenre("vestern", "Vestern", 37, 150),
  seriesGenre("vestern", "Vestern", "37", 20),

  // Film-only and series-only rows last: TMDB has no matching genre on the other side.
  movieGenre("romanticni", "Romantični", 10749, 300),
  {
    kind: "discover",
    id: "klasici",
    type: "movie",
    name: "Klasici",
    genreFilter: true,
    params: () => ({
      "primary_release_date.lte": "1989-12-31",
      sort_by: "popularity.desc",
      "vote_count.gte": "800",
      "vote_average.gte": "7",
    }),
  },
  movieGenre("povijesni", "Povijesni", 36, 200),
  {
    kind: "discover",
    id: "mini",
    type: "series",
    name: "Mini-serije",
    genreFilter: true,
    params: (today) => ({
      ...regularSeries(today),
      with_type: "2",
      sort_by: "popularity.desc",
      "vote_count.gte": "100",
      "vote_average.gte": "6.8",
    }),
  },
];

export function findCatalog(type: string, id: string): CatalogDef | undefined {
  return CATALOGS.find((c) => c.type === type && c.id === id);
}
