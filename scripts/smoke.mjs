// Smoke test: fetches every home row (and optionally a page 2 + a genre filter) from a running add-on.
// Usage: node scripts/smoke.mjs http://localhost:8787
const base = process.argv[2] ?? "http://localhost:8787";
const manifest = await (await fetch(`${base}/manifest.json`)).json();
let failures = 0;
for (const c of manifest.catalogs) {
  if (c.extra.some((e) => e.isRequired)) continue;
  const t0 = Date.now();
  const res = await fetch(`${base}/catalog/${c.type}/${c.id}.json`);
  const ms = Date.now() - t0;
  const body = await res.json();
  const metas = body.metas ?? [];
  const noDesc = metas.filter((m) => !m.description).length;
  const bad = !res.ok || metas.length < 10;
  if (bad) failures++;
  console.log(
    `${bad ? "✗" : "✓"} ${`${c.type}/${c.id}`.padEnd(26)} ${String(metas.length).padStart(3)} items ${String(ms).padStart(5)}ms` +
      ` cache=${body.cacheMaxAge} noDesc=${noDesc} | ${metas.slice(0, 4).map((m) => m.name).join(" / ")}`,
  );
}
console.log(failures ? `${failures} row(s) failed` : "all rows ok");
process.exit(failures ? 1 : 0);
