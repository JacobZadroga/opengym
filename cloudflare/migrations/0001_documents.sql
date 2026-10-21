-- D1 is the source of truth. The Node filesystem is only an ephemeral cache.
CREATE TABLE opengym_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO opengym_meta (id, revision) VALUES (1, 0);
-- Prevent an old deployment from overwriting a newer deployment's committed data.
CREATE TRIGGER opengym_revision_guard BEFORE UPDATE ON opengym_meta
WHEN NEW.revision != OLD.revision + 1
BEGIN
  SELECT RAISE(ABORT, 'stale openGym writer');
END;
CREATE TABLE opengym_documents (
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (name, part)
) WITHOUT ROWID;
