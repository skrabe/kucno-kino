// A short, Croatian, playable stream list instead of Torrentio's ~75 raw torrent names.
// The relay on the TV box (box/kkproxy) fetches the user's Torrentio + Real-Debrid results and POSTs them to
// /u/<key>/curate. Play URLs pass through untouched; we only filter, rank and relabel.

export interface TorrentioStream {
  name?: string;
  title?: string;
  url?: string;
  infoHash?: string;
  fileIdx?: number;
  behaviorHints?: Record<string, unknown>;
}

export interface Parsed {
  s: TorrentioStream;
  cached: boolean;
  resolution: number;
  sizeGb?: number;
  codec: "h264" | "hevc" | "av1" | "other";
  source: string;
  release: string;
  flags: string[];
}

const MAX_STREAMS = 6;

/** Can't be decoded by the box (Amlogic S905L3: AVC, HEVC, VP9 only) or not worth showing. */
const BAD = /\b(av1|cam|camrip|hdcam|ts|telesync|hdts|tc|telecine|scr|screener|dvdscr|3d|hsbs|h-sbs|half-sbs)\b/i;
/** Trackers whose releases are usually dubbed (Russian, Italian, Spanish, Portuguese, French). */
const DUB_SOURCES = /^(rutor|rutracker|ilcorsaronero|cinecalidad|mejortorrent|wolfmax4k|comando|bludv|torrent9|micoleaodublado|nyaasi)$/i;
const CYRILLIC = /[Ѐ-ӿ]/;
/** Release names that say the main audio track is a dub (English-speaking originals are the norm here). */
const FOREIGN_AUDIO =
  /\b(french|truefrench|vff|vfq|vf2|ita|italian|spanish|castellano|latino|lat|dual|german|deutsch|rus|hindi|tamil|telugu|polish|pl|esp|spa|dublado|dubbed|dub|multi|vostfr)\b/i;
/** Multi-film packs: the right file is in there, but huge and often mislabeled. */
const PACK = /(collection|pack|trilog|anthology|saga|complete|films?\s*\d|\d+\s*(films|movies)|top\s*\d+|all[-\s]time)/i;
const AI_UPSCALE = /\b(ai\s*lab|upscal\w*|ai[-\s]?enhanced)\b/i;

export function parseStream(s: TorrentioStream): Parsed {
  const name = s.name ?? "";
  const title = s.title ?? "";
  const [release = "", meta = "", flagLine = ""] = title.split("\n");
  const res = /(\d{3,4})p/i.exec(name) ?? /(\d{3,4})p/i.exec(release);
  const size = /💾\s*([\d.,]+)\s*(GB|MB)/i.exec(meta);
  const sizeGb = size ? Number.parseFloat(size[1]!.replace(",", ".")) / (size[2]!.toUpperCase() === "MB" ? 1024 : 1) : undefined;
  const source = /⚙️\s*(\S+)/.exec(meta)?.[1] ?? "";
  const hay = `${release} ${String(s.behaviorHints?.filename ?? "")} ${String(s.behaviorHints?.bingeGroup ?? "")}`;
  const codec = /\bav1\b/i.test(hay) ? "av1" : /(x265|h\.?265|hevc)/i.test(hay) ? "hevc" : /(x264|h\.?264|avc)/i.test(hay) ? "h264" : "other";
  return {
    s,
    cached: /\[(RD|AD|PM|DL|TB|OC|ED|PK)\+\]/i.test(name),
    resolution: res ? Number(res[1]) : /4k|2160/i.test(name) ? 2160 : 0,
    sizeGb,
    codec,
    source,
    release,
    flags: [...flagLine.matchAll(/\p{Regional_Indicator}{2}/gu)].map((m) => m[0]),
  };
}

const RU_UA = new Set(["🇷🇺", "🇺🇦"]);

/** True when the release is almost certainly dubbed into a foreign language (wrong audio for our viewers). */
export function looksDubbed(p: Parsed): boolean {
  if (DUB_SOURCES.test(p.source)) return true;
  if (CYRILLIC.test(p.release)) return true;
  return p.flags.length > 0 && p.flags.every((f) => RU_UA.has(f));
}

/**
 * Higher is better. Among streams that start instantly, favor a single-film release in the original language,
 * 1080p H.264/HEVC, of known and sensible size. Dubs and packs are kept as a last resort (some films only exist
 * that way), never shown above a clean release.
 */
export function score(p: Parsed, type: "movie" | "series"): number {
  let s = 0;
  s += p.resolution >= 1080 ? 300 : p.resolution >= 720 ? 200 : p.resolution > 0 ? 50 : 100;
  s += p.codec === "h264" ? 60 : p.codec === "hevc" ? 50 : 20;
  if (looksDubbed(p)) s -= 500;
  else if (FOREIGN_AUDIO.test(p.release)) s -= 400;
  if (AI_UPSCALE.test(p.release)) s -= 150;
  if (type === "movie" && PACK.test(p.release)) s -= 300;
  if (p.sizeGb === undefined) {
    s -= type === "movie" ? 60 : 10;
  } else {
    // Sweet spot for a 1080p film: 2-12 GB.
    const hi = type === "movie" ? 12 : 60;
    if (p.sizeGb > hi) s -= Math.min(200, (p.sizeGb - hi) * 8);
    else if (type === "movie" && p.sizeGb >= 1.5) s += 30;
    if (type === "movie" && p.sizeGb < 1) s -= 80;
  }
  return s;
}

const fmtGb = (gb: number | undefined) =>
  gb === undefined ? undefined : gb >= 1 ? `${gb.toFixed(1).replace(".", ",")} GB` : `${Math.round(gb * 1024)} MB`;

export function curate(streams: TorrentioStream[], type: "movie" | "series") {
  const parsed = streams.filter((s) => s.url || s.infoHash).map(parseStream);
  const playable = parsed.filter((p) => p.codec !== "av1" && !BAD.test(p.release) && p.resolution < 2160);
  // Fall back rather than ever showing an empty list.
  const pool = playable.length ? playable : parsed;
  // Instant (already on Real-Debrid) beats everything: waiting minutes is the worst experience on a TV.
  const ready = pool.some((p) => p.cached) ? pool.filter((p) => p.cached) : pool;
  const ranked = ready
    .map((p, i) => ({ p, sc: score(p, type) - i * 0.01 }))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, MAX_STREAMS)
    .map((x) => x.p);

  return ranked.map((p, i) => {
    const label = i === 0 ? "★ Preporučeno" : `Rezerva ${i}`;
    const size = fmtGb(p.sizeGb);
    const quality = p.resolution ? `${p.resolution}p` : "Video";
    const start = p.cached ? "Kreće odmah" : "Treba pričekati nekoliko minuta";
    return {
      ...p.s,
      name: quality,
      title: [label + (size ? ` · ${size}` : ""), start].join("\n"),
      // Keep bingeGroup (auto-play next episode) and filename (subtitle matching).
      behaviorHints: { ...(p.s.behaviorHints ?? {}) },
    };
  });
}
