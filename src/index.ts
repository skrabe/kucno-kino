import top from "../data/top.json";
import logo from "../assets/logo.png";
import { type Ctx } from "./cards";
import { catalogHandler } from "./catalog-handler";
import { CATALOGS, findCatalog } from "./catalogs";
import type { MediaType } from "./genres";
import { landingPage } from "./landing";
import { buildManifest, SEARCH_ID, VERSION } from "./manifest";
import { metaHandler } from "./meta";
import { searchHandler } from "./search";
import { curate, type TorrentioStream } from "./streams";
import { Budget, type Env, Tmdb } from "./tmdb";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Outbound calls allowed per request. The account is on Workers Paid (10,000 subrequests per invocation),
 * so this is a safety valve against runaway fan-out, not a platform limit. A cold row needs ~25.
 */
const BUDGET = 300;
const HOUR = 3600;
const DAY = 24 * HOUR;

interface CachePolicy {
  /** Edge cache lifetime (s). */
  edge: number;
  /** Stremio client: cacheMaxAge / staleRevalidate / staleError (s). */
  client: number;
  stale: number;
}

const POLICY = {
  catalog: { edge: 6 * HOUR, client: 6 * HOUR, stale: 7 * DAY },
  search: { edge: 12 * HOUR, client: HOUR, stale: DAY },
  meta: { edge: DAY, client: DAY, stale: 30 * DAY },
  partial: { edge: 60, client: 60, stale: DAY },
  fallback: { edge: 10 * 60, client: 10 * 60, stale: DAY },
} satisfies Record<string, CachePolicy>;

function json(body: Record<string, unknown>, policy?: CachePolicy, status = 200): Response {
  const payload = policy
    ? { ...body, cacheMaxAge: policy.client, staleRevalidate: policy.stale, staleError: policy.stale }
    : body;
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": policy
        ? `public, max-age=${policy.client}, s-maxage=${policy.edge}, stale-while-revalidate=${policy.stale}, stale-if-error=${policy.stale}`
        : "no-store",
    },
  });
}

function makeCtx(env: Env, exec: ExecutionContext): Ctx {
  const budget = new Budget(BUDGET);
  return {
    env,
    budget,
    tmdb: new Tmdb(env.TMDB_TOKEN, budget),
    chain: (env.LANGS || "hr,bs,sr,sh,en").split(",").map((s) => s.trim()).filter(Boolean),
    today: new Date().toISOString().slice(0, 10),
    waitUntil: (p) => exec.waitUntil(p),
  };
}

/** Fixed host so cron warm-ups (called via the service binding) fill the same cache entries viewers read. */
const CACHE_HOST = "https://kucno-kino.cache";

function isWarm(req: Request, env: Env): boolean {
  return Boolean(env.WARM_KEY) && req.headers.get("x-warm") === env.WARM_KEY;
}

