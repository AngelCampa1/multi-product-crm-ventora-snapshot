/**
 * Admin feedback router — /api/admin/feedback
 *
 * Handles CRUD + status transitions for FeedbackItem rows.
 * All routes are mounted behind the requireAccess middleware in worker.ts.
 */

import { Hono } from "hono";
import type { Env } from "../../worker";
import { FeedbackDB, ProductsDB, CustomersDB, linkCustomerToProduct, unlinkCustomerFromProduct, cleanupContentCustomerProductLink, type FeedbackItem } from "../../db/queries";
import { assertFirewallSafe, FirewallViolation } from "../../lib/firewall";
import { bustProductWidgets } from "../../lib/cache";

const router = new Hono<{ Bindings: Env }>();
const MAX_FEEDBACK_LIMIT = 200;
const VALID_FEEDBACK_TYPES = new Set<FeedbackItem["type"]>(["feature_request", "bug", "general"]);
const VALID_FEEDBACK_STATUSES = new Set<FeedbackItem["status"]>(["new", "triaged", "planned", "in_progress", "shipped", "declined"]);

function parsePaginationInt(value: string, fallback: number, min: number, max?: number): number {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  const lowerBounded = Math.max(min, parsed);
  return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePublicVisible(value: unknown): number | null {
  if (value === undefined) return 0;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  return null;
}

// ---------------------------------------------------------------------------
// GET / — list feedback items
// Query params: product_id, type, status, limit (default 100), offset (default 0)
// Returns { items: FeedbackItem[], total: number }
// ---------------------------------------------------------------------------
router.get("/", async (c) => {
  const { product_id, type, status, limit = "100", offset = "0" } = c.req.query();

  const validType = type as FeedbackItem["type"] | undefined;
  const validStatus = status as FeedbackItem["status"] | undefined;
  if (type && !VALID_FEEDBACK_TYPES.has(validType!)) return c.json({ error: "invalid feedback type" }, 400);
  if (status && !VALID_FEEDBACK_STATUSES.has(validStatus!)) return c.json({ error: "invalid feedback status" }, 400);
  const limitInt = parsePaginationInt(limit, 100, 1, MAX_FEEDBACK_LIMIT);
  const offsetInt = parsePaginationInt(offset, 0, 0);

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (product_id) {
    conditions.push("f.product_id = ?");
    bindings.push(product_id);
  }
  if (validType) { conditions.push("f.type = ?"); bindings.push(validType); }
  if (validStatus) { conditions.push("f.status = ?"); bindings.push(validStatus); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const itemsResult = await c.env.DB
    .prepare(
      `SELECT f.*, p.slug as product_slug, p.name as product_name
       FROM feedback_items f
       LEFT JOIN products p ON p.id = f.product_id
       ${where}
       ORDER BY f.upvotes DESC, f.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limitInt, offsetInt)
    .all<FeedbackItem & { product_slug: string | null; product_name: string | null }>();

  const countRow = await c.env.DB
    .prepare(
      `SELECT COUNT(*) as n
       FROM feedback_items f
       ${where}`,
    )
    .bind(...bindings)
    .first<{ n: number }>();

  return c.json({ items: itemsResult.results, total: countRow?.n ?? 0 });
});

// ---------------------------------------------------------------------------
// POST / — create a new feedback item
// Body: { product_id, type, title, body?, customer_id?, public_visible? }
// ---------------------------------------------------------------------------
router.post("/", async (c) => {
  let body: {
    product_id?: string;
    type?: string;
    title?: string;
    body?: string;
    customer_id?: string;
    public_visible?: number;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "feedback body must be a JSON object" }, 400);

  const { product_id, type, title, body: bodyText, customer_id, public_visible } = body;
  const publicVisible = parsePublicVisible(public_visible);

  if (typeof product_id !== "string" || product_id.trim().length === 0) return c.json({ error: "product_id is required" }, 400);
  if (typeof type !== "string" || !["feature_request", "bug", "general"].includes(type)) {
    return c.json({ error: "type must be one of: feature_request, bug, general" }, 400);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    return c.json({ error: "title must not be empty" }, 400);
  }
  if (bodyText !== undefined && bodyText !== null && typeof bodyText !== "string") {
    return c.json({ error: "body must be a string or null" }, 400);
  }
  if (customer_id !== undefined && customer_id !== null && typeof customer_id !== "string") {
    return c.json({ error: "customer_id must be a string" }, 400);
  }
  if (publicVisible === null) {
    return c.json({ error: "public_visible must be a boolean or 0/1" }, 400);
  }

  // Verify product exists
  const product = await ProductsDB.getById(c.env.DB, product_id.trim());
  if (!product) return c.json({ error: "product not found" }, 404);

  const productId = product_id.trim();
  const customerId = customer_id?.trim() || null;
  let createdLink = false;
  if (customerId) {
    const customer = await CustomersDB.getById(c.env.DB, customerId);
    if (!customer) return c.json({ error: "customer not found" }, 404);
    try {
      await assertFirewallSafe(c.env.DB, customerId, productId);
    } catch (err) {
      if (err instanceof FirewallViolation) {
        return c.json({ error: err.message, code: "FIREWALL_VIOLATION" }, 422);
      }
      throw err;
    }
    createdLink = await linkCustomerToProduct(c.env.DB, customerId, productId);
  }

  let item: FeedbackItem;
  try {
    item = await FeedbackDB.create(c.env.DB, {
      product_id: productId,
      type: type as "feature_request" | "bug" | "general",
      title: title.trim(),
      body: bodyText ?? null,
      customer_id: customerId,
      status: "new",
    });
  } catch (err) {
    if (createdLink && customerId) {
      await unlinkCustomerFromProduct(c.env.DB, customerId, productId);
    }
    throw err;
  }

  // Apply public_visible if provided.
  if (publicVisible !== 0) {
    await c.env.DB
      .prepare("UPDATE feedback_items SET public_visible = ? WHERE id = ?")
      .bind(publicVisible, item.id)
      .run();
    item.public_visible = publicVisible;
  }

  return c.json(item, 201);
});

// ---------------------------------------------------------------------------
// GET /:id — get a single feedback item
// ---------------------------------------------------------------------------
router.get("/:id", async (c) => {
  const item = await FeedbackDB.getById(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  return c.json(item);
});

// ---------------------------------------------------------------------------
// PATCH /:id — update feedback item fields
// Body: { title?, body?, status?, type?, increment_upvotes?: true, public_visible? }
// ---------------------------------------------------------------------------
router.patch("/:id", async (c) => {
  const id = c.req.param("id");

  const existing = await FeedbackDB.getById(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  let body: {
    title?: string;
    body?: string | null;
    status?: string;
    type?: string;
    increment_upvotes?: boolean;
    public_visible?: number;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "feedback body must be a JSON object" }, 400);

  const { title, body: bodyText, status, type, increment_upvotes, public_visible } = body;
  const now = new Date().toISOString();
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) return c.json({ error: "title must not be empty" }, 400);
    sets.push("title = ?");
    bindings.push(title.trim());
  }

  if (bodyText !== undefined) {
    if (bodyText !== null && typeof bodyText !== "string") return c.json({ error: "body must be a string or null" }, 400);
    sets.push("body = ?");
    bindings.push(bodyText);
  }

  if (status !== undefined) {
    const validStatuses = ["new", "triaged", "planned", "in_progress", "shipped", "declined"];
    if (!validStatuses.includes(status)) {
      return c.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, 400);
    }
    sets.push("status = ?");
    bindings.push(status);
  }

  if (type !== undefined) {
    const validTypes = ["feature_request", "bug", "general"];
    if (!validTypes.includes(type)) {
      return c.json({ error: `type must be one of: ${validTypes.join(", ")}` }, 400);
    }
    sets.push("type = ?");
    bindings.push(type);
  }

  if (public_visible !== undefined) {
    const publicVisible = parsePublicVisible(public_visible);
    if (publicVisible === null) {
      return c.json({ error: "public_visible must be a boolean or 0/1" }, 400);
    }
    sets.push("public_visible = ?");
    bindings.push(publicVisible);
  }

  if (increment_upvotes === true) {
    await FeedbackDB.incrementUpvotes(c.env.DB, id);
  }

  if (sets.length > 0) {
    sets.push("updated_at = ?");
    bindings.push(now, id);
    await c.env.DB
      .prepare(`UPDATE feedback_items SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...bindings)
      .run();
  } else if (increment_upvotes !== true) {
    // Nothing to update
    return c.json(existing);
  }

  // Note: the cache-bust below is intentionally not transactional with the DB UPDATE above.
  // Per CLAUDE.md, D1 statements are not atomic across calls. The worst case is a stale
  // cache window of seconds until the next mutation triggers another bust.
  //
  // When status or type changes and the feedback is linked to a testimonial for
  // the same customer+product, bust the product widget cache (the testimonial
  // wall may surface customer context that depends on feedback status).
  const statusChanged = status !== undefined && status !== existing.status;
  const typeChanged = type !== undefined && type !== existing.type;
  if ((statusChanged || typeChanged) && existing.customer_id) {
    const linkedTestimonial = await c.env.DB
      .prepare(
        "SELECT 1 FROM testimonials WHERE customer_id = ? AND product_id = ? AND approved = 1 LIMIT 1",
      )
      .bind(existing.customer_id, existing.product_id)
      .first<{ 1: number }>();
    if (linkedTestimonial) {
      const product = await ProductsDB.getById(c.env.DB, existing.product_id);
      if (product) await bustProductWidgets(product.slug);
    }
  }

  const updated = await FeedbackDB.getById(c.env.DB, id);
  return c.json(updated);
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete a feedback item
// ---------------------------------------------------------------------------
router.delete("/:id", async (c) => {
  const item = await FeedbackDB.getById(c.env.DB, c.req.param("id"));
  if (!item) return c.json({ error: "not found" }, 404);
  await FeedbackDB.delete(c.env.DB, c.req.param("id"));
  if (item.customer_id) {
    await cleanupContentCustomerProductLink(c.env.DB, item.customer_id, item.product_id);
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// PATCH /:id/status — shorthand status transition
// Body: { status }
// ---------------------------------------------------------------------------
router.patch("/:id/status", async (c) => {
  const id = c.req.param("id");

  const existing = await FeedbackDB.getById(c.env.DB, id);
  if (!existing) return c.json({ error: "not found" }, 404);

  let body: { status?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "feedback body must be a JSON object" }, 400);

  const validStatuses = ["new", "triaged", "planned", "in_progress", "shipped", "declined"];
  if (!body.status || !validStatuses.includes(body.status)) {
    return c.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, 400);
  }

  await FeedbackDB.updateStatus(c.env.DB, id, body.status as "new" | "triaged" | "planned" | "in_progress" | "shipped" | "declined");

  const updated = await FeedbackDB.getById(c.env.DB, id);
  return c.json(updated);
});

export default router;
