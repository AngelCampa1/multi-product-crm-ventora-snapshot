/**
 * Applies the production phase-1 migration set to an isolated local D1 store.
 *
 * This intentionally avoids the default local D1 because normal development
 * usually has the final schema applied, where phase-1 checks should fail.
 */

import { execFileSync } from "child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DB_NAME = "ventora-crm";
const WRANGLER_BIN = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
const TSX_BIN = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");

const BASE_MIGRATIONS = [
  "migrations/0001_init.sql",
  "migrations/0002_connector_configs.sql",
  "migrations/0003_security_firewall_and_widget_keys.sql",
  "migrations/0004_complete_firewall_update_triggers.sql",
];

interface D1Response<T> {
  results?: T[];
  success: boolean;
}

interface CountRow {
  count: number;
}

function writeTempConfig(root: string, migrationsDir: string): string {
  const configPath = join(root, `${migrationsDir}.wrangler.json`);
  writeFileSync(configPath, JSON.stringify({
    name: "ventora-crm",
    main: "src/worker.ts",
    compatibility_date: "2025-05-01",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [{
      binding: "DB",
      database_name: DB_NAME,
      database_id: "00000000-0000-0000-0000-000000000000",
      migrations_dir: join(root, migrationsDir),
    }],
  }));
  return configPath;
}

function copyMigrations(root: string, dirname: string, files: string[]): void {
  const dir = join(root, dirname);
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    copyFileSync(file, join(dir, file.split("/").at(-1)!));
  }
}

function applyMigrationDir(persistTo: string, configPath: string): void {
  execFileSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "migrations", "apply", DB_NAME, "--local", "--persist-to", persistTo, "--config", configPath],
    { stdio: "inherit" },
  );
}

function executeSql<T>(persistTo: string, sql: string): T[] {
  const output = execFileSync(
    process.execPath,
    [WRANGLER_BIN, "d1", "execute", DB_NAME, "--local", "--persist-to", persistTo, "--json", "--command", sql],
    { encoding: "utf-8" },
  );
  const parsed = JSON.parse(output) as Array<D1Response<T>>;
  const first = parsed[0];
  if (!first?.success) throw new Error(`D1 query failed: ${sql}`);
  return first.results ?? [];
}

function verifyPhase2BacklogHandoff(persistTo: string): void {
  executeSql(
    persistTo,
    `INSERT INTO products (id, slug, name, widget_public_key, origin_allowlist_json)
     VALUES ('phase1-product-a', 'phase1-product-a', 'Phase1 A', 'wk_00000000000000000000000000000001', '[]'),
            ('phase1-product-b', 'phase1-product-b', 'Phase1 B', 'wk_00000000000000000000000000000002', '[]')`,
  );
  executeSql(
    persistTo,
    `INSERT INTO reviews (id, product_id, source, external_id, rating, body, imported_at)
     VALUES ('phase1-review-a', 'phase1-product-a', 'g2', 'same-external-id', 5, 'Original product review', '2026-05-27T00:00:00.000Z')`,
  );
  executeSql(
    persistTo,
    `INSERT INTO review_import_backlog (id, product_id, source, external_id, rating, body, imported_at)
     VALUES ('phase1-review-b', 'phase1-product-b', 'g2', 'same-external-id', 4, 'Queued product review', '2026-05-27T00:01:00.000Z')`,
  );

  applyMigrationDir(persistTo, "wrangler.jsonc");

  const duplicateCount = executeSql<CountRow>(
    persistTo,
    "SELECT COUNT(*) AS count FROM reviews WHERE source = 'g2' AND external_id = 'same-external-id'",
  )[0]?.count ?? 0;
  if (duplicateCount !== 2) {
    throw new Error(`phase2 backlog handoff copied ${duplicateCount} duplicate reviews; expected 2`);
  }

  const backlogTableCount = executeSql<CountRow>(
    persistTo,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'review_import_backlog'",
  )[0]?.count ?? 0;
  if (backlogTableCount !== 0) {
    throw new Error("phase2 backlog handoff left review_import_backlog behind");
  }
}

function main(): void {
  const persistTo = mkdtempSync(join(tmpdir(), "ventora-crm-phase1-"));
  const configRoot = mkdtempSync(join(tmpdir(), "ventora-crm-phase1-config-"));
  try {
    copyMigrations(configRoot, "migrations_base", BASE_MIGRATIONS);
    const baseConfig = writeTempConfig(configRoot, "migrations_base");

    applyMigrationDir(persistTo, baseConfig);
    applyMigrationDir(persistTo, "wrangler.phase1.jsonc");

    execFileSync(process.execPath, [TSX_BIN, "scripts/verify-migration-phase1.ts"], {
      stdio: "inherit",
      env: {
        ...process.env,
        D1_PERSIST_TO: persistTo,
      },
    });

    verifyPhase2BacklogHandoff(persistTo);
    for (const script of ["scripts/seed-products.ts", "scripts/configure-product-origins.ts"]) {
      execFileSync(process.execPath, [TSX_BIN, script], {
        stdio: "inherit",
        env: {
          ...process.env,
          D1_PERSIST_TO: persistTo,
        },
      });
    }
    execFileSync(process.execPath, [TSX_BIN, "scripts/verify-migration-state.ts"], {
      stdio: "inherit",
      env: {
        ...process.env,
        D1_PERSIST_TO: persistTo,
      },
    });
    console.log("Migration phase-2 backlog handoff verification passed for isolated local D1.");
  } finally {
    // Wrangler may keep local D1 files locked briefly on Windows after execute
    // calls. Leaving this OS-temp directory behind is preferable to making the
    // rollout verifier hang on best-effort cleanup.
  }
}

main();
