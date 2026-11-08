// Builds data/top.json (IMDb Top 250 movies + series, resolved to TMDB ids) from a list of IMDb ids.
// Usage: TMDB_TOKEN=... node scripts/build-top.mjs path/to/imdb-top-lists.json
// Input: {"top": ["tt..."], "toptv": ["tt..."]} (scraped from imdb.com/chart/top and /chart/toptv).
import { readFileSync, writeFileSync } from "node:fs";

const token = process.env.TMDB_TOKEN;
if (!token) throw new Error("TMDB_TOKEN missing");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));

async function find(imdb) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://api.themoviedb.org/3/find/${imdb}?external_source=imdb_id`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`find failed for ${imdb}`);
}

async function resolve(ids, key) {
  const out = [];
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.all(
      ids.slice(i, i + 8).map(async (imdb) => {
        const r = await find(imdb);
        const hit = r[key][0];
        if (!hit) console.warn("no TMDB match", imdb);
        return hit ? { imdb, tmdb: hit.id } : undefined;
      }),
    );
    out.push(...batch.filter(Boolean));
  }
  return out;
}

const movies = await resolve(input.top, "movie_results");
const series = await resolve(input.toptv, "tv_results");
writeFileSync(
  new URL("../data/top.json", import.meta.url),
  `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), movies, series })}\n`,
);
console.log(`movies ${movies.length}/${input.top.length}, series ${series.length}/${input.toptv.length}`);
