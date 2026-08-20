-- Completes the firewall trigger set for databases that already applied
-- 0003 before testimonial-update and review-insert guards were added there.

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
