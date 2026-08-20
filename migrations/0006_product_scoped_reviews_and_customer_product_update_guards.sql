-- Completes two backend invariants:
-- 1. Review deduplication is product-scoped, not global across products.
-- 2. Direct customer_products updates cannot bypass the RetiredProduct01/CAMAudit firewall.

DROP TRIGGER IF EXISTS trg_customer_products_firewall_insert;
DROP TRIGGER IF EXISTS trg_customer_products_firewall_customer_update;
DROP TRIGGER IF EXISTS trg_customer_products_firewall_product_update;
DROP TRIGGER IF EXISTS trg_testimonials_firewall_insert;
DROP TRIGGER IF EXISTS trg_testimonials_firewall_customer_update;
DROP TRIGGER IF EXISTS trg_testimonials_firewall_product_update;
DROP TRIGGER IF EXISTS trg_reviews_firewall_insert;
DROP TRIGGER IF EXISTS trg_reviews_firewall_customer_update;
DROP TRIGGER IF EXISTS trg_reviews_firewall_product_update;
DROP TRIGGER IF EXISTS trg_feedback_items_firewall_insert;
DROP TRIGGER IF EXISTS trg_feedback_items_firewall_customer_update;
DROP TRIGGER IF EXISTS trg_feedback_items_firewall_product_update;
DROP TRIGGER IF EXISTS trg_products_firewall_group_update;

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

CREATE TABLE reviews_new (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL
              CHECK (source IN ('g2', 'trustpilot', 'capterra', 'app_store', 'play_store', 'twitter', 'product_hunt', 'rss', 'csv', 'manual')),
  external_id TEXT NOT NULL,
  rating      INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  body        TEXT NOT NULL,
  author_name TEXT,
  source_url  TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, source, external_id)
);

INSERT INTO reviews_new (id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at)
SELECT id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at
  FROM reviews;

INSERT INTO reviews_new (id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at)
SELECT id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at
  FROM review_import_backlog;

DROP TABLE reviews;
ALTER TABLE reviews_new RENAME TO reviews;
DROP TABLE IF EXISTS review_import_backlog;

CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);
CREATE INDEX IF NOT EXISTS idx_reviews_customer ON reviews(customer_id);

CREATE TRIGGER IF NOT EXISTS trg_customer_products_firewall_insert
BEFORE INSERT ON customer_products
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_products_firewall_customer_update
BEFORE UPDATE OF customer_id ON customer_products
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products
       WHERE customer_id = NEW.customer_id
         AND NOT (customer_id = OLD.customer_id AND product_id = OLD.product_id)
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_customer_products_firewall_product_update
BEFORE UPDATE OF product_id ON customer_products
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products
       WHERE customer_id = NEW.customer_id
         AND NOT (customer_id = OLD.customer_id AND product_id = OLD.product_id)
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_testimonials_firewall_insert
BEFORE INSERT ON testimonials
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_testimonials_firewall_customer_update
BEFORE UPDATE OF customer_id ON testimonials
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id AND id != OLD.id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_testimonials_firewall_product_update
BEFORE UPDATE OF product_id ON testimonials
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id AND id != OLD.id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_firewall_insert
BEFORE INSERT ON reviews
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_firewall_customer_update
BEFORE UPDATE OF customer_id ON reviews
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id AND id != OLD.id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_reviews_firewall_product_update
BEFORE UPDATE OF product_id ON reviews
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id AND id != OLD.id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_feedback_items_firewall_insert
BEFORE INSERT ON feedback_items
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_feedback_items_firewall_customer_update
BEFORE UPDATE OF customer_id ON feedback_items
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id AND id != OLD.id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_feedback_items_firewall_product_update
BEFORE UPDATE OF product_id ON feedback_items
FOR EACH ROW
WHEN NEW.customer_id IS NOT NULL AND EXISTS (
  SELECT 1
    FROM products candidate
    JOIN (
      SELECT product_id FROM customer_products WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM testimonials WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM reviews WHERE customer_id = NEW.customer_id
      UNION
      SELECT product_id FROM feedback_items WHERE customer_id = NEW.customer_id AND id != OLD.id
    ) associated ON 1 = 1
    JOIN products existing ON existing.id = associated.product_id
   WHERE candidate.id = NEW.product_id
     AND candidate.firewall_group IS NOT NULL
     AND existing.firewall_group = candidate.firewall_group
     AND existing.id != candidate.id
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;

CREATE TRIGGER IF NOT EXISTS trg_products_firewall_group_update
BEFORE UPDATE OF firewall_group ON products
FOR EACH ROW
WHEN NEW.firewall_group IS NOT NULL AND EXISTS (
  SELECT 1
    FROM (
      SELECT customer_id, product_id FROM customer_products
      UNION ALL
      SELECT customer_id, product_id FROM testimonials
      UNION ALL
      SELECT customer_id, product_id FROM reviews WHERE customer_id IS NOT NULL
      UNION ALL
      SELECT customer_id, product_id FROM feedback_items WHERE customer_id IS NOT NULL
    ) candidate_assoc
    JOIN (
      SELECT customer_id, product_id FROM customer_products
      UNION
      SELECT customer_id, product_id FROM testimonials
      UNION
      SELECT customer_id, product_id FROM reviews WHERE customer_id IS NOT NULL
      UNION
      SELECT customer_id, product_id FROM feedback_items WHERE customer_id IS NOT NULL
    ) other_assoc ON other_assoc.customer_id = candidate_assoc.customer_id
    JOIN products other_product ON other_product.id = other_assoc.product_id
   WHERE candidate_assoc.product_id = NEW.id
     AND other_assoc.product_id != NEW.id
     AND other_product.firewall_group = NEW.firewall_group
)
BEGIN
  SELECT RAISE(ABORT, 'FIREWALL_VIOLATION');
END;
