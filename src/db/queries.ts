import type { D1Database } from "@cloudflare/workers-types";
import { assertFirewallSafe } from "../lib/firewall";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function generateId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row types — mirror the SQL schema column for column.
// ---------------------------------------------------------------------------

export interface Product {
  id: string;
  slug: string;
  name: string;
  brand_color: string | null;
  primary_domain: string | null;
  widget_public_key: string;
  origin_allowlist_json: string;
  firewall_group: string | null;
  created_at: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  photo_r2_key: string | null;
  company: string | null;
  role: string | null;
  twitter: string | null;
  linkedin: string | null;
  website: string | null;
  lifecycle: "lead" | "active" | "churned" | "champion";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerProduct {
  customer_id: string;
  product_id: string;
  joined_at: string;
  source: "manual" | "content";
}

export interface Testimonial {
  id: string;
  customer_id: string;
  product_id: string;
  quote: string;
  source: "twitter" | "email" | "manual" | "widget" | "import";
  source_url: string | null;
  rating: number | null;
  approved: number;
  featured: number;
  created_at: string;
}

export interface FeedbackItem {
  id: string;
  customer_id: string | null;
  product_id: string;
  type: "feature_request" | "bug" | "general";
  title: string;
  body: string | null;
  status: "new" | "triaged" | "planned" | "in_progress" | "shipped" | "declined";
  upvotes: number;
  public_visible: number;
  created_at: string;
  updated_at: string;
}

export interface Review {
  id: string;
  customer_id: string | null;
  product_id: string;
  source: "g2" | "trustpilot" | "capterra" | "app_store" | "play_store" | "twitter" | "product_hunt" | "rss" | "csv" | "manual";
  external_id: string;
  rating: number | null;
  body: string;
  author_name: string | null;
  source_url: string | null;
  imported_at: string;
}

export type ConnectorConfigSource = "rss" | "g2" | "trustpilot";

export interface ConnectorConfigRow {
  id: string;
  product_id: string;
  source: ConnectorConfigSource;
  config_json: string;
  enabled: number;
  last_polled_at: string | null;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_inserted: number | null;
  created_at: string;
}

export interface ConnectorConfig extends Omit<ConnectorConfigRow, "config_json" | "enabled"> {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface Tag {
  id: string;
  name: string;
}

export interface TagLink {
  tag_id: string;
  item_id: string;
  item_type: "customer" | "testimonial" | "feedback" | "review";
}

export interface IngestRateLimit {
  product_id: string;
  origin: string;
  window_start: string;
  count: number;
}

// ---------------------------------------------------------------------------
// ProductsDB
// ---------------------------------------------------------------------------

export const ProductsDB = {
  async getById(db: D1Database, id: string): Promise<Product | null> {
    return db.prepare("SELECT * FROM products WHERE id = ?").bind(id).first<Product>();
  },

  async getBySlug(db: D1Database, slug: string): Promise<Product | null> {
    return db.prepare("SELECT * FROM products WHERE slug = ?").bind(slug).first<Product>();
  },

  async getByWidgetKey(db: D1Database, key: string): Promise<Product | null> {
    return db.prepare("SELECT * FROM products WHERE widget_public_key = ?").bind(key).first<Product>();
  },

  async list(db: D1Database): Promise<Product[]> {
    const result = await db.prepare("SELECT * FROM products ORDER BY created_at ASC").all<Product>();
    return result.results;
  },

  async upsert(
    db: D1Database,
    row: Omit<Product, "created_at">,
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO products (id, slug, name, brand_color, primary_domain, widget_public_key, origin_allowlist_json, firewall_group)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug = excluded.slug,
           name = excluded.name,
           brand_color = excluded.brand_color,
           primary_domain = excluded.primary_domain,
           widget_public_key = excluded.widget_public_key,
           origin_allowlist_json = excluded.origin_allowlist_json,
           firewall_group = excluded.firewall_group`,
      )
      .bind(
        row.id,
        row.slug,
        row.name,
        row.brand_color,
        row.primary_domain,
        row.widget_public_key,
        row.origin_allowlist_json,
        row.firewall_group,
      )
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// CustomersDB
// ---------------------------------------------------------------------------

export const CustomersDB = {
  async getById(db: D1Database, id: string): Promise<Customer | null> {
    return db.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first<Customer>();
  },

  async getByEmail(db: D1Database, email: string): Promise<Customer | null> {
    return db.prepare("SELECT * FROM customers WHERE email = ?").bind(email).first<Customer>();
  },

  async list(
    db: D1Database,
    opts: { lifecycle?: Customer["lifecycle"]; limit?: number; offset?: number } = {},
  ): Promise<Customer[]> {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (opts.lifecycle) {
      conditions.push("lifecycle = ?");
      bindings.push(opts.lifecycle);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    bindings.push(limit, offset);

    const result = await db
      .prepare(`SELECT * FROM customers ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings)
      .all<Customer>();
    return result.results;
  },

