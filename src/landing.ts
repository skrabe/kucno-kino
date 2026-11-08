import { CATALOGS } from "./catalogs";
import { VERSION } from "./manifest";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function landingPage(origin: string): string {
  const host = new URL(origin).host;
  const install = `stremio://${host}/manifest.json`;
  const web = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(`${origin}/manifest.json`)}`;
  const rows = CATALOGS.map((c) => `<li>${esc(c.name)} <span>${c.type === "movie" ? "film" : "serija"}</span></li>`).join("");
  return `<!doctype html>
<html lang="hr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kućno kino</title>
<link rel="icon" href="/logo.png">
<style>
  :root { --bg:#faf7f2; --fg:#1d1a16; --muted:#6b6259; --card:#fff; --line:#e8e1d6; --accent:#c2410c; --accent-fg:#fff; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#14110e; --fg:#f3ede4; --muted:#a69b8e; --card:#1d1915; --line:#2e2822; --accent:#f97316; --accent-fg:#14110e; } }
  :root[data-theme="dark"] { --bg:#14110e; --fg:#f3ede4; --muted:#a69b8e; --card:#1d1915; --line:#2e2822; --accent:#f97316; --accent-fg:#14110e; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 16px 64px; }
  header { display:flex; gap:16px; align-items:center; }
  header img { width:64px; height:64px; border-radius:16px; }
  h1 { font-size: 32px; margin:0; letter-spacing:-0.02em; }
  .lead { color:var(--muted); margin:4px 0 0; }
  .actions { display:flex; flex-wrap:wrap; gap:12px; margin:32px 0; }
  a.btn { display:inline-block; padding:12px 20px; border-radius:10px; text-decoration:none; font-weight:600; border:1px solid var(--line); color:var(--fg); background:var(--card); }
  a.btn.primary { background:var(--accent); color:var(--accent-fg); border-color:transparent; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 24px; margin-top:20px; }
  h2 { font-size:18px; margin:0 0 8px; }
  ul.rows { columns: 2; column-gap: 32px; padding-left: 18px; margin: 8px 0 0; }
  ul.rows span { color:var(--muted); font-size:13px; }
  @media (max-width: 520px) { ul.rows { columns: 1; } }
  code { background:var(--bg); padding:2px 6px; border-radius:6px; word-break: break-all; }
  footer { color:var(--muted); font-size:13px; margin-top:32px; }
  footer a { color:inherit; }
</style>
</head>
<body>
<main>
  <header>
    <img src="/logo.png" alt="">
    <div>
      <h1>Kućno kino</h1>
      <p class="lead">Stremio dodatak: filmovi i serije na našem jeziku.</p>
    </div>
  </header>
  <div class="actions">
    <a class="btn primary" href="${esc(install)}">Instaliraj u Stremio</a>
    <a class="btn" href="${esc(web)}">Instaliraj preko weba</a>
  </div>
  <section>
    <h2>Što radi</h2>
    <p>Naslovi i opisi na hrvatskom. Kad hrvatskog prijevoda nema, koristi se bosanski pa srpski (ćirilica se automatski piše latinicom), a tek onda engleski. Pretraga razumije naše naslove, sa ili bez kvačica (<em>kum</em>, <em>kuca od papira</em>), i imena glumaca (<em>bud spencer</em>). Popisi se osvježavaju sami, svaki dan.</p>
  </section>
  <section>
    <h2>Redovi na početnom ekranu</h2>
    <ul class="rows">${rows}</ul>
  </section>
  <section>
    <h2>Ručna instalacija</h2>
    <p>Zalijepite adresu u Stremio → Dodaci → pretraga: <code>${esc(origin)}/manifest.json</code></p>
  </section>
  <footer>
    Verzija ${VERSION}. Podaci o filmovima: <a href="https://www.themoviedb.org/">TMDB</a> i <a href="https://www.wikidata.org/">Wikidata</a>.
    This product uses the TMDB API but is not endorsed or certified by TMDB.
  </footer>
</main>
</body>
</html>`;
}
