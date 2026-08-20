/**
 * Verifies the CRM migration state that can be checked from this repo.
 *
 * Run via:
 *   npm run verify:migration
 *   npm run verify:migration:remote
 */

import { execFileSync } from "child_process";
import { join } from "path";
import { PRODUCT_BRAND_COLORS_BY_SLUG, PRODUCT_ORIGINS_BY_SLUG } from "../src/config/product-origins";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const LOCAL_PERSIST_TO = !REMOTE ? process.env.D1_PERSIST_TO : undefined;

const EXPECTED_PRODUCTS: Record<string, { domain: string; origins: string[]; firewallGroup: string | null; brandColor: string }> = {
  "camaudit-v2": {
    domain: "camaudit.io",
    origins: [...PRODUCT_ORIGINS_BY_SLUG["camaudit-v2"]],
    firewallGroup: "cre",
    brandColor: PRODUCT_BRAND_COLORS_BY_SLUG["camaudit-v2"],
  },
  "floriva-web": {
    domain: "floriva.app",
    origins: [...PRODUCT_ORIGINS_BY_SLUG["floriva-web"]],
    firewallGroup: null,
    brandColor: PRODUCT_BRAND_COLORS_BY_SLUG["floriva-web"],
  },
  "grantpipe": {
    domain: "grantpipe.com",
    origins: [...PRODUCT_ORIGINS_BY_SLUG["grantpipe"]],
    firewallGroup: null,
    brandColor: PRODUCT_BRAND_COLORS_BY_SLUG["grantpipe"],
  },
  "ventora-crm": {
    domain: "crm.ventoralabs.com",
    origins: [...PRODUCT_ORIGINS_BY_SLUG["ventora-crm"]],
    firewallGroup: null,
    brandColor: PRODUCT_BRAND_COLORS_BY_SLUG["ventora-crm"],
  },
};

interface D1Response<T> {
  results?: T[];
  success: boolean;
}

interface ProductRow {
  slug: string;
  widget_public_key: string;
  brand_color: string | null;
  primary_domain: string | null;
  origin_allowlist_json: string;
  firewall_group: string | null;
}

interface CountRow {
  count: number;
}

interface IndexRow {
  name: string;
  is_unique: number;
}

interface IndexColumnRow {
  name: string;
}

