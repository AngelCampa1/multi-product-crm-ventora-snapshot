/**
 * Exercises media registry triggers against the local D1 database.
 */

import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const PREFIX = `verify_media_${Date.now()}_${Math.random().toString(16).slice(2)}_`;

function runSql(sql: string, expectedError?: string): string {
  const tmpFile = join(tmpdir(), `ventora_media_${Date.now()}_${Math.random().toString(16).slice(2)}.sql`);
  writeFileSync(tmpFile, sql, "utf-8");
  try {
    const output = execFileSync(
      process.execPath,
      [WRANGLER_BIN, "d1", "execute", DB_NAME, D1_LOCATION_FLAG, "--file", tmpFile],
      { encoding: "utf-8" },
    );
    if (expectedError) {
      throw new Error(`Expected D1 command to fail with ${expectedError}, but it succeeded:\n${sql}`);
    }
    return output;
  } catch (err) {
    if (!expectedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(expectedError)) {
      throw new Error(`Expected ${expectedError}, got:\n${message}`);
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
DELETE FROM customers WHERE id LIKE '${PREFIX}%';
DELETE FROM media_assets WHERE key LIKE 'media/${PREFIX}%';
`;
}

function setupSql(): string {
  return `
${cleanupSql()}
INSERT INTO media_assets (key, content_type, size_bytes, created_at)
VALUES ('media/${PREFIX}photo.png', 'image/png', 8, '2026-01-01T00:00:00.000Z');
INSERT INTO customers (id, name, lifecycle, photo_r2_key, created_at, updated_at)
VALUES ('${PREFIX}customer', 'Media Verify Customer', 'lead', 'media/${PREFIX}photo.png', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
`;
}

function main(): void {
  if (REMOTE) {
    throw new Error("verify-media mutates verifier rows and is local-only; use verify:migration:remote for read-only production checks");
  }

  const target = REMOTE ? "remote" : "local";
  console.log(`Verifying media triggers in ${target} D1 (${DB_NAME})...`);

  try {
    runSql(setupSql());
    runSql(
      `INSERT INTO customers (id, name, lifecycle, photo_r2_key, created_at, updated_at)
       VALUES ('${PREFIX}bad_insert', 'Bad Media Insert', 'lead', 'media/${PREFIX}missing.png', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
      "MEDIA_ASSET_NOT_FOUND",
    );
    runSql(
      `UPDATE customers SET photo_r2_key = 'media/${PREFIX}missing.png' WHERE id = '${PREFIX}customer';`,
      "MEDIA_ASSET_NOT_FOUND",
    );
    runSql(
      `UPDATE media_assets SET deleted_at = '2026-01-01T00:00:01.000Z' WHERE key = 'media/${PREFIX}photo.png';`,
      "MEDIA_IN_USE",
    );
    runSql(
      `DELETE FROM media_assets WHERE key = 'media/${PREFIX}photo.png';`,
      "MEDIA_IN_USE",
    );
  } finally {
    runSql(cleanupSql());
  }

  console.log(`Media trigger verification passed for ${target} D1.`);
}

main();
