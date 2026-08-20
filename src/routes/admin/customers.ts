import { Hono } from "hono";
import type { Env } from "../../worker";
import {
  CustomersDB,
  ProductsDB,
  nowIso,
  linkCustomerToProduct,
  unlinkCustomerFromProduct,
  listProductsForCustomer,
} from "../../db/queries";
import type { Customer, Testimonial, FeedbackItem, Review } from "../../db/queries";
import { FirewallViolation, assertFirewallSafe } from "../../lib/firewall";
import { bustProductWidgets } from "../../lib/cache";

const customers = new Hono<{ Bindings: Env }>();
const VALID_LIFECYCLES: Customer["lifecycle"][] = ["lead", "active", "churned", "champion"];
const MAX_CUSTOMER_LIMIT = 200;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidLifecycle(value: unknown): value is Customer["lifecycle"] {
  return typeof value === "string" && (VALID_LIFECYCLES as string[]).includes(value);
}

function parsePaginationInt(value: string | undefined, fallback: number, min: number, max?: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < min) return fallback;
  const lowerBounded = Math.max(min, parsed);
  return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
}

export function shouldBustCustomerAttributionCache(customer: Customer, body: Record<string, unknown>): boolean {
  return (
    (typeof body.name === "string" && body.name.trim() !== customer.name) ||
    (Object.prototype.hasOwnProperty.call(body, "role") && body.role !== customer.role) ||
    (Object.prototype.hasOwnProperty.call(body, "company") && body.company !== customer.company)
  );
}

function parseProductIds(value: unknown): string[] | Response | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((productId) => typeof productId !== "string" || productId.trim() === "")) {
    return new Response(JSON.stringify({ error: "product_ids must be an array of product id strings" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    });
  }
  return [...new Set(value)];
}

const NULLABLE_CUSTOMER_STRING_FIELDS = ["email", "photo_r2_key", "company", "role", "twitter", "linkedin", "website", "notes"] as const;

function validateCustomerPatch(body: Record<string, unknown>): string | null {
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    if (typeof body.name !== "string" || body.name.trim() === "") return "name must be a non-empty string";
  }
  for (const field of NULLABLE_CUSTOMER_STRING_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field) && body[field] !== null && typeof body[field] !== "string") {
      return `${field} must be a string or null`;
    }
  }
  return null;
}

function isManagedMediaKey(value: string): boolean {
  return value.startsWith("media/");
}

