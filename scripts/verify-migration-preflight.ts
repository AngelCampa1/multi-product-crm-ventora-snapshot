/**
 * Read-only checks that must pass before applying new D1 migrations.
 *
 * This script intentionally avoids querying tables/columns introduced by
 * pending migrations, so it can run safely against the currently deployed
 * production schema.
 */

import { execFileSync } from "child_process";
import { join } from "path";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");

interface D1Response<T> {
  results?: T[];
  success: boolean;
}

interface CountRow {
  count: number;
}

function executeSql<T>(sql: string): T[] {
  const output = execFileSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "execute", DB_NAME, D1_LOCATION_FLAG, "--json", "--command", sql],
    { encoding: "utf-8" },
  );
  const parsed = JSON.parse(output) as Array<D1Response<T>>;
  const first = parsed[0];
  if (!first?.success) {
    throw new Error(`D1 query failed: ${sql}`);
  }
  return first.results ?? [];
}

function count(sql: string): number {
  return executeSql<CountRow>(sql)[0]?.count ?? 0;
}

function main(): void {
  const target = REMOTE ? "remote" : "local";
  const failures: string[] = [];

  const firewallViolationCount = count(
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
  );
  if (firewallViolationCount !== 0) {
    failures.push(`found ${firewallViolationCount} existing firewall group violation(s)`);
  }

  const invalidManagedMediaKeyCount = count(
    `SELECT COUNT(*) AS count
       FROM customers
      WHERE photo_r2_key IS NOT NULL
        AND photo_r2_key NOT LIKE 'media/%'`,
  );
  if (invalidManagedMediaKeyCount !== 0) {
    failures.push(`customers have non-managed photo_r2_key values: ${invalidManagedMediaKeyCount}`);
  }

  const ambiguousCustomerProductCount = count(
    `SELECT COUNT(*) AS count
       FROM customer_products cp
      WHERE EXISTS (
        SELECT 1 FROM testimonials t
         WHERE t.customer_id = cp.customer_id AND t.product_id = cp.product_id
        UNION ALL
        SELECT 1 FROM reviews r
         WHERE r.customer_id = cp.customer_id AND r.product_id = cp.product_id
        UNION ALL
        SELECT 1 FROM feedback_items f
         WHERE f.customer_id = cp.customer_id AND f.product_id = cp.product_id
      )`,
  );
  if (ambiguousCustomerProductCount !== 0) {
    failures.push(
      `customer_products has ${ambiguousCustomerProductCount} row(s) overlapping content; classify provenance before 0008 or accept they become manual`,
    );
  }

  if (failures.length > 0) {
    console.error(`\nMigration preflight failed for ${target} D1:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Migration preflight passed for ${target} D1.`);
}

main();
