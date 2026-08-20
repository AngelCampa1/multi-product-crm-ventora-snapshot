/**
 * Exercises firewall triggers against the local/remote D1 database.
 *
 * This verifier intentionally uses real D1 execution instead of mocked SQL so
 * trigger syntax, trigger ordering, and abort behavior are checked by SQLite.
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const PREFIX = `verify_fw_${Date.now()}_${Math.random().toString(16).slice(2)}_`;

function runSql(sql: string, expectFailure = false): string {
  const tmpFile = join(tmpdir(), `ventora_firewall_${Date.now()}_${Math.random().toString(16).slice(2)}.sql`);
  writeFileSync(tmpFile, sql, "utf-8");
  try {
    const output = execFileSync(
      process.execPath,
      [WRANGLER_BIN, "d1", "execute", DB_NAME, D1_LOCATION_FLAG, "--file", tmpFile],
      { encoding: "utf-8" },
    );
    if (expectFailure) {
      throw new Error(`Expected D1 command to fail, but it succeeded:\n${sql}`);
    }
    return output;
  } catch (err) {
    if (!expectFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("FIREWALL_VIOLATION")) {
      throw new Error(`Expected FIREWALL_VIOLATION, got:\n${message}`);
    }
    return message;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Best-effort temp file cleanup.
    }
  }
}

function cleanupSql(): string {
  return `
DELETE FROM feedback_items WHERE id LIKE '${PREFIX}%';
DELETE FROM reviews WHERE id LIKE '${PREFIX}%';
DELETE FROM testimonials WHERE id LIKE '${PREFIX}%';
DELETE FROM customer_products WHERE customer_id LIKE '${PREFIX}%';
DELETE FROM customers WHERE id LIKE '${PREFIX}%';
DELETE FROM products WHERE id LIKE '${PREFIX}%';
`;
}

function setupSql(): string {
  return `
${cleanupSql()}
INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json, firewall_group)
VALUES
  ('${PREFIX}a', '${PREFIX}a', 'Verify Firewall A', '${PREFIX}a_key', '[]', 'verify_group'),
  ('${PREFIX}b', '${PREFIX}b', 'Verify Firewall B', '${PREFIX}b_key', '[]', 'verify_group'),
  ('${PREFIX}null_a', '${PREFIX}null_a', 'Verify Firewall Null A', '${PREFIX}null_a_key', '[]', NULL),
  ('${PREFIX}null_b', '${PREFIX}null_b', 'Verify Firewall Null B', '${PREFIX}null_b_key', '[]', NULL);
INSERT INTO customers (id, name, lifecycle, created_at, updated_at)
VALUES
  ('${PREFIX}customer', 'Firewall Verify Customer', 'lead', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}group_customer', 'Firewall Verify Group Customer', 'lead', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}move_source', 'Firewall Verify Move Source', 'lead', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}move_target', 'Firewall Verify Move Target', 'lead', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
INSERT INTO customer_products (customer_id, product_id, joined_at)
VALUES
  ('${PREFIX}customer', '${PREFIX}a', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}group_customer', '${PREFIX}null_a', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}group_customer', '${PREFIX}null_b', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}move_source', '${PREFIX}a', '2026-01-01T00:00:00.000Z'),
  ('${PREFIX}move_target', '${PREFIX}b', '2026-01-01T00:00:00.000Z');
INSERT INTO testimonials (id, customer_id, product_id, quote, source, approved, featured, created_at)
VALUES ('${PREFIX}testimonial', '${PREFIX}customer', '${PREFIX}a', 'Real verifier quote placeholder', 'manual', 0, 0, '2026-01-01T00:00:00.000Z');
INSERT INTO reviews (id, customer_id, product_id, source, external_id, body, imported_at)
VALUES ('${PREFIX}review', '${PREFIX}customer', '${PREFIX}a', 'manual', '${PREFIX}review_external', 'Real verifier review body', '2026-01-01T00:00:00.000Z');
INSERT INTO feedback_items (id, customer_id, product_id, type, title, status, upvotes, public_visible, created_at, updated_at)
VALUES ('${PREFIX}feedback', '${PREFIX}customer', '${PREFIX}a', 'bug', 'Verifier feedback', 'new', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`;
}

function main(): void {
  if (REMOTE) {
    throw new Error("verify-firewall mutates verifier rows and is local-only; use verify:migration:remote for read-only production checks");
  }

  const target = REMOTE ? "remote" : "local";
  console.log(`Verifying firewall triggers in ${target} D1 (${DB_NAME})...`);

  try {
    runSql(setupSql());

    runSql(
      `INSERT INTO customer_products (customer_id, product_id, joined_at)
       VALUES ('${PREFIX}customer', '${PREFIX}b', '2026-01-01T00:00:00.000Z');`,
      true,
    );
    runSql(
      `INSERT INTO testimonials (id, customer_id, product_id, quote, source, approved, featured, created_at)
       VALUES ('${PREFIX}testimonial_conflict', '${PREFIX}customer', '${PREFIX}b', 'Verifier quote', 'manual', 0, 0, '2026-01-01T00:00:00.000Z');`,
      true,
    );
    runSql(
      `INSERT INTO reviews (id, customer_id, product_id, source, external_id, body, imported_at)
       VALUES ('${PREFIX}review_conflict', '${PREFIX}customer', '${PREFIX}b', 'manual', '${PREFIX}review_conflict_external', 'Verifier review body', '2026-01-01T00:00:00.000Z');`,
      true,
    );
    runSql(
      `INSERT INTO feedback_items (id, customer_id, product_id, type, title, status, upvotes, public_visible, created_at, updated_at)
       VALUES ('${PREFIX}feedback_conflict', '${PREFIX}customer', '${PREFIX}b', 'bug', 'Verifier feedback conflict', 'new', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
      true,
    );
    runSql(`UPDATE customer_products SET product_id = '${PREFIX}b' WHERE customer_id = '${PREFIX}customer' AND product_id = '${PREFIX}a';`, true);
    runSql(`UPDATE customer_products SET customer_id = '${PREFIX}move_target' WHERE customer_id = '${PREFIX}move_source' AND product_id = '${PREFIX}a';`, true);
    runSql(`UPDATE testimonials SET customer_id = '${PREFIX}move_target' WHERE id = '${PREFIX}testimonial';`, true);
    runSql(`UPDATE reviews SET customer_id = '${PREFIX}move_target' WHERE id = '${PREFIX}review';`, true);
    runSql(`UPDATE feedback_items SET customer_id = '${PREFIX}move_target' WHERE id = '${PREFIX}feedback';`, true);
    runSql(`UPDATE testimonials SET product_id = '${PREFIX}b' WHERE id = '${PREFIX}testimonial';`, true);
    runSql(`UPDATE reviews SET product_id = '${PREFIX}b' WHERE id = '${PREFIX}review';`, true);
    runSql(`UPDATE feedback_items SET product_id = '${PREFIX}b' WHERE id = '${PREFIX}feedback';`, true);
    runSql(`UPDATE products SET firewall_group = 'verify_group' WHERE id = '${PREFIX}null_a';`);
    runSql(`UPDATE products SET firewall_group = 'verify_group' WHERE id = '${PREFIX}null_b';`, true);
  } finally {
    runSql(cleanupSql());
  }

  console.log(`Firewall trigger verification passed for ${target} D1.`);
}

main();