function executeSql<T>(sql: string): T[] {
  const persistArgs = LOCAL_PERSIST_TO ? ["--persist-to", LOCAL_PERSIST_TO] : [];
  const output = execFileSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "execute", DB_NAME, D1_LOCATION_FLAG, ...persistArgs, "--json", "--command", sql],
    { encoding: "utf-8" },
  );
  const parsed = JSON.parse(output) as Array<D1Response<T>>;
  const first = parsed[0];
  if (!first?.success) {
    throw new Error(`D1 query failed: ${sql}`);
  }
  return first.results ?? [];
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function main(): void {
  const target = REMOTE ? "remote" : "local";
  const failures: string[] = [];

  const rows = executeSql<ProductRow>(
    "SELECT slug, widget_public_key, brand_color, primary_domain, origin_allowlist_json, firewall_group FROM products ORDER BY slug",
  );
  const rowsBySlug = new Map(rows.map((row) => [row.slug, row]));

  for (const [slug, expected] of Object.entries(EXPECTED_PRODUCTS)) {
    const row = rowsBySlug.get(slug);
    if (!row) {
      failures.push(`missing product row: ${slug}`);
      continue;
    }

    if (row.primary_domain !== expected.domain) {
      failures.push(`${slug} primary_domain is ${row.primary_domain ?? "null"}, expected ${expected.domain}`);
    }
    if (row.firewall_group !== expected.firewallGroup) {
      failures.push(`${slug} firewall_group is ${row.firewall_group ?? "null"}, expected ${expected.firewallGroup ?? "null"}`);
    }
    if (row.brand_color !== expected.brandColor) {
      failures.push(`${slug} brand_color is ${row.brand_color ?? "null"}, expected ${expected.brandColor}`);
    }
    if (!/^wk_[0-9a-f]{32}$/.test(row.widget_public_key)) {
      failures.push(`${slug} widget_public_key has an unsafe legacy format`);
    }

    let origins: string[];
    try {
      origins = JSON.parse(row.origin_allowlist_json) as string[];
    } catch {
      failures.push(`${slug} origin_allowlist_json is invalid JSON`);
      continue;
    }
    if (!sameStringSet(origins, expected.origins)) {
      failures.push(`${slug} origins are ${JSON.stringify(origins)}, expected ${JSON.stringify(expected.origins)}`);
    }
  }

  for (const scrapedSlug of ["a11yproof", "openclaw", "reachally"]) {
    if (rowsBySlug.has(scrapedSlug)) {
      failures.push(`scraped product row still exists: ${scrapedSlug}`);
    }
  }
  for (const retiredSlug of ["retired-product-01", "retired-product-02", "retired-product-03", "retired-product-04", "retired-product-05", "retired-product-06", "retired-product-07", "retired-product-08", "retired-product-09"]) {
    if (rowsBySlug.has(retiredSlug)) {
      failures.push(`retired product row still exists: ${retiredSlug}`);
    }
  }

  const testimonialCount = executeSql<CountRow>("SELECT COUNT(*) AS count FROM testimonials")[0]?.count ?? 0;
  if (!REMOTE && testimonialCount !== 0) {
    failures.push(`testimonials table has ${testimonialCount} rows; expected 0 until real approvals are migrated`);
  }

  const triggerCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_customer_products_firewall_insert', 'trg_customer_products_firewall_customer_update', 'trg_customer_products_firewall_product_update', 'trg_testimonials_firewall_insert', 'trg_testimonials_firewall_customer_update', 'trg_reviews_firewall_insert', 'trg_reviews_firewall_customer_update', 'trg_feedback_items_firewall_insert', 'trg_feedback_items_firewall_customer_update', 'trg_testimonials_firewall_product_update', 'trg_reviews_firewall_product_update', 'trg_feedback_items_firewall_product_update', 'trg_products_firewall_group_update')",
  )[0]?.count ?? 0;
  if (triggerCount !== 13) {
    failures.push(`firewall trigger count is ${triggerCount}; expected 13`);
  }

  const mediaAssetTableCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'",
  )[0]?.count ?? 0;
  if (mediaAssetTableCount !== 1) {
    failures.push("media_assets table is missing");
  }

  const customerProductsSourceColumnCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM pragma_table_info('customer_products') WHERE name = 'source'",
  )[0]?.count ?? 0;
  if (customerProductsSourceColumnCount !== 1) {
    failures.push("customer_products.source column is missing");
  }

  if (customerProductsSourceColumnCount === 1) {
    const customerProductsInvalidSourceCount = executeSql<CountRow>(
      "SELECT COUNT(*) AS count FROM customer_products WHERE source NOT IN ('manual', 'content') OR source IS NULL",
    )[0]?.count ?? 0;
    if (customerProductsInvalidSourceCount !== 0) {
      failures.push(`customer_products has invalid source values: ${customerProductsInvalidSourceCount}`);
    }
  }

  const mediaTriggerCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_customers_media_insert', 'trg_customers_media_photo_update', 'trg_media_assets_delete_referenced', 'trg_media_assets_delete_referenced_row')",
  )[0]?.count ?? 0;
  if (mediaTriggerCount !== 4) {
    failures.push(`media trigger count is ${mediaTriggerCount}; expected 4`);
  }

  const reviewBacklogTableCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_import_backlog'",
  )[0]?.count ?? 0;
  if (reviewBacklogTableCount !== 0) {
    failures.push("review_import_backlog table still exists after final migration");
  }

  const invalidMediaReferenceCount = executeSql<CountRow>(
    `SELECT COUNT(*) AS count
       FROM customers c
       LEFT JOIN media_assets m
         ON m.key = c.photo_r2_key
        AND m.deleted_at IS NULL
      WHERE c.photo_r2_key IS NOT NULL
        AND m.key IS NULL`,
  )[0]?.count ?? 0;
  if (invalidMediaReferenceCount !== 0) {
    failures.push(`customers reference missing/deleted media asset rows: ${invalidMediaReferenceCount}`);
  }

  const firewallViolationCount = executeSql<CountRow>(
    `SELECT COUNT(*) AS count
       FROM (
         SELECT a.customer_id, p.firewall_group
           FROM (
             SELECT customer_id, product_id FROM customer_products
             UNION
             SELECT customer_id, product_id FROM testimonials
             UNION
             SELECT customer_id, product_id FROM reviews WHERE customer_id IS NOT NULL
             UNION
             SELECT customer_id, product_id FROM feedback_items WHERE customer_id IS NOT NULL
           ) a
           JOIN products p ON p.id = a.product_id
          WHERE p.firewall_group IS NOT NULL
          GROUP BY a.customer_id, p.firewall_group
         HAVING COUNT(DISTINCT a.product_id) > 1
       )`,
  )[0]?.count ?? 0;
  if (firewallViolationCount !== 0) {
    failures.push(`found ${firewallViolationCount} existing firewall group violation(s)`);
  }

  const reviewUniqueIndexes = executeSql<IndexRow>(
    "SELECT name, \"unique\" as is_unique FROM pragma_index_list('reviews') WHERE \"unique\" = 1",
  );
  let hasProductScopedReviewUniqueIndex = false;
  let hasLegacyGlobalReviewUniqueIndex = false;
  for (const index of reviewUniqueIndexes) {
    const columns = executeSql<IndexColumnRow>(`SELECT name FROM pragma_index_info('${index.name.replace(/'/g, "''")}') ORDER BY seqno`)
      .map((row) => row.name);
    if (sameStringList(columns, ["product_id", "source", "external_id"])) {
      hasProductScopedReviewUniqueIndex = true;
    }
    if (sameStringList(columns, ["source", "external_id"])) {
      hasLegacyGlobalReviewUniqueIndex = true;
    }
  }
  if (!hasProductScopedReviewUniqueIndex) {
    failures.push("reviews product-scoped unique index is missing");
  }
  if (hasLegacyGlobalReviewUniqueIndex) {
    failures.push("reviews still has legacy global source/external_id uniqueness");
  }

  if (failures.length > 0) {
    console.error(`\nMigration verification failed for ${target} D1:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Migration verification passed for ${target} D1 (${rows.length} products, ${testimonialCount} testimonials).`);
}

main();
