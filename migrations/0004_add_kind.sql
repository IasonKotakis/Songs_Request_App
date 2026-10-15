-- 'request' (a guest asked for the song) or 'vote' (a 👍 on a song someone else requested).
-- Guests can take back a vote, but not a request.
ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'request';
