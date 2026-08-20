/**
 * Removes retired product rows from D1 after reporting dependent content counts.
 *
 * Run via:
 *   npm run db:retire-products
 *   npm run db:retire-products:remote
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const LOCAL_PERSIST_TO = !REMOTE ? process.env.D1_PERSIST_TO : undefined;
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

const RETIRED_PRODUCT_SLUGS = [
  "retired-product-01",
  "retired-product-02",
  "retired-product-03",
  "retired-product-04",
  "retired-product-05",
  "retired-product-06",
  "retired-product-07",
  "retired-product-08",
  "retired-product-09",
] as const;

interface D1Response<T> {
  results?: T[];
  success: boolean;
}

interface RetiredProductCountRow {
  slug: string;
  testimonials: number;
  feedback: number;
  reviews: number;
}

interface SlugRow {
  slug: string;
}

function sqlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function retiredSlugListSql(): string {
  return RETIRED_PRODUCT_SLUGS.map(sqlValue).join(", ");
}

function wranglerBaseArgs(): string[] {
  const persistArgs = LOCAL_PERSIST_TO ? ["--persist-to", LOCAL_PERSIST_TO] : [];
  return [WRANGLER_BIN, "d1", "execute", DB_NAME, D1_LOCATION_FLAG, ...persistArgs];
}

function queryRows<T>(sql: string): T[] {
  const output = execFileSync(process.execPath, [...wranglerBaseArgs(), "--json", "--command", sql], { encoding: "utf-8" });
  const parsed = JSON.parse(output) as Array<D1Response<T>>;
  const first = parsed[0];
  if (!first?.success) {
    throw new Error(`D1 query failed: ${sql}`);
  }
  return first.results ?? [];
}

function runSql(sql: string): void {
  const tmpFile = join(tmpdir(), `ventora_retired_products_${Date.now()}.sql`);
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    execFileSync(process.execPath, [...wranglerBaseArgs(), "--file", tmpFile], { stdio: "pipe" });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

function buildCleanupSql(remote = REMOTE): string {
  const retiredSlugs = retiredSlugListSql();
  const statements = [
    `DELETE FROM tag_links WHERE item_type = 'testimonial' AND item_id IN ` +
      `(SELECT id FROM testimonials WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs})))`,
    `DELETE FROM tag_links WHERE item_type = 'feedback' AND item_id IN ` +
      `(SELECT id FROM feedback_items WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs})))`,
    `DELETE FROM tag_links WHERE item_type = 'review' AND item_id IN ` +
      `(SELECT id FROM reviews WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs})))`,
    `DELETE FROM testimonials WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs}))`,
    `DELETE FROM feedback_items WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs}))`,
    `DELETE FROM reviews WHERE product_id IN (SELECT id FROM products WHERE slug IN (${retiredSlugs}))`,
    `DELETE FROM products WHERE slug IN (${retiredSlugs})`,
  ];
  const sql = `${statements.join(";\n")};\n`;

  if (remote) {
    return sql;
  }
  return `BEGIN TRANSACTION;\n${sql}COMMIT;\n`;
}

function getRetiredProductCounts(): RetiredProductCountRow[] {
  const retiredSlugs = retiredSlugListSql();
  return queryRows<RetiredProductCountRow>(
    `SELECT p.slug,
            (SELECT COUNT(*) FROM testimonials t WHERE t.product_id = p.id) AS testimonials,
            (SELECT COUNT(*) FROM feedback_items f WHERE f.product_id = p.id) AS feedback,
            (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS reviews
       FROM products p
      WHERE p.slug IN (${retiredSlugs})
      ORDER BY p.slug`,
  );
}

function getRemainingRetiredProductSlugs(): string[] {
  const retiredSlugs = retiredSlugListSql();
  return queryRows<SlugRow>(`SELECT slug FROM products WHERE slug IN (${retiredSlugs}) ORDER BY slug`).map((row) => row.slug);
}

function main(): void {
  const target = REMOTE ? "remote" : "local";
  const before = getRetiredProductCounts();
  if (before.length === 0) {
    console.log(`No retired product rows found in ${target} D1 (${DB_NAME}).`);
    return;
  }

  console.log(`\nRetired product cleanup preflight for ${target} D1 (${DB_NAME}):\n`);
  for (const row of before) {
    console.log(`  ${row.slug}: ${row.testimonials} testimonials, ${row.feedback} feedback, ${row.reviews} reviews`);
  }

  runSql(buildCleanupSql(REMOTE));

  const remaining = getRemainingRetiredProductSlugs();
  if (remaining.length > 0) {
    throw new Error(`Retired product rows still exist after cleanup: ${remaining.join(", ")}`);
  }

  console.log(`\nRemoved ${before.length} retired product row(s) from ${target} D1.`);
}

main();
