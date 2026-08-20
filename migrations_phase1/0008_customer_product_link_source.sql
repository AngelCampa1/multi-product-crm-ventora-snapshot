-- Phase 1 expand-only customer/product provenance column.
-- Old Worker inserts omit this column and receive the default; new Worker can
-- write explicit source values after deployment.

ALTER TABLE customer_products
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'content'));
