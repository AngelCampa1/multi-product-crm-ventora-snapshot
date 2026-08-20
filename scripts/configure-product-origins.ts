/**
 * Configures product origin allowlists for public widget embeds.
 *
 * Run via:
 *   npm run db:origins
 *   npm run db:origins:remote
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PRODUCT_BRAND_COLORS_BY_SLUG, PRODUCT_ORIGINS_BY_SLUG } from "../src/config/product-origins";

const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const LOCAL_PERSIST_TO = !REMOTE ? process.env.D1_PERSIST_TO : undefined;

function sqlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): void {
  const tmpFile = join(tmpdir(), `ventora_origins_${Date.now()}.sql`);
  const persistFlag = LOCAL_PERSIST_TO ? ` --persist-to "${LOCAL_PERSIST_TO}"` : "";
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    execSync(`wrangler d1 execute ${DB_NAME} ${D1_LOCATION_FLAG}${persistFlag} --file "${tmpFile}"`, { stdio: "pipe" });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // Best-effort temp file cleanup.
    }
  }
}

function queryRows<T>(sql: string): T[] {
  const persistFlag = LOCAL_PERSIST_TO ? ` --persist-to "${LOCAL_PERSIST_TO}"` : "";
  const output = execSync(
    `wrangler d1 execute ${DB_NAME} ${D1_LOCATION_FLAG}${persistFlag} --json --command "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf-8" },
  );
  const payload = JSON.parse(output) as Array<{ results?: T[] }>;
  return payload.flatMap((result) => result.results ?? []);
}

function main(): void {
  const target = REMOTE ? "remote" : "local";
  console.log(`\nConfiguring product origins in ${target} D1 (${DB_NAME})...\n`);

  let updated = 0;
  const expectedSlugs = Object.keys(PRODUCT_ORIGINS_BY_SLUG);
  const originCases: string[] = [];
  const brandColorCases: string[] = [];
  for (const [slug, origins] of Object.entries(PRODUCT_ORIGINS_BY_SLUG)) {
    const allowlistJson = JSON.stringify(origins);
    const brandColor = PRODUCT_BRAND_COLORS_BY_SLUG[slug as keyof typeof PRODUCT_BRAND_COLORS_BY_SLUG];
    originCases.push(`WHEN ${sqlValue(slug)} THEN ${sqlValue(allowlistJson)}`);
    if (brandColor) brandColorCases.push(`WHEN ${sqlValue(slug)} THEN ${sqlValue(brandColor)}`);
    updated += 1;
    console.log(`  ${slug}: ${allowlistJson}`);
  }

  const slugList = expectedSlugs.map(sqlValue).join(", ");
  const existingRows = queryRows<{ slug: string }>(`SELECT slug FROM products WHERE slug IN (${slugList});`);
  const existingSlugs = new Set(existingRows.map((row) => row.slug));
  const missingSlugs = expectedSlugs.filter((slug) => !existingSlugs.has(slug));
  if (missingSlugs.length > 0) {
    throw new Error(`PRODUCT_ORIGIN_ROWS_MISSING: ${missingSlugs.join(", ")}`);
  }

  runSql([
    `UPDATE products
        SET origin_allowlist_json = CASE slug ${originCases.join(" ")} ELSE origin_allowlist_json END,
            brand_color = CASE slug ${brandColorCases.join(" ")} ELSE brand_color END
      WHERE slug IN (${slugList});`,
  ].join("\n"));
  console.log(`\n${updated} product origin allowlists configured.`);
}

main();
