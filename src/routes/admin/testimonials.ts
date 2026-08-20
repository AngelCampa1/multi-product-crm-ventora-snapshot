import { Hono } from "hono";
import type { Env } from "../../worker";
import { TestimonialsDB, ProductsDB, CustomersDB, generateId, nowIso, linkCustomerToProduct, unlinkCustomerFromProduct, cleanupContentCustomerProductLink } from "../../db/queries";
import type { Testimonial } from "../../db/queries";
import { bustProductWidgets } from "../../lib/cache";
import { assertFirewallSafe, FirewallViolation } from "../../lib/firewall";

type TestimonialSource = Testimonial["source"];

interface TestimonialWithCustomer extends Testimonial {
  customer_name: string | null;
  customer_email: string | null;
}

interface CreateBody {
  customer_id: string;
  product_id: string;
  quote: string;
  source: TestimonialSource;
  source_url?: string;
  rating?: number;
  approved?: boolean;
}

interface UpdateBody {
  quote?: string;
  source?: TestimonialSource;
  source_url?: string | null;
  rating?: number | null;
  approved?: boolean;
  featured?: boolean;
}

const VALID_SOURCES: TestimonialSource[] = ["twitter", "email", "manual", "widget", "import"];
const MAX_TESTIMONIAL_LIMIT = 200;

const router = new Hono<{ Bindings: Env }>();

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalBooleanError(body: Record<string, unknown>, field: "approved" | "featured"): string | null {
  if (Object.prototype.hasOwnProperty.call(body, field) && typeof body[field] !== "boolean") {
    return `${field} must be a boolean`;
  }
  return null;
}

function parsePaginationInt(value: string | null, fallback: number, min: number, max?: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min) return fallback;
  const lowerBounded = Math.max(min, parsed);
  return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
}

export function shouldBustTestimonialWidgetCache(
  testimonial: Testimonial,
  patch: UpdateBody,
): boolean {
  const approvalChanged =
    patch.approved !== undefined && patch.approved !== (testimonial.approved === 1);
  const featuredChanged =
    patch.featured !== undefined && patch.featured !== (testimonial.featured === 1);

  if (approvalChanged || featuredChanged) return true;
  if (testimonial.approved !== 1) return false;

  return (
    patch.quote !== undefined ||
    patch.source !== undefined ||
    "source_url" in patch ||
    "rating" in patch
  );
}

async function withCustomer(
  db: D1Database,
  t: Testimonial,
): Promise<TestimonialWithCustomer> {
  const customer = await CustomersDB.getById(db, t.customer_id);
  return {
    ...t,
    customer_name: customer?.name ?? null,
    customer_email: customer?.email ?? null,
  };
}

