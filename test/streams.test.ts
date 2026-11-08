import { describe, expect, it } from "vitest";
import { curate, looksDubbed, parseStream } from "../src/streams";

const s = (name: string, title: string, filename = "") => ({
  name,
  title,
  url: `https://example/${Math.random()}`,
  behaviorHints: { bingeGroup: "g", filename },
});

const raw = [
  s("[RD+] Torrentio\n1080p", "Movie 2026 1080p AV1 Opus\n👤 9 💾 3.1 GB ⚙️ YTS"),
  s("[RD+] Torrentio\n1080p", "Проект / Movie (2026) WEB-DL 1080p\n👤 67 💾 12.24 GB ⚙️ Rutor\n🇬🇧 / 🇷🇺"),
  s("[RD download] Torrentio\n1080p", "Movie.2026.1080p.WEB.h264\n👤 500 💾 6 GB ⚙️ 1337x"),
  s("[RD+] Torrentio\n1080p", "Movie 2026 1080p WEB H264-DJT\n👤 1397 💾 9.1 GB ⚙️ ThePirateBay", "Movie.mkv"),
  s("[RD+] Torrentio\n720p", "Movie 2026 720p HDCAM x264\n👤 2 💾 1.2 GB ⚙️ 1337x"),
  s("[RD+] Torrentio\n1080p", "Movie (2026) (1080p BluRay x265 10bit)\n👤 100 💾 9.26 GB ⚙️ TorrentGalaxy"),
];

describe("stream curation", () => {
  it("parses size, codec, cache state and source", () => {
    const p = parseStream(raw[3]!);
    expect(p).toMatchObject({ cached: true, resolution: 1080, sizeGb: 9.1, codec: "h264", source: "ThePirateBay" });
  });
  it("detects dubbed releases", () => {
    expect(looksDubbed(parseStream(raw[1]!))).toBe(true);
    expect(looksDubbed(parseStream(raw[3]!))).toBe(false);
  });
  it("drops AV1, CAM and uncached, ranks dubs last; labels in Croatian; keeps play URL and hints", () => {
    const out = curate(raw, "movie");
    expect(out.map((x) => x.url)).toEqual([raw[3]!.url, raw[5]!.url, raw[1]!.url]);
    expect(out[0]).toMatchObject({ name: "1080p", title: "★ Preporučeno · 9,1 GB\nKreće odmah" });
    expect(out[1]!.title).toBe("Rezerva 1 · 9,3 GB\nKreće odmah");
    expect(out[0]!.behaviorHints).toMatchObject({ bingeGroup: "g", filename: "Movie.mkv" });
  });
  it("never returns an empty list when only imperfect streams exist", () => {
    const out = curate([raw[2]!], "movie");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("Treba pričekati");
  });
});

describe("stream ranking against packs and dubs", () => {
  it("puts a clean single-film release above packs, French dubs and AI upscales", () => {
    const list = [
      s("[RD+] Torrentio\n1080p", "Great Films 1 - Mp4 x264 AC3 1080p\n👤 5 ⚙️ 1337x"),
      s("[RD+] Torrentio\n1080p", "Le Parrain (1972) MULTI [1080p] Bluray x264-PopHD\n👤 9 💾 4.32 GB ⚙️ 1337x"),
      s("[RD+] Torrentio\n1080p", "The Godfather (1972) 1080p (AI Lab) ENG\n👤 9 💾 4.18 GB ⚙️ EXT"),
      s("[RD+] Torrentio\n1080p", "500 top all-time movies collection 1080p H.264\n👤 9 💾 480 GB ⚙️ 1337x"),
      s("[RD+] Torrentio\n1080p", "The.Godfather.1972.REMASTERED.1080p.BluRay.H264.AAC-RARBG\n👤 9 💾 3.34 GB ⚙️ TorrentGalaxy"),
    ];
    const out = curate(list, "movie");
    expect(out[0]!.url).toBe(list[4]!.url);
    expect(out.at(-1)!.url).not.toBe(list[4]!.url);
  });
});
