-- Phase 1 compatibility index.
-- Keeps the legacy reviews UNIQUE(source, external_id) table constraint for
-- old Worker code while proving/product-indexing the final scoped key shape.

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_product_source_external_unique
  ON reviews(product_id, source, external_id);
