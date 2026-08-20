-- Final media registry enforcement. Normal fresh migrations already installed
-- the soft-delete guards in 0007; staged production rollout applies a phase-1
-- expand-only 0007, so these IF NOT EXISTS triggers complete enforcement after
-- the compatible Worker has been deployed.

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

CREATE TRIGGER IF NOT EXISTS trg_media_assets_delete_referenced_row
BEFORE DELETE ON media_assets
WHEN EXISTS (
  SELECT 1 FROM customers
   WHERE photo_r2_key = OLD.key
)
BEGIN
  SELECT RAISE(ABORT, 'MEDIA_IN_USE');
END;