/** Edge-cached Stremio resource. A warm-up request (cron) always recomputes and refreshes the entry. */
async function cached(
  req: Request,
  keyPath: string,
  ctx: Ctx,
  exec: ExecutionContext,
  compute: () => Promise<Response>,
): Promise<Response> {
  const key = new Request(`${CACHE_HOST}${keyPath}?v=${VERSION}-${ctx.env.CF_VERSION?.id ?? "dev"}`);
  const cache = caches.default;
  if (!isWarm(req, ctx.env)) {
    ctx.budget.take();
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await compute();
  if (res.ok && ctx.budget.left > 0) {
    ctx.budget.take();
    exec.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

const ROUTE = /^\/(catalog|meta)\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/;
/** Private prefix /u/<STREAM_KEY>/…: unlocks /curate, used by the stream relay running on the TV box. */
const PRIVATE = /^\/u\/([A-Za-z0-9_-]{16,})(\/.*)$/;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  let base = url.origin;
  let privileged = false;
  const priv = PRIVATE.exec(path);
  if (priv) {
    if (!env.STREAM_KEY || !timingSafeEqual(priv[1]!, env.STREAM_KEY)) return json({ error: "not found" }, undefined, 404);
    privileged = true;
    path = priv[2]!;
    base = `${url.origin}/u/${priv[1]}`;
  }

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (privileged && path === "/curate" && req.method === "POST") {
    // The box fetches Torrentio itself (Torrentio rate-limits Cloudflare IPs) and asks us only to
    // filter, rank and relabel. Keeping the logic here means labels can change without touching the box.
    const type = url.searchParams.get("type") === "series" ? "series" : "movie";
    const body = (await req.json().catch(() => ({}))) as { streams?: TorrentioStream[] };
    return json({ streams: curate(Array.isArray(body.streams) ? body.streams : [], type) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  if (path === "/" || path === "/configure") {
    return new Response(landingPage(url.origin), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" },
    });
  }
  if (path === "/manifest.json") {
    return json(buildManifest(url.origin), { edge: HOUR, client: HOUR, stale: DAY });
  }
  if (path === "/logo.png") {
    return new Response(logo, {
      headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
    });
  }
  if (path === "/health") {
    const ctx = makeCtx(env, exec);
    const checks: Record<string, string> = {};
    await Promise.all([
      ctx.tmdb.get("/configuration").then(
        () => (checks.tmdb = "ok"),
        (e) => (checks.tmdb = String(e)),
      ),
      env.DB.prepare("SELECT COUNT(*) AS n FROM cards").first<{ n: number }>().then(
        (r) => (checks.d1 = `ok (${r?.n ?? 0} cached cards)`),
        (e) => (checks.d1 = String(e)),
      ),
    ]);
    const ok = Object.values(checks).every((v) => v.startsWith("ok"));
    return json({ ok, version: VERSION, ...checks }, undefined, ok ? 200 : 503);
  }

  if (path === "/warm") {
    if (!isWarm(req, env) || !env.SELF) return json({ error: "forbidden" }, undefined, 403);
    const part = Number(url.searchParams.get("part"));
    if (!Number.isInteger(part) || part < 0 || part >= WARM_PARTS) return json({ error: "bad part" }, undefined, 400);
    return json(await warmPart(env, part));
  }

  const m = ROUTE.exec(path);
  if (!m) return json({ error: "not found" }, undefined, 404);
  const [, resource, type, rawId, rawExtra] = m as unknown as [string, "catalog" | "meta", MediaType, string, string?];
  const id = decodeURIComponent(rawId);
  const extra = Object.fromEntries(new URLSearchParams(rawExtra ?? ""));
  const ctx = makeCtx(env, exec);

  if (resource === "meta") {
    if (!/^tt\d+$/.test(id)) return json({ meta: null }, undefined, 404);
    return cached(req, path, ctx, exec, async () => {
      const r = await metaHandler(ctx, type, id, `${base}/manifest.json`);
      if (!r) return json({ meta: null }, undefined, 404);
      return json({ meta: r.meta }, r.fallback ? POLICY.fallback : POLICY.meta);
    });
  }

  if (id === SEARCH_ID) {
    if (!extra.search) return json({ metas: [] }, POLICY.partial);
    return cached(req, path, ctx, exec, async () => {
      const r = await searchHandler(ctx, type, extra.search!);
      return json({ metas: r.metas }, r.complete ? POLICY.search : POLICY.partial);
    });
  }

  const def = findCatalog(type, id);
  if (!def) return json({ metas: [] }, undefined, 404);
  return cached(req, path, ctx, exec, async () => {
    try {
      const r = await catalogHandler(ctx, def, extra);
      return json({ metas: r.metas }, r.complete ? POLICY.catalog : POLICY.partial);
    } catch (e) {
      console.error("catalog failed", type, id, String(e));
      // 5xx so neither the edge nor Stremio caches the failure; Stremio keeps showing its stale copy.
      return json({ metas: [], error: "upstream" }, undefined, 502);
    }
  });
}

/** Every path the cron keeps warm: first page of each row and the whole Top 250 lists. */
function warmPaths(): string[] {
  return CATALOGS.flatMap((c) => {
    if (c.kind === "static") {
      const n = (c.list === "top-movies" ? top.movies : top.series).length;
      return Array.from({ length: Math.ceil(n / 20) }, (_, i) =>
        i === 0 ? `/catalog/${c.type}/${c.id}.json` : `/catalog/${c.type}/${c.id}/skip=${i * 20}.json`,
      );
    }
    return [`/catalog/${c.type}/${c.id}.json`];
  });
}

const WARM_PARTS = 4;

/** Warms one slice of the paths. Each path is its own invocation (service binding), with its own budget. */
async function warmPart(env: Env, part: number): Promise<{ ok: number; failed: string[] }> {
  const paths = warmPaths().filter((_, i) => i % WARM_PARTS === part);
  const failed: string[] = [];
  for (let i = 0; i < paths.length; i += 4) {
    const batch = paths.slice(i, i + 4);
    const results = await Promise.allSettled(
      batch.map((p) => env.SELF!.fetch(`${CACHE_HOST}${p}`, { headers: { "x-warm": env.WARM_KEY! } })),
    );
    results.forEach((r, j) => {
      if (r.status === "rejected" || !r.value.ok) failed.push(batch[j]!);
    });
  }
  return { ok: paths.length - failed.length, failed };
}

/** Cron: drop expired cache rows, then warm everything in WARM_PARTS invocations so no single one is overloaded. */
async function warm(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM cards WHERE expires < ?").bind(Math.floor(Date.now() / 1000)).run();
  if (!env.SELF || !env.WARM_KEY) return;
  const results = await Promise.allSettled(
    Array.from({ length: WARM_PARTS }, (_, part) =>
      env.SELF!.fetch(`${CACHE_HOST}/warm?part=${part}`, { headers: { "x-warm": env.WARM_KEY! } }),
    ),
  );
  for (const r of results) {
    if (r.status === "rejected") console.warn("warm part failed", r.reason);
    else console.log("warm part", r.value.status, await r.value.text());
  }
}

export default {
  async fetch(req, env, exec) {
    try {
      return await handle(req, env, exec);
    } catch (e) {
      console.error("unhandled", req.url, e);
      return json({ error: "internal" }, undefined, 500);
    }
  },
  async scheduled(_event, env, exec) {
    exec.waitUntil(warm(env));
  },
} satisfies ExportedHandler<Env>;