function hasOwn<T extends object>(obj: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function markMediaDeletedIfUnreferenced(db: D1Database, key: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE media_assets
          SET deleted_at = ?
        WHERE key = ?
          AND deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM customers WHERE photo_r2_key = ?
          )`,
    )
    .bind(nowIso(), key, key)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function restoreMediaAsset(db: D1Database, key: string): Promise<void> {
  await db
    .prepare("UPDATE media_assets SET deleted_at = NULL WHERE key = ?")
    .bind(key)
    .run();
}

async function deleteManagedMediaIfUnreferenced(env: Env, key: string): Promise<void> {
  const markedDeleted = await markMediaDeletedIfUnreferenced(env.DB, key);
  if (!markedDeleted) return;

  try {
    await env.MEDIA.delete(key);
  } catch (err) {
    try {
      await restoreMediaAsset(env.DB, key);
    } catch (restoreErr) {
      console.warn("Failed to restore media registry after R2 cleanup failure", restoreErr);
    }
    console.warn("Managed media R2 cleanup failed", err);
  }
}

interface CustomerWithProducts extends Customer {
  products: import("../../db/queries").Product[];
}

async function attachProductsToCustomers(db: D1Database, customerRows: Customer[]): Promise<CustomerWithProducts[]> {
  if (customerRows.length === 0) return [];

  const ids = customerRows.map((c) => c.id);
  const placeholders = ids.map(() => "?").join(", ");

  // One batched query to fetch all products associated with the returned customers,
  // then group in TypeScript — avoids N per-customer round-trips.
  const productRows = await db
    .prepare(
      `SELECT DISTINCT cp_union.customer_id, p.*
       FROM (
         SELECT customer_id, product_id FROM customer_products WHERE customer_id IN (${placeholders})
         UNION
         SELECT customer_id, product_id FROM testimonials WHERE customer_id IN (${placeholders})
         UNION
         SELECT customer_id, product_id FROM reviews WHERE customer_id IN (${placeholders})
         UNION
         SELECT customer_id, product_id FROM feedback_items WHERE customer_id IN (${placeholders})
       ) cp_union
       JOIN products p ON p.id = cp_union.product_id
       ORDER BY p.name`,
    )
    .bind(...ids, ...ids, ...ids, ...ids)
    .all<{ customer_id: string } & import("../../db/queries").Product>();

  const productsByCustomer = new Map<string, import("../../db/queries").Product[]>();
  for (const row of productRows.results) {
    const { customer_id, ...product } = row;
    const existing = productsByCustomer.get(customer_id);
    if (existing) {
      existing.push(product as import("../../db/queries").Product);
    } else {
      productsByCustomer.set(customer_id, [product as import("../../db/queries").Product]);
    }
  }

  return customerRows.map((c) => ({ ...c, products: productsByCustomer.get(c.id) ?? [] }));
}

customers.get("/", async (c) => {
  const db = c.env.DB;
  const search = c.req.query("search") ?? "";
  const lifecycle = c.req.query("lifecycle") as Customer["lifecycle"] | undefined;
  const limit = parsePaginationInt(c.req.query("limit"), 50, 1, MAX_CUSTOMER_LIMIT);
  const offset = parsePaginationInt(c.req.query("offset"), 0, 0);
  if (lifecycle !== undefined && !isValidLifecycle(lifecycle)) {
    return c.json({ error: `lifecycle must be one of: ${VALID_LIFECYCLES.join(", ")}` }, 400);
  }

  if (search) {
    const like = `%${search}%`;
    const conditions: string[] = ["(name LIKE ? OR email LIKE ? OR company LIKE ?)"];
    const bindings: unknown[] = [like, like, like];

    if (lifecycle) {
      conditions.push("lifecycle = ?");
      bindings.push(lifecycle);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    bindings.push(limit, offset);

    const [rows, countRow] = await Promise.all([
      db
        .prepare(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .bind(...bindings)
        .all<Customer>(),
      db
        .prepare(`SELECT COUNT(*) as total FROM customers ${where}`)
        .bind(...bindings.slice(0, bindings.length - 2))
        .first<{ total: number }>(),
    ]);

    const customersWithProducts = await attachProductsToCustomers(db, rows.results);
    return c.json({ customers: customersWithProducts, total: countRow?.total ?? 0 });
  }

  const listBindings: unknown[] = [];
  const listConditions: string[] = [];

  if (lifecycle) {
    listConditions.push("lifecycle = ?");
    listBindings.push(lifecycle);
  }

  const where = listConditions.length ? `WHERE ${listConditions.join(" AND ")}` : "";
  const countBindings = [...listBindings];
  listBindings.push(limit, offset);

  const [rows, countRow] = await Promise.all([
    db
      .prepare(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...listBindings)
      .all<Customer>(),
    db
      .prepare(`SELECT COUNT(*) as total FROM customers ${where}`)
      .bind(...countBindings)
      .first<{ total: number }>(),
  ]);

  const customersWithProducts = await attachProductsToCustomers(db, rows.results);
  return c.json({ customers: customersWithProducts, total: countRow?.total ?? 0 });
});

customers.post("/", async (c) => {
  const db = c.env.DB;
  let body: {
    name: string;
    email?: string;
    company?: string;
    role?: string;
    twitter?: string;
    linkedin?: string;
    website?: string;
    lifecycle?: Customer["lifecycle"];
    notes?: string;
    product_ids?: string[];
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "customer body must be a JSON object" }, 400);

  if (typeof body.name !== "string" || body.name.trim() === "") {
    return c.json({ error: "name is required" }, 422);
  }
  if (body.lifecycle !== undefined && !isValidLifecycle(body.lifecycle)) {
    return c.json({ error: `lifecycle must be one of: ${VALID_LIFECYCLES.join(", ")}` }, 422);
  }
  const patchError = validateCustomerPatch(body);
  if (patchError) return c.json({ error: patchError }, 422);

  const parsedProductIds = parseProductIds(body.product_ids);
  if (parsedProductIds instanceof Response) return parsedProductIds;
  const productIds = parsedProductIds ?? [];
  for (const productId of productIds) {
    const product = await ProductsDB.getById(db, productId);
    if (!product) {
      return c.json({ error: "product not found", product_id: productId }, 404);
    }
  }

  const customer = await CustomersDB.create(db, {
    name: body.name.trim(),
    email: body.email ?? null,
    photo_r2_key: null,
    company: body.company ?? null,
    role: body.role ?? null,
    twitter: body.twitter ?? null,
    linkedin: body.linkedin ?? null,
    website: body.website ?? null,
    lifecycle: body.lifecycle ?? "lead",
    notes: body.notes ?? null,
  });

  if (productIds.length > 0) {
    for (const productId of productIds) {
      try {
        await linkCustomerToProduct(db, customer.id, productId, assertFirewallSafe, "manual");
      } catch (err) {
        await CustomersDB.delete(db, customer.id);
        if (err instanceof FirewallViolation) {
          return c.json({ error: err.userMessage, code: "FIREWALL_VIOLATION" }, 422);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
    }
  }

  return c.json(customer, 201);
});

customers.get("/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");

  const customer = await CustomersDB.getById(db, id);
  if (!customer) {
    return c.json({ error: "customer not found" }, 404);
  }

  const [products, testimonials, feedback, reviews] = await Promise.all([
    listProductsForCustomer(db, id),
    db
      .prepare("SELECT * FROM testimonials WHERE customer_id = ? ORDER BY created_at DESC")
      .bind(id)
      .all<Testimonial>(),
    db
      .prepare("SELECT * FROM feedback_items WHERE customer_id = ? ORDER BY created_at DESC")
      .bind(id)
      .all<FeedbackItem>(),
    db
      .prepare("SELECT * FROM reviews WHERE customer_id = ? ORDER BY imported_at DESC")
      .bind(id)
      .all<Review>(),
  ]);

  return c.json({
    customer,
    products,
    testimonials: testimonials.results,
    feedback: feedback.results,
    reviews: reviews.results,
  });
});

customers.patch("/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");

  let body: Partial<{
    name: string;
    email: string | null;
    photo_r2_key: string | null;
    company: string | null;
    role: string | null;
    twitter: string | null;
    linkedin: string | null;
    website: string | null;
    lifecycle: Customer["lifecycle"];
    notes: string | null;
  }>;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "customer body must be a JSON object" }, 400);

  if (body.lifecycle !== undefined && !isValidLifecycle(body.lifecycle)) {
    return c.json({ error: `lifecycle must be one of: ${VALID_LIFECYCLES.join(", ")}` }, 422);
  }
  const patchError = validateCustomerPatch(body);
  if (patchError) return c.json({ error: patchError }, 422);
  if (typeof body.photo_r2_key === "string" && !isManagedMediaKey(body.photo_r2_key)) {
    return c.json({ error: "photo_r2_key must reference a managed media key" }, 422);
  }

  const customer = await CustomersDB.getById(db, id);
  if (!customer) {
    return c.json({ error: "customer not found" }, 404);
  }
  const previousPhotoKey = customer.photo_r2_key;
  const shouldBustAttribution = shouldBustCustomerAttributionCache(customer, body);
  const photoPatchProvided = hasOwn(body, "photo_r2_key");
  const requestedPhotoKey = body.photo_r2_key;
  const scalarPatch = { ...body };
  delete scalarPatch.photo_r2_key;

  if (typeof requestedPhotoKey === "string") {
    const result = await db
      .prepare(
        `UPDATE customers
            SET photo_r2_key = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM media_assets
               WHERE key = ? AND deleted_at IS NULL
            )`,
      )
      .bind(requestedPhotoKey, nowIso(), id, requestedPhotoKey)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      return c.json({ error: "photo_r2_key not found" }, 404);
    }
  } else if (photoPatchProvided) {
    await CustomersDB.update(db, id, { photo_r2_key: null });
  }

  if (Object.keys(scalarPatch).length > 0) {
    await CustomersDB.update(db, id, scalarPatch);
  }

  if (shouldBustAttribution) {
    const affectedProducts = await db
      .prepare(
        `SELECT DISTINCT p.slug
         FROM testimonials t
         JOIN products p ON p.id = t.product_id
         WHERE t.customer_id = ? AND t.approved = 1`,
      )
      .bind(id)
      .all<{ slug: string }>();
    await Promise.all(affectedProducts.results.map((product) => bustProductWidgets(product.slug)));
  }

  if (
    photoPatchProvided &&
    previousPhotoKey &&
    isManagedMediaKey(previousPhotoKey) &&
    previousPhotoKey !== requestedPhotoKey
  ) {
    await deleteManagedMediaIfUnreferenced(c.env, previousPhotoKey);
  }

  const updated = await CustomersDB.getById(db, id);
  return c.json(updated!);
});

customers.delete("/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");

  const customer = await CustomersDB.getById(db, id);
  if (!customer) {
    return c.json({ error: "customer not found" }, 404);
  }

  try {
    await CustomersDB.delete(db, id);
    if (customer.photo_r2_key && isManagedMediaKey(customer.photo_r2_key)) {
      await deleteManagedMediaIfUnreferenced(c.env, customer.photo_r2_key);
    }
  } catch (err) {
    // testimonials.customer_id and reviews/feedback FKs use RESTRICT/SET NULL.
    // A RESTRICT violation surfaces as a D1 constraint error — surface as 409
    // so the UI can prompt the operator to reassign or delete content first.
    const msg = err instanceof Error ? err.message : String(err);
    if (/FOREIGN KEY constraint failed/i.test(msg)) {
      return c.json(
        { error: "customer has linked testimonials; reassign or delete them first", code: "FK_RESTRICT" },
        409,
      );
    }
    throw err;
  }
  return c.body(null, 204);
});

customers.post("/:id/link-product", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");

  const customer = await CustomersDB.getById(db, id);
  if (!customer) {
    return c.json({ error: "customer not found" }, 404);
  }

  let body: { product_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "customer body must be a JSON object" }, 400);
  if (typeof body.product_id !== "string" || body.product_id.trim() === "") {
    return c.json({ error: "product_id is required" }, 422);
  }
  const productId = body.product_id.trim();
  const product = await ProductsDB.getById(db, productId);
  if (!product) return c.json({ error: "product not found", product_id: productId }, 404);

  try {
    await linkCustomerToProduct(db, id, productId, assertFirewallSafe, "manual");
  } catch (err) {
    if (err instanceof FirewallViolation) {
      return c.json({ error: err.userMessage, code: "FIREWALL_VIOLATION" }, 422);
    }
    throw err;
  }

  return c.json({ linked: true });
});

customers.delete("/:id/products/:productId", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const productId = c.req.param("productId");

  const linkedContent = await db
    .prepare(
      `SELECT COUNT(*) as total FROM (
         SELECT id FROM testimonials WHERE customer_id = ? AND product_id = ?
         UNION ALL
         SELECT id FROM feedback_items WHERE customer_id = ? AND product_id = ?
         UNION ALL
         SELECT id FROM reviews WHERE customer_id = ? AND product_id = ?
       )`,
    )
    .bind(id, productId, id, productId, id, productId)
    .first<{ total: number }>();

  if ((linkedContent?.total ?? 0) > 0) {
    return c.json(
      { error: "customer has linked content for this product; delete or reassign it before unlinking", code: "PRODUCT_CONTENT_EXISTS" },
      409,
    );
  }

  await unlinkCustomerFromProduct(db, id, productId);
  return c.body(null, 204);
});

customers.post("/:id/merge", async (c) => {
  const db = c.env.DB;
  const targetId = c.req.param("id");

  const target = await CustomersDB.getById(db, targetId);
  if (!target) {
    return c.json({ error: "target customer not found" }, 404);
  }

  let body: { source_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isJsonObject(body)) return c.json({ error: "customer body must be a JSON object" }, 400);
  if (typeof body.source_id !== "string" || body.source_id.trim() === "") {
    return c.json({ error: "source_id is required" }, 422);
  }
  const sourceId = body.source_id.trim();

  const source = await CustomersDB.getById(db, sourceId);
  if (!source) {
    return c.json({ error: "source customer not found" }, 404);
  }

  if (sourceId === targetId) {
    return c.json({ error: "source and target must be different customers" }, 422);
  }

  // First check for any firewall violations BEFORE making changes
  const sourceAssociatedProducts = await db
    .prepare(
      `SELECT product_id,
              CASE WHEN MAX(manual_link) = 1 THEN 'manual' ELSE 'content' END as source
         FROM (
           SELECT product_id,
                  CASE WHEN source = 'manual' THEN 1 ELSE 0 END as manual_link
             FROM customer_products
            WHERE customer_id = ?
           UNION ALL
           SELECT product_id, 0 FROM testimonials WHERE customer_id = ?
           UNION ALL
           SELECT product_id, 0 FROM reviews WHERE customer_id = ?
           UNION ALL
           SELECT product_id, 0 FROM feedback_items WHERE customer_id = ?
           UNION ALL
           SELECT target_cp.product_id, 1
             FROM customer_products target_cp
            WHERE target_cp.customer_id = ?
              AND target_cp.source = 'manual'
              AND target_cp.product_id IN (
                SELECT product_id FROM customer_products WHERE customer_id = ?
                UNION
                SELECT product_id FROM testimonials WHERE customer_id = ?
                UNION
                SELECT product_id FROM reviews WHERE customer_id = ?
                UNION
                SELECT product_id FROM feedback_items WHERE customer_id = ?
              )
         )
        GROUP BY product_id`,
    )
    .bind(sourceId, sourceId, sourceId, sourceId, targetId, sourceId, sourceId, sourceId, sourceId)
    .all<{ product_id: string; source: "manual" | "content" }>();
  const sourceProducts = sourceAssociatedProducts.results;
  const sourceProductIds = sourceProducts.map((row) => row.product_id);

  for (const productId of sourceProductIds) {
    try {
      await assertFirewallSafe(db, targetId, productId);
    } catch (err) {
      if (err instanceof FirewallViolation) {
        return c.json(
          { error: `Merge blocked — ${err.userMessage}`, code: "FIREWALL_VIOLATION" },
          422,
        );
      } else {
        throw err;
      }
    }
  }

  const cacheBustProducts = await db
    .prepare(
      `SELECT DISTINCT p.slug
       FROM testimonials t
       JOIN products p ON p.id = t.product_id
       WHERE t.approved = 1 AND t.customer_id IN (?, ?)`,
    )
    .bind(sourceId, targetId)
    .all<{ slug: string }>();

  // Atomically copy memberships, re-assign all content rows, and delete source.
  const joinedAt = nowIso();
  await db.batch([
    ...sourceProducts.map((product) =>
      db
        .prepare(
          `INSERT INTO customer_products (customer_id, product_id, joined_at, source)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(customer_id, product_id) DO UPDATE SET
             source = CASE
               WHEN customer_products.source = 'manual' OR excluded.source = 'manual'
               THEN 'manual'
               ELSE 'content'
             END`,
        )
        .bind(targetId, product.product_id, joinedAt, product.source),
    ),
    db.prepare("UPDATE testimonials SET customer_id = ? WHERE customer_id = ?").bind(targetId, sourceId),
    db.prepare("UPDATE feedback_items SET customer_id = ? WHERE customer_id = ?").bind(targetId, sourceId),
    db.prepare("UPDATE reviews SET customer_id = ? WHERE customer_id = ?").bind(targetId, sourceId),
    db.prepare("DELETE FROM customers WHERE id = ?").bind(sourceId),
  ]);

  if (source.photo_r2_key && isManagedMediaKey(source.photo_r2_key)) {
    await deleteManagedMediaIfUnreferenced(c.env, source.photo_r2_key);
  }

  await Promise.all(cacheBustProducts.results.map((product) => bustProductWidgets(product.slug)));

  const updated = await CustomersDB.getById(db, targetId);
  return c.json(updated!);
});

export default customers;
