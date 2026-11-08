import { CATALOGS } from "./catalogs";
import { genreFilterOptions } from "./genres";

export const VERSION = "1.0.0";
export const SEARCH_ID = "pretraga";

export function buildManifest(origin: string) {
  const catalogs = CATALOGS.map((c) => {
    const extra: { name: string; isRequired?: boolean; options?: string[] }[] = [];
    if (c.kind === "discover" && c.genreFilter) {
      extra.push({ name: "genre", isRequired: false, options: genreFilterOptions(c.type) });
    }
    extra.push({ name: "skip" });
    return { type: c.type, id: c.id, name: c.name, extra };
  });
  for (const type of ["movie", "series"] as const) {
    catalogs.push({ type, id: SEARCH_ID, name: "Pretraga", extra: [{ name: "search", isRequired: true }] });
  }
  return {
    id: "hr.kucnokino",
    version: VERSION,
    name: "Kućno kino",
    description:
      "Filmovi i serije s naslovima i opisima na hrvatskom (ili bosanskom/srpskom kad hrvatskog nema): " +
      "popularno, novo, domaće, turske serije, klasici i žanrovi, uz pretragu na našem jeziku. " +
      "Podaci: TMDB i Wikidata. This product uses the TMDB API but is not endorsed or certified by TMDB.",
    logo: `${origin}/logo.png`,
    resources: ["catalog", { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] }],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    catalogs,
    behaviorHints: { configurable: false, configurationRequired: false },
  };
}
