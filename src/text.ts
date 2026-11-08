// Text helpers for ex-Yu languages: Cyrillic <-> Latin transliteration, folding for search,
// and picking the best translation along a language preference chain.

const CYR_TO_LAT: Record<string, string> = {
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Ђ: "Đ", Е: "E", Ж: "Ž", З: "Z", И: "I", Ј: "J", К: "K",
  Л: "L", Љ: "Lj", М: "M", Н: "N", Њ: "Nj", О: "O", П: "P", Р: "R", С: "S", Т: "T", Ћ: "Ć", У: "U",
  Ф: "F", Х: "H", Ц: "C", Ч: "Č", Џ: "Dž", Ш: "Š",
  а: "a", б: "b", в: "v", г: "g", д: "d", ђ: "đ", е: "e", ж: "ž", з: "z", и: "i", ј: "j", к: "k",
  л: "l", љ: "lj", м: "m", н: "n", њ: "nj", о: "o", п: "p", р: "r", с: "s", т: "t", ћ: "ć", у: "u",
  ф: "f", х: "h", ц: "c", ч: "č", џ: "dž", ш: "š",
  // Macedonian / Russian letters that show up in TMDB data, mapped to their closest Latin form.
  Ѓ: "Gj", ѓ: "gj", Ќ: "Kj", ќ: "kj", Ѕ: "Dz", ѕ: "dz", Й: "J", й: "j", Ы: "Y", ы: "y", Э: "E", э: "e",
  Ю: "Ju", ю: "ju", Я: "Ja", я: "ja", Ё: "Jo", ё: "jo", Щ: "Šč", щ: "šč", Ъ: "", ъ: "", Ь: "", ь: "",
};

const CYRILLIC = /[Ѐ-ӿ]/;

export function hasCyrillic(s: string): boolean {
  return CYRILLIC.test(s);
}

/** Serbian Cyrillic -> Latin (gaj). Keeps ALL-CAPS digraphs uppercase ("ЉУБАВ" -> "LJUBAV"). */
export function cyrToLat(s: string): string {
  if (!hasCyrillic(s)) return s;
  const chars = [...s];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const mapped = CYR_TO_LAT[c];
    if (mapped === undefined) {
      out += c;
      continue;
    }
    if (mapped.length > 1 && c === c.toUpperCase()) {
      const next = chars[i + 1] ?? "";
      const nextIsUpper = next !== "" && next === next.toUpperCase() && next !== next.toLowerCase();
      out += nextIsUpper ? mapped.toUpperCase() : mapped;
    } else {
      out += mapped;
    }
  }
  return out;
}

const LAT_DIGRAPHS: [string, string][] = [
  ["dž", "џ"], ["lj", "љ"], ["nj", "њ"],
];
const LAT_TO_CYR: Record<string, string> = {
  a: "а", b: "б", v: "в", g: "г", d: "д", đ: "ђ", e: "е", ž: "ж", z: "з", i: "и", j: "ј", k: "к",
  l: "л", m: "м", n: "н", o: "о", p: "п", r: "р", s: "с", t: "т", ć: "ћ", u: "у", f: "ф", h: "х",
  c: "ц", č: "ч", š: "ш",
};

/** Latin -> Serbian Cyrillic, lower-case. Only used to widen searches, so exact casing is irrelevant. */
export function latToCyr(s: string): string {
  let t = s.toLowerCase();
  for (const [lat, cyr] of LAT_DIGRAPHS) t = t.split(lat).join(cyr);
  return [...t].map((c) => LAT_TO_CYR[c] ?? c).join("");
}

/** Lower-case, Latin, no diacritics, single-spaced. "Kuća od papira" == "kuca od papira" == "Кућа од папира". */
export function fold(s: string): string {
  return cyrToLat(s)
    .toLowerCase()
    .replace(/đ/g, "dj")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface Translation {
  iso_639_1: string;
  iso_3166_1: string;
  data: { title?: string; name?: string; overview?: string };
}

const HOME_COUNTRY: Record<string, string> = { hr: "HR", bs: "BA", sr: "RS", sh: "HR", en: "US" };

/**
 * First non-empty translated field along the language chain (e.g. hr, bs, sr, en).
 * Cyrillic results are transliterated so everything on screen is in Latin script.
 */
export function pickTranslation(
  translations: Translation[] | undefined,
  chain: readonly string[],
  field: "title" | "name" | "overview",
): { text: string; lang: string } | undefined {
  if (!translations?.length) return undefined;
  for (const lang of chain) {
    const candidates = translations
      .filter((t) => t.iso_639_1 === lang)
      .sort((a, b) => Number(b.iso_3166_1 === HOME_COUNTRY[lang]) - Number(a.iso_3166_1 === HOME_COUNTRY[lang]));
    for (const t of candidates) {
      const v = t.data[field]?.trim();
      if (v) return { text: cyrToLat(v), lang };
    }
  }
  return undefined;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max).trimEnd()}…`;
}

export function formatRuntime(minutes: number | undefined | null): string | undefined {
  if (!minutes || minutes <= 0) return undefined;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