router.get("/", async (c) => {
  const { DB } = c.env;
  const url = new URL(c.req.url);
  const product_id = url.searchParams.get("product_id");
  const approvedParam = url.searchParams.get("approved");
  const featuredParam = url.searchParams.get("featured");
  const limit = parsePaginationInt(url.searchParams.get("limit"), 50, 1, MAX_TESTIMONIAL_LIMIT);
  const offset = parsePaginationInt(url.searchParams.get("offset"), 0, 0);

  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (product_id) {
    conditions.push("t.product_id = ?");
    bindings.push(product_id);
  }
  if (approvedParam !== null) {
    if (approvedParam !== "0" && approvedParam !== "1") return c.json({ error: "approved must be 0 or 1" }, 400);
    conditions.push("t.approved = ?");
    bindings.push(approvedParam === "1" ? 1 : 0);
  }
  if (featuredParam !== null) {
    if (featuredParam !== "0" && featuredParam !== "1") return c.json({ error: "featured must be 0 or 1" }, 400);
    conditions.push("t.featured = ?");
    bindings.push(featuredParam === "1" ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countResult = await DB
    .prepare(
      `SELECT COUNT(*) as n FROM testimonials t ${where}`,
    )
    .bind(...bindings)
    .first<{ n: number }>();
  const total = countResult?.n ?? 0;

  bindings.push(limit, offset);
  const rows = await DB
    .prepare(
      `SELECT t.*, c.name as customer_name, c.email as customer_email
       FROM testimonials t
       LEFT JOIN customers c ON c.id = t.customer_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings)
    .all<TestimonialWithCustomer>();

  return c.json({ testimonials: rows.results, total });
});

router.post("/", async (c) => {
  const { DB } = c.env;
  let body: CreateBody;
  try {
    body = await c.req.json<CreateBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "testimonial body must be a JSON object" }, 400);
  const approvedTypeError = optionalBooleanError(body, "approved");
  if (approvedTypeError) return c.json({ error: approvedTypeError }, 422);

  const { customer_id, product_id, quote, source, source_url, rating, approved } = body;

  if (typeof quote !== "string" || quote.trim().length === 0) {
    return c.json({ error: "quote is required" }, 422);
  }
  if (typeof customer_id !== "string" || customer_id.trim() === "" || typeof product_id !== "string" || product_id.trim() === "") {
    return c.json({ error: "customer_id and product_id are required" }, 422);
  }
  if (!source || !VALID_SOURCES.includes(source)) {
    return c.json({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` }, 422);
  }
  if (source_url !== undefined && source_url !== null && typeof source_url !== "string") {
    return c.json({ error: "source_url must be a string or null" }, 422);
  }
  if (rating !== undefined && rating !== null && (typeof rating !== "number" || !Number.isFinite(rating) || rating < 1 || rating > 5)) {
    return c.json({ error: "rating must be between 1 and 5" }, 422);
  }

  const product = await ProductsDB.getById(DB, product_id.trim());
  if (!product) return c.json({ error: "product not found" }, 404);

  const customer = await CustomersDB.getById(DB, customer_id.trim());
  if (!customer) return c.json({ error: "customer not found" }, 404);

  try {
    await assertFirewallSafe(DB, customer_id.trim(), product_id.trim());
  } catch (err) {
    if (err instanceof FirewallViolation) {
      return c.json({ error: err.userMessage, code: "FIREWALL_VIOLATION" }, 422);
    }
    throw err;
  }
  const customerId = customer_id.trim();
  const productId = product_id.trim();
  const createdLink = await linkCustomerToProduct(DB, customerId, productId);

  const id = generateId();
  const now = nowIso();
  const approvedInt = approved ? 1 : 0;

  try {
    await DB
      .prepare(
        `INSERT INTO testimonials (id, customer_id, product_id, quote, source, source_url, rating, approved, featured, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(id, customerId, productId, quote.trim(), source, source_url ?? null, rating ?? null, approvedInt, now)
      .run();
  } catch (err) {
    if (createdLink) {
      await unlinkCustomerFromProduct(DB, customerId, productId);
    }
    throw err;
  }

  if (approvedInt) {
    await bustProductWidgets(product.slug);
  }

  const created: Testimonial = {
    id,
    customer_id: customerId,
    product_id: productId,
    quote: quote.trim(),
    source,
    source_url: source_url ?? null,
    rating: rating ?? null,
    approved: approvedInt,
    featured: 0,
    created_at: now,
  };

  return c.json(created, 201);
});

router.get("/:id", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");
  const testimonial = await TestimonialsDB.getById(DB, id);
  if (!testimonial) return c.json({ error: "not found" }, 404);
  const result = await withCustomer(DB, testimonial);
  return c.json(result);
});

router.patch("/:id", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");

  const testimonial = await TestimonialsDB.getById(DB, id);
  if (!testimonial) return c.json({ error: "not found" }, 404);

  let body: UpdateBody;
  try {
    body = await c.req.json<UpdateBody>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "testimonial body must be a JSON object" }, 400);
  const approvedTypeError = optionalBooleanError(body, "approved");
  if (approvedTypeError) return c.json({ error: approvedTypeError }, 422);
  const featuredTypeError = optionalBooleanError(body, "featured");
  if (featuredTypeError) return c.json({ error: featuredTypeError }, 422);

  const { quote, source, source_url, rating, approved, featured } = body;

  if (quote !== undefined && (typeof quote !== "string" || quote.trim().length === 0)) {
    return c.json({ error: "quote cannot be empty" }, 422);
  }
  if (source !== undefined && (typeof source !== "string" || !(VALID_SOURCES as readonly string[]).includes(source))) {
    return c.json({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` }, 422);
  }
  if (source_url !== undefined && source_url !== null && typeof source_url !== "string") {
    return c.json({ error: "source_url must be a string or null" }, 422);
  }
  if (rating !== undefined && rating !== null && (typeof rating !== "number" || !Number.isFinite(rating) || rating < 1 || rating > 5)) {
    return c.json({ error: "rating must be between 1 and 5" }, 422);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (quote !== undefined) { sets.push("quote = ?"); vals.push(quote.trim()); }
  if (source !== undefined) { sets.push("source = ?"); vals.push(source); }
  if ("source_url" in body) { sets.push("source_url = ?"); vals.push(source_url ?? null); }
  if ("rating" in body) { sets.push("rating = ?"); vals.push(rating ?? null); }
  if (approved !== undefined) { sets.push("approved = ?"); vals.push(approved ? 1 : 0); }
  if (featured !== undefined) { sets.push("featured = ?"); vals.push(featured ? 1 : 0); }

  if (sets.length === 0) return c.json({ error: "no fields to update" }, 422);

  await DB
    .prepare(`UPDATE testimonials SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals, id)
    .run();

  const needsBust = shouldBustTestimonialWidgetCache(testimonial, body);

  if (needsBust) {
    const product = await ProductsDB.getById(DB, testimonial.product_id);
    if (product) await bustProductWidgets(product.slug);
  }

  const updated = await TestimonialsDB.getById(DB, id);
  if (!updated) return c.json({ error: "not found after update" }, 500);
  const result = await withCustomer(DB, updated);
  return c.json(result);
});

router.delete("/:id", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");
  const testimonial = await TestimonialsDB.getById(DB, id);
  if (!testimonial) return c.json({ error: "not found" }, 404);
  await TestimonialsDB.delete(DB, id);
  await cleanupContentCustomerProductLink(DB, testimonial.customer_id, testimonial.product_id);

  if (testimonial.approved === 1 || testimonial.featured === 1) {
    const product = await ProductsDB.getById(DB, testimonial.product_id);
    if (product) await bustProductWidgets(product.slug);
  }

  return c.body(null, 204);
});

router.post("/:id/approve", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");
  const testimonial = await TestimonialsDB.getById(DB, id);
  if (!testimonial) return c.json({ error: "not found" }, 404);

  await TestimonialsDB.setApproved(DB, id, true);

  const product = await ProductsDB.getById(DB, testimonial.product_id);
  if (product) await bustProductWidgets(product.slug);

  const updated = await TestimonialsDB.getById(DB, id);
  if (!updated) return c.json({ error: "not found after update" }, 500);
  const result = await withCustomer(DB, updated);
  return c.json(result);
});

router.post("/:id/feature", async (c) => {
  const { DB } = c.env;
  const id = c.req.param("id");
  const testimonial = await TestimonialsDB.getById(DB, id);
  if (!testimonial) return c.json({ error: "not found" }, 404);

  const newFeatured = testimonial.featured === 0;
  await TestimonialsDB.setFeatured(DB, id, newFeatured);

  const product = await ProductsDB.getById(DB, testimonial.product_id);
  if (product) await bustProductWidgets(product.slug);

  const updated = await TestimonialsDB.getById(DB, id);
  if (!updated) return c.json({ error: "not found after update" }, 500);
  const result = await withCustomer(DB, updated);
  return c.json(result);
});

export default router;
