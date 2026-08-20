import { Hono } from "hono";
import type { Env } from "../../worker";

const router = new Hono<{ Bindings: Env }>();

interface CountRow {
  n: number;
}

interface LifecycleCountRow extends CountRow {
  lifecycle: "lead" | "active" | "churned" | "champion";
}

interface ProductSummaryRow {
  id: string;
  slug: string;
  name: string;
  brand_color: string | null;
  primary_domain: string | null;
  widget_public_key: string;
  origin_allowlist_json: string;
  firewall_group: string | null;
  feedback_count: number | null;
  review_count: number | null;
}

interface PendingTestimonialRow {
  id: string;
  customer_name: string | null;
  quote: string;
  approved: number;
  featured: number;
  created_at: string;
}

function countByLifecycle(rows: LifecycleCountRow[]) {
  const counts = {
    lead: 0,
    active: 0,
    churned: 0,
    champion: 0,
  };

  for (const row of rows) {
    counts[row.lifecycle] = row.n;
  }

  return counts;
}

router.get("/", async (c) => {
  const db = c.env.DB;

  const [
    customerTotal,
    lifecycleRows,
    approvedTestimonials,
    pendingTestimonialsCount,
    feedbackTotal,
    reviewsTotal,
    products,
    pendingTestimonials,
  ] = await Promise.all([
    db.prepare("SELECT COUNT(*) as n FROM customers").first<CountRow>(),
    db.prepare("SELECT lifecycle, COUNT(*) as n FROM customers GROUP BY lifecycle").all<LifecycleCountRow>(),
    db.prepare("SELECT COUNT(*) as n FROM testimonials WHERE approved = 1").first<CountRow>(),
    db.prepare("SELECT COUNT(*) as n FROM testimonials WHERE approved = 0").first<CountRow>(),
    db.prepare("SELECT COUNT(*) as n FROM feedback_items").first<CountRow>(),
    db.prepare("SELECT COUNT(*) as n FROM reviews").first<CountRow>(),
    db
      .prepare(
        `SELECT
           p.id,
           p.slug,
           p.name,
           p.brand_color,
           p.primary_domain,
           p.widget_public_key,
           p.origin_allowlist_json,
           p.firewall_group,
           COALESCE(f.feedback_count, 0) as feedback_count,
           COALESCE(r.review_count, 0) as review_count
         FROM products p
         LEFT JOIN (
           SELECT product_id, COUNT(*) as feedback_count
           FROM feedback_items
           GROUP BY product_id
         ) f ON f.product_id = p.id
         LEFT JOIN (
           SELECT product_id, COUNT(*) as review_count
           FROM reviews
           GROUP BY product_id
         ) r ON r.product_id = p.id
         ORDER BY p.created_at ASC`,
      )
      .all<ProductSummaryRow>(),
    db
      .prepare(
        `SELECT
           t.id,
           c.name as customer_name,
           t.quote,
           t.approved,
           t.featured,
           t.created_at
         FROM testimonials t
         LEFT JOIN customers c ON c.id = t.customer_id
         WHERE t.approved = 0
         ORDER BY t.created_at DESC
         LIMIT 5`,
      )
      .all<PendingTestimonialRow>(),
  ]);

  const lifecycleCounts = countByLifecycle(lifecycleRows.results);

  return c.json({
    customers: {
      total: customerTotal?.n ?? 0,
      ...lifecycleCounts,
    },
    testimonials: {
      approved: approvedTestimonials?.n ?? 0,
      pending: pendingTestimonialsCount?.n ?? 0,
    },
    feedback: {
      total: feedbackTotal?.n ?? 0,
    },
    reviews: {
      total: reviewsTotal?.n ?? 0,
    },
    products: products.results.map((product) => ({
      ...product,
      feedback_count: product.feedback_count ?? 0,
      review_count: product.review_count ?? 0,
    })),
    pending_testimonials: pendingTestimonials.results,
  });
});

export default router;
