import { describe, expect, it } from "vitest";
import { buildCard, isReleased, pickTitle, releaseInfo, type Card, type TmdbDetails } from "../src/cards";
import { pageForSkip } from "../src/catalog-handler";
import { CATALOGS, daysAgo } from "../src/catalogs";
import { genreFilterOptions, genreIdByName } from "../src/genres";
import { buildManifest } from "../src/manifest";
import { textScore, wikidataQuery } from "../src/search";
import { cyrToLat, fold, formatRuntime, latToCyr, pickTranslation, type Translation } from "../src/text";

const CHAIN = ["hr", "bs", "sr", "sh", "en"];
const tr = (lang: string, country: string, data: Translation["data"]): Translation => ({
  iso_639_1: lang,
  iso_3166_1: country,
  data,
});

describe("text", () => {
  it("transliterates Serbian Cyrillic, including digraphs", () => {
    expect(cyrToLat("Кућа од папира")).toBe("Kuća od papira");
    expect(cyrToLat("ЉУБАВ")).toBe("LJUBAV");
    expect(cyrToLat("Љубав")).toBe("Ljubav");
    expect(cyrToLat("Џон")).toBe("Džon");
  });
  it("round-trips Latin to Cyrillic for search", () => {
    expect(latToCyr("kum")).toBe("кум");
    expect(latToCyr("Ljubljana")).toBe("љубљана");
  });
  it("folds diacritics, script and punctuation", () => {
    expect(fold("Kuća od papira")).toBe("kuca od papira");
    expect(fold("Кућа од папира")).toBe("kuca od papira");
    expect(fold("Đorđe")).toBe("djordje");
    expect(fold("  Star Wars: Epizoda IV ")).toBe("star wars epizoda iv");
  });
  it("picks translations along the chain and prefers the home country", () => {
    const t = [
      tr("en", "US", { overview: "English" }),
      tr("sr", "RS", { overview: "Српски опис" }),
      tr("hr", "HR", { overview: "" }),
    ];
    expect(pickTranslation(t, CHAIN, "overview")).toEqual({ text: "Srpski opis", lang: "sr" });
    const t2 = [tr("hr", "BA", { overview: "BA" }), tr("hr", "HR", { overview: "HR" })];
    expect(pickTranslation(t2, CHAIN, "overview")?.text).toBe("HR");
  });
  it("formats runtimes", () => {
    expect(formatRuntime(175)).toBe("2 h 55 min");
    expect(formatRuntime(120)).toBe("2 h");
    expect(formatRuntime(45)).toBe("45 min");
    expect(formatRuntime(0)).toBeUndefined();
  });
});

const godfather: TmdbDetails = {
  id: 238,
  title: "Kum",
  original_title: "The Godfather",
  original_language: "en",
  release_date: "1972-03-14",
  runtime: 175,
  genres: [
    { id: 18, name: "Drama" },
    { id: 80, name: "Crime" },
  ],
  poster_path: "/p.jpg",
  backdrop_path: "/b.jpg",
  vote_count: 23936,
  popularity: 47,
  external_ids: { imdb_id: "tt0068646" },
  translations: {
    translations: [
      tr("en", "US", { title: "", overview: "Spanning the years 1945 to 1955" }),
      tr("sr", "RS", { title: "Кум", overview: "Српски" }),
      tr("hr", "HR", { title: "Kum", overview: "Po povratku iz Drugoga svjetskog rata" }),
    ],
  },
};

