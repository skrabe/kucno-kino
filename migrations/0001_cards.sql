-- Card cache: localized poster-tile data and IMDb<->TMDB id map. Rows expire; the cron deletes stale ones.
CREATE TABLE IF NOT EXISTS cards (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_expires ON cards (expires);
