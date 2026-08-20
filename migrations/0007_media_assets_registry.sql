-- Track uploaded media in D1 so customer photo assignment and deletion can be
-- coordinated with database writes instead of racing through R2-only checks.

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

CREATE TRIGGER IF NOT EXISTS trg_customers_media_insert
BEFORE INSERT ON customers
WHEN NEW.photo_r2_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM media_assets
    WHERE key = NEW.photo_r2_key
      AND deleted_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_ASSET_NOT_FOUND');
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_media_photo_update
BEFORE UPDATE OF photo_r2_key ON customers
WHEN NEW.photo_r2_key IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM media_assets
    WHERE key = NEW.photo_r2_key
      AND deleted_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_ASSET_NOT_FOUND');
END;

CREATE TRIGGER IF NOT EXISTS trg_media_assets_delete_referenced
BEFORE UPDATE OF deleted_at ON media_assets
WHEN NEW.deleted_at IS NOT NULL
 AND EXISTS (
   SELECT 1 FROM customers
    WHERE photo_r2_key = OLD.key
 )
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_IN_USE');
END;
