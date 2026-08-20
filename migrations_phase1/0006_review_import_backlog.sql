-- Phase 1 compatibility backlog for review imports that the new Worker can
-- product-scope, but the old reviews UNIQUE(source, external_id) constraint
-- still blocks until phase 2 rebuilds the reviews table.

CREATE TABLE IF NOT EXISTS review_import_backlog (
  id          TEXT PRIMARY KEY,
  customer_id TEXT,
  product_id  TEXT NOT NULL,
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  rating      INTEGER,
  body        TEXT NOT NULL,
  author_name TEXT,
  source_url  TEXT,
  imported_at TEXT NOT NULL,
  UNIQUE (product_id, source, external_id)
);
