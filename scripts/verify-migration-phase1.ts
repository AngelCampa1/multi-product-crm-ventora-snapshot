/**
 * Read-only verifier for the production phase-1 expand schema.
 *
 * Phase 1 must be compatible with the old Worker and ready for the new Worker:
 * - old Worker review upserts still have UNIQUE(source, external_id)
 * - final product-scoped review key is already indexed
 * - media_assets table exists but strict media triggers are not installed yet
 * - customer_products.source exists for the new Worker
 */

import { execFileSync } from "child_process";
import { join } from "path";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const LOCAL_PERSIST_TO = !REMOTE ? process.env.D1_PERSIST_TO : undefined;

interface D1Response<T> {
  results?: T[];
  success: boolean;
}

interface CountRow {
  count: number;
}

interface IndexRow {
  name: string;
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

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasUniqueIndexWithColumns(columnsToFind: string[]): boolean {
  const indexes = executeSql<IndexRow>(
    "SELECT name FROM pragma_index_list('reviews') WHERE \"unique\" = 1",
  );
  for (const index of indexes) {
    const columns = executeSql<IndexColumnRow>(`SELECT name FROM pragma_index_info('${index.name.replace(/'/g, "''")}') ORDER BY seqno`)
      .map((row) => row.name);
    if (sameStringList(columns, columnsToFind)) return true;
  }
  return false;
}

function main(): void {
  const target = REMOTE ? "remote" : "local";
  const failures: string[] = [];

  const hasLegacyReviewKey = hasUniqueIndexWithColumns(["source", "external_id"]);
  const hasProductScopedReviewKey = hasUniqueIndexWithColumns(["product_id", "source", "external_id"]);

  if (!hasLegacyReviewKey) {
    failures.push("phase 1 missing legacy reviews source/external_id unique key for old Worker compatibility");
  }
  if (!hasProductScopedReviewKey) {
    failures.push("phase 1 missing product-scoped reviews product/source/external_id unique key");
  }

  const customerProductsSourceColumnCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM pragma_table_info('customer_products') WHERE name = 'source'",
  )[0]?.count ?? 0;
  if (customerProductsSourceColumnCount !== 1) {
    failures.push("phase 1 missing customer_products.source column");
  }

  const mediaAssetTableCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'media_assets'",
  )[0]?.count ?? 0;
  if (mediaAssetTableCount !== 1) {
    failures.push("phase 1 missing media_assets table");
  }

  const reviewBacklogTableCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_import_backlog'",
  )[0]?.count ?? 0;
  if (reviewBacklogTableCount !== 1) {
    failures.push("phase 1 missing review_import_backlog table for cross-product review imports");
  }

  const mediaTriggerCount = executeSql<CountRow>(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_customers_media_insert', 'trg_customers_media_photo_update', 'trg_media_assets_delete_referenced', 'trg_media_assets_delete_referenced_row')",
  )[0]?.count ?? 0;

  const alreadyFinalized =
    !hasLegacyReviewKey &&
    hasProductScopedReviewKey &&
    customerProductsSourceColumnCount === 1 &&
    mediaAssetTableCount === 1 &&
    reviewBacklogTableCount === 0 &&
    mediaTriggerCount > 0;

  if (alreadyFinalized) {
    console.log(`Migration phase-1 verification skipped for ${target} D1; schema is already finalized.`);
    return;
  }

  if (mediaTriggerCount !== 0) {
    failures.push(`phase 1 has final media enforcement triggers installed early: ${mediaTriggerCount}`);
  }

  if (failures.length > 0) {
    console.error(`\nMigration phase-1 verification failed for ${target} D1:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Migration phase-1 verification passed for ${target} D1.`);
}

main();
