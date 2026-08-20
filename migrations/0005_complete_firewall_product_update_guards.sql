-- Completes the firewall invariant for product reassignment and product
-- firewall-group changes. 0003/0004 guarded inserts and customer_id updates;
-- these triggers guard the remaining DB mutation paths that can create a
-- same-customer, same-firewall-group cross-product association.

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
