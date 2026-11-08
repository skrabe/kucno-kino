// Minimal TMDB v3 client with a per-request subrequest budget (Workers Free allows 50 per invocation).

export interface Env {
  DB: D1Database;
  TMDB_TOKEN: string;
  /** Language preference chain for titles/descriptions, e.g. "hr,bs,sr,sh,en". */
  LANGS?: string;
  /** Service binding to this same Worker, used by the cron warm-up so every catalog gets its own budget. */
  SELF?: Fetcher;
  CF_VERSION?: { id: string };
  /** Shared secret for the cron's warm-up requests (header x-warm). */
  WARM_KEY?: string;
}

export class BudgetExceeded extends Error {
  constructor() {
    super("subrequest budget exhausted");
  }
}

/** Counts outbound calls so one request never trips the platform limit; callers degrade gracefully instead. */
export class Budget {
  used = 0;
  constructor(readonly max: number) {}
  get left(): number {
    return this.max - this.used;
  }
  take(n = 1): void {
    if (this.used + n > this.max) throw new BudgetExceeded();
    this.used += n;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

const TMDB = "https://api.themoviedb.org/3";
export const IMG = "https://image.tmdb.org/t/p";

export class Tmdb {
  constructor(
    private readonly token: string,
    private readonly budget: Budget,
  ) {}

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(TMDB + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      this.budget.take();
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
      if (res.ok) return (await res.json()) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 1 || this.budget.left < 4) throw new HttpError(res.status, url.pathname);
      const wait = Math.min(Number(res.headers.get("retry-after")) || 1, 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

export function img(path: string | null | undefined, size: string): string | undefined {
  return path ? `${IMG}/${size}${path}` : undefined;
}

// Shapes of the TMDB responses we use (only the fields we read).
export interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  popularity?: number;
  vote_count?: number;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  media_type?: string;
  adult?: boolean;
}

export interface TmdbPage {
  page: number;
  total_pages: number;
  results: TmdbListItem[];
}
