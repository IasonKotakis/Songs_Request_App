CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  track TEXT,            -- JSON with album, artwork, Apple Music link (null if typed in by hand)
  name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
