/**
 * Reads every .md file in the products source directory and upserts
 * them as Product rows in the local D1 database.
 *
 * Run via: npm run db:seed
 * Requires: wrangler on PATH, `wrangler d1 migrations apply ventora-crm --local` already run.
 */

import { execSync } from "child_process";
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";

// Resolve the products source directory in priority order:
//   1. VENTORA_PRODUCTS_DIR env override, for operators with a private catalog,
//   2. the checked-in fixtures fallback so seeding always works on a fresh clone.
const FIXTURES_PRODUCTS_DIR = join(process.cwd(), "tests", "fixtures", "products");
const PRODUCTS_DIR = (() => {
  const candidates = [process.env.VENTORA_PRODUCTS_DIR, FIXTURES_PRODUCTS_DIR];
  for (const dir of candidates) {
    if (dir && existsSync(dir)) return dir;
  }
  return FIXTURES_PRODUCTS_DIR;
})();
const DB_NAME = "ventora-crm";
const REMOTE = process.argv.includes("--remote");
const D1_LOCATION_FLAG = REMOTE ? "--remote" : "--local";
const LOCAL_PERSIST_TO = !REMOTE ? process.env.D1_PERSIST_TO : undefined;

const SCRAPED_PRODUCT_SLUGS = new Set(["a11yproof", "openclaw", "reachally"]);
const RETIRED_PRODUCT_SLUGS = new Set([
  "retired-product-01",
  "retired-product-02",
  "retired-product-03",
  "retired-product-04",
  "retired-product-05",
  "retired-product-06",
  "retired-product-07",
  "retired-product-08",
  "retired-product-09",
]);

const EXTRA_PRODUCTS: Array<{ slug: string; name: string; domain: string }> = [
  { slug: "grantpipe", name: "GrantPipe", domain: "grantpipe.com" },
  { slug: "floriva-web", name: "Floriva", domain: "floriva.app" },
];

function widgetKeySql(): string {
  return "'wk_' || lower(hex(randomblob(16)))";
}

function firewallGroup(slug: string): string | null {
  if (slug === "camaudit-v2") return "cre";
  return null;
}

function parseProductMd(content: string): { name: string; domain: string | null } {
  const lines = content.split("\n");

  let name = "";
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    if (h1 && h1[1]) {
      name = h1[1].trim();
      break;
    }
  }

  let domain: string | null = null;
  for (const line of lines) {
    const domainRow = line.match(/^\|\s*Domain\s*\|\s*([^|]+?)\s*\|/i);
    if (domainRow && domainRow[1]) {
      const val = domainRow[1].trim();
      if (val && val.toUpperCase() !== "TBD") {
        domain = val;
      }
      break;
    }
  }

  return { name, domain };
}

function slugToId(slug: string): string {
  return slug;
}

