-- Ventora CRM — initial schema.
-- See portfolio/ARCHITECTURE.md for the data model and portfolio/SECURITY.md for the firewall rules.
--
-- Conventions:
--   * UUIDs as TEXT (generated app-side via crypto.randomUUID()).
--   * Enums encoded as TEXT + CHECK constraint (D1 has no native enum).
--   * Timestamps stored as TEXT in ISO-8601 UTC.
--   * Foreign keys ON DELETE CASCADE only where the child row is meaningless
--     without the parent (e.g. customer_products); otherwise RESTRICT.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- products
--
-- One row per Ventora product. firewall_group enforces the conflict-of-interest
-- separation rule (see portfolio/SECURITY.md, "Conflict-of-interest firewall"): customers
-- linked to a product in firewall_group "cre" cannot be linked to any other
-- product in the same group. Enforced application-side in src/lib/firewall.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id                    TEXT PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,
  name                  TEXT NOT NULL,
  brand_color           TEXT,                       -- hex, e.g. "#0ea5e9"
  primary_domain        TEXT,                       -- e.g. "camaudit.io"
  widget_public_key     TEXT NOT NULL UNIQUE,       -- opaque, generated at seed time
  origin_allowlist_json TEXT NOT NULL DEFAULT '[]', -- JSON array of allowed Origin values
  firewall_group        TEXT,                       -- NULL = no firewall constraint
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_products_firewall_group ON products(firewall_group) WHERE firewall_group IS NOT NULL;

-- ---------------------------------------------------------------------------
-- customers
--
-- The CRM spine. Everything (testimonials, feedback, reviews) hangs off this.
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE,                        -- NULL allowed (anonymous feedback)
  photo_r2_key  TEXT,                               -- R2 object key for avatar
  company       TEXT,
  role          TEXT,
  twitter       TEXT,                               -- handle without @
  linkedin      TEXT,                               -- profile URL
  website       TEXT,
  lifecycle     TEXT NOT NULL DEFAULT 'lead'
                CHECK (lifecycle IN ('lead', 'active', 'churned', 'champion')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_lifecycle ON customers(lifecycle);

-- ---------------------------------------------------------------------------
-- customer_products
--
-- Many-to-many. Firewall enforcement happens in src/lib/firewall.ts before
-- inserts, since SQLite/D1 can't express the cross-row constraint declaratively.
-- ---------------------------------------------------------------------------
CREATE TABLE customer_products (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  joined_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id, product_id)
);

CREATE INDEX idx_customer_products_product ON customer_products(product_id);

-- ---------------------------------------------------------------------------
-- testimonials
-- ---------------------------------------------------------------------------
CREATE TABLE testimonials (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  product_id  TEXT NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
  quote       TEXT NOT NULL,
  source      TEXT NOT NULL
              CHECK (source IN ('twitter', 'email', 'manual', 'widget', 'import')),
  source_url  TEXT,
  rating      INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  approved    INTEGER NOT NULL DEFAULT 0,           -- 0/1 boolean
  featured    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_testimonials_product_approved ON testimonials(product_id, approved);
CREATE INDEX idx_testimonials_featured ON testimonials(featured) WHERE featured = 1;
CREATE INDEX idx_testimonials_customer ON testimonials(customer_id);

-- ---------------------------------------------------------------------------
-- feedback_items
--
-- Internal kanban v1; public roadmap deferred to v2 (public_visible kept for
-- forward compat but not surfaced anywhere yet).
-- ---------------------------------------------------------------------------
CREATE TABLE feedback_items (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT REFERENCES customers(id) ON DELETE SET NULL,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  type           TEXT NOT NULL
                 CHECK (type IN ('feature_request', 'bug', 'general')),
  title          TEXT NOT NULL,
  body           TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined')),
  upvotes        INTEGER NOT NULL DEFAULT 0,
  public_visible INTEGER NOT NULL DEFAULT 0,        -- reserved for v2 public roadmap
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_feedback_product_status ON feedback_items(product_id, status);
CREATE INDEX idx_feedback_type ON feedback_items(type);
CREATE INDEX idx_feedback_customer ON feedback_items(customer_id);

-- ---------------------------------------------------------------------------
-- reviews
--
-- External imports (G2, Trustpilot, App Store, etc). Dedup on (source, external_id).
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
  id          TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL
              CHECK (source IN ('g2', 'trustpilot', 'capterra', 'app_store', 'play_store', 'twitter', 'product_hunt', 'rss', 'csv', 'manual')),
  external_id TEXT NOT NULL,                        -- platform-specific id (or hash for csv/manual)
  rating      INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  body        TEXT NOT NULL,
  author_name TEXT,
  source_url  TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, external_id)
);

CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_customer ON reviews(customer_id);

-- ---------------------------------------------------------------------------
-- tags + tag_links (polymorphic tagging across all item types)
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE tag_links (
  tag_id    TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  item_id   TEXT NOT NULL,
  item_type TEXT NOT NULL
            CHECK (item_type IN ('customer', 'testimonial', 'feedback', 'review')),
  PRIMARY KEY (tag_id, item_id, item_type)
);

CREATE INDEX idx_tag_links_item ON tag_links(item_id, item_type);

-- ---------------------------------------------------------------------------
-- ingest_rate_limit
--
-- Per-origin counter for /w/ingest/:product. Single row per (product_id, origin)
-- with a count and a window_start; refreshed each request. Cheap and bounded.
-- ---------------------------------------------------------------------------
CREATE TABLE ingest_rate_limit (
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin       TEXT NOT NULL,
  window_start TEXT NOT NULL,                       -- ISO timestamp, start of current minute
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, origin)
);
