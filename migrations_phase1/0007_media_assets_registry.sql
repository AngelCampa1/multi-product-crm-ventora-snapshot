-- Phase 1 expand-only media registry.
-- Safe while the old Worker is still live: creates/backfills the registry, but
-- does not yet enforce customer photo references through triggers.

CREATE TABLE IF NOT EXISTS media_assets (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_assets_deleted_at ON media_assets(deleted_at);

INSERT OR IGNORE INTO media_assets (key, content_type, size_bytes, created_at)
SELECT DISTINCT photo_r2_key, 'application/octet-stream', 0, CURRENT_TIMESTAMP
  FROM customers
 WHERE photo_r2_key IS NOT NULL
   AND photo_r2_key LIKE 'media/%';