describe("cards", () => {
  it("builds a Croatian card with IMDb id and Croatian genres", () => {
    const c = buildCard(godfather, "movie", CHAIN);
    expect(c).toMatchObject({
      imdb: "tt0068646",
      name: "Kum",
      description: "Po povratku iz Drugoga svjetskog rata",
      releaseInfo: "1972",
      runtime: "2 h 55 min",
      genres: ["Drama", "Kriminalistički"],
      date: "1972-03-14",
    });
    expect("keys" in c && c.keys).toEqual(expect.arrayContaining(["kum", "the godfather"]));
  });
  it("drops titles without an IMDb id (no streams possible)", () => {
    expect(buildCard({ ...godfather, external_ids: {} }, "movie", CHAIN)).toEqual({ missing: true });
  });
  it("falls back to Serbian (Latin), then original for ex-Yu films, then English", () => {
    const sr = { ...godfather, translations: { translations: [tr("sr", "RS", { title: "Кум" })] } };
    expect(pickTitle(sr, "movie", CHAIN)).toBe("Kum");
    const domestic: TmdbDetails = {
      id: 1,
      original_title: "Маратонци трче почасни круг",
      original_language: "sr",
      translations: { translations: [tr("en", "US", { title: "The Marathon Family" })] },
    };
    expect(pickTitle(domestic, "movie", CHAIN)).toBe("Maratonci trče počasni krug");
    const foreign: TmdbDetails = {
      id: 2,
      original_title: "Le fabuleux destin d'Amélie Poulain",
      original_language: "fr",
      translations: { translations: [tr("en", "US", { title: "Amélie" })] },
    };
    expect(pickTitle(foreign, "movie", CHAIN)).toBe("Amélie");
  });
  it("shows series year ranges", () => {
    expect(releaseInfo({ id: 1, first_air_date: "2008-01-20", last_air_date: "2013-09-29", status: "Ended" }, "series")).toBe(
      "2008–2013",
    );
    expect(releaseInfo({ id: 1, first_air_date: "2022-01-01", status: "Returning Series" }, "series")).toBe("2022–");
  });
});

describe("catalog paging", () => {
  it("maps Stremio's running skip to TMDB pages even when a few items were dropped", () => {
    expect(pageForSkip(0)).toBe(1);
    expect(pageForSkip(18)).toBe(2);
    expect(pageForSkip(20)).toBe(2);
    expect(pageForSkip(37)).toBe(3);
    expect(pageForSkip(9980)).toBe(500);
    expect(pageForSkip(99999)).toBeUndefined();
  });
  it("computes date windows", () => {
    expect(daysAgo("2026-03-01", 1)).toBe("2026-02-28");
  });
});

describe("search ranking", () => {
  it("scores exact > prefix > word > tokens", () => {
    expect(textScore(["kum"], "kum")).toBe(70);
    expect(textScore(["kum 2"], "kum")).toBe(55);
    expect(textScore(["the godfather"], "godfather")).toBe(45);
    expect(textScore(["kuca od papira"], "kuca papir")).toBe(30);
    expect(textScore(["breaking bad"], "kum")).toBe(0);
  });
  it("builds a SPARQL query that also searches the Cyrillic spelling and escapes quotes", () => {
    const q = wikidataQuery('kum"', "movie");
    expect(q).toContain("P4947");
    expect(q).toContain('kum\\" haswbstatement');
    expect(q).toContain("кум");
    expect(wikidataQuery("kum", "series")).toContain("P4983");
  });
});

describe("manifest", () => {
  const m = buildManifest("https://example.workers.dev");
  it("has unique catalog keys and only optional extras on home rows", () => {
    const keys = m.catalogs.map((c) => `${c.type}/${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const home = m.catalogs.filter((c) => !c.extra.some((e) => e.isRequired));
    expect(home.length).toBe(CATALOGS.length);
  });
  it("offers Croatian genre names that map back to TMDB ids", () => {
    for (const type of ["movie", "series"] as const) {
      for (const g of genreFilterOptions(type)) expect(genreIdByName(type, g)).toBeTypeOf("number");
    }
    expect(genreFilterOptions("movie")).toContain("Vestern");
  });
});

describe("search ranking: short queries", () => {
  it("does not let 'kum' partially match 'kumar'", () => {
    expect(textScore(["harold i kumar"], "kum")).toBe(0);
    expect(textScore(["kumare"], "kum")).toBe(0);
    expect(textScore(["gospodar prstenova povratak kralja"], "gospodar prst")).toBe(50);
  });
});

describe("release gating", () => {
  it("re-evaluates release dates per request instead of freezing them in the cache", () => {
    const c = buildCard({ ...godfather, release_date: "2026-12-01" }, "movie", CHAIN) as Card;
    expect(isReleased(c, "2026-11-08")).toBe(false);
    expect(isReleased(c, "2026-12-01")).toBe(true);
  });
});
