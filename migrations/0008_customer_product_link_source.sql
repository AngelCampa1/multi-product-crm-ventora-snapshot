-- Track whether a customer/product link was explicitly created by an admin or
-- derived from attached content. Content links can be cleaned up when the last
-- related testimonial/review/feedback row is removed; manual links stay.

ALTER TABLE customer_products
  ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'content'));