  async create(
    db: D1Database,
    input: Omit<Customer, "id" | "created_at" | "updated_at">,
  ): Promise<Customer> {
    const id = generateId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO customers (id, name, email, photo_r2_key, company, role, twitter, linkedin, website, lifecycle, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.name,
        input.email,
        input.photo_r2_key,
        input.company,
        input.role,
        input.twitter,
        input.linkedin,
        input.website,
        input.lifecycle,
        input.notes,
        now,
        now,
      )
      .run();
    return { ...input, id, created_at: now, updated_at: now };
  },

  async update(
    db: D1Database,
    id: string,
    patch: Partial<Omit<Customer, "id" | "created_at" | "updated_at">>,
  ): Promise<void> {
    const ALLOWED = new Set(["name", "email", "photo_r2_key", "company", "role", "twitter", "linkedin", "website", "lifecycle", "notes"]);
    const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter(f => ALLOWED.has(f));
    if (fields.length === 0) return;

    const setClauses = fields.map((f) => `${f} = ?`).join(", ");
    const values = fields.map((f) => patch[f]);
    values.push(nowIso());

    await db
      .prepare(`UPDATE customers SET ${setClauses}, updated_at = ? WHERE id = ?`)
      .bind(...values, id)
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// Customer ↔ Product link (firewall-guarded)
// ---------------------------------------------------------------------------

export async function linkCustomerToProduct(
  db: D1Database,
  customerId: string,
  productId: string,
  firewallCheck: typeof assertFirewallSafe = assertFirewallSafe,
  source: "manual" | "content" = "content",
): Promise<boolean> {
  const now = nowIso();
  if (await insertCustomerProductIfFirewallSafe(db, customerId, productId, now, source)) return true;

  if (await customerProductLinkExists(db, customerId, productId)) {
    if (source === "manual") await promoteCustomerProductLinkToManual(db, customerId, productId);
    return false;
  }

  await firewallCheck(db, customerId, productId);

  if (await insertCustomerProductIfFirewallSafe(db, customerId, productId, now, source)) return true;
  if (await customerProductLinkExists(db, customerId, productId)) {
    if (source === "manual") await promoteCustomerProductLinkToManual(db, customerId, productId);
    return false;
  }

  throw new Error(`customer product link failed for customer ${customerId} and product ${productId}`);
}

async function insertCustomerProductIfFirewallSafe(
  db: D1Database,
  customerId: string,
  productId: string,
  joinedAt: string,
  source: "manual" | "content",
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO customer_products (customer_id, product_id, joined_at, source)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1
         FROM products candidate
         JOIN (
           SELECT product_id FROM customer_products WHERE customer_id = ?
           UNION
           SELECT product_id FROM testimonials WHERE customer_id = ?
           UNION
           SELECT product_id FROM reviews WHERE customer_id = ?
           UNION
           SELECT product_id FROM feedback_items WHERE customer_id = ?
         ) associated ON 1 = 1
         JOIN products existing ON existing.id = associated.product_id
         WHERE candidate.id = ?
           AND candidate.firewall_group IS NOT NULL
           AND existing.firewall_group = candidate.firewall_group
           AND existing.id != candidate.id
       )
       ON CONFLICT(customer_id, product_id) DO NOTHING`,
    )
    .bind(customerId, productId, joinedAt, source, customerId, customerId, customerId, customerId, productId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

async function customerProductLinkExists(
  db: D1Database,
  customerId: string,
  productId: string,
): Promise<boolean> {
  const existing = await db
    .prepare("SELECT 1 FROM customer_products WHERE customer_id = ? AND product_id = ?")
    .bind(customerId, productId)
    .first<{ "1": number }>();
  return Boolean(existing);
}

async function promoteCustomerProductLinkToManual(
  db: D1Database,
  customerId: string,
  productId: string,
): Promise<void> {
  await db
    .prepare("UPDATE customer_products SET source = 'manual' WHERE customer_id = ? AND product_id = ? AND source = 'content'")
    .bind(customerId, productId)
    .run();
}

export async function unlinkCustomerFromProduct(
  db: D1Database,
  customerId: string,
  productId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM customer_products WHERE customer_id = ? AND product_id = ?")
    .bind(customerId, productId)
    .run();
}

export async function cleanupContentCustomerProductLink(
  db: D1Database,
  customerId: string,
  productId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM customer_products
        WHERE customer_id = ?
          AND product_id = ?
          AND source = 'content'
          AND NOT EXISTS (
            SELECT 1 FROM testimonials WHERE customer_id = ? AND product_id = ?
            UNION ALL
            SELECT 1 FROM reviews WHERE customer_id = ? AND product_id = ?
            UNION ALL
            SELECT 1 FROM feedback_items WHERE customer_id = ? AND product_id = ?
          )`,
    )
    .bind(customerId, productId, customerId, productId, customerId, productId, customerId, productId)
    .run();
}

export async function listProductsForCustomer(db: D1Database, customerId: string): Promise<Product[]> {
  const result = await db
    .prepare(
      `SELECT p.* FROM products p
       JOIN (
         SELECT product_id FROM customer_products WHERE customer_id = ?
         UNION
         SELECT product_id FROM testimonials WHERE customer_id = ?
         UNION
         SELECT product_id FROM reviews WHERE customer_id = ?
         UNION
         SELECT product_id FROM feedback_items WHERE customer_id = ?
       ) associated ON associated.product_id = p.id
       ORDER BY p.name`,
    )
    .bind(customerId, customerId, customerId, customerId)
    .all<Product>();
  return result.results;
}

// ---------------------------------------------------------------------------
// TestimonialsDB
// ---------------------------------------------------------------------------

export const TestimonialsDB = {
  async getById(db: D1Database, id: string): Promise<Testimonial | null> {
    return db.prepare("SELECT * FROM testimonials WHERE id = ?").bind(id).first<Testimonial>();
  },

  async listByProduct(
    db: D1Database,
    productId: string,
    opts: { approvedOnly?: boolean; featuredOnly?: boolean; limit?: number } = {},
  ): Promise<Testimonial[]> {
    const conditions = ["product_id = ?"];
    const bindings: unknown[] = [productId];

    if (opts.approvedOnly) {
      conditions.push("approved = 1");
    }
    if (opts.featuredOnly) {
      conditions.push("featured = 1");
    }

    const limit = opts.limit ?? 100;
    bindings.push(limit);

    const result = await db
      .prepare(`SELECT * FROM testimonials WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .bind(...bindings)
      .all<Testimonial>();
    return result.results;
  },

  async create(
    db: D1Database,
    input: Omit<Testimonial, "id" | "created_at" | "approved" | "featured">,
  ): Promise<Testimonial> {
    const id = generateId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO testimonials (id, customer_id, product_id, quote, source, source_url, rating, approved, featured, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      )
      .bind(id, input.customer_id, input.product_id, input.quote, input.source, input.source_url, input.rating, now)
      .run();
    return { ...input, id, approved: 0, featured: 0, created_at: now };
  },

  async setApproved(db: D1Database, id: string, approved: boolean): Promise<void> {
    await db.prepare("UPDATE testimonials SET approved = ? WHERE id = ?").bind(approved ? 1 : 0, id).run();
  },

  async setFeatured(db: D1Database, id: string, featured: boolean): Promise<void> {
    await db.prepare("UPDATE testimonials SET featured = ? WHERE id = ?").bind(featured ? 1 : 0, id).run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM testimonials WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// FeedbackDB
// ---------------------------------------------------------------------------

export const FeedbackDB = {
  async getById(db: D1Database, id: string): Promise<FeedbackItem | null> {
    return db.prepare("SELECT * FROM feedback_items WHERE id = ?").bind(id).first<FeedbackItem>();
  },

  async listByProduct(
    db: D1Database,
    productId: string,
    opts: { status?: FeedbackItem["status"]; type?: FeedbackItem["type"]; limit?: number; offset?: number } = {},
  ): Promise<FeedbackItem[]> {
    const conditions = ["product_id = ?"];
    const bindings: unknown[] = [productId];

    if (opts.status) {
      conditions.push("status = ?");
      bindings.push(opts.status);
    }
    if (opts.type) {
      conditions.push("type = ?");
      bindings.push(opts.type);
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    bindings.push(limit, offset);

    const result = await db
      .prepare(
        `SELECT * FROM feedback_items WHERE ${conditions.join(" AND ")} ORDER BY upvotes DESC, created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bindings)
      .all<FeedbackItem>();
    return result.results;
  },

  async create(
    db: D1Database,
    input: Omit<FeedbackItem, "id" | "created_at" | "updated_at" | "upvotes" | "public_visible">,
  ): Promise<FeedbackItem> {
    const id = generateId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT INTO feedback_items (id, customer_id, product_id, type, title, body, status, upvotes, public_visible, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      )
      .bind(id, input.customer_id, input.product_id, input.type, input.title, input.body, input.status, now, now)
      .run();
    return { ...input, id, upvotes: 0, public_visible: 0, created_at: now, updated_at: now };
  },

  async updateStatus(db: D1Database, id: string, status: FeedbackItem["status"]): Promise<void> {
    await db
      .prepare("UPDATE feedback_items SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, nowIso(), id)
      .run();
  },

  async incrementUpvotes(db: D1Database, id: string): Promise<void> {
    await db.prepare("UPDATE feedback_items SET upvotes = upvotes + 1 WHERE id = ?").bind(id).run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM feedback_items WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// ReviewsDB
// ---------------------------------------------------------------------------

export const ReviewsDB = {
  async getById(db: D1Database, id: string): Promise<Review | null> {
    return db.prepare("SELECT * FROM reviews WHERE id = ?").bind(id).first<Review>();
  },

  async getByProductSourceAndExternalId(
    db: D1Database,
    productId: string,
    source: Review["source"],
    externalId: string,
  ): Promise<Review | null> {
    return db
      .prepare("SELECT * FROM reviews WHERE product_id = ? AND source = ? AND external_id = ?")
      .bind(productId, source, externalId)
      .first<Review>();
  },

  async listByProduct(
    db: D1Database,
    productId: string,
    opts: { source?: Review["source"]; limit?: number; offset?: number } = {},
  ): Promise<Review[]> {
    const conditions = ["product_id = ?"];
    const bindings: unknown[] = [productId];

    if (opts.source) {
      conditions.push("source = ?");
      bindings.push(opts.source);
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    bindings.push(limit, offset);

    const result = await db
      .prepare(
        `SELECT * FROM reviews WHERE ${conditions.join(" AND ")} ORDER BY imported_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(...bindings)
      .all<Review>();
    return result.results;
  },

  async upsert(db: D1Database, input: Omit<Review, "id" | "imported_at">): Promise<void> {
    const id = generateId();
    const now = nowIso();
    await db
      .prepare(
        `INSERT OR IGNORE INTO reviews (id, customer_id, product_id, source, external_id, rating, body, author_name, source_url, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.customer_id,
        input.product_id,
        input.source,
        input.external_id,
        input.rating,
        input.body,
        input.author_name,
        input.source_url,
        now,
      )
      .run();
    await db
      .prepare(
        `UPDATE reviews SET
           customer_id = COALESCE(?, customer_id),
           rating = ?,
           body = ?,
           author_name = ?,
           source_url = ?,
           imported_at = ?
         WHERE product_id = ? AND source = ? AND external_id = ?`,
      )
      .bind(
        input.customer_id,
        input.rating,
        input.body,
        input.author_name,
        input.source_url,
        now,
        input.product_id,
        input.source,
        input.external_id,
      )
      .run();
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM reviews WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// ConnectorConfigsDB
// ---------------------------------------------------------------------------

function parseConnectorConfig(row: ConnectorConfigRow): ConnectorConfig {
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.config_json);
    config = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    config = {};
  }

  const { config_json: _configJson, enabled, ...rest } = row;
  return { ...rest, enabled: enabled === 1, config };
}

export const ConnectorConfigsDB = {
  async getById(db: D1Database, id: string): Promise<ConnectorConfig | null> {
    const row = await db
      .prepare("SELECT * FROM connector_configs WHERE id = ?")
      .bind(id)
      .first<ConnectorConfigRow>();
    return row ? parseConnectorConfig(row) : null;
  },

  async list(db: D1Database): Promise<ConnectorConfig[]> {
    const result = await db
      .prepare("SELECT * FROM connector_configs ORDER BY created_at DESC")
      .all<ConnectorConfigRow>();
    return result.results.map(parseConnectorConfig);
  },

  async listByProduct(db: D1Database, productId: string): Promise<ConnectorConfig[]> {
    const result = await db
      .prepare("SELECT * FROM connector_configs WHERE product_id = ? ORDER BY created_at DESC")
      .bind(productId)
      .all<ConnectorConfigRow>();
    return result.results.map(parseConnectorConfig);
  },

  async upsert(
    db: D1Database,
    input: {
      id?: string;
      product_id: string;
      source: ConnectorConfigSource;
      config: Record<string, unknown>;
      enabled: boolean;
    },
  ): Promise<ConnectorConfig> {
    const id = input.id ?? generateId();
    const enabled = input.enabled ? 1 : 0;
    const configJson = JSON.stringify(input.config);
    await db
      .prepare(
        `INSERT INTO connector_configs (id, product_id, source, config_json, enabled)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_polled_at = CASE
             WHEN connector_configs.product_id != excluded.product_id
               OR connector_configs.source != excluded.source
               OR connector_configs.config_json != excluded.config_json
             THEN NULL ELSE connector_configs.last_polled_at END,
           last_status = CASE
             WHEN connector_configs.product_id != excluded.product_id
               OR connector_configs.source != excluded.source
               OR connector_configs.config_json != excluded.config_json
             THEN NULL ELSE connector_configs.last_status END,
           last_error = CASE
             WHEN connector_configs.product_id != excluded.product_id
               OR connector_configs.source != excluded.source
               OR connector_configs.config_json != excluded.config_json
             THEN NULL ELSE connector_configs.last_error END,
           last_inserted = CASE
             WHEN connector_configs.product_id != excluded.product_id
               OR connector_configs.source != excluded.source
               OR connector_configs.config_json != excluded.config_json
             THEN NULL ELSE connector_configs.last_inserted END,
           product_id = excluded.product_id,
           source = excluded.source,
           config_json = excluded.config_json,
           enabled = excluded.enabled`,
      )
      .bind(id, input.product_id, input.source, configJson, enabled)
      .run();

    const persisted = await ConnectorConfigsDB.getById(db, id);
    if (!persisted) {
      throw new Error("connector config upsert failed");
    }
    return persisted;
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM connector_configs WHERE id = ?").bind(id).run();
  },
};

// ---------------------------------------------------------------------------
// TagsDB
// ---------------------------------------------------------------------------

export const TagsDB = {
  async getById(db: D1Database, id: string): Promise<Tag | null> {
    return db.prepare("SELECT * FROM tags WHERE id = ?").bind(id).first<Tag>();
  },

  async getByName(db: D1Database, name: string): Promise<Tag | null> {
    return db.prepare("SELECT * FROM tags WHERE name = ?").bind(name).first<Tag>();
  },

  async list(db: D1Database): Promise<Tag[]> {
    const result = await db.prepare("SELECT * FROM tags ORDER BY name ASC").all<Tag>();
    return result.results;
  },

  async create(db: D1Database, name: string): Promise<Tag> {
    const id = generateId();
    await db.prepare("INSERT INTO tags (id, name) VALUES (?, ?)").bind(id, name).run();
    return { id, name };
  },

  async findOrCreate(db: D1Database, name: string): Promise<Tag> {
    const existing = await TagsDB.getByName(db, name);
    if (existing) return existing;
    return TagsDB.create(db, name);
  },

  async linkToItem(
    db: D1Database,
    tagId: string,
    itemId: string,
    itemType: TagLink["item_type"],
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO tag_links (tag_id, item_id, item_type) VALUES (?, ?, ?)
         ON CONFLICT(tag_id, item_id, item_type) DO NOTHING`,
      )
      .bind(tagId, itemId, itemType)
      .run();
  },

  async unlinkFromItem(
    db: D1Database,
    tagId: string,
    itemId: string,
    itemType: TagLink["item_type"],
  ): Promise<void> {
    await db
      .prepare("DELETE FROM tag_links WHERE tag_id = ? AND item_id = ? AND item_type = ?")
      .bind(tagId, itemId, itemType)
      .run();
  },

  async listForItem(db: D1Database, itemId: string, itemType: TagLink["item_type"]): Promise<Tag[]> {
    const result = await db
      .prepare(
        `SELECT t.* FROM tags t
         JOIN tag_links tl ON tl.tag_id = t.id
         WHERE tl.item_id = ? AND tl.item_type = ?`,
      )
      .bind(itemId, itemType)
      .all<Tag>();
    return result.results;
  },

  async delete(db: D1Database, id: string): Promise<void> {
    await db.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
  },
};
