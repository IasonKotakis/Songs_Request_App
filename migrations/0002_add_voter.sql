-- The guest's device id, so each guest counts once per song (👍 votes).
ALTER TABLE requests ADD COLUMN voter TEXT NOT NULL DEFAULT '';