function sqlValue(value: string | null): string {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function runSql(sql: string): void {
  const tmpFile = join(tmpdir(), `ventora_seed_${Date.now()}.sql`);
  const persistFlag = LOCAL_PERSIST_TO ? ` --persist-to "${LOCAL_PERSIST_TO}"` : "";
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    execSync(`wrangler d1 execute ${DB_NAME} ${D1_LOCATION_FLAG}${persistFlag} --file "${tmpFile}"`, { stdio: "pipe" });
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

interface SeedRow {
  slug: string;
  id: string;
  name: string;
  primary_domain: string | null;
  firewall_group: string | null;
}

function collectRows(): SeedRow[] {
  const files = readdirSync(PRODUCTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .filter((f) => {
      const slug = basename(f, ".md");
      return !SCRAPED_PRODUCT_SLUGS.has(slug) && !RETIRED_PRODUCT_SLUGS.has(slug);
    });

  if (files.length === 0) {
    console.error(`No .md files found in ${PRODUCTS_DIR}`);
    process.exit(1);
  }

  const rows: SeedRow[] = [];
  for (const file of files) {
    const slug = basename(file, ".md");
    const content = readFileSync(join(PRODUCTS_DIR, file), "utf-8");
    const { name, domain } = parseProductMd(content);

    if (!name) {
      console.warn(`  SKIP ${file} - could not parse product name`);
      continue;
    }

    rows.push({
      slug,
      id: slugToId(slug),
      name,
      primary_domain: domain,
      firewall_group: firewallGroup(slug),
    });
  }

  for (const product of EXTRA_PRODUCTS) {
    rows.push({
      slug: product.slug,
      id: slugToId(product.slug),
      name: product.name,
      primary_domain: product.domain,
      firewall_group: firewallGroup(product.slug),
    });
  }

  return rows;
}

function buildSeedSql(rows: SeedRow[], remote = REMOTE): string {
  const statements: string[] = [];

  for (const row of rows) {
    statements.push(
      `INSERT INTO products ` +
        `(id, slug, name, primary_domain, widget_public_key, origin_allowlist_json, firewall_group) ` +
        `VALUES ` +
        `(${sqlValue(row.id)}, ${sqlValue(row.slug)}, ${sqlValue(row.name)}, ${sqlValue(row.primary_domain)}, ` +
        `${widgetKeySql()}, '[]', ${sqlValue(row.firewall_group)}) ` +
        `ON CONFLICT(id) DO UPDATE SET ` +
        `slug = excluded.slug, ` +
        `name = excluded.name, ` +
        `primary_domain = excluded.primary_domain, ` +
        `firewall_group = excluded.firewall_group`,
    );
  }

  for (const slug of SCRAPED_PRODUCT_SLUGS) {
    statements.push(`DELETE FROM products WHERE slug = ${sqlValue(slug)}`);
  }

  const sql = `${statements.join(";\n")};\n`;

  if (remote) {
    return sql;
  }

  return `BEGIN TRANSACTION;\n${sql}COMMIT;\n`;
}

function printSummary(rows: SeedRow[], seedError: string | null): void {
  const colWidths = {
    slug: Math.max(4, ...rows.map((r) => r.slug.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    domain: Math.max(6, ...rows.map((r) => (r.primary_domain ?? "null").length)),
    group: Math.max(5, ...rows.map((r) => (r.firewall_group ?? "null").length)),
    status: 6,
  };

  const pad = (s: string, w: number) => s.padEnd(w);
  const hr =
    `${"-".repeat(colWidths.slug + 2)}+` +
    `${"-".repeat(colWidths.name + 2)}+` +
    `${"-".repeat(colWidths.domain + 2)}+` +
    `${"-".repeat(colWidths.group + 2)}+` +
    `${"-".repeat(colWidths.status + 2)}`;

  console.log(
    `  ${pad("slug", colWidths.slug)}  |  ${pad("name", colWidths.name)}  |  ${pad("domain", colWidths.domain)}  |  ${pad("group", colWidths.group)}  |  status`,
  );
  console.log(hr);

  for (const row of rows) {
    const statusStr = seedError ? "ERROR " : "  ok  ";
    console.log(
      `  ${pad(row.slug, colWidths.slug)}  |  ${pad(row.name, colWidths.name)}  |  ${pad(row.primary_domain ?? "null", colWidths.domain)}  |  ${pad(row.firewall_group ?? "null", colWidths.group)}  |  ${statusStr}`,
    );
  }

  console.log(`\n${seedError ? 0 : rows.length}/${rows.length} products seeded successfully.`);
}

function main(): void {
  const rows = collectRows();
  const target = REMOTE ? "remote" : "local";
  console.log(`\nSeeding ${rows.length} products into ${target} D1 (${DB_NAME})...\n`);

  let seedError: string | null = null;
  try {
    runSql(buildSeedSql(rows, REMOTE));
  } catch (err) {
    seedError = String(err);
  }

  printSummary(rows, seedError);

  if (seedError) {
    console.error(`\nSeed failed: ${seedError}`);
    process.exit(1);
  }
}

main();
