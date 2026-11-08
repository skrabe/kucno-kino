// TMDB has no Croatian genre names, so they live here. Keys are TMDB genre ids.
export type MediaType = "movie" | "series";

export const MOVIE_GENRES: Record<number, string> = {
  28: "Akcija",
  12: "Avantura",
  16: "Animirani",
  35: "Komedija",
  80: "Kriminalistički",
  99: "Dokumentarni",
  18: "Drama",
  10751: "Obiteljski",
  14: "Fantastika",
  36: "Povijesni",
  27: "Horor",
  10402: "Glazbeni",
  9648: "Misterij",
  10749: "Romantični",
  878: "Znanstvena fantastika",
  10770: "TV film",
  53: "Triler",
  10752: "Ratni",
  37: "Vestern",
};

export const TV_GENRES: Record<number, string> = {
  10759: "Akcija i avantura",
  16: "Animirani",
  35: "Komedija",
  80: "Kriminalistički",
  99: "Dokumentarni",
  18: "Drama",
  10751: "Obiteljski",
  10762: "Dječji",
  9648: "Misterij",
  10763: "Vijesti",
  10764: "Reality",
  10765: "Znanstvena fantastika i fantastika",
  10766: "Sapunica",
  10767: "Talk show",
  10768: "Rat i politika",
  37: "Vestern",
};

/** Genres offered in the Discover filter (talk shows, news etc. are left out on purpose). */
const FILTER_EXCLUDE = new Set([10770, 10763, 10764, 10767]);

export function genreTable(type: MediaType): Record<number, string> {
  return type === "movie" ? MOVIE_GENRES : TV_GENRES;
}

export function genreNames(type: MediaType, ids: number[] | undefined): string[] {
  const table = genreTable(type);
  return (ids ?? []).map((id) => table[id]).filter((n): n is string => Boolean(n));
}

export function genreFilterOptions(type: MediaType): string[] {
  return Object.entries(genreTable(type))
    .filter(([id]) => !FILTER_EXCLUDE.has(Number(id)))
    .map(([, name]) => name)
    .sort((a, b) => a.localeCompare(b, "hr"));
}

export function genreIdByName(type: MediaType, name: string): number | undefined {
  const entry = Object.entries(genreTable(type)).find(([, n]) => n === name);
  return entry ? Number(entry[0]) : undefined;
}
