-- Small key/value settings, e.g. the guest list ('guests' → JSON array of names).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
